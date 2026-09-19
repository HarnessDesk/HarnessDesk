import { CheckUnseenError, type EvidenceRecord, type Intent, type NamedCheck, type TeamState } from '@harnessdesk/protocol'

import { repositoryRoot } from '../worktree.js'
import type { RunningChecks } from './board.js'
import { readChecksAt } from './checks-file.js'
import { mintId } from './records.js'
import { canonical, headOf, projectOf, revisionAt, type Revision } from './revision.js'
import { runCommand, TAIL_LIMIT } from './run.js'
import type { SeatBook } from './seats.js'
import { incarnationOf, type CommandsSeen } from './seen.js'
import type { EvidenceStore } from './store.js'

/**
 * Runs a project's named check for a card, and records what it observed.
 *
 * **Security-critical: this is the one place a command a repository names is
 * run outside a flow.** The rules, in the order they are checked, and nothing
 * runs until every one has passed:
 *
 * 1. The checkout's `HEAD` is read once, then the check is read from that
 *    commit's `.harnessdesk/checks.yml` — one git blob, through `readChecksAt`
 *    and nowhere else. A
 *    check that file refuses — a command that is not plain printable ASCII, a
 *    key a check cannot say — cannot run, whatever the caller says.
 * 2. It runs in the card's checkout: its holder's folder while it is claimed,
 *    else the folder its latest fact was observed in, else the room's. That
 *    folder must belong to the same project, or nothing runs.
 * 3. A person has approved the command on this machine, for this repository
 *    and this generation of its checks file (`seen.ts`). Until then — and again
 *    whenever the file changes in any way, the check is renamed, or it is new —
 *    the call is refused with `CheckUnseenError`, carrying the command as it
 *    would run and the file's generation, and nothing runs. The person's answer
 *    is the same call with `seen` and `digest` set to the text and the
 *    generation they were shown; it is recorded and run only while the file is
 *    still exactly that, so a file that changed between the question and the
 *    answer asks again.
 * 4. One check runs on a card at a time, whatever its name, bound to that
 *    commit and checks digest. After it ends, `HEAD` is read again; if it moved,
 *    the recorded result says so and cannot count as a pass for either commit.
 *
 * It runs with the person's own authority and a small environment of its own
 * (`run.ts`); the question that approves it says so.
 *
 * **Admission.** A call is admitted from its first line: a desk that is
 * closing refuses it at once, and one that starts closing while a call is
 * still checking the rules stops it before it can start anything. `stop()`
 * waits for every call still being admitted and every run still running. A
 * check the desk stops leaves no fact: nothing was observed.
 *
 * The run itself is not awaited by the caller: a check can take twenty
 * minutes. The fact it leaves arrives as the room's evidence
 * (`evidence/changed`).
 */

/** Why a call made while the desk is closing starts nothing. */
const CLOSING = 'The desk is closing, so no check starts now.'

export interface CheckRunsPort {
  board(room: string): TeamState | null
  cwdOf(runtime: string, sessionId: string): string | null
  /** The room's evidence moved: a run started, or one ended and left a fact. */
  changed(room: string): void
  log(message: string, details?: Readonly<Record<string, unknown>>): void
}

export interface CheckRunsParts {
  readonly store: EvidenceStore
  readonly seen: CommandsSeen
  readonly seats: SeatBook
  readonly running: RunningChecks
  readonly port: CheckRunsPort
  readonly now?: () => number
}

/** A person's answer to the question a check asks: the command, and the file, exactly as they were shown. */
export interface CheckAnswer {
  readonly seen?: string | undefined
  readonly digest?: string | undefined
}

/** One call, from its first line until it has refused or the run it started has ended. */
interface Active {
  readonly stop: AbortController
  readonly settled: Promise<void>
}

export class CheckRuns {
  readonly #parts: CheckRunsParts
  readonly #now: () => number
  #closing = false
  readonly #active = new Set<Active>()

  constructor(parts: CheckRunsParts) {
    this.#parts = parts
    this.#now = parts.now ?? Date.now
  }

  /** Runs a card's named check, or refuses with why — and answers once it has started. */
  run(room: string, card: number, name: string, answer: CheckAnswer = {}): Promise<{ readonly started: true }> {
    if (this.#closing) return Promise.reject(new Error(CLOSING))
    const stop = new AbortController()
    let running: Promise<void> = Promise.resolve()
    const admitting = this.#admit(room, card, name, answer, stop.signal, (run) => {
      running = run
    })
    const active: Active = {
      stop,
      settled: admitting.then(
        () => running,
        () => undefined,
      ),
    }
    this.#active.add(active)
    void active.settled.finally(() => this.#active.delete(active))
    return admitting.then(() => ({ started: true }) as const)
  }

  /**
   * The desk is closing: nothing new is admitted, every call still checking
   * the rules is stopped before it can start anything, every running check is
   * stopped with its process group, and this waits for all of them.
   */
  async stop(): Promise<void> {
    this.#closing = true
    for (const active of this.#active) active.stop.abort()
    await Promise.allSettled([...this.#active].map((active) => active.settled))
  }

  async #admit(
    room: string,
    card: number,
    name: string,
    answer: CheckAnswer,
    signal: AbortSignal,
    started: (running: Promise<void>) => void,
  ): Promise<void> {
    const { port, seen } = this.#parts
    const still = (): void => {
      if (signal.aborted) throw new Error(CLOSING)
    }
    const board = port.board(room)
    if (!board) throw new Error(`There is no room ${room} on this desk.`)
    const intent = board.intents.find((one) => one.id === card)
    if (!intent) throw new Error(`There is no card #${card} on this board.`)
    const folder = board.cwd ?? board.root
    const project = await repositoryRoot(folder)
    still()
    if (project === null) {
      throw new Error(`A check is bound to a commit, and ${folder} is in no git repository, so no check runs here.`)
    }

    // 1. Where it would run, held to the project, and the one commit this
    // admission is about. Nothing below asks HEAD which revision owns the
    // command: every checks lookup names this object directly.
    const cwd = await this.#checkoutFor(board, intent, project)
    still()
    const head = await headOf(cwd)
    still()
    if (head === null) throw new Error(`${cwd} has no commit yet, and a check is bound to one, so it has not run.`)

    // 2. The check from R's own git object, parsed as strictly as it is shown.
    const read = await readChecksAt(await canonical(cwd), head)
    still()
    const check = read.checks.find((one) => one.name === name)
    if (!check || read.digest === null) {
      const problem = read.problems.find((one) => one.at === '' || one.check === name)
      throw new Error(problem ? `${name} cannot run: ${problem.text}` : `${read.file} names no check called “${name}”.`)
    }

    // 3. Approved on this machine, for this repository and this file — or asked, and nothing runs.
    const scope = { project, incarnation: await incarnationOf(project), digest: read.digest }
    await seen.reconcile(
      scope,
      read.checks.map((one) => one.name),
    )
    still()
    const needsApproval = !(await seen.approved(scope, check))
    if (needsApproval) {
      if (answer.seen !== check.run || answer.digest !== read.digest) {
        throw new CheckUnseenError(
          `${check.name} runs a command this machine has not approved as it is written now, so it has not run.`,
          { check, previous: await seen.previous(scope, check.name, check.run), cwd, file: read.file, digest: read.digest },
        )
      }
    }
    still()

    if (needsApproval) {
      await seen.approve(scope, check)
      still()
    }

    // 4. Bound to the already-chosen commit and digest, and alone on its card.
    // Branch and dirty state are metadata for R; neither can substitute a new
    // HEAD into the admission. Nothing below yields until the child exists.
    const revision = await revisionAt(cwd, head)
    still()

    const busy = this.#parts.running.start(room, card, check.name, this.#now())
    if (busy) throw new Error(`${busy.name} is running on #${card}, and one check runs on a card at a time.`)
    const seat =
      intent.state === 'claimed' && intent.claim
        ? (this.#parts.seats.latestKeptOf(intent.claim.runtime, intent.claim.sessionId)?.id ?? null)
        : null
    port.changed(room)
    started(
      this.#execute({ room, card, check, digest: read.digest, cwd, revision, seat, project, signal }).finally(() => {
        this.#parts.running.end(room, card)
        port.changed(room)
      }),
    )
  }

  /** The folder a card's check runs in, or a refusal naming it when it is not part of the project. */
  async #checkoutFor(board: TeamState, intent: Intent, project: string): Promise<string> {
    const holder =
      intent.state === 'claimed' && intent.claim ? this.#parts.port.cwdOf(intent.claim.runtime, intent.claim.sessionId) : null
    const cwd = holder ?? (await this.#lastCheckout(project, board.id, intent.id)) ?? board.cwd ?? board.root
    if ((await projectOf(cwd)) !== project) {
      throw new Error(`#${intent.id}'s checkout, ${cwd}, is not part of this project, so its check does not run there.`)
    }
    return cwd
  }

  /** The folder the card's latest fact was observed in — by this desk: a backup never says where a check runs. */
  async #lastCheckout(project: string, room: string, card: number): Promise<string | null> {
    const { lines } = await this.#parts.store.read(project, 'evidence')
    for (const line of [...lines].reverse()) {
      if (line.type !== 'evidence' || line.record.restored || line.record.card?.board !== room || line.record.card.id !== card) continue
      if (line.record.checkout) return line.record.checkout.cwd
    }
    return null
  }

  async #execute(run: {
    readonly room: string
    readonly card: number
    readonly check: NamedCheck
    readonly digest: string
    readonly cwd: string
    readonly revision: Revision
    readonly seat: string | null
    readonly project: string
    readonly signal: AbortSignal
  }): Promise<void> {
    const result = await runCommand(run.check.run, { cwd: run.cwd, timeoutSec: run.check.timeout, signal: run.signal })
    if (run.signal.aborted) {
      this.#parts.port.log('a check was stopped because the desk closed; it left no evidence', {
        room: run.room,
        card: run.card,
        check: run.check.name,
      })
      return
    }
    const after = await headOf(run.cwd)
    const counted = after === run.revision.head
    const movement = counted
      ? ''
      : after === null
        ? `Not counted: HEAD moved away from ${run.revision.head} while this check ran.`
        : `Not counted: HEAD moved from ${run.revision.head} to ${after} while this check ran.`
    const tail = (result.tail + (result.tail && movement ? '\n\n' : '') + movement).slice(-TAIL_LIMIT)
    const record: EvidenceRecord = {
      id: mintId(),
      fact: {
        kind: 'check',
        name: run.check.name,
        run: run.check.run,
        exit: result.exit,
        timedOut: result.timedOut,
        at: run.revision.head,
        digest: run.digest,
        counted,
        dirty: run.revision.dirty,
        tail,
      },
      card: { board: run.room, id: run.card },
      checkout: { cwd: run.cwd, branch: run.revision.branch },
      seat: run.seat,
      round: null,
      observedAt: this.#now(),
      posted: null,
    }
    await this.#parts.store.append(run.project, 'evidence', [{ type: 'evidence', record }]).catch((error: unknown) => {
      this.#parts.port.log("a check's result could not be recorded", {
        room: run.room,
        card: run.card,
        check: run.check.name,
        error: error instanceof Error ? error.message : String(error),
      })
    })
  }
}
