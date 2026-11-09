import assert from 'node:assert/strict'
import { join } from 'node:path'
import { test } from 'node:test'
import { itemId, sessionId, turnId, wireCodeOf, type Session } from '@harnessdesk/protocol'
import { Host } from '../src/host.js'
import { StateStore } from '../src/state.js'
import { SessionWorktrees } from '../src/session-worktrees.js'
import { SessionIndex } from '../src/session-index.js'
import { TranscriptStore } from '../src/transcripts.js'
import { TranscriptDatabase } from '../src/transcript-database.js'
import { Logger } from '../src/log.js'
import { FakeRuntime } from './fixtures/fake-runtime.js'
import { silent } from './fixtures/harness.js'
import { tempDir } from './scratch.js'

for (const recent of [false, true]) test(`opening an idle conversation from the phone twice accepts thin replay${recent ? ' beside unrelated unsaved activity' : ''}`, async t => {
  const root = tempDir('hd-read-saved-replay-')
  const options = { logger: silent, state: new StateStore(join(root, 'state.json')), builtinAgents: root, catalogRefreshMs: 0 }
  const first = new Host(options), writer = new FakeRuntime()
  first.register(writer); await first.start()
  const created = await first.call('session/create', { runtime: writer.info.id, options: { cwd: root } }) as Session
  const turn = { id: turnId('one'), status: 'inProgress' as const, items: [] }
  writer.emit({ type: 'turn/started', sessionId: created.id, turn })
  writer.emit({ type: 'item/completed', sessionId: created.id, turnId: turn.id, item: {
    id: itemId('tool'), type: 'command', command: 'synthetic', cwd: root, origin: 'agent', actions: [], output: 'saved output', status: 'completed',
  } })
  writer.emit({ type: 'item/completed', sessionId: created.id, turnId: turn.id, item: {
    id: itemId('thought'), type: 'reasoning', summary: ['saved reasoning'], content: ['saved reasoning content'],
  } })
  writer.emit({ type: 'turn/completed', sessionId: created.id, turn: { ...turn, status: 'completed' } })
  const saved = structuredClone(first.registry.get(created.runtime, created.id)!.session)
  await first.dispose()
  const host = new Host(options), runtime = new FakeRuntime()
  host.register(runtime); await host.start()
  t.after(() => host.dispose().catch(() => {}))
  const replay: Session = { ...saved, updatedAt: saved.updatedAt + 60_000, turns: saved.turns.map(one => ({ ...one,
    items: one.items.map(item => item.type === 'command' ? { ...item, output: '' } : item.type === 'reasoning' ? { ...item, summary: [], content: [] } : item),
  })) }
  let reads = 0
  runtime.readSession = async () => {
    const body = recent && reads === 0 ? saved : replay
    reads++
    if (recent && reads === 2) runtime.emit({ type: 'item/completed', sessionId: created.id, turnId: turnId('one'),
      item: { id: itemId('recent'), type: 'assistantMessage', text: 'unrelated recent activity' } })
    runtime.emit({ type: 'session/started', session: body })
    assert.equal(host.registry.get(created.runtime, created.id)!.transcriptIncomplete, false)
    return body
  }
  const db = new TranscriptDatabase(join(root, 'sessions.sqlite'))
  t.after(() => db.close())
  const assertSavedFields = (body: { turns: Session['turns'] }) => {
    const items = body.turns[0]!.items
    assert.equal(items.find(item => item.type === 'command')?.output, 'saved output')
    const thought = items.find(item => item.type === 'reasoning')
    assert.deepEqual(thought?.summary, ['saved reasoning'])
    assert.deepEqual(thought?.content, ['saved reasoning content'])
  }
  for (let i = 0; i < 2; i++) {
    if (i === 1) await host.call('session/close', { runtime: created.runtime, sessionId: created.id })
    const read = await host.call('workspace/thread/read', { id: `${created.runtime}:${created.id}` })
    assert.equal((read as { historyPending?: boolean }).historyPending, undefined)
    const held = host.registry.get(created.runtime, created.id)!
    assert.equal(held.transcriptIncomplete, false)
    assertSavedFields(held.session)
    assert.match(JSON.stringify(read), /saved output/)
    assert.match(JSON.stringify(read), /saved reasoning/)
    assertSavedFields(db.read(created.runtime, created.id)!)
    if (recent && i === 1) assert.match(JSON.stringify(held.session.turns), /unrelated recent activity/)
  }
  assert.ok(reads >= 2, 'the phone read must actually reopen and replay through the runtime')
})

for (const saveFails of [false, true]) test(`a genuine replay conflict stays readable and a consistent replay heals it${saveFails ? ' while saving is refused' : ''}`, async t => {
  const root = tempDir('hd-read-conflict-')
  const logs: unknown[] = []
  t.mock.method(Logger.prototype, 'warn', (message: string, details: unknown) => { logs.push([message, details]) })
  const host = new Host({ logger: silent,
    state: new StateStore(join(root, 'state.json')), builtinAgents: root, catalogRefreshMs: 0 })
  const runtime = new FakeRuntime(); host.register(runtime); await host.start()
  t.after(() => host.dispose().catch(() => {}))
  let store!: TranscriptStore
  const recordWrite = TranscriptStore.prototype.record
  t.mock.method(TranscriptStore.prototype, 'record', function(this: TranscriptStore, ...args: Parameters<typeof recordWrite>) {
    store = this; return recordWrite.apply(this, args)
  })
  const created = await host.call('session/create', { runtime: runtime.info.id, options: { cwd: root } }) as Session
  const turn = { id: turnId('one'), status: 'inProgress' as const, items: [] }
  runtime.emit({ type: 'turn/started', sessionId: created.id, turn })
  runtime.emit({ type: 'item/completed', sessionId: created.id, turnId: turn.id,
    item: { id: itemId('answer'), type: 'assistantMessage', text: 'saved answer' } })
  runtime.emit({ type: 'turn/completed', sessionId: created.id, turn: { ...turn, status: 'completed' } })
  await store.flush()
  const record = host.registry.get(created.runtime, created.id)!
  const db = new TranscriptDatabase(join(root, 'sessions.sqlite'))
  t.after(() => db.close())
  const durable = db.read(created.runtime, created.id)!
  runtime.emit({ type: 'item/completed', sessionId: created.id, turnId: turn.id,
    item: { id: itemId('answer'), type: 'assistantMessage', text: 'new unsaved answer' } })
  const good = structuredClone(record.session)
  const conflicting: Session = { ...good, turns: [{ ...good.turns[0]!,
    items: [{ id: itemId('answer'), type: 'assistantMessage', text: 'conflicting answer' }] }] }
  runtime.readSession = async () => { runtime.emit({ type: 'session/started', session: conflicting }); return conflicting }
  t.mock.method(SessionWorktrees.prototype, 'prepare', async () => ({ cwd: root + '/restored', warning: 'Synthetic worktree warning' }))
  let opened = 0
  const markOpened = SessionIndex.prototype.opened
  t.mock.method(SessionIndex.prototype, 'opened', function(this: SessionIndex, ...args: Parameters<typeof markOpened>) { opened++; return markOpened.apply(this, args) })
  const desktop = await host.call('session/read', { runtime: created.runtime, sessionId: created.id }) as Session & { historyPending?: boolean }
  assert.equal(record.transcriptIncomplete, true)
  assert.equal(desktop.historyPending, true)
  assert.equal(desktop.cwd, root + '/restored')
  assert.equal(desktop.worktreeWarning, 'Synthetic worktree warning')
  assert.equal(opened, 1)
  assert.deepEqual(desktop.turns, good.turns)
  const phone = await host.call('workspace/thread/read', { id: `${created.runtime}:${created.id}` }) as { historyPending?: boolean; turns: unknown }
  assert.equal(phone.historyPending, true)
  await host.call('session/read', { runtime: created.runtime, sessionId: created.id })
  assert.equal(opened, 2)
  assert.match(JSON.stringify(phone.turns), /new unsaved answer/)
  assert.deepEqual(db.read(created.runtime, created.id), durable, 'the conflict never writes over the durable body')
  assert.match(JSON.stringify(logs), /replay-conflict/)
  assert.doesNotMatch(JSON.stringify(logs), /new unsaved answer|conflicting answer/)
  runtime.emit({ type: 'item/delta', sessionId: created.id, turnId: turn.id, itemId: itemId('answer'),
    delta: { kind: 'assistantText', text: ' with later activity' } })
  // The runtime replays the body, without the host's read-projection mark.
  const { historyPending: _pending, ...consistent } = structuredClone(record.session)
  const refusedResume = t.mock.method(TranscriptStore.prototype, 'resumeAfterReplay', () => false)
  runtime.emit({ type: 'session/started', session: consistent })
  runtime.emit({ type: 'session/started', session: consistent })
  assert.equal(record.transcriptIncomplete, true)
  assert.equal(logs.filter(entry => JSON.stringify(entry).includes('replay-conflict')).length, 1, 'log once per conflict')
  refusedResume.mock.restore()
  if (saveFails) db.db.exec("CREATE TRIGGER refuse_body BEFORE INSERT ON bodies BEGIN SELECT RAISE(FAIL, 'synthetic storage refusal'); END")
  runtime.emit({ type: 'session/started', session: consistent })
  runtime.readSession = async () => consistent
  assert.equal(record.transcriptIncomplete, false)
  if (saveFails) await assert.rejects(store.flush(), /protected|refusal/i)
  else await store.flush()
  const healed = await host.call('session/read', { runtime: created.runtime, sessionId: created.id }) as Session & { historyPending?: boolean }
  assert.equal(healed.historyPending, saveFails ? true : undefined)
  const phoneAfter = await host.call('workspace/thread/read', { id: `${created.runtime}:${created.id}` })
  assert.equal(phoneAfter.historyPending, saveFails ? true : undefined)
  assert.deepEqual(db.read(created.runtime, created.id)?.turns, saveFails ? durable.turns : consistent.turns)
  if (saveFails) {
    db.db.exec('DROP TRIGGER refuse_body')
    const base = { kind: 'body' as const, identity: db.stateIdentity(durable, created.runtime, created.id) }
    assert.equal(await store.retryProtectedBody(consistent, base), true)
    // session/read previously stored the pending projection on the record.
    assert.equal(record.session.historyPending, true)
    const settledPhone = await host.call('workspace/thread/read', { id: `${created.runtime}:${created.id}` })
    assert.equal(settledPhone.historyPending, undefined)
    assert.equal(record.session.historyPending, undefined)
  }
})

test('a pending conversation with no body reports a stable unavailable code on desktop and phone', async t => {
  const root = tempDir('hd-read-empty-')
  const host = new Host({ logger: silent, state: new StateStore(join(root, 'state.json')), builtinAgents: root, catalogRefreshMs: 0 })
  const runtime = new FakeRuntime(); host.register(runtime); await host.start()
  t.after(() => host.dispose().catch(() => {}))
  const created = await host.call('session/create', { runtime: runtime.info.id, options: { cwd: root } }) as Session
  const record = host.registry.get(created.runtime, created.id)!
  record.transcriptIncomplete = true
  record.session = { ...record.session, itemsLoaded: false, turns: [] }
  for (const read of [
    () => host.call('session/read', { runtime: created.runtime, sessionId: created.id }),
    () => host.call('workspace/thread/read', { id: `${created.runtime}:${created.id}` }),
  ]) await assert.rejects(read, error => wireCodeOf(error) === 'historyUnavailable')
})

test('a missing retained base still exposes complete new items without inventing the missing history', async t => {
  const root = tempDir('hd-read-missing-base-')
  const host = new Host({ logger: silent, state: new StateStore(join(root, 'state.json')), builtinAgents: root, catalogRefreshMs: 0 })
  const runtime = new FakeRuntime(); host.register(runtime); await host.start()
  t.after(() => host.dispose().catch(() => {}))
  const created = await host.call('session/create', { runtime: runtime.info.id, options: { cwd: root } }) as Session
  const body: Session = { ...created, itemsLoaded: true, turns: [{ id: turnId('one'), status: 'completed',
    items: [{ id: itemId('saved'), type: 'assistantMessage', text: 'saved answer' }] }] }
  host.registry.upsert(body, null)
  await host.call('session/close', { runtime: body.runtime, sessionId: body.id })
  t.mock.method(TranscriptStore.prototype, 'readRetainedTurnsAtBase', () => null)
  t.mock.method(TranscriptStore.prototype, 'recover', async () => null)
  runtime.emit({ type: 'item/started', sessionId: body.id, turnId: turnId('one'),
    item: { id: itemId('new'), type: 'assistantMessage', text: '' } })
  runtime.emit({ type: 'item/delta', sessionId: body.id, turnId: turnId('one'), itemId: itemId('new'),
    delta: { kind: 'assistantText', text: 'retained recent activity' } })
  const read = await host.call('session/read', { runtime: body.runtime, sessionId: body.id }) as Session & { historyPending?: boolean }
  assert.equal(read.historyPending, true)
  assert.equal(read.partialHistory, true)
  assert.deepEqual(read.turns[0]?.items, [{ id: itemId('new'), type: 'assistantMessage', text: 'retained recent activity' }])
  assert.equal(host.registry.get(body.runtime, body.id)!.transcriptIncomplete, true)
})

for (const message of ['Sign in required', 'Agent process crashed', 'Conversation not found']) test(`read preserves runtime failure: ${message}`, async t => {
  const root = tempDir('hd-read-error-')
  const host = new Host({ logger: silent, state: new StateStore(join(root, 'state.json')), builtinAgents: root, catalogRefreshMs: 0 })
  const runtime = new FakeRuntime(); host.register(runtime); await host.start()
  t.after(() => host.dispose().catch(() => {}))
  const failure = Object.freeze(new Error(message))
  runtime.readSession = async () => { throw failure }
  await assert.rejects(host.call('session/read', { runtime: runtime.info.id, sessionId: sessionId('missing') }), error => error === failure)
  assert.equal(wireCodeOf(failure), null)
})

test('a protected write does not hide unrelated read failures or retry a failed pending view', async t => {
  const root = tempDir('hd-read-protected-error-')
  const host = new Host({ logger: silent, state: new StateStore(join(root, 'state.json')), builtinAgents: root, catalogRefreshMs: 0 })
  const runtime = new FakeRuntime(); host.register(runtime); await host.start()
  t.after(() => host.dispose().catch(() => {}))
  const created = await host.call('session/create', { runtime: runtime.info.id, options: { cwd: root } }) as Session
  t.mock.method(TranscriptStore.prototype, 'hasProtectedChanges', () => true)
  const failure = new Error('Sign in required')
  runtime.readSession = async () => { throw failure }
  await assert.rejects(host.call('session/read', { runtime: created.runtime, sessionId: created.id }), error => error === failure)
  const record = host.registry.get(created.runtime, created.id)!
  record.transcriptIncomplete = true
  record.session = { ...record.session, itemsLoaded: false, turns: [] }
  let recoveries = 0
  t.mock.method(TranscriptStore.prototype, 'recover', async () => { recoveries++; return null })
  await assert.rejects(host.call('session/read', { runtime: created.runtime, sessionId: created.id }), error => wireCodeOf(error) === 'historyUnavailable')
  assert.equal(recoveries, 1, 'a failed pending view is attempted once')
})
