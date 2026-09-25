import type { BoardEvidence, FindingPost, FindingView } from '@harnessdesk/protocol'

/**
 * Words and state for the findings ledger, kept beside the components that
 * draw it rather than invented per screen. Nothing here reads the host; it
 * turns the shapes `finding/list` and `finding/read` answer into the design
 * system's own vocabulary — a `Chip` tone, a sentence, never a raw wire word.
 */

export type FindingFilter = 'all' | 'open' | 'blocking'

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

/**
 * The word a row's state carries. A repair is a claim until a reviewer (or a
 * person) confirms it — never "Verified" — and a damaged history is never
 * shown as if it were clean, whatever its recorded state says.
 */
export const lifecycleWords = (view: FindingView): string => {
  if (view.problem !== null) return 'Unreadable'
  const { state, confirmed } = view.lifecycle
  if (state === 'open') return 'Open'
  if (state === 'withdrawn') return confirmed ? 'Withdrawn' : 'Withdrawal claimed · awaiting review'
  return confirmed ? 'Repair accepted by reviewer' : 'Repair claimed · awaiting review'
}

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
 * no admitted set applies, and the raw claim is what there is to show.
 */
export const blockingWords = (view: FindingView): 'Blocking' | 'Advisory' =>
  ((view.activeBlocking ?? view.blocking) ? 'Blocking' : 'Advisory')

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
