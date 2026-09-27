import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'

import { tempDir } from './scratch.js'

import { runtimeId } from '@harnessdesk/protocol'

import { DeskTranscriptTurnsSource } from '../src/ledger/desk-turns.js'
import { Ledger } from '../src/ledger/index.js'
import { Pricing } from '../src/ledger/pricing.js'
import { scanClaudeTranscript, scanCodexRollout, scanGeminiChat, scanQwenTranscript } from '../src/ledger/scan.js'
import { LedgerStore } from '../src/ledger/store.js'

/**
 * Turns: one person-or-agent prompt answered by the agent, never an API
 * request or a tool call — "Turns", `docs/usage-dashboard.md`. Each scanner's
 * own boundary, the migration that adds the column to an existing ledger,
 * and the aggregation rule that withholds a mixed group's total rather than
 * reading it as a real, if partial, count.
 */

const scratch = (): string => tempDir('hd-ledger-turns-')
const NOON = Date.parse('2026-09-26T12:00:00Z')
const at = new Date(NOON).toISOString()
const line = (record: unknown): string => `${JSON.stringify(record)}\n`

const pricingIn = async (dir: string): Promise<Pricing> => {
  const pricing = new Pricing({
    cachePath: join(dir, 'cache.json'),
    overlayPath: join(dir, 'overlay.json'),
    fetchCatalogue: async () => ({}),
  })
  await pricing.warm()
  return pricing
}

// ---------------------------------------------------------------- Codex

test('a Codex rollout counts one turn per turn_context, never per token_count', async () => {
  const dir = scratch()
  const path = join(dir, 'rollout.jsonl')
  const codexLine = (type: string, payload: Record<string, unknown>): string =>
    line({ timestamp: at, type, payload })
  writeFileSync(
    path,
    codexLine('session_meta', { cwd: '/tmp/project' }) +
      codexLine('turn_context', { model: 'gpt-5.6-sol', cwd: '/tmp/project' }) +
      codexLine('event_msg', { type: 'token_count', info: { last_token_usage: { input_tokens: 100, output_tokens: 10 } } }) +
      codexLine('event_msg', { type: 'token_count', info: { last_token_usage: { input_tokens: 50, output_tokens: 5 } } }) +
      codexLine('turn_context', { model: 'gpt-5.6-sol', cwd: '/tmp/project' }) +
      codexLine('event_msg', { type: 'token_count', info: { last_token_usage: { input_tokens: 20, output_tokens: 2 } } }),
  )
  const result = await scanCodexRollout({ runtime: 'codex', kind: 'codex', path, size: 0, mtime: 0 }, 0)
  assert.equal(result.rows.length, 1, 'one day, one model, one project')
  assert.equal(result.rows[0]?.turns, 2, 'two turn_context events, three token_count events')
})

// ---------------------------------------------------------------- Claude

test('a Claude transcript counts a real user message, never a tool result fed back to the model', async () => {
  const dir = scratch()
  const path = join(dir, 'session.jsonl')
  const userTurn = (content: unknown): string =>
    line({ type: 'user', timestamp: at, cwd: '/tmp/project', message: { role: 'user', content } })
  const reply = (id: string): string =>
    line({
      type: 'assistant',
      timestamp: at,
      cwd: '/tmp/project',
      message: { id, model: 'claude-opus-5', usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } },
    })
  writeFileSync(
    path,
    userTurn('hello, please read this file') +
      reply('m1') +
      // A tool call's result rides back as a user-role message too — never a turn.
      userTurn([{ type: 'tool_result', content: 'file contents' }]) +
      reply('m2') +
      // A content array with real text beside a tool result is still a turn.
      userTurn([{ type: 'tool_result', content: 'ok' }, { type: 'text', text: 'thanks, now do the next part' }]) +
      reply('m3'),
  )
  const result = await scanClaudeTranscript({ runtime: 'claude-code', kind: 'claude', path, size: 0, mtime: 0 }, 0, [])
  assert.equal(result.rows.length, 1)
  assert.equal(result.rows[0]?.turns, 2, 'the plain message and the mixed one; the pure tool result does not count')
  assert.equal(result.rows[0]?.requests, 3, 'turns never inflate the request count')
})

test("a Claude turn is filed under the reply that actually answers it, not the one before it", async () => {
  const dir = scratch()
  const path = join(dir, 'session.jsonl')
  const userTurn = (): string => line({ type: 'user', timestamp: at, cwd: '/p', message: { role: 'user', content: 'go' } })
  const reply = (id: string, model: string): string =>
    line({ type: 'assistant', timestamp: at, cwd: '/p', message: { id, model, usage: { input_tokens: 1, output_tokens: 1 } } })
  // The very first line is a turn, before any model has ever answered.
  writeFileSync(path, userTurn() + reply('m1', 'model-a'))
  const result = await scanClaudeTranscript({ runtime: 'claude-code', kind: 'claude', path, size: 0, mtime: 0 }, 0, [])
  const row = result.rows.find((r) => (r.turns ?? 0) > 0)
  assert.equal(row?.model, 'model-a', 'the turn is filed under the model that answers it, never "unknown"')
})

// ---------------------------------------------------------------- Gemini CLI

test('a Gemini CLI chat counts a user prompt once, filed under the reply that answers it', async () => {
  const dir = scratch()
  const project = join(dir, 'tmp', 'proj')
  mkdirSync(join(project, 'chats'), { recursive: true })
  const path = join(project, 'chats', 'session.jsonl')
  writeFileSync(
    path,
    line({ id: 'u1', timestamp: at, type: 'user', content: 'hi' }) +
      line({ id: 'g1', timestamp: at, type: 'gemini', content: 'reply', model: 'gemini-3-flash', tokens: { input: 10, output: 2 } }) +
      line({ id: 'u2', timestamp: at, type: 'user', content: 'again' }) +
      // Replayed once more, as Gemini CLI's own checkpoint does; must not double count.
      line({ $set: { messages: [{ id: 'u2', timestamp: at, type: 'user', content: 'again' }] } }) +
      line({ id: 'g2', timestamp: at, type: 'gemini', content: 'reply', model: 'gemini-3-flash', tokens: { input: 10, output: 2 } }),
  )
  const result = await scanGeminiChat({ runtime: 'gemini', kind: 'gemini', path, size: 1234, mtime: 0 })
  assert.equal(result.rows.length, 1)
  assert.equal(result.rows[0]?.turns, 2, 'two prompts, the replayed one counted once')
  assert.equal(result.rows[0]?.model, 'gemini-3-flash')
})

// ---------------------------------------------------------------- Qwen Code

test('a Qwen Code transcript counts the person’s own prompt, not the assistant’s reply', async () => {
  const dir = scratch()
  const path = join(dir, 'projects', 'p1', 'chats', 'session.jsonl')
  mkdirSync(join(dir, 'projects', 'p1', 'chats'), { recursive: true })
  writeFileSync(
    path,
    line({ uuid: 'u1', type: 'user', timestamp: at, cwd: '/work/qwen-project' }) +
      line({
        uuid: 'c1', type: 'assistant', timestamp: at, cwd: '/work/qwen-project', model: 'qwen3-coder-plus',
        usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 10 },
      }),
  )
  const result = await scanQwenTranscript({ runtime: 'qwen-code', kind: 'qwen', path, size: 0, mtime: 0 }, 0, [])
  assert.equal(result.rows.length, 1)
  assert.equal(result.rows[0]?.turns, 1)
  assert.equal(result.rows[0]?.requests, 1)
})

// ---------------------------------------------------------------- migration

test('a ledger from before turns were counted gains the column at 0, and sums from there', () => {
  const dir = scratch()
  const path = join(dir, 'usage.sqlite')
  const old = new DatabaseSync(path)
  old.exec(`CREATE TABLE usage (file TEXT NOT NULL, day INTEGER NOT NULL, runtime TEXT NOT NULL, model TEXT NOT NULL,
    project TEXT NOT NULL, input INTEGER NOT NULL DEFAULT 0, output INTEGER NOT NULL DEFAULT 0,
    cacheRead INTEGER NOT NULL DEFAULT 0, cacheWrite INTEGER NOT NULL DEFAULT 0, reasoning INTEGER NOT NULL DEFAULT 0,
    requests INTEGER NOT NULL DEFAULT 0, vendorCost REAL, vendored INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (file, day, runtime, model, project, vendored));
    INSERT INTO usage (file, day, runtime, model, project, input, requests, vendored) VALUES ('/a', 1, 'codex', 'm', '', 5, 1, 0);`)
  old.close()

  const store = new LedgerStore(path)
  const [row] = store.since(0)
  assert.equal(row?.input, 5)
  assert.equal(row?.turns, 0, 'an existing row never counted a turn, and reads that as a real 0, not unknown')

  store.commit(
    { path: '/b', size: 1, mtime: 1, offset: 1, tail: [] },
    [{ file: '/b', day: 1, runtime: 'codex', model: 'm', project: '', input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, requests: 0, turns: 3 }],
    1,
    true,
  )
  store.commit(
    { path: '/b', size: 2, mtime: 2, offset: 2, tail: [] },
    [{ file: '/b', day: 1, runtime: 'codex', model: 'm', project: '', input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, requests: 0, turns: 2 }],
    2,
    false,
  )
  const merged = store.since(0).find((entry) => entry.file === '/b')
  assert.equal(merged?.turns, 5, 'turns sum on conflict, exactly like every other counter')
  store.close()

  // Reopened, the column is still there and nothing was lost.
  const again = new LedgerStore(path)
  assert.equal(again.since(0).length, 2)
  again.close()
})

// ---------------------------------------------------------------- ledger aggregation

test('turns are honest across the ledger: known per runtime, withheld the moment a group mixes in one that is not', async () => {
  const dir = scratch()
  const codexDir = join(dir, 'codex')
  mkdirSync(codexDir, { recursive: true })
  const codexPath = join(codexDir, 'rollout.jsonl')
  const codexLine = (type: string, payload: Record<string, unknown>): string => line({ timestamp: at, type, payload })
  writeFileSync(
    codexPath,
    codexLine('session_meta', { cwd: '/work/shared' }) +
      codexLine('turn_context', { model: 'gpt-5.6-sol', cwd: '/work/shared' }) +
      codexLine('event_msg', { type: 'token_count', info: { last_token_usage: { input_tokens: 100, output_tokens: 10 } } }),
  )

  const openCodeDir = join(dir, 'opencode')
  mkdirSync(openCodeDir, { recursive: true })
  const openCodePath = join(openCodeDir, 'opencode.db')
  const oc = new DatabaseSync(openCodePath)
  oc.exec(`PRAGMA journal_mode = WAL;
    CREATE TABLE session (id TEXT PRIMARY KEY, directory TEXT, model TEXT, cost REAL, tokens_input INTEGER,
      tokens_output INTEGER, tokens_reasoning INTEGER, tokens_cache_read INTEGER, tokens_cache_write INTEGER,
      time_created INTEGER, time_updated INTEGER)`)
  oc.prepare('INSERT INTO session VALUES (?,?,?,?,?,?,?,?,?,?,?)').run('s1', '/work/shared', 'gpt', 1, 100, 10, 0, 0, 0, NOON - 1000, NOON)
  oc.close()

  const ledger = new Ledger({
    stateDir: dir,
    databasePath: join(dir, 'usage.sqlite'),
    corpora: [
      { runtime: 'codex', kind: 'codex', root: codexDir },
      { runtime: 'opencode', kind: 'opencode', root: openCodePath },
    ],
    turnRuntimes: [runtimeId('codex')],
    pricing: await pricingIn(dir),
    now: () => NOON,
  })
  await ledger.scan()

  const byRuntime = ledger.query({ days: 7, groupBy: 'runtime' })
  const codexRow = byRuntime.rows.find((r) => r.key === 'codex')
  const opencodeRow = byRuntime.rows.find((r) => r.key === 'opencode')
  assert.equal(codexRow?.turns, 1, 'codex alone is turn-known')
  assert.equal(opencodeRow?.turns, undefined, 'opencode was never told it has a real turn count')
  assert.deepEqual(byRuntime.coverage.turnsKnownFor, ['codex'])

  // Grouped by project, both runtimes land in the SAME row (they share a
  // cwd) — and the mix withholds the count entirely, never a partial one.
  const byProject = ledger.query({ days: 7, groupBy: 'project' })
  assert.equal(byProject.rows.length, 1)
  assert.equal(byProject.rows[0]?.turns, undefined, 'a row mixing a turn-known runtime and one that is not stays unknown')
  assert.equal(byProject.totals?.turns, undefined, 'the whole window mixes both, so the total is withheld too')

  const codexOnly = ledger.query({ days: 7, runtime: runtimeId('codex'), groupBy: 'project' })
  assert.equal(codexOnly.totals?.turns, 1, 'scoped to the one turn-known runtime, the total is real')

  assert.equal(ledger.turnsFor(runtimeId('codex'), NOON - 7 * 86_400_000)?.count, 1)
  assert.equal(ledger.turnsFor(runtimeId('opencode'), NOON - 7 * 86_400_000), null, 'never a zero for a runtime this ledger was never told about')
  assert.equal(ledger.requestsFor(runtimeId('codex'), NOON - 7 * 86_400_000), 1)

  ledger.close()
})

// ---------------------------------------------------------------- desk-transcript fallback

test('the desk’s own transcript counts a stored session’s turns for a runtime with no scanner of its own', async () => {
  const dir = scratch()
  const reader = {
    exportAll: async () => [
      {
        runtime: 'cursor',
        id: 'session-1',
        data: {
          cwd: '/work/proj',
          turns: [{ startedAt: NOON - 1000 }, { startedAt: NOON - 500 }],
        },
      },
      // A different runtime's session must never be counted here.
      { runtime: 'claude-code', id: 'x', data: { cwd: '/work/proj', turns: [{ startedAt: NOON }] } },
    ],
  }
  const source = new DeskTranscriptTurnsSource('cursor', reader)
  const file = await source.resolveFile()
  assert.equal(file, 'desk-transcript:cursor')
  const result = await source.sync({ from: NOON - 86_400_000, to: NOON + 1 }, file!)
  assert.equal(result?.rows.length, 1)
  assert.equal(result?.rows[0]?.turns, 2)
  assert.equal(result?.rows[0]?.runtime, 'cursor')
  assert.equal(result?.rows[0]?.input, 0, 'the desk watched a turn happen, never what it cost')

  // Through the ledger, wired the way the host wires a runtime with no
  // corpus of its own: turns only, via `remoteSources`.
  const ledger = new Ledger({
    stateDir: dir,
    databasePath: join(dir, 'usage.sqlite'),
    corpora: [],
    remoteSources: [source],
    turnRuntimes: [runtimeId('cursor')],
    pricing: await pricingIn(dir),
    now: () => NOON,
  })
  await ledger.scan()
  assert.equal(ledger.turnsFor(runtimeId('cursor'), NOON - 86_400_000)?.count, 2)
  ledger.close()
})
