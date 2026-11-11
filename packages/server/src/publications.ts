import type { AgentItem, CarryOnItem, PublicationItem } from '@harnessdesk/protocol'

/**
 * Publication items are the host's own: a runtime's account of a turn has
 * never heard of them, whether that account arrives as `turn/completed` at
 * the end of the turn or as a `session/read` days later. Wherever the
 * runtime's list replaces the host's, the publications are put back where
 * they were — at the index they had, so a row that stood between two of the
 * agent's steps does not jump to the end of the turn.
 *
 * A carry-on marker is the host's in exactly the same way — the agent never
 * heard that its conversation moved — and is kept by the same rule.
 */

/** An item the host wrote into a turn and the runtime has never heard of. */
export type HostItem = PublicationItem | CarryOnItem
export const isHostItem = (item: AgentItem): item is HostItem => item.type === 'publication' || item.type === 'carryOn'

export interface PlacedPublication {
  readonly item: HostItem
  readonly index: number
}

/** The publications in a list of items, with where each stood. */
export const publicationsIn = (items: readonly AgentItem[]): readonly PlacedPublication[] =>
  items.flatMap((item, index) => (isHostItem(item) ? [{ item, index }] : []))

/** The items with every publication not already among them put back at its place. */
export const withPublications = (
  items: readonly AgentItem[],
  publications: readonly PlacedPublication[],
): readonly AgentItem[] => {
  const out = [...items]
  for (const { item, index } of publications) {
    if (out.some((entry) => entry.id === item.id)) continue
    out.splice(Math.min(index, out.length), 0, item)
  }
  return out
}
