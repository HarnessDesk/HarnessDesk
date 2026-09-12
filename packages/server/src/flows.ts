import { spawn } from 'node:child_process'
import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { sessionKey } from '@harnessdesk/protocol'
import type {
  Flow,
  FlowCheck,
  FlowEvent,
  FlowFile,
  FlowRole,
  FlowRound,
  FlowRun,
  FlowSeat,
  FlowSeatRecord,
  Intent,
} from '@harnessdesk/protocol'

import {
  orderVars,
  parseFlow,
  renderFlowTemplate,
  renderOrder,
  ruleFor,
  seatAt,
  validateFlow,
} from './flow.js'
import type { Team, TeamFlows } from './team.js'

/**
 * Running a flow: seating it, handing out its orders, and opening the round
 * that a finished round earns.
 *
 * The decisions all live in `flow.ts` and are pure. This is the part with
 * side effects — it opens conversations, spends requests, makes worktrees,
 * runs a check's command and writes cards — and it is deliberately the thin
 * half, because everything it does is either "ask `flow.ts` what happens
 * next" or "do that to the board".
 *
 * **The orchestrator is never an agent.** Nothing here summarises, judges or
 * decides anything on the merits: every thinking step names a runtime the
 * author chose, and the only judgment this file makes is a command's exit
 * status. Where a flow wants something decided, that is a step in the flow.
 *
 * A run holds **the flow it started with**, frozen. Editing the file under a
 * running flow changes the next run and never this one: a run whose rules
 * changed halfway has cards open under a policy that no longer exists and no
 * honest answer for what they mean.
 */

/** Where flows live in the repository they serve. */
export const FLOW_DIR = '.harnessdesk/flows'

/** What this needs from the host: opening conversations, folders, and a shell. */
export interface FlowPort {
  /**
   * Opens a conversation on an agent, in a folder, with the model and effort
   * the seat asked for — and reports what it is *actually* running.
   *
   * Reported rather than assumed because a runtime drops a pick it declines
   * rather than failing, and a seat that believes it is running at an effort
   * it is not is a seat with an unchecked claim on it.
   */
  seat(
    seat: FlowSeat,
    where: { readonly cwd: string; readonly title: string },
  ): Promise<{ readonly runtime: string; readonly sessionId: string; readonly label: string }>
  /** Hands a seat its standing order. One turn, and the whole job is inside it. */
  order(runtime: string, sessionId: string, text: string): Promise<void>
  /** Puts a conversation in a room. */
  join(room: string, runtime: string, sessionId: string): Promise<void>
  /** A worktree of its own, on a branch of its own, for a role that isolates. */
  isolate(root: string, name: string): Promise<string>
  /** Runs a check's command. Resolves with its exit status, or null if it ran over. */
  run(
    command: string,
    where: { readonly cwd: string; readonly timeoutSec: number },
  ): Promise<{ readonly status: number | null }>
  /** One room's runs, to every window. */
  changed(room: string, runs: readonly FlowRun[]): void
  log(message: string, details?: Readonly<Record<string, unknown>>): void
}

/** A run as it is kept on disk. */
interface StoredRun extends FlowRun {
  readonly version: 1
  readonly room: string
}

/** What `start` was asked for. */
export interface FlowStart {
  readonly room: string
  /** The flow's text. A room may hold one that was never written to disk. */
  readonly source: string
  /** Where it came from, when it came from a file. */
  readonly path?: string
  readonly vars?: Readonly<Record<string, string>>
}

const now = (): number => Date.now()

/**
 * Runs a check's command and reports its exit status, or null if it ran over.
 *
 * A shell, because a check is written the way a person would type it —
 * `pnpm verify`, `cargo test && cargo clippy` — and a flow that could only
 * name an executable would push every author into a wrapper script.
 *
 * Which is exactly why this is the one thing a flow file can make happen on
 * somebody's machine, and why the dry run prints every command verbatim and
 * the start dialog names them all before a seat is opened. A flow arrives
 * through a pull request like any other file, and a reader has to be able to
 * see what it will run.
 */
export const runCheck = async (
  command: string,
  where: { readonly cwd: string; readonly timeoutSec: number },
): Promise<{ readonly status: number | null }> =>
  new Promise((resolve) => {
    const child = spawn(command, { cwd: where.cwd, shell: true, stdio: 'ignore' })
    let settled = false
    const finish = (status: number | null): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ status })
    }
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      finish(null)
    }, where.timeoutSec * 1000)
    /* Unref'd so a check left running cannot hold a quit open; the kill above
       is what actually ends it. */
    timer.unref?.()
    child.on('error', () => finish(null))
    child.on('exit', (code, signal) => finish(signal ? null : (code ?? null)))
  })

export class Flows implements TeamFlows {
  readonly #dir: string
  readonly #port: FlowPort
  readonly #team: Team
  #runs = new Map<string, StoredRun>()
  /**
   * One advance at a time per run.
   *
   * Three cards of a round can finish inside the same millisecond, and each
   * one asks whether the round is over. Without this, two of them would both
   * see it over and open the next round twice — which on a board is two
   * rounds of three reviewers on one fix, and the second of them unclaimable
   * forever.
   */
  #turning = new Map<string, Promise<void>>()
  #writes: Promise<void> = Promise.resolve()

  constructor(dir: string, team: Team, port: FlowPort) {
    this.#dir = dir
    this.#team = team
    this.#port = port
  }

  /** Waits out the write chain — a disposer's courtesy, and the tests'. */
  async flush(): Promise<void> {
    await Promise.all([...this.#turning.values()])
    await this.#writes
  }

  // ------------------------------------------------------------------ reading

  /**
   * The flows a project offers, from the folder they are versioned in.
   *
   * A file that does not parse is listed *with its problem* rather than left
   * out: a flow that has gone missing from the picker because somebody
   * mistyped a line is the one failure a picker must not have.
   */
  async list(root: string): Promise<FlowFile[]> {
    let names: string[]
    try {
      names = await readdir(join(root, FLOW_DIR))
    } catch {
      return []
    }
    const files: FlowFile[] = []
    for (const name of names.sort()) {
      if (!name.endsWith('.yml') && !name.endsWith('.yaml')) continue
      const path = `${FLOW_DIR}/${name}`
      try {
        const source = await readFile(join(root, path), 'utf8')
        const { flow, problems } = parseFlow(source, name.replace(/\.ya?ml$/, ''))
        const failed = problems.find((one) => one.level === 'error')
        files.push({
          path,
          name: flow?.name ?? name.replace(/\.ya?ml$/, ''),
          ...(flow?.description ? { description: flow.description } : {}),
          ...(failed ? { problem: `${failed.at}: ${failed.text}` } : {}),
        })
      } catch (error) {
        files.push({
          path,
          name: name.replace(/\.ya?ml$/, ''),
          problem: error instanceof Error ? error.message : String(error),
        })
      }
    }
    return files
  }

  /** One flow's text, as it is on disk. */
  async source(root: string, path: string): Promise<string> {
    if (!path.startsWith(`${FLOW_DIR}/`) || path.includes('..')) {
      throw new Error(`A flow is read from ${FLOW_DIR}; "${path}" is somewhere else.`)
    }
    return readFile(join(root, path), 'utf8')
  }

  // ------------------------------------------------------------------ the runs

  /** Every run this room has had, oldest first. */
  runsFor(room: string): FlowRun[] {
    return [...this.#runs.values()]
      .filter((run) => run.room === room)
      .sort((a, b) => a.startedAt - b.startedAt)
  }

  /** The run still going in this room, if any. A room runs one flow at a time. */
  #liveIn(room: string): StoredRun | null {
    return [...this.#runs.values()].find((run) => run.room === room && run.state === 'running') ?? null
  }

  /**
   * Seats a flow and opens its seed round.
   *
   * Everything that spends is here and nowhere else — which is why `dry run`
   * can promise it spends nothing, and why this is the only path a person can
   * reach by pressing something.
   */
  async start(request: FlowStart): Promise<FlowRun> {
    const board = this.#team.stateFor(request.room)
    if (this.#liveIn(request.room)) {
      throw new Error(
        `${board.name} is already running a flow. Stop it first — a second one would open cards into the same board and neither could tell which were its own.`,
      )
    }
    const { flow, problems } = parseFlow(request.source)
    const all = [...problems, ...(flow ? validateFlow(flow) : [])]
    const failed = all.filter((one) => one.level === 'error')
    if (!flow || failed.length > 0) {
      throw new Error(
        `This flow will not run yet:\n${failed.map((one) => `• ${one.at}: ${one.text}`).join('\n')}`,
      )
    }
    const vars: Record<string, string> = {}
    for (const input of flow.inputs) vars[input.id] = request.vars?.[input.id] ?? input.default ?? ''

    const id = `flow-${now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
    const record: FlowEvent[] = [
      { at: now(), kind: 'started', text: flow.name, by: 'the person' },
    ]
    const seats: FlowSeatRecord[] = []
    /* Seat everything before any card exists. A seat that is still opening
       when its card appears is a card nobody can take, and `await_work` would
       hand it to whoever was seated first — which is exactly the routing
       failure roles exist to end. */
    for (const role of flow.roles) {
      if (role.kind !== 'agent') continue
      for (let index = 0; index < role.count; index += 1) {
        const spec = seatAt(role, index)
        const cwd = role.isolate
          ? await this.#port.isolate(board.root, `${role.id}-${index + 1}-${id.slice(-4)}`)
          : board.root
        const title = `${role.id}${role.count > 1 ? ` ${index + 1}` : ''} · ${flow.name}`
        const opened = await this.#port.seat(spec, { cwd, title })
        seats.push({
          key: `${opened.runtime} ${opened.sessionId}`,
          role: role.id,
          runtime: opened.runtime,
          sessionId: opened.sessionId,
          seat: opened.label,
          permission: role.permission,
          cwd,
        })
        await this.#port.join(request.room, opened.runtime, opened.sessionId)
        this.#team.setRole(request.room, opened.runtime, opened.sessionId, role.id)
        record.push({
          at: now(),
          kind: 'seated',
          role: role.id,
          seat: opened.label,
          text: cwd === board.root ? null : cwd,
        })
      }
    }

    const run: StoredRun = {
      version: 1,
      room: request.room,
      id,
      flow,
      ...(request.path ? { source: request.path } : {}),
      state: 'running',
      vars,
      seats,
      rounds: [],
      record,
      startedAt: now(),
    }
    this.#runs.set(id, run)

    /* The order after the cards would be a seat that wakes to a board it has
       not been told how to read; the order before them is a seat that waits.
       So: orders, then the seed round. */
    for (const seat of seats) {
      const role = flow.roles.find((one) => one.id === seat.role) as FlowRole
      const name = this.#team.stateFor(request.room).nicknames?.[seat.key] ?? seat.seat
      await this.#port.order(
        seat.runtime,
        seat.sessionId,
        renderOrder(
          orderVars(role, flow, {
            name,
            member: name,
            room: this.#team.stateFor(request.room).name,
            repo: seat.cwd,
          }),
        ),
      )
    }

    this.#open(run, flow.seed.role, flow.seed, null, [])
    return this.#save(run.id)
  }

  /** Stops a run: the cards stay as the record, and every seat is told to stand down. */
  stop(id: string, why = 'the person stopped this flow'): FlowRun {
    const run = this.#runs.get(id)
    if (!run) throw new Error(`There is no flow run ${id}.`)
    if (run.state !== 'running') return run
    this.#runs.set(id, {
      ...run,
      state: 'stopped',
      endedAt: now(),
      ended: why,
      record: [...run.record, { at: now(), kind: 'stopped', text: why }],
    })
    this.#release(run, why)
    return this.#save(id)
  }

  // -------------------------------------------------------------- the TeamFlows

  /**
   * Why this card may not answer that.
   *
   * The engine refuses an outcome a role never declared, because a rule
   * branching on an unconstrained string is a rule that silently never fires
   * — and the failure is invisible: the card finishes, the board looks right,
   * and the next round simply never opens.
   */
  refuseOutcome(room: string, intent: Intent, outcome: string | null): string | null {
    const run = this.#runFor(room, intent.id)
    if (!run) return null
    const role = run.flow.roles.find((one) => one.id === intent.role)
    if (!role || role.outcomes.length === 0) return null
    if (outcome === null) {
      return `Refused: #${intent.id} belongs to the flow "${run.flow.name}", so it needs an outcome — one of ${role.outcomes.join(', ')}. That is what decides what happens next.`
    }
    if (!role.outcomes.includes(outcome)) {
      return `Refused: "${outcome}" is not something a ${role.id} answers here. It answers ${role.outcomes.join(', ')}. Nothing was recorded.`
    }
    return null
  }

  /** A card finished. Whether that finishes its round is the next question. */
  completed(room: string, intent: Intent): void {
    const run = this.#runFor(room, intent.id)
    if (!run || run.state !== 'running') return
    const queued = (this.#turning.get(run.id) ?? Promise.resolve()).then(() =>
      this.#advance(run.id, intent).catch((error: unknown) => {
        this.#port.log('a flow could not open its next round', {
          run: run.id,
          error: error instanceof Error ? error.message : String(error),
        })
      }),
    )
    this.#turning.set(run.id, queued)
  }

  /** Why this seat should stop waiting — the one thing that may end its turn. */
  standDown(room: string, runtime: string, sessionId: string): string | null {
    const key = `${runtime} ${sessionId}`
    const run = [...this.#runs.values()].find(
      (one) => one.room === room && one.seats.some((seat) => seat.key === key),
    )
    if (!run) return null
    if (run.state === 'running') return null
    return run.ended ?? `the flow "${run.flow.name}" has finished`
  }

  // ---------------------------------------------------------------- the engine

  /** Which run, if any, a card belongs to. */
  #runFor(room: string, intent: number): StoredRun | null {
    return (
      [...this.#runs.values()].find(
        (run) => run.room === room && run.rounds.some((round) => round.intents.includes(intent)),
      ) ?? null
    )
  }

  /**
   * A round finished, so ask the flow what that earns.
   *
   * Reads the board rather than counting completions, because a person is
   * always the referee here: a card they marked done, abandoned or took a
   * claim off is as much a finished card as one an agent completed, and a
   * round that waited for a completion that will never come is a run stuck
   * where its own board says it is not.
   */
  async #advance(id: string, because?: Intent): Promise<void> {
    const run = this.#runs.get(id)
    if (!run || run.state !== 'running') return
    const round = run.rounds[run.rounds.length - 1]
    if (!round) return
    const board = this.#team.stateFor(run.room)
    const cards = round.intents.map((one) => board.intents.find((card) => card.id === one))
    if (cards.some((card) => !card || (card.state !== 'done' && card.state !== 'abandoned'))) return

    if (because?.outcome !== undefined) {
      this.#runs.set(id, {
        ...run,
        record: [
          ...run.record,
          {
            at: now(),
            kind: 'outcome',
            role: round.role,
            intent: because.id,
            outcome: because.outcome ?? null,
          },
        ],
      })
    }
    const current = this.#runs.get(id) as StoredRun
    const outcomes = cards.map((card) => card?.outcome ?? null)
    const fired = ruleFor(current.flow, round.role, outcomes)
    if (!fired) {
      const said = outcomes.map((one) => one ?? 'nothing').join(', ')
      const why = `${round.role} answered ${said}, and no rule takes it further`
      this.#runs.set(id, {
        ...current,
        state: 'settled',
        endedAt: now(),
        ended: why,
        record: [...current.record, { at: now(), kind: 'settled', role: round.role, text: why }],
      })
      this.#release(current, why)
      this.#save(id)
      return
    }
    this.#open(current, fired.then.role, fired.then, fired.id, round.intents)
    this.#save(id)
    await this.#runChecks(id)
  }

  /**
   * Opens a round: N cards of one role, all depending on the round that
   * earned it.
   *
   * The dependency is how the finished round's context packages reach the new
   * one — the board already hands a claimant everything its dependencies left
   * behind, so a review round depending on a fix card receives that fix's
   * package for free, and the next fix round depending on three reviews
   * receives all three. Nothing here copies a word of it.
   */
  #open(
    run: StoredRun,
    roleId: string,
    then: { readonly title: string; readonly detail?: string | null; readonly files?: readonly string[] },
    rule: string | null,
    dependsOn: readonly number[],
  ): void {
    const role = run.flow.roles.find((one) => one.id === roleId)
    if (!role) return
    const n = run.rounds.length + 1
    const board = this.#team.stateFor(run.room)
    const intents: number[] = []
    for (let index = 1; index <= role.count; index += 1) {
      const vars: Record<string, string> = {
        ...run.vars,
        flow: run.flow.name,
        run: run.id,
        room: board.name,
        repo: board.root,
        role: role.id,
        round: String(n),
        n: String(index),
        count: String(role.count),
      }
      const detail = [
        then.detail ? renderFlowTemplate(then.detail, vars) : null,
        /* The vocabulary on the card as well as in the order. An order is read
           once and compacted away; the card is in front of the seat at the
           moment it has to choose a word. */
        role.outcomes.length > 0 && role.kind !== 'check'
          ? `Finish this with complete_claim and an outcome of exactly one of: ${role.outcomes.join(', ')}.`
          : null,
      ]
        .filter((one): one is string => Boolean(one))
        .join('\n\n')
      const card = this.#team.addIntentForFlow(run.room, {
        title: renderFlowTemplate(then.title, vars),
        ...(detail ? { detail } : {}),
        ...(then.files && then.files.length > 0 ? { files: then.files } : {}),
        ...(dependsOn.length > 0 ? { dependsOn } : {}),
        role: role.id,
      })
      intents.push(card.id)
    }
    const round: FlowRound = {
      n,
      role: role.id,
      intents,
      ...(rule ? { rule } : {}),
      openedAt: now(),
    }
    this.#runs.set(run.id, {
      ...(this.#runs.get(run.id) as StoredRun),
      rounds: [...(this.#runs.get(run.id) as StoredRun).rounds, round],
      record: [
        ...(this.#runs.get(run.id) as StoredRun).record,
        { at: now(), kind: 'round', role: role.id, text: `round ${n}, ${role.count} card${role.count === 1 ? '' : 's'}` },
      ],
    })
  }

  /**
   * Runs the command behind a `check` round, and answers its own card with
   * the exit status.
   *
   * This is the step that makes a flow trustworthy rather than merely
   * automated: nobody is asked for an opinion, and an exit status cannot be
   * talked round. It is also the one thing a flow file can make happen on
   * somebody's machine, so the dry run prints every command verbatim and the
   * start dialog names them before anything is seated.
   */
  async #runChecks(id: string): Promise<void> {
    const run = this.#runs.get(id)
    if (!run || run.state !== 'running') return
    const round = run.rounds[run.rounds.length - 1]
    if (!round) return
    const role = run.flow.roles.find((one) => one.id === round.role)
    if (!role || role.kind !== 'check' || !role.check) return
    const check = role.check as FlowCheck
    const board = this.#team.stateFor(run.room)
    const cwd = check.cwd ? (check.cwd.startsWith('/') ? check.cwd : join(board.root, check.cwd)) : board.root
    for (const intent of round.intents) {
      const { status } = await this.#port.run(check.run, { cwd, timeoutSec: check.timeout })
      const outcome = status === null ? check.otherwise : (check.exits[String(status)] ?? check.otherwise)
      const note =
        status === null
          ? `${check.run} ran past ${check.timeout}s`
          : `${check.run} exited ${status}`
      this.#runs.set(id, {
        ...(this.#runs.get(id) as StoredRun),
        record: [
          ...(this.#runs.get(id) as StoredRun).record,
          { at: now(), kind: 'check', role: role.id, intent, outcome, text: note },
        ],
      })
      /* Down the person's own path: a check is the desk acting for them, and
         a completion that did not go through the board's referee would be a
         second way for a card to finish. */
      this.#team.intentAction(run.room, intent, 'done', note, outcome)
    }
  }

  /**
   * Tells this run's seats to stop waiting.
   *
   * Through the board rather than by resolving their calls directly: a waiter
   * is woken by the room it is waiting on, and `standDown` is the flow
   * engine's answer to the question that wake asks. Nudging is what makes a
   * settled run reach a seat at all — nothing else about a run ending touches
   * the board, so without it four seats would wait out their block on a flow
   * that is over.
   */
  #release(run: StoredRun, why: string): void {
    void why
    this.#team.nudgeRoom(run.room)
  }

  // ------------------------------------------------------------- persistence

  /**
   * Reads the runs back, then asks each still-running one whether its board
   * moved on while the desk was down.
   *
   * Reconciliation rather than atomicity, and stronger than it: the cards are
   * the board's file and the run is this one, so a quit between "the last
   * card finished" and "the next round opened" would otherwise strand the run
   * forever. Asking the board is also what recovers a run whose round was
   * half opened, and it is the same question `#advance` asks in the ordinary
   * case — one code path, exercised on every launch.
   */
  async load(): Promise<void> {
    let names: string[] = []
    try {
      names = await readdir(this.#dir)
    } catch {
      return
    }
    for (const name of names) {
      if (!name.endsWith('.json')) continue
      try {
        const raw = JSON.parse(await readFile(join(this.#dir, name), 'utf8')) as StoredRun
        this.#runs.set(raw.id, raw)
      } catch (error) {
        this.#port.log('a stored flow run could not be read', { file: name, error: String(error) })
      }
    }
    for (const run of [...this.#runs.values()]) {
      if (run.state !== 'running') continue
      /* A room that no longer exists takes its run with it. */
      try {
        this.#team.stateFor(run.room)
      } catch {
        this.#runs.set(run.id, {
          ...run,
          state: 'stopped',
          endedAt: now(),
          ended: 'the room this flow ran in is gone',
        })
        this.#save(run.id)
        continue
      }
      await this.#advance(run.id)
    }
  }

  #save(id: string): FlowRun {
    const run = this.#runs.get(id) as StoredRun
    this.#port.changed(run.room, this.runsFor(run.room))
    const file = join(this.#dir, `${encodeURIComponent(id)}.json`)
    /* Written whole and renamed into place, the way the board is: a reader
       that catches a half-written run is a run that reads as gone. */
    this.#writes = this.#writes.then(async () => {
      try {
        await mkdir(this.#dir, { recursive: true })
        const temporary = `${file}.writing`
        await writeFile(temporary, JSON.stringify(run), 'utf8')
        await rename(temporary, file)
      } catch (error) {
        this.#port.log('a flow run could not be saved', { run: id, error: String(error) })
      }
    })
    return run
  }
}
