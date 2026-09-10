import { createReadStream, existsSync } from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

import type { UsageRow } from './store.js'

/**
 * Reading the agents' own transcripts.
 *
 * Both corpora are append-only JSONL, which is what makes an incremental scan
 * possible: a file is read from the byte where the last scan stopped. Three
 * gigabytes of Codex rollouts are read once, and each later pass touches only
 * what was written since.
 *
 * The two formats count tokens differently and normalising them is the whole
 * job here:
 *
 * - **Codex** reports a running total *and* a per-turn delta, and its
 *   `input_tokens` **includes** the cached ones. Summing the deltas reproduces
 *   the final total exactly, so that is what is summed, with the cached share
 *   subtracted out of input.
 * - **Claude** reports per-message usage with cache counts *beside* input
 *   rather than inside it — and writes the same message id on more than one
 *   line. Summing without dedup double-counts a large share of every session.
 */

export interface ScanTarget {
  readonly runtime: string
  readonly path: string
  readonly size: number
  readonly mtime: number
  readonly kind: 'codex' | 'claude'
}

export interface ScanResult {
  readonly rows: readonly UsageRow[]
  /** Bytes consumed, to resume from. */
  readonly offset: number
  /** Message ids seen at the end of the file, so a resume cannot re-count them. */
  readonly tail: readonly string[]
}

/** How many trailing ids are carried across a resume boundary. */
const TAIL = 64

/**
 * Turns a working directory into the project it belongs to.
 *
 * A turn's `cwd` is wherever the agent happened to be — `packages/ui` one
 * session and the repository root the next — and grouping on it splits one
 * project into a dozen rows nobody recognises. The nearest enclosing
 * repository is what a person means by "project", the same rule the sidebar
 * already follows.
 *
 * Memoised for the life of the process: a scan asks about the same few
 * directories thousands of times.
 */
const roots = new Map<string, string>()

export const projectRootOf = (cwd: string): string => {
  if (cwd === '') return ''
  const known = roots.get(cwd)
  if (known !== undefined) return known
  let dir = cwd
  const walked: string[] = []
  for (;;) {
    const cached = roots.get(dir)
    if (cached !== undefined) {
      for (const step of walked) roots.set(step, cached)
      return cached
    }
    walked.push(dir)
    if (existsSync(join(dir, '.git'))) break
    const parent = dirname(dir)
    if (parent === dir) {
      // No repository above it: the directory is its own project.
      for (const step of walked) roots.set(step, cwd)
      return cwd
    }
    dir = parent
  }
  for (const step of walked) roots.set(step, dir)
  return dir
}

const startOfDay = (at: number): number => {
  const date = new Date(at)
  date.setHours(0, 0, 0, 0)
  return date.getTime()
}

interface Accumulator {
  readonly rows: Map<string, UsageRow>
}

const add = (
  into: Accumulator,
  file: string,
  runtime: string,
  at: number,
  model: string,
  project: string,
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number; reasoning: number },
): void => {
  const day = startOfDay(at)
  // A separator that cannot occur in a model id or a path, so two rows
  // never collide on a key.
  const key = `${day}\u0000${model}\u0000${project}`
  const existing = into.rows.get(key)
  if (existing) {
    into.rows.set(key, {
      ...existing,
      input: existing.input + tokens.input,
      output: existing.output + tokens.output,
      cacheRead: existing.cacheRead + tokens.cacheRead,
      cacheWrite: existing.cacheWrite + tokens.cacheWrite,
      reasoning: existing.reasoning + tokens.reasoning,
      requests: existing.requests + 1,
    })
    return
  }
  into.rows.set(key, {
    file,
    day,
    runtime,
    model,
    project,
    input: tokens.input,
    output: tokens.output,
    cacheRead: tokens.cacheRead,
    cacheWrite: tokens.cacheWrite,
    reasoning: tokens.reasoning,
    requests: 1,
  })
}

const positive = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.round(value) : 0

const parseTime = (value: unknown): number | null => {
  if (typeof value !== 'string') return null
  const at = Date.parse(value)
  return Number.isFinite(at) ? at : null
}

/**
 * Reads one append-only JSONL file from `offset`, line by line.
 *
 * A partial trailing line — the agent was mid-write — is left unconsumed, so
 * the next pass reads it whole rather than dropping it.
 *
 * The offset is counted from **bytes**, not from the decoded line, and that
 * is the whole reason this reads buffers rather than using `readline`.
 * `readline` hands over a line with its terminator already removed and no way
 * to say which terminator it was, so the old `byteLength(line) + 1` was a
 * guess that `\n` had ended it. On a file written with `\r\n` the guess is
 * short by one byte per line, the returned offset lags further with every
 * line, and the next incremental pass starts mid-terminator: the first thing
 * it reads is an empty line or a fragment, `JSON.parse` throws, the `catch`
 * breaks — and that file never yields another record for as long as it
 * exists, because every later pass restarts from the same bad offset.
 *
 * Counting the bytes we actually consumed cannot drift, whichever ending the
 * file uses, and needs no guess about what wrote it.
 */
const readLines = async (
  path: string,
  offset: number,
  onLine: (record: unknown, bytes: number) => void,
): Promise<number> => {
  const stream = createReadStream(path, { start: offset })
  let consumed = offset
  let pending: Buffer = Buffer.alloc(0)
  try {
    for await (const chunk of stream) {
      const next = chunk as Buffer
      pending = pending.length === 0 ? next : Buffer.concat([pending, next])
      let at = pending.indexOf(NEWLINE)
      while (at !== -1) {
        // Everything through the `\n`, which is what the next pass must skip.
        const bytes = at + 1
        const line = pending.subarray(0, at).toString('utf8')
        pending = pending.subarray(bytes)
        if (!take(line, bytes, onLine, (added) => (consumed += added))) return consumed
        at = pending.indexOf(NEWLINE)
      }
    }
  } finally {
    stream.destroy()
  }
  /* Whatever is left has no `\n` after it, so the writer is mid-line or the
     file ends without one. Left unconsumed either way: the next pass reads it
     whole, and a file that never gains a final newline is re-read rather than
     half-parsed. */
  return consumed
}

const NEWLINE = 0x0a

/**
 * One line, and whether to keep going.
 *
 * `trim()` takes the `\r` off a CRLF line along with any other surrounding
 * space — the bytes are already counted, so what the parser sees no longer
 * has to be the same length as what the file held.
 */
const take = (
  line: string,
  bytes: number,
  onLine: (record: unknown, bytes: number) => void,
  advance: (bytes: number) => void,
): boolean => {
  const text = line.trim()
  if (text === '') {
    advance(bytes)
    return true
  }
  let record: unknown
  try {
    record = JSON.parse(text)
  } catch {
    // A half-written final line: stop here and let the next pass have it.
    return false
  }
  onLine(record, bytes)
  advance(bytes)
  return true
}

interface CodexRecord {
  readonly type?: string
  readonly timestamp?: string
  readonly payload?: {
    readonly type?: string
    readonly cwd?: string
    readonly model?: string
    readonly info?: {
      readonly last_token_usage?: {
        readonly input_tokens?: number
        readonly cached_input_tokens?: number
        readonly output_tokens?: number
        readonly reasoning_output_tokens?: number
      }
    }
  }
}

export const scanCodexRollout = async (target: ScanTarget, offset: number): Promise<ScanResult> => {
  const into: Accumulator = { rows: new Map() }
  let model = 'unknown'
  let project = ''
  const consumed = await readLines(target.path, offset, (raw) => {
    const record = raw as CodexRecord
    const payload = record.payload
    if (!payload) return
    if (record.type === 'session_meta' || record.type === 'turn_context') {
      if (typeof payload.cwd === 'string' && payload.cwd !== '') project = projectRootOf(payload.cwd)
      if (typeof payload.model === 'string' && payload.model !== '') model = payload.model
      return
    }
    if (record.type !== 'event_msg' || payload.type !== 'token_count') return
    const last = payload.info?.last_token_usage
    if (!last) return
    const cached = positive(last.cached_input_tokens)
    const input = positive(last.input_tokens)
    const at = parseTime(record.timestamp)
    if (at === null) return
    add(into, target.path, target.runtime, at, model, project, {
      // Codex counts cached tokens inside `input_tokens`; every consumer here
      // expects them beside it, so the cached share comes out.
      input: Math.max(0, input - cached),
      cacheRead: cached,
      cacheWrite: 0,
      output: positive(last.output_tokens),
      reasoning: positive(last.reasoning_output_tokens),
    })
  })
  return { rows: [...into.rows.values()], offset: consumed, tail: [] }
}

interface ClaudeRecord {
  readonly type?: string
  readonly timestamp?: string
  readonly cwd?: string
  readonly requestId?: string
  readonly message?: {
    readonly id?: string
    readonly model?: string
    readonly usage?: {
      readonly input_tokens?: number
      readonly output_tokens?: number
      readonly cache_read_input_tokens?: number
      readonly cache_creation_input_tokens?: number
    }
  }
}

export const scanClaudeTranscript = async (
  target: ScanTarget,
  offset: number,
  tail: readonly string[],
): Promise<ScanResult> => {
  const into: Accumulator = { rows: new Map() }
  // The same assistant message is written on more than one line. Dedup by the
  // provider's own message id, carrying the last few across the resume
  // boundary so a message split by two scans is still counted once.
  const seen = new Set<string>(tail)
  const order: string[] = [...tail]
  const consumed = await readLines(target.path, offset, (raw) => {
    const record = raw as ClaudeRecord
    const usage = record.message?.usage
    if (!usage) return
    const id = record.message?.id ?? record.requestId
    if (typeof id === 'string' && id !== '') {
      if (seen.has(id)) return
      seen.add(id)
      order.push(id)
    }
    const at = parseTime(record.timestamp)
    if (at === null) return
    const model = record.message?.model
    if (typeof model !== 'string' || model === '') return
    add(into, target.path, target.runtime, at, model, projectRootOf(record.cwd ?? ''), {
      input: positive(usage.input_tokens),
      output: positive(usage.output_tokens),
      cacheRead: positive(usage.cache_read_input_tokens),
      cacheWrite: positive(usage.cache_creation_input_tokens),
      reasoning: 0,
    })
  })
  return { rows: [...into.rows.values()], offset: consumed, tail: order.slice(-TAIL) }
}

export const scanFile = (target: ScanTarget, offset: number, tail: readonly string[]): Promise<ScanResult> =>
  target.kind === 'codex' ? scanCodexRollout(target, offset) : scanClaudeTranscript(target, offset, tail)

/** Every `.jsonl` under a root, with the stats a cursor needs. */
const walkJsonl = async (root: string, limit: number): Promise<{ path: string; size: number; mtime: number }[]> => {
  const found: { path: string; size: number; mtime: number }[] = []
  const visit = async (dir: string): Promise<void> => {
    if (found.length >= limit) return
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (found.length >= limit) return
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        await visit(full)
        continue
      }
      if (!entry.name.endsWith('.jsonl')) continue
      try {
        const info = await stat(full)
        found.push({ path: full, size: info.size, mtime: Math.round(info.mtimeMs) })
      } catch {
        // Deleted between the listing and the stat.
      }
    }
  }
  await visit(root)
  return found
}

export interface CorpusSpec {
  readonly runtime: string
  readonly root: string
  readonly kind: 'codex' | 'claude'
}

/** Where each agent keeps its own transcripts. Roots, not credentials. */
export const defaultCorpora = (runtimes: readonly { id: string; kind: 'codex' | 'claude' }[]): CorpusSpec[] =>
  runtimes.map(({ id, kind }) => ({
    runtime: id,
    kind,
    root:
      kind === 'codex'
        ? join(process.env['CODEX_HOME'] ?? join(homedir(), '.codex'), 'sessions')
        : join(process.env['CLAUDE_CONFIG_DIR'] ?? homedir(), '.claude', 'projects'),
  }))

export const listTargets = async (corpora: readonly CorpusSpec[], limit = 20_000): Promise<ScanTarget[]> => {
  const targets: ScanTarget[] = []
  for (const corpus of corpora) {
    for (const file of await walkJsonl(corpus.root, limit)) {
      targets.push({ runtime: corpus.runtime, kind: corpus.kind, ...file })
    }
  }
  return targets
}
