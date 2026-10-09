import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { test, type TestContext } from 'node:test'
import { runtimeId, sessionId, turnId, itemId, type AgentItem, type Session, type Turn } from '@harnessdesk/protocol'
import { SessionIndex } from '../src/session-index.js'
import { TranscriptStore } from '../src/transcripts.js'

const message = (id: string, text: string): AgentItem => ({ id: itemId(id), type: 'assistantMessage', text } as AgentItem)
const tool = (text: string, status: 'running' | 'completed' = 'completed'): AgentItem => ({
  id: itemId('tool'), type: 'toolCall', tool: 'read', source: { kind: 'builtin' }, status, args: {}, result: [{ type: 'text', text }],
} as AgentItem)
const turn = (id: string, items: readonly AgentItem[]): Turn => ({ id: turnId(id), status: 'completed', items })
const session = (turns: readonly Turn[], id = 's1'): Session => ({
  runtime: runtimeId('demo'), id: sessionId(id), cwd: '/demo/project', createdAt: 1, updatedAt: 2,
  title: 'A stored conversation', preview: 'Opening words', status: { type: 'idle' }, itemsLoaded: true, turns,
})
const fixture = async (t: TestContext) => {
  const home = await mkdtemp(join(tmpdir(), 'hd-sqlite-transcripts-'))
  const store = new TranscriptStore(join(home, 'transcripts'))
  t.after(async () => {
    await store.close()
    await rm(home, { recursive: true, force: true })
  })
  return { home, store, db: () => new DatabaseSync(join(home, 'sessions.sqlite'), { readOnly: true }) }
}

test('a cold database reconstructs every stored turn, item, usage and Insight field', async t => {
  const { home, store, db } = await fixture(t)
  const original = { ...session([{ ...turn('t1', [message('answer', 'kept'), tool('full output')]),
    status: 'failed', error: { message: 'interrupted' }, startedAt: 10, completedAt: 20, durationMs: 10,
    plan: [{ step: 'Keep the record', status: 'completed' }], diff: 'a diff',
  }]), usage: {
    contextUsed: 120, contextWindow: 1000,
    total: { totalTokens: 150, inputTokens: 120, cachedInputTokens: 0, outputTokens: 30, reasoningOutputTokens: 0 },
    last: { totalTokens: 150, inputTokens: 120, cachedInputTokens: 0, outputTokens: 30, reasoningOutputTokens: 0 },
  } }
  const insight = [{ turn: 't1', startedAt: 10, endedAt: 20, seat: 'demo-seat', cause: { kind: 'person' as const },
    parent: null, before: null, after: null, generation: '', observedAt: 20, loaded: null }]
  store.record(original, { insight })
  await store.flush()
  const expected = await store.exportAll()
  const database = db()
  assert.equal(database.prepare('SELECT count(*) AS n FROM turns').get()?.n, 1)
  assert.equal(database.prepare('SELECT preview FROM sessions').get()?.preview, original.preview)
  assert.deepEqual(JSON.parse(String(database.prepare('SELECT usage FROM sessions').get()?.usage)), original.usage)
  database.close()
  await store.close()
  const cold = new TranscriptStore(join(home, 'transcripts'))
  try {
    assert.deepEqual(await cold.exportAll(), expected)
    assert.deepEqual((await cold.recover(original.runtime, original.id))?.turns, original.turns)
    assert.deepEqual(await cold.readInsight(original.runtime, original.id), insight)
  } finally { await cold.close() }
})

test('one changed turn among 76 writes one turn and one changed item, including after restart', async t => {
  const { home, store } = await fixture(t)
  const turns = Array.from({ length: 76 }, (_, i) => turn(`t${i}`, [message(`m${i}`, `answer ${i}`)]))
  store.record(session(turns))
  await store.flush()
  const counter = new DatabaseSync(join(home, 'sessions.sqlite'))
  t.after(() => counter.close())
  counter.exec(`CREATE TABLE write_counts(kind TEXT);
    CREATE TRIGGER count_turn AFTER UPDATE ON turns BEGIN INSERT INTO write_counts VALUES('turn'); END;
    CREATE TRIGGER count_item AFTER UPDATE ON items BEGIN INSERT INTO write_counts VALUES('item'); END;`)
  await store.close()
  const cold = new TranscriptStore(join(home, 'transcripts'))
  try {
    cold.record(session([...turns.slice(0, -1), turn('t75', [message('m75', 'the final answer')])]))
    await cold.flush()
    assert.deepEqual(counter.prepare('SELECT kind, count(*) AS n FROM write_counts GROUP BY kind ORDER BY kind').all().map(r => ({ ...r })),
      [{ kind: 'item', n: 1 }, { kind: 'turn', n: 1 }])
  } finally { await cold.close() }
})

test('a corrupt retained body does not prevent later live turns from being saved', async t => {
  const { home, store } = await fixture(t)
  const original = session([turn('t1', [message('m1', 'first answer')])])
  store.record(original)
  await store.flush()
  const database = new DatabaseSync(join(home, 'sessions.sqlite'))
  try {
    const corruptions = ['not JSON', JSON.stringify({ version: 1, insightOrder: {}, savedAt: 1 })]
    for (const [index, payload] of corruptions.entries()) {
      database.prepare('UPDATE bodies SET payload=? WHERE runtime=? AND id=?').run(payload, original.runtime, original.id)
      const live = session([...original.turns, turn('t2', [message('m2', `later answer ${index}`)])])
      store.record(live)
      await store.flush()
      assert.deepEqual((await store.recover(live.runtime, live.id))?.turns, live.turns)
    }
  } finally { database.close() }
})

test('item occurrence sequences survive completion and repeated IDs stay distinct', async t => {
  const { store, db } = await fixture(t)
  store.record(session([turn('t1', [tool('running words', 'running'), message('same', 'one'), message('same', 'two')]), turn('t2', [message('same', 'three')])]))
  await store.flush()
  const before = db()
  const sequence = before.prepare("SELECT seq FROM items WHERE item_id='tool'").get()?.seq
  before.close()
  store.record(session([turn('t1', [tool('final words'), message('same', 'one'), message('same', 'two')]), turn('t2', [message('same', 'three')])]))
  await store.flush()
  const after = db()
  assert.equal(after.prepare("SELECT seq FROM items WHERE item_id='tool'").get()?.seq, sequence)
  assert.equal(after.prepare('SELECT count(*) AS n FROM items').get()?.n, 4)
  after.close()
  assert.deepEqual((await store.recover(runtimeId('demo'), sessionId('s1')))?.turns[0]?.items.slice(1).map(i => (i as { text: string }).text), ['one', 'two'])
})

test('search opts into capped tool output, excludes reasoning, and removes running text', async t => {
  const { store } = await fixture(t)
  const includeTools = { includeTools: true } as Parameters<TranscriptStore['search']>[1]
  store.record(session([turn('t1', [message('m', 'spoken words'), tool('running words', 'running'), { id: itemId('r'), type: 'reasoning', summary: ['secret reasoning'], content: ['secret reasoning'] }])]))
  await store.flush()
  assert.equal((await store.search('spoken')).length, 1)
  assert.deepEqual(await store.search('running'), [])
  assert.equal(((await store.search('running', includeTools))[0] as { source?: string } | undefined)?.source, 'tool')
  assert.deepEqual(await store.search('secret', includeTools), [])
  const output = `final words ${'x'.repeat(3100)} beyondcap`
  store.record(session([turn('t1', [message('m', 'spoken words'), tool(output)])]))
  await store.flush()
  assert.deepEqual(await store.search('running', includeTools), [])
  assert.equal(((await store.search('final', includeTools))[0] as { source?: string } | undefined)?.source, 'tool')
  assert.deepEqual(await store.search('beyondcap', includeTools), [])
  assert.deepEqual((await store.recover(runtimeId('demo'), sessionId('s1')))?.turns[0]?.items[1], tool(output))
})

test('search is literal, newest first, substring based, and bounded by conversation count', async t => {
  const { store } = await fixture(t)
  for (const [i, id] of ['old', 'new'].entries()) {
    await store.importOne('demo', id, { version: 1, runtime: 'demo', id, savedAt: i + 1, turns: [turn('t', [message('m', 'A " * AND - % _ tokenwithinword')])] })
  }
  for (const query of ['"', '*', 'AND', '-', '%', '_', 'within']) {
    assert.deepEqual((await store.search(query)).map(h => h.summary.id), ['new', 'old'])
  }
  assert.equal((await store.search('within', { limit: 1 })).length, 1)
  assert.deepEqual(await store.search('within', { limit: 0 }), [])
})

test('search reads matching text and metadata without decoding unrelated or full tool payloads', async t => {
  const { home, store } = await fixture(t)
  store.record(session([turn('t1', [message('m', 'Spoken needle'), tool('Tool needle'),
    { id: itemId('r'), type: 'reasoning', summary: ['private'], content: [] }])]))
  await store.flush()
  const database = new DatabaseSync(join(home, 'sessions.sqlite'))
  try {
    // A read of these payloads would throw, proving search does not assemble the body.
    database.prepare("UPDATE items SET payload='unreadable' WHERE kind IN ('reasoning','toolCall')").run()
    assert.equal((await store.search('spoken'))[0]?.line, 'Spoken needle')
    const hit = (await store.search('tool', { includeTools: true }))[0]
    assert.equal(hit?.line, 'Tool needle')
    assert.equal(hit?.source, 'tool')
    assert.equal(hit?.summary.title, 'A stored conversation')
  } finally { database.close() }
})

test('rollback and forget remove body, item, turn and FTS rows atomically while retaining the index', async t => {
  const { home, store, db } = await fixture(t)
  const index = new SessionIndex(join(home, 'sessions.sqlite'))
  t.after(() => index.close())
  const original = session([turn('t1', [message('a', 'retained')]), turn('t2', [message('b', 'dropped')])])
  index.upsert(original)
  store.record(original)
  await store.flush()
  await store.dropTurns(original.runtime, original.id, 1)
  assert.deepEqual(await store.search('dropped'), [])
  let database = db()
  assert.equal(database.prepare('SELECT count(*) AS n FROM turns').get()?.n, 1)
  database.close()
  await store.forget(original.runtime, original.id)
  database = db()
  for (const table of ['turns', 'items', 'items_fts', 'bodies']) assert.equal(database.prepare(`SELECT count(*) AS n FROM ${table}`).get()?.n, 0, table)
  assert.equal(database.prepare("SELECT count(*) AS n FROM items_fts WHERE items_fts MATCH 'retained'").get()?.n, 0, 'no FTS postings survive')
  assert.equal(database.prepare('SELECT count(*) AS n FROM sessions').get()?.n, 1)
  database.close()
})

test('a failed rollback leaves every body row, FTS posting and Insight context intact', async t => {
  const { home, store } = await fixture(t)
  const original = session([turn('t1', [message('a', 'retained')]), turn('t2', [message('b', 'dropped')])])
  store.record(original, { insight: [{ turn: 't2', startedAt: 1, endedAt: null, seat: 'demo-seat', cause: { kind: 'person' },
    parent: null, before: null, after: null, generation: '', observedAt: 1, loaded: null }] })
  await store.flush()
  const before = await store.exportAll()
  const database = new DatabaseSync(join(home, 'sessions.sqlite'))
  try {
    database.exec("CREATE TRIGGER block_rollback BEFORE DELETE ON items BEGIN SELECT RAISE(ABORT,'rollback held'); END;")
    await store.dropTurns(original.runtime, original.id, 1)
    assert.deepEqual(await store.exportAll(), before)
    assert.equal((await store.search('dropped')).length, 1)
    assert.equal((await store.readInsight(original.runtime, original.id))?.[0]?.turn, 't2')
  } finally { database.close() }
})

test('old transcript files are never read, changed or removed by body operations', async t => {
  const { home, store } = await fixture(t)
  const folder = join(home, 'transcripts', 'demo')
  await mkdir(folder, { recursive: true })
  const old = JSON.stringify({ version: 1, runtime: 'demo', id: 'old', savedAt: 1, turns: [turn('t', [message('m', 'oldonly')])] })
  await writeFile(join(folder, 'old.json'), old)
  await writeFile(join(folder, 'broken.json'), 'broken')
  assert.deepEqual(await store.search('oldonly'), [])
  assert.equal(await store.recover(runtimeId('demo'), sessionId('old')), null)
  store.record(session([turn('t', [message('m', 'newonly')])], 'old'))
  await store.flush()
  await store.dropTurns(runtimeId('demo'), sessionId('old'), 1)
  await store.forget(runtimeId('demo'), sessionId('old'))
  assert.equal(await readFile(join(folder, 'old.json'), 'utf8'), old)
  assert.equal(await readFile(join(folder, 'broken.json'), 'utf8'), 'broken')
  assert.deepEqual((await readdir(folder)).sort(), ['broken.json', 'old.json'])
})

test('version-1 backups round trip into a fresh database without altering their shape', async t => {
  const { store } = await fixture(t)
  const old = { version: 1, runtime: 'demo', id: 'legacy', savedAt: 42, turns: [turn('t', [message('a', 'legacy words')])] }
  assert.equal(await store.importOne('demo', 'legacy', old), 'restored')
  assert.deepEqual(await store.exportAll(), [{ runtime: 'demo', id: 'legacy', data: old }])
  const { store: fresh } = await fixture(t)
  for (const row of await store.exportAll()) assert.equal(await fresh.importOne(row.runtime, row.id, row.data), 'restored')
  assert.deepEqual(await fresh.exportAll(), await store.exportAll())
})
