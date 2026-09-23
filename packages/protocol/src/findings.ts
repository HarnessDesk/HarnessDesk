import type { Evidence, EvidenceRecord, SeatRecord } from './evidence.js'
import type { FlowBudget } from './flow-policy.js'

/**
 * The findings ledger's nouns.
 *
 * A finding is not a document of its own. It is a sequence of evidence
 * records — one `raise`, then any later repair claims, verdicts, carries and
 * postings — each an `EvidenceRecord` whose fact is the existing `finding`
 * arm and whose `finding` field says which event of which finding it is. The
 * ledger is what those records fold to (`packages/server/src/findings/model.ts`),
 * never a second store beside them.
 *
 * Every type here is durable in the way `evidence.ts` is: a record written
 * today is read by every later build, so a field is added nullable and never
 * removed.
 */

/** A host-minted finding identity: `finding-<uuid>`. The fact's `id`, the same on every event. */
export type FindingId = string

/** What the raiser claimed the finding is. A claim, never a host-certified category. */
export type FindingCategory = 'ordinary' | 'regression' | 'security'

/** Who raised a finding, where and at what — repeated exactly on every later event. */
export interface FindingOrigin {
  /** The Goal it was raised on. */
  readonly goal: string
  /** The flow run whose review raised it. */
  readonly run: string
  /** That run's round. */
  readonly round: number
  /** The card the reviewer held. */
  readonly card: number
  /** The raising Seat's id. Empty only on a bare fact that recorded no details. */
  readonly seat: string
  /** The host-observed revision it was raised against: a full commit id. */
  readonly at: string
}

/** A line in a changed file a finding is about, validated when it is raised. */
export interface FindingAnchor {
  /** Repository-relative, forward slashes, no `.`/`..` component. */
  readonly path: string
  readonly line: number
  readonly side: 'LEFT' | 'RIGHT'
}

/** Where one publication of a finding landed on a forge. */
export interface FindingPost {
  readonly repo: string
  readonly pr: number
  readonly comment: number
  readonly kind: 'review-comment' | 'issue-comment'
  readonly url: string
  /** The publication operation that sent it. */
  readonly operation: string
}

/** One event in a finding's life. Only `repair` and `verdict` change its lifecycle. */
export type FindingEvent =
  | {
      readonly kind: 'raise'
      readonly title: string
      readonly body: string
      readonly category: FindingCategory
      readonly blocking: boolean
      readonly related: FindingId | null
      readonly anchor: FindingAnchor | null
    }
  | { readonly kind: 'repair'; readonly note: string }
  | {
      readonly kind: 'verdict'
      readonly state: 'open' | 'repaired' | 'withdrawn'
      readonly note: string
      readonly by: 'seat' | 'person'
    }
  | { readonly kind: 'carry'; readonly from: string; readonly receipt: string; readonly to: string }
  | { readonly kind: 'post'; readonly location: FindingPost }

/** The metadata an evidence record carries when it is one event of a finding. */
export interface FindingDetail {
  readonly version: 1
  /** 1 for the raise, then one more for each later event of the same finding. */
  readonly sequence: number
  /** The operation that wrote it: a retry of the same operation finds this record rather than writing another. */
  readonly operation: string
  readonly origin: FindingOrigin
  readonly event: FindingEvent
}

/** An evidence record that is one event of a finding. */
export type FindingRecord = EvidenceRecord & {
  readonly fact: Extract<Evidence, { kind: 'finding' }>
  readonly finding: FindingDetail
}

/** Where a finding stands. `repaired` without `confirmed` is only a claim that it was repaired. */
export interface FindingState {
  readonly state: 'open' | 'repaired' | 'withdrawn'
  /** True once a reviewer (or a person) confirmed a repair or a withdrawal. A confirmed finding never reopens. */
  readonly confirmed: boolean
  /** Each distinct revision a repair was claimed at, in order. */
  readonly repairs: readonly string[]
}

/** One finding as the ledger folds it. */
export interface FindingView {
  readonly id: FindingId
  readonly origin: FindingOrigin
  /** The Goal that owns its lifecycle now: its origin's, until a person carries it. */
  readonly ownerGoal: string
  readonly title: string
  readonly body: string
  readonly category: FindingCategory
  readonly blocking: boolean
  readonly related: FindingId | null
  readonly anchor: FindingAnchor | null
  readonly lifecycle: FindingState
  /** The last event's sequence. */
  readonly sequence: number
  /** Every event's evidence record id, in order. */
  readonly evidence: readonly string[]
  readonly posted: readonly FindingPost[]
  /** True when any of its events came from a backup: history, never live clearance. */
  readonly restored: boolean
  /** Why this finding cannot be trusted as it stands — a damaged sequence, missing details — or null. */
  readonly problem: string | null
}

/** A person's override of unresolved findings: recorded, never a verdict. */
export interface FindingOverride {
  readonly by: 'person'
  readonly run: string
  readonly round: number
  /** The exact revision the override was for. */
  readonly at: string
  readonly findings: readonly FindingId[]
  readonly reason: string
  readonly decidedAt: number
}

/** A wrap's frozen projection of its findings: fixed event ids and the views they folded to. */
export interface FindingReceipt {
  readonly version: 1
  readonly evidence: readonly string[]
  readonly findings: readonly FindingView[]
  readonly overrides: readonly FindingOverride[]
}

// -------------------------------------------------------------------- reads

/**
 * One page of a Goal's findings, as a person reads them: rows in initial
 * raise order, stable across reloads and preserved by a filter. `stamp` names
 * the read snapshot the page came from, not a finding's own revision.
 */
export interface FindingPage {
  readonly goal: string
  readonly stamp: string
  readonly rows: readonly FindingView[]
  readonly next: string | null
  /** Over the whole ledger, not only this page. Null — never a reassuring zero — when it could not be read whole. */
  readonly totals: { readonly all: number; readonly open: number; readonly blocking: number } | null
  readonly problem: string | null
}

/** One finding's full history, as a person reads it: the immutable claim, then its later events in order. */
export interface FindingDetailPage {
  readonly finding: FindingView
  readonly records: readonly FindingRecord[]
  /** The raising Seat's own record, by its permanent id — never the latest Seat of a reused session. */
  readonly seat: SeatRecord | null
  readonly next: string | null
  readonly problem: string | null
}

// ----------------------------------------------------------------- commands

/*
 * What a Seat's finding tools take. None of them names a Seat, an Agent, an
 * origin, a revision, a checkout, a posting or a permission: the host resolves
 * every one of those from the calling conversation, the card it holds and the
 * candidate it was offered. `request` is the caller's own idempotency token —
 * the same request retried is the same event, never a second one.
 */

/** Raise a finding against a candidate `review_candidates` offered this card. */
export interface RaiseFindingInput {
  readonly intent: number
  readonly candidate: string
  readonly request: string
  readonly title: string
  readonly body: string
  readonly category: FindingCategory
  readonly blocking: boolean
  readonly related?: FindingId
  readonly anchor?: FindingAnchor
}

/** Claim a finding repaired at the caller's committed head. `expected` is the sequence the caller last read. */
export interface RepairFindingInput {
  readonly intent: number
  readonly finding: FindingId
  readonly request: string
  readonly expected: number
  readonly note: string
}

/** The raising Agent's verdict on its own finding, from a later review card. */
export interface DecideFindingInput {
  readonly intent: number
  readonly candidate: string
  readonly finding: FindingId
  readonly request: string
  readonly expected: number
  readonly state: 'open' | 'repaired' | 'withdrawn'
  readonly note: string
}

/** A person carrying unresolved findings from a wrapped receipt into an open Goal of the same project. */
export interface CarryFindingsInput {
  /** The Goal the findings are carried into. */
  readonly goal: string
  /** That Goal's revision as the person saw it. */
  readonly revision: number
  /** The wrapped Goal they come from. */
  readonly source: string
  /** Its receipt. */
  readonly receipt: string
  readonly findings: readonly FindingId[]
  readonly request: string
}

/** What a Seat may read of its own Goal's findings. */
export interface FindingReadInput {
  readonly intent: number
  readonly filter?: 'all' | 'open' | 'blocking'
}

// ------------------------------------------------------------------- rounds

/**
 * One review series of a run: the reviews of one subject checkout by one
 * role. Its initial blocking set is frozen when its first review round
 * closes; later ordinary claims are advisory, and a later regression or
 * security claim waits for a person as a pending exception.
 */
export interface FindingSeries {
  /** `<role>@<cwd>`: stable across rounds, never a Seat id. */
  readonly id: string
  readonly role: string
  readonly checkout: { readonly cwd: string; readonly branch: string | null }
  /** The subject revision its last closed review judged: the start of the next repair delta. */
  readonly reviewedAt: string | null
  readonly reviewRounds: readonly number[]
  /** Blocking findings admitted when the first review closed. Never grows. */
  readonly initial: readonly FindingId[]
  /** Later regression or security findings a person admitted. */
  readonly exceptions: readonly FindingId[]
  /** Later regression or security findings waiting for a person. */
  readonly pending: readonly FindingId[]
}

/** A run's findings bookkeeping, frozen at start for a new-format run; absent on runs saved before it. */
export interface FindingRunState {
  readonly version: 1
  readonly budget: FlowBudget
  /** Every closed round, counted once. */
  readonly closedRounds: readonly number[]
  /** Consecutive closed rounds that brought no new evidence. */
  readonly idleRounds: number
  /** Every progress key this run has seen, so repeated evidence never counts twice. */
  readonly progress: readonly string[]
  readonly series: readonly FindingSeries[]
  /** Why the run stopped for a person, and after which round; null while it may go on. */
  readonly stopped: { readonly round: number; readonly reason: string } | null
  /** One more round a person authorized after a stop. */
  readonly extraRound: { readonly after: number; readonly reason: string } | null
  readonly overrides: readonly FindingOverride[]
  /**
   * The last `finding/decide` this run actually applied: its one-use stamp,
   * and a hash of the action and reason it carried. A resubmission of that
   * same stamp replays this decision's outcome rather than re-running it —
   * necessary because applying a decision is what moves the stamp, so a lost
   * answer's retry would otherwise always read as conflicting. A resubmission
   * naming a different action or reason under that same stamp is refused.
   */
  readonly lastDecision: { readonly stamp: string; readonly key: string } | null
}

/** What a later review round is handed: the repair delta, and only the findings still in question. */
export interface RepairPacket {
  readonly run: string
  readonly round: number
  readonly series: string
  /** The subject revision the last closed review judged. */
  readonly from: string
  /** The subject's committed head now, pinned before the reviewer is seated. */
  readonly to: string
  /** The exact two-tip diff, whole — refused rather than cut short. */
  readonly diff: string
  readonly findings: readonly FindingView[]
  /** Findings whose repair was claimed since the last review. */
  readonly claimed: readonly FindingId[]
  /** Findings still unresolved. */
  readonly unresolved: readonly FindingId[]
  /** Evidence ids the review must also honour: requirement revisions, checks, CI. */
  readonly evidence: readonly string[]
  /** Set when history was rewritten between the two tips: the delta is two trees, not a descendant range. */
  readonly warning: string | null
}

/**
 * A person's bounded decision on a stopped or stoppable run. Only `adjudicate`
 * changes a finding's lifecycle; the rest change the run's own bookkeeping or
 * hand off to an existing action (merge, drop) that this never performs
 * itself.
 */
export type FindingDecisionAction =
  | { readonly kind: 'another-round' }
  | { readonly kind: 'merge-anyway' }
  | { readonly kind: 'drop' }
  | { readonly kind: 'admit-exceptions'; readonly findings: readonly FindingId[] }
  | { readonly kind: 'decline-exceptions'; readonly findings: readonly FindingId[] }
  | {
      readonly kind: 'adjudicate'
      readonly finding: FindingId
      readonly state: 'open' | 'repaired' | 'withdrawn'
    }

/** A run's findings as a person reads them. */
export interface FindingRunView {
  readonly run: string
  readonly goal: string
  readonly round: number
  readonly finished: number
  readonly total: number
  readonly embargoed: boolean
  readonly open: number
  readonly blocking: number
  readonly reason: string | null
  readonly stamp: string
  readonly publication: 'local' | 'pending' | 'posted' | 'partial' | 'uncertain'
  /**
   * How many of the current round's review cards hold a durable completed
   * card — never a token stream ending — and how many the round opened.
   * Null outside a review round. A crashed or timed-out reviewer is not
   * counted finished: this never rounds up to claim every reviewer answered.
   */
  readonly reviewersFinished: number | null
  readonly reviewersTotal: number | null
}
