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
 * The vocabulary is closed on purpose. Four sources, a finite field list per
 * source, and one bounded budget; a new source or field is a protocol change,
 * never something a declaration reaches on its own.
 */

export type TriggerSource = 'pull-request' | 'issue' | 'schedule' | 'mention'

/** Every source, in the order the desk lists them. */
export const TRIGGER_SOURCES: readonly TriggerSource[] = ['pull-request', 'issue', 'schedule', 'mention']

/**
 * The facts a firing's Goal grouping and dedupe keys may name. Each is a
 * host-validated scalar the source assigns: `event` is a stable fact
 * identity the desk derives, never a delivery time or a body field.
 */
export type TriggerField = 'pr' | 'head' | 'event' | 'issue' | 'slot' | 'thread'

export type PullRequestEvent = 'opened' | 'pushed' | 'checks-failed' | 'review-commented' | 'mentioned'
export type IssueEvent = 'labelled' | 'closed' | 'commented' | 'mentioned'

/**
 * The word that makes a comment a request: `@harnessdesk`, the project's own
 * organization on GitHub, at the start of a comment's first line. An `@` of
 * an organization notifies nobody. See `summonsOf` in the server for the rule.
 */
export const SUMMONS_WORD = '@harnessdesk'

/**
 * Whose comments fire a trigger that reads `commented` issue events or
 * `mentioned` requests on issues and pull requests,
 * compared by the forge's stable account id, never a display name:
 * - `me` (the default): only the forge account the trigger is armed with.
 * - `collaborators`: that account, and anyone the forge says can write to
 *   the bound repository — one bounded read per comment; a read that fails
 *   skips the comment.
 * - `anyone`: anyone who can comment on the repository.
 * A comment the desk itself posted never fires, whichever this is.
 */
export type TriggerCommentFrom = 'me' | 'collaborators' | 'anyone'
export const TRIGGER_COMMENT_FROM: readonly TriggerCommentFrom[] = ['me', 'collaborators', 'anyone']

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
  | { readonly kind: 'mention'; readonly events: readonly ['commented'] }

/** The complete vocabulary; new events do not silently broaden an existing declaration. */
export const TRIGGER_EVENTS = {
  'pull-request': ['opened', 'pushed', 'checks-failed', 'review-commented', 'mentioned'],
  issue: ['labelled', 'closed', 'commented', 'mentioned'],
  schedule: ['tick'],
  mention: ['commented'],
} as const

/** Per source: its default events, the fields it may name, and what an omitted key defaults to. */
export const TRIGGER_DEFAULTS: {
  readonly 'pull-request': { readonly events: readonly PullRequestEvent[]; readonly fields: readonly TriggerField[]; readonly goal: readonly TriggerField[]; readonly dedupe: readonly TriggerField[] }
  readonly issue: { readonly events: readonly IssueEvent[]; readonly fields: readonly TriggerField[]; readonly goal: readonly TriggerField[]; readonly dedupe: readonly TriggerField[] }
  readonly schedule: { readonly events: readonly ['tick']; readonly fields: readonly TriggerField[]; readonly goal: readonly TriggerField[]; readonly dedupe: readonly TriggerField[] }
  readonly mention: { readonly events: readonly ['commented']; readonly fields: readonly TriggerField[]; readonly goal: readonly TriggerField[]; readonly dedupe: readonly TriggerField[] }
} = {
  'pull-request': { events: ['opened', 'pushed'], fields: ['pr', 'head', 'event'], goal: ['pr'], dedupe: ['pr', 'head', 'event'] },
  issue: { events: ['labelled', 'closed', 'commented'], fields: ['issue', 'event'], goal: ['issue'], dedupe: ['issue', 'event'] },
  schedule: { events: ['tick'], fields: ['slot'], goal: ['slot'], dedupe: ['slot'] },
  mention: { events: ['commented'], fields: ['thread', 'event'], goal: ['thread'], dedupe: ['thread', 'event'] },
}

/**
 * The title a later round is opened under: fixed, so no event text ever
 * becomes a card title. The one canonical spelling — the parser refuses
 * `again` with any other title, and authoring writes exactly this one.
 */
export const AGAIN_TITLE = 'Continue this work'

/** One trigger as the host normalized it: every omitted setting filled, nothing inferred from event text. */
export interface TriggerDefinition {
  /** Project-scoped: what arming and history attach to. */
  readonly id: string
  readonly on: TriggerOn
  /** Exactly one: a Flow, a single Agent, or a Lead plan that waits for approval. */
  readonly opens: { readonly flow: string } | { readonly agent: string } | { readonly lead: true }
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
  /**
   * Whose comments fire it: present exactly when the trigger reads
   * `commented` issue events, `mentioned` requests or mentions, `me` unless
   * the file says otherwise. A mention trigger never takes `anyone`.
   */
  readonly from?: TriggerCommentFrom
  /**
   * A mention trigger's handle: the name a comment addresses as `@handle`.
   * Absent means the desk's Lead name, read when a comment is judged.
   */
  readonly handle?: string
  /** A mention trigger's named people: forge logins also allowed to ask, besides `from`. At most ten. */
  readonly people?: readonly string[]
  /** A mention trigger's named bots: bot logins (without `[bot]`) also allowed to ask. At most ten. */
  readonly bots?: readonly string[]
}

/** At most this many named people, and as many named bots, on one mention trigger. */
export const TRIGGER_NAMED_LIMIT = 10

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
  /** `set-aside`: it fired, and its effects were then set aside for the person — never run on their own. */
  readonly outcome: 'fired' | 'recorded' | 'skipped' | 'duplicate' | 'pending' | 'set-aside'
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
  | 'message' | 'approval' | 'question' | 'person-step' | 'member' | 'budget' | 'source' | 'publication' | 'skipped' | 'triage'

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
  /** This target drafts only; the plan's later approval owns all worker authority. */
  readonly lead?: { readonly summary: string; readonly approvalRequired: true }
  readonly problems: readonly TriggerProblem[]
  /** Money is an observed stop threshold: a turn in flight may spend past it before it stops. */
  readonly moneyPolicy: 'observed-stop'
  /** The forge repository an arm binds, `owner/name`, when the trigger reads the forge and it was read. */
  readonly repository?: string | null
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
  /**
   * How the source it watches stands on this machine, once it has been read:
   * a gap is the one state a person resumes (`trigger/rebaseline`). Absent
   * until then, and for a trigger that is not armed.
   */
  readonly source?: TriggerSourceStatus | null
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

export type TriggerAction = PullRequestEvent | IssueEvent | 'tick'

/** Bounded aggregate, bound to the checked head; absent and pending never mean passed. */
export interface TriggerCheck {
  readonly head: string
  readonly state: 'absent' | 'pending' | 'passed' | 'failed'
  readonly total: number
}

export interface TriggerReview {
  readonly id: number
  readonly head: string
  readonly state: 'commented' | 'changes-requested' | 'approved'
}

/**
 * One fact a source observed, normalized. A `mentioned` fact is a comment
 * (or a review's body) on an issue or pull request whose first line starts
 * with {@link SUMMONS_WORD}: `event` is keyed on the comment id, `body` is
 * the words after the command word, `head` is the pull request's head (null
 * on an issue), and `author`, `authorWrites` and `desk` read as for
 * `commented`. A bot never makes one. Everything in it is either
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
  /**
   * Who wrote a comment or review: an opaque digest of the forge
   * and the author's numeric account id — the same digest an arm binds for
   * the signed-in account — or null when it could not be read.
   */
  readonly author?: string | null
  /**
   * Whether the forge says the comment's author can write to the bound
   * repository: asked for every review, and for issue triggers that let collaborators fire,
   * with the answer's account id checked against the author's; null when it
   * was not asked or could not be read.
   */
  readonly authorWrites?: boolean | null
  /** The comment opens with a marker the desk writes on what it posts itself (matched exactly): never a firing. */
  readonly desk?: boolean
  readonly check?: TriggerCheck
  readonly review?: TriggerReview
  /** A mention fact: whether the comment is on an issue or a pull request's conversation. */
  readonly thread?: 'issue' | 'pull-request'
  /** A mention fact: the author's forge login as the forge spelled it, validated; what a named list is matched on with the id. */
  readonly login?: string | null
  /** A mention fact: the forge says the author is a bot account. */
  readonly bot?: boolean
  /**
   * A request (`mentioned`): whether the forge's own edit history says the
   * comment is exactly as its author first wrote it — true; false when anyone
   * edited it; null when that history could not be read. Only true asks: an
   * edit may be anyone's who can write, so the words are no longer surely
   * the author's.
   */
  readonly unedited?: boolean | null
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

// ------------------------------------------------------------------ triage

/**
 * What triage decided about a comment that addresses a mention trigger:
 * `accept` opens work, `ignore` leaves it, `stop` asks the work on that
 * thread to stop, and `ask` puts it to the person because the rules could not
 * settle it and the assessment was unsure or could not be made.
 */
export type TriggerTriage = 'accept' | 'ignore' | 'stop' | 'ask'

/** Whether a mention trigger acts on what it accepts (`act`) or only records it (`observe`, the default). */
export type TriggerMode = 'observe' | 'act'

/** One deterministic rule a decision checked, in the order it was checked. */
export interface TriggerRuleCheck {
  /** `addressed`, `allowed`, `project`, `label`, `handled`, `stop-word`. */
  readonly id: string
  readonly passed: boolean
  /** A host-made sentence when it did not pass (or names what matched), never comment text. */
  readonly detail: string | null
}

/**
 * One triage decision, as history keeps it. Everything is a validated scalar
 * or host-made sentence except `excerpt`, which is the comment's own bounded
 * prose: information, never authority, rendered as untrusted text.
 */
export interface TriggerDecision {
  readonly id: string
  readonly trigger: string
  readonly project: string
  readonly repository: string
  readonly thread: { readonly kind: 'issue' | 'pull-request'; readonly number: number }
  readonly comment: { readonly id: string; readonly url: string; readonly at: number; readonly author: string | null; readonly excerpt: string }
  readonly decision: TriggerTriage
  /** One sentence: the rule that failed, the assessment's reason, or why it waits for the person. */
  readonly reason: string
  /** Who settled it: a deterministic rule, the observer model's assessment, or the person. */
  readonly by: 'rules' | 'assessment' | 'person'
  readonly rules: readonly TriggerRuleCheck[]
  /** The trigger's mode when it was decided: an `observe` accept is "would have accepted" and acted on nothing. */
  readonly mode: TriggerMode
  /** Whether work was opened, resumed or stopped because of it. */
  readonly acted: boolean
  /** The work thread it opened or joined, or null. */
  readonly work: string | null
  readonly decidedAt: number
  /** How many times a person asked for it to be evaluated again. */
  readonly evaluations: number
}

/**
 * One thread of work a mention opened: the issue or pull request it started
 * on, and every Goal and pull request linked to it since. A later comment on
 * any linked thread from someone allowed joins this work without a new
 * triage; it closes when every linked pull request merged or closed.
 */
export interface TriggerWorkThread {
  readonly id: string
  readonly trigger: string
  readonly project: string
  readonly repository: string
  readonly origin: { readonly kind: 'issue' | 'pull-request'; readonly number: number }
  readonly links: { readonly issues: readonly number[]; readonly pulls: readonly number[]; readonly goals: readonly string[] }
  readonly state: 'open' | 'closed'
  readonly closed: { readonly reason: 'merged' | 'closed' | 'stopped'; readonly at: number } | null
  /** Later comments from someone allowed that joined it. */
  readonly resumes: number
  /** Comments on its threads from anyone else: read, never acted on. */
  readonly observations: number
  readonly openedAt: number
}

/** A mention trigger's decisions, newest first, its mode on this machine, and its work threads. */
export interface TriggerDecisionsPage {
  readonly mode: TriggerMode
  readonly decisions: readonly TriggerDecision[]
  readonly threads: readonly TriggerWorkThread[]
}

/** At most this many decisions, and this many work threads, are kept per machine; the oldest go first. */
export const TRIGGER_DECISIONS_KEPT = 500
export const TRIGGER_THREADS_KEPT = 256
