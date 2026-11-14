import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { itemId, turnId, type Session } from '@harnessdesk/protocol'
import { Host } from '../src/host.js'
import { StateStore } from '../src/state.js'
import { TranscriptStore } from '../src/transcripts.js'
import { TranscriptDatabase } from '../src/transcript-database.js'
import { FakeRuntime } from './fixtures/fake-runtime.js'
import { silent } from './fixtures/harness.js'

test('active same-ID replay keeps the person prompt', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'hd-active-replay-'))
  const runtime = new FakeRuntime(), host = new Host({ logger: silent, state: new StateStore(join(dir, 'state.json')), builtinAgents: dir, catalogRefreshMs: 0, idleStopMs: 0 })
  host.register(runtime); await host.start()
  t.after(async () => { await host.dispose().catch(() => {}); await rm(dir, { recursive: true, force: true }) })
  let store: TranscriptStore | undefined
  const record = TranscriptStore.prototype.record
  t.mock.method(TranscriptStore.prototype, 'record', function (this: TranscriptStore, ...args: Parameters<typeof record>) { store = this; return record.apply(this, args) })
  const session = await host.call('session/create', { runtime: runtime.info.id, options: { cwd: dir } }) as Session
  const original = { id: itemId('user'), type: 'userMessage' as const, content: [{ type: 'text' as const, text: 'person request' }] }
  const tid = turnId('one')
  runtime.emit({ type: 'turn/started', sessionId: session.id, turn: { id: tid, status: 'inProgress', items: [original] } })
  assert.ok(store); await store.flush()
  const held = host.registry.get(runtime.info.id, session.id)!
  assert.equal(held.running.has(tid), true)
  const changed = { ...original, content: [{ type: 'text' as const, text: 'different request' }] }
  runtime.emit({ type: 'session/started', session: { ...held.session, turns: [{ id: tid, status: 'inProgress', items: [changed] }] } })
  assert.deepEqual(held.session.turns[0]!.items[0], original)
  assert.equal(held.transcriptIncomplete, true, 'conflicting replay is protected')
  const db = new TranscriptDatabase(join(dir, 'sessions.sqlite'))
  try { assert.deepEqual(db.read(runtime.info.id, session.id)!.turns[0]!.items[0], original) } finally { db.close() }
})

for (const mode of ['assistant update', 'appended steer'] as const) test(`active replay accepts an ordinary ${mode}`, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'hd-active-compatible-'))
  const runtime = new FakeRuntime(), host = new Host({ logger: silent, state: new StateStore(join(dir, 'state.json')), builtinAgents: dir, catalogRefreshMs: 0, idleStopMs: 0 })
  host.register(runtime); await host.start()
  t.after(async () => { await host.dispose(); await rm(dir, { recursive: true, force: true }) })
  let store: TranscriptStore | undefined
  const record = TranscriptStore.prototype.record
  t.mock.method(TranscriptStore.prototype, 'record', function (this: TranscriptStore, ...args: Parameters<typeof record>) { store = this; return record.apply(this, args) })
  const session = await host.call('session/create', { runtime: runtime.info.id, options: { cwd: dir } }) as Session
  const user = { id: itemId('user'), type: 'userMessage' as const, content: [{ type: 'text' as const, text: 'person request' }] }
  const assistant = { id: itemId('answer'), type: 'assistantMessage' as const, text: 'first' }
  const tid = turnId('one')
  runtime.emit({ type: 'turn/started', sessionId: session.id, turn: { id: tid, status: 'inProgress', items: [user, assistant] } })
  assert.ok(store); await store.flush()
  const held = host.registry.get(runtime.info.id, session.id)!
  const updated = { ...assistant, text: 'first continued' }
  const steer = { id: itemId('steer'), type: 'userMessage' as const, content: [{ type: 'text' as const, text: 'extra direction' }] }
  const items = mode === 'appended steer' ? [user, updated, steer] : [user, updated]
  runtime.emit({ type: 'session/started', session: { ...held.session, turns: [{ id: tid, status: 'inProgress', items }] } })
  assert.equal(held.transcriptIncomplete, false, 'compatible active work is not quarantined')
  assert.deepEqual(held.session.turns[0]!.items, items)
})
