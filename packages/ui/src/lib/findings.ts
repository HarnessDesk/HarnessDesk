import type { BoardEvidence, FindingPost, FindingView, FlowExecution } from '@harnessdesk/protocol'

/**
 * Words and state for the findings ledger, kept beside the components that
 * draw it rather than invented per screen. Nothing here reads the host; it
 * turns the shapes `finding/list` and `finding/read` answer into the design
 * system's own vocabulary — a `Chip` tone, a sentence, never a raw wire word.
 */

export type FindingFilter = 'all' | 'open' | 'blocking'

/** Only accepted route evidence changes which attempts read Not kept; routine Run updates do not. */
export const acceptedFindingEvidence = (run: FlowExecution | undefined): string =>
  JSON.stringify((run?.rounds ?? []).filter(one => one.evidence.length > 0).map(one => [one.n, one.evidence]))

export const FILTER_LABEL: Readonly<Record<FindingFilter, string>> = {
  all: 'All',
  open: 'Open',
  blocking: 'Blocking',
}

/** One Goal's cached findings list: a filter, its rows, and where the read stands. */
export interface FindingsListState {
  readonly filter: FindingFilter
  readonly rows: readonly FindingView[]
  readonly next: string | null
  readonly totals: { readonly all: number; readonly open: number; readonly blocking: number } | null
  readonly problem: string | null
  readonly loading: boolean
  readonly loadingMore: boolean
  readonly error: string | null
  /** The rows shown are from before a failed reload — still worth reading, with a banner saying so. */
  readonly stale: boolean
}

export const emptyFindingsState = (filter: FindingFilter = 'all'): FindingsListState => ({
  filter, rows: [], next: null, totals: null, problem: null, loading: false, loadingMore: false, error: null, stale: false,
})

export type LifecycleTone = 'neutral' | 'warning' | 'success' | 'danger'

export { lifecycleWords } from '@harnessdesk/client/views'

/** `stateTone`-shaped: reuse the existing open/known tones, but a finding's own words for what is finding-specific. */
export const lifecycleTone = (view: FindingView): LifecycleTone => {
  if (view.problem !== null) return 'danger'
  const { state, confirmed } = view.lifecycle
  // A plain "Open" finding is the normal, default state a freshly raised
  // finding starts in — never a warning ink, which is for a claim genuinely
  // waiting on a person's review below.
  if (state === 'open') return 'neutral'
  if (!confirmed) return 'warning'
  return state === 'withdrawn' ? 'neutral' : 'success'
}

/**
 * `FindingView.blocking` is initial eligibility — the row's own claim, not
 * whether the ledger currently admits it. A `finding/list` row carries the
 * live answer as `activeBlocking` (a carried finding starts outside the
 * admitted set until its own first round closes, though `blocking` still
 * reads true); this reads that when present, so a row never disagrees with
 * the same page's own totals. Elsewhere — `finding/read`, a frozen receipt —
 * an accepted selection may instead explain why an attempt was not kept;
 * other rows carry the raw claim.
 */
export const blockingWords = (view: FindingView): 'Blocking' | 'Advisory' | 'Not kept' =>
  view.inactiveReason ? 'Not kept' : ((view.activeBlocking ?? view.blocking) ? 'Blocking' : 'Advisory')

/** Where one posting actually landed, in the reader's own words — never a raw wire kind. */
export const postWords = (post: FindingPost): string => (post.kind === 'review-comment' ? 'Review thread' : 'PR comment')

/** A finding's compact, selectable label: the literal id, never abbreviated into something unfindable by search. */
export const findingLabel = (id: string): string => id

/**
 * Whether this Goal's already-read board evidence shows an open, host-observed
 * pull request — the same fresh `pr` fact the host's own publication gate
 * reads. A Goal whose evidence has not been read here yet reads as none: the
 * publication Switch stays hidden rather than guessing, and the "Local
 * findings" note explains why until the Board pane has been opened once.
 */
export const goalHasBoundPr = (evidence: BoardEvidence | undefined): boolean =>
  (evidence?.cards ?? []).some((card) => card.facts.some((view) =>
    !view.record.restored && view.record.fact.kind === 'pr' && view.record.fact.state === 'open'))
