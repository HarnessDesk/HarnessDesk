import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { test, type TestContext } from 'node:test'
import { sessionId, turnId, itemId, type Session } from '@harnessdesk/protocol'
import { Host } from '../src/host.js'
import { StateStore } from '../src/state.js'
import { TranscriptStore } from '../src/transcripts.js'
import { SessionIndex } from '../src/session-index.js'
import { FakeRuntime } from './fixtures/fake-runtime.js'
import { silent } from './fixtures/harness.js'
import { tempDir } from './scratch.js'

const rig = async (t: TestContext) => {
  const root = tempDir('hd-remove-')
  const runtime = new FakeRuntime({ capabilities: { archiveHistory: false } })
  const id = sessionId('synthetic')
  const session: Session = { runtime: runtime.info.id, id, title: 'Check the synthetic cache', cwd: root,
    createdAt: 10, updatedAt: 20, status: { type: 'idle' }, itemsLoaded: true,
    usage: { total: { totalTokens: 5, inputTokens: 3, cachedInputTokens: 0, outputTokens: 2, reasoningOutputTokens: 0 }, last: { totalTokens: 5, inputTokens: 3, cachedInputTokens: 0, outputTokens: 2, reasoningOutputTokens: 0 } },
    turns: [{ id: turnId('turn'), status: 'completed', items: [{ id: itemId('answer'), type: 'assistantMessage', text: 'A retained synthetic answer' }] }] }
  const index = new SessionIndex(join(root, 'sessions.sqlite'))
  index.upsert(session)
  index.close()
  const transcripts = new TranscriptStore(join(root, 'transcripts'))
  transcripts.record(session, { now: true, insight: [{ turn: 'turn', startedAt: 10, endedAt: 20, seat: 'demo-seat', cause: { kind: 'person' }, parent: null, before: null, after: session.usage!, generation: '', observedAt: 20, loaded: null }] })
  await transcripts.close()
  const options = { state: new StateStore(join(root, 'state.json')), logger: silent,
    builtinAgents: join(root, 'agents'), libraryHome: join(root, 'library') }
  const host = new Host(options)
  host.register(runtime)
  await host.start()
  t.after(() => host.dispose())
  const db = new DatabaseSync(join(root, 'sessions.sqlite'))
  t.after(() => db.close())
  const body = () => ['bodies', 'turns', 'items'].map(table => Number(db.prepare(`SELECT count(*) AS n FROM ${table}`).get()?.n))
  const remove = (removed: boolean) => host.call('session/remove', { runtime: runtime.info.id, sessionId: id, removed })
  return { root, runtime, id, session, options, host, db, body, remove }
}

test('Remove hides only its row, leaves the agent files and body intact, and Undo restores every fact', async t => {
  const r = await rig(t)
  const agentFile = join(r.root, 'agent-store.json')
  await writeFile(agentFile, JSON.stringify({ synthetic: r.session }))
  r.runtime.deleteSession = async () => { await writeFile(agentFile, '{}'); return { disposition: 'trash', removed: 1 } }
  const before = await readFile(agentFile)
  const row = r.db.prepare('SELECT * FROM sessions').get()
  const body = r.db.prepare('SELECT * FROM bodies').get()
  const insight = r.db.prepare('SELECT insight FROM turns').get()
  await r.remove(true)
  assert.deepEqual((await r.host.call('session/index', {})).data, [])
  assert.deepEqual(r.body(), [1, 1, 1])
  assert.equal(r.db.prepare('SELECT origin FROM sessions').get()?.origin, 'imported')
  assert.ok(r.db.prepare('SELECT removed_at FROM sessions').get()?.removed_at)
  assert.deepEqual(await readFile(agentFile), before)
  assert.deepEqual(r.runtime.deleted, [])
  await r.remove(false)
  assert.deepEqual(r.db.prepare('SELECT * FROM sessions').get(), row)
  assert.deepEqual(r.db.prepare('SELECT * FROM bodies').get(), body)
  assert.deepEqual(r.db.prepare('SELECT insight FROM turns').get(), insight)
  assert.equal((await r.host.call('session/index', {})).data[0]?.id, r.id)
  assert.deepEqual(r.body(), [1, 1, 1])
})

test('the Undo-window sweep removes all body and search rows but keeps the removed index row', async t => {
  t.after(() => t.mock.timers.reset())
  const r = await rig(t)
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.now() })
  await r.remove(true)
  assert.ok(r.db.prepare('SELECT usage FROM sessions').get()?.usage)
  assert.ok(r.db.prepare('SELECT insight FROM turns').get()?.insight)
  t.mock.timers.tick(7_999)
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(r.body(), [1, 1, 1])
  t.mock.timers.tick(1)
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(r.body(), [0, 0, 0])
  assert.equal(r.db.prepare('SELECT count(*) AS n FROM items_fts WHERE items_fts MATCH ?').get('synthetic')?.n, 0)
  const row = r.db.prepare('SELECT * FROM sessions').get()!
  assert.equal(row.body, 'none')
  assert.equal(row.usage, null)
  assert.equal(row.saved_at, null)
  assert.equal((await r.host.call('session/index', {})).data.length, 0)
})

test('launch catches an expired removal whose timer never ran', async t => {
  const r = await rig(t)
  await r.remove(true)
  await r.host.dispose()
  r.db.prepare('UPDATE sessions SET removed_at=?').run(Date.now() - 60_000)
  const reopened = new Host({ ...r.options, state: new StateStore(join(r.root, 'state.json')) })
  reopened.register(r.runtime)
  t.after(() => reopened.dispose())
  await reopened.start()
  assert.deepEqual(r.body(), [0, 0, 0])
  assert.deepEqual((await reopened.call('session/index', {})).data, [])
})

test('Remove closes a running conversation before marking it, and never asks the agent to delete', async t => {
  const r = await rig(t)
  const live = await r.host.call('session/create', { runtime: r.runtime.info.id, options: { cwd: r.root } })
  const handle = r.runtime.sessions.get(String(live.id))!
  await handle.send([{ type: 'text', text: 'Synthetic active turn' }])
  let closed = false
  const close = handle.close.bind(handle)
  handle.close = async () => {
    assert.equal(r.db.prepare('SELECT removed_at FROM sessions WHERE id=?').get(live.id)?.removed_at, null)
    await close()
    closed = true
  }
  await r.host.call('session/remove', { runtime: r.runtime.info.id, sessionId: live.id, removed: true })
  assert.ok(closed)
  assert.equal(r.host.registry.get(r.runtime.info.id, live.id), undefined)
  assert.deepEqual(r.runtime.deleted, [])
})

test('Delete everywhere refuses an erasing runtime before asking it or changing our records', async t => {
  const r = await rig(t)
  Object.assign(r.runtime.info.capabilities, { deleteHistory: 'erase' })
  await assert.rejects(r.host.call('session/delete', { runtime: r.runtime.info.id, sessionId: r.id }), /Trash/)
  assert.deepEqual(r.runtime.deleted, [])
  assert.deepEqual(r.body(), [1, 1, 1])
  assert.equal((await r.host.call('session/index', {})).data.length, 1)
})

test('Delete everywhere drops index, body and FTS together only after the agent answers', async t => {
  const r = await rig(t)
  Object.assign(r.runtime.info.capabilities, { deleteHistory: 'trash' })
  r.runtime.deleteSession = async () => {
    assert.deepEqual(r.body(), [1, 1, 1])
    assert.equal(r.db.prepare('SELECT count(*) AS n FROM sessions').get()?.n, 1)
    return { disposition: 'trash', removed: 1 }
  }
  await r.host.call('session/delete', { runtime: r.runtime.info.id, sessionId: r.id })
  assert.equal(r.db.prepare('SELECT count(*) AS n FROM sessions').get()?.n, 0)
  assert.deepEqual(r.body(), [0, 0, 0])
  assert.equal(r.db.prepare('SELECT count(*) AS n FROM items_fts WHERE items_fts MATCH ?').get('synthetic')?.n, 0)
})


test('late agent events cannot bring a removed row or body back', async t => {
  const r = await rig(t)
  await r.remove(true)
  r.runtime.emit({ type: 'session/started', session: r.session })
  assert.equal(r.host.registry.get(r.runtime.info.id, r.id), undefined)
  assert.deepEqual((await r.host.call('session/index', {})).data, [])
})

test('Delete everywhere closes a running handle before the agent moves its record', async t => {
  const r = await rig(t)
  const session = await r.host.call('session/create', { runtime: r.runtime.info.id, options: { cwd: r.root } })
  const handle = r.runtime.sessions.get(String(session.id))!
  await handle.send([{ type: 'text', text: 'Synthetic running turn' }])
  r.runtime.deleteSession = async () => {
    assert.equal(r.host.registry.get(r.runtime.info.id, session.id)?.live, null)
    return { disposition: 'trash', removed: 1 }
  }
  await r.host.call('session/delete', { runtime: r.runtime.info.id, sessionId: session.id })
})

test('a failed database delete rolls body and index cleanup back together', async t => {
  const r = await rig(t)
  r.db.exec("CREATE TRIGGER refuse_body_delete BEFORE DELETE ON bodies BEGIN SELECT RAISE(ABORT,'synthetic cleanup refusal'); END")
  await assert.rejects(r.host.call('session/delete', { runtime: r.runtime.info.id, sessionId: r.id }), /synthetic cleanup refusal/)
  assert.deepEqual(r.body(), [1, 1, 1])
  assert.equal(r.db.prepare('SELECT count(*) AS n FROM sessions').get()?.n, 1)
  assert.equal(r.db.prepare('SELECT count(*) AS n FROM items_fts WHERE items_fts MATCH ?').get('synthetic')?.n, 1)
})

test('a newly created conversation can reuse a deleted id without reviving its old body', async t => {
  const r = await rig(t)
  const created = await r.host.call('session/create', { runtime: r.runtime.info.id, options: { cwd: r.root } })
  await r.host.call('session/delete', { runtime: r.runtime.info.id, sessionId: created.id })
  await r.host.dispose()
  const reopened = new Host({ ...r.options, state: new StateStore(join(r.root, 'state.json')) })
  reopened.register(new FakeRuntime())
  t.after(() => reopened.dispose())
  await reopened.start()
  const fresh = await reopened.call('session/create', { runtime: r.runtime.info.id, options: { cwd: r.root } })
  assert.equal(fresh.id, created.id)
  assert.ok((await reopened.call('session/index', {})).data.some(row => row.id === fresh.id))
  assert.deepEqual(fresh.turns, [])
})
