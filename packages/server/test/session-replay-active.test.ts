import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { itemId, sessionId, turnId, type Session } from '@harnessdesk/protocol'
import { Host } from '../src/host.js'
import { StateStore } from '../src/state.js'
import { TranscriptStore } from '../src/transcripts.js'
import { TranscriptDatabase } from '../src/transcript-database.js'
import { FakeRuntime, FakeSession } from './fixtures/fake-runtime.js'
import { conflictsWithRunningPrompt } from '../src/reconcile-prose.js'
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

for (const turnIdentity of ['same turn', 'new turn'] as const) for (const textIdentity of ['same text', 'changed text'] as const) test(`active replay with ${turnIdentity} and regenerated person ID preserves the original for ${textIdentity}`, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'hd-active-replay-identity-'))
  const runtime = new FakeRuntime(), host = new Host({ logger: silent, state: new StateStore(join(dir, 'state.json')), builtinAgents: dir, catalogRefreshMs: 0, idleStopMs: 0 })
  host.register(runtime); await host.start()
  t.after(async () => { await host.dispose().catch(() => {}); await rm(dir, { recursive: true, force: true }) })
  let store: TranscriptStore | undefined
  const record = TranscriptStore.prototype.record
  t.mock.method(TranscriptStore.prototype, 'record', function (this: TranscriptStore, ...args: Parameters<typeof record>) { store = this; return record.apply(this, args) })
  const session = await host.call('session/create', { runtime: runtime.info.id, options: { cwd: dir } }) as Session
  const original = { id: itemId('original-user'), type: 'userMessage' as const, content: [{ type: 'text' as const, text: 'person request' }] }
  const tid = turnId('one')
  runtime.emit({ type: 'turn/started', sessionId: session.id, turn: { id: tid, status: 'inProgress', items: [original] } })
  assert.ok(store); await store.flush()
  const held = host.registry.get(runtime.info.id, session.id)!
  const raw = { id: itemId('replacement-user'), type: 'userMessage' as const, content: [{ type: 'text' as const, text: textIdentity === 'same text' ? 'person request' : 'different request' }] }
  const replay = { ...held.session, turns: [{ id: turnIdentity === 'same turn' ? tid : turnId('other-turn'), status: 'inProgress' as const, items: [raw] }] }
  runtime.emit({ type: 'session/started', session: replay })
  assert.equal(held.transcriptIncomplete, true, 'unproven active person identity is protected')
  assert.deepEqual(held.session.turns.flatMap(turn => turn.items.filter(item => item.type === 'userMessage')), [original])
  const view = await host.call('session/read', { runtime: runtime.info.id, sessionId: session.id }) as Session
  assert.deepEqual(view.turns.flatMap(turn => turn.items.filter(item => item.type === 'userMessage')), [original])
  const db = new TranscriptDatabase(join(dir, 'sessions.sqlite'))
  try { assert.deepEqual(db.read(runtime.info.id, session.id)!.turns.flatMap(turn => turn.items.filter(item => item.type === 'userMessage')), [original]) } finally { db.close() }
  runtime.emit({ type: 'turn/completed', sessionId: session.id, turn: { id: tid, status: 'completed', items: [original] } })
  const { historyPending: _pending, ...consistent } = structuredClone(held.session)
  runtime.emit({ type: 'session/started', session: consistent })
  assert.equal(held.transcriptIncomplete, false, 'an exact idle replay can recover the protected body')
  await store.flush()
  const recovered = new TranscriptDatabase(join(dir, 'sessions.sqlite'))
  try { assert.deepEqual(recovered.read(runtime.info.id, session.id)!.turns.flatMap(turn => turn.items.filter(item => item.type === 'userMessage')), [original]) } finally { recovered.close() }
})

test('a thinner active replay with no person item retains the watched prompt', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'hd-active-thin-'))
  const runtime = new FakeRuntime(), host = new Host({ logger: silent, state: new StateStore(join(dir, 'state.json')), builtinAgents: dir, catalogRefreshMs: 0, idleStopMs: 0 })
  host.register(runtime); await host.start()
  t.after(async () => { await host.dispose(); await rm(dir, { recursive: true, force: true }) })
  const session = await host.call('session/create', { runtime: runtime.info.id, options: { cwd: dir } }) as Session
  const user = { id: itemId('user'), type: 'userMessage' as const, content: [{ type: 'text' as const, text: 'person request' }] }
  const answer = { id: itemId('answer'), type: 'assistantMessage' as const, text: 'first' }, tid = turnId('one')
  runtime.emit({ type: 'turn/started', sessionId: session.id, turn: { id: tid, status: 'inProgress', items: [user, answer] } })
  const held = host.registry.get(runtime.info.id, session.id)!
  runtime.emit({ type: 'session/started', session: { ...held.session, turns: [{ id: tid, status: 'inProgress', items: [answer] }] } })
  assert.equal(held.transcriptIncomplete, false)
  assert.deepEqual(held.session.turns[0]!.items, [user, answer])
})

test('a watched active prompt moved to another turn is protected', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'hd-active-moved-'))
  const runtime = new FakeRuntime(), host = new Host({ logger: silent, state: new StateStore(join(dir, 'state.json')), builtinAgents: dir, catalogRefreshMs: 0, idleStopMs: 0 })
  host.register(runtime); await host.start()
  t.after(async () => { await host.dispose().catch(() => {}); await rm(dir, { recursive: true, force: true }) })
  const session = await host.call('session/create', { runtime: runtime.info.id, options: { cwd: dir } }) as Session
  const user = { id: itemId('user'), type: 'userMessage' as const, content: [{ type: 'text' as const, text: 'person request' }] }, tid = turnId('one')
  runtime.emit({ type: 'turn/started', sessionId: session.id, turn: { id: tid, status: 'inProgress', items: [user] } })
  const held = host.registry.get(runtime.info.id, session.id)!
  runtime.emit({ type: 'session/started', session: { ...held.session, turns: [{ id: tid, status: 'inProgress', items: [] }, { id: turnId('other'), status: 'completed', items: [user] }] } })
  assert.equal(held.transcriptIncomplete, true)
  assert.deepEqual(held.session.turns.flatMap(turn => turn.items.filter(item => item.type === 'userMessage')), [user])
})

test('active replay rejects duplicated turn IDs and reordered or duplicated person identities', () => {
  const runtime = new FakeRuntime(), tid = turnId('one')
  const base: Session = { ...new FakeSession(runtime, sessionId('active-order'), { cwd: '/synthetic', model: 'fake-1' }, {}).snapshot(), itemsLoaded: true }
  const first = { id: itemId('u1'), type: 'userMessage' as const, content: [{ type: 'text' as const, text: 'first' }] }
  const second = { id: itemId('u2'), type: 'userMessage' as const, content: [{ type: 'text' as const, text: 'steer' }] }
  const held = { turns: [{ id: tid, status: 'inProgress' as const, items: [first, second] }] }
  for (const turns of [
    [{ ...held.turns[0]!, items: [second, first] }],
    [{ ...held.turns[0]!, items: [first, second, first] }],
    [held.turns[0]!, held.turns[0]!],
  ]) assert.equal(conflictsWithRunningPrompt({ ...base, turns }, held, new Set([tid])), true)
})
