import type { FindingView } from '@harnessdesk/protocol'

/** A word from an Agent's file — its id, a verdict — as a person reads it: `request-changes` → "Request changes". */
export const wordOf = (word: string): string => {
  const spaced = word.replace(/[-_]+/g, ' ')
  return spaced.charAt(0).toUpperCase() + spaced.slice(1)
}

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

