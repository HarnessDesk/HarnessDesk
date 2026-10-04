import type { AgentDefinition, AgentEntry, SeatPlan } from './agent.js'
import type { StartContext } from './authoring.js'
import type { CeilingLevel } from './evidence.js'
import type { FindingRunState } from './findings.js'
import type { Flow, FlowCheck, FlowInput, FlowProblem, FlowRun, FlowSeat, FlowThen } from './flow.js'

/** The second-generation, Agent-routed flow document. */
export interface FlowAgentRole {
  readonly id: string
  readonly kind: 'agent'
  readonly uses: readonly string[]
  readonly seats: readonly FlowSeat[]
  readonly count?: number
  readonly isolate: boolean
  readonly grant: CeilingLevel
  readonly independentOf: readonly string[]
  /**
   * Whether this role's siblings in one round are blind to each other's
   * packages and findings until it closes. Absent means true, and the file
   * says `blind: false` to let them see; publication waits for the round to
   * close either way. Only an Agent role says it.
   */
  readonly blind?: boolean
}

export type FlowPolicyRole = FlowAgentRole
  | { readonly id: string; readonly kind: 'check'; readonly check: FlowCheck }
  | { readonly id: string; readonly kind: 'person'; readonly outcomes: readonly string[] }

export type FlowEvidenceGuard =
  | { readonly check: string }
  | { readonly ci: 'green' }
  | { readonly review: string }
  | { readonly pr: 'open' | 'merged' }
  | { readonly diff: true }

export interface FlowPolicyRule {
  readonly id: string
  readonly on: string
  readonly when?: {
    readonly every?: readonly string[]
    readonly any?: readonly string[]
    readonly evidence?: readonly FlowEvidenceGuard[]
  }
  readonly then: FlowThen
}

/**
 * How long a run may go before it stops for a person: `rounds` closed rounds
 * in all, and `withoutProgress` closed rounds in a row that brought no new
 * evidence. YAML spells the second `without-progress`.
 */
export interface FlowBudget {
  readonly rounds: number
  readonly withoutProgress: number
}

/** What a new-format run gets when its file names no budget. */
export const DEFAULT_FLOW_BUDGET: FlowBudget = { rounds: 3, withoutProgress: 2 }

/** Fetch a configured remote at start; absent branch means its advertised default (HEAD). */
export interface FlowBase {
  readonly remote: string
  readonly branch?: string
}

/** Frozen before any Seat opens, and reused by every later or recovered round. */
export interface FlowBasePin extends FlowBase {
  readonly at: string
}

export interface FlowPolicy {
  readonly version: 2
  readonly name: string
  readonly description?: string
  readonly base?: FlowBase
  readonly inputs: readonly FlowInput[]
  readonly roles: readonly FlowPolicyRole[]
  readonly rules: readonly FlowPolicyRule[]
  readonly seed: FlowThen
  readonly messaging: 'board-only' | 'members'
  readonly wait: number
  readonly rearm?: number
  /** Absent in a file that names none: a run started from it freezes `DEFAULT_FLOW_BUDGET`. */
  readonly budget?: FlowBudget
  readonly layout?: unknown
}

/** A person role is a review step only when its outgoing rule reads a review fact. */
export const isPersonReviewStep = (policy: FlowPolicy, roleId: string): boolean => {
  if (policy.roles.find((role) => role.id === roleId)?.kind !== 'person') return false
  return policy.rules?.some((rule) =>
    rule.on === roleId && rule.when?.evidence?.some((guard) => 'review' in guard) === true,
  ) ?? false
}

export type FlowDocument =
  | { readonly format: 'legacy'; readonly flow: Flow }
  | { readonly format: 'agents'; readonly flow: FlowPolicy }

export interface FlowBinding {
  readonly role: string
  readonly index: number
  readonly agent: AgentDefinition
  readonly origin: AgentEntry['origin']
  readonly digest: string
  readonly seats: readonly FlowSeat[]
  readonly grant: CeilingLevel
}

export interface CompiledFlow {
  readonly document: FlowDocument
  readonly bindings: readonly FlowBinding[]
  readonly problems: readonly FlowProblem[]
}

/**
 * One round of a run on a Goal: the cards it opened, the Seats that hold
 * them, and the evidence it was opened on. `cause` is the idempotency key the
 * round was opened under, so a repeated notice can never open it twice.
 */
export interface FlowRoundState {
  readonly n: number
  readonly role: string
  readonly cards: readonly number[]
  readonly seats: readonly string[]
  readonly evidence: readonly string[]
  readonly state: 'opening' | 'running' | 'waiting-evidence' | 'closed'
  readonly cause: string
}

/**
 * One piece of external work a run did or tried to do, journaled before it
 * started. `uncertain` means the desk stopped between starting it and
 * learning how it ended, and a person has to look before it is tried again.
 */
export interface FlowOperation {
  readonly key: string
  readonly kind: 'seat' | 'turn' | 'check' | 'round'
  readonly state: 'prepared' | 'started' | 'finished' | 'uncertain'
  readonly card: number | null
  readonly seat: string | null
}

/**
 * One result the desk recorded for a check card's command: what it exited with
 * and printed, the commit it ran at, and the word the Flow reads it as.
 *
 * A check run again adds one and rewrites none, because each is a durable
 * evidence record of its own; `FlowOperation` is a single record a retry
 * overwrites, and `evidence/board` folds a card to its latest fact, so
 * `flow/check/attempts` is the read that returns the earlier ones. An attempt
 * exists once its result is recorded: one still running, or interrupted before
 * the desk could keep what it printed, is the card's operation, not yet an
 * attempt.
 */
export interface FlowCheckAttempt {
  /** 1 for the first result recorded for this card, in the order recorded. */
  readonly n: number
  /** When the desk recorded it, in host milliseconds. */
  readonly at: number
  /** The commit it ran at. */
  readonly commit: string
  /** Its exit status; null when it did not exit by itself — it ran over its limit, was stopped, or never started. */
  readonly exit: number | null
  /** It ran over the check's limit and was stopped. */
  readonly timedOut: boolean
  /**
   * What the Flow's own mapping says this result is: its `exits` entry for the
   * exit status, else its `otherwise` (a timeout included). It is the word the
   * engine answers a completed check's card with; a result the desk stopped
   * part-way is mapped the same way, though the card took no answer from it.
   */
  readonly outcome: string
  /**
   * The last of what the command printed, at most 4,000 characters, exactly as
   * recorded. It is command output, which can hold anything a repository or a
   * tool printed: a surface shows it as text, through its sanitiser.
   */
  readonly tail: string
}

/**
 * A run a trigger started (phase 8): the firing that started it, the trigger,
 * the closure digest its arm consented to, and whether its dispatch is held.
 * `dispatchHeld` is set before every start or later round a firing opens and
 * cleared only once that firing is durably recorded and every gate allows
 * work: while it is set, no Seat is opened, no card is handed over and no
 * check runs. `again` is the round a later firing opens, frozen at the start.
 */
export interface FlowIntake {
  readonly key: string
  readonly trigger: string
  readonly closureDigest: string
  readonly dispatchHeld: boolean
  readonly again: FlowThen | null
  /**
   * Why a gate that lifts on its own — the machine paused, the daily cap
   * below what is committed — holds this run's dispatch; null or absent when
   * nothing like that does. Such a hold records no stop: the run stays
   * running, and its release continues it.
   */
  readonly heldFor?: string | null
  /** The Seats whose turn ended while that hold stood: each is handed its card again once it lifts. */
  readonly rearm?: readonly string[]
}

/** Structured cause of a Run's departure from running. */
export type FlowExecutionEnd =
  | { readonly kind: 'complete' }
  | { readonly kind: 'unrouted'; readonly card: number; readonly outcome: string }
  | { readonly kind: 'stopped'; readonly by: 'person' | 'desk' }
  | { readonly kind: 'budget'; readonly which: 'rounds' | 'without-progress'; readonly used: number }
  | { readonly kind: 'stalled' }

/**
 * A flow run as execution state attached to one Goal. Its membership is the
 * Goal's Seats; this holds no member list of its own.
 */
export interface FlowExecution {
  readonly version: 2
  readonly id: string
  readonly goal: string
  /** Absent on older runs: attended, except trigger-origin work. */
  readonly attended?: boolean
  readonly overrides?: Readonly<Record<string, readonly FlowSeat[]>>
  readonly base?: FlowBasePin
  readonly document: FlowDocument
  /** Canonical parsed document's short digest, frozen at start; absent on older records. */
  readonly revision?: string | null
  /** Earlier Run this start continues; a link only, never permission to resume it. */
  readonly continues?: string | null
  /** The declared brief input, frozen at start; null when the Flow declares none. */
  readonly brief?: string | null
  readonly startedAt?: number
  /** First departure from running, stamped once; null until then. Absent on older records. */
  readonly endedAt?: number | null
  /** Structured cause of the current departure; reason retains its existing sentence. */
  readonly end?: FlowExecutionEnd | null
  readonly state: 'running' | 'settled' | 'stopped' | 'stalled'
  readonly rounds: readonly FlowRoundState[]
  readonly operations: readonly FlowOperation[]
  readonly legacyRun: FlowRun | null
  readonly reason: string | null
  /**
   * A person's answer to a Seat's question that the Seat would not take,
   * even when asked twice. The question is already closed, so the answer is
   * kept here, on a stopped run, until `flow/answer/continue` hands it to
   * that Seat again. `canContinue` and `refusal` are read fresh on every
   * projection: `refusal` says why it cannot be sent now (the Seat is gone,
   * the card finished), and is null when it can.
   */
  readonly keptAnswer?: {
    readonly card: number
    readonly seat: string
    readonly question: string
    readonly answer: string
    readonly at: number
    readonly canContinue: boolean
    readonly refusal: string | null
  }
  /** The run's findings bookkeeping; absent on a run saved before it existed, which keeps its old behaviour. */
  readonly findings?: FindingRunState
  /** Set only on a run a trigger started. */
  readonly intake?: FlowIntake
  /**
   * Set on a run started from a front-door preview: every Seat it ever opens,
   * later and recovered rounds included, must hold its ceiling before it is
   * given work. Frozen at the start; a record that should carry it and does
   * not stops the run rather than seating under a weaker policy.
   */
  readonly requireHeld?: true
  /**
   * Set on a run started from a front-door preview of a branch, a pull
   * request, a diff or a working tree: what it works on, as the host
   * resolved it when the preview was taken and the token bound it.
   */
  readonly target?: FlowStartTarget
  /**
   * A plain-word sentence naming a card and the Seat still holding it, while
   * a release on this run is waiting on that Seat's turn to end — present
   * whenever one is, whatever `state` reads (`running`, `stalled`, `stopped`
   * or `settled`), and absent the moment nothing is pending any more. A
   * result field, computed fresh on every read from the in-memory pending
   * release itself and never stored: a restart drops it along with the
   * pending release it names, never leaving a stale sentence with no real
   * reason left to fall back to (#1027; review #1050 finding 3, round 3 —
   * `reason` itself is never touched by a pending release, so a surface
   * reading only `reason` still sees exactly what stopped or settled the
   * run).
   */
  readonly pendingReleaseNote?: string
}

/**
 * What a front-door run works on, resolved on the host and never taken from
 * a request. `head` is the commit every Seat of the run works at — each in
 * its own checkout of it — and null for a working tree, whose uncommitted
 * snapshot is only ever read in the project's own checkout.
 */
export interface FlowStartTarget {
  readonly kind: 'branch' | 'pull-request' | 'diff' | 'working-diff'
  readonly label: string
  readonly base: string | null
  readonly head: string | null
  readonly pr: number | null
  readonly dirty: boolean
}

// ---------------------------------------------------------------- review

/**
 * One observed predecessor a review may name: a host-minted id bound to the
 * claimed card and frozen subject snapshot, never an arbitrary Git revision.
 */
export interface ReviewCandidate {
  readonly id: string
  readonly card: number
  readonly at: string
  readonly branch: string | null
  readonly evidence: readonly string[]
  /** The Agent name that held this attempt, when the flow opened one. */
  readonly holder?: string
}

/** What `record_review` takes: a structured verdict against one observed candidate, never prose. */
export interface ReviewInput {
  readonly intent: number
  readonly candidate: string
  readonly verdict: string
  readonly against?: readonly string[]
}

// --------------------------------------------------------------- catalogue

export type FlowOrigin = 'project' | 'user' | 'builtin'

/** One flow the catalogue offers, from whichever layer's file wins. */
export interface FlowEntry {
  readonly id: string
  readonly origin: FlowOrigin
  readonly path: string
  readonly name: string
  readonly description: string | null
  readonly format: 'legacy' | 'agents' | null
  readonly problem: string | null
  readonly shadows: readonly { readonly origin: FlowOrigin; readonly path: string }[]
  /**
   * What this entry's own `layout.frontDoor` says, read once when the
   * catalogue is listed rather than by a second bulk call: `order` positions
   * it among the others, `contexts` names which starts it accepts. Absent or
   * `null` for a legacy-format, broken, or unlisted-layout flow — every
   * caller must read a missing value the same way it reads `null`. A present
   * `contexts` that omits a start means this shape refuses it; a `null` or
   * missing `contexts` means every start is accepted — absence is never a
   * refusal.
   */
  readonly frontDoor?: { readonly order: number | null; readonly contexts: readonly StartContext['kind'][] | null } | null
}

// ----------------------------------------------------------------- update

export interface FlowFileEdit {
  readonly path: string
  readonly before: string | null
  readonly after: string
}
export interface FlowUpdatePreview {
  readonly token: string
  readonly resuming: boolean
  readonly edits: readonly FlowFileEdit[]
  readonly problems: readonly FlowProblem[]
}
export interface FlowUpdateResult {
  readonly state: 'applied' | 'partial' | 'refused'
  readonly written: readonly string[]
  readonly message: string
}

// ---------------------------------------------------------------- preview

/** One role's slot in a dry run: the Agent it resolved to and how it would be seated. */
export interface FlowPreviewSeat {
  readonly role: string
  readonly index: number
  readonly agent: string | null
  readonly plan: SeatPlan
  readonly isolate: boolean
  /**
   * Whether a run opens this Seat in a worktree of its own, cut from the one
   * earlier step's commit it is handed, though its role does not say
   * `isolate` (#1053): `always` is every route into the role, `may` only some.
   */
  readonly atPredecessor?: 'always' | 'may'
  /** Whether this Seat is there to review, as the server decides it (`reviewsIn`): its round is a review series's round. */
  readonly reviews: boolean
}

/**
 * A non-executing statement of what a flow would do: every seat it would
 * open, every check command verbatim, every guard's requirements, and
 * everything wrong with it. Opens no session, allocates no lane, sends no
 * turn, runs no command and creates no Goal.
 */
export interface FlowPreview {
  /** Null when the flow has an error a start could not get past. */
  readonly token: string | null
  readonly attended?: boolean
  readonly overrides?: Readonly<Record<string, { readonly file: readonly FlowSeat[]; readonly run: readonly FlowSeat[] }>>
  readonly compiled: CompiledFlow
  readonly seats: readonly FlowPreviewSeat[]
  readonly commands: readonly {
    readonly role: string
    readonly run: string
    readonly cwd: string
    readonly timeout: number
  }[]
  readonly guards: readonly {
    readonly rule: string
    readonly unevidenced: boolean
    readonly requires: readonly FlowEvidenceGuard[]
  }[]
  readonly messaging: 'board-only' | 'members'
  readonly problems: readonly FlowProblem[]
}

/** Per-run choices; the flow's own document remains the file's. */
export interface FlowRunOptions {
  readonly seats?: Readonly<Record<string, readonly FlowSeat[]>>
  readonly attended?: boolean
}

/** What `flow/start-goal` takes: a frozen preview token, redeemed once. */
export interface FlowStartRequest extends FlowRunOptions {
  readonly root: string
  readonly source: string
  readonly token: string
  readonly sentence: string
  readonly vars?: Readonly<Record<string, string>>
  /** Earlier Run this start continues. This never resumes or changes the earlier Run. */
  readonly continues?: string | null
  /** The empty Goal a front-door start reuses, at the revision its preview saw; it must match the preview's own. */
  readonly goal?: { readonly id: string; readonly revision: number }
}

/** Bounded, host-derived context a check command reads from `HARNESSDESK_FLOW_CONTEXT`. */
export interface FlowCheckContext {
  readonly version: 1
  readonly goal: string
  readonly round: number
  readonly subjects: readonly {
    readonly card: number
    readonly at: string
    readonly cwd: string
    readonly branch: string | null
    readonly portStart: number | null
    readonly portEnd: number | null
  }[]
}
