import { createHash, createHmac, randomBytes } from 'node:crypto'
import { PendingItemDeltas } from './pending-item-deltas.js'
import { seatedSession, type SeatedAs } from './registry.js'
import { canonicalTranscriptBody, matchContextRecords, planNoticeRecords, splitContext, withDeskContextFrom, type AgentEvent, type AgentItem, type Session, type Turn, type UserMessageItem } from '@harnessdesk/protocol'

// Process-local hints are not exact equality proofs and must never be logged.
const hintKey = randomBytes(32)
const hint = (value: unknown): string => createHmac('sha256', hintKey).update(JSON.stringify(value)).digest('hex')

interface DescriptorItem extends ContextItemHint {
  readonly startedAt: number | null
  readonly kindHint?: string
  readonly contentKeyHint?: string
  readonly lastEventIdHint?: string
  readonly count?: number | null
  readonly messageHint?: string
  readonly summaryCount?: number
  readonly contentCount?: number
  readonly pathHints?: readonly string[]
}
const describeItem = (entry: AgentItem): DescriptorItem => {
  const common = { id: hint(entry.id), type: entry.type, startedAt: entry.startedAt ?? null }
  if (entry.type === 'userMessage') {
    const text = entry.content.flatMap(part => part.type === 'text' ? [part.text] : []).join('\n')
    const folded = splitContext(text)
    return { ...common, hasDeskContext: entry.content.some(part => part.type === 'text' && part.deskContext !== undefined),
      rawTextHint: hint(text), candidateFoldedHint: hint([text, entry.context ?? []]),
      foldedTextHint: folded.injections.length ? hint([folded.text, folded.injections]) : null }
  }
  if (entry.type === 'notice') return { ...common, hasKind: Boolean(entry.kind), kindHint: hint(entry.kind ?? null), contentKeyHint: hint(entry.contentKey ?? null),
    lastEventIdHint: hint(entry.lastEventId ?? null), count: entry.count ?? null }
  if (entry.type === 'error') return { ...common, messageHint: hint(entry.message) }
  if (entry.type === 'reasoning') return { ...common, summaryCount: entry.summary.length, contentCount: entry.content.length }
  if (entry.type === 'fileChange') return { ...common, pathHints: entry.changes.map(change => hint(change.path)) }
  return common
}

/**
 * Structural planning hints only. A full exact base remains necessary before
 * resolving equality-sensitive reducer predicates or authorizing an unload.
 */
export function recoveryDescriptor(session: Session, durableIdentity?: string) {
  return { sessionHint: hint(session.id), runtimeHint: hint(session.runtime), hasUsage: Boolean(session.usage), identity: createHash('sha256').update(canonicalTranscriptBody(session.turns).canonical).digest('hex'), ...(durableIdentity === undefined ? {} : { durableIdentity }),
    turnIdentities: session.turns.map(turn => createHash('sha256').update(canonicalTranscriptBody([turn]).canonical).digest('hex')),
    turns: session.turns.map(turn => ({ id: hint(turn.id), noticeTurn: String(turn.id).startsWith('notice:'), status: turn.status,
      errorHint: hint(turn.error?.message ?? null), diffDefined: turn.diff !== undefined, planDefined: turn.plan !== undefined, items: turn.items.map(describeItem) })) }
}

/** Bounded structural facts; a refusal leaves every existing entry intact. */
export class DescriptorCache {
  readonly #entries = new Map<string, { encoded: string; bytes: number }>()
  readonly #reservations = new Map<symbol, { key: string; entry: { encoded: string; bytes: number }; charge: number }>()
  readonly #locked = new Set<string>()
  #bytes = 0
  constructor(readonly maxBytes: number) {}
  get size(): number { return this.#entries.size }
  /** Includes reservations so concurrent admissions cannot exceed the budget. */
  get bytes(): number { return this.#bytes }

  #entry(key: string, descriptor: ReturnType<typeof recoveryDescriptor>) {
    const encoded = JSON.stringify(descriptor)
    const bytes = Buffer.byteLength(`{"key":${JSON.stringify(key)},"descriptor":${encoded}}`, 'utf8')
    return { encoded, bytes }
  }

  put(key: string, descriptor: ReturnType<typeof recoveryDescriptor>): boolean {
    if (this.#locked.has(key)) return false
    const entry = this.#entry(key, descriptor), old = this.#entries.get(key)
    if (this.#bytes - (old?.bytes ?? 0) + entry.bytes > this.maxBytes) return false
    this.#entries.set(key, entry)
    this.#bytes += entry.bytes - (old?.bytes ?? 0)
    return true
  }

  reserve(key: string, descriptor: ReturnType<typeof recoveryDescriptor>): symbol | null {
    if (this.#locked.has(key)) return null
    const entry = this.#entry(key, descriptor), old = this.#entries.get(key)
    const charge = old?.encoded === entry.encoded ? 0 : entry.bytes
    if (this.#bytes + charge > this.maxBytes) return null
    const token = Symbol('descriptor reservation')
    this.#locked.add(key); this.#reservations.set(token, { key, entry, charge }); this.#bytes += charge
    return token
  }

  commit(token: symbol): boolean {
    const reserved = this.#reservations.get(token)
    if (!reserved) return false
    this.#reservations.delete(token); this.#locked.delete(reserved.key)
    if (reserved.charge) {
      const old = this.#entries.get(reserved.key)
      this.#bytes -= old?.bytes ?? 0
      this.#entries.set(reserved.key, reserved.entry)
    }
    return true
  }

  cancel(token: symbol): void {
    const reserved = this.#reservations.get(token)
    if (!reserved) return
    this.#bytes -= reserved.charge; this.#locked.delete(reserved.key); this.#reservations.delete(token)
  }

  get(key: string): ReturnType<typeof recoveryDescriptor> | undefined {
    const entry = this.#entries.get(key)
    return entry ? JSON.parse(entry.encoded) as ReturnType<typeof recoveryDescriptor> : undefined
  }

  remove(key: string): void {
    for (const [token, reservation] of this.#reservations) if (reservation.key === key) this.cancel(token)
    const entry = this.#entries.get(key)
    if (!entry) return
    this.#bytes -= entry.bytes
    this.#entries.delete(key)
  }
}

interface ContextItemHint {
  readonly id: string
  readonly type: string
  readonly hasKind?: boolean
  readonly hasDeskContext?: boolean
  readonly rawTextHint?: string
  readonly foldedTextHint?: string | null
  readonly candidateFoldedHint?: string
}

/** Collision-resistant index plan; the exact base remains required for reconstruction. */
export function matchContextHints(candidates: readonly ContextItemHint[], held: readonly ContextItemHint[]): readonly (number | null)[] {
  return matchContextRecords(
    candidates.map(item => ({ id: item.id, rawKey: item.rawTextHint, foldedKey: item.candidateFoldedHint, hasDeskContext: item.hasDeskContext ?? false })),
    held.map(item => ({ id: item.id, rawKey: item.rawTextHint, foldedKey: item.foldedTextHint, hasDeskContext: item.hasDeskContext ?? false })),
  )
}

/** Shares the reducer's notice placement policy over keyed descriptor hints. */
export function planNoticeHints(items: readonly ContextItemHint[], held: readonly ContextItemHint[], keepRuntimeRows = false) {
  const describe = (item: ContextItemHint) => ({ id: item.id, type: item.type, hasKind: item.hasKind ?? false })
  return planNoticeRecords(items.map(describe), held.map(describe), keepRuntimeRows)
}

const withContextHints = (entry: DescriptorItem, source: DescriptorItem | undefined): DescriptorItem => {
  if (!source || source.type !== 'userMessage' || entry.type !== 'userMessage') return entry
  return { ...entry, hasDeskContext: true, rawTextHint: source.rawTextHint,
    candidateFoldedHint: source.candidateFoldedHint, foldedTextHint: source.foldedTextHint }
}

/** Shape-only prototype. It cannot materialize data or authorize release. */
export class PendingTurnShape {
  #turn: ReturnType<typeof recoveryDescriptor>['turns'][number]
  constructor(turn: ReturnType<typeof recoveryDescriptor>['turns'][number]) { this.#turn = structuredClone(turn) }
  snapshot() { return structuredClone(this.#turn) }
  interrupt(): void { if (this.#turn.status === 'inProgress') this.#turn = { ...this.#turn, status: 'interrupted' } }
  append(item: AgentItem): void { this.#turn = { ...this.#turn, items: [...this.#turn.items, describeItem(item)] } }
  insert(index: number, item: DescriptorItem): void { const items = this.#turn.items.slice(); items.splice(index, 0, item); this.#turn = { ...this.#turn, items } }
  repeatNotice(index: number, id: string): void {
    const items = this.#turn.items.slice(), previous = items[index]!
    items[index] = { ...previous, count: (previous.count ?? 1) + 1, lastEventIdHint: hint(id) }
    this.#turn = { ...this.#turn, items }
  }

  reconcileRead(read: Turn): void {
    if (hint(read.id) !== this.#turn.id) throw new Error('Read belongs to another turn')
    let items = this.#turn.items
    if (read.items.length >= items.length) {
      const incoming = read.items.map(describeItem), plan = planNoticeHints(incoming, items, true)
      const selected = incoming.map((entry, index) => plan.replacements[index] == null ? entry : items[plan.replacements[index]!]!)
      selected.push(...plan.appended.map(index => items[index]!))
      const matches = matchContextHints(selected, items)
      items = selected.map((entry, index) => withContextHints(entry, matches[index] == null ? undefined : items[matches[index]!]!))
    }
    if (read.error) items = items.filter(entry => entry.type !== 'error' || entry.messageHint !== hint(read.error!.message))
    this.#turn = { ...this.#turn, status: read.status, items, errorHint: hint(read.error?.message ?? null),
      diffDefined: read.diff != null || this.#turn.diffDefined || read.diff !== undefined,
      planDefined: read.plan != null || this.#turn.planDefined || read.plan !== undefined }
  }

  apply(event: AgentEvent): void {
    if (event.type === 'turn/started' || event.type === 'turn/completed') {
      if (hint(event.turn.id) !== this.#turn.id) return
      let items = this.#turn.items
      if (event.type === 'turn/completed' && event.turn.items.length > items.length) {
        const incoming = event.turn.items.map(describeItem)
        const plan = planNoticeHints(incoming, items, true)
        const selected = incoming.map((entry, index) => plan.replacements[index] == null ? entry : items[plan.replacements[index]!]!)
        selected.push(...plan.appended.map(index => items[index]!))
        const contexts = matchContextHints(selected, items)
        items = selected.map((entry, index) => withContextHints(entry, contexts[index] == null ? undefined : items[contexts[index]!]!))
      }
      if (event.type === 'turn/completed' && event.turn.error) items = items.filter(entry => entry.type !== 'error' || entry.messageHint !== hint(event.turn.error!.message))
      this.#turn = { ...this.#turn, status: event.turn.status, items,
        ...('error' in event.turn ? { errorHint: hint(event.turn.error?.message ?? null) } : {}),
        ...('diff' in event.turn ? { diffDefined: event.turn.diff !== undefined } : {}),
        ...('plan' in event.turn ? { planDefined: event.turn.plan !== undefined } : {}) }
      return
    }
    if (event.type === 'turn/diff' || event.type === 'turn/plan') {
      if (hint(event.turnId) === this.#turn.id) this.#turn = { ...this.#turn, ...(event.type === 'turn/diff' ? { diffDefined: true } : { planDefined: true }) }
      return
    }
    if (event.type !== 'item/started' && event.type !== 'item/completed' && event.type !== 'item/delta') throw new Error('Unsupported turn shape event')
    if (hint(event.turnId) !== this.#turn.id) return
    const id = hint(event.type === 'item/delta' ? event.itemId : event.item.id)
    const index = this.#turn.items.findIndex(entry => entry.id === id)
    if (event.type === 'item/delta') {
      if (index < 0) return
      const previous = this.#turn.items[index]!
      let next = previous
      const delta = event.delta
      if (previous.type === 'reasoning' && (delta.kind === 'reasoningSummary' || delta.kind === 'reasoningSummaryPart')) {
        next = { ...previous, summaryCount: Math.max(previous.summaryCount ?? 0, delta.index + 1) }
      } else if (previous.type === 'reasoning' && delta.kind === 'reasoningText') {
        next = { ...previous, contentCount: Math.max(previous.contentCount ?? 0, delta.index + 1) }
      } else if (previous.type === 'fileChange' && delta.kind === 'fileChangePatch') {
        const paths = new Set(previous.pathHints ?? [])
        for (const change of delta.changes) paths.add(hint(change.path))
        next = { ...previous, pathHints: [...paths] }
      }
      const items = this.#turn.items.slice(); items[index] = next; this.#turn = { ...this.#turn, items }
      return
    }
    let next = describeItem(event.item)
    if (index >= 0) {
      const previous = this.#turn.items[index]!
      if (next.startedAt === null && previous.startedAt !== null) next = { ...next, startedAt: previous.startedAt }
      const matched = matchContextHints([next], [previous])[0]
      if (matched != null) next = withContextHints(next, previous)
      const items = this.#turn.items.slice(); items[index] = next; this.#turn = { ...this.#turn, items }
    } else this.#turn = { ...this.#turn, items: [...this.#turn.items, next] }
  }
}

const verifiedSessionBase = Symbol('verified session base')

type FieldRef<T> = { readonly kind: 'base'; readonly defined: boolean } | { readonly kind: 'value'; readonly value: T | undefined; readonly present: boolean; readonly defined: boolean }

type ContextCarrier = { readonly baseIndex: number } | { readonly known: UserMessageItem }
interface SymbolicItem {
  readonly baseIndex: number | null
  readonly replacement: AgentItem | null
  readonly deltas: PendingItemDeltas
  readonly context: ContextCarrier | null
  noticePatch?: { count: number; lastEventId: string; completedAt: number | undefined }
}

/** Prototype for one existing turn. The caller must first verify the entire base identity. */
export class PendingTurnOverlay {
  readonly #baseHints: readonly DescriptorItem[]
  readonly #baseIdentity: string | null
  readonly #shape: PendingTurnShape
  #items: SymbolicItem[]
  #patch: Partial<Turn> = {}
  #metadataReplacement: Omit<Turn, 'items'> | null = null
  #diff: FieldRef<Turn['diff']>
  #plan: FieldRef<Turn['plan']>

  /** Logical UTF-8 pending data estimate; protected output is not a cache bound or RSS. */
  get protectedBytes(): number {
    let bytes = Buffer.byteLength(JSON.stringify(this.#patch), 'utf8')
    for (const item of this.#items) {
      if (item.replacement) bytes += Buffer.byteLength(JSON.stringify(item.replacement), 'utf8')
      if (item.context && 'known' in item.context && item.context.known !== item.replacement) bytes += Buffer.byteLength(JSON.stringify(item.context.known), 'utf8')
      bytes += item.deltas.protectedBytes
    }
    return bytes
  }
  get structureCount(): number { return this.#items.reduce((count, item) => count + 1 + item.deltas.operationCount, 0) }

  constructor(turn: ReturnType<typeof recoveryDescriptor>['turns'][number], baseIdentity: string | null) {
    this.#baseIdentity = baseIdentity
    this.#diff = { kind: 'base', defined: turn.diffDefined }
    this.#plan = { kind: 'base', defined: turn.planDefined }
    this.#shape = new PendingTurnShape(turn)
    this.#baseHints = structuredClone(turn.items)
    this.#items = turn.items.map((entry, baseIndex) => ({ baseIndex, replacement: null, deltas: new PendingItemDeltas(),
      context: entry.type === 'userMessage' && entry.hasDeskContext ? { baseIndex } : null }))
  }

  apply(event: AgentEvent): void {
    const before = this.#shape.snapshot()
    if (event.type === 'turn/started' || event.type === 'turn/completed') {
      if (hint(event.turn.id) !== before.id) return
      let selectedHints = before.items
      if (event.type === 'turn/completed' && event.turn.items.length > before.items.length) {
        const incoming = event.turn.items.map(describeItem)
        const plan = planNoticeHints(incoming, before.items, true)
        const selected = incoming.map((entry, index): { hint: DescriptorItem; symbol: SymbolicItem } => {
          const prior = plan.replacements[index]
          if (prior != null) return { hint: before.items[prior]!, symbol: this.#items[prior]! }
          const item = event.turn.items[index]!
          return { hint: entry, symbol: { baseIndex: null, replacement: item, deltas: new PendingItemDeltas(),
            context: item.type === 'userMessage' && entry.hasDeskContext ? { known: item } : null } }
        })
        selected.push(...plan.appended.map(index => ({ hint: before.items[index]!, symbol: this.#items[index]! })))
        selectedHints = selected.map(entry => entry.hint)
        const matches = matchContextHints(selectedHints, before.items)
        this.#items = selected.map((entry, index) => matches[index] == null ? entry.symbol : { ...entry.symbol, context: this.#items[matches[index]!]!.context })
      }
      if (event.type === 'turn/completed' && event.turn.error) {
        // The reducer filters only errors matching the completion's own error.
        this.#items = this.#items.filter((_, index) => selectedHints[index]!.type !== 'error' || selectedHints[index]!.messageHint !== hint(event.turn.error!.message))
      }
      const { items: _items, ...patch } = event.turn
      this.#patch = { ...this.#patch, ...patch }
      if ('diff' in event.turn) this.#diff = { kind: 'value', value: event.turn.diff, present: true, defined: event.turn.diff !== undefined }
      if ('plan' in event.turn) this.#plan = { kind: 'value', value: event.turn.plan, present: true, defined: event.turn.plan !== undefined }
      this.#shape.apply(event)
      return
    }
    if (event.type === 'turn/diff' || event.type === 'turn/plan') {
      if (hint(event.turnId) !== before.id) return
      this.#patch = event.type === 'turn/diff' ? { ...this.#patch, diff: event.diff } : { ...this.#patch, plan: event.steps }
      if (event.type === 'turn/diff') this.#diff = { kind: 'value', value: event.diff, present: true, defined: true }
      else this.#plan = { kind: 'value', value: event.steps, present: true, defined: true }
      this.#shape.apply(event)
      return
    }
    if (event.type !== 'item/started' && event.type !== 'item/completed' && event.type !== 'item/delta') throw new Error('Unsupported pending turn event')
    if (hint(event.turnId) !== before.id) return
    const id = hint(event.type === 'item/delta' ? event.itemId : event.item.id)
    const index = before.items.findIndex(item => item.id === id)
    if (event.type === 'item/delta') {
      if (index >= 0) this.#items[index]!.deltas.add(event.delta)
    } else {
      const described = describeItem(event.item)
      const old = index < 0 ? null : this.#items[index]!
      const oldHint = index < 0 ? undefined : before.items[index]
      const context = event.item.type === 'userMessage' && described.hasDeskContext ? { known: event.item } :
        oldHint && matchContextHints([described], [oldHint])[0] != null ? old?.context ?? null : null
      const replacement = oldHint && described.startedAt === null && oldHint.startedAt !== null
        ? { ...event.item, startedAt: oldHint.startedAt } as AgentItem : event.item
      const entry: SymbolicItem = { baseIndex: null, replacement, deltas: new PendingItemDeltas(), context }
      if (index < 0) this.#items.push(entry); else this.#items[index] = entry
    }
    this.#shape.apply(event)
  }

  /** Reconcile an authoritative read using the same item-selection planners as mergeRead. */
  reconcileRead(read: Turn): void {
    const before = this.#shape.snapshot()
    if (hint(read.id) !== before.id) throw new Error('Read belongs to another turn')
    let selectedHints = before.items
    if (read.items.length >= before.items.length) {
      const incoming = read.items.map(describeItem), plan = planNoticeHints(incoming, before.items, true)
      const selected = incoming.map((entry, index): { hint: DescriptorItem; symbol: SymbolicItem } => {
        const prior = plan.replacements[index]
        if (prior != null) return { hint: before.items[prior]!, symbol: this.#items[prior]! }
        const item = read.items[index]!
        return { hint: entry, symbol: { baseIndex: null, replacement: item, deltas: new PendingItemDeltas(),
          context: item.type === 'userMessage' && entry.hasDeskContext ? { known: item } : null } }
      })
      selected.push(...plan.appended.map(index => ({ hint: before.items[index]!, symbol: this.#items[index]! })))
      selectedHints = selected.map(entry => entry.hint)
      const matches = matchContextHints(selectedHints, before.items)
      this.#items = selected.map((entry, index) => matches[index] == null ? entry.symbol : { ...entry.symbol, context: this.#items[matches[index]!]!.context })
    }
    if (read.error) this.#items = this.#items.filter((_, index) => selectedHints[index]!.type !== 'error' || selectedHints[index]!.messageHint !== hint(read.error!.message))
    if (read.diff != null || !this.#diff.defined) this.#diff = { kind: 'value', value: read.diff, present: Object.hasOwn(read, 'diff'), defined: read.diff !== undefined }
    if (read.plan != null || !this.#plan.defined) this.#plan = { kind: 'value', value: read.plan, present: Object.hasOwn(read, 'plan'), defined: read.plan !== undefined }
    const { items: _items, ...metadata } = read
    this.#metadataReplacement = metadata
    this.#patch = {}
    this.#shape.reconcileRead(read)
  }

  /** Fold one completion and retain Host publication rows once, without replaying side effects. */
  applyHostCompletion(event: AgentEvent): void {
    if (event.type !== 'turn/completed') throw new Error('Expected a turn completion')
    const before = this.#shape.snapshot()
    const publications = before.items.flatMap((item, index) => item.type === 'publication' ? [{ item, index, symbol: this.#items[index]! }] : [])
    this.apply(event)
    for (const publication of publications) {
      if (this.#shape.snapshot().items.some(item => item.id === publication.item.id)) continue
      const index = Math.min(publication.index, this.#items.length)
      this.#items.splice(index, 0, publication.symbol)
      this.#shape.insert(index, publication.item)
    }
  }

  interrupt(): void {
    if (this.#shape.snapshot().status === 'inProgress') { this.#patch = { ...this.#patch, status: 'interrupted' }; this.#shape.interrupt() }
  }

  shape() { return this.#shape.snapshot() }
  appendDerivedItem(item: AgentItem): void {
    this.#items.push({ baseIndex: null, replacement: item, deltas: new PendingItemDeltas(), context: null })
    this.#shape.append(item)
  }
  repeatNotice(index: number, id: string, at: number | undefined): void {
    const entry = this.#items[index]!, prior = this.#shape.snapshot().items[index]!
    this.#items[index] = { ...entry, noticePatch: { count: (prior.count ?? 1) + 1, lastEventId: id, completedAt: at } }
    this.#shape.repeatNotice(index, id)
  }

  materialize(base: Turn, proof?: symbol): Turn {
    if ((this.#baseIdentity === null ? proof !== verifiedSessionBase : createHash('sha256').update(canonicalTranscriptBody([base]).canonical).digest('hex') !== this.#baseIdentity) ||
        hint(base.id) !== this.#shape.snapshot().id || base.items.length !== this.#baseHints.length ||
        base.items.some((item, index) => hint(item.id) !== this.#baseHints[index]!.id)) throw new Error('Pending turn base structure changed')
    const items = this.#items.map(symbol => {
      let item = symbol.replacement ?? (symbol.baseIndex == null ? undefined : base.items[symbol.baseIndex])
      if (!item) throw new Error('Pending turn base item is unavailable')
      if (item.type === 'userMessage' && symbol.context) {
        const source = 'baseIndex' in symbol.context ? base.items[symbol.context.baseIndex] : symbol.context.known
        if (!source || source.type !== 'userMessage') throw new Error('Pending desk context source is unavailable')
        item = withDeskContextFrom(item, source)
      }
      item = symbol.deltas.apply(item)
      if (symbol.noticePatch && item.type === 'notice') item = { ...item, ...symbol.noticePatch }
      return item
    })
    const result = { ...(this.#metadataReplacement ?? base), ...this.#patch, items } as Turn
    const applyField = <K extends 'diff' | 'plan'>(key: K, ref: FieldRef<Turn[K]>): void => {
      if (ref.kind === 'base') {
        if (Object.hasOwn(base, key)) Object.assign(result, { [key]: base[key] })
        else Reflect.deleteProperty(result, key)
      } else if (ref.present) Object.assign(result, { [key]: ref.value })
      else Reflect.deleteProperty(result, key)
    }
    applyField('diff', this.#diff); applyField('plan', this.#plan)
    return result
  }
}

interface SymbolicTurn {
  readonly id: string
  readonly baseIndex: number | null
  readonly known: Turn | null
  readonly migrated?: readonly SymbolicTurn[]
  readonly overlay: PendingTurnOverlay
}

/** Partial prototype; unsupported body events must remain protected, never dropped. */
export class PendingSessionOverlay {
  readonly #descriptor: ReturnType<typeof recoveryDescriptor>
  readonly #turns: SymbolicTurn[]
  #patch: Partial<Session> = {}
  #replacementSession: Session | null = null
  #usage: FieldRef<Session['usage']>
  #usageTruthy: boolean
  #applyHostSeating = false
  #hostSeated: SeatedAs | null = null

  /** Logical serialized pending data, not a heap/RSS measurement. */
  get protectedBytes(): number {
    const measure = (turn: SymbolicTurn): number => (turn.known ? Buffer.byteLength(JSON.stringify(turn.known), 'utf8') : 0) +
      turn.overlay.protectedBytes + (turn.migrated?.reduce((sum, child) => sum + measure(child), 0) ?? 0)
    const { turns: _turns, ...metadata } = this.#replacementSession ?? { turns: [] }
    return Buffer.byteLength(JSON.stringify([this.#patch, metadata]), 'utf8') + this.#turns.reduce((sum, turn) => sum + measure(turn), 0)
  }
  get structureCount(): number {
    const count = (turn: SymbolicTurn): number => 1 + turn.overlay.structureCount + (turn.migrated?.reduce((sum, child) => sum + count(child), 0) ?? 0)
    return this.#turns.reduce((sum, turn) => sum + count(turn), 0)
  }

  constructor(descriptor: ReturnType<typeof recoveryDescriptor>) {
    this.#descriptor = structuredClone(descriptor)
    this.#usage = { kind: 'base', defined: descriptor.hasUsage }
    this.#usageTruthy = descriptor.hasUsage
    this.#turns = descriptor.turns.map((turn, baseIndex) => ({ id: turn.id, baseIndex, known: null,
      overlay: new PendingTurnOverlay(turn, descriptor.turnIdentities[baseIndex]!) }))
  }

  apply(event: AgentEvent): void {
    const eventId = event.type === 'session/started' ? event.session.id : event.type === 'approval/requested' ? event.approval.sessionId :
      'sessionId' in event ? event.sessionId : undefined
    if (eventId !== undefined && hint(eventId) !== this.#descriptor.sessionHint) return
    if ((event.type === 'notice' || event.type === 'error') && event.sessionId === undefined) return
    switch (event.type) {
      case 'turn/started': {
        const id = hint(event.turn.id), existing = this.#turns.find(turn => turn.id === id)
        if (existing) { existing.overlay.apply(event); return }
        const noticeTurns = this.#turns.filter(turn => turn.overlay.shape().noticeTurn)
        for (let i = this.#turns.length - 1; i >= 0; i--) if (this.#turns[i]!.overlay.shape().noticeTurn) this.#turns.splice(i, 1)
        this.#appendKnownTurn(event.turn, noticeTurns)
        return
      }
      case 'turn/completed':
      case 'turn/diff':
      case 'turn/plan':
      case 'item/started':
      case 'item/completed':
      case 'item/delta': {
        const id = hint(event.type === 'turn/completed' ? event.turn.id : event.turnId)
        this.#turns.find(turn => turn.id === id)?.overlay.apply(event)
        return
      }
      case 'session/status': this.#patch = { ...this.#patch, status: event.status }; return
      case 'session/title': this.#patch = { ...this.#patch, title: event.title }; return
      case 'session/goal': this.#patch = { ...this.#patch, goal: event.goal }; return
      case 'session/settings': this.#patch = { ...this.#patch, settings: event.settings }; return
      case 'session/options': this.#patch = { ...this.#patch, options: event.options }; return
      case 'session/memory': this.#patch = { ...this.#patch, memory: event.enabled }; return
      case 'usage/updated': this.#patch = { ...this.#patch, usage: event.usage }; this.#usage = { kind: 'value', value: event.usage, present: true, defined: true }; this.#usageTruthy = true; return
      case 'session/closed': this.#patch = { ...this.#patch, status: { type: 'idle' } }; return
      case 'session/detached':
        this.#patch = { ...this.#patch, status: { type: 'idle' } }
        for (const turn of this.#turns) turn.overlay.interrupt()
        return
      case 'session/queue': case 'session/tasks': case 'approval/requested': case 'approval/resolved':
      case 'limits/updated': case 'runtime/options': case 'catalog/changed': case 'account/loginCompleted':
      case 'account/loginAwaitsCode': case 'account/changed': return
      case 'notice': {
        if (event.class === 'info' || event.class === 'result' || event.kind === 'runtime:config' || event.kind === 'runtime:deprecation') return
        const key = event.contentKey ?? JSON.stringify([event.kind ?? 'conversation:warning', event.message])
        const id = event.id ?? `notice:${key}`, idHint = hint(id)
        if (this.#turns.some(turn => turn.overlay.shape().items.some(item => item.id === idHint || (item.type === 'notice' && item.lastEventIdHint === idHint)))) return
        const last = this.#turns.at(-1)
        const repeated = last?.overlay.shape().items.flatMap((item, index) => item.type === 'notice' && item.contentKeyHint === hint(key) ? [index] : []) ?? []
        if (last && repeated.length) { for (const index of repeated) last.overlay.repeatNotice(index, id, event.at); return }
        const item: AgentItem = { id: id as AgentItem['id'], type: 'notice', kind: event.kind ?? 'conversation:warning', contentKey: key,
          text: event.message, count: 1, ...(event.at === undefined ? {} : { startedAt: event.at }) }
        if (last) last.overlay.appendDerivedItem(item)
        else this.#appendKnownTurn({ id: `notice:${id}` as Turn['id'], status: 'completed', items: [item] })
        return
      }
      case 'error': {
        if (!event.error.retrying) this.#patch = { ...this.#patch, status: { type: 'error', message: event.error.message } }
        const last = this.#turns.at(-1), shape = last?.overlay.shape(), messageHint = hint(event.error.message)
        if (shape && (shape.errorHint === messageHint || shape.items.some(item => item.type === 'error' && item.messageHint === messageHint))) return
        const item: AgentItem = { id: `error:${event.error.message}` as AgentItem['id'], type: 'error', message: event.error.message }
        if (last) last.overlay.appendDerivedItem(item)
        else this.#appendKnownTurn({ id: `notice:${item.id}` as Turn['id'], status: 'failed', items: [item] })
        return
      }
      case 'session/started': {
        const incomingIds = new Set(event.session.turns.map(turn => hint(turn.id)))
        const notices = this.#turns.filter(turn => turn.overlay.shape().noticeTurn && !incomingIds.has(turn.id))
        this.#turns.splice(0)
        for (const turn of event.session.turns) this.#appendKnownTurn(turn)
        this.#turns.push(...notices)
        this.#replacementSession = event.session
        this.#usage = { kind: 'value', value: event.session.usage, present: Object.hasOwn(event.session, 'usage'), defined: event.session.usage !== undefined }
        this.#usageTruthy = Boolean(event.session.usage)
        this.#patch = {}
        return
      }
      default: { const exhaustive: never = event; throw new Error(`Unknown event ${String(exhaustive)}`) }
    }
  }

  /** Model Host body state only; callers must execute surrounding Host side effects exactly once. */
  applyHostEvent(event: AgentEvent, watched: readonly Turn['id'][], running: readonly Turn['id'][], seated: SeatedAs | null = null): void {
    const target = event.type === 'session/started' ? event.session.id : event.type === 'approval/requested' ? event.approval.sessionId :
      'sessionId' in event ? event.sessionId : undefined
    if (target === undefined || hint(target) !== this.#descriptor.sessionHint) return
    this.#applyHostSeating = true
    this.#hostSeated = seated
    if (event.type === 'session/started') { this.applyHostStarted(event.session, watched, running, seated); return }
    if (event.type === 'turn/completed') {
      if (hint(event.sessionId) !== this.#descriptor.sessionHint) return
      this.#turns.find(turn => turn.id === hint(event.turn.id))?.overlay.applyHostCompletion(event)
      return
    }
    this.apply(event)
  }

  /** Host session/started uses registry merge, not the renderer's raw reducer. */
  applyHostStarted(read: Session, watched: readonly Turn['id'][], running: readonly Turn['id'][], seated: SeatedAs | null = null): void {
    if (hint(read.id) !== this.#descriptor.sessionHint || hint(read.runtime) !== this.#descriptor.runtimeHint) throw new Error('Read belongs to another session')
    const runningIds = new Set(running)
    const settled: Session = seatedSession({ ...read,
      ...(read.status.type === 'active' && runningIds.size === 0 ? { status: { type: 'idle' as const } } : {}),
      turns: read.turns.map(turn => turn.status === 'inProgress' && !runningIds.has(turn.id) ? { ...turn, status: 'interrupted' as const } : turn) }, seated)
    if (settled.usage || !this.#usageTruthy) {
      this.#usage = { kind: 'value', value: settled.usage, present: Object.hasOwn(settled, 'usage'), defined: settled.usage !== undefined }
      this.#usageTruthy = Boolean(settled.usage)
    }
    if (settled.itemsLoaded) {
      const old = [...this.#turns], byId = new Map(old.map(turn => [turn.id, turn])), readIds = new Set(settled.turns.map(turn => hint(turn.id)))
      const readTurns: SymbolicTurn[] = []
      for (const turn of settled.turns) {
        const existing = byId.get(hint(turn.id))
        if (existing) { existing.overlay.reconcileRead(turn); readTurns.push(existing) }
        else {
          const fake: Session = { runtime: '' as Session['runtime'], id: '' as Session['id'], cwd: '', createdAt: 0, updatedAt: 0,
            status: { type: 'idle' }, itemsLoaded: true, turns: [turn] }
          const desc = recoveryDescriptor(fake)
          readTurns.push({ id: hint(turn.id), baseIndex: null, known: turn, overlay: new PendingTurnOverlay(desc.turns[0]!, desc.turnIdentities[0]!) })
        }
      }
      const noticeIds = new Set(readTurns.flatMap(turn => turn.overlay.shape().items.filter(item => item.type === 'notice').map(item => item.id)))
      const unrepresented = (turn: SymbolicTurn) => !turn.overlay.shape().noticeTurn || !turn.overlay.shape().items.every(item => noticeIds.has(item.id))
      const firstShared = old.findIndex(turn => readIds.has(turn.id))
      const earlier = settled.partialHistory ? old.slice(0, firstShared < 0 ? old.length : firstShared).filter(turn => turn.overlay.shape().status !== 'inProgress' && unrepresented(turn)) : []
      const earlierIds = new Set(earlier.map(turn => turn.id)), watchedIds = new Set(watched.map(id => hint(id)))
      const missing = old.filter(turn => !readIds.has(turn.id) && !earlierIds.has(turn.id) && unrepresented(turn) &&
        (watchedIds.has(turn.id) || turn.overlay.shape().noticeTurn))
      this.#turns.splice(0, this.#turns.length, ...earlier, ...readTurns, ...missing)
    }
    this.#replacementSession = settled.itemsLoaded ? settled : { ...settled, itemsLoaded: true }
    this.#patch = {}
  }

  #appendKnownTurn(turn: Turn, migrated: readonly SymbolicTurn[] = []): void {
    const fake: Session = { runtime: '' as Session['runtime'], id: '' as Session['id'], cwd: '', createdAt: 0, updatedAt: 0,
      status: { type: 'idle' }, itemsLoaded: true, turns: [turn] }
    const desc = recoveryDescriptor(fake), shape = desc.turns[0]!
    const composite = migrated.length ? { ...shape, items: [...migrated.flatMap(entry => entry.overlay.shape().items), ...shape.items] } : shape
    this.#turns.push({ id: hint(turn.id), baseIndex: null, known: turn, migrated,
      overlay: new PendingTurnOverlay(composite, migrated.length ? null : desc.turnIdentities[0]!) })
  }

  materialize(base: Session): Session {
    if (hint(base.id) !== this.#descriptor.sessionHint || hint(base.runtime) !== this.#descriptor.runtimeHint ||
        recoveryDescriptor(base).identity !== this.#descriptor.identity) throw new Error('Pending session base changed')
    const materializeTurn = (turn: SymbolicTurn): Turn => {
      let origin = turn.known ?? (turn.baseIndex == null ? undefined : base.turns[turn.baseIndex])
      if (!origin) throw new Error('Pending session turn is unavailable')
      if (turn.migrated?.length) origin = { ...origin, items: [...turn.migrated.flatMap(entry => materializeTurn(entry).items), ...origin.items] }
      return turn.overlay.materialize(origin, verifiedSessionBase)
    }
    const turns = this.#turns.map(materializeTurn)
    const result = { ...(this.#replacementSession ?? base), ...this.#patch, turns }
    if (this.#usage.kind === 'base') {
      if (Object.hasOwn(base, 'usage')) Object.assign(result, { usage: base.usage })
      else Reflect.deleteProperty(result, 'usage')
    } else if (this.#usage.present) Object.assign(result, { usage: this.#usage.value })
    else Reflect.deleteProperty(result, 'usage')
    return this.#applyHostSeating ? seatedSession(result, this.#hostSeated) : result
  }
}
