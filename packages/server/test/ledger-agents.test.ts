import assert from 'node:assert/strict'
import { appendFileSync, existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { createRequire, syncBuiltinESMExports } from 'node:module'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'

import { tempDir } from './scratch.js'

import { readForeignDatabase } from '../src/ledger/foreign-db.js'
import { Ledger } from '../src/ledger/index.js'
import { InsightBudgetExceededError, InsightSourceChangedError } from '../src/ledger/insight.js'
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

const addOpencodeSession = (database: DatabaseSync, id: string, model: string, cost: number | null, tokens: number[]): void => {
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

test('a session the agent priced and one it did not, on one day and model, are not one row', async () => {
  // Same day, same model, same folder: the key a row is grouped by. Folding the
  // unpriced session into the priced one would call all its tokens vendor-priced
  // and cost them at the other's $0.50 — its list price lost, provenance wrong
  // (#772, review round 1).
  const dir = scratch()
  const oc = join(dir, 'opencode.db')
  const writer = opencodeDatabase(oc)
  const model = '{"id":"gemini-3-flash-preview"}'
  addOpencodeSession(writer, 'priced', model, 0.5, [1_000_000, 0, 0, 0, 0])
  addOpencodeSession(writer, 'unpriced', model, null, [1_000_000, 0, 0, 0, 0])
  writer.close()
  const ledger = new Ledger({
    stateDir: dir,
    databasePath: join(dir, 'usage.sqlite'),
    corpora: [{ runtime: 'opencode', kind: 'opencode', root: oc }],
    pricing: await pricingIn(dir),
    now: () => NOON,
  })
  await ledger.scan()
  const report = ledger.query({ days: 7, groupBy: 'model' })
  assert.equal(report.totalCost, 0.5 + 1, 'the recorded $0.50, and 1M input at the list price of $1/M')
  assert.equal(report.provenance, 'mixed', 'one request was the agent’s to price, one was not')
  assert.equal(report.coverage.priced, 2)
  assert.equal(report.coverage.unpriced, 0)
  ledger.close()
})

test('rows the agent priced and rows it did not stay apart in the store, and add up within their own kind', () => {
  const store = new LedgerStore(':memory:')
  const row = (vendorCost: number | null, requests = 1) => ({
    file: '/db', day: 1, runtime: 'opencode', model: 'm', project: '/p', input: 10, output: 0, cacheRead: 0, cacheWrite: 0,
    reasoning: 0, requests, vendorCost,
  })
  // One commit, so the upsert is what merges them, as a scan's rows are.
  store.commit({ path: '/db', size: 1, mtime: 1, offset: 1, tail: [] }, [row(0.5), row(null), row(0.25), row(null)], 1, true)
  const rows = [...store.since(0)].sort((a, b) => (a.vendorCost ?? -1) - (b.vendorCost ?? -1))
  assert.equal(rows.length, 2, 'one of each kind')
  assert.deepEqual(rows.map((entry) => [entry.vendorCost, entry.requests, entry.input]), [
    [null, 2, 20],
    [0.75, 2, 20],
  ])
  store.close()
})

test('a table that already has vendorCost but not vendored is still migrated, not mistaken for the current shape', () => {
  // The shape between the two migrations: a store built on an intermediate
  // version of this branch, with the column but not yet the key bit (round 2
  // review: the earlier test only covered the shape before either existed).
  const dir = scratch()
  const path = join(dir, 'usage.sqlite')
  const old = new DatabaseSync(path)
  old.exec(`CREATE TABLE usage (file TEXT NOT NULL, day INTEGER NOT NULL, runtime TEXT NOT NULL, model TEXT NOT NULL,
    project TEXT NOT NULL, input INTEGER NOT NULL DEFAULT 0, output INTEGER NOT NULL DEFAULT 0,
    cacheRead INTEGER NOT NULL DEFAULT 0, cacheWrite INTEGER NOT NULL DEFAULT 0, reasoning INTEGER NOT NULL DEFAULT 0,
    requests INTEGER NOT NULL DEFAULT 0, vendorCost REAL, PRIMARY KEY (file, day, runtime, model, project));
    INSERT INTO usage (file, day, runtime, model, project, input, requests, vendorCost) VALUES ('/a', 1, 'codex', 'm', '', 5, 1, NULL);
    INSERT INTO usage (file, day, runtime, model, project, input, requests, vendorCost) VALUES ('/b', 1, 'opencode', 'm', '', 5, 1, 0.5);`)
  old.close()
  const store = new LedgerStore(path)
  const rows = [...store.since(0)].sort((a, b) => a.file.localeCompare(b.file))
  assert.deepEqual(rows.map((row) => [row.file, row.vendorCost]), [
    ['/a', null],
    ['/b', 0.5],
  ])
  store.close()
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
  // The old key had no room for the difference; the rebuilt table does.
  store.commit(
    { path: '/c', size: 1, mtime: 1, offset: 1, tail: [] },
    [
      { file: '/c', day: 1, runtime: 'cline', model: 'm', project: '', input: 1, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, requests: 1, vendorCost: 0.5 },
      { file: '/c', day: 1, runtime: 'cline', model: 'm', project: '', input: 1, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, requests: 1, vendorCost: null },
    ],
    1,
    true,
  )
  assert.equal(store.since(0).filter((entry) => entry.file === '/c').length, 2)
  store.close()
  // Opened again, nothing is rebuilt and nothing is lost.
  const again = new LedgerStore(path)
  assert.equal(again.since(0).length, 4)
  again.close()
})

/** Every file in a folder with its size and time: what "left alone" means. */
const listing = (dir: string): string[] =>
  readdirSync(dir)
    .sort()
    .map((name) => `${name} ${statSync(join(dir, name)).size} ${statSync(join(dir, name)).mtimeMs}`)

const countRows = (database: DatabaseSync): number =>
  (database.prepare('SELECT count(*) AS n FROM t').get() as { n: number }).n

test('a database nobody has open is read without a file written beside it', () => {
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
  const before = listing(dir)
  assert.equal(existsSync(`${wal}-shm`) || existsSync(`${wal}-wal`), false, 'a closed WAL database leaves no side files')

  for (const [path, value] of [
    [wal, 1],
    [rollback, 2],
  ] as const) {
    assert.equal(readForeignDatabase(path, (database) => (database.prepare('SELECT x FROM t').get() as { x: number }).x), value)
  }
  assert.equal(readForeignDatabase(join(dir, 'not-a-database.db'), () => 1), null)
  assert.equal(readForeignDatabase(join(dir, 'absent.db'), () => 1), null)
  assert.deepEqual(listing(dir), before, 'no -shm, no -wal, nothing touched')
})

test('a database its owner has open is read from a copy: what it committed is seen, and nothing of its own is touched', () => {
  const dir = scratch()
  const path = join(dir, 'live.db')
  const owner = new DatabaseSync(path)
  // Commits stay in the log, as they do between an owner's checkpoints.
  owner.exec('PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0; CREATE TABLE t (x)')
  owner.exec('INSERT INTO t VALUES (1); INSERT INTO t VALUES (2); INSERT INTO t VALUES (3)')
  assert.ok(existsSync(`${path}-wal`) && existsSync(`${path}-shm`), 'an owner at work has both side files')
  const before = listing(dir)

  assert.equal(readForeignDatabase(path, countRows), 3, 'the rows only the log holds')
  assert.deepEqual(listing(dir), before, 'the owner’s files, byte for byte and time for time')
  owner.exec('INSERT INTO t VALUES (4)')
  assert.equal(readForeignDatabase(path, countRows), 4, 'and each read sees what has been committed since')
  owner.close()
})

test('an owner in exclusive locking mode, which has no shared memory to give it away, is still read safely', () => {
  const dir = scratch()
  const path = join(dir, 'exclusive.db')
  const owner = new DatabaseSync(path)
  owner.exec('PRAGMA locking_mode = EXCLUSIVE; PRAGMA journal_mode = WAL; CREATE TABLE t (x)')
  owner.exec('INSERT INTO t VALUES (1); INSERT INTO t VALUES (2)')
  // The case a "no -shm, so nobody is running" rule would open in place.
  assert.equal(existsSync(`${path}-shm`), false, 'exclusive mode keeps its index in memory')
  assert.ok(existsSync(`${path}-wal`))
  const before = listing(dir)

  assert.equal(readForeignDatabase(path, countRows), 2)
  assert.deepEqual(listing(dir), before)
  owner.close()
})

test('an owner that starts while an idle database is being read has its read thrown away, not trusted', () => {
  const dir = scratch()
  const path = join(dir, 'race.db')
  const writer = new DatabaseSync(path)
  writer.exec('PRAGMA journal_mode = WAL; CREATE TABLE t (x); INSERT INTO t VALUES (1)')
  writer.close()
  assert.equal(existsSync(`${path}-wal`), false)

  let owner: DatabaseSync | null = null
  assert.throws(
    () =>
      readForeignDatabase(path, countRows, {
        onCopied: () => {
          // The owner wakes up and commits while the immutable read is under way.
          owner = new DatabaseSync(path)
          owner.exec('INSERT INTO t VALUES (2)')
        },
      }),
    /changed while it was being read/,
  )
  ;(owner as DatabaseSync | null)?.close()
})

test('a commit while the snapshot is being copied sends it round again, and one that never stops is refused', () => {
  const dir = scratch()
  const path = join(dir, 'busy.db')
  const owner = new DatabaseSync(path)
  owner.exec('PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0; CREATE TABLE t (x); INSERT INTO t VALUES (1)')

  // One commit lands mid-copy: the first copy is discarded, the second is whole.
  let landed = false
  assert.equal(
    readForeignDatabase(path, countRows, {
      onCopied: () => {
        if (landed) return
        landed = true
        owner.exec('INSERT INTO t VALUES (2)')
      },
    }),
    2,
  )

  // A writer that commits every time is never read torn: after three tries it is an error.
  let n = 10
  assert.throws(
    () => readForeignDatabase(path, countRows, { onCopied: () => owner.exec(`INSERT INTO t VALUES (${n++})`) }),
    /changed while it was being read/,
  )
  owner.close()
})

test('a caller’s byte budget sums the write-ahead log with the main file, not the main file alone', () => {
  const dir = scratch()
  const path = join(dir, 'wal-budget.db')
  const owner = new DatabaseSync(path)
  // Commits stay in the log, as they do between an owner's checkpoints, so
  // one large row leaves the main file small and the log holding the bulk.
  owner.exec('PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0; CREATE TABLE t (x)')
  owner.exec(`INSERT INTO t VALUES ('${'x'.repeat(200_000)}')`)
  assert.ok(existsSync(`${path}-wal`), 'an owner at work has a log')
  const mainSize = statSync(path).size
  const walSize = statSync(`${path}-wal`).size
  assert.ok(walSize > mainSize, 'the log, not the main file, holds the bulk of what was written')

  assert.throws(
    () => readForeignDatabase(path, countRows, { byteLimit: mainSize + 100 }),
    (error: unknown) => error instanceof InsightBudgetExceededError,
    'a budget that only covers the main file must still refuse once the log is summed in',
  )
  assert.equal(
    readForeignDatabase(path, countRows, { byteLimit: mainSize + walSize }),
    1,
    'the same read succeeds once the budget comfortably covers both files summed',
  )
  owner.close()
})

test('a rollback-journal database that grows while it is being read is refused, not counted at the size checked before', () => {
  const dir = scratch()
  const path = join(dir, 'rollback-growth.db')
  const db = new DatabaseSync(path)
  db.exec('CREATE TABLE t (x); INSERT INTO t VALUES (1)')
  db.close()
  const before = statSync(path).size

  assert.throws(
    () =>
      readForeignDatabase(
        path,
        (database) => {
          const value = countRows(database)
          // Grows the file while the read this budget approved is still in
          // flight — the exact race a check taken once, before the read,
          // and never looked at again would miss.
          appendFileSync(path, 'x'.repeat(2000))
          return value
        },
        { byteLimit: before + 100 },
      ),
    /changed while it was being read/,
  )
})

/*
 * #865. A database refused because it changed while it was read was still
 * read, so what it cost is on the refusal: the caller's shared budget counts
 * it, and a source that keeps changing can no longer be read over and over for
 * free.
 */
test('a budgeted database refused because it changed while it was read says how much of it was read', () => {
  const dir = scratch()
  const path = join(dir, 'rollback-changed.db')
  const db = new DatabaseSync(path)
  db.exec('CREATE TABLE t (x); INSERT INTO t VALUES (1)')
  db.close()
  const before = statSync(path).size
  assert.throws(
    () => readForeignDatabase(path, (database) => {
      const value = countRows(database)
      appendFileSync(path, 'x'.repeat(10))
      return value
    }, { byteLimit: before * 4 }),
    // Read in place, and grown by ten bytes before the second look: what the file held at its largest.
    (error: unknown) => error instanceof InsightSourceChangedError && error.bytesRead === before + 10,
  )

  const busy = join(dir, 'busy-changed.db')
  const owner = new DatabaseSync(busy)
  owner.exec('PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0; CREATE TABLE t (x); INSERT INTO t VALUES (1)')
  let n = 10
  const copies: number[] = []
  assert.throws(
    () => readForeignDatabase(busy, countRows, {
      byteLimit: 1024 * 1024 * 1024,
      onCopied: () => {
        copies.push(statSync(busy).size + statSync(`${busy}-wal`).size)
        owner.exec(`INSERT INTO t VALUES (${n++})`)
      },
    }),
    (error: unknown) => error instanceof InsightSourceChangedError && error.bytesRead === copies.reduce((sum, size) => sum + size, 0) && copies.length === 3,
    'every copy thrown away was still read, and all of them count',
  )
  owner.close()
})

/*
 * #940 review P3-6. The database's copy is read before its log's; when the
 * log's copy then fails (a checkpoint removed it), what the database copy
 * read still counts — every attempt's.
 */
test('a snapshot whose log copy fails still counts the database bytes it copied', (t) => {
  const dir = scratch()
  const path = join(dir, 'lost-log.db')
  const owner = new DatabaseSync(path)
  owner.exec('PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0; CREATE TABLE t (x); INSERT INTO t VALUES (1)')
  const dbSize = statSync(path).size
  const fs = createRequire(import.meta.url)('node:fs') as typeof import('node:fs')
  const real = fs.copyFileSync
  let n = 10
  fs.copyFileSync = ((from: string, to: string) => {
    if (String(from).endsWith('-wal')) {
      // The owner commits (so the fingerprint moves) and the log is gone by the time it is copied.
      owner.exec(`INSERT INTO t VALUES (${n++})`)
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    }
    return real(from, to)
  }) as typeof fs.copyFileSync
  syncBuiltinESMExports()
  t.after(() => {
    fs.copyFileSync = real
    syncBuiltinESMExports()
    owner.close()
  })
  assert.throws(
    () => readForeignDatabase(path, countRows, { byteLimit: 1024 * 1024 * 1024 }),
    (error: unknown) => error instanceof InsightSourceChangedError && error.bytesRead === 3 * dbSize,
    'three attempts, each of which read the database before its log failed',
  )
})

test('a snapshot copy a commit made stale is spent from the budget, so a second copy that no longer fits is refused', () => {
  const dir = scratch()
  const path = join(dir, 'stale-copy.db')
  const owner = new DatabaseSync(path)
  owner.exec('PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0; CREATE TABLE t (x); INSERT INTO t VALUES (1)')
  const size = statSync(path).size + statSync(`${path}-wal`).size
  let landed = false
  assert.throws(
    () => readForeignDatabase(path, countRows, {
      // Room for one copy and a half: the first copy is spent, and the second no longer fits.
      byteLimit: Math.floor(size * 1.5),
      onCopied: () => {
        if (landed) return
        landed = true
        owner.exec('INSERT INTO t VALUES (2)')
      },
    }),
    (error: unknown) => error instanceof InsightBudgetExceededError,
  )
  owner.close()
})

test('a rollback-journal database written to during a no-budget read still succeeds, as SQLite’s own lock already allows', () => {
  const dir = scratch()
  const path = join(dir, 'rollback-nobudget-growth.db')
  const db = new DatabaseSync(path)
  db.exec('CREATE TABLE t (x); INSERT INTO t VALUES (1)')
  db.close()

  // No `byteLimit`, matching the background scan: the consistency check
  // that a caller's byte budget needs must not apply here, or a write
  // elsewhere in the file during the read — a checkpoint, another
  // connection's commit — fails a read SQLite's own shared lock already
  // kept consistent, where it never used to.
  const result = readForeignDatabase(path, (database) => {
    const value = countRows(database)
    appendFileSync(path, 'x'.repeat(2000))
    return value
  })
  assert.equal(result, 1)
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
