import { dirname, join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'

import type {
  RuntimeId,
  Session,
  SessionId,
  SessionSource,
  SessionSummary,
  SessionUsage,
  TranscriptHit,
  Turn,
  AgentItem,
  TurnInsightContext,
} from '@harnessdesk/protocol'
import { PendingTranscript, canonicalTranscriptBody, isNoticeTurn, openingOfContent, preserveDeskContext, preserveNoticeItems, typedUserText } from '@harnessdesk/protocol'

import { decodeBody, durableStateIdentity, InvalidTranscriptBodyError, NewerTranscriptFormatError, readTranscriptFacts, TranscriptDatabase, TOOL_INDEX_CAP } from './transcript-database.js'
import { DailySessionSnapshots } from './session-snapshots.js'
import { publicationsIn, withPublications } from './publications.js'

/** The runtime has no retained transcript store yet (or it became unavailable). */
export class MissingTranscriptRuntimeError extends Error {}

/**
 * The transcript the host watched, kept.
 *
 * Backends are lossy about their own history. Codex's `thread/read` rebuilds
 * a turn from the rollout with only the messages and file changes in it —
 * its protocol says so: "we explicitly do not persist all agent interactions,
 * such as command executions". The seventy-six steps a person watched become
 * four the next morning. The host folded every one of those events into a
 * session as they happened (`SessionRegistry`), so it already holds the full
 * transcript; this writes that down and reads it back.
 *
 * Turn and item rows in the index's `<state>/sessions.sqlite`,
 * written a beat after the last event and at once when a turn completes. On
 * a read, the backend's turns are *enriched*, not replaced: a turn with the
 * same id whose stored copy knows more items takes the stored items, and the
 * backend's own status, timestamps and diff win wherever it has them. A turn
 * the backend no longer lists — after a rollback — is not brought back.
 *
 * The last token figures ride along for the same reason. Every adapter holds
 * its usage on the live session handle, which is gone the moment the host
 * restarts — so before this, *every* agent came back from a restart with the
 * context ring out until the next turn, and no backend will answer a read
 * with the tokens it once reported. This is the only place the host remembers
 * them, and `enrich` the only place it hands them back.
 */

export interface Stored {
  readonly version: 1
  readonly runtime: RuntimeId
  readonly id: SessionId
  readonly savedAt: number
  readonly turns: readonly Turn[]
  /**
   * The last usage the runtime reported, true as of the final turn above.
   * Optional: transcripts written before this existed simply have none, which
   * is why the format is not bumped — an old file is still a good transcript.
   */
  readonly usage?: SessionUsage | null
  /**
   * Enough of the session's face to make a search hit presentable without
   * asking the runtime — a hit is only useful if it can say which conversation
   * it is from. Optional for the same reason as `usage`: files written before
   * these existed are still good transcripts, they just introduce themselves
   * with less.
   */
  readonly title?: string | null
  readonly preview?: string | null
  readonly cwd?: string
  readonly createdAt?: number
  readonly updatedAt?: number
  /** Optional historical observation metadata; old transcript files deliberately read without it. */
  readonly insight?: readonly TurnInsightContext[]
}

const FORMAT = 1
const SETTLE_MS = 800

/** A backup is incomplete if the conversation database could not be read. */
const unexported = (error: unknown): Error =>
  new Error(
    `The backup was not made: the conversations this desk keeps could not all be read — ${
      error instanceof Error ? error.message : String(error)
    }. A backup without them would still look complete, and could not bring them back. Fix that store, then export again.`,
    { cause: error },
  )

/**
 * How a stored turn is recognised in a fresh read.
 *
 * Turn ids are minted by counter, and a replay that segments the conversation
 * differently mints different ones: the id "turn-1" names nine steps of work
 * today and a one-line notice tomorrow, and matching on it pastes the work
 * onto the notice while the replay's own copy stands beside it — the same
 * conversation twice. Tool-call ids are the runtime's own and survive any
 * segmentation, so content claims first: a stored turn belongs to the read
 * turn that carries its calls. The id is only trusted where content is
 * silent on both sides — a stored turn whose calls a lossy read dropped
 * entirely (Codex keeps four items of seventy-six) still matches by id, but
 * never one whose calls the read placed somewhere else.
 */
const pairTurns = (
  read: readonly Turn[],
  stored: readonly Turn[],
): ReadonlyMap<Turn, Turn> => {
  const ownerOf = new Map<string, Turn>()
  for (const turn of stored) {
    for (const item of turn.items) {
      if (item.type === 'toolCall') ownerOf.set(String(item.id), turn)
    }
  }
  const claims = new Map<Turn, Set<Turn>>()
  const carried = new Map<Turn, Set<Turn>>()
  for (const turn of read) {
    for (const item of turn.items) {
      if (item.type !== 'toolCall') continue
      const owner = ownerOf.get(String(item.id))
      if (!owner) continue
      const claim = claims.get(owner) ?? new Set<Turn>()
      claim.add(turn)
      claims.set(owner, claim)
      const carries = carried.get(turn) ?? new Set<Turn>()
      carries.add(owner)
      carried.set(turn, carries)
    }
  }
  const byId = new Map(stored.map((turn) => [turn.id, turn]))
  const pairs = new Map<Turn, Turn>()
  for (const turn of read) {
    const owners = carried.get(turn)
    if (owners) {
      // One stored turn, wholly here: a pair. Split or merged across other
      // read turns, the read's own segmentation wins and nothing is pasted.
      if (owners.size !== 1) continue
      const owner = [...owners][0] as Turn
      if (claims.get(owner)?.size === 1) pairs.set(turn, owner)
      continue
    }
    const sameId = byId.get(turn.id)
    if (sameId && !claims.has(sameId)) pairs.set(turn, sameId)
  }
  return pairs
}

/** Restore message records without copying the stored turn segmentation. */
const withDeskContext = (turns: readonly Turn[], stored: readonly Turn[]): readonly Turn[] => {
  const readItems = turns.flatMap(turn => turn.items)
  const recordedItems = preserveDeskContext(readItems, stored.flatMap(turn => turn.items))
  if (recordedItems === readItems) return turns
  let offset = 0
  return turns.map(turn => {
    const items = recordedItems.slice(offset, offset + turn.items.length)
    offset += turn.items.length
    return items.every((item, index) => item === turn.items[index]) ? turn : { ...turn, items }
  })
}

/**
 * The stored usage to put back on a read, or null to leave the read alone.
 *
 * Two conditions, both necessary. The read must have carried none: a runtime
 * that still holds the live figures is the authority, and the store never
 * argues with it. And the conversation must not have moved on — the number is
 * only true as of the last turn the host watched, so if the backend now ends
 * on a different turn, because someone carried the conversation on in Codex
 * Desktop or the Claude CLI, the figure describes a context that no longer
 * exists. There the ring stays out until the next turn reports a real one: a
 * wrong number near the limit is worse than no number at all, which is the
 * same rule that gives Cursor a dashed ring rather than a guess.
 */
const restorableUsage = (
  session: Session,
  stored: Stored,
  pairs: ReadonlyMap<Turn, Turn>,
): SessionUsage | null => {
  if (session.usage) return null
  if (!stored.usage) return null
  const last = session.turns.at(-1)
  const lastStored = stored.turns.at(-1)
  if (last === undefined || lastStored === undefined) return null
  return pairs.get(last) === lastStored ? stored.usage : null
}

/**
 * One session's key in the store's queues. Spelled once: `forget()` built it
 * with a space where `record()` used a NUL, so the write still queued for a
 * deleted conversation was never found, and it wrote the transcript back a
 * moment after the delete (#36).
 */
const keyOf = (runtime: RuntimeId, id: SessionId): string => `${runtime}\0${id}`
export type DurableTranscriptBase = { readonly kind: 'missing' } | { readonly kind: 'body'; readonly identity: string }
type PendingWrite = { timer: ReturnType<typeof setTimeout>; session: Session; insight: readonly TurnInsightContext[]; generation?: string; revision?: number; authorityEpoch?: number }

const sameStoredSessionFacts = (stored: Stored, session: Session): boolean =>
  (['title', 'preview', 'cwd', 'createdAt', 'updatedAt', 'usage'] as const)
    .every(field => isDeepStrictEqual(stored[field] ?? null, session[field] ?? null))

export class TranscriptStore {
  readonly #pending = new Map<string, PendingWrite>()
  readonly #generationConflicts = new Map<string, { owner: object; capture: PendingTranscript }>()
  readonly #writes = new Map<string, Promise<boolean>>()
  readonly #settling = new Map<string, Promise<void>>()
  /** A failed save must not reuse an older body's stamp or timestamp on retry. */
  readonly #failedWrites = new Set<string>()
  /** A failed CAS quarantines later ordinary writes until explicit reconciliation. */
  readonly #protectedWrites = new Set<string>()
  readonly #protectedNotified = new Set<string>()
  readonly #unboundWrites = new Set<string>()
  readonly #retryHeld = new Map<string, PendingWrite>()
  readonly #authorities = new Map<string, { generation: string; base: DurableTranscriptBase }>()
  readonly #verifiedRows = new Map<string, string>()
  readonly #readBases = new WeakMap<Session, DurableTranscriptBase>()
  readonly #insight = new Map<string, readonly TurnInsightContext[]>()
  readonly #database: TranscriptDatabase
  readonly #snapshots: DailySessionSnapshots

  constructor(
    directory: string,
    private readonly log: (message: string, details?: Record<string, unknown>) => void = () => {},
    private readonly onWrite: () => void = () => {},
    private readonly generationCurrent: (runtime: RuntimeId, id: SessionId, generation: string, session: Session, revision?: number, authorityEpoch?: number, allowPartial?: boolean) => boolean = () => true,
    private readonly baseAdvanced: (runtime: RuntimeId, id: SessionId, generation: string, base: DurableTranscriptBase) => void = () => {},
    private readonly onProtected: (runtime: RuntimeId, id: SessionId) => void = () => {},
    private readonly onDurableChange: (runtime: RuntimeId, id: SessionId, kind?: 'import') => void = () => {},
  ) {
    this.#database = new TranscriptDatabase(join(dirname(directory), 'sessions.sqlite'))
    this.#snapshots = new DailySessionSnapshots(this.#database.file, {
      onError: error => this.log('conversation snapshot not saved', { error: String(error) }),
    })
    this.#snapshots.schedule()
  }

  #notifyProtected(session: Session): void {
    const key = keyOf(session.runtime, session.id)
    this.#protectedWrites.add(key)
    if (!this.#protectedNotified.has(key)) {
      this.#protectedNotified.add(key)
      this.onProtected(session.runtime, session.id)
    }
  }

  forgetMemory(rows: readonly { runtime: RuntimeId; id: SessionId }[]): void {
    for (const row of rows) {
      const key = keyOf(row.runtime, row.id)
      if (this.#protectedWrites.has(key) || this.#unboundWrites.has(key)) continue
      const pending = this.#pending.get(key)
      if (pending) clearTimeout(pending.timer)
      this.#pending.delete(key)
      this.#insight.delete(key)
      this.#failedWrites.delete(key)
    }
  }

  /** Logical pending-body pressure; excludes heap overhead and never exports payloads. */
  protectedPressure(): { bodies: number; bytes: number } {
    let bodies = 0, bytes = 0
    for (const key of new Set([...this.#protectedWrites, ...this.#unboundWrites])) {
      for (const entry of [this.#pending.get(key), this.#retryHeld.get(key)]) if (entry) {
        bodies++
        const { turns, ...metadata } = entry.session
        bytes += canonicalTranscriptBody(turns).bytes + Buffer.byteLength(JSON.stringify([metadata, entry.insight]), 'utf8')
      }
    }
    return { bodies, bytes }
  }

  /** Copies of unsaved bodies owned by this exact record incarnation. */
  pendingBodies(runtime: RuntimeId, id: SessionId, generation: string, epoch: number): readonly Session[] {
    const key = keyOf(runtime, id), bodies: Session[] = []
    for (const pending of [this.#pending.get(key), this.#retryHeld.get(key)]) {
      if (pending?.generation === generation && pending.authorityEpoch === epoch) bodies.push(structuredClone(pending.session))
    }
    return bodies
  }

  /** Quarantine owned pending bodies before a conflicting replay can replace them. */
  protectPending(runtime: RuntimeId, id: SessionId, generation: string, epoch: number): boolean {
    const key = keyOf(runtime, id)
    const owned = [this.#pending.get(key), this.#retryHeld.get(key)].filter((pending): pending is PendingWrite =>
      !!pending && pending.generation === generation && pending.authorityEpoch === epoch)
    if (!owned.length) return false
    for (const pending of owned) clearTimeout(pending.timer)
    this.#notifyProtected(owned[0]!.session)
    return true
  }

  /** Carry the same host-owned fields that item completion preserves before comparing replay. */
  replayWithPendingMetadata(replay: Session, generation: string, epoch: number): Session {
    const pending = this.pendingBodies(replay.runtime, replay.id, generation, epoch)
    if (!replay.itemsLoaded || !pending.length) return replay
    const turns = replay.turns.map(turn => {
      const held = pending.flatMap(body => body.turns.filter(candidate => candidate.id === turn.id))
      if (held.length !== 1) return turn
      const items = turn.items.map(item => {
        const matches = held[0]!.items.filter(candidate => candidate.id === item.id)
        if (matches.length !== 1) return item
        const previous = matches[0]!
        const notice = previous.type === 'notice' && item.type === 'userMessage' && item.content.length === 1 &&
          item.content[0]?.type === 'text' && item.content[0].text === previous.text
          ? preserveNoticeItems([item], [previous], true)[0] ?? item : item
        const classified = preserveDeskContext([notice], [previous])[0] ?? notice
        return classified.startedAt === undefined && previous.startedAt !== undefined
          ? { ...classified, startedAt: previous.startedAt } : classified
      })
      return { ...turn, items }
    })
    return { ...replay, turns }
  }

  /** Detect, without choosing a winner, when a replay conflicts with unsaved items. */
  pendingReplayConflict(replay: Session, generation: string, epoch: number, held?: Session): boolean {
    if (!replay.itemsLoaded) return false
    replay = this.replayWithPendingMetadata(replay, generation, epoch)
    const bodies = [...this.pendingBodies(replay.runtime, replay.id, generation, epoch)]
    if (bodies.length && held && held.runtime === replay.runtime && held.id === replay.id) bodies.push(held)
    for (const body of bodies) {
      const byTurn = new Map(body.turns.map(turn => [turn.id, turn]))
      for (const turn of replay.turns) {
        const saved = byTurn.get(turn.id)
        if (!saved) continue
        const byItem = new Map<string, AgentItem[]>()
        for (const item of saved.items) {
          const group = byItem.get(String(item.id)) ?? []
          group.push(item); byItem.set(String(item.id), group)
        }
        if (turn.items.some(item => byItem.get(String(item.id))?.some(previous => {
          if (isDeepStrictEqual(previous, item)) return false
          if (previous.type !== 'assistantMessage' || item.type !== 'assistantMessage' || !item.text.startsWith(previous.text)) return true
          const { text: _oldText, ...oldFields } = previous
          const { text: _newText, ...newFields } = item
          return !isDeepStrictEqual(oldFields, newFields)
        }))) return true
      }
    }
    return false
  }

  /** Unsaved turns belong to this exact record incarnation, not a later one. */
  pendingTurnIds(runtime: RuntimeId, id: SessionId, generation: string, epoch: number): ReadonlySet<string> {
    const key = keyOf(runtime, id), ids = new Set<string>()
    for (const pending of [this.#pending.get(key), this.#retryHeld.get(key)]) {
      if (pending?.generation !== generation || pending.authorityEpoch !== epoch) continue
      for (const turn of pending.session.turns) ids.add(String(turn.id))
    }
    return ids
  }

  hasGenerationConflict(runtime: RuntimeId, id: SessionId): boolean {
    return this.#generationConflicts.has(keyOf(runtime, id))
  }

  /** Any owner or in-flight writer prevents treating a registry fold as a durable no-op. */
  hasOutstandingWrite(runtime: RuntimeId, id: SessionId): boolean {
    const key = keyOf(runtime, id)
    return this.#pending.has(key) || this.#retryHeld.has(key) || this.#writes.has(key) || this.#settling.has(key) ||
      this.#protectedWrites.has(key) || this.#unboundWrites.has(key) || this.#generationConflicts.has(key)
  }

  hasProtectedChanges(runtime: RuntimeId, id: SessionId): boolean {
    const key = keyOf(runtime, id)
    return this.#protectedWrites.has(key) || this.#unboundWrites.has(key) || this.#retryHeld.has(key)
  }

  /** No previous writer or authority may be displaced by an unsolicited initial event. */
  mayObserveInitialBase(session: Session): boolean {
    const key = keyOf(session.runtime, session.id)
    return !this.#authorities.has(key) && !this.#pending.has(key) && !this.#retryHeld.has(key) &&
      !this.#writes.has(key) && !this.#settling.has(key) && !this.#protectedWrites.has(key) && !this.#unboundWrites.has(key)
  }

  /** Only this record's unbound snapshot can acquire a newly observed missing base. */
  ownsUnboundWrite(session: Session, generation: string, epoch: number): boolean {
    const key = keyOf(session.runtime, session.id), pending = this.#pending.get(key)
    return this.#unboundWrites.has(key) && !this.#protectedWrites.has(key) && !this.#writes.has(key) &&
      !this.#retryHeld.has(key) && !this.#settling.has(key) &&
      (!this.#authorities.has(key) || (this.#authorities.get(key)?.generation !== generation && this.#authorities.get(key)?.base.kind === 'missing')) &&
      pending?.generation === generation && pending.authorityEpoch === epoch && isDeepStrictEqual(pending.session, session)
  }

  evictCached(cap: number, live: (runtime: RuntimeId, id: SessionId) => boolean): { count: number; bytes: number } {
    const result = this.#database.evictCached(cap, (runtime, id) => this.#protectedWrites.has(keyOf(runtime, id)) || this.#unboundWrites.has(keyOf(runtime, id)) || live(runtime, id))
    for (const row of result.removed) this.onDurableChange(row.runtime, row.id)
    this.forgetMemory(result.removed)
    return { count: result.count, bytes: result.bytes }
  }

  /**
   * Notes the session's current transcript for writing. `now` skips the
   * settle delay — the end of a turn is worth a write of its own.
   */
  record(session: Session, options: { readonly now?: boolean; readonly insight?: readonly TurnInsightContext[]; readonly generation?: string; readonly revision?: number; readonly authorityEpoch?: number } = {}): void {
    if (!session.itemsLoaded || this.#database.isRemoved(session.runtime, session.id)) return
    if (!session.turns.some((turn) => turn.items.length > 0) && !(options.insight?.length)) return
    const key = keyOf(session.runtime, session.id)
    let conflict = this.#generationConflicts.get(key)
    const earlier = [this.#pending.get(key), this.#retryHeld.get(key)].filter((entry): entry is PendingWrite => !!entry)
    if (!conflict && earlier.some(entry => entry.generation !== options.generation || entry.authorityEpoch !== options.authorityEpoch)) {
      const owner = {}, capture = new PendingTranscript({ runtime: String(session.runtime), sessionId: String(session.id), owner })
      for (const entry of earlier) {
        clearTimeout(entry.timer)
        if (!capture.retainLocal(entry.session, owner)) throw new Error('Cannot protect an earlier conversation generation')
      }
      conflict = { owner, capture }; this.#generationConflicts.set(key, conflict)
      this.#notifyProtected(session)
    }
    if (conflict) {
      if (!conflict.capture.retainLocal(session, conflict.owner)) throw new Error('Cannot protect conversation activity')
      return
    }
    if (options.generation && this.#authorities.get(key)?.generation !== options.generation) this.#unboundWrites.add(key)
    if (options.insight?.length) {
      const previous = this.#insight.get(key) ?? []
      const byTurn = new Map(previous.map((context) => [context.turn, context]))
      for (const context of options.insight) byTurn.set(context.turn, context)
      this.#insight.set(key, [...byTurn.values()].slice(-2000))
    }
    const pending = this.#pending.get(key)
    if (pending) clearTimeout(pending.timer)
    const timer = setTimeout(() => {
      if (this.#protectedWrites.has(key)) return
      void this.#settle(session.runtime, session.id).catch(() => {})
    }, options.now ? 0 : SETTLE_MS)
    this.#pending.set(key, { timer, session, insight: this.#insight.get(key) ?? [], generation: options.generation, revision: options.revision, authorityEpoch: options.authorityEpoch })
  }

  bindBase(session: Session, generation: string, base: DurableTranscriptBase): void {
    const key = keyOf(session.runtime, session.id)
    this.#authorities.set(key, { generation, base })
    const pending = this.#pending.get(key)
    if (!pending || pending.generation === generation) this.#unboundWrites.delete(key)
    if (pending?.generation === generation && !this.#protectedWrites.has(key)) {
      this.record(pending.session, { insight: pending.insight, generation, revision: pending.revision, authorityEpoch: pending.authorityEpoch })
    }
  }

  rememberReadBase(session: Session, base: DurableTranscriptBase | undefined): void {
    if (base) this.#readBases.set(session, base)
  }

  readBase(session: Session): DurableTranscriptBase | undefined { return this.#readBases.get(session) }

  unbindBase(session: Session, generation: string): void {
    const key = keyOf(session.runtime, session.id)
    if (this.#authorities.get(key)?.generation === generation && !this.#pending.has(key) && !this.#writes.has(key) && !this.#retryHeld.has(key) &&
        !this.#settling.has(key) && !this.#protectedWrites.has(key) && !this.#unboundWrites.has(key) && !this.#generationConflicts.has(key)) {
      this.#authorities.delete(key)
      this.#verifiedRows.delete(key)
    }
  }

  /** Caller supplies fresh-creation authority before a missing row can be trusted. */
  observeBase(session: Session, allowMissing: boolean): DurableTranscriptBase | undefined {
    const key = keyOf(session.runtime, session.id)
    if (this.#writes.has(key) || this.#protectedWrites.has(key) || !session.itemsLoaded) return undefined
    try {
      const observed = this.#database.observe(session.runtime, session.id)
      if (observed.removed) return undefined
      if (!observed.bodyPresent) return allowMissing ? { kind: 'missing' } : undefined
      const stored = observed.stored
      if (!stored || !observed.identity || !sameStoredSessionFacts(stored, session) || canonicalTranscriptBody(stored.turns).canonical !== canonicalTranscriptBody(session.turns).canonical) return undefined
      return { kind: 'body', identity: observed.identity }
    } catch { return undefined }
  }

  /** Adopt only the current generation's exact queued snapshot, then CAS its base. */
  async releaseFromBase(session: Session, generation: string, base: DurableTranscriptBase, authorityEpoch?: number): Promise<boolean> {
    const key = keyOf(session.runtime, session.id), pending = this.#pending.get(key)
    const current = () => this.generationCurrent(session.runtime, session.id, generation, session, undefined, authorityEpoch)
    if (!current() || this.#retryHeld.has(key) || this.#writes.has(key)) return false
    if (!pending) {
      const saved = await this.#persistEvolvedBody(session, base, [], current, undefined, true)
      if (saved && current() && this.#advanceBase(session, generation)) return true
      if (saved) this.#notifyProtected(session)
      return false
    }
    if (pending.generation !== generation || pending.authorityEpoch !== authorityEpoch || !isDeepStrictEqual(pending.session, session)) return false
    clearTimeout(pending.timer); this.#pending.delete(key); this.#retryHeld.set(key, pending)
    const saved = await this.#persistEvolvedBody(session, base, pending.insight, current, pending, false, identity => {
      const next = this.#pending.get(key), authority = this.#authorities.get(key)
      if (!next || next.generation !== generation || next.authorityEpoch !== authorityEpoch || authority?.generation !== generation ||
          !isDeepStrictEqual(authority.base, base) || !this.generationCurrent(session.runtime, session.id, generation, next.session, next.revision, authorityEpoch) ||
          !this.#bodyExtends(session, next.session)) return false
      const verified: DurableTranscriptBase = { kind: 'body', identity }
      authority.base = verified
      this.baseAdvanced(session.runtime, session.id, generation, verified)
      this.#retryHeld.delete(key); this.#protectedWrites.delete(key); this.#protectedNotified.delete(key)
      this.record(next.session, { insight: next.insight, generation, revision: next.revision, authorityEpoch })
      return true
    })
    if (saved && current() && this.#advanceBase(session, generation)) { this.#retryHeld.delete(key); return true }
    if (saved) this.#notifyProtected(session)
    if (!this.#pending.has(key)) { this.#pending.set(key, pending); this.#retryHeld.delete(key) }
    return false
  }

  #advanceBase(session: Session, generation: string): boolean {
    const identity = this.#verifiedRows.get(keyOf(session.runtime, session.id))
    if (!identity || !this.#matchesStoredRow(session, identity)) return false
    const base: DurableTranscriptBase = { kind: 'body', identity }
    this.bindBase(session, generation, base)
    this.baseAdvanced(session.runtime, session.id, generation, base)
    return true
  }

  verifiedBase(session: Session): DurableTranscriptBase | undefined {
    const identity = this.#verifiedRows.get(keyOf(session.runtime, session.id))
    return identity && this.#matchesStoredRow(session, identity) ? { kind: 'body', identity } : undefined
  }

  async #write(session: Session, insight: readonly TurnInsightContext[] = [], refresh?: { source?: SessionSource | null; preserveSource?: boolean; preserveExactBody?: string; preserveStored?: Stored; expectedBase?: DurableTranscriptBase; current?: () => boolean; prepared?: (identity: string) => void }): Promise<boolean> {
    const key = keyOf(session.runtime, session.id)
    if (this.#protectedWrites.has(key) && !refresh?.expectedBase) return false
    const previous = this.#writes.get(key) ?? Promise.resolve()
    const next = previous.then(async () => {
      if (this.#protectedWrites.has(key) && !refresh?.expectedBase) return false
      if (refresh?.current && !refresh.current()) return false
      const preserveSource = refresh?.preserveSource && !this.#failedWrites.has(key)
      let stored: Stored = refresh?.preserveStored ?? {
        version: FORMAT,
        runtime: session.runtime,
        id: session.id,
        savedAt: Date.now(),
        turns: session.turns,
        usage: session.usage ?? null,
        title: session.title ?? null,
        preview: session.preview ?? null,
        cwd: session.cwd,
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
        ...(insight.length ? { insight } : {}),
      }
      try {
        // Only stored user messages are needed for provenance; large command
        // and tool payloads never make a round trip on the write path.
        let current: Stored | null = null
        let reconcile = false
        try { current = this.#database.read(session.runtime, session.id, true) }
        catch (error) {
          if (!(error instanceof InvalidTranscriptBodyError)) throw error
          reconcile = true
          this.log('invalid retained transcript ignored', { session: session.id, error: String(error) })
        }
        if (current && !refresh?.preserveStored) {
          const retained = new Set(stored.turns.map(turn => String(turn.id)))
          const contexts = new Map((current.insight ?? []).filter(context => retained.has(context.turn)).map(context => [context.turn, context]))
          for (const context of insight) contexts.set(context.turn, context)
          stored = { ...stored, turns: withDeskContext(stored.turns, current.turns),
            ...(preserveSource ? { savedAt: current.savedAt } : {}),
            ...(contexts.size ? { insight: [...contexts.values()] } : {}) }
        }
        // An event write has not replayed the source: even a stat that matches
        // now may describe unseen CLI work. Only a reconciled refresh can
        // stamp the body; ordinary writes force the next idle read to refresh.
        // A release adds no source work. Read the current stamp inside this
        // queued write, after any older event write has invalidated it.
        const source = preserveSource ? this.#storedSource(session.runtime, session.id) : refresh?.source ?? null
        const writtenIdentity = durableStateIdentity(stored, source)
        refresh?.prepared?.(writtenIdentity)
        this.#database.write(stored, session.runtime, session.id, { reconcile: reconcile || !!refresh, source, preserveExactBody: refresh?.preserveExactBody, expectedBase: refresh?.expectedBase })
        // Exact verification of the same semantic row is not a cache change.
        if (!refresh?.preserveStored || refresh.expectedBase?.kind !== 'body' || refresh.expectedBase.identity !== writtenIdentity) {
          this.onDurableChange(session.runtime, session.id)
        }
        this.#snapshots.schedule()
        this.onWrite()
        this.#failedWrites.delete(key)
        return true
      } catch (error) {
        this.#failedWrites.add(key)
        this.log(error instanceof NewerTranscriptFormatError ? 'transcript from a newer format left untouched' : 'transcript not saved',
          { session: session.id, error: String(error) })
        return false
      }
    })
    this.#writes.set(key, next)
    try { return await next }
    finally { if (this.#writes.get(key) === next) this.#writes.delete(key) }
  }

  /**
   * Verify the exact ordered body against a fresh SQLite read after writing it.
   * This is a storage primitive, not an eviction receipt: the caller must fence
   * host identity, quiescence and all intervening mutations independently.
   */
  async persistExactBody(host: Session, candidate: Session, expectedBase?: DurableTranscriptBase): Promise<boolean> {
    if (host.runtime !== candidate.runtime || host.id !== candidate.id || !host.itemsLoaded || !candidate.itemsLoaded ||
        !host.turns.some(turn => turn.items.length > 0)) return false
    const body = canonicalTranscriptBody(host.turns).canonical
    if (body !== canonicalTranscriptBody(candidate.turns).canonical) return false
    const key = keyOf(host.runtime, host.id)
    if (this.#pending.has(key) || this.#writes.has(key) || this.#failedWrites.has(key)) return false
    let base: DurableTranscriptBase, storedForVerification: Stored | undefined
    try {
      const observed = this.#database.observe(host.runtime, host.id)
      const stored = observed.stored
      if (observed.removed || (observed.bodyPresent && !stored)) return false
      if (stored && observed.identity) {
        if (!sameStoredSessionFacts(stored, host)) return false
        const heldInsight = this.#insight.get(key)
        if (heldInsight?.length && !isDeepStrictEqual(heldInsight, stored.insight ?? [])) return false
        storedForVerification = stored
        base = { kind: 'body', identity: observed.identity }
      } else base = { kind: 'missing' }
    } catch { return false }
    if (expectedBase && (expectedBase.kind !== base.kind ||
      (expectedBase.kind === 'body' && (base.kind !== 'body' || expectedBase.identity !== base.identity)))) return false
    let prepared: string | undefined
    if (!await this.#write(host, this.#insight.get(key) ?? [], { preserveSource: true, preserveExactBody: body, preserveStored: storedForVerification, expectedBase: expectedBase ?? base, prepared: identity => { prepared = identity } })) return false
    if (this.#pending.has(key) || this.#writes.has(key)) return false
    if (!prepared || !this.#matchesStoredRow(host, prepared)) return false
    this.#verifiedRows.set(key, prepared)
    return true
  }

  /** Storage CAS only: the caller owns and fences the observed base and record. */
  async persistEvolvedBody(session: Session, expectedBase: { readonly kind: 'missing' } | { readonly kind: 'body'; readonly identity: string }, insight: readonly TurnInsightContext[] = [], current?: () => boolean): Promise<boolean> {
    return this.#persistEvolvedBody(session, expectedBase, insight, current)
  }

  #bodyExtends(old: Session, next: Session): boolean {
    if (old.runtime !== next.runtime || old.id !== next.id || old.cwd !== next.cwd || old.createdAt !== next.createdAt ||
        old.title !== next.title || old.preview !== next.preview || !isDeepStrictEqual(old.usage, next.usage) || old.turns.length > next.turns.length) return false
    return old.turns.every((turn, index) => {
      const newer = next.turns[index]
      if (!newer || turn.items.length > newer.items.length) return false
      const { items: _oldItems, ...oldFields } = turn, { items: _newItems, ...newFields } = newer
      return isDeepStrictEqual(oldFields, newFields) && turn.items.every((item, i) => isDeepStrictEqual(item, newer.items[i]))
    })
  }

  async #persistEvolvedBody(session: Session, expectedBase: DurableTranscriptBase, insight: readonly TurnInsightContext[] = [], current?: () => boolean, ownedHeld?: PendingWrite, preserveSource = false, acceptOvertaken?: (identity: string) => boolean): Promise<boolean> {
    if (!session.itemsLoaded || !session.turns.some(turn => turn.items.length > 0)) return false
    const key = keyOf(session.runtime, session.id)
    if (this.#pending.has(key) || this.#writes.has(key) || (this.#retryHeld.has(key) && this.#retryHeld.get(key) !== ownedHeld)) return false
    if (insight.length) {
      const byTurn = new Map((this.#insight.get(key) ?? []).map(context => [context.turn, context]))
      for (const context of insight) byTurn.set(context.turn, context)
      this.#insight.set(key, [...byTurn.values()].slice(-2000))
    }
    // Guard ordinary settles throughout the asynchronous CAS and readback.
    this.#protectedWrites.add(key)
    let prepared: string | undefined
    const wrote = await this.#write(session, this.#insight.get(key) ?? [], { expectedBase, current, preserveSource, prepared: identity => { prepared = identity } })
    const verified = wrote && !!prepared && this.#matchesStoredRow(session, prepared)
    if (!verified || this.#pending.has(key) || (current && !current())) {
      if (!(verified && prepared && acceptOvertaken?.(prepared))) this.#notifyProtected(session)
      return false
    }
    this.#verifiedRows.set(key, prepared!)
    this.#protectedWrites.delete(key)
    this.#protectedNotified.delete(key)
    return true
  }

  /** Storage retry only; the caller must fence the current Host record and generation. */
  async retryProtectedBody(session: Session, expectedBase: DurableTranscriptBase, current?: () => boolean): Promise<boolean> {
    const key = keyOf(session.runtime, session.id), pending = this.#pending.get(key)
    if ((current && !current()) || !this.#protectedWrites.has(key) || this.#retryHeld.has(key) || this.#writes.has(key)) return false
    // A failed recovered-body CAS may have no queued snapshot: the current
    // generation's fully materialized Host record owns that data instead.
    if (!pending) return this.#persistEvolvedBody(session, expectedBase, [], current)
    if (!isDeepStrictEqual(pending.session, session)) return false
    clearTimeout(pending.timer)
    this.#pending.delete(key)
    this.#retryHeld.set(key, pending)
    const saved = await this.#persistEvolvedBody(session, expectedBase, [], current, pending)
    if (saved) { this.#retryHeld.delete(key); return true }
    if (!this.#pending.has(key)) { this.#pending.set(key, pending); this.#retryHeld.delete(key) }
    return false
  }

  /** A fresh connection checks that the exact body remains in SQLite. */
  matchesExactBody(session: Session): boolean {
    const key = keyOf(session.runtime, session.id)
    if (this.#protectedWrites.has(key) || this.#unboundWrites.has(key) || this.#pending.has(key) || this.#writes.has(key) || this.#retryHeld.has(key) || this.#settling.has(key)) return false
    return this.#matchesStoredBody(session)
  }

  #matchesStoredBody(session: Session): boolean {
    const verifier = new TranscriptDatabase(this.#database.file)
    try {
      if (verifier.isRemoved(session.runtime, session.id)) return false
      const stored = verifier.read(session.runtime, session.id)
      return !!stored && canonicalTranscriptBody(stored.turns).canonical === canonicalTranscriptBody(session.turns).canonical
    } catch { return false }
    finally { verifier.close() }
  }

  #matchesStoredRow(session: Session, identity: string): boolean {
    const verifier = new TranscriptDatabase(this.#database.file)
    try {
      const observed = verifier.observe(session.runtime, session.id)
      const stored = observed.stored
      return !observed.removed && !!stored && observed.identity === identity &&
        canonicalTranscriptBody(stored.turns).canonical === canonicalTranscriptBody(session.turns).canonical
    } catch { return false }
    finally { verifier.close() }
  }

  /** Persist before a closed handle lets go of its body; a failed save keeps it in memory. */
  async release(session: Session): Promise<boolean> {
    const key = keyOf(session.runtime, session.id)
    if (this.#protectedWrites.has(key)) return false
    const pending = this.#pending.get(key)
    if (pending) clearTimeout(pending.timer)
    this.#pending.delete(key)
    const saved = await this.#write(session, this.#insight.get(key) ?? [], { preserveSource: !pending })
    if (saved && !this.#pending.has(key) && !this.#writes.has(key)) {
      this.#insight.delete(key)
      this.#database.releaseMemory(session.runtime, session.id)
    }
    return saved
  }

  /** Flush a pending settle before reading, or await this conversation's in-flight write.
   * The writer reads rows directly and never calls this path, so it cannot wait on itself.
   */
  async #settle(runtime: RuntimeId, id: SessionId): Promise<void> {
    const key = keyOf(runtime, id)
    const inProgress = this.#settling.get(key)
    if (inProgress) { await inProgress; return this.#settle(runtime, id) }
    if (this.#protectedWrites.has(key)) throw new Error('Transcript has protected changes that could not be saved')
    const pending = this.#pending.get(key)
    if (pending) {
      if (pending.generation) {
        const work = this.#settleGeneration(key, pending)
        this.#settling.set(key, work)
        try { await work } finally { if (this.#settling.get(key) === work) this.#settling.delete(key) }
        if (this.#protectedWrites.has(key)) throw new Error('Transcript has protected changes that could not be saved')
        if (this.#pending.get(key) === pending) throw new Error('Transcript write authority is not established')
        return this.#settle(runtime, id)
      }
      clearTimeout(pending.timer)
      this.#pending.delete(key)
      await this.#write(pending.session, pending.insight)
      return
    }
    await this.#writes.get(key)?.catch(() => {})
  }

  /** A partial replay may only append to an exact existing durable body. */
  #partialAppend(session: Session, base: DurableTranscriptBase, insight: readonly TurnInsightContext[]): Stored | undefined {
    if (!session.partialHistory || base.kind !== 'body') return undefined
    try {
      const observed = this.#database.observe(session.runtime, session.id), stored = observed.stored
      if (observed.removed || !stored || observed.identity !== base.identity || stored.turns.length > session.turns.length ||
          !stored.turns.every((turn, index) => isDeepStrictEqual(turn, session.turns[index])) ||
          !(['title', 'preview', 'cwd', 'usage'] as const).every(field => isDeepStrictEqual(stored[field] ?? null, session[field] ?? null))) return undefined
      const contexts = new Map((stored.insight ?? []).map(value => [value.turn, value]))
      for (const value of insight) {
        const held = contexts.get(value.turn)
        if (held && !isDeepStrictEqual(held, value)) return undefined
        contexts.set(value.turn, value)
      }
      return { ...stored, turns: session.turns, updatedAt: Math.max(stored.updatedAt ?? 0, session.updatedAt),
        ...(contexts.size ? { insight: [...contexts.values()] } : {}) }
    } catch { return undefined }
  }

  async #settleGeneration(key: string, pending: PendingWrite): Promise<void> {
    const generation = pending.generation!, session = structuredClone(pending.session), authority = this.#authorities.get(key)
    if (!authority) { clearTimeout(pending.timer); this.#unboundWrites.add(key); return }
    const partial = this.#partialAppend(session, authority.base, pending.insight)
    const allowPartial = !!partial
    if (authority.generation !== generation || !this.generationCurrent(session.runtime, session.id, generation, session, pending.revision, pending.authorityEpoch, allowPartial) || this.#retryHeld.has(key)) {
      this.#notifyProtected(session); return
    }
    clearTimeout(pending.timer); this.#pending.delete(key); this.#retryHeld.set(key, pending); this.#protectedWrites.add(key)
    const current = () => this.#authorities.get(key) === authority && this.generationCurrent(session.runtime, session.id, generation, session, pending.revision, pending.authorityEpoch, allowPartial)
    let prepared: string | undefined
    const saved = await this.#write(session, pending.insight, { expectedBase: authority.base, current, ...(partial ? { preserveStored: partial } : {}), prepared: identity => { prepared = identity } })
    if (saved && current() && prepared && this.#matchesStoredRow(session, prepared)) {
      const base: DurableTranscriptBase = { kind: 'body', identity: prepared }
      authority.base = base
      this.baseAdvanced(session.runtime, session.id, generation, base)
      this.#retryHeld.delete(key); this.#protectedWrites.delete(key)
      this.#protectedNotified.delete(key)
      const next = this.#pending.get(key)
      if (next) this.record(next.session, { insight: next.insight, generation: next.generation, revision: next.revision, authorityEpoch: next.authorityEpoch })
      return
    }
    this.#notifyProtected(session)
    if (!this.#pending.has(key)) { this.#pending.set(key, pending); this.#retryHeld.delete(key) }
  }

  async #read(runtime: RuntimeId, id: SessionId): Promise<Stored | null> {
    await this.#settle(runtime, id)
    if (this.#protectedWrites.has(keyOf(runtime, id))) return null
    try { return this.#database.read(runtime, id) }
    catch { return null }
  }

  /** Read a released body synchronously before folding an arriving event. */
  readRetainedTurns(runtime: RuntimeId, id: SessionId): readonly Turn[] | null {
    const key = keyOf(runtime, id)
    if (this.#protectedWrites.has(key) || this.#pending.has(key) || this.#writes.has(key)) return null
    try {
      if (this.#database.isRemoved(runtime, id)) return null
      return this.#database.read(runtime, id)?.turns ?? null
    } catch { return null }
  }

  readRetainedTurnsAtBase(runtime: RuntimeId, id: SessionId, identity: string): readonly Turn[] | null {
    const key = keyOf(runtime, id)
    if (this.#protectedWrites.has(key) || this.#unboundWrites.has(key) || this.#pending.has(key) || this.#writes.has(key)) return null
    const verifier = new TranscriptDatabase(this.#database.file)
    try {
      const observed = verifier.observe(runtime, id)
      return !observed.removed && observed.stored && observed.identity === identity ? observed.stored.turns : null
    } catch { return null }
    finally { verifier.close() }
  }

  /** Metadata of a verified stored body, including conversations with no turns. */
  async readSummary(runtime: RuntimeId, id: SessionId): Promise<SessionSummary | null> {
    const stored = await this.#read(runtime, id)
    return stored ? { ...summaryOf(stored), runtime, id } : null
  }

  /** Historical metadata is unavailable, not person-caused, when an old file has none. */
  async readInsight(runtime: RuntimeId, id: SessionId): Promise<readonly TurnInsightContext[] | null> {
    const stored = await this.#read(runtime, id)
    return stored?.insight ?? null
  }

  /** Fingerprint and body are committed together; a failed refresh never blesses a stale body. */
  async source(runtime: RuntimeId, id: SessionId): Promise<SessionSource | null> {
    await this.#settle(runtime, id)
    if (this.#protectedWrites.has(keyOf(runtime, id))) return null
    return this.#storedSource(runtime, id)
  }

  #storedSource(runtime: RuntimeId, id: SessionId): SessionSource | null {
    return this.#database.source(runtime, id)
  }

  /** Persist only after enrich; omitted work turns, items, search and context leave together. */
  async refresh(session: Session, source: SessionSource | null, observedBase?: DurableTranscriptBase): Promise<{ saved: true; base: DurableTranscriptBase } | { saved: false; base: DurableTranscriptBase }> {
    await this.#settle(session.runtime, session.id)
    const key = keyOf(session.runtime, session.id)
    if (this.#protectedWrites.has(key)) throw new Error('Transcript has protected changes that could not be saved')
    const retained = new Set(session.turns.map(turn => String(turn.id)))
    const contexts = (this.#insight.get(key) ?? []).filter(context => retained.has(context.turn))
    const base = observedBase ?? (session.partialHistory ? undefined : this.observeBase(session, true))
    let prepared: string | undefined
    if (!base || !await this.#write(session, [], { source, expectedBase: base, prepared: identity => { prepared = identity } }) || !prepared || !this.#matchesStoredRow(session, prepared)) {
      this.#notifyProtected(session)
      const timer = setTimeout(() => {}, 0); timer.unref()
      const held = { timer, session, insight: this.#insight.get(key) ?? [] }
      if (!this.#pending.has(key)) this.#pending.set(key, held)
      else if (!this.#retryHeld.has(key)) this.#retryHeld.set(key, held)
      if (base && this.#baseStillMatches(session, base)) return { saved: false, base }
      throw new Error('Transcript refresh could not be verified; changes are protected')
    }
    if (contexts.length) this.#insight.set(key, contexts)
    else this.#insight.delete(key)
    return { saved: true, base: { kind: 'body', identity: prepared } }
  }

  /** Compare the current durable base without settling or changing a live body. */
  matchesBase(session: Session, base: DurableTranscriptBase): boolean {
    return this.#baseStillMatches(session, base)
  }

  #baseStillMatches(session: Session, base: DurableTranscriptBase): boolean {
    const verifier = new TranscriptDatabase(this.#database.file)
    try {
      const observed = verifier.observe(session.runtime, session.id)
      if (observed.removed) return false
      if (base.kind === 'missing') return !observed.bodyPresent
      return !!observed.stored && observed.identity === base.identity
    } catch { return false }
    finally { verifier.close() }
  }

  /**
   * A session rebuilt purely from what the host stored, for when the backend
   * cannot serve it at all — an ACP agent restarted out of its idle sessions,
   * a Codex build that refuses its own rollout. Read-only by nature: idle,
   * no settings, no options. Null when the host never watched this session.
   */
  async recover(runtime: RuntimeId, id: SessionId): Promise<Session | null> {
    const stored = await this.#read(runtime, id)
    if (!stored || stored.turns.length === 0) return null
    const at = stored.updatedAt ?? stored.savedAt
    return {
      id,
      runtime,
      cwd: stored.cwd ?? '',
      status: { type: 'idle' },
      createdAt: stored.createdAt ?? at,
      updatedAt: at,
      itemsLoaded: true,
      turns: stored.turns,
      ...(stored.title !== undefined ? { title: stored.title } : {}),
      ...(stored.preview !== undefined ? { preview: stored.preview } : {}),
      ...(stored.usage != null ? { usage: stored.usage } : {}),
    }
  }

  /**
   * The backend's read, with what the host remembers folded in. Items are
   * merged per turn, and the last usage is restored when the read carried
   * none; nothing else about the session changes.
   */
  async enrich(session: Session): Promise<Session> {
    return this.#enrichFromStored(session, await this.#read(session.runtime, session.id))
  }

  /** The base belongs to this individual read, never to a shared session-key slot. */
  async enrichForRefresh(session: Session): Promise<{ session: Session; base: DurableTranscriptBase | undefined }> {
    await this.#settle(session.runtime, session.id)
    let stored: Stored | null = null, base: DurableTranscriptBase | undefined
    if (!this.#protectedWrites.has(keyOf(session.runtime, session.id))) try {
      const observed = this.#database.observe(session.runtime, session.id)
      stored = observed.stored
      if (observed.identity) base = { kind: 'body', identity: observed.identity }
      else if (!observed.removed && !session.partialHistory && !observed.bodyPresent) base = { kind: 'missing' }
    } catch { /* An unavailable or undecodable base is not known missing. */ }
    return { session: this.#enrichFromStored(session, stored), base }
  }

  #enrichFromStored(session: Session, stored: Stored | null): Session {
    if (!stored) return session
    // A backend that answers with no turns at all — an ACP agent restarted
    // out of its idle sessions serves the session but not its past — is not
    // making a claim about history the way a rollback is; the host watched
    // the turns happen, so they stand in whole.
    if (session.turns.length === 0 && stored.turns.length > 0) {
      return { ...session, turns: stored.turns, ...(session.usage ? {} : stored.usage != null ? { usage: stored.usage } : {}) }
    }
    // A read that begins at a reopen that replayed nothing is silent about
    // the turns before it; the stored ones ahead of the first turn it shares
    // stand in for them, so a reply after the reopen never shortens the
    // conversation the desk kept.
    if (session.partialHistory) {
      const readIds = new Set(session.turns.map((turn) => turn.id))
      const firstShared = stored.turns.findIndex((turn) => readIds.has(turn.id))
      const earlier = stored.turns.slice(0, firstShared === -1 ? stored.turns.length : firstShared)
      if (earlier.length > 0) session = { ...session, turns: [...earlier, ...session.turns] }
    }
    // Provenance belongs to a message even when replay changes its turn.
    // Restore it before turn pairing, without copying the old segmentation.
    const recordedTurns = withDeskContext(session.turns, stored.turns)
    if (recordedTurns !== session.turns) session = { ...session, turns: recordedTurns }
    const pairs = pairTurns(session.turns, stored.turns)
    // Where each item the read knows about lives. A stored turn that would
    // bring an item some other read turn already shows is a split the
    // pairing could not see — pasting it would show the item twice.
    const homes = new Map<string, Turn>()
    for (const turn of session.turns) {
      for (const entry of turn.items) homes.set(String(entry.id), turn)
    }
    let changed = false
    const turns = session.turns.map((turn) => {
      const kept = pairs.get(turn)
      if (!kept) return turn
      // What the host itself put in the turn. The backend has never heard of
      // a publication, so a read that otherwise wins on count — a Codex
      // rollout that stored more than it streamed — would drop the row the
      // host recorded. Put back at its place, whichever list stands.
      const published = publicationsIn(kept.items)
      const carry = (items: readonly AgentItem[]): readonly AgentItem[] => {
        const classified = preserveDeskContext(preserveNoticeItems(items, kept.items, true), kept.items)
        return published.every(({ item }) => classified.some((entry) => entry.id === item.id))
          ? classified
          : withPublications(classified, published)
      }
      if (kept.items.length <= turn.items.length) {
        const items = carry(turn.items)
        if (items === turn.items) return turn
        changed = true
        return { ...turn, items }
      }
      if (
        kept.items.some((entry) => {
          const home = homes.get(String(entry.id))
          return home !== undefined && home !== turn
        })
      ) {
        const items = carry(turn.items)
        if (items === turn.items) return turn
        changed = true
        return { ...turn, items }
      }
      changed = true
      return {
        ...kept,
        ...turn,
        items: kept.items,
        diff: turn.diff ?? kept.diff ?? null,
        plan: turn.plan ?? kept.plan,
        // The host's own stored time, never the backend read's: a replay
        // that opens this turn again re-stamps `startedAt` at the moment it
        // was replayed (see the ACP adapter), and letting that win would
        // re-date a turn from months ago to today every time the session is
        // reopened -- and, since desk turn counting buckets by day, count it
        // again on whatever day it happens to be reopened (#1047 review).
        startedAt: kept.startedAt ?? turn.startedAt ?? null,
        completedAt: kept.completedAt ?? turn.completedAt ?? null,
      }
    })
    // These rows are host-owned and have no vendor turn to pair with.
    // Keep only their missing items; omitted work turns still belong to rollback.
    for (let index = 0; index < stored.turns.length; index++) {
      const held = stored.turns[index]!
      if (!isNoticeTurn(held) || turns.some(turn => turn.id === held.id)) continue
      const items = held.items.filter(item => item.type === 'notice' && !homes.has(String(item.id)))
      if (items.length === 0) continue
      const next = stored.turns.slice(index + 1).find(turn => turns.some(read => read.id === turn.id))
      const at = next ? turns.findIndex(turn => turn.id === next.id) : turns.length
      turns.splice(at, 0, { ...held, items })
      changed = true
    }
    const usage = restorableUsage(session, stored, pairs)
    if (!changed && !usage) return session
    return { ...session, turns, ...(usage ? { usage } : {}) }
  }

  /**
   * Search every stored transcript for the words themselves.
   *
   * This is the one search that treats every agent the same, because it reads
   * what the host watched rather than asking anyone. The adapters' own
   * searches are narrower on purpose — Codex greps its rollouts, ACP agents
   * can only offer their live previews — and the palette merges all three.
   *
   * What is searched is what a person would call the conversation: their own
   * messages and the agent's answers. Tool output is opt-in; reasoning and
   * client scaffolding stay excluded — matching a conversation on
   * a word that appears only in a command's stderr surprises more than it
   * helps. Most recent transcripts are read first, so under a result cap it
   * is the oldest conversations that go unsearched, never the latest.
   */
  async search(query: string, options: { readonly limit?: number; readonly includeTools?: boolean } = {}): Promise<readonly TranscriptHit[]> {
    const limit = Math.max(0, Math.floor(options.limit ?? 20))
    const needle = query.trim().toLowerCase()
    if (!needle || !limit) return []
    // Quoting the complete literal hides FTS operators. One/two-character
    // searches use the same columns directly: trigram has no shorter tokens.
    const columns = options.includeTools ? '{message_text tool_text}' : 'message_text'
    const match = [...needle].length >= 3 ? `items_fts MATCH ? AND ` : ''
    const params: string[] = match ? [`${columns} : "${needle.replaceAll('"', '""')}"`] : []
    params.push(needle)
    if (options.includeTools) params.push(needle)
    const rows = this.#database.db.prepare(`SELECT i.runtime,i.id,i.kind,b.payload AS facts,
      CASE WHEN i.kind IN ('assistantMessage','userMessage') THEN i.text ELSE substr(i.text,1,${TOOL_INDEX_CAP}) END AS text
      FROM items_fts JOIN items i ON i.rowid=items_fts.rowid
      JOIN bodies b ON b.runtime=i.runtime AND b.id=i.id
      JOIN sessions s ON s.runtime=i.runtime AND s.id=i.id
      JOIN turns t ON t.runtime=i.runtime AND t.id=i.id AND t.turn_id=i.turn_id
      WHERE s.origin='desk' AND s.removed_at IS NULL AND ${match}(instr(items_fts.message_text,?)>0${options.includeTools ? ' OR instr(items_fts.tool_text,?)>0' : ''})
      ORDER BY s.saved_at DESC,i.runtime,i.id,t.seq,i.position`).iterate(...params)
    const hits: TranscriptHit[] = []
    const seen = new Set<string>()
    for (const row of rows) {
      const key = JSON.stringify([row.runtime, row.id])
      if (seen.has(key)) continue
      const message = row.kind === 'assistantMessage' || row.kind === 'userMessage'
      const text = String(row.text)
      const hit = lineMatch(message ? text : text.slice(0, TOOL_INDEX_CAP), needle)
      if (!hit) continue
      seen.add(key)
      try {
        const facts = readTranscriptFacts(String(row.facts))
        if (!facts) continue
        // Old backup entries can lack a preview. Only their user messages are
        // needed to derive one; tool payloads never make a search round trip.
        const stored = facts.preview == null
          ? this.#database.read(String(row.runtime), String(row.id), true)
          : { ...facts, turns: [] }
        if (!stored) continue
        const summary = decodeBody(() => summaryOf(stored))
        hits.push({ summary, ...hit, source: message ? 'message' : 'tool' } as TranscriptHit)
      } catch (error) {
        if (!(error instanceof InvalidTranscriptBodyError || error instanceof NewerTranscriptFormatError)) throw error
        this.log('invalid transcript omitted from search', { runtime: row.runtime, session: row.id, error: String(error) })
      }
      if (hits.length >= limit) break
    }
    return hits
  }

  /** Every retained body in the existing version-1 backup shape. An unreadable database refuses the backup. */
  async exportAll(): Promise<readonly { runtime: string; id: string; data: unknown }[]> {
    await this.flush()
    try { return this.#export() }
    catch (error) { throw unexported(error) }
  }

  #export(runtime?: string): { runtime: string; id: string; data: unknown }[] {
    const rows = this.#database.db.prepare(`SELECT b.runtime,b.id,s.origin,s.last_opened_at FROM bodies b
      JOIN sessions s ON s.runtime=b.runtime AND s.id=b.id${runtime === undefined ? '' : ' WHERE b.runtime=?'} ORDER BY b.runtime,b.id`)
      .all(...(runtime === undefined ? [] : [runtime]))
    return rows.map(row => {
      const data = this.#database.read(String(row.runtime), String(row.id))
      if (!data) throw new Error('A stored transcript is invalid; its runtime export cannot replace the ledger window')
      return { runtime: String(row.runtime), id: String(row.id), data: row.origin === 'imported'
        ? { ...data, origin: 'imported', lastOpenedAt: Number(row.last_opened_at) } : data }
    })
  }

  /** An unavailable runtime store never replaces an already-counted ledger window. */
  async exportRuntime(runtime: string): Promise<readonly { runtime: string; id: string; data: unknown }[]> {
    await this.flush()
    if (!this.#database.db.prepare('SELECT 1 FROM meta WHERE key=?').get(`transcripts:runtime:${runtime}`)) {
      throw new MissingTranscriptRuntimeError('Transcript runtime has no stored conversations')
    }
    return this.#export(runtime)
  }

  /**
   * Puts one transcript from a backup into the store, additively and
   * verified. `skipped` when the local copy is at least as new — a restore
   * must never roll a conversation backwards — `refused` when the data is
   * not a transcript, and `restored` only after the written body was read
   * back and matched.
   */
  async importOne(
    runtime: string,
    id: string,
    data: unknown,
  ): Promise<'restored' | 'skipped' | 'refused'> {
    const incoming = data as Partial<Stored> & { origin?: 'desk' | 'imported'; lastOpenedAt?: number }
    if (
      typeof incoming !== 'object' ||
      incoming === null ||
      incoming.version !== FORMAT ||
      !Array.isArray(incoming.turns) ||
      incoming.turns.some((turn) => typeof turn !== 'object' || turn === null || !Array.isArray(turn.items)) ||
      typeof incoming.savedAt !== 'number' ||
      (incoming.origin !== undefined && incoming.origin !== 'desk' && incoming.origin !== 'imported') ||
      (incoming.lastOpenedAt !== undefined && (!Number.isFinite(incoming.lastOpenedAt) || incoming.lastOpenedAt < 0))
    ) {
      return 'refused'
    }
    await this.#settle(runtime as RuntimeId, id as SessionId)
    if (this.#protectedWrites.has(keyOf(runtime as RuntimeId, id as SessionId))) return 'refused'
    let existing: Stored | null, base: DurableTranscriptBase
    try {
      const observed = this.#database.observe(runtime, id)
      existing = observed.stored
      if (observed.removed || (observed.bodyPresent && !existing)) return 'refused'
      if (existing && existing.savedAt >= incoming.savedAt) return 'skipped'
      base = observed.identity ? { kind: 'body', identity: observed.identity } : { kind: 'missing' }
    } catch { return 'refused' }
    const { origin, lastOpenedAt, ...stored } = incoming
    try {
      this.#database.write(stored as Stored, runtime as RuntimeId, id as SessionId, { source: null, origin, lastOpenedAt, expectedBase: base, expectedSavedAt: existing?.savedAt ?? null })
      this.onDurableChange(runtime as RuntimeId, id as SessionId, 'import')
      this.#snapshots.schedule()
    }
    catch { return 'refused' }
    const verifier = new TranscriptDatabase(this.#database.file)
    try {
      const observed = verifier.observe(runtime, id), written = observed.stored
      if (!written || observed.removed || written.savedAt !== incoming.savedAt || observed.identity !== durableStateIdentity(stored as Stored, null)) return 'refused'
    } catch { return 'refused' }
    finally { verifier.close() }
    // Notify after verification: cache eviction may remove this body at once.
    this.onWrite()
    return 'restored'
  }

  /** Preserve the final write before opening the Remove Undo window. */
  async flushSession(runtime: RuntimeId, id: SessionId): Promise<void> { await this.#settle(runtime, id) }

  removedBodies(): readonly { runtime: RuntimeId; id: SessionId; removed_at: number }[] { return this.#database.removedBodies() }

  async sweepRemoved(before: number): Promise<void> {
    for (const row of this.removedBodies()) if (row.removed_at <= before) await this.forget(row.runtime, row.id, { removedBefore: before })
  }

  /** Cancel queued writes and atomically drop this body, and optionally its index row. */
  async forget(runtime: RuntimeId, id: SessionId, options: { deleteIndex?: boolean; removedBefore?: number } = {}): Promise<void> {
    const key = keyOf(runtime, id)
    // A stale timed sweep is not authority to discard unresolved generations.
    if (options.removedBefore !== undefined && this.#generationConflicts.has(key)) return
    const pending = this.#pending.get(key)
    if (pending) {
      clearTimeout(pending.timer)
      this.#pending.delete(key)
    }
    this.#insight.delete(key)
    // Wait out a write already in flight, or the deletion races it.
    await this.#writes.get(key)?.catch(() => {})
    this.#writes.delete(key)
    this.#failedWrites.delete(key)
    this.#protectedWrites.delete(key)
    this.#protectedNotified.delete(key)
    this.#unboundWrites.delete(key)
    this.#retryHeld.delete(key)
    this.#authorities.delete(key)
    this.#verifiedRows.delete(key)
    this.#generationConflicts.delete(key)
    this.#database.forget(runtime, id, options)
    this.onDurableChange(runtime, id)
  }

  /**
   * Drops a conversation's last `count` turns from what the store kept,
   * because the conversation itself dropped them: a rollback. Untold, the
   * store filled a later read in from the turns it had, and a relaunch
   * brought the dropped ones back (#156). A write still waiting goes out
   * first, so the turns counted from the end are the conversation's last,
   * and a transcript with no turn left is forgotten. It trims stored rows rather
   * than writing the host's copy over it, since that copy can be thinner
   * than the stored body, or not loaded (review of #236, round 1).
   */
  async dropTurns(runtime: RuntimeId, id: SessionId, count: number): Promise<void> {
    if (!(count > 0)) return
    const key = keyOf(runtime, id)
    if (this.#protectedWrites.has(key)) return
    const pending = this.#pending.get(key)
    if (pending) {
      clearTimeout(pending.timer)
      this.#pending.delete(key)
      await this.#write(pending.session, pending.insight)
    }
    await this.#writes.get(key)?.catch(() => {})
    const stored = await this.#read(runtime, id)
    if (!stored) return
    const kept = Math.max(0, stored.turns.length - count)
    if (kept === 0) await this.forget(runtime, id)
    else {
      const turns = stored.turns.slice(0, kept)
      const retainedSession = await this.recover(runtime, id)
      if (!retainedSession) return
      const retained = new Set(turns.map((turn) => String(turn.id)))
      const insight = (stored.insight ?? []).filter((context) => retained.has(context.turn))
      if (insight.length) this.#insight.set(key, insight)
      else this.#insight.delete(key)
      await this.#write({ ...retainedSession, turns }, insight)
    }
  }

  /** Writes whatever is still waiting. Call on shutdown. */
  async flush(): Promise<void> {
    const waiting = [...this.#pending.values()].filter(entry => !this.#protectedWrites.has(keyOf(entry.session.runtime, entry.session.id)))
    await Promise.all(waiting.map(entry => this.#settle(entry.session.runtime, entry.session.id)))
    await Promise.all([...this.#settling.values()])
    await Promise.all([...this.#writes.values()])
    if (this.#protectedWrites.size) throw new Error('Transcript has protected changes that could not be saved')
  }
  async close(): Promise<void> {
    try { await this.flush() }
    finally {
      await this.#snapshots.close()
      this.#database.close()
      this.#failedWrites.clear()
    }
  }

}

/**
 * How the conversation opened: the first message that *says* something, read
 * whole — its text parts in order, a block each and the person's own words.
 *
 * The first message, full stop, was not the same thing. A message can carry
 * no text at all — a pasted screenshot, a file mention, a skill, and nothing
 * typed — and that one returned an empty string and stopped, so a transcript
 * whose *next* message asked in words was left with no name and read
 * "Untitled session" (review of #231, round 3). Nothing else in a user
 * message can speak: `UserContent` is text, image, localImage, skill or
 * mention, and a tool's result is an item of its own, never a message of the
 * person's. So a message of images alone says nothing, and this walks on to
 * the one that does — which is exactly what the other two producers of a
 * first ask do (`SessionTree`, and the renderer's store).
 */
const firstOpening = (turns: readonly Turn[]): string => {
  for (const turn of turns) {
    for (const item of turn.items) {
      if (item.type !== 'userMessage' || !Array.isArray(item.content)) continue
      const opening = openingOfContent(item.content)
      if (opening) return opening
    }
  }
  return ''
}

/** A literal match with the palette's existing clipping and offsets. */
const lineMatch = (text: string, needle: string): { line: string; start: number; end: number } | null => {
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    const at = line.toLowerCase().indexOf(needle)
    if (at === -1) continue
    if (line.length <= 200) return { line, start: at, end: at + needle.length }
    const from = Math.max(0, at - 60)
    const to = Math.min(line.length, at + needle.length + 120)
    const clipped = `${from > 0 ? '…' : ''}${line.slice(from, to)}${to < line.length ? '…' : ''}`
    const start = at - from + (from > 0 ? 1 : 0)
    return { line: clipped, start, end: start + needle.length }
  }
  return null
}

/**
 * A summary from the stored body alone. Backups written before the metadata
 * existed fall back to the transcript's own first words; `notLoaded` is the
 * honest status for a conversation nobody has opened this session.
 */
const summaryOf = (stored: Stored): SessionSummary => {
  // The first message whole, its blocks included: its first text part alone was often a block, and its first line the envelope's (#186).
  const preview = stored.preview ?? (firstOpening(stored.turns).slice(0, 120) || null)
  return {
    id: stored.id,
    runtime: stored.runtime,
    title: stored.title ?? null,
    preview,
    cwd: stored.cwd ?? '',
    status: { type: 'notLoaded' },
    createdAt: stored.createdAt ?? stored.updatedAt ?? stored.savedAt,
    updatedAt: stored.updatedAt ?? stored.savedAt,
  }
}
