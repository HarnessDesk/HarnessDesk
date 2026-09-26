import { createHash } from 'node:crypto'
import { mkdir, open, readdir, readFile, rename, unlink } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'

import { DEFAULT_FLOW_BUDGET } from '@harnessdesk/protocol'
import type {
  CompiledFlow,
  EvidenceView,
  FindingId,
  FindingOverride,
  FindingRunState,
  FindingSeries,
  FlowBinding,
  FlowCheck,
  FlowCheckContext,
  FlowExecution,
  FlowOperation,
  FlowPolicy,
  FlowPolicyRule,
  FlowRoundState,
  FlowStartTarget,
  FlowSeat,
  FlowThen,
  GoalCreateInput,
  GoalOrigin,
  GoalSeatRequest,
  Intent,
  Lane,
  RepairLead,
  SeatRecord,
  TriggerDefinition,
  TriggerFact,
} from '@harnessdesk/protocol'

import { ConfinedTree } from './confined-tree.js'
import { cardVars, guardHolds } from './flow.js'
import {
  evidenceValues, namesEvidence, readyGuard, renderCardTemplate, type FindingsGate, type FlowEvidenceContext, type FlowSubject,
} from './flow-evidence.js'
import { decideLoop, QUESTION_STOP } from './findings/rounds.js'
import type { FindingJournal, FindingJournalEntry } from './findings/journal.js'
import type { PublicationEntry, PublicationJournal, StoredPublication } from './findings/publication.js'
import type { TriggerClosure } from './intake/consent.js'
import { effectiveBudget } from './intake/definition.js'
import type { Team } from './team.js'

/**
 * A flow run as execution state on one Goal.
 *
 * A run is not a room with members: it is the Goal's rounds, the cards each
 * round opened, and the Seats the Goal opened for those cards — each one
 * journaled here before the external work it stands for starts. Membership
 * is the Goal's Seats and nothing else.
 *
 * Every step that reaches outside the desk — a card on the board, a Seat and
 * its conversation, an order sent to it — is written as `prepared`, then
 * `started`, then `finished`. A restart that finds a step `started` and cannot
 * tell from the board whether it happened marks it `uncertain` and stops the
 * run for a person, rather than doing it a second time.
 */

export type StoredFlowExecution = FlowExecution & {
  compiled: CompiledFlow
  source: string
  sourcePath: string | null
  vars: Readonly<Record<string, string>>
  startedAt: number
  updatedAt: number
  /** `start: 'front-door'` marks a start whose Seats must hold their ceilings; its run must then carry `requireHeld`. */
  authorization: { sourceDigest: string; commandDigest: string; approvedAt: number; start?: 'front-door' }
  /** The empty Goal a front-door start reserved, journaled with its start before the reservation is written. */
  reserving?: { readonly goal: string; readonly revision: number }
  operationTimes: Readonly<Record<string, { preparedAt: number; startedAt: number | null; finishedAt: number | null }>>
  /** Each check round's plan, by round number, written when the round's cards were: see `CheckPlan`. */
  checkPlans?: Readonly<Record<string, CheckPlan>>
  /** Each finding command a Seat of this run made, by operation key, journaled before its record is appended. */
  findingOps?: Readonly<Record<string, FindingJournalEntry>>
  /** A later review round's package, by round number: pinned before its Seats open, handed to each in its order. */
  reviewPackets?: Readonly<Record<string, ReviewPacketPin>>
  /** Each closed round's release decision and every comment it posts, journaled before the first is sent. */
  publication?: StoredPublication
}

/** What a later review round was handed, and the subject revisions it was pinned to. */
export interface ReviewPacketPin {
  readonly text: string
  readonly pinned: readonly { readonly cwd: string; readonly at: string }[]
  /** The same delta as `text`, as ids and revisions only — what a board card leads with, never the rendered prose. */
  readonly leads: readonly RepairLead[]
}

/**
 * Where and at which revision each card of a check round runs, decided once
 * when the round opens and journaled beside its cards. A first run and every
 * retry read this and nothing else: a card never re-derives its checkout
 * from whichever writers happen to be clean later, and a checkout whose head
 * has moved since is refused rather than checked in its new state.
 */
export interface CheckPlan {
  /** `HARNESSDESK_FLOW_CONTEXT`, as every card of the round receives it. */
  readonly context: string
  /** One per card, in the round's card order. `at` is null only for a checkout with no commit. */
  readonly targets: readonly { readonly cwd: string; readonly at: string | null }[]
  /** Why no card of this round may run at all (its `cwd` is outside the project), or null. */
  readonly refused: string | null
}

/** What `startGoal` is handed: a compiled, authorized policy. Preview and its token are a later step's. */
export interface FlowStartRequest {
  readonly root: string
  readonly cwd?: string
  readonly sentence: string
  readonly source: string
  readonly sourcePath: string | null
  readonly compiled: CompiledFlow
  readonly vars?: Readonly<Record<string, string>>
  readonly authorization: StoredFlowExecution['authorization']
  /** From a strict preview token only: every Seat this run opens must hold its ceiling. */
  readonly requireHeld?: true
  /** From a strict preview token only: the empty Goal this run lands on, at the revision the preview saw. */
  readonly goal?: { readonly id: string; readonly revision: number }
  /** From a strict preview token only: what the run works on, as the host resolved it. A head pins every Seat to it. */
  readonly target?: FlowStartTarget
}

/**
 * What `startTriggered` is handed (phase 8): the firing's key and the run id
 * it reserved, the trigger's Goal (already made under its own reserved id),
 * the closure digest its arm consented to, the frozen definition and fact,
 * and the host evidence the firing observed. Host-only: no wire method
 * reaches it, and it never redeems a person's start token.
 */
export interface TriggerStartRequest {
  readonly key: string
  readonly id: string
  readonly goal: string
  readonly root: string
  readonly closureDigest: string
  readonly definition: TriggerDefinition
  readonly fact: TriggerFact
  readonly evidence: readonly string[]
}

/** A firing the run could not take, said as a reason a person reads: not a storage failure, and not retried as one. */
export class TriggerRefusal extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TriggerRefusal'
  }
}

/** Why a trigger's run holds instead of dispatching: its dispatch is held until its firing is recorded. */
/** How long a released trigger Seat's interrupted turn is waited for before its release is tried anyway. */
const RELEASE_WAIT_MS = 10_000
export const CHECK_INTERRUPTED = 'This check was stopped part-way when unattended work was paused or stopped. Inspect its effects, then choose Run again.'
/** Why a Seat of a run pinned to one commit was given no work: its checkout is somewhere else. */
export const NOT_AT_TARGET = (card: number): string =>
  `The Seat for card #${card} did not open at the commit this run reviews, so it was given no work. Start the review again.`
/** Why a review of a branch, a pull request or a diff does not land on an existing Goal. */
export const REVIEW_OWN_GOAL = 'A review of a branch, a pull request or a diff starts a Goal of its own. Start it from the project instead of this Goal.'
export const DISPATCH_HELD = 'This run is waiting for its trigger firing to be recorded before it sends any work.'
/** What a trigger's run says when what it would run no longer matches what was armed. */
export const TRIGGER_CLOSURE_CHANGED = 'What this trigger runs changed after it fired, so nothing was started. Arm it again, then start this work.'
/** A run id a trigger reserves. */
export const TRIGGER_RUN_ID = /^flow-trigger-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/**
 * The host, as a run on a Goal needs it. The first four are the plan's
 * boundary; the rest are the reads and sends a round cannot happen without.
 */
export interface FlowExecutionPort {
  /** Which vendor a session of this runtime in `cwd` reaches, as its adapter reports it; null when unknown. */
  providerOf(runtime: string, cwd: string): Promise<string | null>
  /** GoalPlane.seat: resolves the Agent, opens and records the Seat, hands over its brief, claims `card`. */
  openSeat(input: GoalSeatRequest): Promise<SeatRecord>
  release(goal: string, seat: string): Promise<void>
  canDispatch(goal: string): { ok: true } | { ok: false; reason: string }
  /** `at`, host-only: the commit every Seat of the new Goal works at, each in a checkout of its own cut from it. */
  createGoal(input: GoalCreateInput & { readonly at?: string }): Promise<{ readonly id: string }>
  /**
   * Reserves an existing empty Goal for this run, in the Goal queue, against
   * the revision its preview saw: open, same project, no card, no Seat, ready
   * to dispatch and not reserved already. Throws a sentence otherwise. Found
   * again by `goalsOf` after a restart, like a Goal this run made.
   */
  reserveGoal?(input: { readonly goal: string; readonly revision: number; readonly run: string; readonly operation: string; readonly root: string }): Promise<void>
  /**
   * Lets go of this run's reservation of an existing Goal — only while it is
   * still this run's, and a no-op otherwise — so a run that ended before its
   * first round does not keep the Goal from every later start.
   */
  releaseGoal?(input: { readonly goal: string; readonly run: string; readonly operation: string }): Promise<void>
  /** Goals whose origin names this run: how an interrupted create is found instead of repeated. */
  goalsOf(run: string): readonly string[]
  seatOf(id: string): SeatRecord | null
  /** Open Seats kept on this Goal. */
  seatsOn(goal: string): readonly SeatRecord[]
  /** The Agent's current brief digest where this Goal would read it; null when it cannot be read. */
  digestOf(goal: string, agent: string): Promise<string | null>
  /** Sends one turn to a Seat's conversation. */
  order(seat: SeatRecord, text: string): Promise<void>
  /**
   * Whether a Seat's conversation is inside a turn now — its brief's own turn,
   * say — and so would refuse another message until that turn ends. Absent,
   * never.
   */
  busy?(seat: SeatRecord): boolean
  /**
   * Interrupts a Seat's live turn, keeping what it already said: what a
   * trigger's run does to every Seat it releases, so no turn it started
   * outlives it. Absent, nothing is interrupted.
   */
  interrupt?(seat: SeatRecord): Promise<void>
  /** The lane a Seat was given, or null when it has none. */
  laneOf(seat: SeatRecord): Lane | null
  /** Puts a Seat back on the model and effort it was opened on and says what it is running. */
  reseat(seat: SeatRecord): Promise<string>
  changed(goal: string, runs: readonly FlowExecution[]): void
  log(message: string, details?: Readonly<Record<string, unknown>>): void
  /**
   * A checkout's live branch head and whether it holds uncommitted changes,
   * read fresh — never the stale head a Seat was opened with. Null head
   * outside a repository or before its first commit.
   */
  headOf(cwd: string, branch: string | null): Promise<{ readonly at: string | null; readonly dirty: boolean }>
  /**
   * Runs a flow's check command through the bounded runner, and records its
   * result as that card's check evidence, awaited before this resolves — a
   * card is never marked done on an unsaved fact. `problem` is set only when
   * the command finished but its evidence could not be saved; the command's
   * own result is still returned alongside it, never discarded.
   */
  runCheck(
    command: string,
    where: { readonly cwd: string; readonly timeoutSec: number; readonly flowContext?: string; readonly signal?: AbortSignal },
    card: { readonly goal: string; readonly card: number; readonly name: string; readonly round: number },
  ): Promise<{ readonly result: { readonly exit: number | null; readonly timedOut: boolean; readonly tail: string }; readonly evidence: string | null; readonly problem: string | null }>
}

/** A person decision's actions on one run, each run inside the run's queue a `withDecision` step already holds. */
export interface RunDecisionOps {
  authorizeExtraRound(round: number, reason: string): Promise<void>
  recordExceptionDecision(findings: readonly FindingId[], admit: boolean): Promise<void>
  recordOverride(override: FindingOverride): Promise<void>
  recordDecisionStamp(stamp: string, key: string): Promise<void>
  /** The person's Drop: the run stops. Its listeners (unsent postings skipped) are told once the step is done. */
  stop(why: string): Promise<void>
}

// ------------------------------------------------------------------ one queue

/** One queue per run: board completions, evidence notices, stop and restart reconciliation take turns. */
export class SerialRun {
  private tails = new Map<string, Promise<void>>()
  async within<T>(id: string, work: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(id) ?? Promise.resolve()
    const next = previous.then(work)
    const tail = next.then(() => undefined, () => undefined)
    this.tails.set(id, tail)
    try { return await next } finally { if (this.tails.get(id) === tail) this.tails.delete(id) }
  }
  /**
   * Waits for every run's queue to empty, including work a turn queues on
   * itself while running — a check's own completion opening its next round,
   * say, which re-enters `within` for the same id before the outer call has
   * returned. A single snapshot of `tails` taken before that reentry would
   * miss the promise it queues, so this reads the map again after each wait
   * until nothing is left, rather than once.
   */
  async idle(): Promise<void> {
    let guard = 0
    while (this.tails.size > 0) {
      if (++guard > 10_000) throw new Error('SerialRun.idle() never quieted down: something keeps re-queuing work.')
      await Promise.all([...this.tails.values()])
    }
  }
}

// ------------------------------------------------------------------- storage

export const CORRUPT_RUN = 'A saved flow run could not be read. Restore its state file before starting another run.'

/** `flows-v2/` under the host's state: one file per run, written whole, synced and renamed into place. */
export class ExecutionFiles {
  constructor(readonly dir: string) {}

  #file(id: string): string {
    return join(this.dir, `${encodeURIComponent(id)}.json`)
  }

  async save(run: StoredFlowExecution): Promise<void> {
    await mkdir(this.dir, { recursive: true })
    const target = this.#file(run.id)
    const temporary = `${target}.${process.pid}.${Date.now()}.writing`
    const handle = await open(temporary, 'wx', 0o600)
    try {
      await handle.writeFile(JSON.stringify(run), 'utf8')
      await handle.sync()
    } finally {
      await handle.close()
    }
    try {
      await rename(temporary, target)
    } catch (error) {
      await unlink(temporary).catch(() => {})
      throw error
    }
    const folder = await open(this.dir, 'r')
    try { await folder.sync() } finally { await folder.close() }
  }

  /** Every file as it was read, or why it could not be: a broken file is never skipped silently. */
  async list(): Promise<readonly { readonly file: string; readonly raw: unknown; readonly error: string | null }[]> {
    let names: string[]
    try {
      names = await readdir(this.dir)
    } catch (error) {
      if ((error as { code?: string }).code === 'ENOENT') return []
      throw error
    }
    const out: { file: string; raw: unknown; error: string | null }[] = []
    for (const name of names.filter((one) => one.endsWith('.json')).sort()) {
      try {
        out.push({ file: name, raw: JSON.parse(await readFile(join(this.dir, name), 'utf8')), error: null })
      } catch (error) {
        out.push({ file: name, raw: null, error: error instanceof Error ? error.message : String(error) })
      }
    }
    return out
  }
}

// ---------------------------------------------------------------- the pieces

export const sourceDigest = (source: string): string => createHash('sha256').update(source).digest('hex')

export const projectExecution = (run: StoredFlowExecution): FlowExecution => ({
  version: 2,
  id: run.id,
  goal: run.goal,
  document: run.document,
  state: run.state,
  rounds: run.rounds,
  operations: run.operations,
  legacyRun: run.legacyRun,
  reason: run.reason,
  ...(run.findings ? { findings: run.findings } : {}),
  ...(run.intake ? { intake: run.intake } : {}),
  ...(run.requireHeld ? { requireHeld: true as const } : {}),
  ...(run.target ? { target: run.target } : {}),
})

/** A new-format run's findings bookkeeping, frozen at its start: the budget its file named, or the default. */
export const startingFindings = (policy: FlowPolicy): FindingRunState => ({
  version: 1,
  budget: policy.budget ?? DEFAULT_FLOW_BUDGET,
  closedRounds: [],
  idleRounds: 0,
  progress: [],
  series: [],
  stopped: null,
  extraRound: null,
  overrides: [],
  lastDecision: null,
})

/** A run as the findings plane reads it at a round's close: its rounds, which of them review, and each review Seat's stable slot. */
export interface FindingRunSnapshot {
  readonly id: string
  readonly goal: string
  readonly state: FlowExecution['state']
  /** Why the run itself is in that state — set when it stopped or settled; null while it is still live. */
  readonly reason: string | null
  readonly findings: FindingRunState | null
  readonly rounds: readonly (FlowRoundState & { readonly reviews: boolean })[]
  /** A review's Seat as its role, its place in the round and its Agent: the same slot however often it is seated. */
  readonly slots: Readonly<Record<string, string>>
  /** Finding commands a stop left part-way: no round closes over one. */
  readonly pendingFindings: number
  /** Each later review round's pinned subject revisions: a finding or verdict there judges exactly these. */
  readonly pinned: Readonly<Record<string, readonly { readonly cwd: string; readonly at: string }[]>>
  /** Each later review round's repair lead, by round: absent for a first review, which has no packet. */
  readonly leads: Readonly<Record<string, readonly RepairLead[]>>
}

const policyOf = (run: StoredFlowExecution): FlowPolicy => {
  if (run.document.format !== 'agents') throw new Error('This run uses the old format and is run by the old engine.')
  return run.document.flow
}

const bindingsFor = (run: StoredFlowExecution, role: string): FlowBinding[] =>
  run.compiled.bindings.filter((binding) => binding.role === role).sort((a, b) => a.index - b.index)

/** A revision under judgment: see the invariant at `FlowSubject` in `flow-evidence.ts`. */
export type FlowSubjectLike = FlowSubject

/** A dependency walk's answer: the writers' revisions, the writers with none, and every card the walk crossed. */
export interface FlowClosure {
  readonly subjects: readonly FlowSubject[]
  readonly unsettled: readonly { readonly card: number; readonly why: string }[]
  readonly cards: readonly number[]
}

export const INDEPENDENT = 'This step needs an independent provider. Choose a seat from another provider.'
export const BRIEF_CHANGED = 'The Agent brief changed. Start a new run to use it.'
export const CHECK_CWD_OUTSIDE = 'This check points outside the project. Choose a folder inside the project and review it again.'
export const CHECK_UNPLANNED = 'This check’s checkouts were not recorded when its round opened, so it was not run. Start a new run.'
const LANE_REFUSED = 'This step needs its own checkout, ports and browser profile, and they could not all be prepared, so its Seat was released.'

/**
 * Why a round stalled on one Seat that would not open, and what a person can
 * do about it.
 *
 * A round's cards start together (`#seatRound`): every Seat is opened and
 * made durable before any of them is handed its card, so a comparison never
 * runs with one competitor, and a rule never judges a round that only part
 * of started. The siblings are not refused — they were never tried — and the
 * reason says so by number, because "stalled" alone read as though the whole
 * round had failed on its own. The next step names the two ways on from here
 * a person has: fix the seat and start the flow again, or seat an Agent in
 * the Goal and hand it the cards directly.
 */
export const seatRefused = (card: number, cards: readonly number[], why: string): string => {
  const siblings = cards.filter((one) => one !== card).map((one) => `#${one}`)
  const together = siblings.length === 0
    ? ''
    : `\nA round’s cards start together, so card${siblings.length === 1 ? '' : 's'} ${siblings.join(', ')} ${siblings.length === 1 ? 'was' : 'were'} not started either.`
  const give = siblings.length === 0 ? 'the card' : 'the cards'
  return `The Seat for card #${card} could not be opened: ${why}${together}\n` +
    `Next: fix what stopped card #${card} and start the flow again, or seat an Agent in this Goal and give it ${give} yourself.`
}

/** What a finished round's rule decides: fire one (with the evidence that authorized it), wait, or end the run. */
export type RuleDecision =
  | { readonly kind: 'fire'; readonly rule: FlowPolicyRule; readonly evidence: readonly string[] }
  | { readonly kind: 'wait'; readonly rule: FlowPolicyRule; readonly reason?: string }
  /** `passed`: each guarded rule whose answers matched but whose evidence contradicted it, and why. */
  | { readonly kind: 'none'; readonly passed?: readonly { readonly rule: string; readonly reason: string }[] }

/** What one rule's evidence guard decided, however it was computed. `reason` says what it waits for, or what contradicted it. */
export type RuleEvidence =
  | { readonly state: 'matched'; readonly evidence: readonly string[] }
  | { readonly state: 'no-match' | 'waiting'; readonly reason?: string }

/**
 * Rules are three-valued and read in file order. A rule whose answers match
 * but whose evidence is not yet known waits, and a later fallback cannot
 * overtake it. `evidence` is asked only for a rule whose answers already
 * matched and which actually names a guard, since evaluating one reads git
 * and the evidence store.
 */
export const decide = async (
  policy: FlowPolicy,
  role: string,
  outcomes: readonly (string | null)[],
  evidence: (rule: FlowPolicyRule) => Promise<RuleEvidence>,
): Promise<RuleDecision> => {
  const passed: { rule: string; reason: string }[] = []
  for (const rule of policy.rules) {
    if (rule.on !== role) continue
    const answers = rule.when && (rule.when.every?.length || rule.when.any?.length)
      ? guardHolds({ ...(rule.when.every?.length ? { every: rule.when.every } : {}), ...(rule.when.any?.length ? { any: rule.when.any } : {}) }, outcomes)
      : outcomes.length > 0
    if (!answers) continue
    if (!rule.when?.evidence?.length) return { kind: 'fire', rule, evidence: [] }
    const found = await evidence(rule)
    if (found.state === 'matched') return { kind: 'fire', rule, evidence: found.evidence }
    if (found.state === 'waiting') return { kind: 'wait', rule, ...(found.reason ? { reason: found.reason } : {}) }
    if (found.reason) passed.push({ rule: rule.id, reason: found.reason })
  }
  return passed.length > 0 ? { kind: 'none', passed } : { kind: 'none' }
}

/** A check's `cwd` as the confined tree reads it: `.` and `./sub/` name the Goal checkout and `sub` inside it. */
const insideRelative = (cwd: string): string => {
  const trimmed = cwd.replace(/^(\.\/)+/, '').replace(/\/+$/, '')
  return trimmed === '.' ? '' : trimmed
}

/** The run's own journal refused a write — a storage failure, not a refusal of the step. */
class JournalWriteError extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause), { cause })
    this.name = 'JournalWriteError'
  }
}

const done = (card: Intent | undefined): boolean => card?.state === 'done' || card?.state === 'abandoned'

/** What a run records when its Seat's question on `card` went unanswered: one sentence, written and recognised here. */
const questionStall = (card: number, reason: string): string => `Card #${card}: its Seat ${reason}. Its answer so far is kept.`

const now = (): number => Date.now()

export interface FlowExecutionsOptions {
  readonly now?: () => number
  /**
   * Every fact attributable to a Goal, in append order, each with its
   * freshness computed now — the evidence store's own sequence, never the
   * board's folded display. Absent, every guard waits: a desk with no
   * evidence plane attached never fabricates a match.
   */
  readonly facts?: (goal: string) => Promise<readonly EvidenceView[]>
  /**
   * Phase 8: how a trigger's run is compiled — the same frozen closure its
   * arm consented to, re-read — which Goal a trigger made, and the gate every
   * one of its dispatches passes (budgets, pause, consent). Absent, no
   * trigger run starts.
   */
  readonly triggered?: {
    freeze(root: string, definition: TriggerDefinition): Promise<TriggerClosure>
    originOf(goal: string): GoalOrigin | null
    /**
     * `transient` marks a refusal that lifts on its own — a pause, the daily
     * cap: the run is held, never stalled or stopped, and its release
     * continues it. Any other refusal stalls the run for a person.
     */
    gate?(run: FlowExecution): Promise<{ readonly ok: true } | { readonly ok: false; readonly reason: string; readonly transient?: boolean }>
  }
}

/** Runs on Goals. `Flows` hands every Goal-born run and every card of one to this. */
export class FlowExecutions {
  readonly #files: ExecutionFiles
  readonly #team: Team
  readonly #port: FlowExecutionPort
  readonly #now: () => number
  readonly #facts: FlowExecutionsOptions['facts'] | null
  readonly #triggered: FlowExecutionsOptions['triggered'] | null
  readonly #queue = new SerialRun()
  #runs = new Map<string, StoredFlowExecution>()
  /** The checks running now, by Goal: what a pause or a stop aborts without waiting for the run's queue. */
  readonly #checks = new Map<string, Set<AbortController>>()
  /** Goals a broken run file names: no new round opens on them until it is restored. */
  #blocked = new Map<string, string>()
  /** Set when a run file names no readable Goal: nothing new starts anywhere. */
  #corrupt: string | null = null
  #rearms = new Map<string, number[]>()
  /** Told when a round of a run with findings bookkeeping closes: the findings plane's close processing. */
  readonly #closeListeners = new Set<(run: string, round: number) => void | Promise<void>>()
  /** Close processing a listener started, so `idle()` waits for it as it waits for the run queues. */
  readonly #closing = new Set<Promise<void>>()
  /** The closes being processed now, by run and round: never two of one close at once. */
  readonly #processingCloses = new Set<string>()
  /** What a ready rule also needs besides its guards: no open admitted blocker and no pending exception. */
  #findingsGate: ((run: string) => Promise<FindingsGate | null>) | null = null
  /** A later review round's package, read before its Seats open; throws when the delta cannot be read in full. */
  #reviewPackets: ((run: string, round: number, role: string, subjects: readonly FlowSubject[]) => Promise<ReviewPacketPin | null>) | null = null

  constructor(files: ExecutionFiles, team: Team, port: FlowExecutionPort, options: FlowExecutionsOptions = {}) {
    this.#files = files
    this.#team = team
    this.#port = port
    this.#now = options.now ?? now
    this.#facts = options.facts ?? null
    this.#triggered = options.triggered ?? null
  }

  async idle(): Promise<void> {
    let guard = 0
    do {
      if (++guard > 10_000) throw new Error('FlowExecutions.idle() never quieted down.')
      await this.#queue.idle()
      await Promise.all([...this.#closing])
    } while (this.#closing.size > 0)
    await this.#queue.idle()
  }

  // ------------------------------------------------------- round closing

  /**
   * Subscribes to round closes of runs with findings bookkeeping. The
   * listener schedules its work and returns; the engine never awaits it
   * inside a run's queue, and opens no round after a close until the close
   * has been recorded (`recordRoundClose`).
   */
  onRoundClosed(listener: (run: string, round: number) => void | Promise<void>): () => void {
    this.#closeListeners.add(listener)
    return () => this.#closeListeners.delete(listener)
  }

  attachFindingsGate(gate: ((run: string) => Promise<FindingsGate | null>) | null): void {
    this.#findingsGate = gate
  }

  attachReviewPackets(packets: ((run: string, round: number, role: string, subjects: readonly FlowSubject[]) => Promise<ReviewPacketPin | null>) | null): void {
    this.#reviewPackets = packets
  }

  #emitClosed(run: string, round: number): void {
    /* One processing of a close at a time: a person's decision advancing the
       run while its close is still being read would otherwise start a second
       one, and the two would race to record it. */
    const key = `${run}\u0000${round}`
    if (this.#processingCloses.has(key)) return
    this.#processingCloses.add(key)
    const settled: Promise<unknown>[] = []
    for (const listener of this.#closeListeners) {
      try {
        const work = listener(run, round)
        if (work) {
          const tracked = Promise.resolve(work).catch(async (error: unknown) => {
            const why = error instanceof Error ? error.message : String(error)
            this.#port.log('a closed round could not be processed', { run, round, error: why })
            // Never a silent wait: the run stops for a person, saying why, and nothing opens after the round.
            await this.#queue.within(run, () => this.#stall(run, `Round ${round} could not be closed: ${why}`)).catch(() => undefined)
          }).finally(() => this.#closing.delete(tracked))
          this.#closing.add(tracked)
          settled.push(tracked)
        }
      } catch (error) {
        this.#port.log('a closed round could not be processed', { run, round, error: error instanceof Error ? error.message : String(error) })
      }
    }
    void Promise.all(settled).finally(() => this.#processingCloses.delete(key))
  }

  /** A run as the findings plane reads it when one of its rounds closes. */
  findingRun(id: string): FindingRunSnapshot | null {
    const run = this.#runs.get(id)
    if (!run || run.document.format !== 'agents') return null
    const policy = run.document.flow
    const slots: Record<string, string> = {}
    const rounds = run.rounds.map((round) => {
      const role = policy.roles.find((one) => one.id === round.role)
      const bindings = role?.kind === 'agent' ? bindingsFor(run, role.id) : []
      for (const [index, card] of round.cards.entries()) {
        const seat = this.#seatForCard(run, card).seat
        if (seat) slots[String(seat.id)] = `${round.role}:${index}:${bindings[index]?.agent.id ?? seat.seat.runtime}`
      }
      return { ...round, reviews: bindings.some((binding) => binding.agent.produces.includes('review')) }
    })
    const pendingFindings = Object.values(run.findingOps ?? {}).filter((entry) => entry.state === 'prepared').length
    const pinned = Object.fromEntries(Object.entries(run.reviewPackets ?? {}).map(([round, pin]) => [round, pin.pinned]))
    // `?? []`: absent on a packet pinned before repair leads existed; that packet has no lead to show, not a crash reading it back.
    const leads = Object.fromEntries(Object.entries(run.reviewPackets ?? {}).map(([round, pin]) => [round, pin.leads ?? []]))
    return { id: run.id, goal: run.goal, state: run.state, reason: run.reason, findings: run.findings ?? null, rounds, slots, pendingFindings, pinned, leads }
  }

  /**
   * Records a closed round's findings bookkeeping with its close operation
   * finished, in one write, then advances the run from its own queue.
   * Idempotent on the round. `close` is applied here, inside the run's
   * queue, to the run's bookkeeping as it stands now — never to the copy the
   * close read before its awaits — and only the fields a close owns are
   * taken from it: the closed rounds, the idle count, the progress seen, the
   * stop, and the review series (which `close` builds by applying its round's
   * `closeSeries` to the current ones). Everything a person decided while the
   * close was reading — an override, an exception, an extra round, a
   * decision stamp — is kept. Null records nothing but the close itself.
   */
  recordRoundClose(id: string, round: number, close: ((current: FindingRunState) => FindingRunState) | null): Promise<void> {
    return this.#queue.within(id, async () => {
      const run = this.#runs.get(id)
      if (!run?.findings) return
      const key = `close:${round}`
      const operation = run.operations.find((one) => one.key === key)
      if (operation?.state === 'finished') return
      const current = run.findings
      let findings = current
      if (close && !current.closedRounds.includes(round)) {
        const closed = close(current)
        findings = {
          ...current,
          closedRounds: closed.closedRounds,
          idleRounds: closed.idleRounds,
          progress: closed.progress,
          series: closed.series,
          stopped: closed.stopped,
        }
      }
      await this.#put(this.#operation({ ...run, findings }, key, { kind: 'round', state: 'finished', card: null, seat: null }))
      await this.#advance(id)
    })
  }

  /**
   * A person's "Another round": authorizes exactly one further round past a
   * stop this run's findings recorded, then resumes dispatch. `after` is the
   * round the stop named — the same one `#advance`'s stall check compares —
   * so the very next transition it would otherwise block is let through once.
   * Idempotent while that transition has not happened yet: a duplicate press,
   * or a crash before the round actually opens, replays the same one round
   * rather than spending a second.
   */
  async authorizeExtraRound(id: string, round: number, reason: string): Promise<FlowExecution> {
    return this.#queue.within(id, async () => {
      await this.#authorizeExtraRound(id, round, reason)
      return projectExecution(this.#get(id))
    })
  }

  async #authorizeExtraRound(id: string, round: number, reason: string): Promise<void> {
    let run = this.#get(id)
    if (!run.findings) throw new Error('This run keeps no findings bookkeeping to authorize a round on.')
    if (run.state !== 'running' && run.state !== 'stalled') throw new Error(run.reason ?? 'This flow run is not running.')
    const already = run.findings.extraRound
    // The same authorization again — a retry, or a crash before its round opened — replays it; it spends nothing more.
    const replay = run.findings.stopped === null && already?.after === round && already.reason === reason
    if (!replay && (!run.findings.stopped || run.findings.stopped.round !== round)) {
      throw new Error('This run is not stopped at that round any more. Read its status again.')
    }
    if (!replay) {
      // The stop is answered: cleared, so nothing says the run is waiting for a person while its authorized round runs.
      run = await this.#put({ ...run, findings: { ...run.findings, stopped: null, extraRound: { after: round, reason } } })
    }
    run = await this.#put({ ...run, state: 'running', reason: null })
    await this.#advance(id)
  }

  /**
   * A person admits a pending regression or security claim into a series's
   * blocking set, or declines it out of consideration entirely. Only ids
   * still actually pending are touched — a stale id (already decided, or a
   * head that moved the series on) is silently left alone rather than
   * refusing ids that were never a problem, which is what makes a duplicate
   * press of the same decision harmless.
   */
  async recordExceptionDecision(id: string, findings: readonly FindingId[], admit: boolean): Promise<FlowExecution> {
    return this.#queue.within(id, async () => {
      await this.#recordExceptionDecision(id, findings, admit)
      return projectExecution(this.#get(id))
    })
  }

  async #recordExceptionDecision(id: string, findings: readonly FindingId[], admit: boolean): Promise<void> {
    const run = this.#get(id)
    if (!run.findings) throw new Error('This run keeps no findings bookkeeping to decide.')
    const names = new Set(findings)
    const series: readonly FindingSeries[] = run.findings.series.map((one) => {
      const applicable = one.pending.filter((pending) => names.has(pending))
      if (applicable.length === 0) return one
      return {
        ...one,
        pending: one.pending.filter((pending) => !names.has(pending)),
        exceptions: admit ? [...one.exceptions, ...applicable] : one.exceptions,
      }
    })
    await this.#put({ ...run, findings: { ...run.findings, series } })
    await this.#advance(id)
  }

  /**
   * Records the last `finding/decide` this run actually applied, so a
   * resubmission of the same stamp can be told from a genuinely stale one:
   * applying a decision is what moves the run's own read stamp, so without
   * this a lost answer's retry would always look like a conflicting replay.
   * Idempotent on an identical (stamp, key) pair.
   */
  async recordDecisionStamp(id: string, stamp: string, key: string): Promise<FlowExecution> {
    return this.#queue.within(id, async () => {
      await this.#recordDecisionStamp(id, stamp, key)
      return projectExecution(this.#get(id))
    })
  }

  async #recordDecisionStamp(id: string, stamp: string, key: string): Promise<void> {
    const run = this.#get(id)
    if (!run.findings) throw new Error('This run keeps no findings bookkeeping to decide.')
    if (run.findings.lastDecision?.stamp !== stamp || run.findings.lastDecision.key !== key) {
      await this.#put({ ...run, findings: { ...run.findings, lastDecision: { stamp, key } } })
    }
  }

  /**
   * A person's recorded disagreement: unresolved findings stay unresolved,
   * and nothing here edits a check, CI or review to passing. It is never a
   * merge by itself — the existing person merge action, with its own
   * expected-head precondition, is what actually merges.
   */
  async recordOverride(id: string, override: FindingOverride): Promise<FlowExecution> {
    return this.#queue.within(id, async () => {
      await this.#recordOverride(id, override)
      return projectExecution(this.#get(id))
    })
  }

  async #recordOverride(id: string, override: FindingOverride): Promise<void> {
    const run = this.#get(id)
    if (!run.findings) throw new Error('This run keeps no findings bookkeeping to override.')
    const exact = JSON.stringify(override)
    if (!run.findings.overrides.some((one) => JSON.stringify(one) === exact)) {
      await this.#put({ ...run, findings: { ...run.findings, overrides: [...run.findings.overrides, override] } })
    }
  }

  /**
   * One person decision on a run, whole, inside the run's own queue: the
   * read it was made against is checked and the action applied as one step,
   * so two submissions of the same read cannot both pass the check before
   * either applies. `step` is handed this run's decision actions, each run
   * in the queue already held — it must not ask for this run's queue again
   * (host.ts, "Lock order").
   */
  withDecision<T>(id: string, step: (ops: RunDecisionOps) => Promise<T>): Promise<T> {
    if (!this.#runs.has(id)) return Promise.reject(new Error(`There is no flow run ${id}.`))
    return this.#queue.within(id, () => step({
      authorizeExtraRound: (round, reason) => this.#authorizeExtraRound(id, round, reason),
      recordExceptionDecision: (findings, admit) => this.#recordExceptionDecision(id, findings, admit),
      recordOverride: (override) => this.#recordOverride(id, override),
      recordDecisionStamp: (stamp, key) => this.#recordDecisionStamp(id, stamp, key),
      stop: (why) => this.#stopForDecision(id, why),
    }))
  }

  /**
   * The person's Drop, decided: like "another round," the run's own ceiling
   * stop is answered here — cleared, so nothing goes on saying a person is
   * waited on for a round this same decision just settled. Nothing else
   * about a Drop changes: the run itself stopping is `#finish`'s own job.
   */
  async #stopForDecision(id: string, why: string): Promise<void> {
    const run = this.#get(id)
    if (run.findings?.stopped) await this.#put({ ...run, findings: { ...run.findings, stopped: null } })
    await this.#finish(id, 'stopped', why)
  }

  /**
   * A close with no findings plane listening: the round is still counted and
   * the budget still holds, so a desk without the ledger never runs past it.
   */
  async #closeUnwatched(id: string, round: number): Promise<void> {
    const run = this.#get(id)
    const state = run.findings!
    if (state.closedRounds.includes(round)) return
    const closed = state.closedRounds.length + 1
    const limit = Math.max(state.budget.rounds, state.extraRound ? state.extraRound.after + 1 : 0)
    const decision = decideLoop({
      closed, limit, idle: state.idleRounds, idleLimit: state.budget.withoutProgress, newProgress: true,
      unresolvedRepairs: [], unresolved: 0, reviewComplete: false, freshGuards: false, pendingException: false,
    })
    await this.#put(this.#operation({
      ...run,
      findings: { ...state, closedRounds: [...state.closedRounds, round], idleRounds: decision.idle, stopped: decision.next === 'person' ? { round, reason: decision.reason! } : null },
    }, `close:${round}`, { kind: 'round', state: 'finished', card: null, seat: null }))
  }

  /**
   * The open review rounds of a Goal whose several reviewers must not read
   * each other until the round closes: each round's cards and the
   * conversations holding them. Only runs with findings bookkeeping.
   */
  blindRounds(goal: string): readonly { readonly run: string; readonly round: number; readonly cards: readonly number[]; readonly holders: readonly { readonly card: number; readonly runtime: string; readonly sessionId: string }[] }[] {
    // A role that says `blind: false` lets its siblings read each other's finished work; its posting still waits (`embargoedRounds`).
    return this.embargoedRounds(goal).filter((round) => round.blind)
  }

  /**
   * Every open review round with several reviewers, blind or sighted: none of
   * them may post to a forge, and the round's batch is released only once it
   * closes. `blind` is the role's own policy — true unless it says false.
   */
  embargoedRounds(goal: string): readonly { readonly run: string; readonly round: number; readonly blind: boolean; readonly cards: readonly number[]; readonly holders: readonly { readonly card: number; readonly runtime: string; readonly sessionId: string }[] }[] {
    const out: { run: string; round: number; blind: boolean; cards: readonly number[]; holders: { card: number; runtime: string; sessionId: string }[] }[] = []
    for (const run of this.#runs.values()) {
      if (run.goal !== goal || !run.findings || run.document.format !== 'agents' || (run.state !== 'running' && run.state !== 'stalled')) continue
      for (const round of run.rounds) {
        if (round.state === 'closed' || round.cards.length < 2) continue
        const role = run.document.flow.roles.find((one) => one.id === round.role)
        if (role?.kind !== 'agent' || !bindingsFor(run, role.id).some((binding) => binding.agent.produces.includes('review'))) continue
        const holders = round.cards.flatMap((card) => {
          const seat = this.#seatForCard(run, card).seat
          return seat ? [{ card, runtime: seat.session.runtime, sessionId: seat.session.sessionId }] : []
        })
        out.push({ run: run.id, round: round.n, blind: role.blind !== false, cards: round.cards, holders })
      }
    }
    return out
  }

  /**
   * Every review series this Goal has had, across every run — unioned by
   * series id (`role@cwd`), never only the latest run's. A finding this Goal
   * still owns can have been raised under an earlier run than the one open
   * now, and "currently blocking" has to mean the same thing for both. Two
   * runs that somehow share one series id are merged the conservative way:
   * a finding either union ever admits or ever leaves pending stays that way.
   */
  seriesOfGoal(goal: string): readonly FindingSeries[] {
    const merged = new Map<string, FindingSeries>()
    for (const run of this.#runs.values()) {
      if (run.goal !== goal || !run.findings) continue
      for (const series of run.findings.series) {
        const before = merged.get(series.id)
        merged.set(series.id, before ? {
          ...series,
          reviewRounds: [...new Set([...before.reviewRounds, ...series.reviewRounds])].sort((a, b) => a - b),
          initial: [...new Set([...before.initial, ...series.initial])],
          exceptions: [...new Set([...before.exceptions, ...series.exceptions])],
          pending: [...new Set([...before.pending, ...series.pending])],
        } : series)
      }
    }
    return [...merged.values()]
  }

  /** Every person override this Goal has recorded, across every run — what a wrap freezes into its receipt. */
  overridesOfGoal(goal: string): readonly FindingOverride[] {
    const out: FindingOverride[] = []
    for (const run of this.#runs.values()) {
      if (run.goal !== goal || !run.findings) continue
      out.push(...run.findings.overrides)
    }
    return out
  }

  /** An unattended Seat's question went unanswered: its run stops for a person, with the reason. */
  async stopForQuestion(runtime: string, sessionId: string, reason: string): Promise<boolean> {
    for (const run of [...this.#runs.values()]) {
      if (run.state !== 'running') continue
      if (!this.#seatingOf(run, runtime, sessionId)) continue
      await this.#queue.within(run.id, async () => {
        // Read again inside the queue: the card is the one this Seat holds now, not when the deadline fired.
        const seating = this.#seatingOf(this.#get(run.id), runtime, sessionId)
        if (seating) await this.#stall(run.id, questionStall(seating.card, reason))
      })
      return true
    }
    return false
  }

  /**
   * A person answered the question an unattended Seat's turn was stopped on.
   * That turn is over, so the answer cannot go into it: the run goes back to
   * running, durably, and the Seat — reopened first, the way a relaunch
   * reopens one — is handed the question and its answer in a turn of its
   * own, with its card, and carries on. `settle` closes the old question,
   * as answered, right before that turn is sent: never after it has begun.
   * False when no run here stopped on this Seat's question, so the answer is
   * not the flow's to deliver. Throws a sentence when it is and cannot be
   * delivered: before `settle`, the question is kept and the run left
   * stopped on it; after, the run stops with the answer in its reason.
   */
  async answerQuestion(
    runtime: string,
    sessionId: string,
    words: { readonly question: string; readonly answer: string },
    settle: () => Promise<void>,
  ): Promise<boolean> {
    for (const run of [...this.#runs.values()]) {
      if (run.state !== 'stalled' || !this.#seatingOf(run, runtime, sessionId)) continue
      return this.#queue.within(run.id, () => this.#answerQuestion(run.id, runtime, sessionId, words, settle))
    }
    return false
  }

  /**
   * The question was answered in the turn that asked it after all — an
   * answer that landed between its run stopping and its turn being
   * interrupted, or after an interrupt that never took. The run stopped on
   * that question goes back to running; the turn carries on with the answer.
   */
  async answeredInTurn(runtime: string, sessionId: string): Promise<void> {
    for (const run of [...this.#runs.values()]) {
      if (run.state !== 'stalled' || !this.#seatingOf(run, runtime, sessionId)) continue
      await this.#queue.within(run.id, async () => {
        const now = this.#get(run.id)
        const seating = this.#seatingOf(now, runtime, sessionId)
        if (seating && now.state === 'stalled' && now.reason === questionStall(seating.card, QUESTION_STOP)) {
          await this.#put({ ...now, state: 'running', reason: null })
        }
      })
      return
    }
  }

  async #answerQuestion(
    id: string,
    runtime: string,
    sessionId: string,
    words: { readonly question: string; readonly answer: string },
    settle: () => Promise<void>,
  ): Promise<boolean> {
    const stopped = (): boolean => {
      const run = this.#get(id)
      const seating = this.#seatingOf(run, runtime, sessionId)
      return seating !== null && run.state === 'stalled' && run.reason === questionStall(seating.card, QUESTION_STOP)
    }
    if (!stopped()) return false
    // A trigger's run sends nothing its gate would not: read before anything is decided below.
    const intake = this.#get(id).intake
    if (intake) {
      if (intake.dispatchHeld) throw new Error(DISPATCH_HELD)
      const gate = await this.#gateOf(id)
      if (!gate.ok) throw new Error(`Your answer was not sent: ${gate.reason}`)
      if (!stopped()) return false
    }
    /* Read again here, after the gate's await. What is carried past the
       awaits below — the Seat, its round and its binding — is safe to carry:
       only this run's queue writes this run, and it is held throughout; the
       run itself is always read afresh. */
    const run = this.#get(id)
    const seating = this.#seatingOf(run, runtime, sessionId)!
    const card = this.#team.stateFor(run.goal).intents.find((one) => one.id === seating.card)
    if (!card || done(card)) throw new Error(`Card #${seating.card} is already finished, so there is nothing to hand this answer to.`)
    const seat = this.#port.seatOf(seating.seat!)
    if (!seat || seat.closed) {
      throw new Error(`The Seat for card #${card.id} is ${seat ? 'closed' : 'no longer recorded'}, so it cannot be handed your answer. Start a new run to pick up the work.`)
    }
    // A turn still ending — the one the question stopped, or one begun since — is never sent into: the answer waits for it.
    if (this.#port.busy?.(seat)) throw new Error(`The Seat for card #${card.id} is inside a turn now. Answer again once it ends.`)
    const round = run.rounds.find((one) => one.cards.includes(card.id))
    const index = round ? round.cards.indexOf(card.id) : -1
    const binding = round ? bindingsFor(run, round.role)[index] : undefined
    if (!round || !binding) throw new Error(`Card #${card.id} no longer matches a Seat of its round, so it cannot be handed your answer.`)
    const stall = questionStall(card.id, QUESTION_STOP)
    // Durable before the Seat hears anything, and before the person is told it was sent.
    await this.#put({ ...run, state: 'running', reason: null })
    if (!await this.#sameSeat(id, seat, card.id, round.role, 'answered')) throw new Error(this.#get(id).reason ?? 'The Seat could not be reopened.')
    /* Reopening can take a while — a runtime starting that was not up — and
       the gate was read before it began. A limit reached meanwhile still
       holds: read it again right before the hand-back (#939). One that
       lifts on its own leaves the run stopped on the question, still
       answerable; any other stops the run with its reason. */
    if (this.#get(id).intake) {
      const again = await this.#gateOf(id)
      if (!again.ok) {
        await this.#put({ ...this.#get(id), state: 'stalled', reason: again.transient ? stall : again.reason })
        throw new Error(`Your answer was not sent: ${again.reason}`)
      }
    }
    const prefix = `turn:${round.n}:${index}:answer:`
    const key = `${prefix}${this.#get(id).operations.filter((one) => one.key.startsWith(prefix)).length + 1}`
    const lead = [
      'The person has answered the question you asked. Your turn had already been stopped while it waited, so their answer comes to you here.',
      `You asked: ${words.question}`,
      `Their answer: ${words.answer}`,
      'Carry on from where you were, with that answer.',
    ].join('\n\n')
    // The old question closes as answered before the turn that carries the answer begins.
    await settle()
    const refused = await this.#handOver(id, key, seat, card.id, binding, lead)
    const left = this.#get(id)
    if (refused !== null || left.operations.find((one) => one.key === key)?.state === 'prepared') {
      /* Not delivered — refused, or a turn began between the look and the
         send. The question is already closed, so the run stops with the
         answer in its reason: nothing reads as running over an answer the
         Seat never heard, and the answer is not lost. */
      const why = refused ?? 'it started another turn first'
      const kept = left.operations.filter((one) => one.key !== key || one.state !== 'prepared')
      await this.#put({
        ...left, operations: kept, state: 'stalled',
        reason: `Card #${card.id}: your answer (${words.answer}) could not be handed to its Seat: ${why}. Tell it in that conversation.`,
      })
      throw new Error(`Your answer could not be handed to the Seat for card #${card.id}: ${why}.`)
    }
    return true
  }

  /** The latest seating of this conversation on a run, preferring one whose card is still open. */
  #seatingOf(run: StoredFlowExecution, runtime: string, sessionId: string): (FlowOperation & { readonly card: number }) | null {
    const board = run.goal ? this.#team.stateFor(run.goal).intents : []
    const mine = run.operations.filter((one): one is FlowOperation & { readonly card: number } => {
      if (one.kind !== 'seat' || !one.seat || one.card === null) return false
      const record = this.#port.seatOf(one.seat)
      return record?.session.runtime === runtime && record.session.sessionId === sessionId
    })
    return mine.filter((one) => !done(board.find((card) => card.id === one.card))).at(-1) ?? mine.at(-1) ?? null
  }

  /**
   * Whether a conversation is a Seat of a running run a trigger started:
   * nobody is here for its questions, so they wait only as long as this
   * machine says. A run a person started is theirs, and its Seat's question
   * waits for their answer.
   */
  unattended(runtime: string, sessionId: string): boolean {
    return [...this.#runs.values()].some((run) => run.state === 'running' && run.intake !== undefined && run.operations.some((one) => {
      if (one.kind !== 'seat' || !one.seat) return false
      const record = this.#port.seatOf(one.seat)
      return record !== null && record.closed === null && record.session.runtime === runtime && record.session.sessionId === sessionId
    }))
  }

  // ------------------------------------------------------------- reading

  runs(goal?: string): FlowExecution[] {
    return [...this.#runs.values()]
      .filter((run) => goal === undefined || run.goal === goal)
      .sort((a, b) => a.startedAt - b.startedAt)
      .map(projectExecution)
  }

  stored(id: string): StoredFlowExecution | null {
    return this.#runs.get(id) ?? null
  }

  owns(goal: string): boolean {
    return [...this.#runs.values()].some((run) => run.goal === goal)
  }

  /** Why a new run may not start, or open a round on this Goal; null when it may. */
  refusal(goal?: string): string | null {
    if (this.#corrupt) return this.#corrupt
    return goal === undefined ? null : this.#blocked.get(goal) ?? null
  }

  #runOfCard(goal: string, card: number): StoredFlowExecution | null {
    return [...this.#runs.values()].find((run) => run.goal === goal && run.rounds.some((round) => round.cards.includes(card))) ?? null
  }

  /** The Seat bound to a card, from the run's own journal. */
  #seatForCard(run: StoredFlowExecution, card: number): { readonly operation: FlowOperation | null; readonly seat: SeatRecord | null } {
    const operation = run.operations.find((one) => one.kind === 'seat' && one.card === card) ?? null
    return { operation, seat: operation?.seat ? this.#port.seatOf(operation.seat) : null }
  }

  /** Which conversation may take this card, or null for a card no v2 run bound. */
  bindingOf(goal: string, card: number): { readonly session: SeatRecord['session'] | null; readonly opening: boolean } | null {
    const run = this.#runOfCard(goal, card)
    if (!run) return null
    const round = run.rounds.find((one) => one.cards.includes(card))
    const role = run.document.format === 'agents' ? run.document.flow.roles.find((one) => one.id === round?.role) : undefined
    if (role?.kind !== 'agent') return null
    const { operation, seat } = this.#seatForCard(run, card)
    return { session: seat?.session ?? null, opening: operation?.state === 'started' && !operation.seat }
  }

  roundClosed(run: string, round: number): boolean {
    return this.#runs.get(run)?.rounds.find((one) => one.n === round)?.state === 'closed'
  }

  refuseOutcome(goal: string, intent: Intent, outcome: string | null): string | null {
    const run = this.#runOfCard(goal, intent.id)
    if (!run || run.document.format !== 'agents') return null
    const round = run.rounds.find((one) => one.cards.includes(intent.id))!
    const role = run.document.flow.roles.find((one) => one.id === round.role)
    let answers: readonly string[] = []
    if (role?.kind === 'agent') answers = bindingsFor(run, role.id)[round.cards.indexOf(intent.id)]?.agent.answers ?? []
    else if (role?.kind === 'person') answers = role.outcomes
    if (answers.length === 0) return null
    if (outcome === null) return `Refused: #${intent.id} belongs to a flow, so it needs an outcome — one of ${answers.join(', ')}.`
    if (!answers.includes(outcome)) return `Refused: "${outcome}" is not an answer this step accepts. It accepts ${answers.join(', ')}. Nothing was recorded.`
    return null
  }

  /** Whether a card is a writer, whose head is a subject: its binding may change files, and its Agent does not judge. */
  #writer(run: StoredFlowExecution, card: number): boolean {
    const round = run.rounds.find((one) => one.cards.includes(card))
    if (!round || run.document.format !== 'agents') return false
    const role = run.document.flow.roles.find((one) => one.id === round.role)
    if (role?.kind !== 'agent') return false
    const binding = bindingsFor(run, role.id)[round.cards.indexOf(card)]
    // A card that judges is never judged: a reviewer's own checkout is not a
    // subject whatever its grant, exactly as `reviewBinding` offers it only
    // what it depends on.
    return binding !== undefined && binding.grant !== 'read' && !binding.agent.produces.includes('review')
  }

  /**
   * The dependency walk every evidence question starts from (the invariant
   * at `FlowSubject` in `flow-evidence.ts`): from `start` back along
   * `dependsOn` to the nearest round whose cards may change files, each such
   * card's head read now, never trusted from when its Seat opened. Every
   * card the walk crossed is returned too — those are the cards whose facts
   * may speak for the subjects. Bounded, so a corrupt or cyclic `dependsOn`
   * cannot loop.
   */
  async #closure(run: StoredFlowExecution, start: readonly number[]): Promise<FlowClosure> {
    const board = this.#team.stateFor(run.goal)
    const crossed = new Set<number>()
    let frontier = [...new Set(start)]
    for (let hop = 0; hop < 50 && frontier.length > 0; hop += 1) {
      for (const card of frontier) crossed.add(card)
      const writers = frontier.filter((card) => this.#writer(run, card))
      if (writers.length > 0) return { ...(await this.#heads(run, writers)), cards: [...crossed] }
      const next = new Set<number>()
      for (const card of frontier) {
        for (const dep of board.intents.find((one) => one.id === card)?.dependsOn ?? []) if (!crossed.has(dep)) next.add(dep)
      }
      frontier = [...next]
    }
    return { subjects: [], unsettled: [], cards: [...crossed] }
  }

  async #heads(run: StoredFlowExecution, cards: readonly number[]): Promise<Omit<FlowClosure, 'cards'>> {
    const subjects: FlowSubject[] = []
    const unsettled: { card: number; why: string }[] = []
    for (const card of cards) {
      const round = run.rounds.find((one) => one.cards.includes(card))!
      const { seat } = this.#seatForCard(run, card)
      if (!seat) {
        unsettled.push({ card, why: 'its Seat can no longer be read' })
        continue
      }
      const head = await this.#port.headOf(seat.checkout.cwd, seat.checkout.branch)
      if (!head.at) unsettled.push({ card, why: 'its checkout has no commit to judge' })
      else if (head.dirty) unsettled.push({ card, why: 'its checkout has changes that are not committed' })
      else subjects.push({ card, round: round.n, checkout: { cwd: seat.checkout.cwd, branch: seat.checkout.branch }, at: head.at })
    }
    return { subjects, unsettled }
  }

  /** A finished round's subjects, read now. */
  async subjectsOf(goal: string, round: FlowRoundState): Promise<readonly FlowSubject[]> {
    const run = round.cards.length > 0 ? this.#runOfCard(goal, round.cards[0]!) : null
    return run ? (await this.#closure(run, round.cards)).subjects : []
  }

  /** What a finished round's rule is judged against: the walk from its own cards, and the Goal's facts now. */
  async #evidenceContext(run: StoredFlowExecution, round: FlowRoundState, facts: readonly EvidenceView[]): Promise<FlowEvidenceContext> {
    const closure = await this.#closure(run, round.cards)
    const board = this.#team.stateFor(run.goal)
    return {
      goal: run.goal,
      finished: round,
      subjects: closure.subjects,
      unsettled: closure.unsettled,
      cards: closure.cards,
      reviewers: round.seats,
      facts,
      outcomes: round.cards.map((id) => board.intents.find((one) => one.id === id)?.outcome ?? null),
    }
  }

  /** One rule's evidence guard, read fresh. */
  async #guard(run: StoredFlowExecution, round: FlowRoundState, rule: FlowPolicyRule): Promise<RuleEvidence> {
    if (!this.#facts) return { state: 'waiting' }
    // A ready rule of a run with findings bookkeeping also waits on its open admitted blockers.
    const findings = run.findings && this.#findingsGate ? await this.#findingsGate(run.id) : undefined
    const result = readyGuard(rule.when?.evidence ?? [], await this.#evidenceContext(run, round, await this.#facts(run.goal)), findings)
    if (result.state === 'matched') return { state: 'matched', evidence: result.evidence }
    return result.reason ? { state: result.state, reason: result.reason } : { state: result.state }
  }

  /** Whether this card's Agent binding declares `produces: review` — `complete_claim` alone cannot finish it then. */
  requiresReview(goal: string, card: number): boolean {
    const run = this.#runOfCard(goal, card)
    if (!run || run.document.format !== 'agents') return false
    const round = run.rounds.find((one) => one.cards.includes(card))
    const role = run.document.flow.roles.find((one) => one.id === round?.role)
    if (role?.kind !== 'agent') return false
    const index = round!.cards.indexOf(card)
    return bindingsFor(run, role.id)[index]?.agent.produces.includes('review') ?? false
  }

  /**
   * What a review call binds to: the caller's own kept Seat, holding this
   * exact card now, its Agent's declared answers, and the predecessor
   * subjects it may judge — each a fresh, clean (non-dirty) checkout's own
   * head, read now rather than trusted from when the Seat opened. Null when
   * the scope holds no live claim on this card at all.
   */
  async reviewBinding(
    goal: string, card: number, caller: { readonly runtime: string; readonly sessionId: string },
  ): Promise<{
    readonly seat: string
    readonly answers: readonly string[]
    readonly round: number
    readonly subjects: readonly FlowSubject[]
    readonly unsettled: readonly { readonly card: number; readonly why: string }[]
  } | null> {
    const run = this.#runOfCard(goal, card)
    if (!run) return null
    const round = run.rounds.find((one) => one.cards.includes(card))
    if (!round) return null
    const { seat } = this.#seatForCard(run, card)
    if (!seat || seat.closed || seat.session.runtime !== caller.runtime || seat.session.sessionId !== caller.sessionId) return null
    const role = run.document.format === 'agents' ? run.document.flow.roles.find((one) => one.id === round.role) : undefined
    const index = round.cards.indexOf(card)
    const answers = role?.kind === 'agent' ? (bindingsFor(run, role.id)[index]?.agent.answers ?? []) : []
    const board = this.#team.stateFor(goal)
    const deps = board.intents.find((one) => one.id === card)?.dependsOn ?? []
    // The same walk a guard makes, started from what this card depends on:
    // a review judges its predecessors' revisions, never its own checkout.
    const closure = await this.#closure(run, deps)
    return { seat: String(seat.id), answers, round: round.n, subjects: closure.subjects, unsettled: closure.unsettled }
  }

  /**
   * The card a finding command is bound to: the caller's own Seat, the one
   * the run opened for this card, open, and whether the caller holds the card
   * now, judges (its Agent produces reviews) or writes (it may change files
   * and does not judge). Null for a card no run bound to this caller. Read
   * from the run's journal and the board, never from anything the caller said.
   */
  findingBinding(goal: string, card: number, caller: { readonly runtime: string; readonly sessionId: string }): {
    readonly run: string
    readonly round: number
    readonly role: string
    readonly seat: string
    readonly reviews: boolean
    readonly writer: boolean
    readonly held: boolean
  } | null {
    const run = this.#runOfCard(goal, card)
    if (!run || run.document.format !== 'agents') return null
    const round = run.rounds.find((one) => one.cards.includes(card))
    if (!round) return null
    const role = run.document.flow.roles.find((one) => one.id === round.role)
    if (role?.kind !== 'agent') return null
    const { seat } = this.#seatForCard(run, card)
    if (!seat || seat.closed || seat.restored || seat.session.runtime !== caller.runtime || seat.session.sessionId !== caller.sessionId) return null
    const binding = bindingsFor(run, role.id)[round.cards.indexOf(card)]
    const intent = this.#team.stateFor(goal).intents.find((one) => one.id === card)
    return {
      run: run.id,
      round: round.n,
      role: round.role,
      seat: String(seat.id),
      reviews: binding?.agent.produces.includes('review') ?? false,
      writer: this.#writer(run, card),
      held: intent?.state === 'claimed' && intent.claim?.runtime === caller.runtime && intent.claim.sessionId === caller.sessionId,
    }
  }

  /**
   * Runs one finding command inside its run's own queue, with the run's
   * finding journal: every entry it writes is persisted to the run's file
   * before `put` answers, by this class and nobody else, and read back from
   * the run as it is when the step runs — never a copy taken when it queued.
   */
  withFindingJournal<T>(id: string, step: (journal: FindingJournal) => Promise<T>): Promise<T> {
    return this.#queue.within(id, () => step({
      entry: (operation) => this.#get(id).findingOps?.[operation] ?? null,
      put: async (entry) => {
        const run = this.#get(id)
        await this.#put({ ...run, findingOps: { ...run.findingOps, [entry.operation]: entry } })
      },
    }))
  }

  /**
   * Runs one publication step inside its run's own queue, with the run's
   * publication journal: every entry it writes is persisted to the run's file
   * before `put` answers, read back from the run as it is when the step runs.
   */
  withPublicationJournal<T>(id: string, step: (journal: PublicationJournal) => Promise<T>): Promise<T> {
    return this.#queue.within(id, () => step({
      round: (round) => this.#get(id).publication?.rounds[String(round)] ?? null,
      entry: (key) => this.#get(id).publication?.ops[key] ?? null,
      entries: () => Object.values(this.#get(id).publication?.ops ?? {}),
      decide: async (round, entries) => {
        const run = this.#get(id)
        const now = run.publication ?? { rounds: {}, ops: {} }
        if (now.rounds[String(round.round)]) return
        const ops = { ...now.ops }
        for (const entry of entries) {
          if (ops[entry.key]) throw new Error('A publication of this round was already journaled under another decision.')
          ops[entry.key] = entry
        }
        await this.#put({ ...run, publication: { rounds: { ...now.rounds, [String(round.round)]: round }, ops } })
      },
      put: async (entry) => {
        const run = this.#get(id)
        const now = run.publication
        if (!now?.ops[entry.key]) throw new Error('Only a journaled publication is written again.')
        await this.#put({ ...run, publication: { ...now, ops: { ...now.ops, [entry.key]: entry } } })
      },
      backfill: async (round, entries) => {
        const run = this.#get(id)
        const now = run.publication
        const was = now?.rounds[String(round.round)]
        if (!now || !was) throw new Error('Only a round this run closed is posted later.')
        if (was.mode === 'batch' && was.backfilled) return
        if (was.mode !== 'local' || round.mode !== 'batch') throw new Error('Only a round kept on the desk is posted later.')
        const ops = { ...now.ops }
        for (const entry of entries) {
          if (ops[entry.key]) throw new Error('A publication of this round was already journaled under another decision.')
          ops[entry.key] = entry
        }
        await this.#put({ ...run, publication: { rounds: { ...now.rounds, [String(round.round)]: round }, ops } })
      },
    }))
  }

  /** Every run with a publication journaled, and its Goal. */
  publicationRuns(): readonly { readonly run: string; readonly goal: string }[] {
    return [...this.#runs.values()].filter((run) => Object.keys(run.publication?.rounds ?? {}).length > 0).map((run) => ({ run: run.id, goal: run.goal }))
  }

  /** A run's publication journal as it stands: a snapshot read that takes no queue. */
  publicationOf(id: string): StoredPublication | null {
    return this.#runs.get(id)?.publication ?? null
  }

  /** A publication by its key, in whichever run journaled it: a snapshot read. */
  publicationEntry(key: string): PublicationEntry | null {
    for (const run of this.#runs.values()) {
      const found = run.publication?.ops[key]
      if (found) return found
    }
    return null
  }

  /** Every run with finding commands journaled but not settled — what a restart has to finish or give up with a reason. */
  pendingFindings(): readonly { readonly run: string; readonly entries: readonly FindingJournalEntry[] }[] {
    return [...this.#runs.values()].flatMap((run) => {
      const entries = Object.values(run.findingOps ?? {}).filter((entry) => entry.state === 'prepared')
      return entries.length > 0 ? [{ run: run.id, entries }] : []
    })
  }

  standDown(goal: string, runtime: string, sessionId: string): string | null {
    for (const run of this.#runs.values()) {
      if (run.goal !== goal) continue
      const operation = run.operations.find((one) => {
        if (one.kind !== 'seat' || !one.seat) return false
        const seat = this.#port.seatOf(one.seat)
        return seat?.session.runtime === runtime && seat.session.sessionId === sessionId
      })
      if (!operation) continue
      if (run.state !== 'running') return run.reason ?? 'this flow run has ended'
      const card = this.#team.stateFor(goal).intents.find((one) => one.id === operation.card)
      if (done(card)) return 'the card this Seat was opened for is finished'
      return null
    }
    return null
  }

  messagingLocked(goal: string): string | null {
    const live = [...this.#runs.values()].find((run) => run.goal === goal && (run.state === 'running' || run.state === 'stalled'))
    if (!live || live.document.format !== 'agents' || live.document.flow.messaging === 'members') return null
    return 'This Goal’s flow runs board-only. Stop the run and start one whose policy allows messages to change this.'
  }

  // -------------------------------------------------------------- writing

  /** Persist first, then hold it in memory, then say so: a failed write changes nothing the desk believes. */
  async #put(run: StoredFlowExecution): Promise<StoredFlowExecution> {
    const next = { ...run, updatedAt: this.#now() }
    try {
      await this.#files.save(next)
    } catch (error) {
      throw new JournalWriteError(error)
    }
    this.#runs.set(next.id, next)
    this.#port.changed(next.goal, this.runs(next.goal))
    return next
  }

  #operation(run: StoredFlowExecution, key: string, patch: Omit<FlowOperation, 'key'>): StoredFlowExecution {
    const at = this.#now()
    const times = run.operationTimes[key] ?? { preparedAt: at, startedAt: null, finishedAt: null }
    const stamped = {
      ...times,
      ...(patch.state === 'started' && times.startedAt === null ? { startedAt: at } : {}),
      ...((patch.state === 'finished' || patch.state === 'uncertain') && times.finishedAt === null ? { finishedAt: at } : {}),
    }
    const operation: FlowOperation = { key, ...patch }
    const exists = run.operations.some((one) => one.key === key)
    return {
      ...run,
      operations: exists ? run.operations.map((one) => (one.key === key ? operation : one)) : [...run.operations, operation],
      operationTimes: { ...run.operationTimes, [key]: stamped },
    }
  }

  #round(run: StoredFlowExecution, round: FlowRoundState): StoredFlowExecution {
    const exists = run.rounds.some((one) => one.n === round.n)
    return { ...run, rounds: exists ? run.rounds.map((one) => (one.n === round.n ? round : one)) : [...run.rounds, round] }
  }

  #get(id: string): StoredFlowExecution {
    const run = this.#runs.get(id)
    if (!run) throw new Error(`There is no flow run ${id}.`)
    return run
  }

  /** Stops the run for a person, reason persisted before anyone is told. */
  async #stall(id: string, reason: string): Promise<void> {
    const run = this.#get(id)
    if (run.state !== 'running') return
    await this.#put({ ...run, state: 'stalled', reason })
    this.#port.log('a flow run stalled', { run: id, reason })
    this.#team.nudgeRoom(run.goal)
  }

  /**
   * Releases Seats. `interrupt` — a trigger's run — interrupts each one's
   * live turn first, keeping what it said: a Seat the run lets go never
   * keeps working unmetered after the run stopped (review #898).
   */
  async #release(goal: string, ids: readonly string[], interrupt = false): Promise<void> {
    for (const id of ids) {
      if (interrupt) {
        const record = this.#port.seatOf(id)
        if (record) {
          await this.#port.interrupt?.(record).catch((error: unknown) => {
            this.#port.log('a flow Seat’s turn could not be interrupted', { goal, seat: id, error: error instanceof Error ? error.message : String(error) })
          })
          // An interrupt asks; the turn ends a moment later. The release waits for it, bounded, rather than being refused.
          for (let waited = 0; waited < RELEASE_WAIT_MS && this.#port.busy?.(record); waited += 50) {
            await new Promise((resolve) => setTimeout(resolve, 50))
          }
        }
      }
      try {
        await this.#port.release(goal, id)
      } catch (error) {
        this.#port.log('a flow Seat could not be released', { goal, seat: id, error: error instanceof Error ? error.message : String(error) })
      }
    }
  }

  // ---------------------------------------------------------------- start

  async startGoal(request: FlowStartRequest): Promise<FlowExecution> {
    const refused = this.refusal()
    if (refused) throw new Error(refused)
    if (request.compiled.document.format !== 'agents') throw new Error('Only a flow in the Agent format starts a new Goal. Update this flow first.')
    const errors = request.compiled.problems.filter((one) => one.level === 'error')
    if (errors.length) throw new Error(`This flow will not run yet:\n${errors.map((one) => `• ${one.at}: ${one.text}`).join('\n')}`)
    const policy = request.compiled.document.flow
    const vars: Record<string, string> = {}
    for (const input of policy.inputs) vars[input.id] = request.vars?.[input.id] ?? input.default ?? ''
    if ((request.requireHeld === true) !== (request.authorization.start === 'front-door')) {
      throw new Error('This start’s held-seat policy does not match where it came from. Review the dry run again before starting.')
    }
    if (request.goal && !request.requireHeld) throw new Error('Only a front-door start reuses an existing Goal.')
    if (request.target && !request.requireHeld) throw new Error('Only a front-door start names what it works on.')
    // A Goal made by a person was never pinned to a commit, so a review of one starts a Goal of its own.
    if (request.goal && request.target?.head) throw new Error(REVIEW_OWN_GOAL)
    if (request.goal && !this.#port.reserveGoal) throw new Error('This desk cannot reuse a Goal for a run.')
    const id = `flow-${this.#now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
    const at = this.#now()
    // The start is journaled before the Goal exists — or before an empty one is reserved — so a restart finds the Goal by this run rather than making or reserving another.
    let run = await this.#put(this.#operation({
      version: 2, id, goal: '', document: request.compiled.document, state: 'running', rounds: [], operations: [],
      legacyRun: null, reason: null, compiled: request.compiled, source: request.source, sourcePath: request.sourcePath,
      vars, startedAt: at, updatedAt: at, authorization: request.authorization, operationTimes: {},
      // Written before the first dispatch, and frozen for the life of the run.
      findings: startingFindings(policy),
      // Frozen with it: every Seat this run ever opens holds its ceiling, later and recovered rounds too.
      ...(request.requireHeld ? { requireHeld: true as const } : {}),
      ...(request.goal ? { reserving: { goal: request.goal.id, revision: request.goal.revision } } : {}),
      ...(request.target ? { target: request.target } : {}),
    }, 'start', { kind: 'round', state: 'started', card: null, seat: null }))
    let goal: { readonly id: string }
    if (request.goal) {
      try {
        await this.#port.reserveGoal!({ goal: request.goal.id, revision: request.goal.revision, run: id, operation: 'start', root: request.root })
      } catch (error) {
        // Nothing outside the desk happened: no Goal, no Seat, no lane. The refusal stands as the run's reason.
        const reason = error instanceof Error ? error.message : String(error)
        await this.#put(this.#operation({ ...this.#get(id), state: 'stopped', reason }, 'start', { kind: 'round', state: 'finished', card: null, seat: null }))
        // A reservation that landed before the refusal was said is this run's to let go: the run never starts.
        await this.#letGo(id, request.goal.id)
        throw error
      }
      goal = { id: request.goal.id }
    } else {
      goal = await this.#port.createGoal({
        root: request.root, ...(request.cwd ? { cwd: request.cwd } : {}), sentence: request.sentence.trim() || policy.name,
        origin: { kind: 'flow', run: id },
        // Every Seat of a review of a branch, a pull request or a diff works at the commit its preview resolved.
        ...(request.target?.head ? { at: request.target.head } : {}),
      })
    }
    run = await this.#put(this.#operation({ ...this.#get(id), goal: goal.id }, 'start', { kind: 'round', state: 'finished', card: null, seat: null }))
    await this.#queue.within(id, () => this.#afterStart(id))
    return projectExecution(this.#get(id))
  }

  /** Board policy, then the seed round. Shared by a fresh start and a restart that finds the start half done. */
  async #afterStart(id: string): Promise<void> {
    const run = this.#get(id)
    const policy = policyOf(run)
    // Visible and fixed for the life of the run: board-only unless the policy said members.
    this.#team.setMessaging(run.goal, policy.messaging === 'members')
    await this.#open(id, policy.seed, { key: 'seed', evidence: [] }, [])
  }

  /**
   * Opens a round the run itself decided on — its seed, or what a finished
   * round's rule named — and when that cannot happen, stalls the run with
   * the refusal as its reason. Never a run that reads "running" while
   * nothing is: the person sees why it stopped and what to do.
   */
  async #open(id: string, then: FlowThen, cause: { readonly key: string; readonly evidence: readonly string[] }, dependsOn: readonly number[]): Promise<void> {
    try {
      await this.#openRound(id, then, cause, dependsOn)
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      this.#port.log('a flow run could not open a round', { run: id, round: then.role, error: reason })
      // The run's own journal would not take a write: nothing outside the
      // desk happened for this step, so the next notice retries it — a stall
      // would be one more write to the same journal.
      if (error instanceof JournalWriteError) return
      try {
        await this.#stall(id, reason)
      } catch (stalling) {
        this.#port.log('a flow run could not record why it stopped', { run: id, error: stalling instanceof Error ? stalling.message : String(stalling) })
      }
    }
  }

  // ------------------------------------------------------- trigger starts

  /**
   * A trigger's run, under the id its firing reserved, on the trigger's own
   * Goal: made once, found again by every retry of the same firing. It
   * attaches only to the Goal whose persisted origin names this trigger and
   * firing and that holds no other run, re-reads the frozen closure the arm
   * consented to and compiles from it — phase 6's own compilation, checks,
   * round journal and seating; never a person's start token — and opens its
   * seed round's cards with dispatch **held**: no Seat opens, no card is
   * handed over and no check runs until `resumeTriggered`. A closure that no
   * longer matches the arm makes the run stopped, with the reason, and
   * dispatches nothing.
   */
  async startTriggered(request: TriggerStartRequest): Promise<FlowExecution> {
    const refused = this.refusal(request.goal)
    if (refused) throw new Error(refused)
    const triggered = this.#triggered
    if (!triggered) throw new Error('Trigger runs are not available on this desk.')
    if (!TRIGGER_RUN_ID.test(request.id)) throw new TriggerRefusal('A trigger’s run id is not one the desk reserves.')
    return this.#queue.within(request.id, async () => {
      const existing = this.#runs.get(request.id)
      if (existing) {
        if (existing.goal !== request.goal || existing.intake?.key !== request.key) {
          throw new TriggerRefusal('Another run already holds this trigger’s reserved id. Nothing was adopted.')
        }
        if (existing.state === 'running' && existing.rounds.length === 0) await this.#afterStart(request.id)
        return projectExecution(this.#get(request.id))
      }
      const origin = triggered.originOf(request.goal)
      if (origin?.kind !== 'trigger' || origin.trigger !== request.definition.id || origin.event !== request.key) {
        throw new TriggerRefusal('This Goal was not opened by this trigger firing, so its run is not attached to it.')
      }
      if ([...this.#runs.values()].some((one) => one.goal === request.goal)) {
        throw new TriggerRefusal('This Goal already has a run. A trigger’s run attaches only to its own new Goal.')
      }
      const closure = await triggered.freeze(request.root, request.definition)
      const compiled = closure.preview.compiled
      if (compiled.document.format !== 'agents') throw new TriggerRefusal('Only a flow in the Agent format runs from a trigger.')
      const policy = compiled.document.flow
      // Whether a seat can be taken right now is read again when the run seats, never taken for a changed closure.
      const errors = [...compiled.problems, ...closure.preview.problems].filter((one) => one.level === 'error' && !one.availability)
      const reason = closure.digest !== request.closureDigest || closure.problems.length > 0 || errors.length > 0 ? TRIGGER_CLOSURE_CHANGED : null
      const vars: Record<string, string> = {}
      // Only the flow's own defaults: no title, body or comment from outside becomes a variable.
      for (const input of policy.inputs) vars[input.id] = input.default ?? ''
      const at = this.#now()
      await this.#put(this.#operation({
        version: 2, id: request.id, goal: request.goal, document: compiled.document,
        state: reason ? 'stopped' : 'running', rounds: [], operations: [], legacyRun: null, reason,
        compiled, source: closure.source, sourcePath: null, vars, startedAt: at, updatedAt: at,
        authorization: {
          sourceDigest: sourceDigest(closure.source),
          commandDigest: sourceDigest(JSON.stringify(closure.preview.commands)),
          approvedAt: at,
        },
        operationTimes: {},
        // The narrower of the trigger's and the flow's loop limits, frozen for the life of the run.
        findings: { ...startingFindings(policy), budget: effectiveBudget(request.definition.budget, policy.budget) },
        intake: {
          key: request.key, trigger: request.definition.id, closureDigest: request.closureDigest,
          dispatchHeld: true, again: request.definition.again,
        },
      }, 'start', { kind: 'round', state: 'finished', card: null, seat: null }))
      if (!reason) await this.#afterStart(request.id)
      return projectExecution(this.#get(request.id))
    })
  }

  /**
   * A later firing's round on a trigger's run: its dispatch held first, then
   * the round opened under the firing's own cause, so a retry finds it rather
   * than opening another. A run that settled after its last round takes it
   * (the Goal is still open); one a person stopped, or that stopped for a
   * person, does not — the firing is recorded and the person decides.
   */
  againTriggered(id: string, key: string, evidence: readonly string[]): Promise<FlowRoundState> {
    return this.#queue.within(id, async () => {
      let run = this.#get(id)
      if (!run.intake) throw new TriggerRefusal('This run was not started by a trigger.')
      const cause = `cause:intake:${key}`
      const existing = run.rounds.find((one) => one.cause === cause)
      if (existing && existing.state !== 'opening') return existing
      const then = run.intake.again
      if (!then) throw new TriggerRefusal('This trigger opens no later round, so the new work was recorded for a person to decide.')
      if (run.state === 'stopped' || run.state === 'stalled') {
        throw new TriggerRefusal(`This Goal’s run is ${run.state === 'stopped' ? 'stopped' : 'waiting for a person'}, so the new work was recorded for a person to decide.`)
      }
      run = await this.#put({
        ...run, state: 'running', reason: run.state === 'settled' ? null : run.reason,
        intake: { ...run.intake, dispatchHeld: true },
      })
      return this.#openRound(id, then, { key: cause, evidence }, [])
    })
  }

  /**
   * Lets a trigger's run dispatch: its firing is durably recorded and every
   * gate allowed it. Idempotent; a run that is not running only has its hold
   * cleared. The run then advances exactly as it would have — a held round's
   * Seats opened, its cards handed over, its checks run.
   */
  resumeTriggered(id: string): Promise<void> {
    return this.#queue.within(id, async () => {
      let run = this.#get(id)
      if (!run.intake) throw new TriggerRefusal('This run was not started by a trigger.')
      // The Seats whose turn a pause or the cap ended: handed their cards again below, once each.
      const waiting = run.intake.rearm ?? []
      if (run.intake.dispatchHeld || (run.intake.heldFor ?? null) !== null || waiting.length > 0) {
        run = await this.#put({ ...run, intake: { ...run.intake, dispatchHeld: false, heldFor: null, rearm: [] } })
      }
      if (run.state !== 'running') return
      await this.#advance(id)
      for (const key of waiting) {
        const operation = this.#get(id).operations.find((one) => one.key === key)
        if (operation?.seat) await this.#reArm(id, operation, 'released')
      }
    })
  }

  /**
   * A later firing brought a new head (phase 8): work on the old one stops.
   * With a round to follow, dispatch is held — the old round's cards are
   * never handed out again, and the new round waits for its release; with
   * none, the run waits for a person with the reason. Idempotent, and it
   * never discards a card, an answer or a finding.
   */
  supersedeTriggered(id: string, why: string, next: 'round' | 'person'): Promise<void> {
    return this.#queue.within(id, async () => {
      const run = this.#get(id)
      if (!run.intake) throw new TriggerRefusal('This run was not started by a trigger.')
      if (next === 'round') {
        if (!run.intake.dispatchHeld) await this.#put({ ...run, intake: { ...run.intake, dispatchHeld: true } })
        return
      }
      if (run.state === 'running' && run.reason !== why) await this.#stall(id, why)
    })
  }

  /**
   * Whether a trigger's run may dispatch now: not held, and its gate allows
   * it. A refusal that lifts on its own (a pause, the cap) holds the run; any
   * other stalls it with the gate's reason.
   */
  /**
   * Stops every check running on a Goal now, outside the run's queue — which
   * a running check holds — so a pause or a stop reaches it at once. Each is
   * left uncertain for a person, never run again on its own (decision 18).
   */
  interruptChecks(goal: string): void {
    for (const controller of this.#checks.get(goal) ?? []) controller.abort()
  }

  async #mayDispatch(id: string): Promise<boolean> {
    const run = this.#get(id)
    if (!run.intake) return true
    if (run.intake.dispatchHeld) return false
    const verdict = await this.#gateOf(id)
    if (verdict.ok) return true
    if (verdict.transient) await this.#hold(id, verdict.reason)
    else await this.#stall(id, verdict.reason)
    return false
  }

  async #gateOf(id: string): Promise<{ readonly ok: true } | { readonly ok: false; readonly reason: string; readonly transient?: boolean }> {
    const run = this.#get(id)
    const gate = this.#triggered?.gate
    return gate ? gate(projectExecution(run)) : { ok: true }
  }

  /** Holds a trigger's run for a gate that lifts on its own: running, nothing recorded as a stop, released by `resumeTriggered`. */
  async #hold(id: string, why: string): Promise<void> {
    const run = this.#get(id)
    if (!run.intake || run.state !== 'running') return
    if (run.intake.dispatchHeld && run.intake.heldFor === why) return
    const first = (run.intake.heldFor ?? null) === null
    await this.#put({ ...run, intake: { ...run.intake, dispatchHeld: true, heldFor: why } })
    /* Whoever set the hold first — a turn ending, a Seat about to open, the
       budget watch — every other Seat of the run still inside a turn is
       interrupted with it, so nothing keeps working through a pause because
       the watch found the run already held (review #898). */
    if (first) {
      for (const seat of this.#openSeats(this.#get(id))) {
        await this.#port.interrupt?.(seat).catch((error: unknown) => {
          this.#port.log('a held flow Seat’s turn could not be interrupted', { run: id, seat: String(seat.id), error: error instanceof Error ? error.message : String(error) })
        })
      }
    }
  }

  /** The run's Seats that are still open, each once. */
  #openSeats(run: StoredFlowExecution): SeatRecord[] {
    return [...new Set(run.rounds.flatMap((round) => round.seats))]
      .map((seat) => this.#port.seatOf(seat))
      .filter((record): record is SeatRecord => record !== null && record.closed === null)
  }

  /**
   * A firing of this run was set aside for the person (phase 8): whatever
   * held its dispatch is let go, and a running run waits on them with why —
   * never left held on a firing that will not come.
   */
  setAsideTriggered(id: string, why: string): Promise<void> {
    return this.#queue.within(id, async () => {
      const run = this.#get(id)
      if (!run.intake) throw new TriggerRefusal('This run was not started by a trigger.')
      if (run.intake.dispatchHeld || (run.intake.heldFor ?? null) !== null) {
        await this.#put({ ...run, intake: { ...run.intake, dispatchHeld: false, heldFor: null, rearm: [] } })
      }
      if (this.#get(id).state === 'running') await this.#stall(id, why)
    })
  }

  /**
   * A pause or the daily cap reached a trigger's run from outside it (the
   * budget watch): it holds, with why, and no card is handed over or check
   * run until `resumeTriggered` lets it go. Not a stop: nothing is recorded
   * that a release would have to undo.
   */
  holdTriggered(id: string, why: string): Promise<void> {
    return this.#queue.within(id, () => this.#hold(id, why))
  }

  /**
   * A Seat's turn ended while its run was held by a pause or the cap: it is
   * handed its card again once the hold lifts, never while it stands.
   */
  async #noteHeld(id: string, operation: FlowOperation): Promise<void> {
    const run = this.#get(id)
    if (!run.intake?.heldFor || run.intake.rearm?.includes(operation.key)) return
    const card = this.#team.stateFor(run.goal).intents.find((one) => one.id === operation.card)
    if (!card || done(card)) return
    await this.#put({ ...run, intake: { ...run.intake, rearm: [...(run.intake.rearm ?? []), operation.key] } })
  }

  // --------------------------------------------------------------- rounds

  /** Phase 8's entry: a round opened for an outside cause, idempotent on its key. */
  openRound(id: string, then: FlowThen, cause: { readonly key: string; readonly evidence: readonly string[] }): Promise<FlowRoundState> {
    return this.#queue.within(id, () => this.#openRound(id, then, { key: `cause:${cause.key}`, evidence: cause.evidence }, []))
  }

  async #openRound(id: string, then: FlowThen, cause: { readonly key: string; readonly evidence: readonly string[] }, dependsOn: readonly number[]): Promise<FlowRoundState> {
    let run = this.#get(id)
    const existing = run.rounds.find((one) => one.cause === cause.key)
    if (existing && existing.state !== 'opening') return existing
    if (run.state !== 'running') throw new Error(run.reason ?? 'This flow run is not running.')
    const ready = this.#port.canDispatch(run.goal)
    if (!ready.ok) throw new Error(ready.reason)
    const blocked = this.refusal(run.goal)
    if (blocked) throw new Error(blocked)
    const policy = policyOf(run)
    const role = policy.roles.find((one) => one.id === then.role)
    if (!role) throw new Error(`There is no role called "${then.role}".`)
    let round: FlowRoundState = existing ?? {
      n: run.rounds.length + 1, role: role.id, cards: [], seats: [], evidence: cause.evidence, state: 'opening', cause: cause.key,
    }
    if (!existing) {
      run = await this.#put(this.#operation(this.#round(run, round), `round:${round.n}`, { kind: 'round', state: 'prepared', card: null, seat: null }))
    }
    // Cards, each under its dispatch key: a replay finds them rather than adding more.
    const bindings = role.kind === 'agent' ? bindingsFor(run, role.id) : []
    /*
     * A check with no explicit `cwd` fans out over its predecessor round's
     * own subjects — one card per revision, each checked in that subject's
     * own checkout — rather than running one aggregate command that would
     * silently pick just one of them. A check that names `cwd` stays one
     * aggregate card in the Goal's own checkout regardless of predecessor
     * width; so does a check with no predecessor subject at all (a seed
     * check, or one whose predecessor left no clean checkout).
     */
    let plan: CheckPlan | null = null
    if (role.kind === 'check') {
      const planned = run.checkPlans?.[String(round.n)] ?? await this.#planCheck(run, round.n, role.check, dependsOn)
      if (typeof planned === 'string') {
        await this.#stall(id, planned)
        return this.#get(id).rounds.find((one) => one.n === round.n)!
      }
      plan = planned
    }
    const width = role.kind === 'agent' ? bindings.length : plan ? plan.targets.length : 1
    /*
     * The facts this round was opened on, as values its card may name —
     * `{{evidence.review.at}}` on a merge card, say. Read from the exact fact
     * ids the round keeps, never re-chosen, so a replay renders what the
     * first attempt did; a field those facts do not settle to one value
     * refuses before any card exists.
     */
    let evidence: Readonly<Record<string, string>> = {}
    if (namesEvidence(then.title) || namesEvidence(then.detail)) {
      const ids = new Set(round.evidence)
      const facts = this.#facts ? await this.#facts(run.goal) : []
      evidence = evidenceValues(facts.filter((view) => ids.has(view.record.id) && view.freshness.state === 'fresh').map((view) => view.record))
    }
    const board = this.#team.stateFor(run.goal)
    const before = run.rounds.find((one) => one.n === round.n - 1)
    const cards: number[] = []
    const render = (template: string, vars: Readonly<Record<string, string>>): string | Error => {
      try {
        return renderCardTemplate(template, vars, evidence)
      } catch (error) {
        return error instanceof Error ? error : new Error(String(error))
      }
    }
    for (let index = 0; index < width; index += 1) {
      const vars = cardVars({
        flow: policy.name, run: id, room: board.name, repo: board.root, role: role.id, round: round.n, n: index + 1, count: width,
        ...(before ? { from: before.role, answered: before.cards.length } : {}), vars: run.vars,
      })
      const answers = role.kind === 'agent' ? bindings[index]!.agent.answers : role.kind === 'person' ? role.outcomes : []
      const title = render(then.title, vars as Record<string, string>)
      const said = then.detail ? render(then.detail, vars as Record<string, string>) : null
      const refused = [title, said].find((one): one is Error => one instanceof Error)
      if (refused) {
        await this.#stall(id, refused.message)
        return this.#get(id).rounds.find((one) => one.n === round.n)!
      }
      const detail = [
        said as string | null,
        answers.length > 0 && role.kind !== 'check' ? `Finish this with complete_claim and an outcome of exactly one of: ${answers.join(', ')}.` : null,
      ].filter((one): one is string => Boolean(one)).join('\n\n')
      const card = this.#team.addIntentForFlow(run.goal, {
        title: title as string,
        ...(detail ? { detail } : {}),
        ...(then.files?.length ? { files: then.files } : {}),
        ...(dependsOn.length ? { dependsOn } : {}),
        role: role.id,
        dispatch: `${id}:${round.n}:${index}`,
      }, run.intake ? { kind: 'trigger', trigger: run.intake.trigger } : { kind: 'user' })
      cards.push(card.id)
    }
    if (JSON.stringify(cards) !== JSON.stringify(round.cards) || (plan && !run.checkPlans?.[String(round.n)])) {
      round = { ...round, cards }
      const plans = plan ? { checkPlans: { ...run.checkPlans, [String(round.n)]: plan } } : {}
      run = await this.#put({ ...this.#round(run, round), ...plans })
    }
    // The board's own write of these cards lands before any Seat is asked to
    // claim one: the Goal a Seat claims through reads that write, not the
    // engine's memory, and a claim that raced it found no such card.
    await this.#team.flush()
    /* A trigger's run stops here while its dispatch is held, or its gate
       refuses: the round's cards exist, and nothing is seated, handed over or
       run until `resumeTriggered` lets it go and the gate allows it. */
    if (!await this.#mayDispatch(id)) return this.#get(id).rounds.find((one) => one.n === round.n)!
    /* A later review of a series gets its repair packet, read and pinned
       before any of its Seats opens: a delta that cannot be read in full
       stops the run here, with nothing seated. */
    if (role.kind === 'agent' && run.findings && this.#reviewPackets && !this.#get(id).reviewPackets?.[String(round.n)] &&
      bindings.some((binding) => binding.agent.produces.includes('review'))) {
      let packet: ReviewPacketPin | null
      try {
        packet = await this.#reviewPackets(id, round.n, round.role, (await this.#closure(this.#get(id), dependsOn)).subjects)
      } catch (error) {
        await this.#stall(id, error instanceof Error ? error.message : String(error))
        return this.#get(id).rounds.find((one) => one.n === round.n)!
      }
      if (packet) {
        const current = this.#get(id)
        run = await this.#put({ ...current, reviewPackets: { ...current.reviewPackets, [String(round.n)]: packet } })
      }
    }
    if (role.kind === 'agent') {
      const opened = await this.#seatRound(id, round, bindings, role.isolate, role.independentOf)
      if (!opened) return this.#get(id).rounds.find((one) => one.n === round.n)!
    }
    if (role.kind === 'check') {
      const opened = await this.#runCheckRound(id, round, role.check)
      if (!opened) return this.#get(id).rounds.find((one) => one.n === round.n)!
    }
    run = this.#get(id)
    round = { ...run.rounds.find((one) => one.n === round.n)!, state: 'running' }
    await this.#put(this.#operation(this.#round(run, round), `round:${round.n}`, { kind: 'round', state: 'finished', card: null, seat: null }))
    this.#team.nudgeRoom(run.goal)
    return round
  }

  /** Providers of every Seat that worked a round of these roles; null in the set means one was unknown. */
  async #writers(run: StoredFlowExecution, roles: readonly string[]): Promise<Set<string | null>> {
    const providers = new Set<string | null>()
    for (const round of run.rounds) {
      if (!roles.includes(round.role)) continue
      for (const id of round.seats) {
        const seat = this.#port.seatOf(id)
        providers.add(seat ? await this.#port.providerOf(seat.session.runtime, seat.checkout.cwd) : null)
      }
    }
    return providers
  }

  /**
   * Opens one Seat per slot, then — only once every one of them is durable —
   * sends each its card. False when the round could not be seated; the run
   * is stalled with the reason and only this round's new openings released.
   */
  async #seatRound(id: string, round: FlowRoundState, bindings: readonly FlowBinding[], isolate: boolean, independentOf: readonly string[]): Promise<boolean> {
    const openedNow: string[] = []
    const fail = async (reason: string): Promise<false> => {
      const run = this.#get(id)
      await this.#release(run.goal, openedNow, run.intake !== undefined)
      await this.#stall(id, reason)
      return false
    }
    /*
     * A trigger's gate is asked again before every Seat opens and every card
     * is handed over, not only when the round opens: a stop, a pause or the
     * cap landing while the round is still seating reaches the very next
     * step (review #898). A hold keeps what is open for its release; any
     * other refusal lets this round's new Seats go, interrupted.
     */
    const mayGo = async (): Promise<boolean | 'fail'> => {
      const current = this.#get(id)
      if (!current.intake) return true
      if (current.intake.dispatchHeld) return false
      const verdict = await this.#gateOf(id)
      if (verdict.ok) return true
      if (verdict.transient) {
        await this.#hold(id, verdict.reason)
        return false
      }
      await fail(verdict.reason)
      return 'fail'
    }
    const seats: SeatRecord[] = []
    for (const [index, binding] of bindings.entries()) {
      let run = this.#get(id)
      const card = round.cards[index]!
      const key = `seat:${round.n}:${index}`
      const prior = run.operations.find((one) => one.key === key)
      if (prior?.state === 'finished' && prior.seat) {
        const kept = this.#port.seatOf(prior.seat)
        if (!kept) return fail(`The Seat recorded for card #${card} can no longer be read. Its work is kept; start a new run.`)
        seats.push(kept)
        continue
      }
      if (prior?.state === 'started' || prior?.state === 'uncertain') {
        return fail(`A Seat for card #${card} may have opened while the desk was stopped. Check this Goal’s conversations, then start a new run.`)
      }
      // Independence is decided on providers the host knows, before and after opening.
      let candidates: readonly FlowSeat[] = binding.seats
      let writers: Set<string | null> | null = null
      if (independentOf.length > 0) {
        const known = await this.#writers(run, independentOf)
        writers = known
        const offered = binding.seats.length > 0 ? binding.seats : binding.agent.prefer
        const board = this.#team.stateFor(run.goal)
        const kept: FlowSeat[] = []
        if (!known.has(null)) {
          for (const seat of offered) {
            const provider = await this.#port.providerOf(seat.runtime, board.cwd ?? board.root)
            if (provider !== null && !known.has(provider)) kept.push(seat)
          }
        }
        candidates = kept
        if (candidates.length === 0) return fail(INDEPENDENT)
      }
      if (await this.#port.digestOf(run.goal, binding.agent.id) !== binding.digest) return fail(BRIEF_CHANGED)
      if (await mayGo() !== true) return false
      run = await this.#put(this.#operation(this.#get(id), key, { kind: 'seat', state: 'started', card, seat: null }))
      let record: SeatRecord
      try {
        record = await this.#port.openSeat({
          goal: run.goal, agent: binding.agent.id,
          ...(candidates.length ? { seats: candidates } : {}),
          grant: { kind: 'ceiling', level: binding.grant }, card, isolate,
          // The run's own frozen policy, read from its record every time — never the request that started it.
          ...(run.requireHeld === true ? { requireHeld: true as const } : {}),
        })
      } catch (error) {
        // The opening failed and said so: nothing is left open for this slot.
        await this.#put(this.#operation(this.#get(id), key, { kind: 'seat', state: 'finished', card, seat: null }))
        return fail(seatRefused(card, round.cards, error instanceof Error ? error.message : String(error)))
      }
      openedNow.push(String(record.id))
      await this.#put(this.#operation(this.#get(id), key, { kind: 'seat', state: 'finished', card, seat: String(record.id) }))
      if (record.briefDigest !== binding.digest) return fail(BRIEF_CHANGED)
      if (writers) {
        const actual = await this.#port.providerOf(record.session.runtime, record.checkout.cwd)
        if (actual === null || writers.has(actual)) return fail(INDEPENDENT)
      }
      if (isolate) {
        const lane = this.#port.laneOf(record)
        if (!lane || lane.cwd !== record.checkout.cwd || lane.ports.end < lane.ports.start || !lane.browserProfile) return fail(LANE_REFUSED)
      }
      /* A run that works on one commit hands work only to a Seat whose own
         checkout is at that commit, read fresh from git — never to one that
         opened on whatever the project had checked out. */
      const pinned = this.#get(id).target?.head ?? null
      if (pinned !== null && (await this.#port.headOf(record.checkout.cwd, null)).at !== pinned) return fail(NOT_AT_TARGET(card))
      try {
        this.#team.setRole(run.goal, record.session.runtime, record.session.sessionId, round.role)
      } catch (error) {
        this.#port.log('a flow Seat could not be given its role on the board', { run: id, error: error instanceof Error ? error.message : String(error) })
      }
      const current = this.#get(id)
      const kept = current.rounds.find((one) => one.n === round.n)!
      if (!kept.seats.includes(String(record.id))) await this.#put(this.#round(current, { ...kept, seats: [...kept.seats, String(record.id)] }))
      seats.push(record)
    }
    // Every Seat of the round is durable; only now does any of them get its card.
    for (const [index, seat] of seats.entries()) {
      const key = `turn:${round.n}:${index}`
      const prior = this.#get(id).operations.find((one) => one.key === key)
      if (prior?.state === 'finished') continue
      if (prior?.state === 'started' || prior?.state === 'uncertain') {
        return fail(`The order for card #${round.cards[index]} may not have reached its Seat while the desk was stopped. Check that conversation, then start a new run.`)
      }
      const cardId = round.cards[index] ?? null
      if (await mayGo() !== true) return false
      const handed = await this.#handOver(id, key, seat, cardId, bindings[index]!)
      if (handed !== null) return fail(`Card #${cardId} could not be handed to its Seat: ${handed}`)
    }
    return true
  }

  /**
   * Hands one Seat its card, journaled under `key`; null once that is settled.
   *
   * A Seat is handed its brief in a turn of its own, and a busy agent refuses
   * a second message until that turn ends. A Seat still inside a turn is not
   * refused work: its card is already claimed for it, and `await_work` hands
   * it over the moment it asks. So the order is left `prepared` — decided,
   * not sent — and the end of that turn sends it (`reArm`) if the card is
   * still open then. A card already finished, as a Seat that got on with it
   * inside its brief's turn finishes it, needs no order at all. Only a send
   * refused for any other reason is a refusal (the answer, its words).
   */
  async #handOver(id: string, key: string, seat: SeatRecord, cardId: number | null, binding: FlowBinding, lead?: string): Promise<string | null> {
    const cardNow = (): Intent | undefined => this.#team.stateFor(this.#get(id).goal).intents.find((one) => one.id === cardId)
    const turn = (state: FlowOperation['state']) => this.#put(this.#operation(this.#get(id), key, { kind: 'turn', state, card: cardId, seat: String(seat.id) }))
    if (done(cardNow())) {
      await turn('finished')
      return null
    }
    if (this.#port.busy?.(seat)) {
      await turn('prepared')
      return null
    }
    await turn('started')
    try {
      const order = this.#cardOrder(this.#get(id), cardNow(), binding)
      await this.#port.order(seat, lead ? `${lead}\n\n${order}` : order)
    } catch (error) {
      // A turn that began between the look and the send is the same Seat at work, not a refusal.
      if (this.#port.busy?.(seat) || done(cardNow())) {
        await turn(done(cardNow()) ? 'finished' : 'prepared')
        return null
      }
      await turn('finished')
      return error instanceof Error ? error.message : String(error)
    }
    await turn('finished')
    return null
  }

  #cardOrder(run: StoredFlowExecution, card: Intent | undefined, binding: FlowBinding): string {
    const answers = binding.agent.answers
    const round = card ? run.rounds.find((one) => one.cards.includes(card.id)) : undefined
    const packet = round ? run.reviewPackets?.[String(round.n)]?.text ?? null : null
    return [
      `Card #${card?.id ?? '?'} on this Goal is yours: ${card?.title ?? ''}`,
      card?.detail ?? null,
      'It is already claimed for you. Work only on this card.',
      answers.length > 0
        ? `When it is done, call complete_claim for #${card?.id} with an outcome of exactly one of: ${answers.join(', ')}.`
        : `When it is done, call complete_claim for #${card?.id}.`,
      packet,
      `Flow run ${run.id}.`,
    ].filter((one): one is string => Boolean(one)).join('\n\n')
  }

  // ---------------------------------------------------------------- checks

  /**
   * The bounded, host-derived context every check of a round shares —
   * `HARNESSDESK_FLOW_CONTEXT` — built once from every predecessor subject,
   * lane included, whether this round runs one aggregate card or fans out
   * over them: a fanned-out card's own subject is not the only one a script
   * might reasonably want to compare itself against.
   */
  #checkContext(run: StoredFlowExecution, round: number, subjects: readonly FlowSubject[]): string {
    const withPorts: FlowCheckContext['subjects'][number][] = []
    for (const subject of subjects) {
      const seat = this.#seatForCard(run, subject.card).seat
      const lane = seat ? this.#port.laneOf(seat) : null
      withPorts.push({
        card: subject.card, at: subject.at, cwd: subject.checkout.cwd, branch: subject.checkout.branch,
        portStart: lane?.ports.start ?? null, portEnd: lane?.ports.end ?? null,
      })
    }
    const context: FlowCheckContext = { version: 1, goal: run.goal, round, subjects: withPorts }
    return JSON.stringify(context)
  }

  /**
   * A check round's plan, read once as the round opens: the writers it
   * depends on, each at its head right now. With no explicit `cwd` it fans
   * out, one card per writer in that writer's own checkout; a writer with no
   * clean head stops the round (a string, the reason) rather than being
   * checked in something else's place or quietly left out. An explicit `cwd`
   * is one aggregate card, resolved inside the Goal's checkout; one outside
   * it is recorded as refused, so its card exists and says why. With no
   * writer at all it is one aggregate card in the Goal's checkout.
   */
  async #planCheck(run: StoredFlowExecution, round: number, check: FlowCheck, dependsOn: readonly number[]): Promise<CheckPlan | string> {
    const closure = await this.#closure(run, dependsOn)
    const context = this.#checkContext(run, round, closure.subjects)
    const board = this.#team.stateFor(run.goal)
    const base = board.cwd ?? board.root
    const at = async (cwd: string): Promise<string | null> => (await this.#port.headOf(cwd, null)).at
    if (check.cwd) {
      if (isAbsolute(check.cwd)) return { context, targets: [{ cwd: base, at: null }], refused: CHECK_CWD_OUTSIDE }
      let cwd: string
      try {
        cwd = await (await ConfinedTree.open(base)).resolveDir(insideRelative(check.cwd))
      } catch {
        return { context, targets: [{ cwd: base, at: null }], refused: CHECK_CWD_OUTSIDE }
      }
      return { context, targets: [{ cwd, at: await at(cwd) }], refused: null }
    }
    const [unsettled] = closure.unsettled
    if (unsettled) {
      return `Card #${unsettled.card}: ${unsettled.why}, so there is no revision of it to check. Start a new run once it has one.`
    }
    if (closure.subjects.length > 0) {
      return { context, targets: closure.subjects.map((one) => ({ cwd: one.checkout.cwd, at: one.at })), refused: null }
    }
    return { context, targets: [{ cwd: base, at: await at(base) }], refused: null }
  }

  /**
   * Runs a check round's cards exactly where its journaled plan put them.
   * Each is journaled before it spawns, so a crash mid-run leaves it
   * `uncertain` for a person rather than run a second time, and its evidence
   * append is awaited before the card is marked done — a storage failure
   * stalls the run instead.
   */
  async #runCheckRound(id: string, round: FlowRoundState, check: FlowCheck): Promise<boolean> {
    if (round.cards.length === 0) return true
    const plan = this.#get(id).checkPlans?.[String(round.n)]
    if (!plan || plan.targets.length !== round.cards.length) return this.#failCheck(id, CHECK_UNPLANNED)
    if (plan.refused) return this.#failCheck(id, plan.refused)
    for (const [index, card] of round.cards.entries()) {
      const ok = await this.#runOneCheck(id, round, check, card, index, plan.targets[index]!, plan.context)
      if (!ok) return false
    }
    return true
  }

  async #runOneCheck(
    id: string, round: FlowRoundState, check: FlowCheck, card: number, index: number,
    target: CheckPlan['targets'][number], flowContext: string,
  ): Promise<boolean> {
    const key = `check:${round.n}:${index}`
    let run = this.#get(id)
    const prior = run.operations.find((one) => one.key === key)
    if (prior?.state === 'finished') return true
    if (prior?.state === 'started' || prior?.state === 'uncertain') {
      await this.#stall(id, `This check was interrupted. Inspect its effects, then choose Run again.`)
      return false
    }
    if (target.at !== null) {
      const head = await this.#port.headOf(target.cwd, null)
      if (head.at !== target.at) {
        await this.#stall(id, `Card #${card}'s checkout has moved since this check was planned at ${target.at.slice(0, 12)}, so it was not run. Start a new run to check what is there now.`)
        return false
      }
    }
    // A trigger's gate is asked again before each check spawns: a stop, a pause or the cap reaches the next one.
    if (run.intake) {
      if (run.intake.dispatchHeld) return false
      const verdict = await this.#gateOf(id)
      if (!verdict.ok) {
        if (verdict.transient) await this.#hold(id, verdict.reason)
        else await this.#stall(id, verdict.reason)
        return false
      }
    }
    run = await this.#put(this.#operation(this.#get(id), key, { kind: 'check', state: 'started', card, seat: null }))
    const controller = new AbortController()
    const running = this.#checks.get(run.goal) ?? new Set<AbortController>()
    this.#checks.set(run.goal, running.add(controller))
    let outcome: Awaited<ReturnType<FlowExecutionPort['runCheck']>>
    try {
      outcome = await this.#port.runCheck(check.run, { cwd: target.cwd, timeoutSec: check.timeout, flowContext, signal: controller.signal }, { goal: run.goal, card, name: round.role, round: round.n })
    } finally {
      running.delete(controller)
      if (running.size === 0) this.#checks.delete(run.goal)
    }
    if (controller.signal.aborted) {
      /* Stopped part-way by a pause or a stop: whatever it did is its own, and
         is never run again on its own — a person looks, then chooses Run again. */
      await this.#put(this.#operation(this.#get(id), key, { kind: 'check', state: 'uncertain', card, seat: null }))
      await this.#stall(id, CHECK_INTERRUPTED)
      return false
    }
    if (outcome.problem) {
      await this.#put(this.#operation(this.#get(id), key, { kind: 'check', state: 'uncertain', card, seat: null }))
      await this.#stall(id, outcome.problem)
      return false
    }
    await this.#put(this.#operation(this.#get(id), key, { kind: 'check', state: 'finished', card, seat: null }))
    const said = check.exits[String(outcome.result.exit)] ?? check.otherwise
    this.#team.intentAction(run.goal, card, 'done', outcome.result.tail.slice(0, 400) || undefined, said)
    return true
  }

  async #failCheck(id: string, reason: string): Promise<false> {
    await this.#stall(id, reason)
    return false
  }

  /**
   * The person's own "Run again" for an uncertain check: the operation is
   * re-armed exactly as a fresh round-open would run it, only once — the
   * caller (`flow/check/retry`) has already redeemed a token bound to this
   * exact run and card, so nothing here re-chooses the command or checkout.
   */
  async retryCheck(id: string, card: number): Promise<FlowExecution> {
    return this.#queue.within(id, async () => {
      let run = this.#get(id)
      const round = run.rounds.find((one) => one.cards.includes(card))
      if (!round) throw new Error(`Card #${card} belongs to no round of this run.`)
      const role = policyOf(run).roles.find((one) => one.id === round.role)
      if (role?.kind !== 'check') throw new Error(`Card #${card} is not a check.`)
      const index = round.cards.indexOf(card)
      const key = `check:${round.n}:${index}`
      const operation = run.operations.find((one) => one.key === key)
      if (operation?.state !== 'uncertain') throw new Error('This check is not waiting to be run again.')
      if (run.intake?.dispatchHeld) throw new Error(DISPATCH_HELD)
      if (run.state !== 'running' && run.state !== 'stalled') throw new Error(run.reason ?? 'This flow run is not running.')
      /*
       * Re-armed, not resumed: this call is the person's one explicit consent
       * to run this exact card again, so only its own stale `uncertain`
       * record is cleared before `#runCheckRound` is asked to run the round
       * once more. Every other card of the round — already finished, or a
       * different one still `uncertain` — is untouched, and `#runOneCheck`'s
       * own "finished" guard skips it without a second spawn.
       */
      run = await this.#put({ ...run, state: 'running', reason: null, operations: run.operations.filter((one) => one.key !== key) })
      const opened = await this.#runCheckRound(id, round, role.check)
      if (opened) await this.#advance(id)
      return projectExecution(this.#get(id))
    })
  }

  // -------------------------------------------------------------- advance

  completed(goal: string, card: number): void {
    const run = this.#runOfCard(goal, card)
    if (!run) return
    void this.#queue.within(run.id, () => this.#advance(run.id)).catch((error: unknown) => {
      this.#port.log('a flow could not open its next round', { run: run.id, error: error instanceof Error ? error.message : String(error) })
    })
  }

  async wakeEvidence(goal: string): Promise<void> {
    for (const run of [...this.#runs.values()]) {
      if (run.goal !== goal || run.state !== 'running') continue
      await this.#queue.within(run.id, () => this.#advance(run.id)).catch((error: unknown) => {
        this.#port.log('a flow could not re-read its evidence', { run: run.id, error: error instanceof Error ? error.message : String(error) })
      })
    }
  }

  /** What the last closed-or-closing round decides, recomputed from the board every time it is asked. */
  async #decision(run: StoredFlowExecution, round: FlowRoundState): Promise<{ decision: RuleDecision; completed: number[] } | null> {
    const board = this.#team.stateFor(run.goal)
    const cards = round.cards.map((id) => board.intents.find((one) => one.id === id))
    if (round.cards.length === 0 || cards.some((card) => !done(card))) return null
    return {
      decision: await decide(policyOf(run), round.role, cards.map((card) => card?.outcome ?? null), (rule) => this.#guard(run, round, rule)),
      completed: cards.filter((card) => card?.state === 'done').map((card) => card!.id),
    }
  }

  async #advance(id: string): Promise<void> {
    let run = this.#get(id)
    if (run.state !== 'running') return
    if (run.goal === '') return
    // A trigger's run whose firing is not yet recorded opens nothing and sends nothing.
    if (run.intake?.dispatchHeld) return
    const last = run.rounds.at(-1)
    if (!last) {
      await this.#afterStart(id)
      return
    }
    if (last.state === 'opening') {
      // Half opened before a crash or a failed write: the same cause opens it the same way.
      const previous = run.rounds.find((one) => one.n === last.n - 1)
      if (last.cause.startsWith('cause:intake:') && run.intake?.again) {
        await this.#open(id, run.intake.again, { key: last.cause, evidence: last.evidence }, [])
        return
      }
      if (last.cause === 'seed' || !previous) {
        await this.#open(id, policyOf(run).seed, { key: last.cause, evidence: last.evidence }, [])
        return
      }
      const earlier = await this.#decision(run, previous)
      if (earlier?.decision.kind === 'fire') {
        await this.#open(id, earlier.decision.rule.then, { key: last.cause, evidence: last.evidence }, earlier.completed)
      }
      return
    }
    const found = await this.#decision(run, last)
    if (!found) return
    if (found.decision.kind === 'wait') {
      // Waiting is said, never silent: the run's status names what its rule waits for.
      const reason = `Rule ${found.decision.rule.id}: ${found.decision.reason ?? 'Waiting for its evidence.'}`
      if (last.state !== 'waiting-evidence' || run.reason !== reason) {
        await this.#put({ ...this.#round(run, { ...last, state: 'waiting-evidence' }), reason })
      }
      return
    }
    if (last.state !== 'closed') run = await this.#put({ ...this.#round(run, { ...last, state: 'closed' }), reason: null })
    if (run.findings) {
      /* The close is journaled, then processed outside this queue, and no
         round opens until its processing is recorded: a restart that finds
         it started processes it again, keyed by the round, never twice. */
      const key = `close:${last.n}`
      const closing = run.operations.find((one) => one.key === key)
      if (closing?.state !== 'finished') {
        if (!closing) run = await this.#put(this.#operation(run, key, { kind: 'round', state: 'started', card: null, seat: null }))
        if (this.#closeListeners.size === 0) {
          await this.#closeUnwatched(id, last.n)
          run = this.#get(id)
        } else {
          this.#emitClosed(id, last.n)
          return
        }
      }
      const stopped = run.findings?.stopped
      // A person's "Another round" authorizes exactly this one transition past the stop; consumed here, not re-granted.
      const authorized = run.findings?.extraRound?.after === last.n
      if (stopped && stopped.round === last.n && found.decision.kind === 'fire' && !authorized) {
        await this.#stall(id, stopped.reason)
        return
      }
    }
    if (found.decision.kind === 'none') {
      const answered = this.#team.stateFor(run.goal).intents.filter((card) => last.cards.includes(card.id)).map((card) => card.outcome ?? 'nothing').join(', ')
      const why = (found.decision.passed ?? []).map((one) => `${one.rule} did not apply: ${one.reason}`).join('; ')
      await this.#finish(id, 'settled', `${last.role} answered ${answered}, and no rule takes it further${why ? ` — ${why}` : ''}`)
      return
    }
    await this.#open(id, found.decision.rule.then, { key: `after:${last.n}:${found.decision.rule.id}`, evidence: found.decision.evidence }, found.completed)
  }

  async #finish(id: string, state: 'settled' | 'stopped', reason: string): Promise<void> {
    const run = this.#get(id)
    if (run.state === 'settled' || run.state === 'stopped') return
    await this.#put({ ...run, state, reason })
    // Ended before its first round: the empty Goal it reserved is empty still, and free for another start.
    if (run.reserving && run.rounds.length === 0) await this.#letGo(id, run.reserving.goal)
    // Kept Seats are released once. The Goal stays open for its person to wrap.
    const open = [...new Set(run.rounds.flatMap((round) => round.seats))]
      .filter((seat) => { const record = this.#port.seatOf(seat); return record !== null && record.closed === null })
    // A trigger's run interrupts every Seat it lets go: no turn it started outlives its stop.
    await this.#release(run.goal, open, run.intake !== undefined)
    this.#team.nudgeRoom(run.goal)
  }

  /** Best effort, and said when it fails: the reservation stays, visible on the Goal, for a person. */
  async #letGo(id: string, goal: string): Promise<void> {
    try {
      await this.#port.releaseGoal?.({ goal, run: id, operation: 'start' })
    } catch (error) {
      this.#port.log('a flow run could not let go of the Goal it reserved', { run: id, goal, error: error instanceof Error ? error.message : String(error) })
    }
  }

  // ----------------------------------------------------------------- stop

  stop(id: string, why = 'the person stopped this flow'): Promise<FlowExecution> {
    return this.#queue.within(id, async () => {
      await this.#finish(id, 'stopped', why)
      return projectExecution(this.#get(id))
    })
  }

  /** Stops every live run on a Goal, inside each run's own queue: the wrap barrier. */
  async stopGoal(goal: string, why: string): Promise<void> {
    for (const run of [...this.#runs.values()]) {
      if (run.goal === goal && (run.state === 'running' || run.state === 'stalled')) await this.stop(run.id, why)
    }
  }

  // ---------------------------------------------------------------- re-arm

  /** A v2 Seat whose turn ended with its card still open is handed the card again, within the run's budget. */
  async reArm(runtime: string, sessionId: string): Promise<boolean> {
    for (const run of [...this.#runs.values()]) {
      if (run.state !== 'running') continue
      const operation = run.operations.find((one) => {
        if (one.kind !== 'seat' || !one.seat) return false
        const seat = this.#port.seatOf(one.seat)
        return seat?.session.runtime === runtime && seat.session.sessionId === sessionId
      })
      if (!operation?.seat) continue
      await this.#queue.within(run.id, () => this.#reArm(run.id, operation))
      return true
    }
    return false
  }

  /**
   * `why` is what ended the Seat's last turn: the Seat itself (`turn-ended`,
   * budgeted), a pause or the cap a trigger's release lifted (`released`),
   * or the desk quitting under it (`relaunched`). Neither of the last two is
   * a Seat that stopped early, so neither counts against the budget.
   */
  async #reArm(id: string, operation: FlowOperation, why: 'turn-ended' | 'released' | 'relaunched' = 'turn-ended'): Promise<void> {
    const run = this.#get(id)
    if (run.state !== 'running') return
    if (run.intake && !await this.#mayDispatch(id)) {
      await this.#noteHeld(id, operation)
      return
    }
    const seat = this.#port.seatOf(operation.seat!)
    const card = this.#team.stateFor(run.goal).intents.find((one) => one.id === operation.card)
    if (!card || done(card)) return
    const again = why === 'relaunched' ? ' after the desk restarted' : ''
    /* Nothing but a relaunch's own resume will ever hand this card out again
       on its own, and a release after a hold hands it out exactly once
       (below): a Seat that is gone is a run that has stopped, said as such —
       never a run left reading as running over nobody (#939, generalizing
       #915's relaunch-only check to a hold's release too). A Seat still
       inside its one turn (`why === 'turn-ended'`) is not this case: there is
       simply nothing to hand it yet, until that turn ends. */
    if (!seat || seat.closed) {
      // A card a flow bound to one Seat is that Seat's alone (`#goalClaimable`,
      // host.ts): once its Seat is gone, nothing — not seating the Agent
      // again under a new Seat, not `goal/assign` reassigning the card to a
      // different session — can hand this run's own card back to it, and
      // `reArm` itself never looks at a run again once it has stalled. A new
      // run is the only way forward, not a resume this run has no path for.
      if (why !== 'turn-ended')
        await this.#stall(
          id,
          `The Seat for card #${card.id} is ${seat ? 'closed' : 'no longer recorded'}, so its card was not handed back${again}. This run cannot continue; start a new one to pick up the work.`,
        )
      return
    }
    // Inside a turn is where a working Seat lives: there is nothing to hand it until that turn ends.
    if (this.#port.busy?.(seat)) return
    const round = run.rounds.find((one) => one.cards.includes(card.id))!
    const index = round.cards.indexOf(card.id)
    const binding = bindingsFor(run, round.role)[index]
    if (!binding) {
      if (why === 'relaunched') await this.#stall(id, `Card #${card.id} no longer matches a Seat of its round, so it was not handed back after the desk restarted.`)
      return
    }
    /* A card going back after a quit or a hold reopens the conversation
       first, in `reseat`: the agent that held it may have gone with the desk
       (a hold can outlast a relaunch), and it comes back on its own default
       model unless it is put back — and in its own lane, or not at all. One
       that cannot be reopened is a run that has stopped, and it says so
       rather than reading as running. */
    if (why !== 'turn-ended') {
      if (!await this.#sameSeat(id, seat, card.id, round.role, why)) return
      /* Reopening the conversation above can take a while — spinning up a
         runtime that was not already up — and the gate at the top of this
         method read spend before that started. A limit reached while it was
         reopening must still hold or stall the run instead of handing the
         card back on spend that is no longer current (#939): read the gate
         again now, right before the card is actually handed back. */
      if (run.intake && !await this.#mayDispatch(id)) {
        await this.#noteHeld(id, operation)
        return
      }
    }
    /* The order its round decided on and left for the end of the Seat's
       brief turn: delivered now, as the round's own first order, not
       counted against the budget for a Seat whose turn ended early. */
    const firstKey = `turn:${round.n}:${index}`
    if (run.operations.find((one) => one.key === firstKey)?.state === 'prepared') {
      const refused = await this.#handOver(id, firstKey, seat, card.id, binding)
      if (refused !== null) await this.#stall(id, `Card #${card.id} could not be handed to its Seat${again}: ${refused}`)
      return
    }
    if (why !== 'turn-ended') {
      /* A turn a pause, the cap or a quit ended is not a Seat that stopped
         early: its card goes back once, outside the re-arm budget. */
      const prefix = `turn:${round.n}:${index}:${why === 'released' ? 'resume' : 'relaunch'}:`
      const key = `${prefix}${run.operations.filter((one) => one.key.startsWith(prefix)).length + 1}`
      const refused = await this.#handOver(id, key, seat, card.id, binding)
      if (refused !== null) await this.#stall(id, `Card #${card.id} could not be handed back to its Seat${again}: ${refused}`)
      /* Left `prepared` because the Seat turned busy while it was reopened: a
         turn is running, and its own end re-arms the card. This hand-back
         will never be sent, so it is not kept as one that might be. */
      const left = this.#get(id)
      if (left.operations.find((one) => one.key === key)?.state === 'prepared') {
        await this.#put({ ...left, operations: left.operations.filter((one) => one.key !== key) })
      }
      return
    }
    const budget = policyOf(run).rearm ?? 3
    const spent = (this.#rearms.get(String(seat.id)) ?? []).filter((at) => this.#now() - at < 60 * 60 * 1000)
    if (spent.length >= budget) {
      await this.#stall(id, `The Seat for card #${card.id} ended its turn ${spent.length} times inside the hour, so it is not being handed its card again.`)
      return
    }
    if (!await this.#sameSeat(id, seat, card.id, round.role, why)) return
    this.#rearms.set(String(seat.id), [...spent, this.#now()])
    const key = `turn:${round.n}:${index}:${spent.length + 1}`
    const refused = await this.#handOver(id, key, seat, card.id, binding)
    if (refused !== null) await this.#stall(id, `Card #${card.id} could not be handed to its Seat again: ${refused}`)
  }

  /**
   * The same environment and the same model before the same card, or not at
   * all: false once the run is stalled with why. `reseat` is also what
   * reopens a conversation a relaunch left closed, so a refusal to reopen it
   * for a card going back after a quit or a hold stalls the run too, rather
   * than leaving it running over nothing.
   */
  async #sameSeat(id: string, seat: SeatRecord, cardId: number, roleId: string, why: 'turn-ended' | 'released' | 'relaunched' | 'answered'): Promise<boolean> {
    const role = policyOf(this.#get(id)).roles.find((one) => one.id === roleId)
    if (role?.kind === 'agent' && role.isolate) {
      const lane = this.#port.laneOf(seat)
      if (!lane || lane.cwd !== seat.checkout.cwd || !lane.browserProfile) {
        await this.#stall(id, `The Seat for card #${cardId} no longer has its own checkout, ports and browser profile, so it was not re-armed.`)
        return false
      }
    }
    let running: string
    try {
      running = await this.#port.reseat(seat)
    } catch (error) {
      if (why === 'turn-ended') throw error
      await this.#stall(id, `Card #${cardId} could not be handed back to its Seat${why === 'relaunched' ? ' after the desk restarted' : ''}: ${error instanceof Error ? error.message : String(error)}`)
      return false
    }
    if (running !== seat.seatLabel) {
      await this.#stall(id, `The Seat for card #${cardId} came back on ${running}, not ${seat.seatLabel}, so it was not handed its card again.`)
      return false
    }
    return true
  }

  // --------------------------------------------------------------- restart

  /**
   * Reads every run back, validated whole. A broken file blocks its Goal; a
   * file that names no Goal blocks every start. Steps a crash left `started`
   * are reconciled from the board, or marked uncertain for a person.
   */
  async load(validate: (raw: unknown) => StoredFlowExecution): Promise<void> {
    for (const entry of await this.#files.list()) {
      let run: StoredFlowExecution
      try {
        if (entry.error) throw new Error(entry.error)
        run = validate(entry.raw)
      } catch (error) {
        const goal = typeof (entry.raw as { goal?: unknown } | null)?.goal === 'string' && (entry.raw as { goal: string }).goal
          ? (entry.raw as { goal: string }).goal : null
        if (goal) this.#blocked.set(goal, CORRUPT_RUN)
        else this.#corrupt = CORRUPT_RUN
        this.#port.log('a saved flow run could not be read', { file: entry.file, error: error instanceof Error ? error.message : String(error) })
        continue
      }
      if (run.legacyRun) continue
      this.#runs.set(run.id, run)
    }
    for (const run of [...this.#runs.values()]) {
      if (run.state !== 'running') continue
      await this.#queue.within(run.id, () => this.#reconcile(run.id)).catch((error: unknown) => {
        this.#port.log('a flow run could not be reconciled', { run: run.id, error: error instanceof Error ? error.message : String(error) })
      })
    }
  }

  async #reconcile(id: string): Promise<void> {
    let run = this.#get(id)
    // An interrupted start: find its Goal by origin before ever making another.
    if (run.goal === '') {
      const goals = this.#port.goalsOf(id)
      if (goals.length > 1) {
        await this.#put({ ...run, state: 'stalled', reason: 'More than one Goal claims this run. Keep one, then start a new run.' })
        return
      }
      if (goals.length === 0) {
        // Nothing outside the desk happened yet; the person starts it again rather than the desk guessing its folder.
        await this.#put(this.#operation({ ...run, state: 'stopped', reason: 'This run stopped before its Goal was made. Start it again.' },
          'start', { kind: 'round', state: 'finished', card: null, seat: null }))
        return
      }
      run = await this.#put(this.#operation({ ...run, goal: goals[0]! }, 'start', { kind: 'round', state: 'finished', card: null, seat: null }))
    }
    const board = run.goal ? this.#team.stateFor(run.goal) : null
    for (const operation of run.operations) {
      if (operation.state !== 'started') continue
      if (operation.kind === 'seat' && board && operation.card !== null) {
        // Deterministic: the card's claim, held by exactly one open Seat on this Goal, is the Seat that opened.
        const claim = board.intents.find((one) => one.id === operation.card)?.claim
        const holders = claim ? this.#port.seatsOn(run.goal).filter((seat) =>
          seat.closed === null && seat.session.runtime === claim.runtime && seat.session.sessionId === claim.sessionId) : []
        if (holders.length === 1) {
          run = await this.#put(this.#operation(run, operation.key, { kind: 'seat', state: 'finished', card: operation.card, seat: String(holders[0]!.id) }))
          const round = run.rounds.find((one) => one.cards.includes(operation.card!))!
          if (!round.seats.includes(String(holders[0]!.id))) run = await this.#put(this.#round(run, { ...round, seats: [...round.seats, String(holders[0]!.id)] }))
          continue
        }
      }
      if (operation.kind === 'round' && operation.key === 'start') continue
      // A round's close processing is idempotent on its round: resuming it again is safe, so it is never uncertain.
      if (operation.kind === 'round' && operation.key.startsWith('close:')) continue
      // Anything else that started and did not say how it ended needs a person.
      run = await this.#put(this.#operation(run, operation.key, { ...operation, state: 'uncertain' }))
    }
    const uncertain = run.operations.find((one) => one.state === 'uncertain')
    if (uncertain && run.state === 'running') {
      await this.#put({
        ...run, state: 'stalled',
        reason: uncertain.kind === 'turn'
          ? `The order for card #${uncertain.card} may not have reached its Seat while the desk was stopped. Check that conversation, then start a new run.`
          : `A step for card #${uncertain.card ?? '?'} was interrupted while the desk was stopped. Check this Goal’s conversations, then start a new run.`,
      })
    }
  }

  /** The latest seating of each card still open on this run's board: whose turn a quit may have ended. */
  #openCardSeatings(id: string): readonly FlowOperation[] {
    const run = this.#get(id)
    if (run.goal === '') return []
    const board = this.#team.stateFor(run.goal).intents
    const byCard = new Map<number, FlowOperation>()
    for (const operation of run.operations) {
      if (operation.kind !== 'seat' || operation.state !== 'finished' || operation.seat === null || operation.card === null) continue
      const card = board.find((one) => one.id === operation.card)
      if (!card || done(card)) continue
      byCard.set(operation.card, operation)
    }
    return [...byCard.values()]
  }

  /**
   * Once runtimes are up: finish half-opened rounds, advance rounds the board
   * already finished, and hand each Seat whose card is still open that card
   * again.
   *
   * The last is the quit's own turn-end. A Seat was inside its one turn when
   * the desk went — working, or waiting on a person to approve a command —
   * and that turn went with the agent's process: no turn-end event arrives
   * to re-arm it, and the approval it was waiting on is gone with it. Left
   * there, the run read "Running" over a conversation nobody had open (#915).
   * So it is reopened and handed its card again, in the conversation it
   * already had, the way the first flow engine's `resume` wakes a stopped
   * seat — and an agent that was asking can ask again. Outside the re-arm
   * budget: a quit is not a Seat that stopped early. A Seat that cannot be
   * reopened stalls the run with the reason.
   */
  async resume(which: 'all' | 'person' | 'triggered' = 'all'): Promise<void> {
    for (const run of [...this.#runs.values()]) {
      if (run.state !== 'running') continue
      // A trigger's run waits for its budget's fresh read and its firing's release; anyone else's does not wait on either.
      if (which !== 'all' && (which === 'triggered') !== Boolean(run.intake)) continue
      await this.#queue.within(run.id, async () => {
        /* Read before advancing: a card the advance itself hands out — a
           round it opens, an order a crash left unsent — is handed out by
           it, never a second time here. */
        const seated = this.#openCardSeatings(run.id)
        const turns = new Map(this.#get(run.id).operations.filter((one) => one.kind === 'turn').map((one) => [one.key, one.state]))
        await this.#advance(run.id)
        const handed = (card: number | null): boolean => this.#get(run.id).operations
          .some((one) => one.kind === 'turn' && one.card === card && turns.get(one.key) !== one.state)
        for (const operation of seated) if (!handed(operation.card)) await this.#reArm(run.id, operation, 'relaunched')
      }).catch((error: unknown) => {
        this.#port.log('a flow run could not resume', { run: run.id, error: error instanceof Error ? error.message : String(error) })
      })
    }
  }
}
