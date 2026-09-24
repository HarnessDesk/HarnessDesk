import type { SessionPointer } from './evidence.js'
import type { FlowThen } from './flow.js'
import type { FlowPreview } from './flow-policy.js'

/**
 * Intake: what a project declares may open work on its own.
 *
 * A project's `.harnessdesk/triggers.yml` names a source — pull requests,
 * issues, or an interval — what each firing opens, how firings group into
 * Goals, what makes a firing new, how many Goals may be open at once, and
 * what bounds each one. It arrives with a clone, so it is a *declaration*:
 * nothing here runs until a person arms it on their own machine, and nothing
 * in it can name a command, an environment, a ceiling or a template that
 * outside text could fill.
 *
 * The vocabulary is closed on purpose. Three sources, a finite field list per
 * source, and one bounded budget; a new source or field is a protocol change,
 * never something a declaration reaches on its own.
 */

export type TriggerSource = 'pull-request' | 'issue' | 'schedule'

/** Every source, in the order the desk lists them. */
export const TRIGGER_SOURCES: readonly TriggerSource[] = ['pull-request', 'issue', 'schedule']

/**
 * The facts a firing's Goal grouping and dedupe keys may name. Each is a
 * host-validated scalar the source assigns: `event` is a stable fact
 * identity the desk derives, never a delivery time or a body field.
 */
export type TriggerField = 'pr' | 'head' | 'event' | 'issue' | 'slot'

export type PullRequestEvent = 'opened' | 'pushed'
export type IssueEvent = 'labelled' | 'closed' | 'commented'

/**
 * What one Goal a trigger opens may spend before it stops for a person.
 * `usd` is an observed stop threshold, never an invoice.
 */
export interface TriggerBudget {
  readonly usd: number
  readonly rounds: number
  readonly hours: number
  readonly withoutProgress: number
}

/** What a declaration that names no budget gets. */
export const DEFAULT_TRIGGER_BUDGET: TriggerBudget = { usd: 5, rounds: 3, hours: 4, withoutProgress: 2 }

export type TriggerOn =
  | { readonly kind: 'pull-request'; readonly events: readonly PullRequestEvent[] }
  | { readonly kind: 'issue'; readonly events: readonly IssueEvent[] }
  | { readonly kind: 'schedule'; readonly events: readonly ['tick']; readonly everyMinutes: number }

/** Per source: its events, the fields it may name, and what an omitted key defaults to. */
export const TRIGGER_DEFAULTS: {
  readonly 'pull-request': { readonly events: readonly PullRequestEvent[]; readonly fields: readonly TriggerField[]; readonly goal: readonly TriggerField[]; readonly dedupe: readonly TriggerField[] }
  readonly issue: { readonly events: readonly IssueEvent[]; readonly fields: readonly TriggerField[]; readonly goal: readonly TriggerField[]; readonly dedupe: readonly TriggerField[] }
  readonly schedule: { readonly events: readonly ['tick']; readonly fields: readonly TriggerField[]; readonly goal: readonly TriggerField[]; readonly dedupe: readonly TriggerField[] }
} = {
  'pull-request': { events: ['opened', 'pushed'], fields: ['pr', 'head', 'event'], goal: ['pr'], dedupe: ['pr', 'head', 'event'] },
  issue: { events: ['labelled', 'closed', 'commented'], fields: ['issue', 'event'], goal: ['issue'], dedupe: ['issue', 'event'] },
  schedule: { events: ['tick'], fields: ['slot'], goal: ['slot'], dedupe: ['slot'] },
}

/** One trigger as the host normalized it: every omitted setting filled, nothing inferred from event text. */
export interface TriggerDefinition {
  /** Project-scoped: what arming and history attach to. */
  readonly id: string
  readonly on: TriggerOn
  /** Exactly one: a flow by its catalogue id, or a single Agent run as a one-role flow. */
  readonly opens: { readonly flow: string } | { readonly agent: string }
  /** Which Goal a firing lands in: firings that agree on these fields share an open Goal. */
  readonly goal: readonly TriggerField[]
  /** The round a later firing opens in an open Goal; null records the fact and asks the person. */
  readonly again: FlowThen | null
  /** What makes a firing new: two facts that agree on these fields are one firing. */
  readonly dedupe: readonly TriggerField[]
  /** How many Goals this trigger may have open at once. */
  readonly concurrency: number
  /** Whether a pull request from another repository may open work. Only a pull-request trigger may say `allow`. */
  readonly forks: 'never' | 'allow'
  readonly budget: TriggerBudget
  /**
   * Which labels a labelled issue fires on, matched exactly; absent when the
   * trigger names none. Only an issue trigger whose events are exactly
   * `[labelled]` may name labels, at most five of them.
   */
  readonly label?: readonly string[]
}

/** At most this many labels on one trigger, each at most this many characters: the forge's own name limit. */
export const TRIGGER_LABEL_LIMIT = 5
export const TRIGGER_LABEL_CHARS = 50

/** One thing wrong with a triggers file, where, and what fixes it. */
export interface TriggerProblem {
  /** `[2].budget.usd`, `line 7`, or `file` for the file as a whole. */
  readonly at: string
  readonly text: string
  readonly fix: string
}

/**
 * A parsed file: every definition, or none at all. A file with any problem
 * runs nothing — a partial parse is never armed under one file's digest.
 */
export interface TriggerDocument {
  readonly definitions: readonly TriggerDefinition[]
  readonly problems: readonly TriggerProblem[]
}

// ------------------------------------------------------------------ arming

/** A trigger id as a project declares it: an ASCII slug of 1–64 characters. */
export const TRIGGER_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/

/**
 * One firing, as history shows it: which trigger, what it was about, when,
 * and what became of it. A public row, never raw event bytes: `subject` is
 * the pull request or issue number, or the slot's instant, and `head` a
 * pull request's commit id. `pending` is a firing whose effects are still
 * being applied; `recorded` one that joined an open Goal without a round.
 */
export interface TriggerFiring {
  readonly id: string
  readonly trigger: string
  readonly source: TriggerSource
  readonly subject: string
  readonly at: number
  readonly outcome: 'fired' | 'recorded' | 'skipped' | 'duplicate' | 'pending'
  readonly reason: string | null
  readonly goal: string | null
  readonly run: string | null
  readonly round: number | null
  readonly head: string | null
}

/** One page of a trigger's history, newest first; `next` is opaque. */
export interface TriggerHistoryPage {
  readonly items: readonly TriggerFiring[]
  readonly next: string | null
}

/** At most this many rows a history page carries. */
export const TRIGGER_HISTORY_PAGE = 50

/**
 * This machine's trigger controls: a person's, never a trigger's. `revision`
 * only grows; a write names the revision it read. Money is in USD: the cap is
 * what every trigger may reserve today (UTC), `chargedUsd` what settled
 * today — null when it cannot be vouched for — and `reservedUsd` what open
 * Goals still hold against it.
 */
export interface TriggerPreferences {
  readonly revision: number
  readonly paused: boolean
  readonly dailyUsd: number
  readonly day: string
  readonly chargedUsd: number | null
  readonly reservedUsd: number
}

/** The most a daily cap may be set to. */
export const TRIGGER_DAILY_USD_MAX = 10_000

export type TriggerAttentionKind =
  | 'message' | 'approval' | 'question' | 'person-step' | 'member' | 'budget' | 'source' | 'publication' | 'skipped'

/**
 * One named wait on unattended work: who it waits on, in a sentence, and
 * what opens it. One id per underlying request or reason, persisted before
 * it is announced, so a reconnect or a restart replays it and never makes
 * a second one. `notification` says whether the person was told outside the
 * app — never claimed when they were not.
 */
export interface TriggerAttention {
  readonly id: string
  readonly goal: string | null
  readonly trigger: string
  readonly kind: TriggerAttentionKind
  readonly waitingOn: { readonly kind: 'person' | 'member' | 'service'; readonly label: string }
  readonly sentence: string
  readonly action: 'open-goal' | 'open-trigger' | 'open-permissions' | 'open-usage'
  readonly createdAt: number
  readonly resolvedAt: number | null
  readonly notification: 'pending' | 'delivered' | 'unavailable'
}

/** A trigger Goal as its surfaces show it: where it came from, its budget, and every wait on it. */
export interface TriggerGoalStatus {
  readonly goal: string
  readonly trigger: string
  readonly source: TriggerSource
  /** Host-made: "from PR #12", "from issue #7", "from a schedule" — never a title from outside. */
  readonly label: string
  /** The bound forge's own address for the subject, or null. */
  readonly url: string | null
  readonly budget: TriggerBudgetState | null
  readonly waits: readonly TriggerAttention[]
}

/**
 * What arming a trigger would consent to: the committed declaration, the
 * whole flow it opens with every Seat, command, grant and messaging rule, and
 * everything wrong with it. `token` is one-use and short-lived, and is null
 * whenever anything would refuse. It carries no account, signature or key.
 */
export interface TriggerArmPreview {
  readonly id: string
  readonly token: string | null
  readonly expiresAt: number | null
  /** The file a person opens to change this: `.harnessdesk/triggers.yml`. */
  readonly sourcePath: string
  /** The working copy differs from what is committed; only what is committed is armed. */
  readonly workingCopyChanged: boolean
  readonly definition: TriggerDefinition | null
  readonly flow: FlowPreview | null
  readonly problems: readonly TriggerProblem[]
  /** Money is an observed stop threshold: a turn in flight may spend past it before it stops. */
  readonly moneyPolicy: 'observed-stop'
}

/** One declared trigger on this machine: whether it is armed, and if it cannot run, why and what fixes it. */
export interface TriggerView {
  readonly id: string
  readonly definition: TriggerDefinition | null
  readonly armed: boolean
  readonly state: 'off' | 'armed' | 'changed' | 'refused' | 'paused'
  readonly reason: string | null
  readonly fix: string | null
  readonly last: TriggerFiring | null
  readonly openGoals: number
}

/** A project's triggers file and every trigger it declares, as this machine stands on each. */
export interface TriggerProjectView {
  readonly project: string
  /** This machine's consent revision: it only grows. */
  readonly revision: number
  readonly path: string
  readonly exists: boolean
  readonly workingCopyChanged: boolean
  readonly triggers: readonly TriggerView[]
  readonly problems: readonly TriggerProblem[]
}

// -------------------------------------------------------------- monitoring

export type TriggerAction = 'opened' | 'pushed' | 'labelled' | 'closed' | 'commented' | 'tick'

/**
 * One fact a source observed, normalized. Everything in it is either
 * host-validated (the repository the arm was bound to, positive ids, full
 * commit ids, finite times, a URL confined to the repository) or bounded,
 * untrusted prose (`title`, `body`) that is information, never authority,
 * never evidence and never a command, variable, path or ceiling.
 */
export interface TriggerFact {
  readonly source: TriggerSource
  readonly project: string
  /** `owner/name` as bound at arm time; null for a schedule. */
  readonly repository: string | null
  /** The pull request or issue number, or the slot's epoch milliseconds, as a string. */
  readonly subject: string
  /** The fact's stable identity: a framed hash of its canonical tuple, never its delivery time. */
  readonly event: string
  readonly action: TriggerAction
  /** When the forge says it happened, or the slot's own instant. */
  readonly at: number
  /** The pull request's full head commit id; null for anything else. */
  readonly head: string | null
  /** The head is in another repository than the one bound. */
  readonly fork: boolean
  readonly title: string
  readonly body: string
  readonly url: string | null
  /** The one trigger a schedule slot belongs to; null for a forge fact, which every matching arm is offered. */
  readonly trigger: string | null
  /**
   * The label a labelled issue event added, as the forge named it and the
   * desk validated it; absent on every other fact, and on a labelled event
   * whose name could not be read — which then matches no label filter.
   */
  readonly label?: string
}

/** How one watched source stands, in sentences a surface can show. */
export interface TriggerSourceStatus {
  readonly project: string
  readonly source: TriggerSource
  readonly state: 'watching' | 'paused' | 'offline' | 'rate-limited' | 'signed-out' | 'unreadable' | 'gap'
  readonly reason: string | null
  readonly fix: string | null
  readonly lastPolledAt: number | null
  /** Facts the last poll saw and recorded as skipped: a stranger's head, a missed slot. */
  readonly skipped: number
}

// ------------------------------------------------------------------ budgets

/** Why unattended work on a trigger's Goal stopped: a completed turn is `answered`, never an approval. */
export type TriggerStopReason =
  | 'answered'
  | 'crashed'
  | 'timed out'
  | 'lease expired'
  | 'cancelled'
  | 'out of budget'
  | 'asked a question nobody can answer'
  | 'needs a person'

/** Where a money figure came from: the vendor's own metered cost, public list prices for exact tokens, or neither. */
export type IntakeSpendProvenance = 'vendorMetered' | 'listPrice' | 'unknown'

/** The daily cap on what every trigger on this machine may reserve, in USD, by UTC day. */
export const DEFAULT_TRIGGER_DAILY_USD = 20

/**
 * One Seat's spend as the desk attributed it: cumulative for its session,
 * never a runtime-wide total divided between Goals. `totalMicros` is null
 * whenever it cannot be vouched for — no cost reported, a partial total, a
 * price that is missing, delegated work it cannot separate, a total that
 * went down — and null is never read as zero.
 */
export interface IntakeSpend {
  readonly seat: string
  readonly session: SessionPointer
  readonly turn: string | null
  readonly observedAt: number
  readonly totalMicros: number | null
  readonly provenance: IntakeSpendProvenance
  readonly complete: boolean
}

/** A trigger Goal's budget as it stands: one per Goal generation, never reset by a later firing. */
export interface TriggerBudgetState {
  readonly goal: string
  readonly startedAt: number
  readonly deadline: number
  readonly budget: TriggerBudget
  readonly spentMicros: number | null
  readonly reservedMicros: number
  readonly provenance: 'vendorMetered' | 'listPrice' | 'mixed' | 'unknown'
  readonly closedRounds: readonly number[]
  readonly idleRounds: number
  readonly stop: { readonly reason: TriggerStopReason; readonly detail: string; readonly at: number } | null
}
