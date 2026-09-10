import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import type { AcpUsage, AcpUsageRecord } from '@harnessdesk/adapter-acp'

import type { KnownAgent } from '../installs/known-agents.js'

/**
 * Antigravity's own count of what a turn spent, read from its conversation
 * store.
 *
 * The Antigravity ACP server (1.1.1) sends no `usage` and no `usage_update`:
 * its local harness reports usage to it, and it does not pass the report on.
 * What it keeps is one SQLite store per conversation,
 * `<GEMINI_HOME>/antigravity-acp/conversations/<session id>.db`, whose
 * `gen_metadata` table holds a row per model call — and every row carries
 * Codeium's `ModelUsageStats` for that call. A turn's usage is the rows the
 * turn added: the agent's own figures, read, never estimated.
 *
 * Measured on 2026-09-09 against a real store of 40 calls: the row blob's
 * field 1 is the call's metadata and field 4 inside it the usage; output was
 * thinking plus response on every call; and input *plus cache reads* grew
 * call on call where input alone did not — so input excludes the cached part,
 * the way Anthropic counts it, and the whole prompt is input, cache reads and
 * cache writes together. The field numbers are the descriptor's own
 * (`exa.codeium_common_pb.ModelUsageStats`, compiled into the server).
 *
 * The turn's boundary is the server's own answer. Rows are read the moment
 * `session/prompt` resolves; a row committed after that read, and the rows of
 * a turn whose read failed, fall before the next turn's mark — missing from
 * the session's total, never counted twice and never under another turn.
 *
 * Nothing here writes. A WAL database opened read-only maps the `-shm` the
 * server made; where there is none, opening it would create one in the
 * agent's folder, so a store the server does not have open is left unread,
 * and that turn shows no usage rather than a guess.
 */

/** `ModelUsageStats`, by field number. */
const INPUT = 2
const OUTPUT = 3
const CACHE_WRITE = 4
const CACHE_READ = 5
const THINKING = 9

/** A `gen_metadata` row: the call's metadata, and the usage inside it. */
const CALL_METADATA = 1
const CALL_USAGE = 4

/** A session id names a file here, so only a plain one is ever joined to a path. */
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/

/**
 * A turn the store shows no model call for — a command the agent answered
 * itself, a turn stopped before it asked anything. That is news, not silence:
 * the last turn is this one, and it spent nothing.
 */
const NO_CALLS: AcpUsage = { totalTokens: 0, inputTokens: 0, outputTokens: 0 }

export interface AntigravityStoreOptions {
  /** The environment the server runs in; `GEMINI_HOME`, when set, is its `.gemini` folder. */
  readonly env?: Readonly<Record<string, string | undefined>>
  /** The home directory. Tests point it somewhere else. */
  readonly home?: string
  /**
   * Told when a store the server has open is not the shape measured — the
   * one sign that the vendor changed its format, which would otherwise read
   * exactly like a conversation with no usage. Once per session, so a changed
   * format is a line in the log rather than silence, and not a line a turn.
   */
  readonly warn?: (message: string, details?: unknown) => void
}

/** The record for the agent a row drives, when it is one that counts only in its own store. */
export const usageRecordFor = (
  known: Pick<KnownAgent, 'id'> | undefined,
  options: AntigravityStoreOptions = {},
): AcpUsageRecord | undefined => (known?.id === 'antigravity-acp' ? antigravityUsageRecord(options) : undefined)

export const antigravityUsageRecord = (options: AntigravityStoreOptions = {}): AcpUsageRecord => {
  const warned = new Set<string>()
  const unreadable = (sessionId: string, details: Readonly<Record<string, unknown>>): null => {
    if (!warned.has(sessionId)) {
      warned.add(sessionId)
      options.warn?.("Antigravity's conversation store is not the shape this desk reads; its usage is not shown", {
        sessionId,
        ...details,
      })
    }
    return null
  }
  const storeOf = (sessionId: string): string | null => {
    if (!SESSION_ID.test(sessionId)) return null
    const env = options.env ?? process.env
    const gemini = nonEmpty(env['GEMINI_HOME']) ?? join(options.home ?? homedir(), '.gemini')
    return join(gemini, 'antigravity-acp', 'conversations', `${sessionId}.db`)
  }
  return {
    mark(sessionId) {
      const path = storeOf(sessionId)
      if (path === null) return null
      // No store yet: everything it comes to hold is this turn's or later.
      if (!existsSync(path)) return 0
      return readStore(path, (database) => {
        // A store opened before its tables were written is as empty as one
        // that does not exist yet.
        if (!hasCallTable(database)) return 0
        const row = database.prepare('SELECT COALESCE(MAX(idx), -1) + 1 AS next FROM gen_metadata').get() as
          | { next?: unknown }
          | undefined
        return typeof row?.next === 'number' ? row.next : null
      })
    },
    since(sessionId, mark) {
      const path = storeOf(sessionId)
      if (path === null || !existsSync(path)) return null
      return readStore(path, (database) => {
        // After a turn, a store still without its table is not a young one:
        // whatever it is, it is not the format this reads.
        if (!hasCallTable(database)) return unreadable(sessionId, { missing: 'gen_metadata' })
        const rows = database.prepare('SELECT data FROM gen_metadata WHERE idx >= ? ORDER BY idx').all(mark) as {
          data?: unknown
        }[]
        if (rows.length === 0) return NO_CALLS
        const blobs = rows.flatMap((row) => (row.data instanceof Uint8Array ? [row.data] : []))
        return usageOfCalls(blobs) ?? unreadable(sessionId, { rows: rows.length })
      })
    },
  }
}

const hasCallTable = (database: DatabaseSync): boolean =>
  database.prepare("SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = 'gen_metadata'").get() !==
  undefined

/**
 * One query against a store the server has open, and nothing else; null on
 * any failure. Nothing retries it: the turn it was for shows no usage, and
 * its rows fall before the next turn's mark (see above).
 */
const readStore = <T>(path: string, query: (database: DatabaseSync) => T | null): T | null => {
  // See above: without the server's `-shm`, a read-only open would make one.
  if (!existsSync(`${path}-shm`)) return null
  let database: DatabaseSync
  try {
    database = new DatabaseSync(path, { readOnly: true })
  } catch {
    // Locked, or mid-checkpoint: this read answers nothing.
    return null
  }
  try {
    return query(database)
  } catch {
    return null
  } finally {
    database.close()
  }
}

interface CallUsage {
  readonly input: number
  readonly output: number
  readonly cacheRead: number
  readonly cacheWrite: number
  /** Whether the call named a write count at all; see `usageOfCalls`. */
  readonly namedWrite: boolean
  readonly thinking: number
}

/**
 * A turn's calls as ACP's usage, or null when not one of them could be read.
 * ACP's `inputTokens` is the whole input with `cachedReadTokens` a part of it,
 * so the store's three input figures are added back together here.
 */
export const usageOfCalls = (blobs: readonly Uint8Array[]): AcpUsage | null => {
  const calls = blobs.flatMap((blob) => {
    const call = callUsageOf(blob)
    return call ? [call] : []
  })
  if (calls.length === 0) return null
  const sum = (pick: (call: CallUsage) => number): number => calls.reduce((total, call) => total + pick(call), 0)
  const inputTokens = sum((call) => call.input + call.cacheRead + call.cacheWrite)
  const outputTokens = sum((call) => call.output)
  return {
    totalTokens: inputTokens + outputTokens,
    inputTokens,
    outputTokens,
    cachedReadTokens: sum((call) => call.cacheRead),
    // The wire format drops a zero, so a store that never names a write
    // cannot be told from one that had none — and a write count that means
    // "not reported" has to stay absent, or the cache chip reads it as a
    // verdict. Gemini's calls name none; Claude's do.
    ...(calls.some((call) => call.namedWrite) ? { cachedWriteTokens: sum((call) => call.cacheWrite) } : {}),
    thoughtTokens: sum((call) => call.thinking),
  }
}

/** One call's usage out of a `gen_metadata` row, or null for a row not of the measured shape. */
const callUsageOf = (blob: Uint8Array): CallUsage | null => {
  try {
    const metadata = messageAt(blob, CALL_METADATA)
    const usage = metadata ? messageAt(metadata, CALL_USAGE) : null
    if (!usage) return null
    const counts = varints(usage)
    if (!counts.has(INPUT) && !counts.has(OUTPUT)) return null
    return {
      input: counts.get(INPUT) ?? 0,
      output: counts.get(OUTPUT) ?? 0,
      cacheRead: counts.get(CACHE_READ) ?? 0,
      cacheWrite: counts.get(CACHE_WRITE) ?? 0,
      namedWrite: counts.has(CACHE_WRITE),
      thinking: counts.get(THINKING) ?? 0,
    }
  } catch {
    return null
  }
}

// ------------------------------------------------------------ protobuf, read

interface Field {
  readonly number: number
  readonly wire: number
  /** A varint's value; a length-delimited field's length. */
  readonly value: number
  readonly bytes: Uint8Array | null
}

/**
 * The protobuf wire format, only as far as these rows need it: every field of
 * one message, in order. Throws on anything malformed, which the caller turns
 * into "this row is not the shape measured".
 */
function* fieldsOf(message: Uint8Array): Generator<Field> {
  let at = 0
  while (at < message.length) {
    const [tag, afterTag] = varint(message, at)
    const number = Math.floor(tag / 8)
    const wire = tag % 8
    if (number === 0) throw new Error('field number 0')
    if (wire === 0) {
      const [value, after] = varint(message, afterTag)
      at = after
      yield { number, wire, value, bytes: null }
    } else if (wire === 2) {
      const [length, after] = varint(message, afterTag)
      const end = after + length
      if (end > message.length) throw new Error('truncated field')
      at = end
      yield { number, wire, value: length, bytes: message.subarray(after, end) }
    } else if (wire === 1 || wire === 5) {
      at = afterTag + (wire === 1 ? 8 : 4)
      if (at > message.length) throw new Error('truncated field')
    } else {
      throw new Error(`wire type ${wire}`)
    }
  }
}

/**
 * A varint, as a JavaScript number. Exact to 2^53, which no token count, tag
 * or length in these rows comes near; the ten-byte bound is the format's own.
 */
const varint = (bytes: Uint8Array, start: number): [number, number] => {
  let value = 0
  let scale = 1
  for (let at = start; at < bytes.length && at < start + 10; at += 1) {
    const byte = bytes[at]!
    value += (byte & 0x7f) * scale
    if ((byte & 0x80) === 0) return [value, at + 1]
    scale *= 128
  }
  throw new Error('truncated varint')
}

/**
 * An embedded message, every occurrence of the field concatenated. The wire
 * format's rule is that a message field given twice is the two merged, and
 * concatenating their bytes is that merge — so a writer that splits one reads
 * the same as one that does not. Null when the field never occurs.
 */
const messageAt = (message: Uint8Array, number: number): Uint8Array | null => {
  const parts: Uint8Array[] = []
  for (const field of fieldsOf(message)) if (field.number === number && field.bytes) parts.push(field.bytes)
  if (parts.length === 0) return null
  return parts.length === 1 ? parts[0]! : Buffer.concat(parts)
}

/** Every varint field of a message; a field given twice is its last value, as the wire format says. */
const varints = (message: Uint8Array): Map<number, number> => {
  const out = new Map<number, number>()
  for (const field of fieldsOf(message)) if (field.wire === 0) out.set(field.number, field.value)
  return out
}

const nonEmpty = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() !== '' ? value.trim() : null
