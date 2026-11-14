import { isDeepStrictEqual } from 'node:util'
import { preserveDeskContext, type AgentItem, type Session, type Turn } from '@harnessdesk/protocol'

/** Canonical JSON retains array order and ignores object property order. */
const canonical = (value: unknown): string => JSON.stringify(value, (_key, entry: unknown) => {
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return entry
  return Object.fromEntries(Object.entries(entry).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0))
})

/** An exact, unique correspondence is needed before moving host-only rows. */
export type ProseReplay = { readonly kind: 'ordinary'; readonly advanced?: boolean } | { readonly kind: 'ambiguous' } | { readonly kind: 'reconciled'; readonly session: Session; readonly replaceTurns?: boolean; readonly advanced?: boolean }

/** A running turn may grow, but an existing person item cannot change identity or content. */
export function conflictsWithRunningPrompt(read: Session, held: Pick<Session, 'turns'>, running: ReadonlySet<Turn['id']>): boolean {
  if (!read.itemsLoaded) return false
  const active = new Map(held.turns.filter(turn => running.has(turn.id)).map(turn => [turn.id, turn]))
  return read.turns.some(turn => {
    const previous = active.get(turn.id)
    if (!previous) return false
    const people = new Map(previous.items.flatMap(item => item.type === 'userMessage' ? [[item.id, item] as const] : []))
    const normalized = preserveDeskContext(turn.items, previous.items)
    return normalized.some(item => {
      const person = people.get(item.id)
      return !!person && (item.type !== 'userMessage' || !isDeepStrictEqual(item.content, person.content))
    })
  })
}

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
  // A prior fold may already have restored host-only rows into the source
  // segmentation. Recognize only the exact row at its proven prose boundary;
  // otherwise a second fold would quarantine our own reconciled output.
  const hostRows = new Map<string, { item: AgentItem; position: number }>()
  let position = 0
  for (const turn of held.turns) for (const item of turn.items) {
    if (item.type === 'userMessage' || item.type === 'assistantMessage') position++
    else if (item.type === 'notice' || item.type === 'publication' || item.type === 'carryOn') hostRows.set(String(item.id), { item, position })
  }
  const encountered = new Set<string>()
  let readPosition = 0, invalidHostRow = false
  const withoutHostRows = read.turns.map(turn => ({ ...turn, items: turn.items.filter(item => {
    const row = hostRows.get(String(item.id))
    if (row) {
      if (!encountered.has(String(item.id)) && row.position === readPosition && isDeepStrictEqual(row.item, item)) {
        encountered.add(String(item.id))
        return false
      }
      invalidHostRow = true
    }
    if (item.type === 'userMessage' || item.type === 'assistantMessage') readPosition++
    return true
  }) }))
  if (encountered.size) read = { ...read, turns: withoutHostRows }
  // Stable identities and exact existing content prove an append without
  // changing the ordinary merge or requiring unique prompt text. Ignore only
  // the host-owned rows the runtime is not expected to replay.
  if (!invalidHostRow && read.turns.length === held.turns.length) {
    const ids = new Set<string>(), turnIds = new Set<string>()
    let stable = true, advanced = false
    for (let i = 0; i < held.turns.length && stable; i++) {
      const old = held.turns[i]!, fresh = read.turns[i]!
      if (old.id !== fresh.id || turnIds.has(String(old.id))) { stable = false; break }
      turnIds.add(String(old.id))
      const oldItems = old.items.filter(item => item.type !== 'notice' && item.type !== 'publication' && item.type !== 'carryOn')
      const last = i === held.turns.length - 1
      if (fresh.items.length < oldItems.length || (!last && fresh.items.length !== oldItems.length)) { stable = false; break }
      for (let j = 0; j < oldItems.length; j++) {
        const item = oldItems[j]!, id = String(item.id)
        if (ids.has(id) || !isDeepStrictEqual(item, fresh.items[j])) { stable = false; break }
        ids.add(id)
      }
      if (!stable) break
      for (const item of fresh.items.slice(oldItems.length)) {
        const id = String(item.id)
        if (ids.has(id) || hostRows.has(id)) { stable = false; break }
        ids.add(id); advanced = true
      }
    }
    if (stable && advanced) return { kind: 'ordinary', advanced: true }
  }
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
  if (invalidHostRow) return { kind: 'ambiguous' }
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
  if (!oldProse.length || newProse.length < oldProse.length || !isDeepStrictEqual(oldProse, newProse.slice(0, oldProse.length)) || new Set(userKeys).size !== userKeys.length) return { kind: 'ambiguous' }
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
  // The source may put newer work in the last matched turn. In that case
  // retain its entire segmentation rather than assigning its facts to a
  // guessed split.
  let count = 0, boundary = -1, interior = false
  for (let i = 0; i < read.turns.length; i++) {
    const next = count + read.turns[i]!.items.length
    if (next >= oldProse.length) { boundary = i + 1; interior = next > oldProse.length; break }
    count = next
  }
  if (boundary < 0) return { kind: 'ambiguous' }
  const prefix = read.turns.slice(0, boundary), tail = read.turns.slice(boundary)
  if (prefix.flatMap(turn => turn.items).slice(0, oldProse.length).some(item => key(item) === null)) return { kind: 'ambiguous' }
  const tailTurnIds = new Set(tail.map(turn => String(turn.id)))
  const heldItemIds = new Set(oldItems.map(item => String(item.id)))
  if (newItems.slice(oldProse.length).some(item => heldItemIds.has(String(item.id)))) return { kind: 'ambiguous' }
  const ranges = (turns: readonly Turn[]) => {
    let n = 0
    return turns.map(turn => { const start = n; n += turn.items.filter(item => key(item) !== null).length; return [start, n] as const })
  }
  const oldRanges = ranges(held.turns), newRanges = ranges(prefix)
  const rangeKey = ([a, b]: readonly [number, number]) => `${a}:${b}`
  const oldRangeKeys = new Set(oldRanges.map(rangeKey))
  const newRangeIndices = new Map(newRanges.map((range, index) => [rangeKey(range), index]))
  const splitHasFacts = prefix.some((turn, i) => !oldRangeKeys.has(rangeKey(newRanges[i]!)) &&
    (turn.status !== 'completed' || turn.durationMs != null || turn.completedAt != null || turn.plan !== undefined || turn.diff != null))
  const sourceLayout = interior || splitHasFacts || held.turns.some(turn => tailTurnIds.has(String(turn.id)))
  if (sourceLayout) {
    // Preserve source segmentation and its facts when a split has its own
    // measurements. Place host rows at the matched prose boundary.
    const hostAt = new Map<number, AgentItem[]>()
    let at = 0
    for (const item of oldItems) {
      if (key(item) !== null) at++
      else { const group = hostAt.get(at) ?? []; group.push(item); hostAt.set(at, group) }
    }
    const sourceIds = new Set(newItems.map(item => String(item.id)))
    if ([...hostAt.values()].some(group => group.some(item => sourceIds.has(String(item.id))))) return { kind: 'ambiguous' }
    let pos = 0
    const turns = prefix.map((turn, index) => ({ ...turn, items: [
      ...(index === 0 ? hostAt.get(0) ?? [] : []),
      ...turn.items.flatMap(item => { pos++; return [item, ...(hostAt.get(pos) ?? [])] }),
    ] }))
    return { kind: 'reconciled', session: { ...read, turns: [...turns, ...tail] }, replaceTurns: true, advanced: newItems.length > oldProse.length }
  }
  const turns = held.turns.map((turn, i) => {
    const range = oldRanges[i]!, j = newRangeIndices.get(rangeKey(range))
    if (j === undefined) return turn
    const fresh = prefix[j]!
    return { ...turn, status: fresh.status, error: fresh.error,
      completedAt: fresh.completedAt ?? (fresh.status === 'inProgress' ? fresh.completedAt : turn.completedAt), durationMs: fresh.durationMs ?? turn.durationMs,
      plan: fresh.plan ?? turn.plan, diff: fresh.diff ?? turn.diff }
  })
  return { kind: 'reconciled', session: { ...read, turns: [...turns, ...tail] }, advanced: newItems.length > oldProse.length }
}
