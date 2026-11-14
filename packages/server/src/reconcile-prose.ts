import { isDeepStrictEqual } from 'node:util'
import { preserveDeskContext, type AgentItem, type Session, type Turn } from '@harnessdesk/protocol'

/** Canonical JSON retains array order and ignores object property order. */
const canonical = (value: unknown): string => JSON.stringify(value, (_key, entry: unknown) => {
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return entry
  return Object.fromEntries(Object.entries(entry).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0))
})

/** An exact, unique correspondence is needed before moving host-only rows. */
export type ProseReplay = { readonly kind: 'ordinary' } | { readonly kind: 'ambiguous' } | { readonly kind: 'reconciled'; readonly session: Session }

export function reconcileProseReplay(read: Session, held: Pick<Session, 'turns'>): ProseReplay {
  if (!read.itemsLoaded || read.partialHistory || !read.turns.length || !held.turns.length) return { kind: 'ordinary' }
  // Runtime replay may peel desk context from an otherwise identical person
  // message. Restore that provenance before comparing its actual content.
  const flattened = read.turns.flatMap(turn => turn.items)
  const restored = preserveDeskContext(flattened, held.turns.flatMap(turn => turn.items))
  let offset = 0
  const normalizedTurns = read.turns.map(turn => {
    const items = restored.slice(offset, offset + turn.items.length); offset += turn.items.length
    return { ...turn, items }
  })
  read = { ...read, turns: normalizedTurns }
  const users = (turn: Turn) => turn.items.filter((item): item is Extract<AgentItem, { type: 'userMessage' }> => item.type === 'userMessage' && item.content.length > 0)
  const heldById = new Map(held.turns.map(turn => [String(turn.id), turn]))
  // Counter reuse is relevant only when both turns name a person message.
  const conflict = read.turns.some(turn => {
    const prior = heldById.get(String(turn.id)); if (!prior) return false
    const a = users(turn), b = users(prior)
    return a.length > 0 && b.length > 0 && !isDeepStrictEqual(a.map(item => [item.id, item.content]), b.map(item => [item.id, item.content]))
  })
  // Replays may also replace every turn id. A matching person message on a
  // different counter is evidence of possible resegmentation, not a match by
  // text: the exact, unique whole-history check below still has to succeed.
  const homes = new Map<string, { turn: Turn['id']; item: AgentItem['id']; multiple: boolean }>()
  const identities = new Map<string, string | null>()
  for (const turn of held.turns) for (const item of users(turn)) {
    const k = canonical(item.content), prior = homes.get(k)
    homes.set(k, prior ? { ...prior, multiple: true } : { turn: turn.id, item: item.id, multiple: false })
    const identity = canonical([turn.id, item.id])
    identities.set(identity, identities.has(identity) ? null : k)
  }
  const moved = read.turns.some(turn => users(turn).some(item => {
    const k = canonical(item.content)
    // A repeated sentence is harmless when its exact turn and item identity
    // still carries the same content. A changed identity needs more proof.
    if (identities.get(canonical([turn.id, item.id])) === k) return false
    const prior = homes.get(k)
    return !!prior && (prior.multiple || prior.turn !== turn.id || prior.item !== item.id)
  }))
  if (!conflict && !moved) return { kind: 'ordinary' }
  const key = (item: AgentItem): string | null => {
    if (item.type === 'userMessage' || item.type === 'assistantMessage') {
      const { id: _id, startedAt: _start, completedAt: _end, durationMs: _duration, ...body } = item
      return canonical(body)
    }
    return null
  }
  const oldItems = held.turns.flatMap(turn => turn.items), newItems = read.turns.flatMap(turn => turn.items)
  const oldProse = oldItems.flatMap(item => { const value = key(item); return value === null ? [] : [value] })
  const newProse = newItems.flatMap(item => { const value = key(item); return value === null ? [] : [value] })
  const userKeys = oldItems.flatMap(item => item.type === 'userMessage' ? [key(item)!] : [])
  if (!oldProse.length || !isDeepStrictEqual(oldProse, newProse) || new Set(userKeys).size !== userKeys.length) return { kind: 'ambiguous' }
  // A repeated answer in one exchange cannot prove which occurrence owns a
  // saved-only row. Equal answers under distinct unique prompts are safe.
  let seen = new Set<string>(), duplicate = false, savedOnly = false
  for (const item of [...oldItems, { type: 'userMessage' } as AgentItem]) {
    if (item.type === 'userMessage') {
      if (duplicate && savedOnly) return { kind: 'ambiguous' }
      seen = new Set(); duplicate = false; savedOnly = false
    } else {
      const k = key(item)
      if (k === null) savedOnly = true
      else if (seen.has(k)) duplicate = true
      else seen.add(k)
    }
  }
  // Preserve the host-observed grouping and all its timings and host-owned
  // rows, but only when the replay proves the exact same unique prompt order.
  // Other saved work or new replay items need the protected conflict path.
  if (oldItems.some(item => key(item) === null && item.type !== 'notice' && item.type !== 'publication' && item.type !== 'carryOn')) return { kind: 'ambiguous' }
  if (newItems.some(item => key(item) === null)) return { kind: 'ambiguous' }
  return { kind: 'reconciled', session: { ...read, turns: held.turns } }
}
