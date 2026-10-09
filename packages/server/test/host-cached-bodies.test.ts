import assert from 'node:assert/strict'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import { Host } from '../src/host.js'
import { StateStore } from '../src/state.js'
import { SessionIndex } from '../src/session-index.js'
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
