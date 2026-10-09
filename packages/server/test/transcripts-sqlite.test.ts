import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { test, type TestContext } from 'node:test'
import { runtimeId, sessionId, turnId, itemId, type AgentItem, type Session, type Turn } from '@harnessdesk/protocol'
import { SessionIndex } from '../src/session-index.js'
import { TranscriptStore } from '../src/transcripts.js'
import { TranscriptDatabase } from '../src/transcript-database.js'

const message = (id: string, text: string): AgentItem => ({ id: itemId(id), type: 'assistantMessage', text } as AgentItem)
const tool = (text: string, status: 'running' | 'completed' = 'completed'): AgentItem => ({
  id: itemId('tool'), type: 'toolCall', tool: 'read', source: { kind: 'builtin' }, status, args: {}, result: [{ type: 'text', text }],
} as AgentItem)
const turn = (id: string, items: readonly AgentItem[]): Turn => ({ id: turnId(id), status: 'completed', items })
const session = (turns: readonly Turn[], id = 's1'): Session => ({
  runtime: runtimeId('demo'), id: sessionId(id), cwd: '/demo/project', createdAt: 1, updatedAt: 2,
  title: 'A stored conversation', preview: 'Opening words', status: { type: 'idle' }, itemsLoaded: true, turns,
})
const fixture = async (t: TestContext, log?: ConstructorParameters<typeof TranscriptStore>[1]) => {
  const home = await mkdtemp(join(tmpdir(), 'hd-sqlite-transcripts-'))
  const store = new TranscriptStore(join(home, 'transcripts'), log)
  t.after(async () => {
    await store.close()
    await rm(home, { recursive: true, force: true })
  })
  return { home, store, db: () => new DatabaseSync(join(home, 'sessions.sqlite'), { readOnly: true }) }
}

test('recording fills missing index titles and advances preview and updated time', async t => {
  const { home, store } = await fixture(t)
  const original = session([turn('t1', [message('answer', 'kept')])])
  const index = new SessionIndex(join(home, 'sessions.sqlite'))
  try {
    store.record({ ...original, title: null, preview: null })
    await store.flush()
    store.record({ ...original, updatedAt: 20 })
    await store.flush()
    const row = index.list().data[0]!
    const stored = (await store.readSummary(original.runtime, original.id))!
    assert.equal(row.title, original.title)
    assert.equal(row.title, stored.title)
    assert.equal(row.preview, stored.preview)
    assert.equal(row.cwd, stored.cwd)
    assert.equal(row.updatedAt, stored.updatedAt)
  } finally { index.close() }
})

test('recording supplies a new index title and preserves a later rename', async t => {
  const { home, store } = await fixture(t)
  const original = session([turn('t1', [message('answer', 'kept')])])
  const index = new SessionIndex(join(home, 'sessions.sqlite'))
  try {
    store.record(original)
    await store.flush()
    assert.equal(index.list().data[0]?.title, original.title)
    index.setTitle(original.runtime, original.id, 'Person chose this name')
    store.record({ ...original, title: 'Later agent title', preview: 'Later opening', updatedAt: 30 })
    await store.flush()
    assert.equal(index.list().data[0]?.title, 'Person chose this name')
    assert.equal(index.list().data[0]?.preview, 'Later opening')
    assert.equal(index.list().data[0]?.updatedAt, 30)
    store.record(original)
    await store.flush()
    assert.equal(index.list().data[0]?.title, 'Person chose this name')
    assert.equal(index.list().data[0]?.updatedAt, 30, 'an older transcript observation cannot move the row backwards')
  } finally { index.close() }
})

test('a JSON metadata upgrade keeps titles and facts when SQLite recording follows', async t => {
  const { home, store } = await fixture(t)
  const original = session([turn('t1', [message('answer', 'kept')])])
  const folder = join(home, 'transcripts', original.runtime)
  await mkdir(folder, { recursive: true })
  const file = join(folder, `${original.id}.json`)
  const legacy = JSON.stringify({ version: 1, ...original, savedAt: 10 })
  await writeFile(file, legacy)
  const index = new SessionIndex(join(home, 'sessions.sqlite'))
  try {
    await index.seed(home, { archiveCapability: () => false })
    const seeded = index.list().data[0]!
    assert.equal(seeded.title, original.title)
    assert.equal(seeded.preview, original.preview)
    assert.equal(seeded.cwd, original.cwd)
    assert.equal(seeded.updatedAt, original.updatedAt)
    store.record({ ...original, updatedAt: 40 })
    await store.flush()
    assert.equal(index.list().data[0]?.title, original.title)
    assert.equal(index.list().data[0]?.updatedAt, 40)
    assert.equal(await readFile(file, 'utf8'), legacy)
  } finally { index.close() }
})

test('restoring a titled version-1 body supplies its index metadata', async t => {
  const { home, store } = await fixture(t)
  const original = session([turn('t1', [message('answer', 'kept')])])
  assert.equal(await store.importOne(original.runtime, original.id, { version: 1, ...original, savedAt: 10 }), 'restored')
  const index = new SessionIndex(join(home, 'sessions.sqlite'))
  try {
    const row = index.list().data[0]!
    assert.equal(row.title, original.title)
    assert.equal(row.preview, original.preview)
    assert.equal(row.cwd, original.cwd)
    assert.equal(row.updatedAt, original.updatedAt)
  } finally { index.close() }
})

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

test('a live save reconciles corrupt retained rows even when their turn fingerprints still match', async t => {
  const corruptions = [
    { name: 'turn', kind: null, payload: 'not JSON' },
    { name: 'user message', kind: 'userMessage', payload: 'not JSON' },
    ...['assistantMessage', 'toolCall', 'reasoning'].flatMap(kind =>
      ['not JSON', 'null'].map(payload => ({ name: `${kind} ${payload}`, kind, payload }))),
  ]
  for (const corruption of corruptions) for (const restart of [false, true]) {
    await t.test(`${corruption.name}, ${restart ? 'cold' : 'warm'} writer`, async t => {
      const { home, store } = await fixture(t)
      const original = session([turn('t1', [
        { id: itemId('ask'), type: 'userMessage', content: [{ type: 'text', text: 'first question' }] },
        message('answer', 'first answer'), tool('retained output'),
        { id: itemId('reasoning'), type: 'reasoning', summary: ['retained summary'], content: ['retained reasoning'] },
      ])])
      store.record(original)
      await store.flush()
      const database = new DatabaseSync(join(home, 'sessions.sqlite'))
      const sequences = database.prepare('SELECT item_id,seq FROM items ORDER BY seq').all()
      const fingerprint = database.prepare('SELECT fingerprint FROM turns').get()?.fingerprint
      if (corruption.kind === null) database.prepare('UPDATE turns SET payload=?').run(corruption.payload)
      else database.prepare('UPDATE items SET payload=? WHERE kind=?').run(corruption.payload, corruption.kind)
      assert.equal(database.prepare('SELECT fingerprint FROM turns').get()?.fingerprint, fingerprint)
      let writer = store
      try {
        if (restart) {
          await store.close()
          writer = new TranscriptStore(join(home, 'transcripts'))
        }
        const live = session([...original.turns, turn('t2', [message('later', 'later answer')])])
        writer.record(live)
        await writer.flush()
        await t.test('recovery', async () => {
          assert.deepEqual((await writer.recover(live.runtime, live.id))?.turns, live.turns)
        })
        await t.test('backup round trip', async t => {
          const exported = await writer.exportAll()
          const { store: fresh } = await fixture(t)
          for (const row of exported) assert.equal(await fresh.importOne(row.runtime, row.id, row.data), 'restored')
          assert.deepEqual(await fresh.exportAll(), exported)
          assert.deepEqual((await fresh.recover(live.runtime, live.id))?.turns, live.turns)
        })
        assert.deepEqual(database.prepare("SELECT item_id,seq FROM items WHERE turn_id='t1' ORDER BY seq").all(), sequences)
        assert.equal((await writer.search('first question'))[0]?.line, 'first question')
      } finally {
        if (writer !== store) await writer.close()
        database.close()
      }
    })
  }
})

test('the write transaction protects a newer body even when an earlier read was supported', async t => {
  const { home, store } = await fixture(t)
  store.record(session([turn('t1', [message('m', 'original answer')])]))
  await store.flush()
  const writer = new TranscriptDatabase(join(home, 'sessions.sqlite'))
  const database = new DatabaseSync(join(home, 'sessions.sqlite'))
  try {
    const supported = writer.read('demo', 's1')
    assert.ok(supported)
    const future = JSON.stringify({ version: 2, somethingNewer: true })
    database.prepare('UPDATE bodies SET payload=? WHERE runtime=? AND id=?').run(future, 'demo', 's1')
    const before = database.prepare('SELECT * FROM sessions').all()
    assert.throws(() => writer.write({ ...supported, turns: [turn('t2', [message('new', 'replacement')])] }), /newer format/)
    assert.equal(database.prepare('SELECT payload FROM bodies').get()?.payload, future)
    assert.deepEqual(database.prepare('SELECT * FROM sessions').all(), before)
    assert.equal(database.prepare("SELECT count(*) AS n FROM items_fts WHERE items_fts MATCH 'original'").get()?.n, 1)
    assert.equal(database.prepare("SELECT count(*) AS n FROM items_fts WHERE items_fts MATCH 'replacement'").get()?.n, 0)
  } finally { writer.close(); database.close() }
})

test('matching turn fingerprints still verify retained item payload identities and kinds', async t => {
  const items: readonly AgentItem[] = [message('answer', 'first answer'), tool('retained output'),
    { id: itemId('reasoning'), type: 'reasoning', summary: ['retained summary'], content: ['retained reasoning'] }]
  for (const item of items) for (const field of ['id', 'type']) {
    await t.test(`${item.type} ${field}`, () => {
      const database = new TranscriptDatabase(':memory:')
      try {
        const original = { ...session([turn('t1', [item])]), version: 1 as const, savedAt: 1 }
        database.write(original)
        assert.ok(database.read(original.runtime, original.id, true), 'provenance was read before the row changed')
        database.db.prepare('UPDATE items SET payload=?').run(JSON.stringify({ ...item, [field]: 'different' }))
        database.write(original)
        assert.deepEqual(database.read(original.runtime, original.id)?.turns, original.turns)
      } finally { database.close() }
    })
  }
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

test('search skips only invalid conversations, including corrupt preview fallback rows', async t => {
  for (const corruption of ['facts JSON', 'facts shape', 'fallback turn', 'fallback item']) await t.test(corruption, async t => {
    const logs: { message: string; details?: Record<string, unknown> }[] = []
    const { home, store } = await fixture(t, (message, details) => { logs.push({ message, details }) })
    for (const id of ['good', 'bad']) {
      store.record(session([turn('t1', [message('m1', 'shared needle'), message('m2', 'another needle')])], id))
    }
    await store.flush()
    logs.length = 0
    const database = new DatabaseSync(join(home, 'sessions.sqlite'))
    try {
      database.prepare("UPDATE sessions SET saved_at=9999999999999 WHERE id='bad'").run()
      if (corruption.startsWith('facts')) {
        database.prepare("UPDATE bodies SET payload=? WHERE id='bad'").run(corruption === 'facts JSON' ? 'not JSON' : 'null')
      } else {
        const facts = JSON.parse(String(database.prepare("SELECT payload FROM bodies WHERE id='bad'").get()?.payload))
        delete facts.preview
        database.prepare("UPDATE bodies SET payload=? WHERE id='bad'").run(JSON.stringify(facts))
        if (corruption === 'fallback turn') database.prepare("UPDATE turns SET payload='not JSON' WHERE id='bad'").run()
        else database.prepare("UPDATE items SET kind='userMessage',payload='null' WHERE id='bad'").run()
      }
      const hits = await store.search('needle', { limit: 1 })
      assert.deepEqual(hits.map(hit => hit.summary.id), ['good'])
      assert.equal(logs.length, 1, 'the invalid conversation is logged once, not once per matching item')
      assert.equal(logs[0]?.details?.session, 'bad')
    } finally { database.close() }
  })
})

test('search still rejects a database query failure', async t => {
  const { home, store } = await fixture(t)
  store.record(session([turn('t1', [message('m', 'needle')])]))
  await store.flush()
  const database = new DatabaseSync(join(home, 'sessions.sqlite'))
  try {
    database.exec('ALTER TABLE turns RENAME TO unavailable_turns')
    await assert.rejects(store.search('needle'), /no such table/)
  } finally {
    database.exec('ALTER TABLE unavailable_turns RENAME TO turns')
    database.close()
  }
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

test('preview bodies stay imported and cached, account payload bytes, and become full on promotion', async t => {
  const { home, store, db } = await fixture(t)
  const original = session([turn('t1', [message('answer', 'Cached synthetic answer')])])
  const index = new SessionIndex(join(home, 'sessions.sqlite'))
  t.after(() => index.close())
  index.upsert(original, { origin: 'imported' })
  await store.refresh(original, null)
  const database = db()
  try {
    const row = database.prepare('SELECT * FROM sessions').get()!
    assert.equal(row.origin, 'imported')
    assert.equal(row.body, 'cached')
    assert.ok(Number(row.body_bytes) > 0)
    assert.equal(index.list().data.length, 0)
  } finally { database.close() }
})

test('cached eviction is oldest-first, excludes full and live bodies, and removes every body table and FTS atomically', async t => {
  const { home, store, db } = await fixture(t)
  const index = new SessionIndex(join(home, 'sessions.sqlite'))
  t.after(() => index.close())
  for (const id of ['old', 'new', 'live', 'full']) {
    const original = session([turn('t1', [message('answer', `needle ${id}`), tool('cached tool')])], id)
    index.upsert(original, { origin: id === 'full' ? 'desk' : 'imported' })
    store.record(original, { insight: [{ turn: 't1', startedAt: 1, endedAt: 2, seat: 'synthetic', cause: { kind: 'person' },
      parent: null, before: null, after: null, generation: '', observedAt: 2, loaded: null }] })
  }
  await store.flush()
  const writable = new DatabaseSync(join(home, 'sessions.sqlite'))
  t.after(() => writable.close())
  writable.exec("UPDATE sessions SET last_opened_at=CASE id WHEN 'old' THEN 1 WHEN 'new' THEN 2 ELSE 0 END")
  const oldBytes = Number(writable.prepare("SELECT body_bytes FROM sessions WHERE id='old'").get()?.body_bytes)
  const total = Number(writable.prepare("SELECT SUM(body_bytes) AS n FROM sessions WHERE body='cached'").get()?.n)
  assert.deepEqual(store.evictCached(total - oldBytes, (_, id) => id === 'live'), { count: 1, bytes: oldBytes })
  assert.equal(writable.prepare("SELECT body FROM sessions WHERE id='old'").get()?.body, 'none')
  for (const table of ['bodies', 'turns', 'items']) assert.equal(writable.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE id='old'`).get()?.n, 0)
  assert.equal(writable.prepare("SELECT count(*) AS n FROM items_fts WHERE items_fts MATCH 'old'").get()?.n, 0)
  assert.equal(writable.prepare("SELECT usage FROM sessions WHERE id='old'").get()?.usage, null)
  assert.equal(await store.readInsight(runtimeId('demo'), sessionId('old')), null)
  assert.equal((await store.recover(runtimeId('demo'), sessionId('new')))?.turns.length, 1)
  const cleared = store.evictCached(0, (_, id) => id === 'live')
  assert.equal(cleared.count, 1)
  assert.equal(writable.prepare("SELECT body FROM sessions WHERE id='full'").get()?.body, 'full')
  assert.equal(writable.prepare("SELECT body FROM sessions WHERE id='live'").get()?.body, 'cached')
  // A constraint failure rolls back item, FTS, turn and metadata deletion together.
  writable.exec("CREATE TRIGGER fail_clear BEFORE DELETE ON turns WHEN old.id='live' BEGIN SELECT RAISE(ABORT,'synthetic refusal'); END")
  assert.throws(() => store.evictCached(0, () => false), /synthetic refusal/)
  assert.ok(writable.prepare("SELECT 1 FROM items WHERE id='live'").get())
  assert.ok(writable.prepare("SELECT 1 FROM items_fts WHERE items_fts MATCH 'live'").get())
  assert.equal(writable.prepare("SELECT body FROM sessions WHERE id='live'").get()?.body, 'cached')
})

test('cached byte estimates follow UTF-8 writes and promotion makes the body ineligible for eviction', async t => {
  const { home, store } = await fixture(t)
  const index = new SessionIndex(join(home, 'sessions.sqlite'))
  t.after(() => index.close())
  const original = session([turn('t1', [message('answer', 'Synthetic 😀 cached answer')])])
  index.upsert(original, { origin: 'imported' })
  await store.refresh(original, null)
  const db = new DatabaseSync(join(home, 'sessions.sqlite'))
  t.after(() => db.close())
  const measured = () => Number(db.prepare('SELECT body_bytes FROM sessions').get()?.body_bytes)
  const sum = () => ['bodies', 'turns', 'items'].reduce((total, table) => total + Number(db.prepare(`SELECT COALESCE(SUM(length(CAST(payload AS BLOB))),0) AS n FROM ${table}`).get()?.n), 0)
  assert.equal(measured(), sum())
  store.record({ ...original, turns: [turn('t1', [message('answer', 'short')])] })
  await store.flush()
  assert.equal(measured(), sum())
  index.promote(original.runtime, original.id)
  assert.equal(db.prepare('SELECT body FROM sessions').get()?.body, 'full')
  index.upsert(original, { origin: 'imported' })
  store.record(original)
  await store.flush()
  assert.equal(db.prepare('SELECT origin FROM sessions').get()?.origin, 'desk')
  assert.deepEqual(store.evictCached(0, () => false), { count: 0, bytes: 0 })
})

test('imported preview text stays out of desk full-text search until promotion', async t => {
  const { home, store } = await fixture(t)
  const index = new SessionIndex(join(home, 'sessions.sqlite'))
  t.after(() => index.close())
  const original = session([turn('t1', [message('answer', 'Synthetic preview search needle')])])
  index.upsert(original, { origin: 'imported' })
  await store.refresh(original, null)
  assert.equal((await store.search('search needle')).length, 0)
  index.promote(original.runtime, original.id)
  assert.equal((await store.search('search needle')).length, 1)
})
