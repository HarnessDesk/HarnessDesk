import type { AgentEvent } from './events.js'
import type { AgentItem, FileChange, ItemDelta } from './items.js'
import type { Session, Turn } from './session.js'
import type { TranscriptWatermark } from './wire.js'
import { preserveDeskContext } from './reduce.js'

type Fence = TranscriptWatermark
type Coverage = Fence & { readonly full: boolean; readonly identityValid: boolean }
type Delta = { assistantText?: string; commandOutput?: string; planText?: string; reasoningSummary?: Record<string, string>; reasoningSummaryParts?: number[]; reasoningText?: Record<string, string>; fileChanges?: FileChange[] }
type Item = { readonly id: string; replacement?: AgentItem; delta: Delta; candidates: Map<string, AgentItem>; deltaCandidates: Map<string, ItemDelta> }
type TurnState = { readonly id: string; metadata?: Omit<Turn, 'items'>; metadataCandidates: Map<string, Omit<Turn, 'items'>>; started?: boolean; diff?: string; plan?: Turn['plan']; diffCandidates: Map<string, string>; planCandidates: Map<string, NonNullable<Turn['plan']>>; items: Map<string, Item> }
type Notice = Omit<Extract<AgentEvent, { type: 'notice' }>, 'type' | 'sessionId'>
type NoticeState = Notice & { readonly lastEventId?: string; readonly completedAt?: number }
type ErrorData = Extract<AgentEvent, { type: 'error' }>['error']
type SessionData = Omit<Session, 'turns'>
type LocalLayout = { readonly fields: Readonly<Record<string, string>>; readonly turns: readonly { readonly id: string; readonly metadataKey: string; readonly items: readonly { readonly id: string; readonly valueKey: string }[] }[] }

// Same canonical JSON ordering used by transcript identity; arrays keep their order.
const canonical = (value: unknown): string => JSON.stringify(value, (_key, entry: unknown) => {
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return entry
  return Object.fromEntries(Object.entries(entry).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0))
}) ?? 'null'

// Held local objects can contain explicit undefined properties, unlike JSON
// wire values. Type-tag keys keep those distinct from null or absent fields.
const localKey = (value: unknown): string => {
  const encode = (entry: unknown): unknown => {
    if (entry === undefined) return ['undefined']
    if (entry === null) return ['null']
    if (Array.isArray(entry)) return ['array', entry.map(encode)]
    if (typeof entry === 'object') return ['object', Object.entries(entry).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => [key, encode(item)])]
    return [typeof entry, entry]
  }
  return JSON.stringify(encode(value))
}

const valid = (value: unknown): value is Fence => {
  if (!value || typeof value !== 'object') return false
  const v = value as Partial<Fence>
  return typeof v.epoch === 'string' && v.epoch.length > 0 && typeof v.generation === 'string' && v.generation.length > 0 &&
    Number.isSafeInteger(v.revision) && (v.revision ?? -1) >= 0 && Number.isSafeInteger(v.sequence) && (v.sequence ?? -1) >= 0
}

/** Typed semantic material only. This is not a complete Session or a replay log. */
class Material {
  readonly #turns = new Map<string, TurnState>()
  readonly #notices = new Map<string, NoticeState>()
  #lastTurn = ''
  readonly #errors = new Map<string, ErrorData>()
  readonly #sessions = new Map<string, SessionData>()
  #session?: SessionData
  #sessionFields: Record<string, unknown> = {}
  readonly #sessionFieldCandidates = new Map<string, Map<string, unknown>>()
  #field(name: string, value: unknown, quarantine: boolean, key?: string): void {
    if (!quarantine) { this.#sessionFields[name] = value; return }
    let candidates = this.#sessionFieldCandidates.get(name)
    if (!candidates) { candidates = new Map(); this.#sessionFieldCandidates.set(name, candidates) }
    candidates.set(key ?? canonical(value), value)
  }

  #turn(id: string): TurnState {
    let value = this.#turns.get(id)
    if (!value) { value = { id, items: new Map(), metadataCandidates: new Map(), diffCandidates: new Map(), planCandidates: new Map() }; this.#turns.set(id, value) }
    return value
  }
  #item(turnId: string, itemId: string): Item {
    const turn = this.#turn(turnId)
    let value = turn.items.get(itemId)
    if (!value) { value = { id: itemId, delta: {}, candidates: new Map(), deltaCandidates: new Map() }; turn.items.set(itemId, value) }
    return value
  }
  #candidate(turnId: string, incoming: AgentItem): void {
    const item = this.#item(turnId, incoming.id)
    item.candidates.set(canonical(incoming), incoming)
  }
  #turnEvent(turn: Turn, kind: 'start' | 'complete', quarantine: boolean): void {
    const target = this.#turn(turn.id), { items, ...metadata } = turn
    if (kind === 'start' && !quarantine && !target.started) this.#lastTurn = turn.id
    if (quarantine) target.metadataCandidates.set(canonical(metadata), metadata)
    else target.metadata = target.metadata ? { ...target.metadata, ...metadata } : metadata
    // Unknown-base capture cannot decide which completion list wins. Retain
    // deduplicated typed alternatives until a full covering snapshot arrives.
    const firstStart = kind === 'start' && !target.started
    const eligible = quarantine || kind === 'complete' || firstStart
    if (kind === 'start') target.started = true
    if (eligible) for (const item of items) {
      if (kind === 'complete' || quarantine) this.#candidate(turn.id, item)
      else if (this.#turn(turn.id).items.has(item.id)) this.#candidate(turn.id, item)
      else this.#replace(turn.id, item, false, false)
    }
  }
  #replace(turnId: string, incoming: AgentItem, complete: boolean, quarantine: boolean, ordered = false, preservePrior = false): void {
    const item = this.#item(turnId, incoming.id)
    if (quarantine && !ordered) { this.#candidate(turnId, incoming); return }
    const previous = item.replacement
    if (preservePrior && previous) this.#candidate(turnId, previous)
    let replacement = previous ? (preserveDeskContext([incoming], [previous])[0] ?? incoming) : incoming
    if (previous?.startedAt !== undefined && replacement.startedAt === undefined) replacement = { ...replacement, startedAt: previous.startedAt } as AgentItem
    item.replacement = replacement
    if (complete && !quarantine) {
      item.delta = {}
      // An unknown-base turn completion may have supplied the matching desk
      // context that replaceItem preserves. Keep possible carriers until the
      // covering snapshot; do not clear them just because an item completed.
      for (const [key, candidate] of item.candidates) {
        const carrier = incoming.type === 'userMessage' && candidate.type === 'userMessage' &&
          candidate.content.some(part => part.type === 'text' && part.deskContext !== undefined)
        if (!carrier) item.candidates.delete(key)
      }
    }
  }
  capture(event: AgentEvent, quarantine: boolean, ordered = false, preservePrior = false): void {
    switch (event.type) {
      case 'item/started': case 'item/completed': this.#replace(event.turnId, event.item, event.type === 'item/completed', quarantine, ordered, preservePrior); return
      case 'item/delta': {
        const item = this.#item(event.turnId, event.itemId), d = event.delta
        if (quarantine && !ordered) {
          if (d.kind !== 'toolProgress') item.deltaCandidates.set(canonical(d), d)
          return
        }
        const out = item.delta
        switch (d.kind) {
          case 'assistantText': out.assistantText = (out.assistantText ?? '') + d.text; break
          case 'commandOutput': out.commandOutput = (out.commandOutput ?? '') + d.chunk; break
          case 'planText': out.planText = (out.planText ?? '') + d.text; break
          case 'reasoningSummary': { const map = out.reasoningSummary ??= {}; map[d.index] = (map[d.index] ?? '') + d.text; break }
          case 'reasoningSummaryPart': { const parts = out.reasoningSummaryParts ??= []; if (!parts.includes(d.index)) parts.push(d.index); break }
          case 'reasoningText': { const map = out.reasoningText ??= {}; map[d.index] = (map[d.index] ?? '') + d.text; break }
          case 'fileChangePatch': { const paths = new Map((out.fileChanges ?? []).map(change => [change.path, change])); for (const change of d.changes) paths.set(change.path, change); out.fileChanges = [...paths.values()]; break }
          case 'toolProgress': break
        }
        return
      }
      case 'turn/started': case 'turn/completed': this.#turnEvent(event.turn, event.type === 'turn/started' ? 'start' : 'complete', quarantine && !ordered); return
      case 'turn/diff': { const turn = this.#turn(event.turnId); if (quarantine && !ordered) turn.diffCandidates.set(event.diff, event.diff); else turn.diff = event.diff; return }
      case 'turn/plan': { const turn = this.#turn(event.turnId); if (quarantine && !ordered) turn.planCandidates.set(canonical(event.steps), event.steps); else turn.plan = event.steps; return }
      case 'notice': {
        if (!event.sessionId || event.class === 'info' || event.class === 'result' || event.kind === 'runtime:config' || event.kind === 'runtime:deprecation') return
        const { type: _type, sessionId: _sessionId, ...notice } = event
        const contentKey = event.contentKey ?? JSON.stringify([event.kind ?? 'conversation:warning', event.message])
        const id = event.id ?? `notice:${contentKey}`
        if (quarantine && !ordered) {
          this.#notices.set(canonical([id, notice]), { ...notice, id }); return
        }
        // Across a gap, identical content keys may land on different unseen turns.
        // Keep distinct typed payloads; only identical notice material coalesces.
        const key = canonical([this.#lastTurn, contentKey, event.kind ?? null, event.level, event.message, event.detail ?? null]), previous = this.#notices.get(key)
        if (previous && (previous.id === id || previous.lastEventId === id)) return
        if (previous) this.#notices.set(key, { ...previous, count: (previous.count ?? 1) + 1, lastEventId: id, completedAt: event.at })
        else this.#notices.set(key, { ...notice, id, count: 1 })
        return
      }
      case 'error': {
        if (!event.sessionId) return
        // A local/conflicting callback may change retrying status without
        // changing its message; retain distinct typed alternatives.
        const key = quarantine ? canonical(event.error) : event.error.message
        if (!this.#errors.has(key)) this.#errors.set(key, event.error)
        return
      }
      case 'session/started': {
        const { turns, ...metadata } = event.session
        if (quarantine && !ordered) this.#sessions.set(canonical(metadata), metadata); else { this.#session = metadata; this.#lastTurn = turns.at(-1)?.id ?? '';  for (const turn of this.#turns.values()) turn.started = false }
        for (const turn of turns) this.#turnEvent(turn, 'complete', quarantine && !ordered)
        return
      }
      case 'session/status': this.#field('status', event.status, quarantine && !ordered); return
      case 'session/title': this.#field('title', event.title, quarantine && !ordered); return
      case 'session/settings': this.#field('settings', event.settings, quarantine && !ordered); return
      case 'session/options': this.#field('options', event.options, quarantine && !ordered); return
      case 'session/memory': this.#field('memory', event.enabled, quarantine && !ordered); return
      case 'session/goal': this.#field('goal', event.goal, quarantine && !ordered); return
      case 'usage/updated': this.#field('usage', event.usage, quarantine && !ordered); return
      case 'session/closed': this.#field('status', { type: 'idle' }, quarantine && !ordered); return
      case 'session/detached':
        this.#field('status', { type: 'idle' }, quarantine && !ordered)
        this.#field('detached', true, quarantine && !ordered)
        if (!quarantine || ordered) for (const turn of this.#turns.values()) if (turn.metadata?.status === 'inProgress') turn.metadata = { ...turn.metadata, status: 'interrupted' }
        return
      // These belong to their existing non-transcript owners.
      case 'session/queue': case 'session/tasks': case 'approval/requested': case 'approval/resolved':
      case 'limits/updated': case 'runtime/options': case 'catalog/changed': case 'account/loginCompleted':
      case 'account/loginAwaitsCode': case 'account/changed': return
      default: { const exhaustive: never = event; throw new Error(`Unexpected typed event ${String(exhaustive)}`) }
    }
  }
  /** Retain a locally held body as typed values, never as a wire event. */
  retainLocal(session: Session): void {
    const { turns, ...fields } = session
    for (const [name, value] of Object.entries(fields)) {
      if (name === 'updatedAt' && typeof value === 'number' && Number.isFinite(value)) {
        // Recency bookkeeping is summarized without inventing arrival order:
        // keep both observed extremes instead of a history of every timestamp.
        const prior = this.#sessionFieldCandidates.get(name)
        const times = [...(prior?.values() ?? []), value] as number[]
        const low = Math.min(...times), high = Math.max(...times)
        const range = new Map<string, unknown>([[canonical(low), low]])
        if (high !== low) range.set(canonical(high), high)
        this.#sessionFieldCandidates.set(name, range)
      } else this.#field(name, value, true, localKey(value))
    }
    for (const { items, ...metadata } of turns) {
      const turn = this.#turn(metadata.id)
      turn.metadataCandidates.set(localKey(metadata), metadata)
      for (const item of items) this.#item(metadata.id, item.id).candidates.set(localKey(item), item)
    }
  }
  forgetStructure(): void {
    this.#lastTurn = ''
    for (const turn of this.#turns.values()) turn.started = false
  }
  inspect() {
    return { session: this.#session, sessionCandidates: [...this.#sessions.values()], sessionFields: this.#sessionFields, sessionFieldCandidates: Object.fromEntries([...this.#sessionFieldCandidates].map(([name, values]) => [name, [...values.values()]])),
      turns: [...this.#turns.values()].map(turn => ({ id: turn.id, metadata: turn.metadata, metadataCandidates: [...turn.metadataCandidates.values()], diff: turn.diff, plan: turn.plan, diffCandidates: [...turn.diffCandidates.values()], planCandidates: [...turn.planCandidates.values()],
        items: [...turn.items.values()].map(item => ({ id: item.id, replacement: item.replacement, delta: item.delta, candidates: [...item.candidates.values()], deltaCandidates: [...item.deltaCandidates.values()] })) })),
      notices: [...this.#notices.values()], errors: [...this.#errors.values()] }
  }
}

/** Private prototype. It retains observed typed material but never builds a Session. */
export class PendingTranscript {
  readonly #runtime: string
  readonly #sessionId: string
  readonly #owner: object
  #material = new Material()
  #quarantine = new Material()
  #local = new Material()
  readonly #localLayouts = new Map<string, LocalLayout>()
  #hasLocal = false
  #fence: Fence | null = null
  #floor: Fence | null = null
  #last: string | null = null
  #unresolved = false
  constructor(options: { runtime: string; sessionId: string; owner: object }) {
    this.#runtime = options.runtime; this.#sessionId = options.sessionId; this.#owner = options.owner
  }
  observe(event: AgentEvent, fence: unknown, owner: object): 'accepted' | 'duplicate' | 'unresolved' | 'ignored' {
    const copy = structuredClone(event)
    // Non-transcript globally addressed side effects stay with their owners.
    const addressed = copy.type === 'session/started' ? copy.session.id : copy.type === 'approval/requested' ? copy.approval.sessionId : 'sessionId' in copy ? copy.sessionId : undefined
    if (addressed === undefined) return 'ignored'
    const serialized = canonical(copy)
    const sane = owner === this.#owner && addressed === this.#sessionId && (copy.type !== 'session/started' || copy.session.runtime === this.#runtime) && valid(fence) &&
      (!this.#fence || (fence.epoch === this.#fence.epoch && fence.generation === this.#fence.generation && fence.revision >= this.#fence.revision)) &&
      (!this.#floor || (fence.epoch === this.#floor.epoch && fence.generation === this.#floor.generation && fence.sequence > this.#floor.sequence && fence.revision >= this.#floor.revision))
    if (sane && this.#fence && fence.sequence === this.#fence.sequence && fence.revision === this.#fence.revision && serialized === this.#last) return 'duplicate'
    if (!sane || (this.#fence && valid(fence) && fence.sequence <= this.#fence.sequence)) {
      this.#unresolved = true
      // Without a fence, repeated append chunks are distinct possible work:
      // accumulate each occurrence instead of deduplicating by value. Other
      // unfenced operations remain unordered alternatives.
      const append = !valid(fence) && copy.type === 'item/delta' &&
        (copy.delta.kind === 'assistantText' || copy.delta.kind === 'commandOutput' || copy.delta.kind === 'planText' ||
         copy.delta.kind === 'reasoningSummary' || copy.delta.kind === 'reasoningText')
      this.#quarantine.capture(copy, true, append)
      if (!valid(fence) && copy.type === 'session/started' && owner === this.#owner && copy.session.runtime === this.#runtime && copy.session.id === this.#sessionId) {
        this.#local.forgetStructure()
        this.retainLocal(copy.session, owner)
      }
      return 'unresolved'
    }
    const previous = this.#fence ?? this.#floor
    if (previous && valid(fence) && fence.sequence > previous.sequence + 1) { this.#material.forgetStructure(); this.#quarantine.forgetStructure() }
    this.#fence = structuredClone(fence as Fence); this.#last = serialized
    if (this.#unresolved) { this.#quarantine.capture(copy, true, true); return 'unresolved' }
    this.#material.capture(copy, false)
    return 'accepted'
  }
  /** Capture the Host's ordered local callback, before any wire cursor exists. */
  observeLocal(event: AgentEvent, owner: object): 'accepted' | 'ignored' | 'refused' {
    const copy = structuredClone(event)
    const addressed = copy.type === 'session/started' ? copy.session.id : copy.type === 'approval/requested' ? copy.approval.sessionId : 'sessionId' in copy ? copy.sessionId : undefined
    if (owner !== this.#owner || (addressed !== undefined && addressed !== this.#sessionId) ||
        (copy.type === 'session/started' && copy.session.runtime !== this.#runtime)) return 'refused'
    if (addressed === undefined) return 'ignored'
    if (copy.type === 'session/started') {
      // A real replay can replace the prior turn set. Keep its material, but
      // do not assume an earlier turn/start still describes the current body.
      this.#local.forgetStructure()
      return this.retainLocal(copy.session, owner) ? 'accepted' : 'refused'
    }
    this.#local.capture(copy, true, true, true)
    this.#hasLocal = true
    return 'accepted'
  }
  /** Own a held local body without inventing any event, cursor, or order. */
  retainLocal(session: Session, owner: object): boolean {
    if (owner !== this.#owner || session.runtime !== this.#runtime || session.id !== this.#sessionId) return false
    const copy = structuredClone(session)
    this.#local.retainLocal(copy)
    // Layouts point at deduplicated typed values, preserving exact held turn
    // order and repeated item identities without keeping full body snapshots.
    const { turns, updatedAt: _updatedAt, ...fields } = copy
    const layout: LocalLayout = {
      fields: Object.fromEntries(Object.entries(fields).map(([name, value]) => [name, localKey(value)])),
      turns: turns.map(({ items, ...turn }) => ({
        id: turn.id, metadataKey: localKey(turn), items: items.map(item => ({ id: item.id, valueKey: localKey(item) })),
      })),
    }
    this.#localLayouts.set(localKey(layout), layout)
    this.#hasLocal = true
    return true
  }
  /** Read-only copy: no protected value is shared with the caller. */
  inspect() {
    return structuredClone({ runtime: this.#runtime, sessionId: this.#sessionId, unresolved: this.#unresolved,
      watermark: this.#fence, ...this.#material.inspect(), quarantine: this.#quarantine.inspect(), local: this.#local.inspect(), localLayouts: [...this.#localLayouts.values()], hasLocal: this.#hasLocal })
  }
  /** The caller validates a full atomic snapshot and preserves richer local data first. */
  retire(snapshot: Coverage | null, owner: object, localDataHandled: boolean): boolean {
    if (!snapshot || !valid(snapshot) || !snapshot.full || !snapshot.identityValid || !localDataHandled || owner !== this.#owner || this.#unresolved || this.#hasLocal || !this.#fence ||
      snapshot.epoch !== this.#fence.epoch || snapshot.generation !== this.#fence.generation || snapshot.sequence < this.#fence.sequence || snapshot.revision < this.#fence.revision) return false
    this.#floor = { epoch: snapshot.epoch, generation: snapshot.generation, revision: snapshot.revision, sequence: snapshot.sequence }
    this.#material = new Material(); this.#quarantine = new Material(); this.#fence = null; this.#last = null
    return true
  }
}
