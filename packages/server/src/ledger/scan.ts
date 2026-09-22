import { createReadStream, existsSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { readdir, readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { createInterface } from 'node:readline'
import type { DatabaseSync } from 'node:sqlite'

import { errnoOf, NOTHING_HERE, NOTHING_YET } from '../errno.js'
import { readForeignDatabase } from './foreign-db.js'
import type { UsageRow } from './store.js'
import type { InsightScanOptions, UsageSample } from './insight.js'
import type { Measure } from '@harnessdesk/protocol'

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
 * - **Qwen Code** appends one record per model call, Claude-style, with the
 *   Gemini API's `usageMetadata` on it — whose prompt count *includes* the
 *   cached part, as Codex's does.
 *
 * Three more agents keep their records in a shape that is rewritten rather
 * than appended to, and those are read whole each time they change, their
 * rows replaced — see `wholeFile`:
 *
 * - **Gemini CLI** writes a JSONL log per chat in which a message is written
 *   again as it fills in, and a rewind hides messages without un-spending them.
 * - **OpenCode** keeps a SQLite database with each session's tokens and the
 *   cost it priced them at.
 * - **Cline** keeps a SQLite database with each session's usage and the cost
 *   Cline billed for it.
 */

/** Which agent's own records a runtime's spend is read from, and so how they are read. */
export type CorpusKind = 'codex' | 'claude' | 'gemini' | 'qwen' | 'opencode' | 'cline'

/**
 * Formats an agent rewrites rather than appends to. Each changed file is read
 * from its start and its rows replaced, which the file-keyed rows make safe.
 */
export const wholeFile = (kind: CorpusKind): boolean => kind === 'gemini' || kind === 'opencode' || kind === 'cline'

export interface ScanTarget {
  readonly runtime: string
  readonly path: string
  readonly size: number
  readonly mtime: number
  readonly kind: CorpusKind
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
 * already follows; a folder with no repository above it is its own project.
 *
 * Memoised for the life of the process: a scan asks about the same few
 * directories thousands of times. What is remembered for each folder walked is
 * the repository at or above it, or that there is none — never the answer for
 * the folder the walk began at. Remembering that answer for the ancestors too,
 * as this once did, filed every later folder with no repository under the first
 * such folder seen: `/work/a` then `/work/b` both came back `/work/a`, because
 * the walk from `b` stopped at `/work` and took what was cached there.
 */
const repositories = new Map<string, string | null>()

const repositoryAbove = (start: string): string | null => {
  const walked: string[] = []
  let dir = start
  let found: string | null
  for (;;) {
    const cached = repositories.get(dir)
    if (cached !== undefined) {
      found = cached
      break
    }
    walked.push(dir)
    if (existsSync(join(dir, '.git'))) {
      found = dir
      break
    }
    const parent = dirname(dir)
    if (parent === dir) {
      found = null
      break
    }
    dir = parent
  }
  for (const step of walked) repositories.set(step, found)
  return found
}

export const projectRootOf = (cwd: string): string => (cwd === '' ? '' : (repositoryAbove(cwd) ?? cwd))

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
  tokens: {
    input: number
    output: number
    cacheRead: number
    cacheWrite: number
    reasoning: number
    /** What the agent itself says these requests cost, when it says. */
    vendorCost?: number | null
  },
): void => {
  const day = startOfDay(at)
  const vendorCost = tokens.vendorCost ?? null
  // A separator that cannot occur in a model id or a path, so two rows
  // never collide on a key. Requests the agent priced and requests it did not
  // never share a row either: a sum of both has no honest cost, and would call
  // the unpriced ones the agent's own.
  const key = `${day}\u0000${model}\u0000${project}\u0000${vendorCost === null ? 0 : 1}`
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
      vendorCost: sumCost(existing.vendorCost ?? null, vendorCost),
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
    vendorCost,
  })
}

/** Null only when neither side was priced by the agent. */
export const sumCost = (a: number | null, b: number | null): number | null =>
  a === null && b === null ? null : (a ?? 0) + (b ?? 0)

const positive = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.round(value) : 0

/** A missing field in a source record is evidence we do not have, never a zero. */
const observedCount = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.round(value) : null

const observedSum = (...values: readonly (number | null)[]): number | null =>
  values.every((value) => value !== null) ? values.reduce((sum, value) => sum + value!, 0) : null

const measure = (value: unknown): Measure =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? { value: Math.round(value), quality: 'exact' }
    : { value: null, quality: 'unknown' }

/** Detail rows never reveal agent-owned paths over the wire; the source key is stable only for this read. */
const sourceFor = (target: ScanTarget, at: number | null) => {
  const digest = createHash('sha256').update(target.path).digest('hex').slice(0, 16)
  return {
    id: `corpus:${target.kind}:${target.runtime}:${digest}`,
    kind: 'corpus' as const,
    label: 'Recorded usage',
    observedAt: at,
    checkedAt: Date.now(),
    stale: false,
    problem: null,
  }
}

const emit = (
  insight: InsightScanOptions | undefined, target: ScanTarget, identity: string, at: number | null, model: string | null,
  project: string | null, tokens: { input: unknown; output: unknown; cacheRead: unknown; cacheWrite: unknown }, scope: 'call' | 'session',
  vendorCost: number | null = null,
  sessionId: string | null = null,
): void => {
  if (!insight) return
  if (insight.signal?.aborted) throw new DOMException('Insight read cancelled.', 'AbortError')
  const source = sourceFor(target, at)
  const sourceKey = `${source.id}:${identity}`
  insight.emit({
    key: createHash('sha256').update(sourceKey).digest('hex'), source, runtime: target.runtime,
    sessionId, turnId: null, requestId: identity || null, project, model, from: at, to: at,
    scope, includesChildren: null, input: measure(tokens.input), output: measure(tokens.output),
    cacheRead: measure(tokens.cacheRead), cacheWrite: measure(tokens.cacheWrite),
    usd: vendorCost === null ? { value: null, quality: 'unknown' } : { value: vendorCost, quality: 'exact' },
    moneyBasis: vendorCost === null ? 'unknown' : 'vendorMetered',
  })
}

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
  /* What is left has no `\n` after it: the writer is mid-line, or the file
     simply ends without one. Told apart the way the old implementation did —
     by trying to parse it. A half-written line is not JSON and is left for
     the next pass; a whole record that happens to end the file is taken.
     Dropping it instead was a regression review caught: the caller commits
     the file's size with the offset, so an unchanged file is skipped from
     then on and that last record is never counted — not on the next pass,
     and not on a full rescan either, because the newline it is waiting for
     is never coming. */
  if (pending.length > 0) take(pending.toString('utf8'), pending.length, onLine, (added) => (consumed += added))
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
    readonly id?: string
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

export const scanCodexRollout = async (
  target: ScanTarget,
  offset: number,
  tail: readonly string[] = [],
  insight?: InsightScanOptions,
): Promise<ScanResult> => {
  const into: Accumulator = { rows: new Map() }
  /* The model and the project are said near the top — `session_meta`, then
     `turn_context` at each turn — and a resumed scan starts after them, so
     every row it found read 'unknown' with no project (#33). What they were
     where the last scan stopped travels in the cursor's tail, the slot the
     Claude scan uses for the message ids it has seen. A cursor written before
     the tail carried them has an offset and nothing else, and reads them once
     from the part of the file it had already counted (review, round 2). */
  const context = contextFrom(tail) ?? (offset > 0 ? await contextBefore(target.path, offset) : unknownContext())
  const consumed = await readLines(target.path, offset, (raw) => {
    const record = raw as CodexRecord
    const payload = record.payload
    if (!payload) return
    if (noteContext(record, context)) return
    if (record.type !== 'event_msg' || payload.type !== 'token_count') return
    const last = payload.info?.last_token_usage
    if (!last) return
    const cached = positive(last.cached_input_tokens)
    const input = positive(last.input_tokens)
    const at = parseTime(record.timestamp)
    if (at === null) return
    const tokens = {
      // Codex counts cached tokens inside `input_tokens`; every consumer here
      // expects them beside it, so the cached share comes out.
      input: Math.max(0, input - cached),
      cacheRead: cached,
      cacheWrite: 0,
      output: positive(last.output_tokens),
      reasoning: positive(last.reasoning_output_tokens),
    }
    add(into, target.path, target.runtime, at, context.model, context.project, tokens)
    emit(insight, target, JSON.stringify(raw), at, context.model, context.project || null, {
      input: typeof last.input_tokens === 'number' && typeof last.cached_input_tokens === 'number' ? Math.max(0, last.input_tokens - last.cached_input_tokens) : last.input_tokens,
      output: last.output_tokens, cacheRead: last.cached_input_tokens, cacheWrite: undefined,
    }, 'call', null, context.sessionId ?? null)
  })
  return { rows: [...into.rows.values()], offset: consumed, tail: [JSON.stringify(context)] }
}

interface CodexContext {
  model: string
  project: string
  sessionId?: string
}

const unknownContext = (): CodexContext => ({ model: 'unknown', project: '' })

/** Notes what a `session_meta` or `turn_context` record says of the model and project; false for any other record. */
const noteContext = (record: CodexRecord, context: CodexContext): boolean => {
  if (record.type !== 'session_meta' && record.type !== 'turn_context') return false
  const payload = record.payload
  if (typeof payload?.cwd === 'string' && payload.cwd !== '') context.project = projectRootOf(payload.cwd)
  if (typeof payload?.model === 'string' && payload.model !== '') context.model = payload.model
  if (record.type === 'session_meta' && typeof payload?.id === 'string' && payload.id !== '') context.sessionId = payload.id
  return true
}

/** The model and project a Codex scan had reached, from the tail it left; null where the tail carries none. */
const contextFrom = (tail: readonly string[]): CodexContext | null => {
  try {
    const parsed: unknown = JSON.parse(tail[0] ?? '')
    if (parsed !== null && typeof parsed === 'object') {
      const { model, project, sessionId } = parsed as Record<string, unknown>
      const context: CodexContext = {
        model: typeof model === 'string' && model !== '' ? model : 'unknown',
        project: typeof project === 'string' ? project : '',
      }
      if (typeof sessionId === 'string' && sessionId !== '') context.sessionId = sessionId
      return context
    }
  } catch {
    // A cursor written before the tail carried this, or none at all.
  }
  return null
}

/**
 * What a rollout had said of its model and project before `offset`, for a
 * cursor that carried neither. Only the lines that can say so are parsed.
 */
const contextBefore = async (path: string, offset: number): Promise<CodexContext> => {
  const context = unknownContext()
  const stream = createReadStream(path, { start: 0, end: offset - 1 })
  try {
    for await (const line of createInterface({ input: stream, crlfDelay: Infinity })) {
      if (!line.includes('"session_meta"') && !line.includes('"turn_context"')) continue
      try {
        noteContext(JSON.parse(line) as CodexRecord, context)
      } catch {
        // A line that is not JSON says nothing.
      }
    }
  } catch {
    // Unreadable now: nothing is known, as before.
  } finally {
    stream.destroy()
  }
  return context
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
  insight?: InsightScanOptions,
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
    const project = projectRootOf(record.cwd ?? '')
    const tokens = {
      input: positive(usage.input_tokens),
      output: positive(usage.output_tokens),
      cacheRead: positive(usage.cache_read_input_tokens),
      cacheWrite: positive(usage.cache_creation_input_tokens),
      reasoning: 0,
    }
    add(into, target.path, target.runtime, at, model, project, tokens)
    emit(insight, target, id ?? JSON.stringify(raw), at, model, project || null, {
      input: usage.input_tokens, output: usage.output_tokens, cacheRead: usage.cache_read_input_tokens, cacheWrite: usage.cache_creation_input_tokens,
    }, 'call')
  })
  return { rows: [...into.rows.values()], offset: consumed, tail: order.slice(-TAIL) }
}

/** The Gemini API's own counts, which Qwen Code records as it received them. */
interface GeminiUsage {
  readonly promptTokenCount?: number
  readonly candidatesTokenCount?: number
  readonly cachedContentTokenCount?: number
  readonly thoughtsTokenCount?: number
  readonly toolUsePromptTokenCount?: number
}

interface QwenRecord {
  readonly uuid?: string
  readonly type?: string
  readonly timestamp?: string
  readonly cwd?: string
  readonly model?: string
  readonly usageMetadata?: GeminiUsage
}

/**
 * The Gemini API's arithmetic, as both Qwen Code and Gemini CLI inherit it:
 * the prompt count *includes* the cached part, thinking is counted apart from
 * the answer and billed as output, and a tool-use prompt is counted apart from
 * the prompt and billed as input.
 */
const fromGeminiCounts = (counts: {
  prompt: number | null
  cached: number | null
  answer: number | null
  thoughts: number | null
  tool: number | null
}): { input: number | null; output: number | null; cacheRead: number | null; cacheWrite: number | null; reasoning: number | null } => ({
  input: counts.prompt === null || counts.cached === null || counts.tool === null ? null : Math.max(0, counts.prompt - counts.cached) + counts.tool,
  cacheRead: counts.cached === null || counts.prompt === null ? null : Math.min(counts.cached, counts.prompt),
  // Gemini and Qwen do not record cache creation.  Aggregate ledger rows
  // retain their legacy zero-normalisation below, but source-qualified reads
  // must leave this unavailable so list pricing cannot complete it by guess.
  cacheWrite: null,
  output: observedSum(counts.answer, counts.thoughts),
  reasoning: counts.thoughts,
})

const aggregateTokens = (tokens: { input: number | null; output: number | null; cacheRead: number | null; cacheWrite: number | null; reasoning: number | null }) => ({
  input: tokens.input ?? 0, output: tokens.output ?? 0, cacheRead: tokens.cacheRead ?? 0, cacheWrite: tokens.cacheWrite ?? 0, reasoning: tokens.reasoning ?? 0,
})

export const scanQwenTranscript = async (
  target: ScanTarget,
  offset: number,
  tail: readonly string[],
  insight?: InsightScanOptions,
): Promise<ScanResult> => {
  const into: Accumulator = { rows: new Map() }
  const seen = new Set<string>(tail)
  const order: string[] = [...tail]
  const consumed = await readLines(target.path, offset, (raw) => {
    const record = raw as QwenRecord
    if (record.type !== 'assistant') return
    const usage = record.usageMetadata
    if (!usage) return
    // One record per model call; a resumed or rewound session writes new
    // records rather than repeating old ones, but a split scan must not count
    // the one at its seam twice.
    const id = record.uuid
    if (typeof id === 'string' && id !== '') {
      if (seen.has(id)) return
      seen.add(id)
      order.push(id)
    }
    const at = parseTime(record.timestamp)
    if (at === null) return
    const model = record.model
    if (typeof model !== 'string' || model === '') return
    const project = projectRootOf(record.cwd ?? '')
    const tokens = fromGeminiCounts({
        prompt: observedCount(usage.promptTokenCount),
        cached: observedCount(usage.cachedContentTokenCount),
        answer: observedCount(usage.candidatesTokenCount),
        thoughts: observedCount(usage.thoughtsTokenCount),
        tool: observedCount(usage.toolUsePromptTokenCount),
      })
    // Aggregate rows retain the existing scanner normalisation; only the
    // source-qualified detail path must preserve a field's absence.
    const aggregate = fromGeminiCounts({
      prompt: positive(usage.promptTokenCount), cached: positive(usage.cachedContentTokenCount),
      answer: positive(usage.candidatesTokenCount), thoughts: positive(usage.thoughtsTokenCount), tool: positive(usage.toolUsePromptTokenCount),
    })
    add(into, target.path, target.runtime, at, model, project, aggregateTokens(aggregate))
    emit(insight, target, id ?? JSON.stringify(raw), at, model, project || null, tokens, 'call')
  })
  return { rows: [...into.rows.values()], offset: consumed, tail: order.slice(-TAIL) }
}

interface GeminiMessage {
  readonly id?: string
  readonly type?: string
  readonly timestamp?: string
  readonly model?: string
  readonly tokens?: {
    readonly input?: number
    readonly output?: number
    readonly cached?: number
    readonly thoughts?: number
    readonly tool?: number
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object'

/**
 * The folder Gemini CLI keeps a project's chats in names that project in a
 * `.project_root` file beside `chats/` — the path itself, not a hash of it.
 */
const geminiProjects = new Map<string, string>()

const geminiProjectOf = (chatFile: string): string => {
  const folder = dirname(dirname(chatFile))
  const known = geminiProjects.get(folder)
  if (known !== undefined) return known
  let project = ''
  try {
    const root = readFileSync(join(folder, '.project_root'), 'utf8').trim()
    if (root !== '') project = projectRootOf(root)
  } catch {
    // An older layout, or a chat moved by hand: the spend still counts.
  }
  geminiProjects.set(folder, project)
  return project
}

/**
 * One Gemini CLI chat, read whole.
 *
 * Measured on Gemini CLI 0.59 and 0.60 (`chatRecordingService.ts`): the log is
 * JSONL, but a message is written again each time it fills in — the reply
 * first, its token counts when the call completes — so the last record of an
 * id is the one that counts. A `$rewindTo` record hides messages from the
 * conversation, and a `$set` with `messages` is a checkpoint that restates
 * them; neither un-spends a call that was made, so both are read as more
 * copies of messages already seen and nothing is subtracted.
 */
export const scanGeminiChat = async (target: ScanTarget, insight?: InsightScanOptions): Promise<ScanResult> => {
  const text = await readFile(target.path, 'utf8')
  const calls = new Map<string, GeminiMessage>()
  const note = (message: unknown): void => {
    if (!isRecord(message)) return
    const candidate = message as GeminiMessage
    if (candidate.type !== 'gemini' || !isRecord(candidate.tokens)) return
    if (typeof candidate.id !== 'string' || candidate.id === '') return
    calls.set(candidate.id, candidate)
  }
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    let record: unknown
    try {
      record = JSON.parse(trimmed)
    } catch {
      // A half-written last line; the next change rereads the whole file.
      continue
    }
    if (!isRecord(record)) continue
    const set = record['$set']
    if (isRecord(set) && Array.isArray(set['messages'])) {
      for (const message of set['messages']) note(message)
      continue
    }
    note(record)
  }
  const into: Accumulator = { rows: new Map() }
  const project = geminiProjectOf(target.path)
  for (const call of calls.values()) {
    const at = parseTime(call.timestamp)
    if (at === null) continue
    if (typeof call.model !== 'string' || call.model === '') continue
    const tokens = call.tokens ?? {}
    const normalized = fromGeminiCounts({
        prompt: observedCount(tokens.input),
        cached: observedCount(tokens.cached),
        answer: observedCount(tokens.output),
        thoughts: observedCount(tokens.thoughts),
        tool: observedCount(tokens.tool),
      })
    const aggregate = fromGeminiCounts({
      prompt: positive(tokens.input), cached: positive(tokens.cached), answer: positive(tokens.output), thoughts: positive(tokens.thoughts), tool: positive(tokens.tool),
    })
    add(into, target.path, target.runtime, at, call.model, project, aggregateTokens(aggregate))
    emit(insight, target, call.id ?? JSON.stringify(call), at, call.model, project || null, normalized, 'call')
  }
  return { rows: [...into.rows.values()], offset: target.size, tail: [] }
}

/** The columns a query needs, or a reason the table is not the shape measured. */
const requireColumns = (
  database: { prepare(sql: string): { all(): unknown[] } },
  table: string,
  columns: readonly string[],
): void => {
  const present = new Set(
    (database.prepare(`PRAGMA table_info("${table}")`).all() as { name?: unknown }[]).map((column) => column.name),
  )
  const missing = columns.filter((column) => !present.has(column))
  if (missing.length > 0) throw new Error(`${table} has no ${missing.join(', ')}: not the shape this reads`)
}

/**
 * One consistent read of another application's database — see
 * `readForeignDatabase` for what makes it consistent and why nothing is written
 * beside it. A file that is not one throws here, so a scan fails loudly and
 * keeps its previous rows rather than replacing them with nothing.
 */
const readForeign = <T>(path: string, read: (database: DatabaseSync) => T): T => {
  const value = readForeignDatabase(path, read)
  if (value === null) throw new Error('the database could not be opened for reading')
  return value
}

const OPENCODE_COLUMNS = [
  'directory',
  'model',
  'cost',
  'tokens_input',
  'tokens_output',
  'tokens_reasoning',
  'tokens_cache_read',
  'tokens_cache_write',
  'time_updated',
] as const

interface OpencodeSession {
  readonly directory: string | null
  readonly model: string | null
  readonly cost: number | null
  readonly tokens_input: number | null
  readonly tokens_output: number | null
  readonly tokens_reasoning: number | null
  readonly tokens_cache_read: number | null
  readonly tokens_cache_write: number | null
  readonly time_updated: number | null
}

/** OpenCode stores the model as `{"id":"big-pickle","providerID":"opencode"}`. */
const opencodeModel = (value: string | null): string => {
  if (typeof value !== 'string' || value === '') return 'unknown'
  try {
    const parsed: unknown = JSON.parse(value)
    if (isRecord(parsed) && typeof parsed['id'] === 'string' && parsed['id'] !== '') return parsed['id']
  } catch {
    // A bare id, as older rows may have it.
  }
  return value
}

/**
 * OpenCode's sessions, read from its own database.
 *
 * Measured on OpenCode 1.18 (`opencode.db`): the `session` table carries each
 * session's totals — tokens and the `cost` OpenCode priced them at — beside its
 * model and folder. OpenCode's input excludes the cache and its output excludes
 * reasoning, both counted apart; reasoning is billed as output, so it is added
 * back. The cost is OpenCode's, including the zero of a free model, and is
 * kept as that rather than re-priced. A session's spend falls on the day it was
 * last touched: the table keeps totals, not calls.
 */
export const scanOpencodeDatabase = async (target: ScanTarget, insight?: InsightScanOptions): Promise<ScanResult> => {
  const sessions = readForeign(target.path, (database) => {
    requireColumns(database, 'session', OPENCODE_COLUMNS)
    return database.prepare(`SELECT ${OPENCODE_COLUMNS.join(', ')} FROM session`).all() as unknown as OpencodeSession[]
  })
  const into: Accumulator = { rows: new Map() }
  for (const session of sessions) {
    const at = typeof session.time_updated === 'number' && session.time_updated > 0 ? session.time_updated : null
    if (at === null) continue
    const reasoning = positive(session.tokens_reasoning)
    const tokens = {
      input: positive(session.tokens_input),
      output: positive(session.tokens_output) + reasoning,
      cacheRead: positive(session.tokens_cache_read),
      cacheWrite: positive(session.tokens_cache_write),
      reasoning,
    }
    const observed = {
      input: observedCount(session.tokens_input),
      output: observedSum(observedCount(session.tokens_output), observedCount(session.tokens_reasoning)),
      cacheRead: observedCount(session.tokens_cache_read),
      cacheWrite: observedCount(session.tokens_cache_write),
    }
    const cost = typeof session.cost === 'number' && Number.isFinite(session.cost) && session.cost >= 0 ? session.cost : null
    if (tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite === 0 && !cost) continue
    const model = opencodeModel(session.model); const project = projectRootOf(session.directory ?? '')
    add(into, target.path, target.runtime, at, model, project, {
      ...tokens,
      vendorCost: cost,
    })
    emit(insight, target, JSON.stringify(session), at, model, project || null, observed, 'session', cost)
  }
  return { rows: [...into.rows.values()], offset: target.size, tail: [] }
}

const CLINE_COLUMNS = ['model', 'cwd', 'workspace_root', 'started_at', 'updated_at', 'metadata_json'] as const

interface ClineSession {
  readonly model: string | null
  readonly cwd: string | null
  readonly workspace_root: string | null
  readonly started_at: string | null
  readonly updated_at: string | null
  readonly metadata_json: string | null
}

interface ClineUsage {
  readonly inputTokens?: number
  readonly outputTokens?: number
  readonly cacheReadTokens?: number
  readonly cacheWriteTokens?: number
  readonly totalCost?: number
}

/**
 * Cline's sessions, read from its own database.
 *
 * Measured on Cline CLI 3.0.62 (`<data>/db/sessions.db`): each session's
 * `metadata_json` carries its own `usage` — tokens and the `totalCost` Cline
 * billed — and an `aggregateUsage` that adds its subagents'. Subagents are
 * sessions of their own in the same table, so only `usage` is read, or every
 * subagent would count twice. Like OpenCode's, the figure is a session total,
 * and falls on the day the session was last touched.
 */
export const scanClineDatabase = async (target: ScanTarget, insight?: InsightScanOptions): Promise<ScanResult> => {
  const sessions = readForeign(target.path, (database) => {
    requireColumns(database, 'sessions', CLINE_COLUMNS)
    return database.prepare(`SELECT ${CLINE_COLUMNS.join(', ')} FROM sessions`).all() as unknown as ClineSession[]
  })
  const into: Accumulator = { rows: new Map() }
  for (const session of sessions) {
    let usage: ClineUsage = {}
    try {
      const metadata: unknown = JSON.parse(session.metadata_json ?? '{}')
      if (isRecord(metadata) && isRecord(metadata['usage'])) usage = metadata['usage'] as ClineUsage
    } catch {
      continue
    }
    const at = parseTime(session.updated_at ?? undefined) ?? parseTime(session.started_at ?? undefined)
    if (at === null) continue
    const tokens = {
      input: positive(usage.inputTokens),
      output: positive(usage.outputTokens),
      cacheRead: positive(usage.cacheReadTokens),
      cacheWrite: positive(usage.cacheWriteTokens),
      reasoning: 0,
    }
    const observed = {
      input: observedCount(usage.inputTokens), output: observedCount(usage.outputTokens),
      cacheRead: observedCount(usage.cacheReadTokens), cacheWrite: observedCount(usage.cacheWriteTokens),
    }
    const cost =
      typeof usage.totalCost === 'number' && Number.isFinite(usage.totalCost) && usage.totalCost >= 0 ? usage.totalCost : null
    if (tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite === 0 && !cost) continue
    const model = typeof session.model === 'string' && session.model !== '' ? session.model : 'unknown'
    const project = projectRootOf(session.workspace_root || session.cwd || '')
    add(into, target.path, target.runtime, at, model, project, {
      ...tokens,
      vendorCost: cost,
    })
    emit(insight, target, JSON.stringify(session), at, model, project || null, observed, 'session', cost)
  }
  return { rows: [...into.rows.values()], offset: target.size, tail: [] }
}

export const scanFile = (target: ScanTarget, offset: number, tail: readonly string[], insight?: InsightScanOptions): Promise<ScanResult> => {
  switch (target.kind) {
    case 'codex':
      return scanCodexRollout(target, offset, tail, insight)
    case 'claude':
      return scanClaudeTranscript(target, offset, tail, insight)
    case 'qwen':
      return scanQwenTranscript(target, offset, tail, insight)
    case 'gemini':
      return scanGeminiChat(target, insight)
    case 'opencode':
      return scanOpencodeDatabase(target, insight)
    case 'cline':
      return scanClineDatabase(target, insight)
  }
}

/** Every `.jsonl` under a root, with the stats a cursor needs. */
const walkJsonl = async (
  root: string,
  limit: number,
  unreadable: (folder: string, error: unknown) => void,
  keep: (path: string) => boolean = () => true,
): Promise<{ path: string; size: number; mtime: number }[]> => {
  const found: { path: string; size: number; mtime: number }[] = []
  const visit = async (dir: string, depth: number): Promise<void> => {
    if (found.length >= limit) return
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch (error) {
      /* The root is the agent's own history, and has to be a folder: one that
         is not there is an agent never run, not worth a line, but a file at
         it or above it is a broken home and not an idle agent. Below the
         root, a folder that vanished or became a file between the listing and
         the read is the walk racing the agent, and nothing. Anything else is
         passed over, so every other agent is still counted, and reported — it
         used to leave that agent's numbers frozen, with nothing to tell them
         from a quiet week. */
      const nothing = depth === 0 ? NOTHING_YET : NOTHING_HERE
      if (!nothing.has(errnoOf(error))) unreadable(dir, error)
      return
    }
    for (const entry of entries) {
      if (found.length >= limit) return
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        await visit(full, depth + 1)
        continue
      }
      if (!entry.name.endsWith('.jsonl') || !keep(full)) continue
      try {
        const info = await stat(full)
        found.push({ path: full, size: info.size, mtime: Math.round(info.mtimeMs) })
      } catch {
        // Deleted between the listing and the stat.
      }
    }
  }
  await visit(root, 0)
  return found
}

export interface CorpusSpec {
  readonly runtime: string
  /** A folder of transcripts, or — for a database-backed kind — the database file. */
  readonly root: string
  readonly kind: CorpusKind
}

/** Where each agent keeps its own records. Roots, not credentials, and each one the agent's own override moves. */
export const corpusRoot = (kind: CorpusKind, env: NodeJS.ProcessEnv = process.env, home = homedir()): string => {
  const set = (name: string): string | null => {
    const value = env[name]?.trim()
    return value ? value : null
  }
  switch (kind) {
    case 'codex':
      return join(set('CODEX_HOME') ?? join(home, '.codex'), 'sessions')
    case 'claude':
      return join(set('CLAUDE_CONFIG_DIR') ?? home, '.claude', 'projects')
    case 'gemini':
      // `GEMINI_CLI_HOME` stands in for the home folder, not for `.gemini`.
      return join(set('GEMINI_CLI_HOME') ?? home, '.gemini', 'tmp')
    case 'qwen':
      return join(set('QWEN_HOME') ?? join(home, '.qwen'), 'projects')
    case 'opencode':
      return join(set('XDG_DATA_HOME') ?? join(home, '.local', 'share'), 'opencode', 'opencode.db')
    case 'cline': {
      const data = set('CLINE_DATA_DIR') ?? join(set('CLINE_DIR') ?? join(home, '.cline'), 'data')
      return join(set('CLINE_DB_DATA_DIR') ?? join(data, 'db'), 'sessions.db')
    }
  }
}

export const defaultCorpora = (runtimes: readonly { id: string; kind: CorpusKind }[]): CorpusSpec[] =>
  runtimes.map(({ id, kind }) => ({ runtime: id, kind, root: corpusRoot(kind) }))

/** Both agents that write chat logs keep them in a `chats` folder, beside files that are not chats. */
const inChats = (path: string): boolean => basename(dirname(path)) === 'chats'

/**
 * A database-backed corpus is one target whose size and time cover its
 * write-ahead log too: a WAL database takes its writes there, and the main
 * file can sit unchanged for as long as its owner runs.
 */
const databaseTarget = async (path: string): Promise<{ path: string; size: number; mtime: number } | null> => {
  let main
  try {
    main = await stat(path)
  } catch {
    return null
  }
  if (!main.isFile()) return null
  let size = main.size
  let mtime = main.mtimeMs
  try {
    const wal = await stat(`${path}-wal`)
    size += wal.size
    mtime = Math.max(mtime, wal.mtimeMs)
  } catch {
    // No log: every write is in the main file.
  }
  return { path, size, mtime: Math.round(mtime) }
}

export const listTargets = async (
  corpora: readonly CorpusSpec[],
  options: {
    readonly limit?: number
    /** Told of each folder the walk could not open and passed over. */
    readonly unreadable?: (folder: string, error: unknown) => void
  } = {},
): Promise<ScanTarget[]> => {
  const limit = options.limit ?? 20_000
  const unreadable = options.unreadable ?? (() => {})
  const targets: ScanTarget[] = []
  for (const corpus of corpora) {
    if (corpus.kind === 'opencode' || corpus.kind === 'cline') {
      const database = await databaseTarget(corpus.root)
      if (database) targets.push({ runtime: corpus.runtime, kind: corpus.kind, ...database })
      continue
    }
    const keep = corpus.kind === 'gemini' || corpus.kind === 'qwen' ? inChats : undefined
    for (const file of await walkJsonl(corpus.root, limit, unreadable, keep)) {
      targets.push({ runtime: corpus.runtime, kind: corpus.kind, ...file })
    }
  }
  return targets
}
