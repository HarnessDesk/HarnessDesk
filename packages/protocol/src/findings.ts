import type { Evidence, EvidenceRecord } from './evidence.js'

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
