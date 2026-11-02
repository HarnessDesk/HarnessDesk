import { applyDelta, preserveDeskContext, type AgentEvent, type AgentItem, type FileChange, type ItemDelta, type PlanStep, type Session, type SessionId } from '@harnessdesk/protocol'

/** Coalesces one item's pending deltas by logical field, never by event count. */
export class PendingItemDeltas {
  readonly #operations = new Map<string, ItemDelta>()
  readonly #changes = new Map<string, FileChange>()

  get operationCount(): number { return this.#operations.size + this.#changes.size }
  /** UTF-8 serialized pending data estimate, not heap or RSS. */
  get protectedBytes(): number { return new TextEncoder().encode(JSON.stringify([[...this.#operations.values()], [...this.#changes.values()]])).byteLength }

  add(delta: ItemDelta): void {
    switch (delta.kind) {
      case 'assistantText':
      case 'planText': {
        const previous = this.#operations.get(delta.kind)
        const text = previous && previous.kind === delta.kind ? previous.text : ''
        this.#operations.set(delta.kind, { ...delta, text: text + delta.text })
        break
      }
      case 'commandOutput': {
        const previous = this.#operations.get(delta.kind)
        const chunk = previous?.kind === 'commandOutput' ? previous.chunk : ''
        this.#operations.set(delta.kind, { ...delta, chunk: chunk + delta.chunk })
        break
      }
      case 'reasoningSummary':
      case 'reasoningText': {
        const key = `${delta.kind}:${delta.index}`
        const previous = this.#operations.get(key)
        const text = previous && previous.kind === delta.kind ? previous.text : ''
        this.#operations.set(key, { ...delta, text: text + delta.text })
        break
      }
      case 'reasoningSummaryPart':
        this.#operations.set(`${delta.kind}:${delta.index}`, delta)
        break
      case 'fileChangePatch':
        for (const change of delta.changes) this.#changes.set(change.path, change)
        break
      case 'toolProgress':
        // The canonical reducer intentionally treats progress as a no-op.
        break
      default: {
        const exhaustive: never = delta
        throw new Error(`Unknown pending item delta: ${String(exhaustive)}`)
      }
    }
  }

  apply(item: AgentItem): AgentItem {
    let result = item
    for (const delta of this.#operations.values()) result = applyDelta(result, delta)
    if (this.#changes.size) result = applyDelta(result, { kind: 'fileChangePatch', changes: [...this.#changes.values()] })
    return result
  }
}

/** Coalesces replacement and delta operations for one item while its base is unavailable. */
export class PendingItemChanges {
  #replacement: AgentItem | undefined
  #baseContextMaySurvive = true
  #deltas = new PendingItemDeltas()

  get operationCount(): number { return this.#deltas.operationCount + (this.#replacement ? 1 : 0) }

  replace(item: AgentItem): void {
    const previous = this.#replacement
    if (previous) {
      // Once a replacement loses the prior user's context, a later matching
      // string cannot resurrect context from the unavailable original item.
      if (previous.type !== 'userMessage' || item.type !== 'userMessage') this.#baseContextMaySurvive = false
      else {
        const index = previous.content.findIndex(part => part.type === 'text')
        if (index < 0) this.#baseContextMaySurvive = false
        else {
          const marked = { ...previous, content: previous.content.map((part, i) => i === index && part.type === 'text'
            ? { ...part, deskContext: { prefixLength: 0 } } : part) }
          const preserved = preserveDeskContext([item], [marked])[0]
          if (preserved?.type !== 'userMessage' || !preserved.content.some(part => part.type === 'text' && part.deskContext !== undefined)) this.#baseContextMaySurvive = false
        }
      }
    }
    const next = previous ? (preserveDeskContext([item], [previous])[0] ?? item) : item
    this.#replacement = previous?.startedAt !== undefined && next.startedAt === undefined
      ? { ...next, startedAt: previous.startedAt } as AgentItem : next
    this.#deltas = new PendingItemDeltas()
  }

  add(delta: ItemDelta): void { this.#deltas.add(delta) }

  apply(base: AgentItem | undefined): AgentItem | undefined {
    let item = this.#replacement
    if (item && base) {
      if (this.#baseContextMaySurvive) item = preserveDeskContext([item], [base])[0] ?? item
      if (item.startedAt === undefined && base.startedAt !== undefined) item = { ...item, startedAt: base.startedAt } as AgentItem
    }
    item ??= base
    return item ? this.#deltas.apply(item) : undefined
  }
}

/** Item-only operations on one turn; turn lifecycle barriers are handled separately. */
export class PendingTurnItems {
  readonly #items = new Map<string, { changes: PendingItemChanges; firstReplacement: number | null }>()
  #ordinal = 0

  get operationCount(): number {
    let count = 0
    for (const value of this.#items.values()) count += value.changes.operationCount
    return count
  }

  add(event: { type: 'item/started' | 'item/completed'; item: AgentItem } | { type: 'item/delta'; itemId: AgentItem['id']; delta: ItemDelta }): void {
    const id = event.type === 'item/delta' ? event.itemId : event.item.id
    let entry = this.#items.get(id)
    if (!entry) { entry = { changes: new PendingItemChanges(), firstReplacement: null }; this.#items.set(id, entry) }
    if (event.type === 'item/delta') entry.changes.add(event.delta)
    else {
      entry.firstReplacement ??= this.#ordinal++
      entry.changes.replace(event.item)
    }
  }

  apply(items: readonly AgentItem[]): readonly AgentItem[] {
    const remaining = new Map(this.#items)
    const result = items.map(item => {
      const entry = remaining.get(item.id)
      remaining.delete(item.id)
      return entry?.changes.apply(item) ?? item
    })
    const additions = [...remaining.values()].filter(entry => entry.firstReplacement !== null)
      .sort((a, b) => a.firstReplacement! - b.firstReplacement!)
    for (const entry of additions) {
      const item = entry.changes.apply(undefined)
      if (item) result.push(item)
    }
    return result
  }
}

/** Item and turn-metadata operations; lifecycle barriers need separate fencing. */
export class PendingTranscriptItems {
  #sessionId: SessionId | undefined
  readonly #turns = new Map<string, { items: PendingTurnItems; diff?: string; plan?: readonly PlanStep[] }>()

  add(event: AgentEvent): void {
    if (event.type !== 'item/started' && event.type !== 'item/completed' && event.type !== 'item/delta' &&
        event.type !== 'turn/diff' && event.type !== 'turn/plan') {
      throw new Error('Event requires a lifecycle-aware overlay')
    }
    if (this.#sessionId !== undefined && this.#sessionId !== event.sessionId) throw new Error('Pending event belongs to another session')
    this.#sessionId = event.sessionId
    let turn = this.#turns.get(event.turnId)
    if (!turn) { turn = { items: new PendingTurnItems() }; this.#turns.set(event.turnId, turn) }
    if (event.type === 'turn/diff') turn.diff = event.diff
    else if (event.type === 'turn/plan') turn.plan = event.steps
    else turn.items.add(event)
  }

  apply(session: Session): Session {
    if (session.id !== this.#sessionId) return session
    return { ...session, turns: session.turns.map(turn => {
      const pending = this.#turns.get(turn.id)
      return pending ? { ...turn, items: pending.items.apply(turn.items),
        ...(pending.diff === undefined ? {} : { diff: pending.diff }),
        ...(pending.plan === undefined ? {} : { plan: pending.plan }) } : turn
    }) }
  }
}
