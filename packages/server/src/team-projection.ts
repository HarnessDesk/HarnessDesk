import type { Intent } from '@harnessdesk/protocol'

/**
 * A Goal's cards, as the Team engine's snapshot and the Goal's own document
 * agree on them.
 *
 * A Goal board has two writers. The Team engine keeps it in memory and saves
 * it whole, after whatever holds the Goal's queue; the Goal plane writes a
 * claim or a release straight to the document, then installs the document back
 * into the Team. A snapshot saved as it was taken could therefore carry an
 * older copy of a card the Goal plane wrote in between — a claim, taken back
 * to open with nobody holding it, or a completion undone.
 *
 * So a snapshot speaks only for the cards the Team itself changed and has not
 * yet seen saved (`changed`): each of those is written as the Team has it —
 * or dropped, when the Team no longer has it at all (trimmed) — and every
 * other card stays as the document has it. A card only the snapshot has is
 * kept: nothing else ever removes one. With no `changed` the snapshot is the
 * whole board, as a standalone room's always was.
 */
export function mergeProjectedIntents(
  stored: readonly Intent[],
  snapshot: readonly Intent[],
  changed: ReadonlySet<number> | undefined,
): Intent[] {
  if (changed === undefined) return [...snapshot]
  const mine = new Map(snapshot.map((intent) => [intent.id, intent]))
  const out = new Map<number, Intent>()
  for (const intent of stored) {
    if (!changed.has(intent.id)) out.set(intent.id, intent)
    else if (mine.has(intent.id)) out.set(intent.id, mine.get(intent.id)!)
  }
  // What is left is a card the document does not have yet.
  for (const intent of snapshot) if (!out.has(intent.id)) out.set(intent.id, intent)
  return [...out.values()].sort((a, b) => a.id - b.id)
}
