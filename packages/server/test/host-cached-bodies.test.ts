import assert from 'node:assert/strict'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import { Host } from '../src/host.js'
import { StateStore } from '../src/state.js'
import { SessionIndex } from '../src/session-index.js'
import { DescriptorCache } from '../src/recovery-descriptor.js'
import { TranscriptStore } from '../src/transcripts.js'
import { FakeRuntime } from './fixtures/fake-runtime.js'
import { silent } from './fixtures/harness.js'
import { tempDir } from './scratch.js'

const options = (root: string, cap: number) => ({ logger: silent, state: new StateStore(join(root, 'state.json')),
  builtinAgents: join(root, 'agents'), libraryHome: join(root, 'library'), cachedBodyCapBytes: cap })

test('launch evicts old cached bodies above the configured cap while retaining full bodies', async t => {
  const root = tempDir('hd-cache-launch-')
  const index = new SessionIndex(join(root, 'sessions.sqlite'))
  index.close()
  const db = new DatabaseSync(join(root, 'sessions.sqlite'))
  t.after(() => db.close())
  db.exec("INSERT INTO sessions(runtime,id,origin,cwd,created_at,updated_at,body,body_bytes) VALUES('fake','old','imported','/synthetic',1,1,'cached',100),('fake','full','desk','/synthetic',1,1,'full',100)")
  const host = new Host(options(root, 50))
  t.after(() => host.dispose())
  assert.equal(db.prepare("SELECT body FROM sessions WHERE id='old'").get()?.body, 'none')
  assert.equal(db.prepare("SELECT body FROM sessions WHERE id='full'").get()?.body, 'full')
})

test('verified backup restores schedule debounced cache eviction without another write or restart', async t => {
  const root = tempDir('hd-cache-restore-')
  const host = new Host(options(root, 1))
  t.after(() => host.dispose())
  const runtime = new FakeRuntime({ capabilities: { archiveHistory: false } })
  host.register(runtime)
  await host.start()
  const backup = await host.call('backup/export', {})
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const report = await host.call('backup/import', { backup: { ...backup, transcripts: ['preview-one', 'preview-two', 'full'].map(id => ({
    runtime: runtime.info.id, id, data: { version: 1, runtime: runtime.info.id, id, savedAt: 10, cwd: root,
      origin: id === 'full' ? 'desk' : 'imported', lastOpenedAt: 100, turns: [{ id: 'turn', status: 'completed',
        items: [{ type: 'assistantMessage', id: 'answer', text: 'Synthetic restored cache body' }] }] },
  })) } })
  assert.deepEqual(report.transcripts, { restored: 3, skipped: 0 })
  const db = new DatabaseSync(join(root, 'sessions.sqlite'))
  t.after(() => db.close())
  const cached = () => Number(db.prepare("SELECT COUNT(*) AS n FROM sessions WHERE body='cached'").get()?.n)
  assert.equal(cached(), 2)
  t.mock.timers.tick(799)
  assert.equal(cached(), 2, 'restores use the existing debounce')
  t.mock.timers.tick(1)
  assert.equal(cached(), 0, 'restored cached bodies obey the cap while the host remains running')
  assert.equal(db.prepare("SELECT body FROM sessions WHERE id='full'").get()?.body, 'full')
  for (const table of ['bodies', 'turns', 'items']) {
    assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE id LIKE 'preview-%'`).get()?.n, 0, table)
  }
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM items_fts').get()?.n, 1, 'only the full body remains searchable')
  t.mock.timers.reset()
})

test('cached writes schedule eviction; opens update recency; clearCached skips a live preview', async t => {
  const root = tempDir('hd-cache-write-')
  const host = new Host(options(root, 1))
  t.after(() => host.dispose())
  const runtime = new FakeRuntime({ capabilities: { archiveHistory: false } })
  const external = await runtime.createSession({ cwd: root })
  runtime.stored.set(external.id, [{ id: 'turn' as import('@harnessdesk/protocol').TurnId, status: 'completed',
    items: [{ type: 'assistantMessage', id: 'answer' as import('@harnessdesk/protocol').ItemId, text: 'Synthetic cached body' }] }])
  host.register(runtime)
  await host.start()
  t.mock.timers.enable({ apis: ['setTimeout'] })
  await host.call('session/read', { runtime: runtime.info.id, sessionId: external.id })
  const db = new DatabaseSync(join(root, 'sessions.sqlite'))
  t.after(() => db.close())
  const row = () => db.prepare('SELECT * FROM sessions WHERE id=?').get(external.id)!
  assert.equal(row().body, 'cached')
  assert.equal(Number(row().last_opened_at), 0, 'a background read does not count as opened')
  await host.call('session/opened', { runtime: runtime.info.id, sessionId: external.id })
  assert.ok(Number(row().last_opened_at) > 0)
  t.mock.timers.tick(800)
  assert.equal(row().body, 'none')
  await host.call('session/resume', { runtime: runtime.info.id, sessionId: external.id })
  assert.equal(row().body, 'cached')
  assert.deepEqual(await host.call('history/clearCached', {}), { count: 0, bytes: 0 })
  await host.call('session/close', { runtime: runtime.info.id, sessionId: external.id })
  const cleared = await host.call('history/clearCached', {})
  assert.equal(cleared.count, 1)
  assert.ok(cleared.bytes > 0)
  assert.equal(row().body_bytes, 0)
  assert.equal(row().body, 'none')
  t.mock.timers.reset()
})

test('a missing preview body not evicted by this host remains protected', async t => {
  const root = tempDir('hd-cache-unowned-loss-')
  const host = new Host(options(root, 1_000_000))
  t.after(async () => { await host.dispose().catch(() => {}) })
  const runtime = new FakeRuntime({ capabilities: { archiveHistory: false } })
  const external = await runtime.createSession({ cwd: root })
  runtime.stored.set(external.id, [{ id: 'turn' as import('@harnessdesk/protocol').TurnId, status: 'completed',
    items: [{ type: 'assistantMessage', id: 'answer' as import('@harnessdesk/protocol').ItemId, text: 'Synthetic cached body' }] }])
  host.register(runtime); await host.start()
  await host.call('session/read', { runtime: runtime.info.id, sessionId: external.id })
  const record = host.registry.get(runtime.info.id, external.id)!
  assert.equal(record.session.itemsLoaded, false, 'the host has a released-body recovery descriptor')
  const db = new DatabaseSync(join(root, 'sessions.sqlite'))
  try {
    // This is not a Host cache eviction: make the verified base disappear
    // behind the host, and keep the descriptor as the only evidence of it.
    db.prepare('DELETE FROM items WHERE runtime=? AND id=?').run(runtime.info.id, external.id)
    db.prepare('DELETE FROM turns WHERE runtime=? AND id=?').run(runtime.info.id, external.id)
    db.prepare('DELETE FROM bodies WHERE runtime=? AND id=?').run(runtime.info.id, external.id)
    db.prepare("UPDATE sessions SET body='none',body_bytes=0 WHERE runtime=? AND id=?").run(runtime.info.id, external.id)
    await assert.rejects(host.call('session/resume', { runtime: runtime.info.id, sessionId: external.id }), (error: Error & { wireCode?: string }) => error.wireCode === 'historyUnavailable')
    assert.equal(record.transcriptIncomplete, true)
    assert.equal(db.prepare('SELECT 1 FROM bodies WHERE runtime=? AND id=?').get(runtime.info.id, external.id), undefined, 'no replay overwrote the unavailable base')
  } finally { db.close() }
})

test('cache eviction retires only the descriptor for the exact evicted preview', async t => {
  const root = tempDir('hd-cache-descriptor-owner-')
  const host = new Host(options(root, 1_000_000)); t.after(() => host.dispose())
  const runtime = new FakeRuntime({ capabilities: { archiveHistory: false } })
  const first = await runtime.createSession({ cwd: root }), second = await runtime.createSession({ cwd: root })
  for (const session of [first, second]) runtime.stored.set(session.id, [{ id: 'turn' as import('@harnessdesk/protocol').TurnId, status: 'completed',
    items: [{ type: 'assistantMessage', id: 'answer' as import('@harnessdesk/protocol').ItemId, text: 'Synthetic cached body' }] }])
  host.register(runtime); await host.start()
  for (const session of [first, second]) await host.call('session/read', { runtime: runtime.info.id, sessionId: session.id })
  const firstRecord = host.registry.get(runtime.info.id, first.id)!, secondRecord = host.registry.get(runtime.info.id, second.id)!
  assert.equal(firstRecord.session.itemsLoaded, false)
  await host.call('session/resume', { runtime: runtime.info.id, sessionId: second.id })
  assert.ok(secondRecord.live, 'the other preview is live and protected')
  const removed: string[] = [], remove = DescriptorCache.prototype.remove
  t.mock.method(DescriptorCache.prototype, 'remove', function (this: DescriptorCache, generation: string) { removed.push(generation); return remove.call(this, generation) })
  const cleared = await host.call('history/clearCached', {})
  assert.equal(cleared.count, 1)
  assert.deepEqual(removed, [firstRecord.bodyGeneration], 'only the evicted record loses its descriptor')
  const db = new DatabaseSync(join(root, 'sessions.sqlite'))
  try {
    assert.equal(db.prepare('SELECT body FROM sessions WHERE id=?').get(first.id)?.body, 'none')
    assert.equal(db.prepare('SELECT body FROM sessions WHERE id=?').get(second.id)?.body, 'cached')
  } finally { db.close() }
  await host.call('session/resume', { runtime: runtime.info.id, sessionId: first.id })
})

test('an overtaken cache eviction cannot retire a newer descriptor owner', async t => {
  const root = tempDir('hd-cache-descriptor-fence-')
  const host = new Host(options(root, 1_000_000)); t.after(async () => { await host.dispose().catch(() => {}) })
  const runtime = new FakeRuntime({ capabilities: { archiveHistory: false } }), external = await runtime.createSession({ cwd: root })
  runtime.stored.set(external.id, [{ id: 'turn' as import('@harnessdesk/protocol').TurnId, status: 'completed',
    items: [{ type: 'assistantMessage', id: 'answer' as import('@harnessdesk/protocol').ItemId, text: 'Synthetic cached body' }] }])
  host.register(runtime); await host.start()
  await host.call('session/read', { runtime: runtime.info.id, sessionId: external.id })
  const record = host.registry.get(runtime.info.id, external.id)!
  assert.equal(record.session.itemsLoaded, false)
  const removed: string[] = [], remove = DescriptorCache.prototype.remove
  t.mock.method(DescriptorCache.prototype, 'remove', function (this: DescriptorCache, generation: string) { removed.push(generation); return remove.call(this, generation) })
  const evict = TranscriptStore.prototype.evictCached
  t.mock.method(TranscriptStore.prototype, 'evictCached', function (this: TranscriptStore, ...args: Parameters<typeof evict>) {
    const [cap, live, evicted] = args
    return evict.call(this, cap, live, (runtime, id) => { record.invalidateBodyRevision(); evicted?.(runtime, id) })
  })
  assert.equal((await host.call('history/clearCached', {})).count, 1)
  assert.deepEqual(removed, [], 'a newer body revision keeps its descriptor')
  await assert.rejects(host.call('session/resume', { runtime: runtime.info.id, sessionId: external.id }), (error: Error & { wireCode?: string }) => error.wireCode === 'historyUnavailable')
  assert.equal(record.transcriptIncomplete, true)
})
