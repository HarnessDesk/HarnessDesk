import { createHash } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { typedUserText, type AgentItem, type RuntimeId, type SessionId, type Turn, type TurnInsightContext } from '@harnessdesk/protocol'
import { openSessionDatabase, transaction } from './session-database.js'
import type { Stored } from './transcripts.js'

export const TOOL_INDEX_CAP = 3000

/** Only output, never tool arguments, command text, or reasoning. */
export function toolOutput(item: AgentItem): string {
  if (item.type === 'command') return item.output ?? ''
  if (item.type !== 'toolCall') return ''
  return [...(item.result ?? []).flatMap(part => part.type === 'text' ? [part.text] : part.type === 'json' ? [JSON.stringify(part.value)] : []),
    ...(item.error ? [item.error] : [])].join('\n')
}

const textOf = (item: AgentItem): string => item.type === 'assistantMessage' ? item.text ?? ''
  : item.type === 'userMessage' ? Array.isArray(item.content) ? typedUserText(item.content) : '' : toolOutput(item)
interface TurnRow { turn_id: string; seq: number; payload: string; insight: string | null; fingerprint: string }
interface ItemRow { seq: number; item_id: string; position: number; payload: string }
type Facts = Omit<Stored, 'turns' | 'insight'> & { insightOrder?: readonly string[]; orphanInsight?: readonly TurnInsightContext[] }

/** A single body's JSON is unusable; this does not indicate a database failure. */
export class InvalidTranscriptBodyError extends Error {}

const decodeBody = <T>(decode: () => T): T => {
  try { return decode() }
  catch (error) { throw new InvalidTranscriptBodyError('A stored transcript cannot be decoded', { cause: error }) }
}

/** Row storage only. The TranscriptStore above it owns reconciliation and settle. */
export class TranscriptDatabase {
  #db: DatabaseSync | undefined
  #dataVersion = -1
  readonly #fingerprints = new Map<string, Map<string, string>>()
  constructor(readonly file: string) {}
  get db(): DatabaseSync { return this.#db ??= openSessionDatabase(this.file) }

  read(runtime: string, id: string, messagesOnly = false): Stored | null {
    const row = this.db.prepare('SELECT payload FROM bodies WHERE runtime=? AND id=?').get(runtime, id)
    if (!row) return null
    const parsed = decodeBody(() => {
      const value = JSON.parse(String(row.payload)) as Facts | null
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid transcript facts')
      return value
    })
    if (parsed.version !== 1) return null
    const rows = this.db.prepare('SELECT * FROM turns WHERE runtime=? AND id=? ORDER BY seq').all(runtime, id) as unknown as TurnRow[]
    const itemRows = this.db.prepare(`SELECT turn_id,payload FROM items WHERE runtime=? AND id=?${messagesOnly ? " AND kind='userMessage'" : ''} ORDER BY position,seq`)
      .all(runtime, id) as unknown as { turn_id: string; payload: string }[]
    // Keep all SQL reads outside this boundary: only this conversation's
    // decoding can be ignored when a later live record is available.
    return decodeBody(() => {
      const { insightOrder, orphanInsight, ...facts } = parsed
      const itemsByTurn = new Map<string, AgentItem[]>()
      for (const row of itemRows) {
        const items = itemsByTurn.get(row.turn_id) ?? []
        items.push(JSON.parse(row.payload) as AgentItem)
        itemsByTurn.set(row.turn_id, items)
      }
      const contexts = new Map((orphanInsight ?? []).map(context => [context.turn, context]))
      const turns = rows.map(row => {
        const metadata = JSON.parse(row.payload) as { version: number; turn: Omit<Turn, 'items'> }
        if (metadata.version !== 1) throw new Error('A stored turn has an unsupported format')
        if (row.insight) contexts.set(row.turn_id, JSON.parse(row.insight) as TurnInsightContext)
        return { ...metadata.turn, items: itemsByTurn.get(row.turn_id) ?? [] }
      })
      return { ...facts, turns, ...(insightOrder ? { insight: insightOrder.map(id => {
        const context = contexts.get(id)
        if (!context) throw new Error('A stored turn context is missing')
        return context
      }) } : {}) }
    })
  }

  write(stored: Stored, runtime = stored.runtime, id = stored.id): void {
    const version = Number(this.db.prepare('PRAGMA data_version').get()?.data_version)
    if (version !== this.#dataVersion) { this.#fingerprints.clear(); this.#dataVersion = version }
    const key = JSON.stringify([runtime, id])
    const previous = this.#fingerprints.get(key) ?? new Map((this.db.prepare('SELECT turn_id,fingerprint FROM turns WHERE runtime=? AND id=?')
      .all(runtime, id) as unknown as TurnRow[]).map(row => [row.turn_id, row.fingerprint]))
    const next = new Map<string, string>()
    const contexts = new Map((stored.insight ?? []).map(context => [context.turn, context]))
    transaction(this.db, () => {
      const { turns, insight, ...facts } = stored
      const turnIds = new Set(turns.map(turn => String(turn.id)))
      const orphanInsight = insight?.filter(context => !turnIds.has(context.turn))
      this.db.prepare(`INSERT INTO sessions(runtime,id,origin,cwd,created_at,updated_at,body,saved_at,usage,preview)
        VALUES(?,?,'desk',?,?,?,'full',?,?,?) ON CONFLICT(runtime,id) DO UPDATE SET body='full',saved_at=excluded.saved_at,
          usage=excluded.usage,preview=COALESCE(excluded.preview,sessions.preview)`)
        .run(runtime, id, stored.cwd ?? '', stored.updatedAt ?? stored.savedAt, stored.updatedAt ?? stored.savedAt,
          stored.savedAt, stored.usage ? JSON.stringify(stored.usage) : null, stored.preview ?? null)
      this.db.prepare('INSERT INTO bodies(runtime,id,payload) VALUES(?,?,?) ON CONFLICT(runtime,id) DO UPDATE SET payload=excluded.payload')
        .run(runtime, id, JSON.stringify({ ...facts, ...(insight ? { insightOrder: insight.map(context => context.turn),
          ...(orphanInsight?.length ? { orphanInsight } : {}) } : {}) }))
      for (const [seq, turn] of turns.entries()) {
        const context = contexts.get(String(turn.id))
        const fingerprint = createHash('sha256').update(JSON.stringify([seq, turn, context ?? null])).digest('hex')
        next.set(String(turn.id), fingerprint)
        if (previous.get(String(turn.id)) === fingerprint) continue
        const { items, ...metadata } = turn
        this.db.prepare(`INSERT INTO turns(runtime,id,turn_id,seq,payload,insight,fingerprint) VALUES(?,?,?,?,?,?,?)
          ON CONFLICT(runtime,id,turn_id) DO UPDATE SET seq=excluded.seq,payload=excluded.payload,insight=excluded.insight,fingerprint=excluded.fingerprint`)
          .run(runtime, id, turn.id, seq, JSON.stringify({ version: 1, turn: metadata }), context ? JSON.stringify(context) : null, fingerprint)
        const existing = this.db.prepare('SELECT seq,item_id,position,payload FROM items WHERE runtime=? AND id=? AND turn_id=? ORDER BY position,seq')
          .all(runtime, id, turn.id) as unknown as ItemRow[]
        const byId = new Map<string, ItemRow[]>()
        for (const row of existing) { const occurrences = byId.get(row.item_id) ?? []; occurrences.push(row); byId.set(row.item_id, occurrences) }
        const retained = new Set<number>()
        let sequence = Number(this.db.prepare('SELECT COALESCE(MAX(seq),-1) AS seq FROM items WHERE runtime=? AND id=?').get(runtime, id)?.seq) + 1
        for (const [position, item] of items.entries()) {
          const row = byId.get(String(item.id))?.shift()
          const seq = row?.seq ?? sequence++
          retained.add(seq)
          const payload = JSON.stringify(item)
          if (row?.payload === payload && row.position === position) continue
          const text = textOf(item)
          const message = item.type === 'userMessage' || item.type === 'assistantMessage'
          this.db.prepare(`INSERT INTO items(runtime,id,seq,turn_id,item_id,position,kind,role,text,message_text,tool_text,payload)
            VALUES(?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(runtime,id,seq) DO UPDATE SET position=excluded.position,
              kind=excluded.kind,role=excluded.role,text=excluded.text,message_text=excluded.message_text,tool_text=excluded.tool_text,payload=excluded.payload`)
            .run(runtime, id, seq, turn.id, String(item.id ?? ''), position, item.type, message ? item.type === 'userMessage' ? 'user' : 'assistant' : null,
              text, message ? text.toLowerCase() : '', message ? '' : toolOutput(item).slice(0, TOOL_INDEX_CAP).toLowerCase(), payload)
        }
        for (const row of existing) if (!retained.has(row.seq)) this.db.prepare('DELETE FROM items WHERE runtime=? AND id=? AND seq=?').run(runtime, id, row.seq)
      }
      for (const turn of previous.keys()) if (!next.has(turn)) {
        this.db.prepare('DELETE FROM items WHERE runtime=? AND id=? AND turn_id=?').run(runtime, id, turn)
        this.db.prepare('DELETE FROM turns WHERE runtime=? AND id=? AND turn_id=?').run(runtime, id, turn)
      }
      this.db.prepare('INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT DO NOTHING').run(`transcripts:runtime:${runtime}`, '1')
    })
    this.#fingerprints.set(key, next)
  }

  forget(runtime: RuntimeId, id: SessionId): void {
    transaction(this.db, () => {
      for (const table of ['items', 'turns', 'bodies']) this.db.prepare(`DELETE FROM ${table} WHERE runtime=? AND id=?`).run(runtime, id)
      this.db.prepare("UPDATE sessions SET body='none',saved_at=NULL,usage=NULL WHERE runtime=? AND id=?").run(runtime, id)
    })
    this.#fingerprints.delete(JSON.stringify([runtime, id]))
  }

  close(): void { this.#db?.close(); this.#db = undefined; this.#fingerprints.clear(); this.#dataVersion = -1 }
}
