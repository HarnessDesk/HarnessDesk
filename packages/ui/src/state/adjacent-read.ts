import { isNoticeTurn, mergeRead, preserveDeskContext, preserveNoticeItems, type AgentEvent, type Session, type TranscriptWatermark, type Turn } from '@harnessdesk/protocol'

type Field = { readonly present: boolean; readonly value: unknown }
type Patch = { path: (string | number)[]; before: Field; truncate?: number }
type Change = { readonly first: Field; last: Field; undo: Patch[][] }
// The journal budget covers one open across read and resume; it excludes the
// first and latest snapshots. Refuse overflow while a provider stalls.
const MAX_JOURNAL_BYTES = 8 * 1024 * 1024
const MAX_TRANSITIONS = 4096
type Fields = Map<string, Change>
type ItemChanges = { whole?: Change; history?: Change; fields: Fields }
type TurnChanges = { whole?: Change; history?: Change; fields: Fields; items: Map<string, ItemChanges> }
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
// Reverse patches keep append-only text as a length, not every growing string.
// Arrays with a changed shape and arbitrary replacements retain exact values.
const reversePatch = (before: Field, after: Field, path: (string | number)[], out: Patch[]): void => {
  if (same(before, after)) return
  const a = before.value, b = after.value
  if (before.present && after.present && typeof a === 'string' && typeof b === 'string' && b.startsWith(a)) {
    out.push({ path, before: absent, truncate: a.length }); return
  }
  if (before.present && after.present && a && b && typeof a === 'object' && typeof b === 'object' &&
      Array.isArray(a) === Array.isArray(b) && (!Array.isArray(a) || a.length === (b as unknown[]).length)) {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)])
    for (const key of keys) reversePatch(field(a, key), field(b, key), [...path, key], out)
    return
  }
  out.push({ path, before })
}
const undo = (current: Field, patches: Patch[]): Field => {
  let root = current.value
  let present = current.present
  for (const patch of patches) {
    if (!patch.path.length) {
      if (patch.truncate !== undefined) root = (root as string).slice(0, patch.truncate)
      else { root = structuredClone(patch.before.value); present = patch.before.present }
      continue
    }
    let parent = root as Record<string | number, unknown>
    for (const key of patch.path.slice(0, -1)) parent = parent[key] as Record<string | number, unknown>
    const key = patch.path[patch.path.length - 1]!
    if (patch.truncate !== undefined) parent[key] = (parent[key] as string).slice(0, patch.truncate)
    else if (patch.before.present) Object.defineProperty(parent, key, { value: structuredClone(patch.before.value), writable: true, enumerable: true, configurable: true })
    else delete parent[key]
  }
  return present ? { present: true, value: root } : absent
}
const apply = (fresh: Field, change: Change): Field => {
  if (same(fresh, change.last)) return fresh
  if (same(fresh, change.first)) return change.last
  let checkpoint: Field = change.last.present ? { present: true, value: structuredClone(change.last.value) } : absent
  for (let i = change.undo.length - 1; i >= 0; i--) {
    checkpoint = undo(checkpoint, change.undo[i]!)
    if (same(fresh, checkpoint)) return change.last
  }
  throw new Error('The conversation changed while it was being read. Retry to refresh it.')
}
const applyFields = <T extends object>(fresh: T, fields: Fields): T => {
  const result = { ...fresh } as Record<string, unknown>
  for (const [key, change] of fields) {
    const next = apply(field(result, key), change)
    if (next.present) Object.defineProperty(result, key, { value: next.value, writable: true, enumerable: true, configurable: true })
    else delete result[key]
  }
  return result as T
}

/** Records actual accepted reducer changes, not ownership of an entire cached session. */
export class AdjacentReadChanges {
  readonly fields: Fields = new Map()
  readonly indexFields: Fields = new Map()
  readonly turns = new Map<string, TurnChanges>()
  private journalBytes = 0
  private transitions = 0
  private journalInvalid = false
  private journalDiscontinuous = false
  private update(previous: Change | undefined, first: Field, last: Field): Change {
    if (!previous) return { first, last, undo: [] }
    if (this.journalInvalid) return previous
    if (!same(previous.last, first)) {
      this.journalInvalid = true
      this.journalDiscontinuous = true
      return previous
    }
    const patches: Patch[] = []
    reversePatch(previous.last, last, [], patches)
    // Count serialized payload, including paths and removed/replaced values.
    const bytes = JSON.stringify(patches).length * 2
    if (++this.transitions > MAX_TRANSITIONS || this.journalBytes + bytes > MAX_JOURNAL_BYTES) {
      this.journalInvalid = true
      return previous
    }
    this.journalBytes += bytes
    previous.undo.push(patches)
    previous.last = last
    return previous
  }
  private record(fields: Fields, before: object | undefined, after: object | undefined, excluded: readonly string[]): void {
    for (const key of new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})])) {
      if (excluded.includes(key)) continue
      const first = field(before, key), last = field(after, key)
      if (!same(first, last)) fields.set(key, this.update(fields.get(key), first, last))
    }
  }
  private ensureJournal(): void {
    if (this.journalDiscontinuous) throw new Error('The conversation changed without a complete event sequence. Retry to refresh it.')
    if (this.journalInvalid) throw new Error('The conversation changed too much while it was being read. Retry to refresh it.')
  }
  unseen = false
  coverage: TranscriptWatermark | null = null
  coverageInvalid = false
  /** Index notifications own only their applied title/archive metadata. */
  observeIndex(before: Session, after: Session): void {
    for (const key of ['title', 'archived']) {
      const first = field(before, key), last = field(after, key)
      if (same(first, last)) continue
      this.indexFields.set(key, this.update(this.indexFields.get(key), first, last))
    }
  }
  applyIndex(snapshot: Session): Session { this.ensureJournal(); return applyFields(snapshot, this.indexFields) }
  forResume(): AdjacentReadChanges {
    const next = new AdjacentReadChanges()
    for (const [key, change] of this.indexFields) next.indexFields.set(key, { ...change, undo: [...change.undo] })
    next.journalBytes = this.journalBytes
    next.transitions = this.transitions
    next.journalInvalid = this.journalInvalid
    next.journalDiscontinuous = this.journalDiscontinuous
    return next
  }
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
    if (same(value(before), value(after))) return
    const history = this.#turn(id)
    history.history = this.update(history.history, value(before), value(after))
    if (!before || !after) {
      const turn = history
      turn.whole = turn.history
      return
    }
    const existing = this.turns.get(id)
    if (existing?.whole) { existing.whole = existing.history; return }
    const turn = this.#turn(id)
    if (!onlyItem) this.record(turn.fields, before, after, ['id', 'items'])
    const left = new Map<string, Turn['items'][number]>(before.items.map(item => [item.id, item])), right = new Map<string, Turn['items'][number]>(after.items.map(item => [item.id, item]))
    const ids = onlyItem ? [onlyItem] : [...new Set([...left.keys(), ...right.keys()])]
    for (const itemId of ids) {
      const a = left.get(itemId), b = right.get(itemId)
      if (same(value(a), value(b))) continue
      let item = turn.items.get(itemId)
      if (!item) turn.items.set(itemId, item = { fields: new Map() })
      item.history = this.update(item.history, value(a), value(b))
      if (!a || !b || a.type !== b.type || item.whole) {
        item.whole = item.history
      } else this.record(item.fields, a, b, ['id', 'type'])
    }
  }
  observe(event: AgentEvent, before: Session | undefined, after: Session | undefined): void {
    if (!before || !after) {
      if (event.type === 'session/started' || event.type === 'session/status' || event.type === 'session/title' || event.type === 'session/settings' || event.type === 'session/options' || event.type === 'session/memory' || event.type === 'session/goal' || event.type === 'session/detached' || event.type === 'session/closed' || event.type === 'usage/updated' || event.type === 'turn/started' || event.type === 'turn/completed' || event.type.startsWith('item/') || event.type === 'turn/diff' || event.type === 'turn/plan') this.unseen = true
      return
    }
    this.record(this.fields, before, after, ['turns'])
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
  assertComplete(): void { this.ensureJournal() }
  get observed(): boolean { return this.unseen || this.fields.size > 0 || this.turns.size > 0 }
}

/** Apply only event-owned changes; a divergent unfenced field refuses replacement. */
export const reconcileAdjacentRead = (held: Session, read: Session, changes: AdjacentReadChanges): Session => {
  changes.assertComplete()
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
