import type { Intent } from './team.js'

/**
 * Flows: the referee's policy, declared up front.
 *
 * A room is a shared board with a human referee — somebody decides who does
 * what, moves work between agents, reads results, and takes the irreversible
 * steps. A **flow** is that policy written down instead of performed: the
 * named roles, the seeding prompt each one is handed, and the rules that move
 * work between them. The person still chooses, per step, which steps stay
 * theirs.
 *
 * Three things shape every type below.
 *
 * - **The orchestrator is never an agent.** Every thinking step names a real
 *   runtime. What this engine contributes is routing, a state machine and
 *   policy; nothing here summarises, judges or decides on the merits. Where
 *   that is wanted it is a step in the flow, assigned to a runtime the author
 *   chose.
 * - **The round is the unit.** A round is N sibling cards of one role, opened
 *   together, and a rule fires on a *round* finishing. That is what makes
 *   "did all three approve?" expressible with two quantifiers instead of a
 *   general rule engine.
 * - **It loops.** Review sends work back to fix, which comes back to review.
 *   So this is a statechart — states, transitions, guards — and not a
 *   pipeline, whatever the famous drag-and-drop builders do.
 *
 * See docs/flows.md for the file format and docs/multi-agent.md for where
 * this sits beside the board it drives.
 */

// ------------------------------------------------------------------ the flow

/**
 * What a role may do to the checkout it works in.
 *
 * Per role rather than per room, because the whole point is that a reviewer
 * must never push and the fixer must. The standing order handed to a seat is
 * *generated* from this, so a seat cannot hold a permission its order does not
 * describe.
 */
export type FlowPermission = 'read' | 'publish' | 'merge'

/**
 * What kind of thing takes a step.
 *
 * `check` is the one that makes a flow trustworthy rather than merely
 * automated: a command whose exit status is the outcome the next rule
 * branches on. It seats nobody, costs nothing, and cannot be talked round. A
 * flow whose only gates are opinions is one this feature should make look
 * suspicious.
 */
export type FlowRoleKind = 'agent' | 'person' | 'check'

/** Which agent, model and effort a seat runs — the `cursor=gpt-5.3-codex/xhigh` grammar. */
export interface FlowSeat {
  readonly runtime: string
  readonly model?: string | null
  readonly effort?: string | null
  readonly thinking?: boolean
}

/** How a check's exit status becomes an outcome. */
export interface FlowCheck {
  /** The command, run through a shell in `cwd`. */
  readonly run: string
  /** Relative to the room's project unless absolute. */
  readonly cwd?: string | null
  /** Seconds. The step reports the fallback outcome when it runs over. */
  readonly timeout: number
  /** Exit status to outcome, for the statuses the author named. */
  readonly exits: Readonly<Record<string, string>>
  /** What every other status reports, the timeout included. */
  readonly otherwise: string
}

export interface FlowRole {
  /** The author's own word: `fixer`, `reviewer`, `judge`. */
  readonly id: string
  readonly kind: FlowRoleKind
  /** How many seats of this role — `reviewer` times 3 opens a round of three. */
  readonly count: number
  readonly permission: FlowPermission
  /** Which agent to seat. Required for `agent`, refused for the others. */
  readonly seat?: FlowSeat | null
  /** The command behind a `check`. Required for `check`, refused for the others. */
  readonly check?: FlowCheck | null
  /**
   * What this role may report. Declared, because a rule branching on an
   * unconstrained string is a rule that silently never fires — the engine
   * refuses an outcome the role never named.
   */
  readonly outcomes: readonly string[]
  /**
   * The seeding prompt: what this role is *for*, in the author's words. The
   * loop scaffolding and the git rules are generated around it, so this is
   * only the brief — the criteria a reviewer applies, the standard a fixer
   * works to.
   */
  readonly order?: string | null
  /**
   * Each seat works in a worktree of its own, made when the flow starts.
   *
   * `/race`'s isolation, declared: two competitors who must not see each
   * other's work need it, and a reviewer reading a branch does not.
   */
  readonly isolate?: boolean
}

/** A round's outcomes, quantified. Two quantifiers cover every loop this has needed. */
export interface FlowGuard {
  /** Every card in the round reported one of these. */
  readonly every?: readonly string[]
  /** At least one card reported one of these. */
  readonly any?: readonly string[]
}

/** What a rule opens: one round of one role, from a card template. */
export interface FlowThen {
  readonly role: string
  readonly title: string
  readonly detail?: string | null
  /** Path patterns each card of the round owns while claimed. */
  readonly files?: readonly string[]
}

/**
 * One transition. `on` a round of a role finishing, `when` its outcomes say
 * so, `then` open a round of another role depending on the one that ended —
 * so the finished round's context packages are handed over for free.
 *
 * Rules are tried in file order and the **first** match fires. A round that
 * matches nothing ends the run, which is how a loop exits.
 */
export interface FlowRule {
  /**
   * Stable, because a canvas has to address a node across an edit. Derived
   * from position when the file omits it — which is why a file a canvas
   * wrote always carries one.
   */
  readonly id: string
  readonly on: string
  readonly when?: FlowGuard | null
  readonly then: FlowThen
}

/** A value the person supplies when starting the flow, and what to call it. */
export interface FlowInput {
  readonly id: string
  readonly label: string
  readonly default?: string | null
}

export interface Flow {
  readonly name: string
  readonly description?: string | null
  readonly inputs: readonly FlowInput[]
  readonly roles: readonly FlowRole[]
  readonly rules: readonly FlowRule[]
  /** What starts the loop: one round of the seed's role. */
  readonly seed: FlowThen
  /**
   * Seconds one `await_work` call may block before it answers "nothing yet".
   * A seat loops on that answer inside its one turn.
   */
  readonly wait: number
  /**
   * Where a canvas keeps node positions. **The engine never reads this.** It
   * is reserved and preserved so a visual builder has somewhere to put layout
   * without inventing a second file or changing the format under everybody's
   * committed flows.
   */
  readonly layout?: unknown
}

// ------------------------------------------------------------------- the run

/** N sibling cards of one role, opened together. */
export interface FlowRound {
  /** 1-based within the run. */
  readonly n: number
  readonly role: string
  readonly intents: readonly number[]
  /** The rule that opened it; absent on the seed round. */
  readonly rule?: string | null
  readonly openedAt: number
}

/**
 * The durable record a change receipt is cut from: who did the work, on which
 * model, under which policy, with what outcome, and when. Rendering it is not
 * this feature's job; emitting it is, because a run is the natural unit a
 * receipt covers and reconstructing one afterwards is guesswork.
 */
export interface FlowEvent {
  readonly at: number
  readonly kind: 'started' | 'seated' | 'round' | 'outcome' | 'check' | 'settled' | 'stopped'
  readonly role?: string | null
  readonly intent?: number | null
  readonly outcome?: string | null
  /** The seat, as the desk describes it. */
  readonly seat?: string | null
  readonly by?: string | null
  readonly text?: string | null
}

export type FlowRunState = 'running' | 'settled' | 'stopped'

/** One seat a run opened, and the role it holds. */
export interface FlowSeatRecord {
  /** The member key: runtime and session id, NUL-joined, as the board keys them. */
  readonly key: string
  readonly role: string
  readonly runtime: string
  readonly sessionId: string
  /** How the desk describes what it is running. */
  readonly seat: string
  readonly permission: FlowPermission
  /** The checkout it was pointed at — a worktree of its own when the role isolates. */
  readonly cwd: string
}

export interface FlowRun {
  readonly id: string
  /**
   * The flow **as it was when the run started**, frozen.
   *
   * Editing the file under a running flow changes the next run, never this
   * one: a run whose rules changed halfway has cards open under a policy that
   * no longer exists, and no honest answer for what they mean.
   */
  readonly flow: Flow
  /** Where the flow was read from, when it came from a file. */
  readonly source?: string | null
  readonly state: FlowRunState
  readonly vars: Readonly<Record<string, string>>
  readonly seats: readonly FlowSeatRecord[]
  readonly rounds: readonly FlowRound[]
  readonly record: readonly FlowEvent[]
  readonly startedAt: number
  readonly endedAt?: number | null
  /** Why it ended, in a sentence. */
  readonly ended?: string | null
}

// --------------------------------------------------------------- the dry run

/** One thing wrong with a flow, and where. */
export interface FlowProblem {
  /** `error` blocks a run; `warning` is worth saying and does not. */
  readonly level: 'error' | 'warning'
  /** `roles.reviewer.seat`, `rules[2].when` — where to look. */
  readonly at: string
  readonly text: string
}

/** A seat the flow would open, and what opening it costs. */
export interface FlowSeatPlan {
  readonly role: string
  readonly index: number
  readonly seat: string
  readonly runtime: string
  readonly permission: FlowPermission
  /** Requests spent to open this seat and hand it its order — one turn each. */
  readonly requests: number
}

/** One step of the simulated loop: a round, and what it was taken to answer. */
export interface FlowTrace {
  readonly n: number
  readonly role: string
  readonly count: number
  readonly title: string
  readonly outcomes: readonly string[]
  /** The rule that fired next, or null when the run settled here. */
  readonly rule?: string | null
  readonly next?: string | null
}

/**
 * What `dry run` prints. It spends nothing: no seat is opened, no request is
 * billed, and no card reaches a board.
 */
export interface FlowDryRun {
  readonly flow: Flow | null
  readonly problems: readonly FlowProblem[]
  readonly seats: readonly FlowSeatPlan[]
  /** Requests the flow would spend before its first card is claimed. */
  readonly requests: number
  /** Every command a `check` role would run, verbatim, before anything runs one. */
  readonly commands: readonly { readonly role: string; readonly run: string; readonly cwd: string }[]
  readonly trace: readonly FlowTrace[]
  /** Whether the simulated loop reached an end within its iteration budget. */
  readonly settled: boolean
}

/** A flow file on disk, as the picker lists them. */
export interface FlowFile {
  /** Repository-relative: `.harnessdesk/flows/fix-bug.yml`. */
  readonly path: string
  readonly name: string
  readonly description?: string | null
  /** Non-null when the file is there and does not parse. */
  readonly problem?: string | null
}

/** What a card answered, for surfaces that draw a finished round. */
export const outcomeOf = (intent: Intent): string | null => intent.outcome ?? null
