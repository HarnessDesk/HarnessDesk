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
  /**
   * Puts a seat back on the model and effort it was seated with, and reports
   * what it is actually running.
   *
   * Called before every re-arm rather than only at seating, because a bridge
   * that restarts holds no session state: the conversation comes back on the
   * agent's own default, and a reviewer signing as one model while running
   * another is a review that lies about who wrote it.
   */
  reseat(runtime: string, sessionId: string, seat: FlowSeat): Promise<string>
  /**
   * Closes a conversation this flow opened and will not use.
   *
   * Only ever called to undo a seating that failed part-way: the turns those
   * seats cost are already spent, and leaving them live in a room no run owns
   * is how a failed start becomes somebody else's cleanup.
   */
  retire(runtime: string, sessionId: string): Promise<void>
  /**
   * Why this conversation's last turn ended badly, in the runtime's own words,
   * or null when it ended normally.
   *
   * Read only to explain a seat that never reached the board: "it has not
   * touched the board" is an observation, and this is the difference between
   * an agent that ignored its tools and one that never got a turn at all.
   */
  turnFailure?(runtime: string, sessionId: string): string | null
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

/**
 * How many times one seat may be handed its order again inside the window.
 *
 * A turn is a request wherever the vendor bills by turn, so this is money.
 * Three inside an hour is enough to carry a seat over a model that stopped
 * after its last card or a window that lapsed; a seat that needs a fourth is
 * one something is actually wrong with, and a stalled run somebody can see
 * beats an account quietly draining.
 */
const REARM_BUDGET = 3
const REARM_WINDOW_MS = 60 * 60 * 1000

/**
 * How long a seat has to be seen using the board before the run gives up on
 * it.
 *
 * Long enough for the slowest honest start measured here — a seat woken, its
 * order read, and one `await_work` issued, which live runs did inside twenty
 * seconds on every agent that works — and short enough that a room which will
 * never move says so while somebody is still watching it.
 */
const ATTENDANCE_GRACE_MS = 3 * 60 * 1000

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
    /* Its own process group, so a timeout can end the whole of it. Killing
       the shell alone leaves whatever it started: `sleep 9 & wait` reported
       the timeout's outcome while the background `sleep` carried on running
       on the machine, which makes "the check stopped" a claim the engine
       could not keep. */
    const child = spawn(command, { cwd: where.cwd, shell: true, stdio: 'ignore', detached: true })
    let settled = false
    const finish = (status: number | null): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ status })
    }
    const stop = (): void => {
      try {
        // Negative pid is the group; the shell and everything it spawned.
        if (child.pid !== undefined) process.kill(-child.pid, 'SIGKILL')
      } catch {
        // Already gone, or never started — `exit` answers either way.
      }
    }
    const timer = setTimeout(() => {
      stop()
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
  /** When each seat was last handed its order again, for the budget below. */
  #rearms = new Map<string, number[]>()
  /** Attendance checks in flight, so a stop or a quit can cancel them. */
  #watching = new Map<string, ReturnType<typeof setTimeout>>()
  #writes: Promise<void> = Promise.resolve()

  constructor(dir: string, team: Team, port: FlowPort) {
    this.#dir = dir
    this.#team = team
    this.#port = port
  }

  /** Waits out the write chain — a disposer's courtesy, and the tests'. */
  async flush(): Promise<void> {
    for (const timer of this.#watching.values()) clearTimeout(timer)
    this.#watching.clear()
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
    /* Everything opened so far, so a seat that fails takes the others with it
       rather than leaving them in the room. Seating spends a turn each and
       joins each conversation to the room; a later refusal used to leave those
       live, roled, and owned by no run — turns spent on members nothing would
       ever stand down. */
    const opened: FlowSeatRecord[] = []
    /* Naming happens before a word is written about anybody. A room names its
       members *lazily* — on the first look at the roster — so an order
       rendered straight after seating called a seat by its label ("Cursor ·
       Gemini 3.8 Flash · High") while the room addressed it as "Gemini 3", and
       the order is the one place a seat is told what it is called. */
    const undo = async (why: string): Promise<void> => {
      for (const seat of opened) {
        this.#team.setRole(request.room, seat.runtime, seat.sessionId, null)
        try {
          this.#team.leaveRoom(request.room, seat.runtime as never, seat.sessionId)
        } catch {
          // A room that is already gone needs no leaving.
        }
        await this.#port.retire(seat.runtime, seat.sessionId).catch(() => {})
      }
      this.#port.log('a flow could not seat every role, so the ones it opened were closed', {
        room: request.room,
        opened: opened.length,
        why,
      })
    }

    try {
    for (const role of flow.roles) {
      if (role.kind !== 'agent') continue
      for (let index = 0; index < role.count; index += 1) {
        const spec = seatAt(role, index)
        const cwd = role.isolate
          ? await this.#port.isolate(board.root, `${role.id}-${index + 1}-${id.slice(-4)}`)
          : board.root
        const title = `${role.id}${role.count > 1 ? ` ${index + 1}` : ''} · ${flow.name}`
        const live = await this.#port.seat(spec, { cwd, title })
        const held: FlowSeatRecord = {
          /* Escaped, not the raw byte: a NUL in the source makes the whole
             file binary to grep, and the string is identical either way. */
          key: `${live.runtime}\u0000${live.sessionId}`,
          role: role.id,
          runtime: live.runtime,
          sessionId: live.sessionId,
          seat: live.label,
          spec,
          permission: role.permission,
          cwd,
        }
        seats.push(held)
        opened.push(held)
        await this.#port.join(request.room, live.runtime, live.sessionId)
        this.#team.setRole(request.room, live.runtime, live.sessionId, role.id)
        record.push({
          at: now(),
          kind: 'seated',
          role: role.id,
          seat: live.label,
          text: cwd === board.root ? null : cwd,
        })
      }
    }

    /* The orders are inside the same transaction as the seating, and the run
       is published only once every one of them has landed.
       `order` goes through the host's live handle and can throw — a runtime
       that dropped in the second between being seated and being spoken to is
       the realistic case — and a start that failed there used to leave the run
       in the map as `running`, the room carrying members and roles, and the
       next attempt refused with "already running a flow". Nothing a person
       could clear without going to the files. */
    await this.#team.peersFor(request.room).catch(() => [])
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
            runtime: seat.runtime,
          }),
        ),
      )
    }
    } catch (error) {
      await undo(error instanceof Error ? error.message : String(error))
      throw error
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

    /* Past this line the run exists, so a failure is *stopped* rather than
       unwound: its seats have their orders and are already waiting, and a run
       that vanished from under them would leave four turns paid for and
       nobody to stand them down. Stopping says what happened, releases them,
       and leaves the room clear for the next attempt. */
    try {
      this.#open(run, flow.seed.role, flow.seed, null, [])
      /* And from here the run is watched: a seat that never touches the board
         is a run that will never move. See `#attendance`. */
      this.#watch(run.id)
      /* A seed that is a `check` runs here, exactly as one a rule opens does.
         Only the transition path called this, so a flow whose first step is a
         preflight gate opened its card and then waited on a command nobody had
         started — a deadlock a valid flow could reach by being written the
         obvious way. */
      await this.#runChecks(run.id)
    } catch (error) {
      const why = `the first round could not be opened: ${
        error instanceof Error ? error.message : String(error)
      }`
      this.stop(id, why)
      throw error
    }
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
    const watch = this.#watching.get(id)
    if (watch) clearTimeout(watch)
    this.#watching.delete(id)
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

  /**
   * A seat's turn ended. If its run is still going, hand it its order again.
   *
   * A seat has exactly one turn and it is meant to outlive the run. When one
   * ends anyway — the model decided it was finished after its last card, a
   * usage window ran out, a harness refused the next call — the flow stalls
   * in silence: its cards stay open, nobody is waiting on them, and the only
   * sign is a room that stopped moving. Every one of those was seen in the
   * hand-rolled version of this, and re-arming by hand was the standing chore
   * it left behind.
   *
   * **Re-rendered from the role, never replayed from a stored string.** That
   * is the bug this must not re-introduce: a publishing seat that came back
   * from a re-arm carrying a reader's git rule then refused the very card it
   * was seated for.
   *
   * Budgeted, because a seat that cannot start is one that would otherwise be
   * re-armed forever, and each re-arm is a turn somebody pays for. The budget
   * is per seat and per hour; past it the run is left stalled and visible
   * rather than quietly draining an account.
   */
  async reArm(runtime: string, sessionId: string): Promise<void> {
    const key = String(sessionKey(runtime as never, sessionId as never))
    const run = [...this.#runs.values()].find(
      (one) => one.state === 'running' && one.seats.some((seat) => seat.key === key),
    )
    if (!run) return
    const seat = run.seats.find((one) => one.key === key) as FlowSeatRecord
    const role = run.flow.roles.find((one) => one.id === seat.role)
    if (!role) return
    /* Only when there is something for it to do. A seat whose role has
       nothing open will wake, find nothing and end its turn again — and doing
       that on a budget spends the budget on nothing. Measured in a live run:
       three reviewers all closed their turns after finishing a round, and
       every one of them was woken to an empty board and burned its whole
       allowance inside the minute. A seat with no work is left down and woken
       by the round that needs it — see `#armFor`. */
    if (!this.#team.hasWorkFor(run.room, seat.runtime, seat.sessionId)) return
    /* A turn that ended in the same second the run settled is not a seat that
       stopped early: it is a seat that was told to stand down and did as it
       was asked. The run's own state is checked above; this covers the race
       between the stand-down and the turn's end reaching the host. */
    const spent = (this.#rearms.get(key) ?? []).filter((at) => now() - at < REARM_WINDOW_MS)
    if (spent.length >= REARM_BUDGET) {
      this.#port.log('a flow seat has ended its turn too often to keep re-arming it', {
        run: run.id,
        role: seat.role,
        seat: seat.seat,
        spent: spent.length,
      })
      this.#runs.set(run.id, {
        ...run,
        record: [
          ...run.record,
          {
            at: now(),
            kind: 'stopped',
            role: seat.role,
            seat: seat.seat,
            text: `stopped answering: ${spent.length} turns ended inside the hour, so it is not being re-armed again`,
          },
        ],
      })
      this.#save(run.id)
      return
    }
    const name = this.#team.stateFor(run.room).nicknames?.[key] ?? seat.seat
    try {
      /* Its model and effort first. Measured after a desk restart: the seat
         came back billing as `default` — Cursor's Auto — because the bridge
         that reopened it held no session state. A flow whose reviewers
         quietly become Auto is a flow that cannot say who did the work. */
      if (seat.spec) {
        const running = await this.#port.reseat(seat.runtime, seat.sessionId, seat.spec)
        if (running !== seat.seat) {
          this.#port.log('a flow seat came back on something else', {
            run: run.id,
            role: seat.role,
            seated: seat.seat,
            running,
          })
        }
      }
      await this.#port.order(
        seat.runtime,
        seat.sessionId,
        renderOrder(
          orderVars(role, run.flow, {
            name,
            member: name,
            room: this.#team.stateFor(run.room).name,
            repo: seat.cwd,
            runtime: seat.runtime,
          }),
        ),
      )
    } catch (error) {
      /* And it does not count against the budget. The budget is there to stop
         a seat that *starts and stops* from draining an account; a send that
         never reached the agent bought nothing and spent nothing, and
         charging for it would use the allowance up on a runtime that was
         merely not running yet. */
      this.#port.log('a flow seat could not be re-armed', {
        run: run.id,
        role: seat.role,
        error: error instanceof Error ? error.message : String(error),
      })
      return
    }
    this.#rearms.set(key, [...spent, now()])
    this.#runs.set(this.#runs.get(run.id)!.id, {
      ...(this.#runs.get(run.id) as StoredRun),
      record: [
        ...(this.#runs.get(run.id) as StoredRun).record,
        {
          at: now(),
          kind: 'seated',
          role: seat.role,
          seat: seat.seat,
          text: `re-armed: its turn ended while the flow was still running (${spent.length + 1} this hour)`,
        },
      ],
    })
    this.#save(run.id)
  }

  /**
   * Stops a run whose seats never took the tools they were given.
   *
   * The failure this catches is #333, and it is silent by construction: an
   * agent that accepts the offered tool bridge and then ignores it is handed
   * its order, spends a turn, and sits there — while the seed card stays open,
   * the run stays `running`, and the only outward sign is a room that never
   * moved. Measured on Cline 3.0.61, whose seats went looking for `claim_next`
   * on the filesystem instead.
   *
   * `usedBoard` is the observation, not a claim: the room records a member the
   * *host* has seen call a team verb. So after a grace period long enough for
   * a seat to wake, read its order and call `await_work` once, any seat that
   * has still not been seen stops the run and says which agent and which role.
   * A stalled run somebody can see beats a silent one — and the whole point of
   * the dry run is that this is decided before, so when it cannot be, the
   * least this owes is to end quickly and say why.
   */
  #watch(id: string): void {
    const run = this.#runs.get(id)
    if (!run) return
    const timer = setTimeout(() => {
      void this.#attendance(id)
    }, ATTENDANCE_GRACE_MS)
    /* Unref'd: a desk quitting inside the grace period must not be held open
       by a check on a run it is about to stop anyway. */
    timer.unref?.()
    this.#watching.set(id, timer)
  }

  /**
   * Runs the attendance check on every live run now, rather than on its timer.
   *
   * The timer is the product's path; this is the same question asked directly,
   * so a test does not have to wait out the grace period to hold the answer.
   */
  async attendance(): Promise<void> {
    for (const run of [...this.#runs.values()]) {
      if (run.state === 'running') await this.#attendance(run.id)
    }
  }

  async #attendance(id: string): Promise<void> {
    const run = this.#runs.get(id)
    this.#watching.delete(id)
    if (!run || run.state !== 'running') return
    const peers = await this.#team.peersFor(run.room).catch(() => [])
    const absent = run.seats.filter((seat) => {
      const peer = peers.find(
        (one) => String(sessionKey(one.runtime, one.sessionId as never)) === seat.key,
      )
      return peer !== undefined && peer.usedBoard !== true
    })
    if (absent.length === 0) return
    const named = absent.map((seat) => `${seat.role} (${seat.seat})`).join(', ')
    /* What is *observed* is that the board was never touched. Why is a second
       question, and the answer is not always the one this check was built for:
       a seat whose turn never ran — an agent that errored, a plan that lapsed,
       an account moved to a slow pool — has not ignored the tools, it never
       got to them. Saying so wrongly is worse than saying less: the first time
       this fired on a healthy build it blamed the agent for a Cursor quota,
       and the message read as a defect in the feature. So the run says what it
       saw, and names the turn's own error when there is one. */
    const failures = absent
      .map((seat) => ({ seat, why: this.#port.turnFailure?.(seat.runtime, seat.sessionId) ?? null }))
      .filter((one): one is { seat: FlowSeatRecord; why: string } => Boolean(one.why))
    const because =
      failures.length > 0
        ? `Their turns did not run: ${[...new Set(failures.map((one) => one.why))].join(' · ')}`
        : "Nothing has been heard from them since, so either that agent takes HarnessDesk's tools without using them, or its turn never started."
    const why = `${absent.length === 1 ? 'a seat has' : `${absent.length} seats have`} not touched the board since being seated — ${named}. ${because}`
    this.#runs.set(id, {
      ...run,
      state: 'stopped',
      endedAt: now(),
      ended: why,
      record: [...run.record, { at: now(), kind: 'stopped', text: why }],
    })
    this.#port.log('a flow stopped because its seats never took the tools', {
      run: id,
      seats: named,
    })
    this.#release(run, why)
    this.#save(id)
  }

  /** Why this seat should stop waiting — the one thing that may end its turn. */
  standDown(room: string, runtime: string, sessionId: string): string | null {
    const key = `${runtime}\u0000${sessionId}`
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
    /* The round that just opened is the moment a seat of that role is worth
       waking: it has work now, which it did not a second ago. */
    await this.#armFor(id, fired.then.role)
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
    /* The round that earned this one. `count` is how many cards *this* round
       opens; an author writing the card that reads the finished round means
       the other number, and saying `{{count}}` there produced "Judge 1
       attempts" and "All 1 reviewers approved" in live runs. */
    const before = run.rounds[run.rounds.length - 1]
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
        ...(before ? { from: before.role, answered: String(before.intents.length) } : {}),
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
   * Wakes the seats of a role whose round has just opened, when their turn
   * has ended.
   *
   * The other half of the rule above: a seat is not re-armed the moment its
   * turn dies — which is usually a model deciding it is finished after its
   * last card — but when there is a card it can take. A seat still inside its
   * turn is left alone: it is already waiting, and handing it a second order
   * is the second billed request this whole design exists to avoid.
   */
  async #armFor(id: string, roleId?: string): Promise<void> {
    const run = this.#runs.get(id)
    if (!run || run.state !== 'running') return
    const seats = roleId === undefined ? run.seats : run.seats.filter((one) => one.role === roleId)
    if (seats.length === 0) return
    const peers = await this.#team.peersFor(run.room).catch(() => [])
    for (const seat of seats) {
      const peer = peers.find(
        (one) => String(sessionKey(one.runtime, one.sessionId as never)) === seat.key,
      )
      // Busy is a seat inside its turn, which is where a standing seat lives.
      if (peer?.busy) continue
      await this.reArm(seat.runtime, seat.sessionId)
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

  /**
   * Wakes whatever stopped while the desk was down.
   *
   * Separate from `load` and called once the runtimes are up, because these
   * are two different jobs: reconciling a run's rounds is board work and can
   * happen the moment the files are read, but *sending* to a seat needs the
   * agent holding it to be running. Asked a moment too early it answers
   * "Cursor is not running" for every seat of every flow — which is exactly
   * what it did.
   *
   * A turn that ended while the desk was down leaves no turn-end event to
   * react to, so without this a run came back reconciled and *asleep*: its
   * rounds correct, its cards where they should be, and every seat that had
   * stopped still stopped. `#armFor` only wakes a seat that is out of its
   * turn and has work — one holding a card, or one whose round is open — so a
   * healthy run wakes nobody.
   */
  async resume(): Promise<void> {
    for (const run of [...this.#runs.values()]) {
      if (run.state !== 'running') continue
      await this.#armFor(run.id)
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
