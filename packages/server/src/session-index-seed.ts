import { open, readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setImmediate } from 'node:timers/promises'

import type { RuntimeId, SessionId, SessionSummary } from '@harnessdesk/protocol'

const WINDOW = 64 * 1_024
const BATCH = 32
const FIELDS = new Set(['version', 'runtime', 'id', 'savedAt', 'title', 'preview', 'cwd', 'updatedAt', 'createdAt'])
type Metadata = Record<string, unknown>

const whitespace = (char: string | undefined): boolean => char !== undefined && /\s/.test(char)
const before = (text: string, index: number): number => {
  while (index >= 0 && whitespace(text[index])) index--
  return index
}
const after = (text: string, index: number): number => {
  while (index < text.length && whitespace(text[index])) index++
  return index
}
const escaped = (text: string, index: number): boolean => {
  let slashes = 0
  while (index > 0 && text[--index] === '\\') slashes++
  return slashes % 2 === 1
}
const stringEnd = (text: string, start: number): number => {
  for (let i = start + 1; i < text.length; i++) if (text[i] === '"' && !escaped(text, i)) return i
  return -1
}
const stringStart = (text: string, end: number): number => {
  for (let i = end - 1; i >= 0; i--) if (text[i] === '"' && !escaped(text, i)) return i
  return -1
}

/** Find a complete JSON value without interpreting a turns array. */
const valueEnd = (text: string, start: number): number => {
  if (text[start] === '"') return stringEnd(text, start)
  if (text[start] !== '{' && text[start] !== '[') {
    for (let i = start; i < text.length; i++) if (text[i] === ',' || text[i] === '}') return before(text, i - 1)
    return -1
  }
  let depth = 0
  for (let i = start; i < text.length; i++) {
    const char = text[i]
    if (char === '"') { i = stringEnd(text, i); if (i < 0) return -1 }
    else if (char === '{' || char === '[') depth++
    else if ((char === '}' || char === ']') && --depth === 0) return i
  }
  return -1
}
const valueStart = (text: string, end: number): number => {
  if (text[end] === '"') return stringStart(text, end)
  if (text[end] !== '}' && text[end] !== ']') {
    let i = end
    while (i >= 0 && text[i] !== ':' && text[i] !== ',') i--
    return after(text, i + 1)
  }
  let depth = 0
  for (let i = end; i >= 0; i--) {
    const char = text[i]
    if (char === '"' && !escaped(text, i)) { i = stringStart(text, i); if (i < 0) return -1 }
    else if (char === '}' || char === ']') depth++
    else if ((char === '{' || char === '[') && --depth === 0) return i
  }
  return -1
}

/** Read only complete root members; nested titles are never mistaken for metadata. */
const headerFields = (text: string): Metadata => {
  const fields: Metadata = {}
  let cursor = after(text, 0)
  if (text[cursor++] !== '{') return fields
  while (cursor < text.length) {
    cursor = after(text, cursor)
    if (text[cursor] !== '"') break
    const keyEnd = stringEnd(text, cursor)
    if (keyEnd < 0) break
    const key = JSON.parse(text.slice(cursor, keyEnd + 1)) as string
    cursor = after(text, keyEnd + 1)
    if (text[cursor++] !== ':') break
    cursor = after(text, cursor)
    const end = valueEnd(text, cursor)
    if (end < 0) break
    if (FIELDS.has(key)) fields[key] = JSON.parse(text.slice(cursor, end + 1)) as unknown
    cursor = after(text, end + 1)
    if (text[cursor++] !== ',') break
  }
  return fields
}
const tailFields = (text: string): Metadata => {
  const fields: Metadata = {}
  let cursor = before(text, text.length - 1)
  if (text[cursor--] !== '}') return fields
  while (cursor >= 0) {
    cursor = before(text, cursor)
    const start = valueStart(text, cursor)
    if (start < 0) break
    const colon = before(text, start - 1)
    if (text[colon] !== ':') break
    const keyEnd = before(text, colon - 1)
    if (text[keyEnd] !== '"') break
    const keyStart = stringStart(text, keyEnd)
    if (keyStart < 0) break
    const key = JSON.parse(text.slice(keyStart, keyEnd + 1)) as string
    if (FIELDS.has(key)) fields[key] = JSON.parse(text.slice(start, cursor + 1)) as unknown
    cursor = before(text, keyStart - 1)
    if (text[cursor--] !== ',') break
  }
  return fields
}

const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)
const readSummary = async (file: string, runtime: string, id: string): Promise<SessionSummary | null> => {
  const handle = await open(file, 'r')
  try {
    const stat = await handle.stat()
    if (!stat.isFile()) return null
    const head = Buffer.alloc(Math.min(WINDOW, stat.size))
    const tail = Buffer.alloc(Math.min(WINDOW, stat.size))
    const headRead = await handle.read(head, 0, head.length, 0)
    const tailRead = await handle.read(tail, 0, tail.length, Math.max(0, stat.size - tail.length))
    let fields: Metadata
    try {
      fields = { ...headerFields(head.subarray(0, headRead.bytesRead).toString('utf8')),
        ...tailFields(tail.subarray(0, tailRead.bytesRead).toString('utf8')) }
    } catch {
      // A small older file can be validated as a whole. A large malformed
      // transcript is skipped rather than parsing its body on the launch loop.
      if (stat.size > WINDOW * 2) return null
      fields = JSON.parse(await handle.readFile('utf8')) as Metadata
    }
    if (fields.version !== 1 || fields.runtime !== runtime || fields.id !== id) return null
    const timestamp = finite(fields.updatedAt) ? fields.updatedAt : finite(fields.savedAt) ? fields.savedAt : stat.mtimeMs
    return { runtime: runtime as RuntimeId, id: id as SessionId,
      title: typeof fields.title === 'string' ? fields.title : null,
      preview: typeof fields.preview === 'string' ? fields.preview : null,
      cwd: typeof fields.cwd === 'string' ? fields.cwd : '', status: { type: 'notLoaded' },
      createdAt: finite(fields.createdAt) ? fields.createdAt : timestamp, updatedAt: timestamp }
  } finally { await handle.close() }
}

/** The old stores are read-only. Yield bounded batches and release the launch loop. */
export async function* seedSummaries(stateDir: string): AsyncGenerator<readonly SessionSummary[]> {
  await setImmediate()
  const archived = new Set<string>()
  try {
    const archive = JSON.parse(await readFile(join(stateDir, 'archive.json'), 'utf8')) as { version?: unknown; entries?: unknown }
    if (archive.version === 1 && Array.isArray(archive.entries)) for (const entry of archive.entries as { runtime?: unknown; sessionId?: unknown }[]) {
      if (typeof entry?.runtime === 'string' && typeof entry.sessionId === 'string') archived.add(JSON.stringify([entry.runtime, entry.sessionId]))
    }
  } catch { /* Missing marks are the same as the existing archive's empty fallback. */ }
  const root = join(stateDir, 'transcripts')
  let runtimes
  try { runtimes = await readdir(root, { withFileTypes: true }) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
  let batch: SessionSummary[] = []
  for (const runtime of runtimes) {
    if (!runtime.isDirectory()) continue
    const folder = join(root, runtime.name)
    const files = await readdir(folder, { withFileTypes: true })
    for (const entry of files) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue
      try {
        const id = decodeURIComponent(entry.name.slice(0, -5))
        const summary = await readSummary(join(folder, entry.name), runtime.name, id)
        if (summary) batch.push({ ...summary, archived: archived.has(JSON.stringify([runtime.name, id])) })
      } catch { /* Unreadable, newer or invalid files stay untouched. */ }
      if (batch.length === BATCH) { yield batch; batch = []; await setImmediate() }
    }
  }
  if (batch.length) yield batch
}
