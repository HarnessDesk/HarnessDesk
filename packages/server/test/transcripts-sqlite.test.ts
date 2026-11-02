import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { test, type TestContext } from 'node:test'
import { canonicalTranscriptBody, runtimeId, sessionId, turnId, itemId, type AgentItem, type Session, type Turn } from '@harnessdesk/protocol'
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
const bodyIdentity = (value: Session): string => createHash('sha256').update(canonicalTranscriptBody(value.turns).canonical).digest('hex')
const storedIdentity = (home: string, value: Session): string => {
  const db = new TranscriptDatabase(join(home, 'sessions.sqlite'))
  try { const stored = db.read(value.runtime, value.id); assert.ok(stored); return db.stateIdentity(stored, value.runtime, value.id) } finally { db.close() }
}
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

test('backup restore keeps previews imported, cached and evictable without changing local desk origin', async t => {
  const { home, store } = await fixture(t)
  const preview = session([turn('t1', [message('answer', 'Synthetic preview needle')])], 'preview')
  const index = new SessionIndex(join(home, 'sessions.sqlite'))
  t.after(() => index.close())
  index.upsert(preview, { origin: 'imported' })
  index.opened(preview.runtime, preview.id)
  store.record(preview)
  await store.flush()
  const exported = await store.exportAll()
  const { home: freshHome, store: fresh } = await fixture(t)
  for (const row of exported) assert.equal(await fresh.importOne(row.runtime, row.id, row.data), 'restored')
  const freshIndex = new SessionIndex(join(freshHome, 'sessions.sqlite'))
  t.after(() => freshIndex.close())
  assert.deepEqual(freshIndex.list().data, [], 'restore must not adopt a preview')
  assert.equal(freshIndex.history().data[0]?.id, preview.id)
  const originalDb = new DatabaseSync(join(home, 'sessions.sqlite'), { readOnly: true })
  const restoredDb = new DatabaseSync(join(freshHome, 'sessions.sqlite'), { readOnly: true })
  t.after(() => { originalDb.close(); restoredDb.close() })
  assert.deepEqual(restoredDb.prepare('SELECT origin,body,last_opened_at FROM sessions').get(), originalDb.prepare('SELECT origin,body,last_opened_at FROM sessions').get())
  assert.equal(fresh.evictCached(0, () => false).count, 1)
  assert.equal(restoredDb.prepare("SELECT body FROM sessions WHERE id='preview'").get()?.body, 'none')
  assert.equal((await fresh.search('preview needle')).length, 0)
  // Importing newer preview data on a desk that already adopted it cannot demote it.
  const { home: localHome, store: local } = await fixture(t)
  const localIndex = new SessionIndex(join(localHome, 'sessions.sqlite'))
  t.after(() => localIndex.close())
  localIndex.upsert(preview)
  assert.equal(await local.importOne(exported[0]!.runtime, exported[0]!.id, exported[0]!.data), 'restored')
  assert.equal(localIndex.list().data[0]?.id, preview.id)
  assert.equal(local.evictCached(0, () => false).count, 0)
  index.promote(preview.runtime, preview.id)
  const promoted = await store.exportAll()
  const { home: promotedHome, store: adopted } = await fixture(t)
  for (const row of promoted) assert.equal(await adopted.importOne(row.runtime, row.id, row.data), 'restored')
  const promotedIndex = new SessionIndex(join(promotedHome, 'sessions.sqlite'))
  t.after(() => promotedIndex.close())
  assert.equal(promotedIndex.list().data[0]?.id, preview.id)
  assert.equal(adopted.evictCached(0, () => false).count, 0)
})

test('restore fills metadata-only opening times and retains newer local recency for cache eviction', async t => {
  const { home, store, db } = await fixture(t)
  const index = new SessionIndex(join(home, 'sessions.sqlite'))
  t.after(() => index.close())
  const recent = session([turn('t', [message('m', 'Recent preview')])], 'a-recent')
  const old = session([turn('t', [message('m', 'Old preview')])], 'z-old')
  index.importPage([recent, old], () => false)
  const database = db()
  t.after(() => database.close())
  const opening = (id: string) => database.prepare('SELECT last_opened_at FROM sessions WHERE id=?').get(id)?.last_opened_at
  assert.equal(opening(recent.id), null)
  assert.equal(await store.importOne(recent.runtime, recent.id, { version: 1, ...recent, savedAt: 10, origin: 'imported', lastOpenedAt: 200 }), 'restored')
  assert.equal(opening(recent.id), 200, 'NULL metadata must accept the restored opening time')
  assert.equal(await store.importOne(recent.runtime, recent.id, { version: 1, ...recent, savedAt: 20, origin: 'imported', lastOpenedAt: 100 }), 'restored')
  assert.equal(opening(recent.id), 200, 'an older restore must retain local recency')
  assert.equal(await store.importOne(old.runtime, old.id, { version: 1, ...old, savedAt: 10, origin: 'imported', lastOpenedAt: 100 }), 'restored')
  const oldBytes = Number(database.prepare('SELECT body_bytes FROM sessions WHERE id=?').get(old.id)?.body_bytes)
  const total = Number(database.prepare("SELECT SUM(body_bytes) AS n FROM sessions WHERE body='cached'").get()?.n)
  assert.deepEqual(store.evictCached(total - oldBytes, () => false), { count: 1, bytes: oldBytes })
  assert.equal(await store.recover(old.runtime, old.id), null)
  assert.equal((await store.recover(recent.runtime, recent.id))?.id, recent.id)
})

test('restore notifies only after verification, so immediate cache eviction cannot refuse a successful restore', async t => {
  const home = await mkdtemp(join(tmpdir(), 'hd-restore-notification-'))
  let writes = 0
  const store = new TranscriptStore(join(home, 'transcripts'), undefined, () => {
    writes++
    store.evictCached(0, () => false)
  })
  t.after(async () => { await store.close(); await rm(home, { recursive: true, force: true }) })
  const preview = session([turn('t', [message('m', 'Synthetic restored preview')])])
  const incoming = { version: 1, ...preview, savedAt: 10, origin: 'imported' }
  assert.equal(await store.importOne(preview.runtime, preview.id, incoming), 'restored')
  assert.equal(writes, 1)
  assert.equal(await store.recover(preview.runtime, preview.id), null, 'the callback can evict the verified body')
  const full = { version: 1, ...preview, id: 'full', savedAt: 10 }
  assert.equal(await store.importOne(preview.runtime, 'full', full), 'restored')
  assert.equal(writes, 2)
  assert.equal(await store.importOne(preview.runtime, 'full', full), 'skipped')
  assert.equal(await store.importOne(preview.runtime, 'invalid', {}), 'refused')
  const database = new DatabaseSync(join(home, 'sessions.sqlite'))
  try {
    database.exec("CREATE TRIGGER lose_restored_body AFTER INSERT ON bodies WHEN new.id='unverified' BEGIN DELETE FROM bodies WHERE runtime=new.runtime AND id=new.id; END")
    assert.equal(await store.importOne(preview.runtime, 'unverified', { ...incoming, id: 'unverified' }), 'refused')
    assert.equal(writes, 2, 'skipped, invalid and unverified restores do not notify')
  } finally { database.close() }
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

test('exact body persistence verifies the SQLite readback before reporting success', async t => {
  const { home, store } = await fixture(t)
  const candidate = session([turn('verified', [message('answer', 'body to keep')])])
  const api = store as unknown as { persistExactBody?: (host: Session, candidate: Session) => Promise<boolean> }
  assert.equal(typeof api.persistExactBody, 'function', 'exact persistence verification is available')
  assert.equal(await api.persistExactBody!(candidate, candidate), true)
  const independentlyOpened = new TranscriptDatabase(join(home, 'sessions.sqlite'))
  try { assert.deepEqual(independentlyOpened.read(candidate.runtime, candidate.id)?.turns, candidate.turns) }
  finally { independentlyOpened.close() }
})

test('exact body persistence refuses a richer renderer and a lost SQLite write', async t => {
  const { home, store } = await fixture(t)
  const host = session([turn('verified', [message('answer', 'host body')])])
  const renderer = session([turn('verified', [message('answer', 'host body'), message('newer', 'renderer only')])])
  const api = store as unknown as { persistExactBody?: (host: Session, candidate: Session) => Promise<boolean> }
  assert.equal(typeof api.persistExactBody, 'function', 'exact persistence verification is available')
  assert.equal(await api.persistExactBody!(host, renderer), false)
  await store.readSummary(host.runtime, host.id) // Initialize the real database before installing the fault.
  const database = new DatabaseSync(join(home, 'sessions.sqlite'))
  try {
    database.exec("CREATE TRIGGER lose_exact_body AFTER INSERT ON bodies BEGIN DELETE FROM bodies WHERE runtime=new.runtime AND id=new.id; END")
    assert.equal(await api.persistExactBody!(host, host), false, 'a successful SQL write without readback cannot verify a body')
  } finally { database.close() }
})

test('exact body persistence never overwrites a richer stored body', async t => {
  const { home, store } = await fixture(t)
  const richer = session([turn('verified', [message('one', 'stored'), message('two', 'also stored')])])
  const smaller = session([turn('verified', [message('one', 'stored')])])
  store.record(richer)
  await store.flush()
  const api = store as unknown as { persistExactBody: (host: Session, candidate: Session) => Promise<boolean> }
  assert.equal(await api.persistExactBody(smaller, smaller), false)
  const database = new TranscriptDatabase(join(home, 'sessions.sqlite'))
  try { assert.deepEqual(database.read(richer.runtime, richer.id)?.turns, richer.turns) }
  finally { database.close() }
})

test('exact body persistence refuses while a transcript write is pending', async t => {
  const { store } = await fixture(t)
  const body = session([turn('pending', [message('one', 'pending event')])])
  store.record(body)
  const api = store as unknown as { persistExactBody: (host: Session, candidate: Session) => Promise<boolean> }
  assert.equal(await api.persistExactBody(body, body), false, 'pending writes must not be turned into a receipt')
})

test('SQLite body CAS permits known evolution and refuses external changes or unexpected presence', async t => {
  const { home, store } = await fixture(t)
  const first = session([turn('one', [message('answer', 'initial')])])
  const next = session([turn('one', [message('answer', 'initial and more')])])
  const external = session([turn('one', [message('answer', 'external richer body')])])
  const db = new TranscriptDatabase(join(home, 'sessions.sqlite'))
  t.after(() => db.close())
  const stored = (value: Session) => ({ version: 1 as const, runtime: value.runtime, id: value.id, savedAt: 1, turns: value.turns })
  const write = (value: Session, expectedBase: { kind: 'missing' } | { kind: 'body'; identity: string }) =>
    db.write(stored(value), value.runtime, value.id, { expectedBase })
  write(first, { kind: 'missing' })
  assert.throws(() => write(next, { kind: 'missing' }), /base/i)
  write(next, { kind: 'body', identity: db.stateIdentity(db.read(first.runtime, first.id)!, first.runtime, first.id) })
  assert.deepEqual(db.read(next.runtime, next.id)?.turns, next.turns)
  db.write(stored(external), external.runtime, external.id)
  assert.throws(() => write(first, { kind: 'body', identity: bodyIdentity(next) }), /base/i)
  assert.deepEqual(db.read(external.runtime, external.id)?.turns, external.turns)
  const index = new SessionIndex(join(home, 'sessions.sqlite'))
  try {
    index.remove(external.runtime, external.id)
    assert.throws(() => write(first, { kind: 'body', identity: db.stateIdentity(db.read(external.runtime, external.id)!, external.runtime, external.id) }), /removed/i)
  } finally { index.close() }
  void store
})

test('evolved body persistence verifies the new readback and preserves a mismatched base', async t => {
  const { home, store } = await fixture(t)
  const first = session([turn('one', [message('answer', 'initial')])])
  const next = session([turn('one', [message('answer', 'initial and more')])])
  const api = store as unknown as { persistEvolvedBody?: (body: Session, base: { kind: 'missing' } | { kind: 'body'; identity: string }) => Promise<boolean> }
  assert.equal(typeof api.persistEvolvedBody, 'function')
  assert.equal(await api.persistEvolvedBody!(first, { kind: 'missing' }), true)
  assert.equal(await api.persistEvolvedBody!(next, { kind: 'missing' }), false)
  assert.equal(await api.persistEvolvedBody!(next, { kind: 'body', identity: storedIdentity(home, first) }), true)
  const db = new TranscriptDatabase(join(home, 'sessions.sqlite'))
  try { assert.deepEqual(db.read(next.runtime, next.id)?.turns, next.turns) } finally { db.close() }
  const broken = session([turn('lost', [message('answer', 'not durable')])], 'lost')
  const fault = new DatabaseSync(join(home, 'sessions.sqlite'))
  try {
    fault.exec("CREATE TRIGGER lose_evolved_body AFTER INSERT ON bodies WHEN new.id='lost' BEGIN DELETE FROM bodies WHERE runtime=new.runtime AND id=new.id; END")
    assert.equal(await api.persistEvolvedBody!(broken, { kind: 'missing' }), false)
  } finally { fault.close() }
  const cleanup = new DatabaseSync(join(home, 'sessions.sqlite'))
  try { cleanup.exec('DROP TRIGGER lose_evolved_body') } finally { cleanup.close() }
  assert.equal(await api.persistEvolvedBody!(broken, { kind: 'missing' }), true)
})

test('evolved persistence does not issue a receipt when a newer event write arrives', async t => {
  const { home, store } = await fixture(t)
  const first = session([turn('one', [message('answer', 'initial')])])
  const next = session([turn('one', [message('answer', 'initial and more')])])
  const writing = store.persistEvolvedBody(first, { kind: 'missing' })
  store.record(next)
  assert.equal(await writing, false)
  const db = new TranscriptDatabase(join(home, 'sessions.sqlite'))
  try { assert.deepEqual(db.read(first.runtime, first.id)?.turns, first.turns) } finally { db.close() }
  assert.equal(await store.retryProtectedBody(next, { kind: 'body', identity: storedIdentity(home, first) }), true)
})

test('a failed base comparison cannot be bypassed by a later settle or shutdown flush', async t => {
  const { home, store } = await fixture(t)
  const saved = session([turn('one', [message('answer', 'durable prior body')])])
  const newer = session([turn('one', [message('answer', 'new protected data')])])
  assert.equal(await store.persistEvolvedBody(saved, { kind: 'missing' }), true)
  assert.equal(await store.persistEvolvedBody(newer, { kind: 'missing' }), false)
  store.record(newer)
  await assert.rejects(store.flush(), /protected/i)
  await assert.rejects(store.readSummary(saved.runtime, saved.id), /protected/i)
  assert.equal(await store.persistEvolvedBody(newer, { kind: 'body', identity: storedIdentity(home, saved) }), false, 'flush retains the protected pending write')
  const db = new TranscriptDatabase(join(home, 'sessions.sqlite'))
  try { assert.deepEqual(db.read(saved.runtime, saved.id)?.turns, saved.turns) } finally { db.close() }
  const api = store as unknown as { retryProtectedBody?: (body: Session, base: { kind: 'body'; identity: string }) => Promise<boolean> }
  assert.equal(typeof api.retryProtectedBody, 'function')
  assert.equal(await api.retryProtectedBody!({ ...newer, title: 'different metadata' }, { kind: 'body', identity: storedIdentity(home, saved) }), false, 'matching turns cannot discard pending session metadata')
  assert.equal(await api.retryProtectedBody!(newer, { kind: 'body', identity: bodyIdentity(newer) }), false)
  assert.equal(store.protectedPressure().bodies, 1, 'a refused retry keeps its pending body')
  assert.equal(await api.retryProtectedBody!(newer, { kind: 'body', identity: storedIdentity(home, saved) }), true)
  assert.equal(store.protectedPressure().bodies, 0)
  const verified = new TranscriptDatabase(join(home, 'sessions.sqlite'))
  try { assert.deepEqual(verified.read(newer.runtime, newer.id)?.turns, newer.turns) } finally { verified.close() }
})

test('conflict protection retains owned pending bodies and refuses flush', async t => {
  const { store } = await fixture(t)
  const body = session([turn('one', [message('answer', 'unsaved')])])
  store.record(body, { generation: 'generation-one', authorityEpoch: 4 })
  assert.equal(store.protectPending(body.runtime, body.id, 'generation-one', 5), false)
  assert.equal(store.protectPending(body.runtime, body.id, 'generation-one', 4), true)
  assert.deepEqual(store.pendingBodies(body.runtime, body.id, 'generation-one', 4), [body])
  assert.equal(store.pendingBodies(body.runtime, body.id, 'generation-two', 4).length, 0)
  await assert.rejects(store.flush(), /protected/i)
  await store.forget(body.runtime, body.id)
})

test('replay conflict detection compares unsaved items only for the owning record', async t => {
  const { store } = await fixture(t)
  const body = session([turn('one', [message('answer', 'unsaved')])])
  const stale = session([turn('one', [message('answer', 'stale')])])
  store.record(body, { generation: 'generation-one', authorityEpoch: 4 })
  assert.equal(store.pendingReplayConflict(body, 'generation-one', 4), false)
  assert.equal(store.pendingReplayConflict(stale, 'generation-one', 4), true)
  assert.equal(store.pendingReplayConflict(stale, 'generation-two', 4), false)
  assert.equal(store.pendingReplayConflict(stale, 'generation-one', 5), false)
  assert.equal(store.pendingReplayConflict({ ...stale, itemsLoaded: false }, 'generation-one', 4), false)
  store.record(session([turn('one', [message('answer', 'first'), message('answer', 'stale')])]),
    { generation: 'generation-one', authorityEpoch: 4 })
  assert.equal(store.pendingReplayConflict(stale, 'generation-one', 4), true, 'duplicate IDs cannot hide a differing earlier item')
  await store.forget(body.runtime, body.id)
})

test('pending turn protection is fenced to its record generation and authority epoch', async t => {
  const { store } = await fixture(t)
  const body = session([turn('one', [message('answer', 'unsaved')])])
  store.record(body, { generation: 'generation-one', authorityEpoch: 4 })
  assert.deepEqual([...store.pendingTurnIds(body.runtime, body.id, 'generation-one', 4)], ['one'])
  assert.equal(store.pendingTurnIds(body.runtime, body.id, 'generation-two', 4).size, 0)
  assert.equal(store.pendingTurnIds(body.runtime, body.id, 'generation-one', 5).size, 0)
  await store.forget(body.runtime, body.id)
  assert.equal(store.pendingTurnIds(body.runtime, body.id, 'generation-one', 4).size, 0)
})

test('a new event during a protected retry keeps both pending snapshots protected', async t => {
  const home = await mkdtemp(join(tmpdir(), 'hd-sqlite-protected-retry-'))
  let inject = false
  const first = session([turn('one', [message('answer', 'first')])])
  const pending = session([turn('one', [message('answer', 'first update')])])
  const later = session([turn('one', [message('answer', 'first update and later')])])
  const store = new TranscriptStore(join(home, 'transcripts'), () => {}, () => { if (inject) { inject = false; store.record(later) } })
  t.after(async () => { await store.close(); await rm(home, { recursive: true, force: true }) })
  assert.equal(await store.persistEvolvedBody(first, { kind: 'missing' }), true)
  assert.equal(await store.persistEvolvedBody(pending, { kind: 'missing' }), false)
  store.record(pending)
  inject = true
  assert.equal(await store.retryProtectedBody(pending, { kind: 'body', identity: storedIdentity(home, first) }), false)
  const api = store as unknown as { protectedPressure?: () => { bodies: number; bytes: number } }
  assert.equal(typeof api.protectedPressure, 'function')
  const pressure = api.protectedPressure!()
  assert.equal(pressure.bodies, 2)
  assert.ok(pressure.bytes >= canonicalTranscriptBody(pending.turns).bytes + canonicalTranscriptBody(later.turns).bytes)
  await assert.rejects(store.flush(), /protected/i)
  await store.forget(first.runtime, first.id)
})

test('a generation-owned queued write compares its observed durable base before replacing it', async t => {
  const { home, store } = await fixture(t)
  const first = session([turn('one', [message('answer', 'first')])])
  const later = session([turn('one', [message('answer', 'later')])])
  const external = session([turn('one', [message('answer', 'external')])])
  const api = store as unknown as { bindBase?: (session: Session, generation: string, base: { kind: 'missing' }) => void }
  assert.equal(typeof api.bindBase, 'function')
  api.bindBase!(first, 'generation-one', { kind: 'missing' })
  store.record(first, { generation: 'generation-one' })
  await store.flush()
  const db = new TranscriptDatabase(join(home, 'sessions.sqlite'))
  try {
    db.write({ version: 1, runtime: external.runtime, id: external.id, savedAt: 1, turns: external.turns })
    store.record(later, { generation: 'generation-one' })
    await assert.rejects(store.flush(), /protected/i)
    assert.deepEqual(db.read(external.runtime, external.id)?.turns, external.turns)
    assert.equal(store.protectedPressure().bodies, 1)
  } finally { db.close(); await store.forget(first.runtime, first.id) }
})

test('a generation-owned event arriving during a write is saved after the verified base advances', async t => {
  const home = await mkdtemp(join(tmpdir(), 'hd-sqlite-queued-interleave-'))
  const first = session([turn('one', [message('answer', 'first')])])
  const later = session([turn('one', [message('answer', 'first and later')])])
  let inject = true
  const store = new TranscriptStore(join(home, 'transcripts'), () => {}, () => { if (inject) { inject = false; store.record(later, { generation: 'g' }) } })
  t.after(async () => { await store.close(); await rm(home, { recursive: true, force: true }) })
  store.bindBase(first, 'g', { kind: 'missing' })
  store.record(first, { generation: 'g' })
  await store.flush()
  await store.flush()
  const db = new TranscriptDatabase(join(home, 'sessions.sqlite'))
  try { assert.deepEqual(db.read(first.runtime, first.id)?.turns, later.turns) } finally { db.close() }
})

test('a record replaced during a queued write cannot advance the old generation authority', async t => {
  const home = await mkdtemp(join(tmpdir(), 'hd-sqlite-stale-generation-'))
  const first = session([turn('one', [message('answer', 'first')])])
  let current = true, advanced = 0
  const store = new TranscriptStore(join(home, 'transcripts'), () => {}, () => { current = false }, () => current, () => { advanced++ })
  t.after(async () => { await store.close(); await rm(home, { recursive: true, force: true }) })
  store.bindBase(first, 'old', { kind: 'missing' })
  store.record(first, { generation: 'old' })
  await assert.rejects(store.flush(), /protected/i)
  assert.equal(advanced, 0)
  assert.equal(store.protectedPressure().bodies, 1)
  await store.forget(first.runtime, first.id)
})

test('overlapping flush and read wait for the same healthy generation-owned write', async t => {
  const { store } = await fixture(t)
  const body = session([turn('one', [message('answer', 'body')])])
  store.bindBase(body, 'g', { kind: 'missing' })
  store.record(body, { generation: 'g' })
  const [, summary] = await Promise.all([store.flush(), store.readSummary(body.runtime, body.id)])
  assert.ok(summary)
  assert.equal(store.protectedPressure().bodies, 0)
})

test('base authority is released only for its matching generation after pending work settles', async t => {
  const { store } = await fixture(t)
  const body = session([turn('one', [message('answer', 'body')])])
  store.bindBase(body, 'old', { kind: 'missing' })
  store.record(body, { generation: 'old' })
  store.unbindBase(body, 'old') // Pending data still needs this base.
  store.unbindBase(body, 'different')
  await store.flush()
  store.unbindBase(body, 'old')
  store.record(body, { generation: 'old' })
  await assert.rejects(store.flush(), /authority/i)
  assert.equal(store.protectedPressure().bodies, 1)
  await store.forget(body.runtime, body.id)
})

test('a source refresh cannot overwrite a durable body changed after enrichment', async t => {
  const { home, store } = await fixture(t)
  const original = session([turn('one', [message('answer', 'original')])])
  const source = session([turn('one', [message('answer', 'source update')])])
  const external = session([turn('one', [message('external', 'different stored body')])])
  assert.equal(await store.persistEvolvedBody(original, { kind: 'missing' }), true)
  const enriched = await store.enrichForRefresh(source)
  const db = new TranscriptDatabase(join(home, 'sessions.sqlite'))
  try {
    db.write({ version: 1, runtime: external.runtime, id: external.id, savedAt: 1, turns: external.turns })
    await assert.rejects(store.refresh(enriched.session, null, enriched.base), /protected|changed/i)
    assert.deepEqual(db.read(external.runtime, external.id)?.turns, external.turns)
    assert.equal(store.protectedPressure().bodies, 1)
  } finally { db.close(); await store.forget(original.runtime, original.id) }
})

test('overlapping enriched reads cannot borrow a newer read observation', async t => {
  const { home, store } = await fixture(t)
  const first = session([turn('one', [message('answer', 'first')])])
  const newer = session([turn('one', [message('newer', 'newer')])])
  assert.equal(await store.persistEvolvedBody(first, { kind: 'missing' }), true)
  const oldRead = await store.enrichForRefresh(first)
  const db = new TranscriptDatabase(join(home, 'sessions.sqlite'))
  try {
    db.write({ version: 1, runtime: newer.runtime, id: newer.id, savedAt: 1, turns: newer.turns })
    const newRead = await store.enrichForRefresh(newer)
    await store.refresh(newRead.session, null, newRead.base)
    await assert.rejects(store.refresh(oldRead.session, null, oldRead.base), /protected|changed/i)
    assert.deepEqual(db.read(newer.runtime, newer.id)?.turns, newRead.session.turns)
  } finally { db.close(); await store.forget(first.runtime, first.id) }
})

test('equal turns with changed durable metadata cannot be overwritten by an older refresh', async t => {
  const { home, store } = await fixture(t)
  const original = session([turn('one', [message('answer', 'same body')])])
  assert.equal(await store.persistEvolvedBody(original, { kind: 'missing' }), true)
  const oldRead = await store.enrichForRefresh(original)
  const db = new TranscriptDatabase(join(home, 'sessions.sqlite'))
  try {
    db.write({ version: 1, runtime: original.runtime, id: original.id, savedAt: 1, turns: original.turns, title: 'newer stored title' })
    await assert.rejects(store.refresh(oldRead.session, null, oldRead.base), /protected|changed/i)
    assert.equal(db.read(original.runtime, original.id)?.title, 'newer stored title')
    assert.equal(store.protectedPressure().bodies, 1)
  } finally { db.close(); await store.forget(original.runtime, original.id) }
})

test('equal turns with new durable Insight cannot be overwritten by an older refresh', async t => {
  const { home, store } = await fixture(t)
  const original = session([turn('one', [message('answer', 'same body')])])
  assert.equal(await store.persistEvolvedBody(original, { kind: 'missing' }), true)
  const oldRead = await store.enrichForRefresh(original)
  const db = new TranscriptDatabase(join(home, 'sessions.sqlite'))
  try {
    const stored = db.read(original.runtime, original.id); assert.ok(stored)
    const insight = [{ turn: 'one', startedAt: 1, endedAt: 2, seat: 'synthetic', cause: { kind: 'person' as const },
      parent: null, before: null, after: null, generation: '', observedAt: 2, loaded: null }]
    db.write({ ...stored, insight })
    await assert.rejects(store.refresh(oldRead.session, null, oldRead.base), /protected|changed/i)
    assert.deepEqual(db.read(original.runtime, original.id)?.insight, insight)
  } finally { db.close(); await store.forget(original.runtime, original.id) }
})

test('a refresh cannot overwrite a source fingerprint changed after its read', async t => {
  const { home, store } = await fixture(t)
  const original = session([turn('one', [message('answer', 'body')])])
  await store.refresh(original, { path: '/synthetic/source', mtimeMs: 1, size: 1 })
  const oldRead = await store.enrichForRefresh(original)
  const db = new DatabaseSync(join(home, 'sessions.sqlite'))
  try {
    db.prepare('UPDATE sessions SET source_mtime=? WHERE runtime=? AND id=?').run(2, original.runtime, original.id)
    await assert.rejects(store.refresh(oldRead.session, { path: '/synthetic/source', mtimeMs: 3, size: 1 }, oldRead.base), /protected|changed/i)
    assert.equal(db.prepare('SELECT source_mtime FROM sessions WHERE runtime=? AND id=?').get(original.runtime, original.id)?.source_mtime, 2)
  } finally { db.close(); await store.forget(original.runtime, original.id) }
})

test('exact verification does not change the semantic identity of sparse legacy facts', async t => {
  const { home, store } = await fixture(t)
  const original = { ...session([turn('one', [message('answer', 'body')])]), title: null, preview: null }
  const db = new TranscriptDatabase(join(home, 'sessions.sqlite'))
  try { db.write({ version: 1, runtime: original.runtime, id: original.id, savedAt: 1, cwd: original.cwd,
    createdAt: original.createdAt, updatedAt: original.updatedAt, turns: original.turns }) } finally { db.close() }
  const base = storedIdentity(home, original)
  assert.equal(await store.persistExactBody(original, original), true)
  assert.equal(storedIdentity(home, original), base)
})

test('exact verification preserves a source fingerprint when it adds no source work', async t => {
  const { home, store } = await fixture(t)
  const original = session([turn('one', [message('answer', 'body')])])
  const source = { path: '/synthetic/source', mtimeMs: 1, size: 1 }
  await store.refresh(original, source)
  const base = storedIdentity(home, original)
  assert.equal(await store.persistExactBody(original, original), true)
  assert.deepEqual(await store.source(original.runtime, original.id), source)
  assert.equal(storedIdentity(home, original), base)
})

test('a refresh observation keeps body and source in one SQLite snapshot', async t => {
  const { home, store } = await fixture(t)
  const original = session([turn('one', [message('answer', 'body')])])
  await store.refresh(original, { path: '/synthetic/source', mtimeMs: 1, size: 1 })
  const originalRead = TranscriptDatabase.prototype.read
  let inject = true
  t.mock.method(TranscriptDatabase.prototype, 'read', function(this: TranscriptDatabase, ...args: Parameters<typeof originalRead>) {
    const result = originalRead.apply(this, args)
    if (inject && result) {
      inject = false
      const other = new DatabaseSync(join(home, 'sessions.sqlite'))
      try { other.prepare('UPDATE sessions SET source_mtime=? WHERE runtime=? AND id=?').run(2, original.runtime, original.id) }
      finally { other.close() }
    }
    return result
  })
  const observed = await store.enrichForRefresh(original)
  await assert.rejects(store.refresh(observed.session, { path: '/synthetic/source', mtimeMs: 3, size: 1 }, observed.base), /protected|changed/i)
  await store.forget(original.runtime, original.id)
})

test('an import cannot overwrite a durable row changed after its version check', async t => {
  const { home, store } = await fixture(t)
  const original = session([turn('one', [message('answer', 'original')])])
  assert.equal(await store.persistEvolvedBody(original, { kind: 'missing' }), true)
  const originalWrite = TranscriptDatabase.prototype.write
  let inject = true
  t.mock.method(TranscriptDatabase.prototype, 'write', function(this: TranscriptDatabase, ...args: Parameters<typeof originalWrite>) {
    if (inject) {
      inject = false
      const other = new TranscriptDatabase(join(home, 'sessions.sqlite'))
      try { const prior = other.read(original.runtime, original.id); assert.ok(prior); originalWrite.call(other, { ...prior, title: 'external newer' }) } finally { other.close() }
    }
    return originalWrite.apply(this, args)
  })
  const result = await store.importOne(original.runtime, original.id, { version: 1, runtime: original.runtime, id: original.id,
    savedAt: Date.now() + 100_000, turns: [turn('one', [message('answer', 'imported')])] })
  assert.equal(result, 'refused')
  const db = new TranscriptDatabase(join(home, 'sessions.sqlite'))
  try { assert.equal(db.read(original.runtime, original.id)?.title, 'external newer') } finally { db.close() }
})
