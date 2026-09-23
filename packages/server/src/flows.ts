import { spawn } from 'node:child_process'
import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'

import { sessionKey } from '@harnessdesk/protocol'
import type {
  EvidenceRecord,
  Flow,
  FlowCheck,
  FlowExecution,
  FlowRoundState,
  FlowThen,
  FlowEvent,
  FlowFile,
  FlowRole,
  FlowRound,
  FlowRun,
  FlowPermission,
  FlowSeat,
  FlowSeatRecord,
  Intent,
  ReviewCandidate,
  ReviewInput,
  RuntimeId,
  SeatId,
  SeatRecord,
} from '@harnessdesk/protocol'

import { errnoOf, NOTHING_HERE, NOTHING_YET } from './errno.js'
import { FlowCatalog } from './flow-catalog.js'
import { CORRUPT_RUN, ExecutionFiles, FlowExecutions, sourceDigest, type FlowStartRequest, type StoredFlowExecution } from './flow-execution.js'
import type { FlowReview } from './flow-evidence.js'
import { executionOf, legacyCheckUncertain, legacyRunOf, legacySeatsMapped, recoveryOf } from './flow-recovery.js'
import {
  cardVars,
  orderVars,
  parseFlow,
  renderFlowTemplate,
  renderOrder,
  ruleFor,
  seatAt,
  validateFlow,
} from './flow.js'
import type { Team, TeamCallScope, TeamFlows } from './team.js'

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
  /** Opens and durably records a legacy role before its first standing-order turn. */
  openLegacySeat(input: {
    goal: string
    spec: FlowSeat
    permission: FlowPermission
    role: string
    isolate: boolean
    title: string
    lane?: string
  }): Promise<SeatRecord>
  /** Closes only the Goal Seat this failed flow opened, after its turn has stopped. */
  releaseGoalSeat(goal: string, seat: SeatId): Promise<void>
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
  /**
   * Refuses the folder a room works in unless it is in a folder or a
   * repository the desk has open.
   *
   * Asked once, by `start`, before anything is seated. Not per seat: a seat
   * is a conversation the desk holds, and the desk counts the folder of every
   * conversation it holds as open, so once one seat sat in the room's folder
   * the question would answer itself. And not again while the run goes on:
   * nothing after seating cuts a worktree, and its seats are conversations
   * like any other, which keep working in a folder somebody has since closed.
   */
  confine(folder: string): Promise<void>
  /** Refuses a new run before it opens Seats or writes cards. */
  canMutateBoard?(goal: string): { ok: true } | { ok: false; reason: string }
  /**
   * Runs a check's command. Resolves with its exit status, or null if it ran
   * over. `card` says which card and round it is for, so the desk can record
   * what it observed as that card's check evidence.
   */
  run(
    command: string,
    where: {
      readonly cwd: string
      readonly timeoutSec: number
      readonly card?: { readonly room: string; readonly intent: number; readonly name: string; readonly round: number }
    },
  ): Promise<{ readonly status: number | null }>
  /** One room's runs, to every window. */
  changed(room: string, runs: readonly FlowRun[]): void
  log(message: string, details?: Readonly<Record<string, unknown>>): void
  /**
   * What a restart needs to decide whether an old run may go on: its Goal,
   * whether that Goal can run work, and the Seats kept on it. Read after the
   * Goal store and the Seat book are restored, before any run is resumed.
   */
  recovery: {
    goal(room: string): { readonly exists: boolean; readonly writable: boolean }
    seats(room: string): readonly SeatRecord[]
  }
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
  readonly #catalogue: FlowCatalog
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
  /** Seats that have exhausted their re-arm budget, so 'stopped answering' is recorded once per seat. */
  #stoppedSeats = new Set<string>()
  #writes: Promise<void> = Promise.resolve()
  /**
   * Why the runs this desk keeps could not be read at launch, or null when
   * they could.
   *
   * Held, because the failure outlives `load`. A desk that cannot read its
   * runs cannot say which are still going, and answering "none" would let a
   * second flow start in a room whose first is live on disk — two runs opening
   * cards into one board, neither able to tell which are its own. So asking
   * what a room is running, and starting a flow, both raise this instead,
   * until a launch can read the folder again.
   */
  #unreadable: Error | null = null
  /**
   * Old runs that are live on disk but may not go on, with the reason — a
   * missing Goal, unmatched Seats, a check that may have run. Kept out of
   * `#runs` so nothing advances, re-arms or re-runs them; their files are
   * left exactly as they were.
   */
  #held = new Map<string, { readonly run: StoredRun; readonly reason: string }>()
  /** Rooms whose stored run file is broken: no flow starts on them until it is restored. */
  #blocked = new Map<string, string>()
  /** Set when a stored run names no room at all: no flow starts anywhere. */
  #corrupt: string | null = null
  /** Runs on Goals: every new run, and the only engine that seats Agents. */
  readonly #executions: FlowExecutions | null
  /** Structured review: candidates and record, host-scoped through the caller's own claimed card. */
  readonly #review: FlowReview | null

  constructor(dir: string, team: Team, port: FlowPort, catalogue?: FlowCatalog, executions?: FlowExecutions, review?: FlowReview) {
    this.#dir = dir
    this.#team = team
    this.#port = port
    this.#catalogue = catalogue ?? new FlowCatalog({ confine: async () => {}, legacyStrict: true })
    this.#executions = executions ?? null
    this.#review = review ?? null
  }

  /** Waits out the write chain — a disposer's courtesy, and the tests'. */
  async flush(): Promise<void> {
    for (const timer of this.#watching.values()) clearTimeout(timer)
    this.#watching.clear()
    await Promise.all([...this.#turning.values()])
    await this.#writes
    await this.#executions?.idle()
  }

  // ------------------------------------------------------------ runs on Goals

  /** A new run on a new Goal. The legacy `start({ room })` route stays for old callers only. */
  async startGoal(request: FlowStartRequest): Promise<FlowExecution> {
    if (this.#unreadable) throw this.#unreadable
    if (this.#corrupt) throw new Error(this.#corrupt)
    if (!this.#executions) throw new Error('Runs on Goals are not available on this desk.')
    return this.#executions.startGoal(request)
  }

  /** True only once every card of that round is finished and the round's close is on disk. */
  roundClosed(run: string, round: number): boolean {
    return this.#executions?.roundClosed(run, round) ?? false
  }

  /** New durable facts on a Goal: re-read its guards. Messages never come through here. */
  async wakeEvidence(goal: string): Promise<void> {
    await this.#executions?.wakeEvidence(goal)
  }

  openRound(run: string, then: FlowThen, cause: { key: string; evidence: readonly string[] }): Promise<FlowRoundState> {
    if (!this.#executions) throw new Error('Runs on Goals are not available on this desk.')
    return this.#executions.openRound(run, then, cause)
  }

  /** Every run on this Goal, as execution state. */
  executionsFor(goal: string): FlowExecution[] {
    return this.#executions?.runs(goal) ?? []
  }

  /** A stored v2 run's own frozen source and inputs — never re-read from a path — for a check retry's exact-equality check. */
  storedRun(run: string): { readonly source: string; readonly vars: Readonly<Record<string, string>> } | null {
    const stored = this.#executions?.stored(run)
    return stored ? { source: stored.source, vars: stored.vars } : null
  }

  /** One run's current execution state, by id alone — the wire read `flow/execution` answers. */
  executionOf(run: string): FlowExecution | null {
    const stored = this.#executions?.stored(run)
    return stored ? this.#executions!.runs(stored.goal).find((one) => one.id === run) ?? null : null
  }

  /** Runs an interrupted check again, once a person has reviewed it. The only way a v2 check ever runs a second time. */
  retryCheck(run: string, card: number): Promise<FlowExecution> {
    if (!this.#executions) throw new Error(`There is no flow run ${run}.`)
    return this.#executions.retryCheck(run, card)
  }

  stopRun(id: string, why?: string): Promise<FlowExecution> {
    if (!this.#executions?.stored(id)) throw new Error(`There is no flow run ${id}.`)
    return this.#executions.stop(id, why)
  }

  /** The wrap barrier: every run on this Goal stops dispatching before the Goal's receipt is taken. */
  async stopGoal(goal: string, why = 'the Goal is being wrapped'): Promise<void> {
    await this.#executions?.stopGoal(goal, why)
    for (const run of [...this.#runs.values()]) {
      if (run.room === goal && (run.state === 'running' || run.state === 'stalled')) this.stop(run.id, why)
    }
    await this.#writes
  }

  bindingOf(room: string, intent: number): { readonly session: { readonly runtime: string; readonly sessionId: string } | null } | null {
    return this.#executions?.bindingOf(room, intent) ?? null
  }

  /** The host's own assignment path asks this too: a card whose Seat is still opening may be claimed by that opening. */
  bindingFor(room: string, intent: number): ReturnType<FlowExecutions['bindingOf']> {
    return this.#executions?.bindingOf(room, intent) ?? null
  }

  messagingLocked(room: string): string | null {
    return this.#executions?.messagingLocked(room) ?? null
  }

  /** A finished round's evidence subjects, forwarded so the host's evidence-guard wiring never reaches `FlowExecutions` around this. */
  subjectsOf(goal: string, round: FlowRoundState): ReturnType<FlowExecutions['subjectsOf']> {
    return this.#executions?.subjectsOf(goal, round) ?? Promise.resolve([])
  }

  /** What a review call binds to on this Goal: forwarded to the host's `FlowReviewPort` wiring, never resolved twice. */
  reviewBindingFor(
    goal: string, card: number, caller: { readonly runtime: string; readonly sessionId: string },
  ): ReturnType<FlowExecutions['reviewBinding']> {
    return this.#executions?.reviewBinding(goal, card, caller) ?? Promise.resolve(null)
  }

  /** Observed predecessor subjects this caller's own claimed card may judge. */
  async reviewCandidates(intent: number, scope: TeamCallScope): Promise<readonly ReviewCandidate[]> {
    return (await this.#review?.candidates(intent, scope)) ?? []
  }

  /** Records one structured verdict. Throws the refusal — there is no evidence record to hand back otherwise. */
  async recordReview(input: ReviewInput, scope: TeamCallScope): Promise<EvidenceRecord> {
    if (!this.#review) throw new Error('Runs on Goals are not available on this desk.')
    return this.#review.record(input, scope)
  }

  /**
   * Why `complete_claim` may not finish this card yet: its role declares
   * `produces: review` and this caller's Seat has not recorded one. `null`
   * for every card no v2 run bound, and for one whose role asks nothing of
   * the kind — the common case, checked first so it costs nothing there.
   */
  async refuseCompletion(room: string, intent: Intent, caller: TeamCallScope): Promise<string | null> {
    if (!this.#executions?.requiresReview(room, intent.id)) return null
    if (!this.#review || !caller.runtime || !caller.sessionId) {
      return 'This card needs a structured review before it can complete. Ask for review candidates and record one first.'
    }
    const recorded = await this.#review.recorded(intent.id, { runtime: caller.runtime, sessionId: caller.sessionId })
    return recorded ? null : 'This card needs a structured review before it can complete. Ask for review candidates and record one first.'
  }

  /**
   * An old run held because its check may already have run: the person has
   * looked, and asks for it to run. The only way such a check runs again.
   */
  async runAgain(id: string): Promise<FlowRun> {
    const held = this.#held.get(id)
    if (!held) throw new Error(`There is no held flow run ${id}.`)
    const again = recoveryOf({
      terminal: false, ...this.#goalState(held.run.room), seatsMapped: legacySeatsMapped(held.run, this.#port.recovery.seats(held.run.room)),
      uncertainCheck: false,
    })
    if (again !== 'resume') throw new Error(again)
    this.#held.delete(id)
    this.#runs.set(id, held.run)
    await this.#runChecks(id)
    return this.#save(id)
  }

  #modernCard(room: string, intent: number): boolean {
    return this.#executions?.runs(room).some((run) => run.rounds.some((round) => round.cards.includes(intent))) ?? false
  }

  #goalState(room: string): { goalExists: boolean; goalWritable: boolean } {
    const goal = this.#port.recovery.goal(room)
    return { goalExists: goal.exists, goalWritable: goal.writable }
  }

  /** A seat governed by a flow that is still live; settled and stopped runs govern nothing. */
  seatOf(runtime: string, sessionId: string): FlowSeatRecord | null {
    const key = String(sessionKey(runtime as never, sessionId as never))
    for (const run of this.#runs.values()) {
      if (run.state !== 'running' && run.state !== 'stalled') continue
      const seat = Array.isArray(run.seats) ? run.seats.find((one) => one.key === key) : undefined
      if (seat) return seat
    }
    return null
  }

  // ------------------------------------------------------------------ reading

  /**
   * The flows a project offers, from the folder they are versioned in.
   *
   * A file that does not parse is listed *with its problem* rather than left
   * out: a flow that has gone missing from the picker because somebody
   * mistyped a line is the one failure a picker must not have.
   *
   * A folder that will not open is raised rather than listed as empty, for the
   * same reason one level up: "no flows in this project yet" over a folder the
   * desk was refused is that failure for every flow at once, and the error
   * names the folder and the reason. Only a folder nobody has made, or a
   * `.harnessdesk` somebody made a file, has none.
   */
  async list(root: string): Promise<FlowFile[]> {
    return (await this.#catalogue.list(root)).map((entry) => ({
      path: entry.path,
      name: entry.name,
      ...(entry.description ? { description: entry.description } : {}),
      ...(entry.problem ? { problem: entry.problem } : {}),
    }))
  }

  /** One flow's text, as it is on disk. */
  async source(root: string, path: string): Promise<string> {
    return this.#catalogue.read(root, path)
  }

  /** The v2 catalogue, whole: every layer's entries, shadows included. */
  async catalog(root: string): Promise<readonly import('@harnessdesk/protocol').FlowEntry[]> {
    return this.#catalogue.list(root)
  }

  /** One catalogue entry's text, by its bare id — never a path. */
  async catalogSource(root: string, id: string, origin?: import('@harnessdesk/protocol').FlowOrigin): Promise<string> {
    return this.#catalogue.readById(root, id, origin)
  }

  // ------------------------------------------------------------------ the runs

  /** Every run this room has had, oldest first. */
  runsFor(room: string): FlowRun[] {
    if (this.#unreadable) throw this.#unreadable
    return this.#runsIn(room)
  }

  /**
   * The same answer without the refusal, for pushing a change of a run this
   * desk holds — which it only can once its runs were read.
   */
  #runsIn(room: string): StoredRun[] {
    const held = [...this.#held.values()]
      .filter((one) => one.run.room === room)
      .map((one): StoredRun => ({ ...one.run, state: 'stalled', ended: one.reason }))
    return [...this.#runs.values(), ...held]
      .filter((run) => run.room === room)
      .sort((a, b) => a.startedAt - b.startedAt)
  }

  /** The run still going in this room, if any — a held one included. A room runs one flow at a time. */
  #liveIn(room: string): StoredRun | null {
    return (
      [...this.#runs.values(), ...[...this.#held.values()].map((one) => one.run)].find(
        (run) => run.room === room && (run.state === 'running' || run.state === 'stalled'),
      ) ?? null
    )
  }

  /**
   * Seats a flow and opens its seed round.
   *
   * Everything that spends is here and nowhere else — which is why `dry run`
   * can promise it spends nothing, and why this is the only path a person can
   * reach by pressing something.
   */
  async start(request: FlowStart): Promise<FlowRun> {
    if (this.#unreadable) throw this.#unreadable
    const corrupt = this.#corrupt ?? this.#blocked.get(request.room) ?? this.#executions?.refusal(request.room) ?? null
    if (corrupt) throw new Error(corrupt)
    if (!this.#team.hasRoom(request.room)) {
      throw new Error(`There is no room ${request.room}.`)
    }
    const allowed = this.#port.canMutateBoard?.(request.room)
    if (allowed && !allowed.ok) throw new Error(allowed.reason)
    const board = this.#team.stateFor(request.room)
    if (this.#liveIn(request.room) || this.#executions?.runs(request.room).some((run) => run.state === 'running' || run.state === 'stalled')) {
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
    /* Where the seats open and what an isolating role's worktrees are cut
       from, held to what is open before any of it happens. A room outlives
       its folder being open: forgetting the folder leaves the room, and so
       does every launch after it. */
    const folder = board.cwd ?? board.root
    await this.#port.confine(folder)
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
    const openedIds = new Map<string, SeatId>()
    /* Naming happens before a word is written about anybody. A room names its
       members *lazily* — on the first look at the roster — so an order
       rendered straight after seating called a seat by its label ("Cursor ·
       Gemini 3.8 Flash · High") while the room addressed it as "Gemini 3", and
       the order is the one place a seat is told what it is called. */
    const undo = async (why: string): Promise<void> => {
      const failures: string[] = []
      for (const seat of opened) {
        try {
          await this.#port.retire(seat.runtime, seat.sessionId)
          const seatId = openedIds.get(`${seat.runtime}\u0000${seat.sessionId}`)
          if (seatId) await this.#port.releaseGoalSeat(request.room, seatId)
        } catch (error) {
          failures.push(error instanceof Error ? error.message : String(error))
        }
      }
      this.#port.log('a flow could not seat every role, so its opened Seats were released', {
        room: request.room, opened: opened.length, why, failures,
      })
      if (failures.length > 0) {
        throw new Error(`${why} Cleanup also failed: ${failures.join('; ')}. The partial conversations were kept.`)
      }
    }

    try {
      for (const role of flow.roles) {
        if (role.kind !== 'agent') continue
        for (let index = 0; index < role.count; index += 1) {
          const spec = seatAt(role, index)
          const title = `${role.id}${role.count > 1 ? ` ${index + 1}` : ''} · ${board.name} · ${flow.name}`
          const durable = await this.#port.openLegacySeat({
            goal: request.room,
            spec,
            permission: role.permission,
            role: role.id,
            isolate: Boolean(role.isolate),
            title,
            lane: `${role.id}-${index + 1}-${id.slice(-4)}`,
          })
          openedIds.set(`${durable.session.runtime}\u0000${durable.session.sessionId}`, durable.id)
          const held: FlowSeatRecord = {
            key: `${durable.session.runtime}\u0000${durable.session.sessionId}`,
            role: role.id,
            runtime: durable.session.runtime,
            sessionId: durable.session.sessionId,
            seat: durable.seatLabel,
            spec,
            permission: role.permission,
            cwd: durable.checkout.cwd,
          }
          seats.push(held)
          opened.push(held)
          record.push({
            at: now(), kind: 'seated', role: role.id, seat: durable.seatLabel,
            text: durable.checkout.cwd === board.root ? null : durable.checkout.cwd,
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
            seat: seat.seat,
            room: this.#team.stateFor(request.room).name,
            repo: seat.cwd,
            runtime: seat.runtime,
            run: id,
            vars,
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
    const held = this.#held.get(id)
    if (held) {
      // The person's own stop is the one write an old held run gets.
      this.#held.delete(id)
      this.#runs.set(id, held.run)
    }
    const run = this.#runs.get(id)
    if (!run) throw new Error(`There is no flow run ${id}.`)
    if (run.state !== 'running' && run.state !== 'stalled') return run
    const record = Array.isArray(run.record) ? run.record : []
    this.#runs.set(id, {
      ...run,
      state: 'stopped',
      endedAt: now(),
      ended: why,
      record: [...record, { at: now(), kind: 'stopped', text: why }],
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
    if (this.#modernCard(room, intent.id)) return this.#executions!.refuseOutcome(room, intent, outcome)
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
    if (this.#modernCard(room, intent.id)) {
      this.#executions!.completed(room, intent.id)
      return
    }
    const run = this.#runFor(room, intent.id)
    if (!run || (run.state !== 'running' && run.state !== 'stalled')) return
    if (run.state === 'stalled') {
      const record = Array.isArray(run.record) ? run.record : []
      this.#runs.set(run.id, {
        ...run,
        state: 'running',
        ended: null,
        record: [
          ...record,
          {
            at: now(),
            kind: 'started',
            text: `recovered from stalled: card #${intent.id} completed`,
          },
        ],
      })
      this.#port.log('a stalled flow run recovered and returned to running', {
        run: run.id,
        intent: intent.id,
      })
      this.#save(run.id)
      const round = run.rounds[run.rounds.length - 1]
      if (round) void this.#armFor(run.id, round.role)
    }
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
    if (await this.#executions?.reArm(runtime, sessionId)) return
    const key = String(sessionKey(runtime as never, sessionId as never))
    const run = [...this.#runs.values()].find(
      (one) =>
        (one.state === 'running' || one.state === 'stalled') &&
        Array.isArray(one.seats) &&
        one.seats.some((seat) => seat.key === key),
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
    const budget = run.flow.rearm ?? REARM_BUDGET
    const spent = (this.#rearms.get(key) ?? []).filter((at) => now() - at < REARM_WINDOW_MS)
    if (spent.length >= budget) {
      if (!this.#stoppedSeats.has(key)) {
        this.#stoppedSeats.add(key)
        this.#port.log('a flow seat has ended its turn too often to keep re-arming it', {
          run: run.id,
          role: seat.role,
          seat: seat.seat,
          spent: spent.length,
        })
        this.#runs.set(run.id, {
          ...run,
          record: [
            ...(Array.isArray(run.record) ? run.record : []),
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
      }
      this.#checkStalled(run.id)
      return
    }
    const slot = now()
    this.#rearms.set(key, [...spent, slot])
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
            seat: seat.seat,
            room: this.#team.stateFor(run.room).name,
            repo: seat.cwd,
            runtime: seat.runtime,
            run: run.id,
            vars: run.vars,
          }),
        ),
      )
    } catch (error) {
      /* And it does not count against the budget. The budget is there to stop
         a seat that *starts and stops* from draining an account; a send that
         never reached the agent bought nothing and spent nothing, and
         charging for it would use the allowance up on a runtime that was
         merely not running yet. */
      const arr = [...(this.#rearms.get(key) ?? [])]
      const idx = arr.indexOf(slot)
      if (idx !== -1) {
        arr.splice(idx, 1)
        this.#rearms.set(key, arr)
      }
      this.#port.log('a flow seat could not be re-armed', {
        run: run.id,
        role: seat.role,
        error: error instanceof Error ? error.message : String(error),
      })
      return
    }
    this.#stoppedSeats.delete(key)
    const currentRun = (this.#runs.get(run.id) ?? run) as StoredRun
    const recovering = currentRun.state === 'stalled'
    const currentRecord = Array.isArray(currentRun.record) ? currentRun.record : []
    this.#runs.set(currentRun.id, {
      ...currentRun,
      ...(recovering ? { state: 'running', ended: null } : {}),
      record: [
        ...currentRecord,
        {
          at: now(),
          kind: 'seated',
          role: seat.role,
          seat: seat.seat,
          text: `re-armed: its turn ended while the flow was still running (${spent.length + 1} this hour)`,
        },
      ],
    })
    if (recovering) {
      this.#port.log('a stalled flow run recovered and returned to running', {
        run: currentRun.id,
        seat: seat.seat,
      })
    }
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
    const record = Array.isArray(run.record) ? run.record : []
    this.#runs.set(id, {
      ...run,
      state: 'stopped',
      endedAt: now(),
      ended: why,
      record: [...record, { at: now(), kind: 'stopped', text: why }],
    })
    this.#port.log('a flow stopped because its seats never took the tools', {
      run: id,
      seats: named,
    })
    this.#release(run, why)
    this.#save(id)
  }

  /**
   * Checks whether the run has stalled because no seat of a role with open
   * work is answering.
   *
   * A seat whose budget is spent stops being re-armed; when every seat of
   * the role holding the current round has stopped, the run has become a
   * zombie that can never make progress. Marking it stalled surfaces what
   * happened to the room and stands down any remaining waiting seats.
   */
  #checkStalled(id: string): void {
    const run = this.#runs.get(id)
    if (!run || run.state !== 'running') return
    const round = run.rounds[run.rounds.length - 1]
    if (!round) return
    const board = this.#team.stateFor(run.room)
    const cards = round.intents.map((one) => board.intents.find((card) => card.id === one))
    const open = cards.filter((card) => !card || (card.state !== 'done' && card.state !== 'abandoned'))
    if (open.length === 0) return

    const roleSeats = run.seats.filter((s) => s.role === round.role)
    const answering = roleSeats.filter((s) => !this.#stoppedSeats.has(s.key))
    if (roleSeats.length > 0 && answering.length === 0) {
      const named = roleSeats.map((s) => s.seat).join(', ')
      const why = `no seat answering for ${round.role} (${named}): re-arm budget exhausted`
      const record = Array.isArray(run.record) ? run.record : []
      this.#runs.set(id, {
        ...run,
        state: 'stalled',
        ended: why,
        record: [
          ...record,
          {
            at: now(),
            kind: 'stalled',
            role: round.role,
            text: why,
          },
        ],
      })
      this.#port.log('a flow run stalled because no seat of a role with open work is answering', {
        run: id,
        role: round.role,
        seats: roleSeats.map((s) => s.seat),
      })
      const watch = this.#watching.get(id)
      if (watch) clearTimeout(watch)
      this.#watching.delete(id)
      this.#release(run, why)
      this.#save(id)
    }
  }

  /** Stops every active flow run in a room that was deleted. */
  deleteRoom(room: string): void {
    void this.#executions?.stopGoal(room, 'the room this flow ran in was deleted')
    for (const run of this.#runs.values()) {
      if (run.room === room && (run.state === 'running' || run.state === 'stalled')) {
        this.stop(run.id, 'the room this flow ran in was deleted')
      }
    }
  }

  /** Why this seat should stop waiting — the one thing that may end its turn. */
  standDown(room: string, runtime: string, sessionId: string): string | null {
    const modern = this.#executions?.standDown(room, runtime, sessionId) ?? null
    if (modern) return modern
    const key = `${runtime}\u0000${sessionId}`
    const held = [...this.#held.values()].find((one) => one.run.room === room && one.run.seats.some((seat) => seat.key === key))
    if (held && ![...this.#runs.values()].some((one) => one.room === room && one.state === 'running')) return held.reason
    const runs = [...this.#runs.values()]
      .filter(
        (one) => one.room === room && Array.isArray(one.seats) && one.seats.some((seat) => seat.key === key),
      )
      .sort((a, b) => a.startedAt - b.startedAt)
    if (runs.length === 0) return null
    if (runs.some((one) => one.state === 'running')) return null
    const run = runs[runs.length - 1]!
    if (run.state === 'stalled') {
      const round = run.rounds[run.rounds.length - 1]
      const seat = run.seats.find((s) => s.key === key)
      if (round && seat && seat.role !== round.role) return null
    }
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
    if (!run.rounds || run.rounds.length === 0) return
    const round = run.rounds[run.rounds.length - 1]
    if (!round) return
    const board = this.#team.stateFor(run.room)
    const cards = round.intents.map((one) => board.intents.find((card) => card.id === one))
    if (cards.some((card) => !card || (card.state !== 'done' && card.state !== 'abandoned'))) return

    if (because?.outcome !== undefined) {
      const record = Array.isArray(run.record) ? run.record : []
      this.#runs.set(id, {
        ...run,
        record: [
          ...record,
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
      const record = Array.isArray(current.record) ? current.record : []
      this.#runs.set(id, {
        ...current,
        state: 'settled',
        endedAt: now(),
        ended: why,
        record: [...record, { at: now(), kind: 'settled', role: round.role, text: why }],
      })
      this.#release(current, why)
      this.#save(id)
      return
    }
    /* Only completed cards are dependencies for the next round: an abandoned
       card has no context package to hand over, and passing it into dependsOn
       leaves downstream cards blocked forever by the team graph (#440). */
    const completedIntents = cards
      .filter((card): card is NonNullable<typeof card> => card !== undefined && card.state === 'done')
      .map((card) => card.id)
    this.#open(current, fired.then.role, fired.then, fired.id, completedIntents)
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
      const vars = cardVars({
        flow: run.flow.name,
        run: run.id,
        room: board.name,
        repo: board.root,
        role: role.id,
        round: n,
        n: index,
        count: role.count,
        ...(before ? { from: before.role, answered: before.intents.length } : {}),
        vars: run.vars,
      })
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
    const currentRun = this.#runs.get(run.id) as StoredRun
    const currentRounds = Array.isArray(currentRun.rounds) ? currentRun.rounds : []
    const currentRecord = Array.isArray(currentRun.record) ? currentRun.record : []
    this.#runs.set(run.id, {
      ...currentRun,
      rounds: [...currentRounds, round],
      record: [
        ...currentRecord,
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
    const baseCwd = board.cwd ?? board.root
    const isAbs = check.cwd ? isAbsolute(check.cwd) || check.cwd.startsWith('/') || /^[A-Za-z]:[\\/]/.test(check.cwd) : false
    const cwd = check.cwd ? (isAbs ? check.cwd : join(baseCwd, check.cwd)) : baseCwd
    for (const intent of round.intents) {
      const current = this.#runs.get(id)
      if (!current || current.state !== 'running') return
      const card = board.intents.find((c) => c.id === intent)
      if (card && (card.state === 'done' || card.state === 'abandoned')) continue
      const { status } = await this.#port.run(check.run, {
        cwd,
        timeoutSec: check.timeout,
        card: { room: run.room, intent, name: role.id, round: round.n },
      })
      const outcome = status === null ? check.otherwise : (check.exits[String(status)] ?? check.otherwise)
      const note =
        status === null
          ? `${check.run} ran past ${check.timeout}s`
          : `${check.run} exited ${status}`
      const currentRun = this.#runs.get(id) as StoredRun
      const currentRecord = Array.isArray(currentRun.record) ? currentRun.record : []
      this.#runs.set(id, {
        ...currentRun,
        record: [
          ...currentRecord,
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
   *
   * A folder of runs that will not open is raised, and kept — see
   * `#unreadable` for why it outlives this call.
   */
  async load(): Promise<void> {
    let names: string[]
    try {
      names = await readdir(this.#dir)
    } catch (error) {
      /* Nothing but `#save` writes this folder, so only a folder not made yet
         is "no runs" — unlike a project's `.harnessdesk`, which is somebody
         else's to make a file of. */
      if (!NOTHING_YET.has(errnoOf(error))) {
        this.#unreadable = new Error(
          `The flow runs this desk keeps could not be read — ${
            error instanceof Error ? error.message : String(error)
          }. Until they can be, it cannot tell which flows are running, so it will not start another on top of one. Fix that folder, then restart HarnessDesk.`,
          { cause: error },
        )
        throw error
      }
      names = []
    }
    for (const name of names) {
      if (!name.endsWith('.json')) continue
      let raw: unknown = null
      try {
        raw = JSON.parse(await readFile(join(this.#dir, name), 'utf8'))
        const run = legacyRunOf(raw) as StoredRun
        this.#runs.set(run.id, run)
      } catch (error) {
        /* Kept on disk as it is. A broken file that still names its room
           blocks that room; one that names nothing blocks every start. */
        const room = typeof (raw as { room?: unknown } | null)?.room === 'string' && (raw as { room: string }).room
          ? (raw as { room: string }).room : null
        if (room) this.#blocked.set(room, CORRUPT_RUN)
        else this.#corrupt = CORRUPT_RUN
        this.#port.log('a stored flow run could not be read', { file: name, error: String(error) })
      }
    }
    for (const run of [...this.#runs.values()]) {
      if (run.state !== 'running' && run.state !== 'stalled') continue
      /* Old runs answer to the Goal and the Seats phase 5 kept for them. One
         that cannot be matched, or whose check may already have run, is held
         with its reason: its file is not rewritten and nothing is re-run. */
      let decision: string
      try {
        decision = recoveryOf({
          terminal: false,
          ...this.#goalState(run.room),
          seatsMapped: legacySeatsMapped(run, this.#port.recovery.seats(run.room)),
          uncertainCheck: legacyCheckUncertain(run, this.#team.hasRoom(run.room) ? this.#team.stateFor(run.room).intents : []),
        })
      } catch (error) {
        decision = `This run could not be matched to its Goal: ${error instanceof Error ? error.message : String(error)}`
      }
      if (decision !== 'resume') {
        this.#runs.delete(run.id)
        this.#held.set(run.id, { run, reason: decision })
        await this.#sidecar(run, decision)
        continue
      }
      if (run.state === 'running') {
        try {
          await this.#advance(run.id)
        } catch (error) {
          this.#port.log('a running flow could not advance during reconciliation', {
            run: run.id,
            error: error instanceof Error ? error.message : String(error),
          })
        }
      }
    }
    await this.#executions?.load(executionOf)
  }

  /**
   * The recovery decision for an old run, beside it under `flows-v2/`: the old
   * file stays exactly as it was, so undoing the decision is deleting this.
   */
  async #sidecar(run: StoredRun, reason: string): Promise<void> {
    if (!this.#executions) return
    const document = { format: 'legacy' as const, flow: run.flow }
    const sidecar: StoredFlowExecution = {
      version: 2, id: run.id, goal: run.room, document, state: 'stalled', rounds: [], operations: [],
      legacyRun: run, reason, compiled: { document, bindings: [], problems: [] }, source: '', sourcePath: run.source ?? null,
      vars: run.vars ?? {}, startedAt: run.startedAt, updatedAt: now(),
      authorization: { sourceDigest: sourceDigest(''), commandDigest: sourceDigest(''), approvedAt: run.startedAt }, operationTimes: {},
    }
    try {
      await new ExecutionFiles(join(this.#dir, '..', 'flows-v2')).save(sidecar)
    } catch (error) {
      this.#port.log('a held flow run could not record why', { run: run.id, error: error instanceof Error ? error.message : String(error) })
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
   * healthy run wakes nobody. Open check rounds are also resumed here: a check
   * has no seat to wake, so without `#runChecks` a run interrupted during a
   * check round stayed deadlocked on its open card forever (#437).
   */
  async resume(): Promise<void> {
    for (const run of [...this.#runs.values()]) {
      if (run.state !== 'running') continue
      await this.#armFor(run.id)
      await this.#runChecks(run.id)
    }
    await this.#executions?.resume()
  }

  #save(id: string): FlowRun {
    const run = this.#runs.get(id) as StoredRun
    this.#port.changed(run.room, this.#runsIn(run.room))
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
