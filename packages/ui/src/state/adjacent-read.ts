import { isNoticeTurn, mergeRead, preserveDeskContext, preserveNoticeItems, type AgentEvent, type Session, type TranscriptWatermark, type Turn } from '@harnessdesk/protocol'

type Field = { readonly present: boolean; readonly value: unknown }
type Change = { readonly first: Field; last: Field }
type Fields = Map<string, Change>
type ItemChanges = { whole?: Change; fields: Fields }
type TurnChanges = { whole?: Change; fields: Fields; items: Map<string, ItemChanges> }
const absent: Field = { present: false, value: undefined }
const field = (object: object | undefined, key: string): Field => object && Object.hasOwn(object, key)
  ? { present: true, value: (object as Record<string, unknown>)[key] } : absent
const sameValue = (a: unknown, b: unknown): boolean => {
  if (Object.is(a, b)) return true
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object' || Array.isArray(a) !== Array.isArray(b)) return false
  const ak = Object.keys(a).sort(), bk = Object.keys(b).sort()
  return ak.length === bk.length && ak.every((key, i) => key === bk[i] && sameValue((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]))
}
const same = (a: Field, b: Field): boolean => a.present === b.present && (!a.present || sameValue(a.value, b.value))
const value = (object: object | undefined): Field => object ? { present: true, value: object } : absent
const record = (fields: Fields, before: object | undefined, after: object | undefined, excluded: readonly string[]): void => {
  const keys = new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})])
  for (const key of keys) {
    if (excluded.includes(key)) continue
    const first = field(before, key), last = field(after, key)
    if (same(first, last)) continue
    const previous = fields.get(key)
    if (previous) previous.last = last
    else fields.set(key, { first, last })
  }
}
const apply = (fresh: Field, change: Change): Field => {
  if (same(fresh, change.last)) return fresh
  if (same(fresh, change.first)) return change.last
  throw new Error('The conversation changed while it was being read. Retry to refresh it.')
}
const applyFields = <T extends object>(fresh: T, fields: Fields): T => {
  const result = { ...fresh } as Record<string, unknown>
  for (const [key, change] of fields) {
    const next = apply(field(result, key), change)
    if (next.present) result[key] = next.value
    else delete result[key]
  }
  return result as T
}

/** Records actual accepted reducer changes, not ownership of an entire cached session. */
export class AdjacentReadChanges {
  readonly fields: Fields = new Map()
  readonly turns = new Map<string, TurnChanges>()
  unseen = false
  coverage: TranscriptWatermark | null = null
  coverageInvalid = false
  observeFence(fence: TranscriptWatermark | null): void {
    if (!fence) { this.coverageInvalid = true; return }
    const previous = this.coverage
    if (previous && (fence.epoch !== previous.epoch || fence.generation !== previous.generation ||
        fence.sequence !== previous.sequence + 1 || fence.revision < previous.revision)) this.coverageInvalid = true
    this.coverage = fence
  }
  #turn(id: string): TurnChanges {
    let turn = this.turns.get(id)
    if (!turn) this.turns.set(id, turn = { fields: new Map(), items: new Map() })
    return turn
  }
  #compareTurn(id: string, before: Turn | undefined, after: Turn | undefined, onlyItem?: string): void {
    if (!onlyItem && same(value(before), value(after))) return
    if (!before || !after) {
      const turn = this.#turn(id)
      if (turn.whole) turn.whole.last = value(after)
      else turn.whole = { first: value(before), last: value(after) }
      return
    }
    const existing = this.turns.get(id)
    if (existing?.whole) { existing.whole.last = value(after); return }
    const turn = this.#turn(id)
    if (!onlyItem) record(turn.fields, before, after, ['id', 'items'])
    const left = new Map<string, Turn['items'][number]>(before.items.map(item => [item.id, item])), right = new Map<string, Turn['items'][number]>(after.items.map(item => [item.id, item]))
    const ids = onlyItem ? [onlyItem] : [...new Set([...left.keys(), ...right.keys()])]
    for (const itemId of ids) {
      const a = left.get(itemId), b = right.get(itemId)
      if (same(value(a), value(b))) continue
      let item = turn.items.get(itemId)
      if (!item) turn.items.set(itemId, item = { fields: new Map() })
      if (!a || !b || a.type !== b.type || item.whole) {
        if (item.whole) item.whole.last = value(b)
        else item.whole = { first: value(a), last: value(b) }
      } else record(item.fields, a, b, ['id', 'type'])
    }
  }
  observe(event: AgentEvent, before: Session | undefined, after: Session | undefined): void {
    if (!before || !after) {
      if (event.type === 'session/started' || event.type === 'session/status' || event.type === 'session/title' || event.type === 'session/settings' || event.type === 'session/options' || event.type === 'session/memory' || event.type === 'session/goal' || event.type === 'session/detached' || event.type === 'session/closed' || event.type === 'usage/updated' || event.type === 'turn/started' || event.type === 'turn/completed' || event.type.startsWith('item/') || event.type === 'turn/diff' || event.type === 'turn/plan') this.unseen = true
      return
    }
    record(this.fields, before, after, ['turns'])
    if (event.type === 'turn/started' || event.type === 'turn/completed') {
      this.#compareTurn(event.turn.id, before.turns.find(t => t.id === event.turn.id), after.turns.find(t => t.id === event.turn.id)); return
    }
    if (event.type === 'turn/diff' || event.type === 'turn/plan') {
      this.#compareTurn(event.turnId, before.turns.find(t => t.id === event.turnId), after.turns.find(t => t.id === event.turnId)); return
    }
    if (event.type === 'item/started' || event.type === 'item/completed' || event.type === 'item/delta') {
      const id = event.type === 'item/delta' ? event.itemId : event.item.id
      this.#compareTurn(event.turnId, before.turns.find(t => t.id === event.turnId), after.turns.find(t => t.id === event.turnId), id); return
    }
    if (event.type === 'session/started' || event.type === 'session/detached' || event.type === 'notice' || event.type === 'error') {
      const left = new Map(before.turns.map(turn => [turn.id, turn])), right = new Map(after.turns.map(turn => [turn.id, turn]))
      for (const id of new Set([...left.keys(), ...right.keys()])) this.#compareTurn(id, left.get(id), right.get(id))
    }
  }
  get observed(): boolean { return this.unseen || this.fields.size > 0 || this.turns.size > 0 }
}

/** Apply only event-owned changes; a divergent unfenced field refuses replacement. */
export const reconcileAdjacentRead = (held: Session, read: Session, changes: AdjacentReadChanges): Session => {
  if (changes.unseen) throw new Error('The conversation changed without a complete event sequence. Retry to refresh it.')
  const merged = mergeRead(held, read, turn => changes.turns.has(turn.id) || turn.status === 'inProgress')
  if (!read.itemsLoaded) return applyFields(merged, changes.fields)
  const old = new Map(held.turns.map(turn => [turn.id, turn])), fresh = new Map(read.turns.map(turn => [turn.id, turn]))
  const output: Turn[] = []
  for (const turn of merged.turns) {
    const readTurn = fresh.get(turn.id), heldTurn = old.get(turn.id), change = changes.turns.get(turn.id)
    if (change?.whole) {
      const next = apply(value(readTurn), change.whole)
      if (next.present) output.push(next.value as Turn)
      continue
    }
    if (!readTurn || !heldTurn) { output.push(turn); continue }
    const base = applyFields(readTurn, change?.fields ?? new Map())
    const baseItems = preserveDeskContext(preserveNoticeItems(readTurn.items, heldTurn.items, true), heldTurn.items)
    const items = [...baseItems]
    for (const [id, itemChange] of change?.items ?? []) {
      const index = items.findIndex(item => item.id === id), item = index < 0 ? undefined : items[index]
      if (itemChange.whole) {
        const next = apply(value(item), itemChange.whole)
        if (index >= 0) { if (next.present) items[index] = next.value as typeof items[number]; else items.splice(index, 1) }
        else if (next.present) items.push(next.value as typeof items[number])
      } else if (item) items[index] = applyFields(item, itemChange.fields)
      else throw new Error('The conversation changed while it was being read. Retry to refresh it.')
    }
    output.push({ ...base, items })
  }
  return applyFields({ ...merged, turns: output }, changes.fields)
}

/** Preserve renderer-owned provenance and notices without restoring old transcript items. */
export const preserveAdjacentLocal = (snapshot: Session, held: Session | undefined): Session => {
  if (!held) return snapshot
  const byId = new Map(held.turns.map(turn => [turn.id, turn]))
  const turns = snapshot.turns.map(turn => {
    const old = byId.get(turn.id)
    return old ? { ...turn, items: preserveDeskContext(preserveNoticeItems(turn.items, old.items, true), old.items) } : turn
  })
  const ids = new Set(turns.map(turn => turn.id))
  const noticeIds = new Set(turns.flatMap(turn => turn.items.map(item => item.id)))
  for (const turn of held.turns) if (isNoticeTurn(turn) && !ids.has(turn.id) && !turn.items.every(item => noticeIds.has(item.id))) turns.push(turn)
  return { ...snapshot, turns }
}
