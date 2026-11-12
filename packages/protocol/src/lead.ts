import { LEAD_STAGES, type LeadStage } from './lead-stage.js'
import { LEAD_APPROVAL_DETAIL_CHARS, parseLeadApprovalEntries, type LeadSavedApproval } from './goal-worker-approval.js'
import { CLIENT_ACTION_TIERS, CLIENT_METHODS, type ClientMethodName } from './client-surface.js'
import type { CeilingLevel } from './evidence.js'
import type { FlowSeat } from './flow.js'
import { flowSeatValidator } from './flow-seat.js'
import { parseLeadDeviceRef } from './lead-presence.js'
import { LEAD_AUTONOMY_KINDS } from './lead-autonomy.js'
import { LEAD_REQUEST_FAILURES, type LeadRequestFailure } from './lead-recovery.js'
import { isBoolean, isObject, literalUnion, optional, optionalNullable, ValidationError, type Validator } from './validate.js'

/** Versioned plain data only. Provider credentials and transport descriptors are private to the child bootstrap. */
export const LEAD_VERSION = 1
export const LEAD_SUPPORTED_VERSIONS = Object.freeze([LEAD_VERSION] as const)
export const LEAD_LIMITS = {
  idChars: 256, textChars: 16_384, pathChars: 4_096,
  steps: 64, assignments: 64, assertions: 128, evidence: 128,
  rules: 128, variables: 64, messages: 256, cards: 64, rounds: 100,
  ipcBytes: 1_048_576,
  /** Why no runtime passed the Lead's capability probe, for the person's window. */
  unavailableReasonChars: 400,
  /** One million USD per field; even three attributed totals fit safely in an integer. */
  maxUsdMicros: 1_000_000_000_000,
} as const

/** Nonnegative safe integer, advanced by nextLeadRevision; source revisions remain opaque strings. */
export type LeadRevision = number
export type LeadUsdMicros = number
export interface LeadCaps {
  /** Observed worker spend stops at this threshold; this is not an invoice ceiling. Zero closes admission.
   * LEAD_LIMITS.maxUsdMicros is the portable ceiling a goal runs with when the person's spending limit is Off. */
  readonly usdMicros: LeadUsdMicros
  /** Total rounds admitted across every execution of this logical goal. */
  readonly rounds: number
}
/** A goal at the portable ceiling has no money limit of the person's: only the overflow stop guards it. */
export const leadNoSpendLimit = (usdMicros: LeadUsdMicros): boolean => usdMicros >= LEAD_LIMITS.maxUsdMicros
/** Canonical identity supplied by the host, never inferred by the portable loop. */
export interface LeadProject { readonly id: string; readonly path: string }
export interface LeadAssignment {
  readonly role: string
  readonly agent: string
  /** Flow's structured map preserves slash-bearing model ids without compact-seat ambiguity. */
  readonly seat: FlowSeat
  readonly ceiling: CeilingLevel
}
export interface LeadPlanStep {
  readonly id: string
  readonly title: string
  readonly flow: string
  readonly sourceRevision: string
  readonly variables: Readonly<Record<string, string>>
  readonly attendance: 'attended' | 'unattended'
  readonly assignments: readonly LeadAssignment[]
}
export interface LeadAssertion {
  readonly id: string
  readonly kind: 'check' | 'review' | 'blocking-findings' | 'diff'
  readonly description: string
}
export interface LeadAcceptanceContract {
  readonly version: 1
  readonly revision: LeadRevision
  /** Host-computed SHA-256 of the frozen approval scope; validation checks its spelling, not its authenticity. */
  readonly digest: string
  readonly goal: string
  /** Host-pinned destination, captured when the approval plan is frozen. */
  readonly publicationRepository?: string | null
  readonly project: LeadProject
  readonly policyRevision: LeadRevision
  /** Array order is execution order. */
  readonly steps: readonly LeadPlanStep[]
  readonly assertions: readonly LeadAssertion[]
  readonly caps: LeadCaps
  readonly repeat?: { readonly every: LeadTaskRepeat; readonly at: string }
}
export interface LeadEvidenceReference {
  readonly kind: 'check' | 'review' | 'finding' | 'diff' | 'spend'
  readonly id: string
  readonly revision: string
}
export interface LeadAssertionResult {
  readonly assertionId: string
  /** no-evidence: no fact was recorded for this assertion at all.
   * unknown: facts exist but are stale, from another revision or contract, or incomplete.
   * errored: a check timed out, had a null exit or was interrupted; not the code's fault.
   * failed: it ran and said no. passed: it ran and said yes, without hedging.
   * pending: retained for stored journals written before evaluation. */
  readonly status: 'pending' | 'passed' | 'failed' | 'unknown' | 'no-evidence' | 'errored'
  readonly revision: LeadRevision
  readonly contractRevision: LeadRevision
  readonly evidence: readonly LeadEvidenceReference[]
  readonly reason: string | null
}
export type LeadPermissionMode = 'plan' | 'default' | 'manage'
export interface LeadPermissionRule {
  readonly id: string
  readonly effect: 'allow' | 'ask' | 'deny'
  readonly method: ClientMethodName
  /** Exact action/project match; null means every action/project within the effective contract. */
  readonly action: string | null
  readonly project: string | null
}
export interface LeadPermissionPolicy {
  readonly version: 1
  readonly revision: LeadRevision
  readonly mode: LeadPermissionMode
  readonly rules: readonly LeadPermissionRule[]
}
export type LeadStopReason = 'budget' | 'rounds' | 'unknown-spend' | 'cancelled' | 'connection-lost' | 'recovery' | 'error' | 'deadline'
export interface LeadBudgetState {
  readonly version: 1
  /** Present in host thread projections to fence controls to the current goal. */
  readonly logicalGoalId?: string
  readonly revision: LeadRevision
  readonly caps: LeadCaps
  /** Non-overlapping attributed totals. Outstanding Lead requests reserve separately. */
  readonly leadUsdMicros: LeadUsdMicros
  readonly workerUsdMicros: LeadUsdMicros
  readonly reservedUsdMicros: LeadUsdMicros
  readonly roundsAdmitted: number
  readonly spend: 'known' | 'unknown' | 'stale' | 'partial' | 'ambiguous'
  /** Durable latch; a higher cap alone does not clear it. */
  readonly stop: { readonly reason: LeadStopReason; readonly revision: LeadRevision } | null
}
/** Trusted owner input, never model output. Observations are cumulative worker-only
 * totals for their named executions; alternative sources must never be added.
 * A terminal observation names one run and its final cost, retained without expiry. */
export type LeadBudgetEvent = { readonly version: 1; readonly now: number } & (
  | { readonly type: 'initialize'; readonly logicalGoalId: string; readonly caps: LeadCaps; readonly freshnessMs: number }
  | ({ readonly type: 'bind'; readonly goalId: string; readonly executionId: string } & (
      /** A start binding always carries its host-proven first-round identity. */
      | { readonly startId: string; readonly firstRoundId: string }
      | { readonly startId?: null; readonly firstRoundId?: never }
    ))
  /** Reserve all potential input at the most expensive input/cache rate. */
  | { readonly type: 'reserve'; readonly requestId: string; readonly inputTokens: number; readonly maxOutputTokens: number;
      readonly inputUsdMicrosPerMillion: number; readonly outputUsdMicrosPerMillion: number;
      readonly cacheReadUsdMicrosPerMillion: number; readonly cacheWriteUsdMicrosPerMillion: number
      /** A request that writes a checkpoint of the conversation rather than answering it. */
      readonly purpose?: 'compaction' }
  /** Actual inputTokens exclude the separately billed cache-read/write counts. */
  | { readonly type: 'settle'; readonly requestId: string; readonly inputTokens: number; readonly outputTokens: number;
      readonly cacheReadTokens?: number; readonly cacheWriteTokens?: number }
  | { readonly type: 'uncertain'; readonly requestId: string }
  /** Conservatively settle a possibly billed request at its full reservation. */
  | { readonly type: 'write-off'; readonly requestId: string }
  | { readonly type: 'observe'; readonly at: number; readonly revision: number; readonly source: 'insight/goal' | 'worker-samples';
      readonly sourceIds: readonly string[]; readonly goalId: string; readonly executionIds: readonly string[];
      readonly quality: LeadBudgetState['spend']; readonly usdMicros: number | null; readonly terminal?: boolean }
  | { readonly type: 'start'; readonly startId: string }
  | { readonly type: 'round'; readonly executionId: string; readonly roundId: string }
  | { readonly type: 'tighten'; readonly caps: LeadCaps }
  | { readonly type: 'stop'; readonly reason: LeadStopReason }
)
interface LeadCardBase {
  readonly version: 1
  readonly id: string
  readonly revision: LeadRevision
}
export type LeadCard = (LeadCardBase & { readonly contractDigest: string } & (
  | { readonly type: 'plan'; readonly contract: LeadAcceptanceContract }
  | { readonly type: 'branch-ownership'; readonly repository: string; readonly number: number; readonly observedHead: string; readonly summary: string }
  | { readonly type: 'waiting'; readonly kind: 'person' | 'worker-approval'; readonly runId: string;
      readonly personCardId: string | null; readonly summary: string; readonly assertions: readonly LeadAssertionResult[] }
  | { readonly type: 'result'; readonly publication?: 'push'; readonly publicationSource?: { readonly runId: string; readonly reviewedHead: string; readonly evidenceRevision: string }; readonly outcome: 'reviewed' | 'accepted' | 'declined'; readonly summary: string;
      readonly assertions: readonly LeadAssertionResult[]; readonly budget: LeadBudgetState }
)) | (LeadCardBase & { readonly type: 'stopped'; readonly contractDigest: string | null;
  readonly reason: LeadStopReason; readonly summary: string; readonly budget: LeadBudgetState }
) | (LeadCardBase & {
  readonly type: 'budget-change'; readonly contractDigest: string | null; readonly logicalGoalId: string
  readonly previous: { readonly revision: LeadRevision; readonly caps: LeadCaps }; readonly proposed: LeadCaps
}) | (LeadCardBase & {
  readonly type: 'second-look'; readonly contractDigest: string | null; readonly logicalGoalId: string
  readonly runId: string; readonly stopKey: string; readonly said: string; readonly found: string; readonly did: string
}) | (LeadCardBase & {
  readonly type: 'allowance-warning'; readonly contractDigest: string | null; readonly logicalGoalId: string
  readonly usdMicros: number; readonly caps: LeadCaps
}) | (LeadCardBase & {
  readonly type: 'permission-change'
  /** Null before there is an approved contract. The immutable card ID/revision binds the policy pair. */
  readonly contractDigest: string | null
  readonly previous: LeadPermissionPolicy
  readonly proposed: LeadPermissionPolicy
})
/** Private recipe choices: person/result acceptance maps accept/decline to accepted/declined. */
export const LEAD_CARD_CHOICES = {
  plan: ['approve', 'decline'], 'permission-change': ['approve', 'decline'], 'budget-change': ['approve', 'decline'],
  'branch-ownership': ['reclaim-branch', 'decline'], waiting: ['accept', 'decline'], result: ['accept', 'accept-open-pr', 'decline'], stopped: [], 'second-look': [], 'allowance-warning': [],
} as const
/** Authenticated window input only. Never a child command or a worker approval answer. */
export interface LeadCardDecision {
  readonly version: 1
  readonly cardId: string
  readonly cardType: Exclude<LeadCard['type'], 'stopped' | 'second-look' | 'allowance-warning'>
  readonly expectedRevision: LeadRevision
  readonly contractDigest: string | null
  readonly choice: 'approve' | 'decline' | 'accept' | 'accept-open-pr' | 'reclaim-branch'
}
/** Host observation; never an instruction or permission to move work. */
export interface LeadChatIncident {
  /** Distinguishes new failed turns from repeated delivery of one observation. */
  readonly turnId?: string
  readonly chatId: string
  readonly kind: 'quota' | 'credits' | 'transient' | 'failed'
  readonly attempts: number
  readonly firstAt: number
  readonly lastAt: number
  readonly resetsAt: number | null
  readonly lastError: { readonly code: import('./events.js').AgentError['code']; readonly message: string }
  readonly state: 'waiting-reset' | 'retrying' | 'asked' | 'moved' | 'stopped' | 'cleared'
  readonly movedTo?: string
}
export interface LeadChatCandidate { readonly key: string; readonly name: string }
export interface LeadChatIncidentObservation extends LeadChatIncident {
  readonly candidates: readonly LeadChatCandidate[]
}

export interface LeadAskOption {
  readonly id: string
  readonly label: string
  /** Choosing it starts or restarts a chat. An answer that picked an option without it starts none: the host refuses
   * the start, so an answer never begins what the question said it would not. Left out on every other option. */
  readonly starts?: true
}
export interface LeadAsk {
  readonly question: string
  readonly options: readonly LeadAskOption[]
  readonly recommended: string
  /** Minutes the question stays answerable, from when the host first saw it. Left out: it does not expire. */
  readonly expiresInMinutes?: number
  /** The host read this question from the Lead under the rule that marks an option `starts` (#2145). Only then does an
   * answer without a `starts` option refuse a chat start; a question stored before the rule keeps the old behaviour. */
  readonly startsMarked?: true
}
/** One host-rendered unprompted finding. Actions navigate existing surfaces; they never grant authority. */
export interface LeadProactive {
  readonly finding: string
  readonly caveat: string
  readonly ask: string
  readonly options?: readonly LeadAskOption[]
  readonly recommended?: string
  readonly action?: 'plan' | 'changes' | 'approvals'
  /** As on `LeadAsk`: the options were written under the `starts` rule. */
  readonly startsMarked?: true
}
export interface LeadApprovalAudit { readonly ruleId: string; readonly target: string; readonly diff?: string }
/** What a reply's work item is: a Team (or its goal), a conversation (a session or a chat the Lead runs), or a work-ledger item. */
export const LEAD_MESSAGE_REF_KINDS = ['team', 'goal', 'session', 'chat', 'work'] as const
export type LeadMessageRefKind = typeof LEAD_MESSAGE_REF_KINDS[number]
/**
 * A work item a reply names, so the window and the phone can open it. Model output: a ref is a pointer, never a grant, and
 * a surface opens only one it can resolve on the desk itself. A ref it cannot resolve is not drawn.
 */
export interface LeadMessageRef { readonly kind: LeadMessageRefKind; readonly id: string; readonly title?: string }
/** At most this many refs on one reply. */
export const LEAD_MESSAGE_REFS_MAX = 8
export interface LeadMessage {
  /** Work items the reply names, in the order it names them; assistant replies only. */
  readonly refs?: readonly LeadMessageRef[]
  /** Host attribution: consent counts only the person's own messages. */
  readonly source?: 'person' | 'automatic' | 'schedule'
  /** Host acknowledgement, never supplied by the Lead model. */
  readonly approval?: LeadApprovalAudit
  readonly proactive?: LeadProactive
  readonly ask?: LeadAsk
  readonly version: 1
  readonly id: string
  readonly revision: LeadRevision
  readonly role: 'user' | 'assistant' | 'system' | 'notice'
  /** Untrusted prose; rendering still requires the transcript sanitizer. */
  readonly text: string
  /** Host notice only: the earlier conversation was summarised here. `lead/context/read` holds the summary by id. */
  readonly checkpoint?: LeadCheckpointMarker
  /**
   * The desk woke the Lead (a reminder came due): never words the person wrote. The journal keeps it as the model's
   * user turn; a thread projection shows it as a `system` line reading the reminder's own words.
   */
  readonly wake?: LeadMessageWake
  /**
   * A line the desk wrote in the Lead's name to say the person's reminder `reminded` while the thread waited on them:
   * no model wrote it, so it is not the Lead's reply to what came before (the chats it started since its last reply
   * still count).
   */
  readonly reminded?: string
}
/** What woke the Lead: `reminder` is the reminder's id, `text` its own words (untrusted, as the person or Lead set them). */
export interface LeadMessageWake { readonly kind: 'reminder'; readonly reminder: string; readonly text: string }
export type LeadThreadState = 'draft' | 'planning' | 'awaiting-plan' | 'running' | 'waiting-for-user' | 'following' | 'accepted' | 'declined' | 'stopped'
export const LEAD_MANAGEMENT_REASONS = [
  'lead-predecessor-unavailable', 'lead-predecessor-unverifiable', 'lead-renewal-blocked',
  'lead-disabled', 'lead-key-changed', 'lead-host-shutdown', 'lead-child-exited', 'lead-child-exited-again', 'lead-ownership-withdrawn',
  'lead-result-awaiting-person', 'lead-handback-limit', 'lead-handback-pending', 'lead-publication-needs-you', 'lead-pr-head-changed', 'lead-pr-branch-rewritten', 'lead-result-revisions-exhausted', 'lead-start-binding-failed', 'lead-plan-refused', 'lead-activity-failed', 'lead-subscription-failed', 'lead-tools-refused',
  'lead-repair-failed', 'lead-repair-withdrawn', 'lead-repair-abandoned', 'lead-repair-unverified', 'lead-repair-recovery-failed',
  'lead-card-too-large', 'lead-send-deadline', 'lead-request-refused', 'lead-request-rate-limited', 'lead-request-failed', 'lead-request-max-tokens', 'lead-request-invalid-response', 'lead-request-cancelled', 'lead-request-uncertain',
  'lead-request-unsent', 'lead-request-unsent-again', 'lead-request-withheld', 'lead-request-held', 'lead-request-held-again',
  'lead-worker-audit-failed', 'lead-chat-effect-uncertain', 'lead-run-not-started', 'lead-budget-unknown', 'lead-plan-unseatable', 'lead-plan-not-independent',
] as const
export interface LeadThread {
  readonly version: 1
  readonly id: string
  readonly revision: LeadRevision
  readonly state: LeadThreadState
  readonly project: LeadProject | null
  /** Journal-window decision: omitted older messages stay in the append-only journal, the persistence record.
   * Projections contain the most recent messages and active/recent cards within their limits;
   * hosts must window before projecting, never persist the projection as the entire conversation. */
  readonly olderMessages: number
  readonly messages: readonly LeadMessage[]
  readonly cards: readonly LeadCard[]
  /** Read-only past cards; informational records carry no person choice. */
  readonly decisions?: readonly LeadDecisionMessage[]
  /** Host journal positions remain fixed when a card gets a newer revision. */
  readonly cardPositions?: Readonly<Record<string, number>>
  readonly contract?: LeadAcceptanceContract | null
  readonly budget?: LeadBudgetState | null
  readonly origin?: LeadOrigin | null
  readonly handback?: LeadHandback | null
  readonly pr?: LeadPullRequest | null
}
export type LeadName = 'dex' | 'lex'

const LEAD_DISPLAY_NAMES: Readonly<Record<LeadName, string>> = { dex: 'Dex', lex: 'Lex' }
/** The name the person picked, as both the receiving model and the transcript read it. */
export const leadDisplayName = (name: LeadName): string => LEAD_DISPLAY_NAMES[name]

/** Who directs one ordinary chat the Lead has written to. */
export type LeadChatHolder = 'lead' | 'person'
export interface LeadChatControl {
  /** `runtime:session`, the id `lead/chat/*` uses. */
  readonly id: string
  readonly holder: LeadChatHolder
  /** Keys (`leadMessageKey`) of the envelopes the host delivered, newest last. */
  readonly sent: readonly string[]
}
export interface LeadChatControlProblem {
  readonly kind: 'invalid' | 'transient' | 'unavailable'
  readonly message: string
  /** Window-only: escalated I/O still permits a read and one automatic retry. */
  readonly retryable?: boolean
}
/** Chat holders and verification keys in the selected project; `project` is null when no Lead project is set. */
export interface LeadChatControlList { readonly project: string | null; readonly chats: readonly LeadChatControl[]; readonly problem?: LeadChatControlProblem }

export interface LeadDecisionMessage { readonly card: LeadCard; readonly choice?: LeadCardDecision['choice']; readonly position: number }
export interface LeadFollowPreferences { readonly checks: boolean; readonly reviews: boolean }
export interface LeadPullRequest {
  readonly repository: string; readonly number: number; readonly branch: string; readonly head: string
  readonly branchOwner?: 'lead' | 'person'
  readonly branchChange?: 'fast-forward' | 'rewrite'
  readonly releaseReason?: string
  readonly observedHead?: string
  readonly review?: import('./intake.js').TriggerReview | null
  readonly state: 'open' | 'merged' | 'closed'; readonly check: import('./intake.js').TriggerCheck | null; readonly at: number
}
export interface LeadSettingsProjection {
  readonly unavailable?: 'runtime'
  /** Why no runtime passed the capability probe; present only with `unavailable`. */
  readonly unavailableReason?: string
  readonly nameChosen?: boolean
  readonly name: LeadName
  readonly version: 1
  readonly model: string
  readonly key: { readonly configured: boolean; readonly protection: 'encrypted' | 'unavailable' }
  readonly policy: LeadPermissionPolicy
  readonly caps: LeadCaps
  /** The person's standing money limit per goal in USD micros; null is Off. Absent only on a desk that has not
   * recorded one yet. `caps` is the goal in hand, which a raise or a plan may have set apart from this. */
  readonly spendLimitUsdMicros?: LeadUsdMicros | null
  readonly follow?: LeadFollowPreferences
}
export interface LeadHostProjection {
  readonly version: 1
  readonly revision: LeadRevision
  readonly thread: LeadThread
  readonly settings: LeadSettingsProjection
}
export type LeadPersonAction = 'resume' | 'decide-plan' | null
/** Where a running goal stands, in numbers: the step the Lead is on, of how many, and how many runs it has started. */
export interface LeadProgress {
  readonly step: number; readonly steps: number; readonly runs: number
  /** When this host first saw the goal running, for the elapsed time beside Stop; absent when it never saw it start. */
  readonly since?: number
}
/** How one run the Lead owns stands, as the Lead's own host reads it between model turns. */
export type LeadRunClass = 'advanced' | 'stuck' | 'plan-only' | 'blocked' | 'done'
export interface LeadRunReading { readonly runId: string; readonly kind: LeadRunClass; readonly quietMinutes?: number }
/** What the Lead did between turns: how many desk changes it looked at, how many of those it let pass, and how each run reads. */
export interface LeadPresence {
  readonly checked: number; readonly quiet: number; readonly lastCheckedAt: number | null
  readonly readings: readonly LeadRunReading[]
}
/** Durable host observations, including checks that never used a model. Newest 128 are projected. */
export interface LeadWakeRecord {
  readonly id: string; readonly at: number
  readonly source: 'schedule' | 'desk-change' | 'person' | 'trigger'
  /** `failed`: the wake's request did not complete, and nothing was said. */
  readonly decision: 'silent' | 'spoke' | 'asked' | 'failed'
  readonly modelTurn: boolean
  readonly usdMicros: number | null
  /** What the wake's model requests reported, summed. Absent for a wake without a model turn and on older records. */
  readonly tokens?: LeadWakeTokens
  /** Set when the person's setting was Observe: the host saw this kind of thing and did nothing about it. */
  readonly observed?: import('./lead-autonomy.js').LeadAutonomyKind
}
export interface LeadWakeLog { readonly revision: number; readonly wakes: readonly LeadWakeRecord[] }
/** A goal the Lead opens on its own at a set time. It only ever reaches a plan card: the person still approves. */
export type LeadTaskRepeat = 'day' | 'weekdays' | 'mondays' | 'fridays'
export interface LeadScheduledRun {
  readonly slot: number; readonly at: number; readonly state: 'started' | 'skipped' | 'needs-approval'
  readonly reason?: string; readonly logicalGoalId?: string; readonly outcome?: 'accepted' | 'declined' | 'stopped'
  readonly usdMicros?: number; readonly rounds?: number
}
export interface LeadRepeatControl { readonly taskId: string; readonly action: 'pause' | 'resume' | 'stop' | 'run-now' }
export interface LeadBudgetRaise { readonly logicalGoalId: string; readonly caps: LeadCaps; readonly expectedRevision: number }
/** The money limit alone, never policy, rounds, name or credentials: narrow enough for a paired phone. Null is Off. */
export interface LeadSpendLimitSet { readonly usdMicros: LeadUsdMicros | null; readonly expectedRevision: number }
export interface LeadScheduledTask {
  readonly project?: string
  readonly id: string; readonly title: string; readonly goal: string
  readonly every: LeadTaskRepeat; readonly at: string; readonly enabled: boolean
  /** When the host last opened it; null before the first time. */
  readonly lastRunAt: number | null
  /** Host creation baseline: the first wake never redeems a slot before this task existed. */
  readonly createdAt?: number
  readonly approved?: { readonly contract: LeadAcceptanceContract; readonly contractDigest: string }
  readonly perRunCaps?: LeadCaps
  readonly paused?: boolean
  readonly runs?: readonly LeadScheduledRun[]
}
/** Hours, in the desk's own clock, when the Lead opens nothing on its own. */
export interface LeadQuietHours { readonly from: string; readonly to: string }
export interface LeadSchedule { readonly seedChoices?: readonly string[]; readonly version: 1; readonly tasks: readonly LeadScheduledTask[]; readonly quiet: LeadQuietHours | null }
/** One line the Lead keeps between goals. A suggestion is the Lead's; only a kept line reaches its instructions. */
export interface LeadMemoryItem { readonly id: string; readonly text: string; readonly state: 'kept' | 'suggested'; readonly at: number }
export interface LeadMemory { readonly version: 1; readonly items: readonly LeadMemoryItem[] }
export const LEAD_SCHEDULE_LIMITS = { tasks: 20, memory: 100 } as const
/** A word the person sent to the running worker through the Lead, without restarting it. */
export interface LeadSteer { readonly id: string; readonly text: string; readonly at: number; readonly state: 'acknowledged' | 'refused'
  /** The thread revision it was sent at, so it sits where it was said rather than at the end. */
  readonly after?: number }
/** Live host-owned requests. These are not model-proposed cards or LeadCardDecision inputs. */
export type LeadAction =
  | { readonly kind: 'worker-approval'; readonly id: string; readonly runId: string; readonly role: string; readonly request: string; readonly choices: readonly ('yes-once' | 'yes-goal' | 'no')[]; readonly details?: string }
  | { readonly kind: 'check'; readonly id: string; readonly runId: string; readonly name: string; readonly command: string }
export interface LeadActionInput { readonly id: string; readonly contractDigest: string; readonly choice: 'yes-once' | 'yes-goal' | 'no' | 'run' }
/** Window projection adds the host's guarded way out; child observations grant no control. */
export interface LeadWindowProjection extends LeadHostProjection {
  /** Absent on older desks. */
  readonly stage?: LeadStage
  readonly stageReason?: string
  readonly savedApprovals?: readonly LeadSavedApproval[]
  readonly revokedApprovals?: readonly LeadSavedApproval[]
  readonly personActions?: readonly LeadAction[]
  readonly requestInFlight: boolean
  /** Host request clock and admitted desk operation; presentation only, no model prose. */
  readonly activity?: { readonly since: number; readonly method: string | null
    /** The step in plain words (`lead-steps.ts`): thinking, the desk call in flight or the last one, or writing the reply. Absent on older desks. */
    readonly step?: string }
  readonly wayOut: LeadPersonAction
  readonly waitReason: typeof LEAD_MANAGEMENT_REASONS[number] | null
  /** Present while the wait is a request that did not complete: its code and the sentence a surface shows. Absent on older desks. */
  readonly failure?: LeadRequestFailure
  readonly planConsentExpiresAt: number | null
  /** Present only while the goal is running; it is read from the journal and grants nothing. */
  readonly progress?: LeadProgress
  /** The Team of the goal's latest run, while the goal is running: the board where its evidence and the person's own acts live. */
  readonly team?: string
  /** The Lead's checks between turns, while a goal is running; it informs and grants nothing. */
  readonly presence?: LeadPresence
  /** The person's steers to the running worker in this goal, oldest first. */
  readonly steers?: readonly LeadSteer[]
}
export interface LeadProjectionFailure { readonly version: 1; readonly revision: LeadRevision; readonly error: 'lead-projection-failed' }
export type LeadChanged = LeadWindowProjection | LeadProjectionFailure
/** A closed name write acknowledges only its name; it is not a scanned window projection. */
export interface LeadNameReceipt {
  readonly version: 1
  readonly revision: LeadRevision
  readonly settings: { readonly name: LeadName; readonly nameChosen?: boolean }
}
export const LEAD_CONTROL_REFUSALS = ['lead-runtime-unsupported', 'lead-unavailable', 'lead-operation-refused', 'lead-secret-refused', 'lead-revision-stale',
  'lead-approval-not-live', 'lead-no-person-wait', 'lead-plan-pending', 'lead-card-stale', 'lead-card-decided', 'lead-worker-approval',
  'lead-gate-changed', 'lead-gate-save-failed', 'lead-settings-combination', 'lead-evidence-read-refused',
  'lead-change-pending', 'lead-card-too-large', 'lead-projection-failed', 'lead-key-missing', 'lead-secret-in-thread',
  'lead-chat-effect-uncertain', 'lead-thread-closed', 'lead-budget-stopped', 'lead-protection-unavailable', 'lead-request-in-flight', 'lead-project-missing', 'lead-steer-unavailable', 'lead-repeat-missing', 'lead-repeat-quiet', 'lead-repeat-cleanup-pending', 'lead-ask-expired', 'lead-ask-answered', 'lead-slot-reserved', 'lead-rules-stale', 'lead-rule-empty', 'lead-rule-version-missing', 'lead-deadline-goal', 'lead-deadline-past',
  'lead-memory-missing', 'lead-memory-stale', 'lead-memory-full', 'lead-memory-core-full', 'lead-memory-instruction-refused', 'lead-ask-replaced',
  'lead-proposal-missing', 'lead-proposal-decided', 'lead-proposal-desk-only'] as const
export type LeadControlRefusal = typeof LEAD_CONTROL_REFUSALS[number]
/** Window-only input. Credentials are consumed by the broker lifecycle, never persisted as settings. */
export interface LeadSettingsUpdate {
  readonly name?: LeadName
  readonly expectedRevision: LeadRevision
  readonly policy?: LeadPermissionPolicy
  readonly caps?: LeadCaps
  readonly follow?: LeadFollowPreferences
  readonly credential?: { readonly provider: 'anthropic'; readonly key: string | null }
}
/** Host-journaled automatic input; external prose never grants worker authority. */
export interface LeadOrigin { readonly source: 'pull-request' | 'issue' | 'schedule'; readonly event: string; readonly subject: string; readonly url: string | null }
export interface LeadHandback {
  readonly key: string; readonly event: string; readonly kind: 'checks' | 'reviews'; readonly head: string
  readonly runId: string; readonly teamId: string; readonly round: number; readonly at: number
  readonly stage: 'prepared' | 'running' | 'awaiting-ci' | 'completed' | 'failed' | 'abandoned' | 'withdrawn'; readonly publishedHead: string | null; readonly detail?: string
}
export interface LeadThreadSend {
  readonly idempotencyKey: string
  readonly text: string
  /** Which device wrote it, so an answer to a question can name who answered. The phone link sets it itself. */
  readonly device?: import('./lead-presence.js').LeadDeviceRef
  /** The id of the message whose option this text answers, when it is a tapped option. */
  readonly ask?: string
}
/** Stable first result, retained across retries and journal recovery. */
export interface LeadSendReceipt { readonly messageId: string; readonly revision: LeadRevision }
/** Public control vocabulary carries no secrets and grants no human decision authority. */
export type LeadChildControl = { readonly version: 1 } & (
  | { readonly type: 'initialize'; readonly thread: LeadThread; readonly model: string;
      readonly policy: LeadPermissionPolicy; readonly budget: LeadBudgetState }
  | { readonly type: 'observe'; readonly projection: LeadHostProjection }
  | { readonly type: 'cancel'; readonly reason: LeadStopReason }
)
export type LeadChildEvent = { readonly version: 1 } & (
  | { readonly type: 'ready' }
  | { readonly type: 'projection'; readonly thread: LeadThread }
  | { readonly type: 'stopped'; readonly reason: LeadStopReason }
)

const fail = (path: string, message: string): never => { throw new ValidationError(path, message) }
const integer = (min = 0, max = Number.MAX_SAFE_INTEGER): Validator<number> => (value, path = '') =>
  typeof value === 'number' && Number.isSafeInteger(value) && !Object.is(value, -0) && value >= min && value <= max
    ? value : fail(path, `expected safe integer in ${min}..${max}`)
const revision = integer()
const micros = integer(0, LEAD_LIMITS.maxUsdMicros)
const version: Validator<1> = (value, path = '') => value === LEAD_VERSION ? LEAD_VERSION : fail(path, 'unsupported Lead version')
// Supported runtimes provide this ES2024 method; the shared compile-time library is ES2023.
const wellFormed = (value: string) => (value as string & { isWellFormed(): boolean }).isWellFormed()
const boundedText = (max: number, allowEmpty: boolean, controls: RegExp): Validator<string> => (value, path = '') =>
  typeof value === 'string' && wellFormed(value) && (allowEmpty || value.trim().length > 0) && value.length <= max && !controls.test(value)
    ? value : fail(path, `expected ${allowEmpty ? '' : 'nonempty '}string of at most ${max} characters without controls`)
const text = (max: number) => boundedText(max, false, /[\u0000-\u001f\u007f-\u009f]/)
/** Catalogue IDs are filenames, model choices are agent-owned, and repository identities
 * can contain punctuation. Current Flow revisions are hex hashes, but Lead keeps them opaque. */
const opaque = text(LEAD_LIMITS.idChars)
const id: Validator<string> = (value, path = '') => {
  const parsed = text(LEAD_LIMITS.idChars)(value, path)
  return /^[A-Za-z0-9._:/@-]+$/.test(parsed) ? parsed : fail(path, 'invalid Lead identifier')
}
/** Prose preserves LF, CR and tab for Markdown and Flow inputs; other C0, DEL and C1 remain forbidden. */
const proseControls = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/
const prose = boundedText(LEAD_LIMITS.textChars, false, proseControls)
/** Empty assistant/tool-only text, optional variable values and absent summaries are legitimate. */
const content = boundedText(LEAD_LIMITS.textChars, true, proseControls)
const digest: Validator<string> = (value, path = '') =>
  typeof value === 'string' && /^[a-f0-9]{64}$/.test(value) ? value : fail(path, 'expected SHA-256 digest')
const nullable = <T>(parse: Validator<T>): Validator<T | null> => (value, path) => value === null ? null : parse(value, path)
const list = <T>(parse: Validator<T>, max: number, min = 0, keyOf?: (entry: T) => string): Validator<readonly T[]> => (value, path = '') => {
  if (!Array.isArray(value) || value.length < min || value.length > max) return fail(path, `expected ${min}..${max} entries`)
  const keys = new Set<string>()
  return Array.from({ length: value.length }, (_, index) => {
    const at = `${path}[${index}]`
    if (!Object.hasOwn(value, index)) return fail(at, 'missing array entry')
    const parsed = parse(value[index], at)
    if (keyOf) {
      const key = keyOf(parsed)
      if (keys.has(key)) return fail(at, 'duplicate Lead identity')
      keys.add(key)
    }
    return parsed
  })
}
/** Closed projections: unknown fields must never pass through into the window or IPC. */
const object = <T>(fields: { [K in keyof T]: Validator<T[K]> }): Validator<T> => (value, path = '') => {
  const source = isObject(value, path)
  for (const key of Object.keys(source)) if (!Object.hasOwn(fields, key)) fail(path, 'unexpected Lead field')
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(fields) as (keyof T & string)[]) out[key] = fields[key](source[key], path ? `${path}.${key}` : key)
  return out as T
}
/** New optional projection fields preserve absence across older journal versions. */
const omitUnset = <T>(parse: Validator<T>, keys: readonly (keyof T & string)[]): Validator<T> => (value, path = '') => {
  const parsed = parse(value, path)
  for (const key of keys) if (parsed[key] === undefined) Reflect.deleteProperty(parsed as object, key)
  return parsed
}
const tag = <T>(branches: Readonly<Record<string, Validator<T>>>): Validator<T> => (value, path = '') => {
  const source = isObject(value, path)
  if (typeof source.type !== 'string' || !Object.hasOwn(branches, source.type)) return fail(path, 'unknown Lead message type')
  return branches[source.type]!(value, path)
}
/** IPC decision: at most one MiB of UTF-8 JSON per control/event, including all nested data.
 * Transports must cap raw frames before parsing too. Recheck validated data so toJSON cannot
 * hide a large in-memory projection. The journal retains data omitted from these windows. */
const ipc = <T>(parse: Validator<T>): Validator<T> => (value, path = '') => {
  const check = (data: unknown) => {
    let json: string | undefined
    try { json = JSON.stringify(data) } catch { return fail(path, 'invalid Lead IPC data') }
    if (json === undefined || new TextEncoder().encode(json).byteLength > LEAD_LIMITS.ipcBytes) fail(path, 'Lead IPC byte limit exceeded')
  }
  check(value)
  const parsed = parse(value, path)
  check(parsed)
  return parsed
}
const variables: Validator<Readonly<Record<string, string>>> = (value, path = '') => {
  const entries = Object.entries(isObject(value, path))
  if (entries.length > LEAD_LIMITS.variables) return fail(path, 'too many variables')
  return Object.fromEntries(entries.map(([key, value]) => {
    if (key === '__proto__') return fail(path, 'forbidden variable key')
    return [id(key, path), content(value, `${path}.${key}`)]
  }))
}
export const parseLeadCaps: Validator<LeadCaps> = object({ usdMicros: micros, rounds: integer(1, LEAD_LIMITS.rounds) })
const projectPath: Validator<string> = (value, path = '') => {
  const parsed = text(LEAD_LIMITS.pathChars)(value, path)
  if (!/^(?:\/|[A-Za-z]:[\\/]|\\\\[^\\/]+[\\/][^\\/]+)/.test(parsed) || parsed.split(/[\\/]/).includes('..'))
    return fail(path, 'expected absolute project path without parent traversal')
  return parsed
}
const project: Validator<LeadProject> = object({ id: opaque, path: projectPath })
const boundedSeat: Validator<FlowSeat> = object({
  runtime: opaque, model: optional(opaque), effort: optional(opaque), thinking: optional(isBoolean),
})
const seat: Validator<FlowSeat> = (value, path = '') => {
  // Reuse Flow's semantics, then apply Lead's closed projection and string bounds.
  const parsed = boundedSeat(flowSeatValidator(value, path), path)
  return Object.fromEntries(Object.entries(parsed).filter(([, value]) => value !== undefined)) as unknown as FlowSeat
}
const assignment: Validator<LeadAssignment> = object({ role: id, agent: id, seat, ceiling: literalUnion('read', 'edit', 'publish', 'merge') })
const step: Validator<LeadPlanStep> = object({
  id, title: prose, flow: opaque, sourceRevision: opaque, variables, attendance: literalUnion('attended', 'unattended'),
  assignments: list(assignment, LEAD_LIMITS.assignments, 1, assignment => assignment.role),
})
const assertion: Validator<LeadAssertion> = object({ id, kind: literalUnion('check', 'review', 'blocking-findings', 'diff'), description: prose })
const clockTime: Validator<string> = (value, path = '') => typeof value === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(value) ? value : fail(path, 'expected HH:MM')
const repeat = object({ every: literalUnion('day', 'weekdays', 'mondays', 'fridays'), at: clockTime })
const acceptanceContractParser: Validator<LeadAcceptanceContract> = object({
  version, revision, digest, goal: prose, project, policyRevision: revision, publicationRepository: optionalNullable(opaque), repeat: optional(repeat),
  steps: list(step, LEAD_LIMITS.steps, 1, step => step.id), assertions: list(assertion, LEAD_LIMITS.assertions, 1, assertion => assertion.id), caps: parseLeadCaps,
})
export const parseLeadAcceptanceContract: Validator<LeadAcceptanceContract> = (value, path = '') => {
  const parsed = Object.fromEntries(Object.entries(acceptanceContractParser(value, path)).filter(([, item]) => item !== undefined)) as unknown as LeadAcceptanceContract
  if (parsed.publicationRepository === undefined) { const { publicationRepository: _, ...rest } = parsed; return rest }
  if (parsed.publicationRepository !== null && !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(parsed.publicationRepository)) return fail(path, 'expected repository')
  return parsed
}
const evidence: Validator<LeadEvidenceReference> = object({ kind: literalUnion('check', 'review', 'finding', 'diff', 'spend'), id, revision: opaque })
export const parseLeadAssertionResult: Validator<LeadAssertionResult> = object({
  assertionId: id, status: literalUnion('pending', 'passed', 'failed', 'unknown', 'no-evidence', 'errored'), revision,
  contractRevision: revision, evidence: list(evidence, LEAD_LIMITS.evidence), reason: nullable(prose),
})
const method: Validator<ClientMethodName> = (value, path = '') =>
  typeof value === 'string' && Object.hasOwn(CLIENT_METHODS, value) ? value as ClientMethodName : fail(path, 'method outside client surface')
const ruleShape: Validator<LeadPermissionRule> = object({
  id, effect: literalUnion('allow', 'ask', 'deny'), method, action: nullable(id), project: nullable(opaque),
})
const rule: Validator<LeadPermissionRule> = (value, path = '') => {
  const parsed = ruleShape(value, path)
  if (parsed.action !== null && !Object.hasOwn(CLIENT_ACTION_TIERS, parsed.method))
    fail(path, 'method has no permission actions')
  return parsed
}
export const parseLeadPermissionPolicy: Validator<LeadPermissionPolicy> = object({
  version, revision, mode: literalUnion('plan', 'default', 'manage'), rules: list(rule, LEAD_LIMITS.rules, 0, rule => rule.id),
})
const stopReason = literalUnion('budget', 'rounds', 'unknown-spend', 'cancelled', 'connection-lost', 'recovery', 'error', 'deadline')
const budgetState: Validator<LeadBudgetState> = object({
  version, logicalGoalId: optional(id), revision, caps: parseLeadCaps, leadUsdMicros: micros, workerUsdMicros: micros, reservedUsdMicros: micros,
  roundsAdmitted: integer(0, LEAD_LIMITS.rounds), spend: literalUnion('known', 'unknown', 'stale', 'partial', 'ambiguous'),
  stop: nullable(object({ reason: stopReason, revision })),
})
/** The spend observation reaching the cap and its stop latch must land in one journal
 * record, never as separately persisted snapshots. A zero-dollar initial budget includes
 * the latch in its first record too; the reducer must not persist an invalid intermediate. */
export const parseLeadBudgetState: Validator<LeadBudgetState> = (value, path = '') => {
  const parsed = budgetState(value, path)
  const reported = parsed.leadUsdMicros + parsed.workerUsdMicros
  if (parsed.stop !== null && parsed.stop.revision > parsed.revision) fail(path, 'stop revision exceeds budget revision')
  // Tightening can put observed work above either cap. Such snapshots remain valid only
  // after latching stop; never erase observed spend/rounds to make the new cap fit.
  if (parsed.stop === null && (parsed.roundsAdmitted > parsed.caps.rounds ||
    reported >= parsed.caps.usdMicros))
    fail(path, 'budget above allowance requires a stop latch')
  const { logicalGoalId, ...rest } = parsed
  return logicalGoalId === undefined ? rest : parsed
}
const budgetBase = { version, now: integer() }
type BudgetOf<T extends LeadBudgetEvent['type']> = Extract<LeadBudgetEvent, { type: T }>
const tokenCount = integer(0, 100_000_000)
const budgetEvent = tag<LeadBudgetEvent>({
  initialize: object<BudgetOf<'initialize'>>({ ...budgetBase, type: literalUnion('initialize'), logicalGoalId: id, caps: parseLeadCaps, freshnessMs: integer(1, 86_400_000) }),
  bind: (value, path) => {
    const { startId, firstRoundId, ...base } = object<Omit<BudgetOf<'bind'>, 'startId' | 'firstRoundId'> & {
      startId?: string | null; firstRoundId?: string
    }>({ ...budgetBase, type: literalUnion('bind'), goalId: id, executionId: id, startId: optional(nullable(id)), firstRoundId: optional(id) })(value, path)
    if (typeof startId === 'string') return { ...base, startId, firstRoundId: id(firstRoundId, path ? `${path}.firstRoundId` : 'firstRoundId') }
    if (firstRoundId !== undefined) fail(path ?? '', 'first round requires its bound start')
    return startId === null ? { ...base, startId } : base
  },
  reserve: object<BudgetOf<'reserve'>>({ ...budgetBase, type: literalUnion('reserve'), requestId: id, inputTokens: tokenCount,
    maxOutputTokens: tokenCount, inputUsdMicrosPerMillion: micros, outputUsdMicrosPerMillion: micros,
    cacheReadUsdMicrosPerMillion: micros, cacheWriteUsdMicrosPerMillion: micros, purpose: optional(literalUnion('compaction')) }),
  settle: object<BudgetOf<'settle'>>({ ...budgetBase, type: literalUnion('settle'), requestId: id, inputTokens: tokenCount, outputTokens: tokenCount, cacheReadTokens: optional(tokenCount), cacheWriteTokens: optional(tokenCount) }),
  'write-off': object<BudgetOf<'write-off'>>({ ...budgetBase, type: literalUnion('write-off'), requestId: id }),
  uncertain: object<BudgetOf<'uncertain'>>({ ...budgetBase, type: literalUnion('uncertain'), requestId: id }),
  observe: object<BudgetOf<'observe'>>({ ...budgetBase, type: literalUnion('observe'), at: integer(), revision, source: literalUnion('insight/goal', 'worker-samples'),
    sourceIds: list(id, 128, 0, item => item), goalId: id, executionIds: list(id, LEAD_LIMITS.rounds, 0, item => item),
    quality: literalUnion('known', 'unknown', 'stale', 'partial', 'ambiguous'), usdMicros: nullable(micros), terminal: optional(isBoolean) }),
  start: object<BudgetOf<'start'>>({ ...budgetBase, type: literalUnion('start'), startId: id }),
  round: object<BudgetOf<'round'>>({ ...budgetBase, type: literalUnion('round'), executionId: id, roundId: id }),
  tighten: object<BudgetOf<'tighten'>>({ ...budgetBase, type: literalUnion('tighten'), caps: parseLeadCaps }),
  stop: object<BudgetOf<'stop'>>({ ...budgetBase, type: literalUnion('stop'), reason: stopReason }),
})
export const parseLeadBudgetEvent: Validator<LeadBudgetEvent> = (value, path = '') => {
  const parsed = budgetEvent(value, path)
  if (parsed.type === 'observe' && (parsed.at > parsed.now || parsed.quality === 'known' && (parsed.usdMicros === null || parsed.sourceIds.length === 0) ||
    parsed.terminal && (parsed.executionIds.length !== 1 || parsed.quality !== 'known')))
    fail(path, 'invalid spend observation')
  return Object.fromEntries(Object.entries(parsed).filter(([, item]) => item !== undefined)) as LeadBudgetEvent
}
const cardBase = { version, id, revision, contractDigest: digest }
type CardOf<T extends LeadCard['type']> = Extract<LeadCard, { type: T }>
const card = tag<LeadCard>({
  'branch-ownership': object<CardOf<'branch-ownership'>>({ ...cardBase, type: literalUnion('branch-ownership'), repository: opaque, number: integer(1), observedHead: opaque, summary: content }),
  plan: object<CardOf<'plan'>>({ ...cardBase, type: literalUnion('plan'), contract: parseLeadAcceptanceContract }),
  'permission-change': object<CardOf<'permission-change'>>({ ...cardBase, contractDigest: nullable(digest), type: literalUnion('permission-change'), previous: parseLeadPermissionPolicy, proposed: parseLeadPermissionPolicy }),
  'budget-change': object<CardOf<'budget-change'>>({ ...cardBase, contractDigest: nullable(digest), type: literalUnion('budget-change'), logicalGoalId: id,
    previous: object({ revision, caps: parseLeadCaps }), proposed: parseLeadCaps }),
  waiting: object<CardOf<'waiting'>>({ ...cardBase, type: literalUnion('waiting'), kind: literalUnion('person', 'worker-approval'), runId: id,
    personCardId: nullable(id), summary: content, assertions: list(parseLeadAssertionResult, LEAD_LIMITS.assertions, 0, result => result.assertionId) }),
  result: object<CardOf<'result'>>({ ...cardBase, type: literalUnion('result'), publication: optional(literalUnion('push')), publicationSource: optional(object({ runId: id, reviewedHead: opaque, evidenceRevision: content })), outcome: literalUnion('reviewed', 'accepted', 'declined'),
    summary: content, assertions: list(parseLeadAssertionResult, LEAD_LIMITS.assertions, 0, result => result.assertionId), budget: parseLeadBudgetState }),
  'second-look': object<CardOf<'second-look'>>({ ...cardBase, contractDigest: nullable(digest), type: literalUnion('second-look'), logicalGoalId: id, runId: id, stopKey: id, said: text(1000), found: text(1000), did: text(1000) }),
  'allowance-warning': object<CardOf<'allowance-warning'>>({ ...cardBase, contractDigest: nullable(digest), type: literalUnion('allowance-warning'), logicalGoalId: id, usdMicros: micros, caps: parseLeadCaps }),
  stopped: object<CardOf<'stopped'>>({ ...cardBase, contractDigest: nullable(digest), type: literalUnion('stopped'), reason: stopReason, summary: content, budget: parseLeadBudgetState }),
})
export const parseLeadCard: Validator<LeadCard> = (value, path = '') => {
  const parsed = card(value, path)
  if (parsed.type === 'plan' && parsed.contractDigest !== parsed.contract.digest) fail(path, 'plan card digest differs from contract')
  if (parsed.type === 'waiting' && parsed.kind === 'worker-approval' && parsed.personCardId !== null) fail(path, 'worker approval cannot be a person decision')
  if (parsed.type === 'waiting' && parsed.kind === 'person' && parsed.personCardId === null) fail(path, 'person decision requires a live gate identifier')
  // Policy proposals are immutable at this card revision. Replacing either policy must advance it.
  // Before applying a click the host revalidates the current policy and the live contract/gate;
  // a digest is never used as a substitute for the policy pair when no contract exists.
  if (parsed.type === 'permission-change' && parsed.proposed.revision <= parsed.previous.revision) fail(path, 'policy proposal must advance its revision')
  if (parsed.type === 'budget-change' && parsed.proposed.usdMicros <= parsed.previous.caps.usdMicros && parsed.proposed.rounds <= parsed.previous.caps.rounds)
    fail(path, 'budget proposal must increase an allowance')
  if (parsed.type === 'result') {
    const { publication, publicationSource, ...rest } = parsed
    return { ...rest, ...(publication === undefined ? {} : { publication }), ...(publicationSource === undefined ? {} : { publicationSource }) }
  }
  return parsed
}
const decision: Validator<LeadCardDecision> = object({
  version, cardId: id, cardType: literalUnion('plan', 'permission-change', 'budget-change', 'waiting', 'result', 'branch-ownership'),
  expectedRevision: revision, contractDigest: nullable(digest), choice: literalUnion('approve', 'decline', 'accept', 'accept-open-pr', 'reclaim-branch'),
})
export const parseLeadCardDecision: Validator<LeadCardDecision> = (value, path = '') => {
  const parsed = decision(value, path)
  if (!(LEAD_CARD_CHOICES[parsed.cardType] as readonly string[]).includes(parsed.choice)) fail(path, 'choice is not allowed for this card type')
  if (!['permission-change', 'budget-change'].includes(parsed.cardType) && parsed.contractDigest === null) fail(path, 'decision requires a contract digest')
  return parsed
}
/** Structural parsing alone cannot authorize a click. Call against the live immutable card immediately before effects. */
export const parseLeadCardDecisionFor = (value: unknown, current: unknown): LeadCardDecision => {
  const parsed = parseLeadCardDecision(value)
  const card = parseLeadCard(current)
  if (parsed.cardId !== card.id || parsed.expectedRevision !== card.revision || parsed.cardType !== card.type || parsed.contractDigest !== card.contractDigest)
    return fail('', 'stale or mismatched card decision')
  if ((card.type === 'waiting' && card.kind === 'worker-approval') || (card.type === 'result' && card.outcome !== 'reviewed'))
    return fail('', 'card has no pending person decision')
  return parsed
}
const proactiveLine: Validator<string> = (value, path = '') => {
  const line = boundedText(800, false, proseControls)(value, path)
  return /[\r\n]/.test(line) ? fail(path, 'expected one proactive line') : line
}
const askExpiry: Validator<number> = (value, path = '') =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 5 && value <= 7 * 24 * 60 ? value : fail(path, 'expected 5 to 10080 minutes')
const askOptionId: Validator<string> = (value, path = '') =>
  typeof value === 'string' && /^[a-z0-9-]{1,32}$/.test(value) ? value : fail(path, 'expected a short option slug')
const askOptions = list(omitUnset(object<LeadAskOption>({ id: askOptionId, label: (value, path = '') => {
  const label = text(60)(value, path)
  return label !== label.trim() || /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(label) ? fail(path, 'expected one trimmed plain-text label') : label
}, starts: optional((value, path = '') => value === true ? true as const : fail(path, 'expected true')) }), ['starts']), 4, 2, option => option.id)
const startsMarked = optional((value, path = '') => value === true ? true as const : fail(path, 'expected true'))
export const parseLeadAsk: Validator<LeadAsk> = (value, path = '') => {
  const ask = omitUnset(object<LeadAsk>({ question: proactiveLine, options: askOptions, recommended: askOptionId, expiresInMinutes: optional(askExpiry), startsMarked }), ['expiresInMinutes', 'startsMarked'])(value, path)
  if (new Set(ask.options.map(option => option.label.trim().replace(/\s+/gu, ' ').toLowerCase())).size !== ask.options.length) fail(path, 'duplicate option label')
  if (!ask.options.some(option => option.id === ask.recommended)) fail(path, 'recommendation must name an option')
  return ask
}
export const parseLeadProactive: Validator<LeadProactive> = (value, path = '') => {
  const report = omitUnset(object<LeadProactive>({ finding: proactiveLine, caveat: proactiveLine, ask: proactiveLine,
    options: optional(askOptions), recommended: optional(askOptionId), action: optional(literalUnion('plan', 'changes', 'approvals')), startsMarked }), ['options', 'recommended', 'startsMarked'])(value, path)
  if (report.options !== undefined || report.recommended !== undefined)
    parseLeadAsk({ question: report.ask, options: report.options, recommended: report.recommended }, path)
  return report
}
/** Fresh model output must offer a decision; journal readers retain legacy reports. */
export const parseLeadProactiveOutput: Validator<LeadProactive> = (value, path = '') => {
  const report = parseLeadProactive(value, path)
  parseLeadAsk({ question: report.ask, options: report.options, recommended: report.recommended }, path)
  return report
}
/** Evidence captured before a newer read (or a failed read) cannot be stated as a verified finding. */
export const leadProactiveReport = (value: LeadProactive, evidenceAt: number, lastReadAt: number, readSucceeded: boolean): LeadProactive => {
  const report = parseLeadProactive(value)
  return readSucceeded && evidenceAt >= lastReadAt ? report : {
    ...report, finding: `Unverified report: ${report.finding}`,
    caveat: 'I could not verify this against the latest desk read.',
  }
}
export const parseLeadApprovalAudit: Validator<LeadApprovalAudit> = omitUnset(object({ ruleId: id, target: (value, path) => {
  const target = text(240)(value, path)
  return /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(target) ? fail(path ?? '', 'hidden audit target') : target
}, diff: optional(boundedText(LEAD_APPROVAL_DETAIL_CHARS, true, proseControls)) }), ['diff'])
const parseLeadCheckpointMarker: Validator<LeadCheckpointMarker> = (value, path = '') => {
  const source = isObject(value, path)
  if (Object.keys(source).some(key => key !== 'id' && key !== 'fallback')) return fail(path, 'unexpected checkpoint field')
  if (source.fallback !== undefined && source.fallback !== true) return fail(path, 'expected true')
  return { id: id(source.id, `${path}.id`), ...(source.fallback === true ? { fallback: true as const } : {}) }
}
export const parseLeadMessageRef: Validator<LeadMessageRef> = omitUnset(object<LeadMessageRef>({ kind: literalUnion(...LEAD_MESSAGE_REF_KINDS), id: opaque, title: optional(text(120)) }), ['title'])
/** The refs a reply carries, at most `LEAD_MESSAGE_REFS_MAX`, one per kind and id. */
export const parseLeadMessageRefs: Validator<readonly LeadMessageRef[]> = list(parseLeadMessageRef, LEAD_MESSAGE_REFS_MAX, 1, ref => `${ref.kind}:${ref.id}`)
const parseLeadMessageWake: Validator<LeadMessageWake> = object<LeadMessageWake>({ kind: literalUnion('reminder'), reminder: id, text: text(200) })
const leadMessageShape = omitUnset(object<LeadMessage>({ version, id, revision, source: optional(literalUnion('person', 'automatic', 'schedule')), proactive: optional(parseLeadProactive), ask: optional(parseLeadAsk), approval: optional(parseLeadApprovalAudit), role: literalUnion('user', 'assistant', 'system', 'notice'), text: content, checkpoint: optional(parseLeadCheckpointMarker), refs: optional(parseLeadMessageRefs), wake: optional(parseLeadMessageWake), reminded: optional(id) }), ['proactive', 'ask', 'approval', 'source', 'checkpoint', 'refs', 'wake', 'reminded'])
export const parseLeadMessage: Validator<LeadMessage> = (value, path = '') => {
  const message = leadMessageShape(value, path)
  if (message.approval !== undefined && message.role !== 'notice' || message.role === 'notice' && message.proactive) fail(path, 'invalid host notice')
  if (message.source !== undefined && message.role !== 'user') fail(path, 'source requires a user message')
  if (message.ask && (message.role !== 'assistant' || message.proactive)) fail(path, 'ask requires an ordinary assistant message')
  if (message.checkpoint && message.role !== 'notice') fail(path, 'a checkpoint marker is a host notice')
  if (message.refs && message.role !== 'assistant') fail(path, 'refs belong to a reply')
  if (message.wake && message.role !== 'user' && message.role !== 'system') fail(path, 'a wake is a desk turn')
  if (message.reminded !== undefined && (message.role !== 'assistant' || message.ask || message.proactive)) fail(path, 'a reminder line is a plain reply')
  return message
}
const cardPositions: Validator<Readonly<Record<string, number>>> = (value, path = '') => {
  const entries = Object.entries(isObject(value, path))
  if (entries.length > LEAD_LIMITS.cards) fail(path, 'too many card positions')
  return Object.fromEntries(entries.map(([key, value]) => [id(key, path), integer(1)(value, path)]))
}
export const parseLeadOrigin: Validator<LeadOrigin> = object({ source: literalUnion('pull-request', 'issue', 'schedule'), event: id, subject: opaque, url: nullable(content) })
const handbackParser: Validator<LeadHandback> = object({ key: id, event: id, kind: literalUnion('checks', 'reviews'), head: opaque,
  runId: id, teamId: id, round: integer(1), at: integer(), stage: literalUnion('prepared', 'running', 'awaiting-ci', 'completed', 'failed', 'abandoned', 'withdrawn'), publishedHead: nullable(opaque), detail: optional(boundedText(8000, false, proseControls)) })
export const parseLeadHandback: Validator<LeadHandback> = (value, path = '') => Object.fromEntries(Object.entries(handbackParser(value, path)).filter(([, item]) => item !== undefined)) as unknown as LeadHandback
export const parseLeadFollowPreferences: Validator<LeadFollowPreferences> = object({ checks: isBoolean, reviews: isBoolean })
const pullRequestParser: Validator<LeadPullRequest> = object({
  review: optional(nullable(object({ id: integer(1), head: opaque, state: literalUnion('commented', 'changes-requested', 'approved') }))),
  branchOwner: optional(literalUnion('lead', 'person')), branchChange: optional(literalUnion('fast-forward', 'rewrite')), releaseReason: optional(content),
  observedHead: optional(opaque),
  repository: (value, path = '') => typeof value === 'string' && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value) ? value : fail(path, 'expected repository'),
  number: integer(1), branch: opaque, head: (value, path = '') => typeof value === 'string' && /^[a-f0-9]{40,64}$/.test(value) ? value : fail(path, 'expected commit'),
  state: literalUnion('open', 'merged', 'closed'), at: integer(), check: nullable(object({ head: opaque, state: literalUnion('absent', 'pending', 'passed', 'failed'), total: integer() })),
})
export const parseLeadPullRequest: Validator<LeadPullRequest> = (value, path = '') => {
  const parsed = pullRequestParser(value, path)
  if (parsed.check && parsed.check.head !== (parsed.observedHead ?? parsed.head) || parsed.review && parsed.review.head !== (parsed.observedHead ?? parsed.head)) return fail(path, 'PR status is for another head')
  return Object.fromEntries(Object.entries(parsed).filter(([, item]) => item !== undefined)) as unknown as LeadPullRequest
}
const pastCardParser: Validator<LeadDecisionMessage> = object({ card: parseLeadCard, choice: optional(literalUnion('approve', 'accept', 'accept-open-pr', 'decline')), position: revision })
export const parseLeadDecisionMessage: Validator<LeadDecisionMessage> = (value, path = '') => {
  const parsed = pastCardParser(value, path)
  const informational = parsed.card.type === 'second-look' || parsed.card.type === 'allowance-warning'
  if ((parsed.choice === undefined) !== informational) return fail(path, 'only informational history omits a person choice')
  return parsed.choice === undefined ? { card: parsed.card, position: parsed.position } : parsed
}
const threadParser: Validator<LeadThread> = object({
  version, id, revision, state: literalUnion('draft', 'planning', 'awaiting-plan', 'running', 'waiting-for-user', 'following', 'accepted', 'declined', 'stopped'),
  // One current snapshot per card. Revisions belong to each card, so different cards may
  // share revision 1; the state machine must compare old/new revisions when replacing a card.
  project: nullable(project), olderMessages: integer(), cardPositions: optional(cardPositions), decisions: optional(list(parseLeadDecisionMessage, 64)),
  contract: optional(nullable(parseLeadAcceptanceContract)), budget: optional(nullable(parseLeadBudgetState)), pr: optional(nullable(parseLeadPullRequest)), origin: optional(nullable(parseLeadOrigin)), handback: optional(nullable(parseLeadHandback)),
  messages: list(parseLeadMessage, LEAD_LIMITS.messages, 0, message => message.id), cards: list(parseLeadCard, LEAD_LIMITS.cards, 0, card => card.id),
})
export const parseLeadThread: Validator<LeadThread> = (value, path = '') => {
  const parsed = threadParser(value, path)
  return Object.fromEntries(Object.entries(parsed).filter(([key, item]) => !['pr', 'origin', 'handback'].includes(key) || item !== undefined)) as unknown as LeadThread
}
/** Keep the largest newest suffix within the thread's UTF-8 JSON budget, without mutating
 * the source or dropping cards. Journal readers first hydrate at most LEAD_LIMITS.messages
 * newest messages, with olderMessages accounting for the rest. This helper adds byte-based
 * omissions. Reserve the control/event envelope's exact overhead from ipcBytes before calling,
 * then validate the completed frame. Oversized cards/metadata fail closed instead of vanishing. */
export const windowLeadThread = (value: unknown, maxBytes: number): LeadThread => {
  const limit = integer(1, LEAD_LIMITS.ipcBytes)(maxBytes, 'maxBytes')
  let thread = parseLeadThread(value)
  const bytesOf = (data: LeadThread | LeadMessage) => new TextEncoder().encode(JSON.stringify(data)).byteLength
  let bytes = bytesOf(thread)
  // Historical prose grants no authority. Older history gives way to live decisions
  // and messages before the message suffix needs to be shortened.
  while (bytes > limit && thread.decisions?.length) {
    thread = { ...thread, decisions: thread.decisions.slice(1) }
    bytes = bytesOf(thread)
  }
  let offset = 0
  let olderMessages = thread.olderMessages
  while (bytes > limit && offset < thread.messages.length) {
    const previousCount = olderMessages
    olderMessages = integer()(olderMessages + 1, 'olderMessages')
    // Removing an array entry removes its JSON plus one comma unless it was the last.
    bytes -= bytesOf(thread.messages[offset]!) + (thread.messages.length - offset > 1 ? 1 : 0)
    bytes += String(olderMessages).length - String(previousCount).length
    offset += 1
  }
  if (bytes > limit) return fail('', 'Lead cards and metadata exceed the thread byte budget')
  return { ...thread, olderMessages, messages: thread.messages.slice(offset) }
}
/** Migration decision: journal recovery calls this hook before projecting. Only v1 exists today.
 * A future version adds its own strict old-version reader and explicit data migration here;
 * it must never pass unknown fields through, infer an absent version, or replay effects. */
export const migrateLeadThread: Validator<LeadThread> = (value, path = '') => {
  const source = isObject(value, path)
  switch (source.version) {
    case 1: return parseLeadThread(value, path)
    default: return fail(path, 'unsupported Lead migration version')
  }
}
export const parseLeadSettingsProjection: Validator<LeadSettingsProjection> = omitUnset(object<LeadSettingsProjection>({
  unavailable: optional(literalUnion('runtime')), unavailableReason: optional(text(LEAD_LIMITS.unavailableReasonChars)),
  version, name: literalUnion('dex', 'lex'), nameChosen: optional(isBoolean), model: opaque, key: object({ configured: isBoolean, protection: literalUnion('encrypted', 'unavailable') }),
  policy: parseLeadPermissionPolicy, caps: parseLeadCaps, follow: (value, path) => value === undefined ? { checks: true, reviews: true } : parseLeadFollowPreferences(value, path),
  // Zero is only an older desk's closed allowance carried over; a person sets 1 or more.
  spendLimitUsdMicros: optionalNullable(micros),
}), ['nameChosen', 'unavailable', 'unavailableReason', 'spendLimitUsdMicros'])
export const parseLeadHostProjection: Validator<LeadHostProjection> = object({
  version, revision, thread: parseLeadThread, settings: parseLeadSettingsProjection,
})
type ControlOf<T extends LeadChildControl['type']> = Extract<LeadChildControl, { type: T }>
export const parseLeadChildControl: Validator<LeadChildControl> = ipc(tag<LeadChildControl>({
  initialize: object<ControlOf<'initialize'>>({ version, type: literalUnion('initialize'), thread: parseLeadThread, model: opaque, policy: parseLeadPermissionPolicy, budget: parseLeadBudgetState }),
  observe: object<ControlOf<'observe'>>({ version, type: literalUnion('observe'), projection: parseLeadHostProjection }),
  cancel: object<ControlOf<'cancel'>>({ version, type: literalUnion('cancel'), reason: stopReason }),
}))
type EventOf<T extends LeadChildEvent['type']> = Extract<LeadChildEvent, { type: T }>
export const parseLeadChildEvent: Validator<LeadChildEvent> = ipc(tag<LeadChildEvent>({
  ready: object<EventOf<'ready'>>({ version, type: literalUnion('ready') }),
  projection: object<EventOf<'projection'>>({ version, type: literalUnion('projection'), thread: parseLeadThread }),
  stopped: object<EventOf<'stopped'>>({ version, type: literalUnion('stopped'), reason: stopReason }),
}))
export const nextLeadRevision = (current: LeadRevision): LeadRevision => {
  const parsed = revision(current)
  return revision(parsed + 1)
}

export const parseLeadThreadSend: Validator<LeadThreadSend> = omitUnset(object<LeadThreadSend>({ idempotencyKey: id, text: prose, device: optional(parseLeadDeviceRef), ask: optional(id) }), ['device', 'ask'])
export const parseLeadResume: Validator<{ readonly expectedRevision: number }> = object({ expectedRevision: revision })
export const parseLeadSettingsUpdate: Validator<LeadSettingsUpdate> = object({
  follow: optional(parseLeadFollowPreferences), expectedRevision: revision, name: optional(literalUnion('dex', 'lex')), policy: optional(parseLeadPermissionPolicy), caps: optional(parseLeadCaps),
  credential: optional(object({ provider: (value, path = '') => value === 'anthropic' ? 'anthropic' : fail(path, 'expected Lead credential provider'), key: nullable(text(4096)) })),
})
export const parseLeadEmpty: Validator<Record<string, never>> = object({})
export const parseLeadNameReceipt: Validator<LeadNameReceipt> = object({ version, revision, settings: omitUnset(object<LeadNameReceipt['settings']>({ name: literalUnion('dex', 'lex'), nameChosen: optional(isBoolean) }), ['nameChosen']) })

const parseLeadProgress: Validator<LeadProgress> = (value, path = '') => {
  const parsed = object<LeadProgress>({ step: integer(1, LEAD_LIMITS.steps), steps: integer(1, LEAD_LIMITS.steps), runs: integer(), since: optional(integer(0, Number.MAX_SAFE_INTEGER)) })(value, path)
  return parsed.step <= parsed.steps ? parsed : fail(path, 'step beyond the plan')
}
export const parseLeadPresence: Validator<LeadPresence> = object({
  checked: integer(), quiet: integer(), lastCheckedAt: nullable(integer(0, Number.MAX_SAFE_INTEGER)),
  readings: list(object<LeadRunReading>({ runId: id, kind: literalUnion('advanced', 'stuck', 'plan-only', 'blocked', 'done'), quietMinutes: optional(integer()) }), 64, 0, reading => reading.runId),
})
const parseLeadSteer: Validator<LeadSteer> = object({ id, text: text(4000), at: integer(0, Number.MAX_SAFE_INTEGER), state: literalUnion('acknowledged', 'refused'), after: optional(integer(0, Number.MAX_SAFE_INTEGER)) })

const scheduledRun: Validator<LeadScheduledRun> = object({ slot: integer(), at: integer(), state: literalUnion('started', 'skipped', 'needs-approval'), reason: optional(text(400)), logicalGoalId: optional(id), outcome: optional(literalUnion('accepted', 'declined', 'stopped')), usdMicros: optional(micros), rounds: optional(integer(0, LEAD_LIMITS.rounds)) })
const approvedRepeat = object({ contract: parseLeadAcceptanceContract, contractDigest: digest })
const scheduledTask = object<LeadScheduledTask>({ project: optional(opaque), id, title: text(80), goal: text(2000), every: literalUnion('day', 'weekdays', 'mondays', 'fridays'),
  at: clockTime, enabled: isBoolean, lastRunAt: nullable(integer(0, Number.MAX_SAFE_INTEGER)), createdAt: optional(integer()), approved: optional(approvedRepeat), perRunCaps: optional(parseLeadCaps), paused: optional(isBoolean), runs: optional(list(scheduledRun, 12)) })
export const parseLeadScheduledTask: Validator<LeadScheduledTask> = (value, path = '') => {
  const parsed = scheduledTask(value, path)
  if (parsed.approved && (parsed.approved.contractDigest !== parsed.approved.contract.digest || !parsed.approved.contract.repeat || parsed.approved.contract.repeat.every !== parsed.every || parsed.approved.contract.repeat.at !== parsed.at || !parsed.perRunCaps || JSON.stringify(parsed.perRunCaps) !== JSON.stringify(parsed.approved.contract.caps))) fail(path, 'repeat approval does not match its contract')
  return Object.fromEntries(Object.entries(parsed).filter(([, item]) => item !== undefined)) as unknown as LeadScheduledTask
}
export const parseLeadRepeatControl: Validator<LeadRepeatControl> = object({ taskId: id, action: literalUnion('pause', 'resume', 'stop', 'run-now') })
export const parseLeadBudgetRaise: Validator<LeadBudgetRaise> = object({ logicalGoalId: id, caps: parseLeadCaps, expectedRevision: revision })
// The ceiling itself is how Off reads in caps, so a figure stops one short of it.
export const parseLeadSpendLimitSet: Validator<LeadSpendLimitSet> = object({ usdMicros: nullable(integer(1, LEAD_LIMITS.maxUsdMicros - 1)), expectedRevision: revision })
export const parseLeadSchedule: Validator<LeadSchedule> = object({ seedChoices: optional(list(opaque, 256, 0, key => key)), version, tasks: list(parseLeadScheduledTask, LEAD_SCHEDULE_LIMITS.tasks, 0, task => task.id),
  quiet: nullable(object<LeadQuietHours>({ from: clockTime, to: clockTime })) })
const parseLeadMemoryItem: Validator<LeadMemoryItem> = object({ id, text: text(400), state: literalUnion('kept', 'suggested'), at: integer(0, Number.MAX_SAFE_INTEGER) })
export const parseLeadMemory: Validator<LeadMemory> = object({ version, items: list(parseLeadMemoryItem, LEAD_SCHEDULE_LIMITS.memory, 0, item => item.id) })
export const parseLeadScheduleUpdate: Validator<{ readonly schedule: LeadSchedule }> = object({ schedule: parseLeadSchedule })
export const parseLeadMemoryUpdate: Validator<{ readonly memory: LeadMemory }> = object({ memory: parseLeadMemory })
export const parseLeadSteerInput: Validator<{ readonly text: string }> = object({ text: text(4000) })
const actionBase = { id, runId: id }
const parseLeadAction: Validator<LeadAction> = (value, path = '') => {
  const kind = (value as { kind?: unknown })?.kind
  return kind === 'worker-approval'
    ? object<Extract<LeadAction, { kind: 'worker-approval' }>>({ ...actionBase, kind: literalUnion('worker-approval'), role: text(80),
      request: text(240), details: optional(boundedText(LEAD_APPROVAL_DETAIL_CHARS, false, proseControls)), choices: list(literalUnion('yes-once', 'yes-goal', 'no'), 3) })(value, path)
    : object<Extract<LeadAction, { kind: 'check' }>>({ ...actionBase, kind: literalUnion('check'), name: text(40), command: boundedText(2000, false, proseControls) })(value, path)
}
export const parseLeadWindowProjection: Validator<LeadWindowProjection> = ipc(object({
  version, revision, stage: optional(literalUnion(...LEAD_STAGES)), stageReason: optional(text(80)), thread: parseLeadThread, settings: parseLeadSettingsProjection, requestInFlight: isBoolean, activity: optional(object({ since: integer(0, Number.MAX_SAFE_INTEGER), method: nullable(text(120)), step: optional(text(80)) })), wayOut: nullable(literalUnion('resume', 'decide-plan')),
  waitReason: nullable(literalUnion(...LEAD_MANAGEMENT_REASONS)), failure: optional(object<LeadRequestFailure>({ reason: literalUnion(...LEAD_REQUEST_FAILURES), detail: text(400) })), planConsentExpiresAt: nullable(integer(0, Number.MAX_SAFE_INTEGER)), progress: optional(parseLeadProgress), team: optional(id),
  savedApprovals: optional(list(object<LeadSavedApproval>({ id, target: text(240), count: integer(), uncertain: optional((value, path) => value === true ? true : fail(path ?? '', 'expected true')), entries: optional(parseLeadApprovalEntries) }), 128, 0, rule => rule.id)),
  revokedApprovals: optional(list(object<LeadSavedApproval>({ id, target: text(240), count: integer(), uncertain: optional((value, path) => value === true ? true : fail(path ?? '', 'expected true')), entries: optional(parseLeadApprovalEntries) }), 128, 0, rule => rule.id)),
  personActions: optional(list(parseLeadAction, 1024, 0, action => action.id)), presence: optional(parseLeadPresence),
  steers: optional(list(parseLeadSteer, 64, 0, steer => steer.id)),
}))

export const parseLeadActionInput: Validator<LeadActionInput> = object({ id, contractDigest: digest, choice: literalUnion('yes-once', 'yes-goal', 'no', 'run') })

const wakeTokens = integer(0, 1_000_000_000)
const parseLeadWakeTokens: Validator<LeadWakeTokens> = object({ input: wakeTokens, output: wakeTokens, cacheRead: wakeTokens, cacheWrite: wakeTokens })
export const parseLeadWakeRecord: Validator<LeadWakeRecord> = omitUnset(object<LeadWakeRecord>({ id, at: integer(0, Number.MAX_SAFE_INTEGER), source: literalUnion('schedule', 'desk-change', 'person', 'trigger'), decision: literalUnion('silent', 'spoke', 'asked', 'failed'), modelTurn: isBoolean, usdMicros: nullable(micros), tokens: optional(parseLeadWakeTokens), observed: optional(literalUnion(...LEAD_AUTONOMY_KINDS)) }), ['tokens', 'observed'])
export const parseLeadWakeLog: Validator<LeadWakeLog> = object({ revision: integer(), wakes: list(parseLeadWakeRecord, 128, 0, wake => wake.id) })

export const parseLeadApprovalRevoke: Validator<{ readonly id: string; readonly contractDigest: string }> = object({ id, contractDigest: digest })


/** Counts of unarchived ordinary chats (Team seats excluded) and Teams, across the desk. */
export interface LeadDeskCounts { readonly running: number; readonly needsYou: number; readonly idle: number }
export interface LeadDeskTotals { readonly chats: LeadDeskCounts; readonly teams: LeadDeskCounts }
/** Titles are untrusted data. Project is a display name, never a filesystem path. */
export interface LeadDeskItem {
  readonly id: string
  readonly title: string
  readonly project: string | null
  readonly state: 'running' | 'needs-you' | 'idle'
  readonly updatedAt: number
  readonly kind: 'chat' | 'team'
}
export interface LeadDeskSummary {
  /** Exact aggregate counts, independent of the bounded detail scan. */
  readonly totals: LeadDeskTotals
  /** Per-project counts cover only sessionsScanned when true; totals stay exact. */
  readonly countsPartial: boolean
  readonly sessionsScanned: number
  readonly projectsMore: number
  readonly projects: readonly (LeadDeskTotals & { readonly project: string | null })[]
  /** Newest first, default eight, at most twenty. */
  readonly recent: readonly LeadDeskItem[]
  /** Up to twenty working items, including those outside recent. */
  readonly running: readonly LeadDeskItem[]
  readonly runningMore: number
  /** Up to twenty attention items, including those outside recent. May overlap recent. */
  readonly needsYou: readonly LeadDeskItem[]
  readonly needsYouMore: number
  /** Items outside the recent window, including any also listed in needsYou. */
  readonly olderCount: number
}

/** Allowance only, projected field by field from cached Dashboard reports. No account identifiers. */
export interface LeadUsageWindow {
  readonly label: string
  readonly kind: '5h' | 'weekly' | 'monthly' | 'window' | 'allowance' | 'balance'
  readonly unlimited?: boolean
  readonly windowMinutes: number | null
  readonly remainingPercent: number | null
  readonly remaining: number | null
  readonly unit: string | null
  /** Absolute epoch milliseconds, never relative text. */
  readonly resetsAt: number | null
  readonly reached: boolean
  readonly projection: {
    readonly kind: 'runs-out' | 'lasts-to-reset'
    readonly at: number
    readonly basis: 'average consumption since window start'
    readonly since: number
    readonly asOf: number
  } | null
}
export interface LeadUsageSummary {
  /** Runtime running counts are lower bounds when the session scan is partial. */
  readonly countsPartial: boolean
  readonly sessionsScanned: number
  readonly asOf: number
  /** Counts by presentation name, including running agents with no cached allowance. */
  readonly runtimes: readonly { readonly name: string; readonly runningSessions: number }[]
  readonly accounts: readonly {
    readonly runtime: string
    /** Presentation name, plan, and ordinal when several accounts share a name. */
    readonly label: string
    readonly plan: string | null
    /** Desk-wide runtime count, a lower bound when countsPartial; repeated accounts share it. */
    readonly runningSessions: number
    readonly windows: readonly LeadUsageWindow[]
    readonly reached: boolean
    readonly fetchedAt: number
    readonly stale: boolean
    readonly error: 'sign-in needed' | 'reading failed' | null
    readonly spend: { readonly currency: string; readonly today: number | null; readonly last30Days: number | null; readonly provenance: import('./usage.js').SpendProvenance } | null
    /** Allowance that expires unspent: more than half is left and a window is about to refill. Absent otherwise. */
    readonly useFirst?: true
    /** Whole minutes between when these figures were read and `asOf`. */
    readonly readAgeMinutes: number
    /** The latest refresh failed; the windows are the last good figures, read `readAgeMinutes` ago. Absent otherwise. */
    readonly refreshFailed?: true
    /**
     * A tracked agent nothing has read: no windows, and no reading to date. Every surface lists it as "Not reporting";
     * it is never left out of a count. An account that answered with no window, balance or billing shape at all is
     * Not reporting too, as the Plans table and the phone say it ("plan usage unavailable"). Absent otherwise.
     */
    readonly notReporting?: true
    /**
     * Figures read through another sign-in (`UsageReport.unverified`): the desk cannot tie them to this agent's own
     * account, so they are never `windows`, but they are what the Dashboard draws for it. `whose` names the sign-in.
     * Absent when there are none.
     */
    readonly unverified?: {
      readonly whose: string
      readonly windows: readonly LeadUsageWindow[]
      readonly readAgeMinutes: number
      readonly stale: boolean
    }
  }[]
  /**
   * Which account to use first, from fresh readings only (`pacingAdvice`): `use-first` when a window refills soon with
   * more than half unspent, else `resets-soonest`, the account with room whose window refills first. Null when no
   * reading is fresh enough to decide.
   */
  readonly pacing: {
    /** The same label as the account's entry. */
    readonly account: string
    readonly reason: 'use-first' | 'resets-soonest'
    readonly window: string
    readonly remainingPercent: number
    /** Absolute epoch milliseconds. */
    readonly resetsAt: number
    /** The same time on the desk's own clock, as the person reads it ("Tue, Nov 17, 5:00 PM"). */
    readonly resetsAtLocal: string
    readonly readAgeMinutes: number
    /**
     * The advice as one plain sentence, to say as it stands. `use-first` is the note the Dashboard and the phone show;
     * `resets-soonest` is no note on any surface, only the order of the accounts with room, and the sentence says so.
     */
    readonly said?: string
  } | null
}

/** Where the Lead's earlier conversation was summarised. The notice carries only the marker; the summary is read by id. */
export interface LeadCheckpointMarker { readonly id: string; readonly fallback?: true }
/** Tokens a provider reported, summed over one wake's requests. The cached share of the prompt is cacheRead over all three inputs. */
export interface LeadWakeTokens { readonly input: number; readonly output: number; readonly cacheRead: number; readonly cacheWrite: number }
/** A checkpoint's sections, in order. The desk writes the first from the person's own messages; the model writes the
 * other five. A view draws the first from `LeadContextCheckpoint.person`, never from the text. */
export const LEAD_CHECKPOINT_SECTIONS = Object.freeze([
  'What the person wants',
  'Decisions made and why',
  'Work and where each piece stands',
  'Waiting on the person',
  'Facts learned',
  'Open questions / next step',
] as const)
/** The person's own words a checkpoint kept, as the desk took them from its journal: quoted with their references,
 * latest kept first when they do not all fit, and the references of those left out. */
export interface LeadCheckpointPerson {
  readonly messages: readonly { readonly id: string; readonly text: string }[]
  readonly leftOut: readonly string[]
}
export const LEAD_CHECKPOINT_PERSON = Object.freeze({ messages: 200, messageChars: 600, leftOut: 200 })
/** One summary of the earlier conversation. `text` is null once the desk no longer keeps it. Untrusted prose: sanitise to render. */
export interface LeadContextCheckpoint {
  readonly id: string; readonly at: number
  /** The model's summary was refused or failed three times; this one was built from the conversation itself. */
  readonly fallback: boolean
  readonly beforeTokens: number; readonly afterTokens: number
  /** The model's five sections, as plain text under their headings; never drawn as markup. A summary from before
   * `person` existed also holds the person's section here. */
  readonly text: string | null
  /** The person's section as data: a view draws it from this, so no model text can stand in for it. Absent on a
   * summary from before it existed, and once `text` is no longer kept. */
  readonly person?: LeadCheckpointPerson
}
/** How full the Lead's conversation is and how much of it the provider served from its cache. Facts, never a control. */
export interface LeadContextFacts {
  readonly version: 1
  /** The window the Lead's model is held to. */
  readonly windowTokens: number
  /** The prompt of the latest request, or null before the first. */
  readonly usedTokens: number | null
  /** Cache reads over prompt tokens across recent model wakes, 0 to 1; null before any wake reported tokens. */
  readonly cacheHitRate: number | null
  /** True while a summary is being written. */
  readonly compacting: boolean
  /** Oldest first, at most eight. */
  readonly checkpoints: readonly LeadContextCheckpoint[]
  /** Every summary the conversation has had, as the thread marks them; `checkpoints` keeps only the latest eight.
   * Absent from a desk that does not count them, where the list's length stands in. */
  readonly count?: number
  /** The latest compaction could not bring the conversation under the hard line, even keeping the fewest recent
   * turns: no compaction runs until it grows further. Absent otherwise. */
  readonly full?: true
}

/** How full the Lead's conversation is, as one figure: what the Lead reads about itself and what a phone shows. No
 * summary text, so it carries none of the conversation. */
export interface LeadContextUse {
  readonly version: 1
  readonly windowTokens: number
  /** The prompt of the latest request, or null before the first. */
  readonly usedTokens: number | null
  /** `usedTokens` as a whole percent of the window, or null before the first request. */
  readonly percent: number | null
  /** When the earlier conversation was last summarised, or null when it never was. */
  readonly lastSummaryAt: number | null
  readonly compacting: boolean
  readonly full?: true
}
export const leadContextUse = (facts: LeadContextFacts): LeadContextUse => ({
  version: 1, windowTokens: facts.windowTokens, usedTokens: facts.usedTokens,
  percent: facts.usedTokens === null || facts.windowTokens <= 0 ? null : Math.round(facts.usedTokens / facts.windowTokens * 100),
  lastSummaryAt: facts.checkpoints.reduce<number | null>((latest, one) => latest === null || one.at > latest ? one.at : latest, null),
  compacting: facts.compacting, ...(facts.full ? { full: true as const } : {}),
})
export const LEAD_CONTEXT_CHECKPOINT_CHARS = 32_768
const parseLeadCheckpointPerson: Validator<LeadCheckpointPerson> = object({
  messages: list(object({ id, text: boundedText(LEAD_CHECKPOINT_PERSON.messageChars, true, /[\u0000-\u001f\u007f-\u009f]/) }), LEAD_CHECKPOINT_PERSON.messages),
  leftOut: list(id, LEAD_CHECKPOINT_PERSON.leftOut) })
const parseLeadContextCheckpoint: Validator<LeadContextCheckpoint> = omitUnset(object({ id, at: integer(0, Number.MAX_SAFE_INTEGER), fallback: isBoolean,
  beforeTokens: wakeTokens, afterTokens: wakeTokens, text: nullable(boundedText(LEAD_CONTEXT_CHECKPOINT_CHARS, true, proseControls)),
  person: optional(parseLeadCheckpointPerson) }), ['person'])
export const parseLeadContextFacts: Validator<LeadContextFacts> = omitUnset(object({ version, windowTokens: integer(1, 100_000_000), usedTokens: nullable(wakeTokens),
  cacheHitRate: nullable((value, path = '') => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1 ? value : fail(path, 'expected a ratio')),
  compacting: isBoolean, checkpoints: list(parseLeadContextCheckpoint, 8, 0, checkpoint => checkpoint.id), count: optional(integer(0, Number.MAX_SAFE_INTEGER)),
  full: optional((value, path = '') => value === true ? true as const : fail(path, 'expected true')) }), ['full', 'count'])
/**
 * The question a Lead message puts to the person, wherever it carries it: an ordinary reply's `ask`, or the options of
 * a report it wrote on an automatic wake. Every surface draws both as the same buttons, so the desk tracks, answers,
 * expires and lists both as one question.
 */
export const leadMessageAsk = (message: { readonly ask?: LeadAsk; readonly proactive?: LeadProactive }): LeadAsk | undefined =>
  message.ask ?? (message.proactive?.options?.length && message.proactive.recommended
    ? { question: message.proactive.ask, options: message.proactive.options, recommended: message.proactive.recommended, ...(message.proactive.startsMarked ? { startsMarked: true as const } : {}) } : undefined)
