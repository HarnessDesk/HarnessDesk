import { dirname, join } from 'node:path'

import type {
  RuntimeId,
  Session,
  SessionId,
  SessionSummary,
  SessionUsage,
  TranscriptHit,
  Turn,
  AgentItem,
  TurnInsightContext,
} from '@harnessdesk/protocol'
import { isNoticeTurn, openingOfContent, preserveDeskContext, preserveNoticeItems, typedUserText } from '@harnessdesk/protocol'

import { decodeBody, InvalidTranscriptBodyError, NewerTranscriptFormatError, readTranscriptFacts, TranscriptDatabase, TOOL_INDEX_CAP } from './transcript-database.js'
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

export class TranscriptStore {
  readonly #pending = new Map<string, { timer: ReturnType<typeof setTimeout>; session: Session; insight: readonly TurnInsightContext[] }>()
  readonly #writes = new Map<string, Promise<void>>()
  readonly #insight = new Map<string, readonly TurnInsightContext[]>()
  readonly #database: TranscriptDatabase
  readonly #snapshots: DailySessionSnapshots

  constructor(
    directory: string,
    private readonly log: (message: string, details?: Record<string, unknown>) => void = () => {},
  ) {
    this.#database = new TranscriptDatabase(join(dirname(directory), 'sessions.sqlite'))
    this.#snapshots = new DailySessionSnapshots(this.#database.file, {
      onError: error => this.log('conversation snapshot not saved', { error: String(error) }),
    })
    this.#snapshots.schedule()
  }

  /**
   * Notes the session's current transcript for writing. `now` skips the
   * settle delay — the end of a turn is worth a write of its own.
   */
  record(session: Session, options: { readonly now?: boolean; readonly insight?: readonly TurnInsightContext[] } = {}): void {
    if (!session.itemsLoaded) return
    if (!session.turns.some((turn) => turn.items.length > 0) && !(options.insight?.length)) return
    const key = keyOf(session.runtime, session.id)
    if (options.insight?.length) {
      const previous = this.#insight.get(key) ?? []
      const byTurn = new Map(previous.map((context) => [context.turn, context]))
      for (const context of options.insight) byTurn.set(context.turn, context)
      this.#insight.set(key, [...byTurn.values()].slice(-2000))
    }
    const pending = this.#pending.get(key)
    if (pending) clearTimeout(pending.timer)
    const timer = setTimeout(() => {
      this.#pending.delete(key)
      void this.#write(session, this.#insight.get(key) ?? [])
    }, options.now ? 0 : SETTLE_MS)
    this.#pending.set(key, { timer, session, insight: this.#insight.get(key) ?? [] })
  }

  async #write(session: Session, insight: readonly TurnInsightContext[] = []): Promise<void> {
    const key = keyOf(session.runtime, session.id)
    const previous = this.#writes.get(key) ?? Promise.resolve()
    const next = previous.then(async () => {
      let stored: Stored = {
        version: FORMAT,
        runtime: session.runtime,
        id: session.id,
        savedAt: Date.now(),
        turns: session.turns,
        usage: session.usage ?? null,
        title: session.title ?? null,
        preview: session.preview ?? null,
        cwd: session.cwd,
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
        if (current) {
          const retained = new Set(stored.turns.map(turn => String(turn.id)))
          const contexts = new Map((current.insight ?? []).filter(context => retained.has(context.turn)).map(context => [context.turn, context]))
          for (const context of insight) contexts.set(context.turn, context)
          stored = { ...stored, turns: withDeskContext(stored.turns, current.turns),
            ...(contexts.size ? { insight: [...contexts.values()] } : {}) }
        }
        this.#database.write(stored, session.runtime, session.id, { reconcile })
        this.#snapshots.schedule()
      } catch (error) {
        this.log(error instanceof NewerTranscriptFormatError ? 'transcript from a newer format left untouched' : 'transcript not saved',
          { session: session.id, error: String(error) })
      }
    })
    this.#writes.set(key, next)
    await next
  }

  /** Flush a pending settle before reading, or await this conversation's in-flight write.
   * The writer reads rows directly and never calls this path, so it cannot wait on itself.
   */
  async #settle(runtime: RuntimeId, id: SessionId): Promise<void> {
    const key = keyOf(runtime, id)
    const pending = this.#pending.get(key)
    if (pending) {
      clearTimeout(pending.timer)
      this.#pending.delete(key)
      await this.#write(pending.session, pending.insight)
      return
    }
    await this.#writes.get(key)?.catch(() => {})
  }

  async #read(runtime: RuntimeId, id: SessionId): Promise<Stored | null> {
    await this.#settle(runtime, id)
    try { return this.#database.read(runtime, id) }
    catch { return null }
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
      createdAt: at,
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
    const stored = await this.#read(session.runtime, session.id)
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
      WHERE ${match}(instr(items_fts.message_text,?)>0${options.includeTools ? ' OR instr(items_fts.tool_text,?)>0' : ''})
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
    const rows = this.#database.db.prepare(`SELECT runtime,id FROM bodies${runtime === undefined ? '' : ' WHERE runtime=?'} ORDER BY runtime,id`)
      .all(...(runtime === undefined ? [] : [runtime]))
    return rows.map(row => {
      const data = this.#database.read(String(row.runtime), String(row.id))
      if (!data) throw new Error('A stored transcript is invalid; its runtime export cannot replace the ledger window')
      return { runtime: String(row.runtime), id: String(row.id), data }
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
    const incoming = data as Partial<Stored>
    if (
      typeof incoming !== 'object' ||
      incoming === null ||
      incoming.version !== FORMAT ||
      !Array.isArray(incoming.turns) ||
      incoming.turns.some((turn) => typeof turn !== 'object' || turn === null || !Array.isArray(turn.items)) ||
      typeof incoming.savedAt !== 'number'
    ) {
      return 'refused'
    }
    const existing = await this.#read(runtime as RuntimeId, id as SessionId)
    if (existing && existing.savedAt >= incoming.savedAt) return 'skipped'
    try {
      this.#database.write(incoming as Stored, runtime as RuntimeId, id as SessionId)
      this.#snapshots.schedule()
    }
    catch { return 'refused' }
    const written = await this.#read(runtime as RuntimeId, id as SessionId)
    return written && written.savedAt === incoming.savedAt && written.turns.length === incoming.turns.length
      ? 'restored'
      : 'refused'
  }

  /**
   * Drops the host's copy of one session, and any write still queued for it.
   *
   * Called when a conversation is deleted. The pending write is cancelled
   * first: a settle timer that fired afterwards would write the transcript
   * back out, and a deleted conversation that returns from the dead a second
   * later is worse than one that was never deleted.
   */
  async forget(runtime: RuntimeId, id: SessionId): Promise<void> {
    const key = keyOf(runtime, id)
    const pending = this.#pending.get(key)
    if (pending) {
      clearTimeout(pending.timer)
      this.#pending.delete(key)
    }
    this.#insight.delete(key)
    // Wait out a write already in flight, or the deletion races it.
    await this.#writes.get(key)?.catch(() => {})
    this.#writes.delete(key)
    this.#database.forget(runtime, id)
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
    const waiting = [...this.#pending.values()]
    for (const entry of waiting) clearTimeout(entry.timer)
    this.#pending.clear()
    await Promise.all(waiting.map((entry) => this.#write(entry.session, entry.insight)))
    await Promise.all([...this.#writes.values()])
  }
  async close(): Promise<void> {
    await this.flush()
    await this.#snapshots.close()
    this.#database.close()
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
    createdAt: stored.updatedAt ?? stored.savedAt,
    updatedAt: stored.updatedAt ?? stored.savedAt,
  }
}
