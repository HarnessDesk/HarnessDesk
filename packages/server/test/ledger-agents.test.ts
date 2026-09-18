import assert from 'node:assert/strict'
import { appendFileSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'

import { tempDir } from './scratch.js'

import { openForeignDatabase } from '../src/ledger/foreign-db.js'
import { Ledger } from '../src/ledger/index.js'
import { Pricing } from '../src/ledger/pricing.js'
import { corpusRoot, listTargets, projectRootOf, scanGeminiChat, scanQwenTranscript } from '../src/ledger/scan.js'
import { LedgerStore } from '../src/ledger/store.js'

/**
 * The agents whose spend is read from records of their own besides Codex's
 * and Claude's: Gemini CLI and Qwen Code chat logs, and OpenCode's and Cline's
 * databases — the last two carrying the cost the agent itself billed.
 *
 * The fixtures are shaped on what each agent wrote on this machine
 * (2026-09-18: Gemini CLI 0.60, OpenCode 1.18, Cline 3.0.62) and on each
 * one's own recorder source, because the formats are what can go wrong.
 */

const scratch = (): string => tempDir('hd-ledger-agents-')
const NOON = Date.parse('2026-09-18T12:00:00Z')
const at = new Date(NOON).toISOString()

const pricingIn = async (dir: string): Promise<Pricing> => {
  const pricing = new Pricing({
    cachePath: join(dir, 'cache.json'),
    overlayPath: join(dir, 'overlay.json'),
    fetchCatalogue: async () => ({
      google: { models: { 'gemini-3-flash-preview': { id: 'gemini-3-flash-preview', cost: { input: 1, output: 4, cache_read: 0.25 } } } },
    }),
  })
  await pricing.warm()
  return pricing
}

const line = (record: unknown): string => `${JSON.stringify(record)}\n`

const geminiCall = (id: string, tokens: Record<string, number>, model = 'gemini-3-flash-preview') => ({
  id,
  timestamp: at,
  type: 'gemini',
  content: 'reply',
  tokens,
  model,
})

test('a Gemini CLI chat counts each call once, at its final counts, rewound or not', async () => {
  const dir = scratch()
  const project = join(dir, 'tmp', 'my-project')
  mkdirSync(join(project, 'chats'), { recursive: true })
  writeFileSync(join(project, '.project_root'), '/work/my-project\n')
  const path = join(project, 'chats', 'session-1.jsonl')
  writeFileSync(
    path,
    line({ sessionId: 's', projectHash: 'h', startTime: at, lastUpdated: at, kind: 'main' }) +
      line({ id: 'u1', timestamp: at, type: 'user', content: 'hi' }) +
      // The reply is written before its counts arrive, then again with them.
      line({ id: 'g1', timestamp: at, type: 'gemini', content: 'partial' }) +
      line(geminiCall('g1', { input: 1000, output: 10, cached: 400, thoughts: 5, tool: 2, total: 1017 })) +
      line({ $set: { lastUpdated: at } }) +
      line(geminiCall('g2', { input: 2000, output: 20, cached: 0, thoughts: 0, tool: 0, total: 2020 })) +
      // A rewind hides g2 from the conversation; the call was still made.
      line({ $rewindTo: 'g2' }) +
      // A checkpoint restates g1; it was already counted.
      line({ $set: { messages: [geminiCall('g1', { input: 1000, output: 10, cached: 400, thoughts: 5, tool: 2 })] } }),
  )
  // Beside the chats, a log that is not one.
  writeFileSync(join(project, 'logs.jsonl'), line(geminiCall('x', { input: 9_999_999, output: 0 })))

  const result = await scanGeminiChat({ runtime: 'gemini', kind: 'gemini', path, size: 1234, mtime: 0 })
  assert.equal(result.rows.length, 1)
  const row = result.rows[0]
  // The Gemini API counts the cached part inside the prompt, a tool-use prompt
  // beside it, and thinking beside the answer.
  assert.equal(row?.input, 1000 - 400 + 2 + 2000)
  assert.equal(row?.cacheRead, 400)
  assert.equal(row?.output, 10 + 5 + 20)
  assert.equal(row?.reasoning, 5)
  assert.equal(row?.requests, 2)
  assert.equal(row?.project, '/work/my-project', 'the project the chat folder names')
  assert.equal(result.offset, 1234, 'a whole-file read consumes the whole file')

  const targets = await listTargets([{ runtime: 'gemini', kind: 'gemini', root: join(dir, 'tmp') }])
  assert.deepEqual(
    targets.map((target) => target.path),
    [path],
    'only chat logs are read',
  )

  // Through the ledger: the file grows as a message is written again with
  // more in it, and the rows are replaced, not added to.
  const ledger = new Ledger({
    stateDir: dir,
    databasePath: join(dir, 'usage.sqlite'),
    corpora: [{ runtime: 'gemini', kind: 'gemini', root: join(dir, 'tmp') }],
    pricing: await pricingIn(dir),
    now: () => NOON,
  })
  await ledger.scan()
  appendFileSync(path, line(geminiCall('g2', { input: 2000, output: 40, cached: 0, thoughts: 0, tool: 0 })))
  await ledger.scan()
  const report = ledger.query({ days: 7, groupBy: 'model' })
  assert.equal(report.totalTokens, 602 + 400 + 15 + 2000 + 40, 'g2 at its later count, once')
  assert.equal(report.provenance, 'listPrice')
  ledger.close()
})

test('a Qwen Code transcript counts a call once, with the Gemini API’s arithmetic', async () => {
  const dir = scratch()
  const path = join(dir, 'projects', 'p1', 'chats', 'session.jsonl')
  mkdirSync(join(dir, 'projects', 'p1', 'chats'), { recursive: true })
  const call = {
    uuid: 'c1',
    parentUuid: null,
    sessionId: 's',
    timestamp: at,
    type: 'assistant',
    cwd: '/work/qwen-project',
    model: 'qwen3-coder-plus',
    usageMetadata: { promptTokenCount: 1000, cachedContentTokenCount: 300, candidatesTokenCount: 50, thoughtsTokenCount: 10 },
  }
  writeFileSync(
    path,
    line({ uuid: 'u1', type: 'user', timestamp: at, cwd: '/work/qwen-project' }) +
      line(call) +
      line(call) +
      line({ ...call, uuid: 's1', type: 'system', subtype: 'rewind' }),
  )
  const result = await scanQwenTranscript({ runtime: 'qwen-code', kind: 'qwen', path, size: 0, mtime: 0 }, 0, [])
  assert.equal(result.rows.length, 1)
  assert.equal(result.rows[0]?.input, 700)
  assert.equal(result.rows[0]?.cacheRead, 300)
  assert.equal(result.rows[0]?.output, 60)
  assert.equal(result.rows[0]?.reasoning, 10)
  assert.equal(result.rows[0]?.requests, 1, 'the same call on two lines is one call')
  assert.equal(result.rows[0]?.project, '/work/qwen-project')

  const targets = await listTargets([{ runtime: 'qwen-code', kind: 'qwen', root: join(dir, 'projects') }])
  assert.deepEqual(targets.map((target) => target.path), [path])
})

/** OpenCode's `session` table, the columns it is read by, in WAL mode as OpenCode keeps it. */
const opencodeDatabase = (path: string): DatabaseSync => {
  const database = new DatabaseSync(path)
  database.exec(`PRAGMA journal_mode = WAL;
    CREATE TABLE session (id TEXT PRIMARY KEY, directory TEXT, model TEXT, cost REAL, tokens_input INTEGER,
      tokens_output INTEGER, tokens_reasoning INTEGER, tokens_cache_read INTEGER, tokens_cache_write INTEGER,
      time_created INTEGER, time_updated INTEGER)`)
  return database
}

const addOpencodeSession = (database: DatabaseSync, id: string, model: string, cost: number, tokens: number[]): void => {
  database
    .prepare('INSERT INTO session VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, '/work/oc', model, cost, ...tokens, NOON - 1000, NOON)
}

test('OpenCode’s sessions are counted at the cost OpenCode priced them, a free model’s zero included', async () => {
  const dir = scratch()
  const home = join(dir, 'opencode')
  mkdirSync(home)
  const path = join(home, 'opencode.db')
  const writer = opencodeDatabase(path)
  addOpencodeSession(writer, 's1', '{"id":"big-pickle","providerID":"opencode"}', 0, [1000, 10, 5, 400, 0])
  addOpencodeSession(writer, 's2', '{"id":"claude-sonnet-5","providerID":"anthropic"}', 0.5, [2000, 100, 50, 0, 300])
  // An empty session costs nothing and says nothing.
  addOpencodeSession(writer, 's3', '{"id":"big-pickle","providerID":"opencode"}', 0, [0, 0, 0, 0, 0])
  writer.close()
  const before = readdirSync(home).sort()

  const ledger = new Ledger({
    stateDir: dir,
    databasePath: join(dir, 'usage.sqlite'),
    corpora: [{ runtime: 'opencode', kind: 'opencode', root: path }],
    pricing: await pricingIn(dir),
    now: () => NOON,
  })
  await ledger.scan()
  // OpenCode is not running: the database is read without writing beside it.
  assert.deepEqual(readdirSync(home).sort(), before)

  const report = ledger.query({ days: 7, groupBy: 'model' })
  assert.equal(report.totalCost, 0.5, 'the costs OpenCode recorded, not list price')
  assert.equal(report.provenance, 'vendorMetered')
  assert.deepEqual(report.rows.map((row) => row.label).sort(), ['big-pickle', 'claude-sonnet-5'])
  const free = report.rows.find((row) => row.label === 'big-pickle')
  assert.equal(free?.cost, 0, 'free, not unpriced')
  assert.equal(free?.tokens, 1000 + 10 + 5 + 400, 'reasoning is output, billed as output')
  assert.equal(ledger.spendFor('opencode' as never)?.windowCost, 0.5)

  // OpenCode running again writes through its log; the next scan sees it.
  const again = new DatabaseSync(path)
  again.exec('PRAGMA journal_mode = WAL')
  addOpencodeSession(again, 's4', '{"id":"claude-sonnet-5","providerID":"anthropic"}', 0.25, [10, 1, 0, 0, 0])
  await ledger.scan()
  assert.equal(ledger.query({ days: 7, groupBy: 'model' }).totalCost, 0.75, 'replaced, not doubled')
  again.close()
  ledger.close()
})

test('Cline’s sessions count their own usage, never their subagents’ twice', async () => {
  const dir = scratch()
  const path = join(dir, 'sessions.db')
  const database = new DatabaseSync(path)
  database.exec(`CREATE TABLE sessions (session_id TEXT PRIMARY KEY, model TEXT, cwd TEXT, workspace_root TEXT,
    started_at TEXT, updated_at TEXT, metadata_json TEXT, is_subagent INTEGER)`)
  const usage = (input: number, output: number, cost: number) => ({
    inputTokens: input,
    outputTokens: output,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalCost: cost,
  })
  const add = database.prepare('INSERT INTO sessions VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
  // The parent's aggregate includes its subagent, which is a row of its own.
  add.run('p', 'deepseek/deepseek-v4-pro', '/work/c', '/work/c', at, at, JSON.stringify({ usage: usage(1000, 100, 0.2), aggregateUsage: usage(1500, 150, 0.3) }), 0)
  add.run('s', 'deepseek/deepseek-v4-pro', '/work/c', '/work/c', at, at, JSON.stringify({ usage: usage(500, 50, 0.1) }), 1)
  database.close()

  const ledger = new Ledger({
    stateDir: dir,
    databasePath: join(dir, 'usage.sqlite'),
    corpora: [{ runtime: 'cline', kind: 'cline', root: path }],
    pricing: await pricingIn(dir),
    now: () => NOON,
  })
  await ledger.scan()
  const spend = ledger.spendFor('cline' as never)
  assert.ok(spend)
  assert.equal(Math.round((spend.windowCost ?? 0) * 100) / 100, 0.3)
  assert.equal(spend.windowTokens, 1650)
  assert.equal(spend.provenance, 'vendorMetered')
  ledger.close()
})

test('list-priced and agent-priced rows together are said to be mixed', async () => {
  const dir = scratch()
  mkdirSync(join(dir, 'tmp', 'p', 'chats'), { recursive: true })
  writeFileSync(join(dir, 'tmp', 'p', 'chats', 's.jsonl'), line(geminiCall('g', { input: 1_000_000, output: 0, cached: 0 })))
  const oc = join(dir, 'opencode.db')
  const writer = opencodeDatabase(oc)
  addOpencodeSession(writer, 's', '{"id":"big-pickle"}', 2, [10, 0, 0, 0, 0])
  writer.close()
  const ledger = new Ledger({
    stateDir: dir,
    databasePath: join(dir, 'usage.sqlite'),
    corpora: [
      { runtime: 'gemini', kind: 'gemini', root: join(dir, 'tmp') },
      { runtime: 'opencode', kind: 'opencode', root: oc },
    ],
    pricing: await pricingIn(dir),
    now: () => NOON,
  })
  await ledger.scan()
  const report = ledger.query({ days: 7, groupBy: 'runtime' })
  assert.equal(report.provenance, 'mixed')
  assert.equal(report.totalCost, 1 + 2, '1M Gemini input at $1/M, and OpenCode’s own $2')
  ledger.close()
})

test('a ledger from before agents could price their own rows gains the column, empty', () => {
  const dir = scratch()
  const path = join(dir, 'usage.sqlite')
  const old = new DatabaseSync(path)
  old.exec(`CREATE TABLE usage (file TEXT NOT NULL, day INTEGER NOT NULL, runtime TEXT NOT NULL, model TEXT NOT NULL,
    project TEXT NOT NULL, input INTEGER NOT NULL DEFAULT 0, output INTEGER NOT NULL DEFAULT 0,
    cacheRead INTEGER NOT NULL DEFAULT 0, cacheWrite INTEGER NOT NULL DEFAULT 0, reasoning INTEGER NOT NULL DEFAULT 0,
    requests INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (file, day, runtime, model, project));
    INSERT INTO usage (file, day, runtime, model, project, input, requests) VALUES ('/a', 1, 'codex', 'm', '', 5, 1);`)
  old.close()
  const store = new LedgerStore(path)
  const [row] = store.since(0)
  assert.equal(row?.input, 5)
  assert.equal(row?.vendorCost, null)
  store.commit(
    { path: '/b', size: 1, mtime: 1, offset: 1, tail: [] },
    [{ file: '/b', day: 1, runtime: 'cline', model: 'm', project: '', input: 1, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, requests: 1, vendorCost: 0.5 }],
    1,
    true,
  )
  assert.equal(store.since(0).find((entry) => entry.file === '/b')?.vendorCost, 0.5)
  store.close()
})

test('another application’s database is read without a file written beside it', () => {
  const dir = scratch()
  const wal = join(dir, 'wal.db')
  const writer = new DatabaseSync(wal)
  writer.exec('PRAGMA journal_mode = WAL; CREATE TABLE t (x); INSERT INTO t VALUES (1)')
  writer.close()
  const rollback = join(dir, 'rollback.db')
  const other = new DatabaseSync(rollback)
  other.exec('CREATE TABLE t (x); INSERT INTO t VALUES (2)')
  other.close()
  writeFileSync(join(dir, 'not-a-database.db'), 'hello')
  const before = readdirSync(dir).sort()

  for (const [path, value] of [
    [wal, 1],
    [rollback, 2],
  ] as const) {
    const database = openForeignDatabase(path)
    assert.ok(database)
    assert.equal((database.prepare('SELECT x FROM t').get() as { x: number }).x, value)
    database.close()
  }
  assert.equal(openForeignDatabase(join(dir, 'not-a-database.db')), null)
  assert.equal(openForeignDatabase(join(dir, 'absent.db')), null)
  assert.deepEqual(readdirSync(dir).sort(), before, 'no -shm, no -wal')
})

test('each agent’s records are found where its own override moves them', () => {
  const env = {
    GEMINI_CLI_HOME: '/g',
    QWEN_HOME: '/q/.qwen',
    XDG_DATA_HOME: '/x',
    CLINE_DIR: '/c',
  }
  assert.equal(corpusRoot('gemini', env, '/home/me'), '/g/.gemini/tmp')
  assert.equal(corpusRoot('qwen', env, '/home/me'), '/q/.qwen/projects')
  assert.equal(corpusRoot('opencode', env, '/home/me'), '/x/opencode/opencode.db')
  assert.equal(corpusRoot('cline', env, '/home/me'), '/c/data/db/sessions.db')
  assert.equal(corpusRoot('cline', { CLINE_DATA_DIR: '/d' }, '/home/me'), '/d/db/sessions.db')
  assert.equal(corpusRoot('opencode', {}, '/home/me'), '/home/me/.local/share/opencode/opencode.db')
})

test('a folder with no repository above it is its own project, whichever came first', () => {
  // The memo once remembered the first such folder's answer for its
  // ancestors, and every later one came back as that first folder.
  const dir = scratch()
  const [a, b, c] = ['a', 'b', 'c'].map((name) => join(dir, name))
  const repo = join(dir, 'repo')
  for (const folder of [a, b, c, join(repo, '.git'), join(repo, 'sub')]) mkdirSync(folder as string, { recursive: true })
  assert.equal(projectRootOf(a as string), a)
  assert.equal(projectRootOf(b as string), b)
  assert.equal(projectRootOf(join(repo, 'sub')), repo)
  assert.equal(projectRootOf(c as string), c)
  assert.equal(projectRootOf(a as string), a, 'and asked again, from the memo')
})
