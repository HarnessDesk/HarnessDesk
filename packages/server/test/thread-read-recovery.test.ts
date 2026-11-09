import assert from 'node:assert/strict'
import { join } from 'node:path'
import { test } from 'node:test'
import { itemId, sessionId, turnId, wireCodeOf, type AgentItem, type Session } from '@harnessdesk/protocol'
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

for (const source of [false, true]) for (const method of ['session/read', 'workspace/thread/read'] as const) {
  if (!source && method === 'workspace/thread/read') continue
  test(`the first refused refresh is pending through ${method} with source=${source}`, async t => {
    const root = tempDir('hd-first-pending-read-')
    const options = { logger: silent, state: new StateStore(join(root, 'state.json')), builtinAgents: root, catalogRefreshMs: 0 }
    const first = new Host(options), writer = new FakeRuntime()
    first.register(writer); await first.start()
    const created = await first.call('session/create', { runtime: writer.info.id, options: { cwd: root } }) as Session
    const turn = { id: turnId('one'), status: 'inProgress' as const, items: [] }
    writer.emit({ type: 'turn/started', sessionId: created.id, turn })
    writer.emit({ type: 'item/completed', sessionId: created.id, turnId: turn.id,
      item: { id: itemId('saved'), type: 'assistantMessage', text: 'saved answer' } })
    writer.emit({ type: 'turn/completed', sessionId: created.id, turn: { ...turn, status: 'completed' } })
    const saved = structuredClone(first.registry.get(created.runtime, created.id)!.session)
    await first.dispose()
    const host = new Host(options), runtime = new FakeRuntime()
    Object.assign(runtime.info.capabilities, { sourceTranscript: source })
    if (source) Object.assign(runtime, { sourceOf: async () => null })
    host.register(runtime); await host.start()
    t.after(() => host.dispose().catch(() => {}))
    const replay: Session = { ...saved, turns: [{ ...saved.turns[0]!, items: [...saved.turns[0]!.items,
      { id: itemId('recent'), type: 'assistantMessage', text: 'recent unsaved answer' }] }] }
    runtime.readSession = async () => replay
    // Start with a known record so reopen preparation does not queue a write
    // of the old body before the refresh under test.
    host.registry.upsert({ ...saved, turns: [], itemsLoaded: false }, null)
    const db = new TranscriptDatabase(join(root, 'sessions.sqlite'))
    t.after(() => db.close())
    db.db.exec("CREATE TRIGGER refuse_body BEFORE INSERT ON bodies BEGIN SELECT RAISE(FAIL, 'synthetic storage refusal'); END")
    const read = method === 'session/read'
      ? await host.call(method, { runtime: created.runtime, sessionId: created.id })
      : await host.call(method, { id: `${created.runtime}:${created.id}` })
    assert.equal(read.historyPending, true, 'the read that establishes protection must carry the pending mark')
    assert.match(JSON.stringify(read.turns), /recent unsaved answer/)
    assert.deepEqual(db.read(created.runtime, created.id)!.turns, saved.turns)
    const record = host.registry.get(created.runtime, created.id)!
    assert.equal(record.session.historyPending, undefined, 'a served mark must not change writable session facts')
    const pushes: Session[] = []
    const stop = host.addBroadcaster(notification => {
      if ('method' in notification && notification.method === 'event' && notification.params.event.type === 'session/started') pushes.push(notification.params.event.session)
    })
    t.after(stop)
    db.db.exec('DROP TRIGGER refuse_body')
    const healed = await host.call('session/read', { runtime: created.runtime, sessionId: created.id })
    assert.equal(healed.historyPending, undefined)
    assert.deepEqual(db.read(created.runtime, created.id)!.turns, replay.turns)
    assert.equal(pushes.length, 1, 'a recovered save must push one cleared session')
    assert.equal(pushes[0]!.historyPending, undefined)
    await host.call('session/read', { runtime: created.runtime, sessionId: created.id })
    assert.equal(pushes.length, 1, 'later reads must not repeat the cleared push')
  })
}

test('settling a pending phone projection pushes one cleared session', async t => {
  const root = tempDir('hd-pending-projection-settle-')
  const host = new Host({ logger: silent, state: new StateStore(join(root, 'state.json')), builtinAgents: root, catalogRefreshMs: 0 })
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
  const db = new TranscriptDatabase(join(root, 'sessions.sqlite'))
  t.after(() => db.close())
  const durable = db.read(created.runtime, created.id)!
  const base = { kind: 'body' as const, identity: db.stateIdentity(durable, created.runtime, created.id) }
  db.db.exec("CREATE TRIGGER refuse_body BEFORE INSERT ON bodies BEGIN SELECT RAISE(FAIL, 'synthetic storage refusal'); END")
  runtime.emit({ type: 'item/completed', sessionId: created.id, turnId: turn.id,
    item: { id: itemId('recent'), type: 'assistantMessage', text: 'recent unsaved answer' } })
  await assert.rejects(store.flush(), /protected|refusal/i)
  const record = host.registry.get(created.runtime, created.id)!
  const read = await host.call('workspace/thread/read', { id: `${created.runtime}:${created.id}` })
  assert.equal(read.historyPending, true)
  assert.equal(record.session.historyPending, undefined, 'only the projection carries the pending mark')
  const pushes: Session[] = []
  const stop = host.addBroadcaster(notification => {
    if ('method' in notification && notification.method === 'event' && notification.params.event.type === 'session/started') pushes.push(notification.params.event.session)
  })
  t.after(stop)
  db.db.exec('DROP TRIGGER refuse_body')
  assert.equal(await store.retryProtectedBody(record.session, base), true)
  assert.equal(pushes.length, 1, 'settling a served projection must update the open conversation')
  assert.equal(pushes[0]!.historyPending, undefined)
  assert.deepEqual(pushes[0]!.turns, record.session.turns)
  assert.equal(await store.persistEvolvedBody(record.session, store.verifiedBase(record.session)!), true)
  assert.equal(pushes.length, 1, 'a later successful save must not repeat the cleared push')
})

test('settling a pending unloaded projection pushes the saved body', async t => {
  const root = tempDir('hd-pending-unloaded-settle-')
  const host = new Host({ logger: silent, state: new StateStore(join(root, 'state.json')), builtinAgents: root, catalogRefreshMs: 0 })
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
  const db = new TranscriptDatabase(join(root, 'sessions.sqlite'))
  t.after(() => db.close())
  const durable = db.read(created.runtime, created.id)!
  const base = { kind: 'body' as const, identity: db.stateIdentity(durable, created.runtime, created.id) }
  const record = host.registry.get(created.runtime, created.id)!
  record.session = { ...record.session, settings: { cwd: root, model: 'fake-1' } }
  const saved = structuredClone(record.session)
  record.session = { ...record.session, turns: [], itemsLoaded: false }
  record.transcriptIncomplete = true
  const read = await host.call('workspace/thread/read', { id: `${created.runtime}:${created.id}` })
  assert.equal(read.historyPending, true)
  assert.equal(record.session.historyPending, undefined, 'only the projection carries the pending mark')
  assert.equal(record.session.itemsLoaded, false, 'the pending view must leave the record unloaded')
  const pushes: Session[] = []
  let pushed!: () => void
  const cleared = new Promise<void>(resolve => { pushed = resolve })
  const stop = host.addBroadcaster(notification => {
    if ('method' in notification && notification.method === 'event' && notification.params.event.type === 'session/started') { pushes.push(notification.params.event.session); pushed() }
  })
  t.after(stop)
  record.transcriptIncomplete = false
  assert.equal(await store.persistEvolvedBody(saved, base), true)
  await cleared
  assert.equal(pushes[0]!.itemsLoaded, true, 'clearing the mark must never replace history with an unloaded body')
  assert.equal(pushes.length, 1, 'settling a served projection must update the open conversation')
  assert.equal(pushes[0]!.historyPending, undefined)
  assert.deepEqual(pushes[0]!.turns, saved.turns)
  assert.deepEqual(pushes[0]!.settings, saved.settings, 'clearing the mark must preserve the record settings')
  assert.equal(await store.persistEvolvedBody(saved, store.verifiedBase(saved)!), true)
  assert.equal(pushes.length, 1, 'a later successful save must not repeat the cleared push')
})

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
    runtime.emit({ type: 'session/started', session: body })
    if (recent && reads === 2) runtime.emit({ type: 'item/completed', sessionId: created.id, turnId: turnId('one'),
      item: { id: itemId('recent'), type: 'assistantMessage', text: 'unrelated recent activity' } })
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
    let pushed: Session | undefined
    const stop = host.addBroadcaster(notification => {
      if ('method' in notification && notification.method === 'event' && notification.params.event.type === 'session/started') pushed = notification.params.event.session
    })
    assert.equal(await store.retryProtectedBody(consistent, base), true)
    stop()
    // Settling storage clears the mark and updates open windows immediately.
    assert.equal(record.session.historyPending, undefined)
    assert.ok(pushed)
    assert.equal(pushed.historyPending, undefined, 'settling storage pushes the cleared session')
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

const savedTool = { id: itemId('tool'), type: 'toolCall' as const, tool: 'Read', source: { kind: 'builtin' as const },
  status: 'completed' as const, args: { p: 1 }, result: [{ type: 'text' as const, text: 'saved result' }], error: 'saved error' }
const savedAnswer = { id: itemId('answer'), type: 'assistantMessage' as const, text: 'saved full answer', phase: 'final' as const }
const savedCommand = { id: itemId('command'), type: 'command' as const, command: 'synthetic', cwd: '/', origin: 'agent' as const,
  actions: [], output: 'saved head, middle and tail', status: 'completed' as const, exitCode: 0 }
const savedChanges = { id: itemId('files'), type: 'fileChange' as const, status: 'completed' as const,
  changes: [{ path: '/demo/file', kind: { type: 'add' as const }, diff: 'saved file content' }] }
const savedSearch = { id: itemId('search'), type: 'webSearch' as const, query: 'synthetic', status: 'completed' as const,
  results: [{ title: 'Saved result', url: 'https://example.com/result' }] }
const savedSubagent = { id: itemId('subagent'), type: 'subagent' as const, action: 'spawn', status: 'completed' as const,
  prompt: 'saved task', model: 'synthetic-model', members: [{ sessionId: 'child', nickname: 'Helper' }] }
const replayCases = [
  { name: 'tool result dropped', saved: savedTool, thin: { ...savedTool, result: undefined },
    newer: { ...savedTool, result: [...savedTool.result, { type: 'text' as const, text: 'continued result' }] } },
  { name: 'assistant text shortened', saved: savedAnswer, thin: { ...savedAnswer, text: 'saved' },
    newer: { ...savedAnswer, text: 'saved full answer with continued work' } },
  { name: 'command output cut with a marker', saved: savedCommand, thin: { ...savedCommand, output: 'saved head ...cut... tail' },
    newer: { ...savedCommand, output: savedCommand.output + ' with continued output' } },
  { name: 'tool error dropped', saved: savedTool, thin: { ...savedTool, error: undefined },
    newer: { ...savedTool, error: savedTool.error + ' with more detail' } },
  { name: 'file content changed', saved: savedChanges, thin: { ...savedChanges, changes: [{ ...savedChanges.changes[0]!, diff: '' }] },
    newer: { ...savedChanges, changes: [...savedChanges.changes, { path: '/demo/extra', kind: { type: 'add' as const }, diff: 'new file' }] } },
  { name: 'search results dropped', saved: savedSearch, thin: { ...savedSearch, results: [] },
    newer: { ...savedSearch, results: [...savedSearch.results, { title: 'New result', url: 'https://example.com/new' }] } },
  { name: 'subagent model dropped', saved: savedSubagent, thin: { ...savedSubagent, model: undefined },
    newer: { ...savedSubagent, prompt: savedSubagent.prompt + ' with more work', members: [...savedSubagent.members, { sessionId: 'child-2', nickname: 'Helper 2' }] } },
  { name: 'a changed field keeps its saved value beside an extended result', saved: savedTool,
    thin: { ...savedTool, args: { p: 2 }, result: [...savedTool.result, { type: 'text' as const, text: 'continued result' }] },
    preserved: { ...savedTool, result: [...savedTool.result, { type: 'text' as const, text: 'continued result' }] },
    newer: { ...savedTool, result: [...savedTool.result, { type: 'text' as const, text: 'continued result' }] } },
] satisfies { name: string; saved: AgentItem; thin: AgentItem; newer: AgentItem; preserved?: AgentItem }[]

for (const method of ['session/read', 'workspace/thread/read'] as const) for (const scenario of replayCases) {
  test(`generic replay preservation: ${scenario.name} through ${method}`, async t => {
    const root = tempDir('hd-generic-replay-')
    const options = { logger: silent, state: new StateStore(join(root, 'state.json')), builtinAgents: root, catalogRefreshMs: 0 }
    const first = new Host(options), writer = new FakeRuntime()
    first.register(writer); await first.start()
    const created = await first.call('session/create', { runtime: writer.info.id, options: { cwd: root } }) as Session
    const turn = { id: turnId('one'), status: 'inProgress' as const, items: [] }
    writer.emit({ type: 'turn/started', sessionId: created.id, turn })
    writer.emit({ type: 'item/completed', sessionId: created.id, turnId: turn.id, item: scenario.saved })
    writer.emit({ type: 'turn/completed', sessionId: created.id, turn: { ...turn, status: 'completed' } })
    const saved = structuredClone(first.registry.get(created.runtime, created.id)!.session)
    await first.dispose()
    const host = new Host(options), runtime = new FakeRuntime()
    host.register(runtime); await host.start()
    t.after(() => host.dispose().catch(() => {}))
    const db = new TranscriptDatabase(join(root, 'sessions.sqlite'))
    t.after(() => db.close())
    let item: AgentItem = scenario.thin, reads = 0, enrichedRead: Session | undefined
    const enrich = TranscriptStore.prototype.enrichForRefresh
    t.mock.method(TranscriptStore.prototype, 'enrichForRefresh', async function(this: TranscriptStore, body: Session) {
      const result = await enrich.call(this, body); enrichedRead = result.session; return result
    })
    runtime.readSession = async () => {
      reads++
      const replay = { ...saved, updatedAt: saved.updatedAt + 60_000,
        turns: [{ ...saved.turns[0]!, items: [item] }] }
      runtime.emit({ type: 'session/started', session: replay }); return replay
    }
    // Both thin reads preserve the saved body. An actual extension then wins,
    // and a later thin replay must also preserve that newly saved extension.
    for (const phase of [
      { replay: scenario.thin, expected: 'preserved' in scenario ? scenario.preserved! : scenario.saved },
      { replay: scenario.newer, expected: scenario.newer },
      { replay: scenario.thin, expected: scenario.newer },
    ]) for (let i = 0; i < 2; i++) {
      if (reads) await host.call('session/close', { runtime: created.runtime, sessionId: created.id })
      item = phase.replay
      const result = method === 'session/read'
        ? await host.call(method, { runtime: created.runtime, sessionId: created.id })
        : await host.call(method, { id: `${created.runtime}:${created.id}` })
      assert.equal(result.historyPending, undefined)
      // Phone deliberately omits arbitrary tool results. Verify the full read
      // that feeds its projection as well as its visible assistant/command text.
      const read = method === 'session/read' ? result as Session : enrichedRead!
      assert.deepEqual(read.turns[0]!.items, [phase.expected])
      if (phase.expected.type === 'assistantMessage') assert.match(JSON.stringify(result), new RegExp(phase.expected.text))
      if (phase.expected.type === 'command') assert.match(JSON.stringify(result), new RegExp(phase.expected.output!))
      assert.deepEqual(db.read(created.runtime, created.id)!.turns[0]!.items, [phase.expected])
      assert.equal(host.registry.get(created.runtime, created.id)!.transcriptIncomplete, false)
    }
    assert.equal(reads, 6)
  })
}

for (const field of ['title', 'preview', 'cwd'] as const) test(`an enriched replay persists changed ${field}`, async t => {
  const root = tempDir('hd-replay-facts-')
  const host = new Host({ logger: silent, state: new StateStore(join(root, 'state.json')), builtinAgents: root, catalogRefreshMs: 0 })
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
  runtime.emit({ type: 'item/completed', sessionId: created.id, turnId: turn.id, item: savedCommand })
  runtime.emit({ type: 'turn/completed', sessionId: created.id, turn: { ...turn, status: 'completed' } })
  await store.flush()
  const saved = host.registry.get(created.runtime, created.id)!.session
  const changed = { ...saved, [field]: field === 'cwd' ? root + '/changed' : 'Changed synthetic metadata',
    turns: [{ ...saved.turns[0]!, items: [{ ...savedCommand, output: '' }] }] }
  runtime.emit({ type: 'session/started', session: changed })
  await store.flush()
  const db = new TranscriptDatabase(join(root, 'sessions.sqlite'))
  try { assert.equal(db.read(created.runtime, created.id)![field], changed[field]) } finally { db.close() }
})

const itemMergeCases = [
  { saved: 4, replay: ['command', 'new-1', 'old-1'], expected: ['command', 'new-1', 'old-1', 'old-2', 'old-3'] },
  { saved: 2, replay: ['command', 'new-1'], expected: ['command', 'new-1', 'old-1'] },
  { saved: 2, replay: ['command', 'new-1', 'new-2', 'new-3'], expected: ['command', 'new-1', 'new-2', 'new-3', 'old-1'] },
  { saved: 2, replay: ['new-1', 'new-2'], expected: ['new-1', 'new-2', 'command', 'old-1'] },
]
for (const method of ['session/read', 'workspace/thread/read'] as const) for (const scenario of itemMergeCases) test(`an enriched replay merges [${scenario.replay}] into ${scenario.saved} saved items through ${method}`, async t => {
  const root = tempDir('hd-replay-merge-')
  const options = { logger: silent, state: new StateStore(join(root, 'state.json')), builtinAgents: root, catalogRefreshMs: 0 }
  const first = new Host(options), writer = new FakeRuntime(); first.register(writer); await first.start()
  const created = await first.call('session/create', { runtime: writer.info.id, options: { cwd: root } }) as Session
  const turn = { id: turnId('one'), status: 'inProgress' as const, items: [] }
  writer.emit({ type: 'turn/started', sessionId: created.id, turn })
  const old = [savedCommand, ...['old-1', 'old-2', 'old-3'].slice(0, scenario.saved - 1).map(id => ({ ...savedAnswer, id: itemId(id), text: id }))]
  for (const item of old) writer.emit({ type: 'item/completed', sessionId: created.id, turnId: turn.id, item })
  writer.emit({ type: 'turn/completed', sessionId: created.id, turn: { ...turn, status: 'completed' } })
  const saved = structuredClone(first.registry.get(created.runtime, created.id)!.session); await first.dispose()
  const host = new Host(options), runtime = new FakeRuntime(); host.register(runtime); await host.start()
  t.after(() => host.dispose().catch(() => {}))
  const itemsById = new Map([...old, ...['new-1', 'new-2', 'new-3'].map(id => ({ ...savedAnswer, id: itemId(id), text: id }))].map(item => [String(item.id), item]))
  runtime.readSession = async () => {
    const replay = { ...saved, turns: [{ ...saved.turns[0]!, items: scenario.replay.map(id => itemsById.get(id)!) }] }
    runtime.emit({ type: 'session/started', session: replay }); return replay
  }
  const read = method === 'session/read' ? await host.call(method, { runtime: created.runtime, sessionId: created.id })
    : await host.call(method, { id: `${created.runtime}:${created.id}` })
  assert.match(JSON.stringify(read), /new-1/)
  const db = new TranscriptDatabase(join(root, 'sessions.sqlite'))
  try {
    const items = db.read(created.runtime, created.id)!.turns[0]!.items
    assert.deepEqual(items, scenario.expected.map(id => itemsById.get(id)!))
    for (const item of old) assert.ok(items.some(candidate => candidate.id === item.id))
  } finally { db.close() }
})

const runningCommand = { ...savedCommand, status: 'inProgress' as const, output: 'partial', exitCode: null, durationMs: 5 }
const runningTool = { ...savedTool, status: 'inProgress' as const, result: undefined, error: undefined }
const lifecycleCases: { name: string; saved: AgentItem; replay: AgentItem; expected: AgentItem }[] = [
  { name: 'command completes after restart', saved: runningCommand,
    replay: { ...runningCommand, status: 'completed', output: 'partial and the rest', exitCode: 0, durationMs: 10 },
    expected: { ...runningCommand, status: 'completed', output: 'partial and the rest', exitCode: 0, durationMs: 10 } },
  { name: 'tool completes after restart', saved: runningTool,
    replay: { ...runningTool, status: 'completed', result: [{ type: 'text', text: 'finished result' }] },
    expected: { ...runningTool, status: 'completed', result: [{ type: 'text', text: 'finished result' }] } },
  { name: 'running file diff rewrite wins', saved: { ...savedChanges, status: 'inProgress' },
    replay: { ...savedChanges, status: 'inProgress', changes: [{ ...savedChanges.changes[0]!, diff: 'rewritten diff' }] },
    expected: { ...savedChanges, status: 'inProgress', changes: [{ ...savedChanges.changes[0]!, diff: 'rewritten diff' }] } },
  { name: 'running tool content rewrite wins', saved: { ...runningTool, result: [{ type: 'text', text: 'old content' }] },
    replay: { ...runningTool, tool: 'Updated tool title', result: [{ type: 'text', text: 'rewritten content' }] },
    expected: { ...runningTool, tool: 'Updated tool title', result: [{ type: 'text', text: 'rewritten content' }] } },
  { name: 'completed item rejects running replay', saved: savedCommand,
    replay: { ...runningCommand, output: savedCommand.output + ' stale extension' }, expected: savedCommand },
  { name: 'completion keeps missing output and takes exit code', saved: runningCommand,
    replay: { ...runningCommand, status: 'completed', output: undefined, exitCode: 0, durationMs: 0 },
    expected: { ...runningCommand, status: 'completed', exitCode: 0, durationMs: 0 } },
]
for (const method of ['session/read', 'workspace/thread/read'] as const) for (const scenario of lifecycleCases) {
  test(`lifecycle replay: ${scenario.name} through ${method}`, async t => {
    const root = tempDir('hd-lifecycle-replay-')
    const options = { logger: silent, state: new StateStore(join(root, 'state.json')), builtinAgents: root, catalogRefreshMs: 0 }
    const first = new Host(options), writer = new FakeRuntime(); first.register(writer); await first.start()
    const created = await first.call('session/create', { runtime: writer.info.id, options: { cwd: root } }) as Session
    const turn = { id: turnId('one'), status: 'inProgress' as const, items: [] }
    writer.emit({ type: 'turn/started', sessionId: created.id, turn })
    writer.emit({ type: 'item/started', sessionId: created.id, turnId: turn.id, item: scenario.saved })
    const saved = structuredClone(first.registry.get(created.runtime, created.id)!.session)
    await first.dispose()
    const host = new Host(options), runtime = new FakeRuntime(); host.register(runtime); await host.start()
    t.after(() => host.dispose().catch(() => {}))
    const db = new TranscriptDatabase(join(root, 'sessions.sqlite')); t.after(() => db.close())
    let reads = 0, enrichedRead: Session | undefined
    const enrich = TranscriptStore.prototype.enrichForRefresh
    t.mock.method(TranscriptStore.prototype, 'enrichForRefresh', async function(this: TranscriptStore, body: Session) {
      const result = await enrich.call(this, body); enrichedRead = result.session; return result
    })
    runtime.readSession = async () => {
      reads++
      const replay = { ...saved, updatedAt: saved.updatedAt + 60_000,
        turns: [{ ...saved.turns[0]!, status: 'completed' as const, items: [scenario.replay] }] }
      runtime.emit({ type: 'session/started', session: replay }); return replay
    }
    for (let i = 0; i < 2; i++) {
      if (i) await host.call('session/close', { runtime: created.runtime, sessionId: created.id })
      const result = method === 'session/read'
        ? await host.call(method, { runtime: created.runtime, sessionId: created.id })
        : await host.call(method, { id: `${created.runtime}:${created.id}` })
      const fullRead = method === 'session/read' ? result as Session : enrichedRead!
      // SQLite omits optional undefined properties; compare the serialized item.
      const expected = JSON.parse(JSON.stringify(scenario.expected)) as AgentItem
      assert.deepEqual(JSON.parse(JSON.stringify(fullRead.turns[0]!.items)), [expected])
      assert.deepEqual(db.read(created.runtime, created.id)!.turns[0]!.items, [expected])
      assert.equal(result.historyPending, undefined)
      assert.equal(host.registry.get(created.runtime, created.id)!.transcriptIncomplete, false)
    }
    assert.equal(reads, 2)
  })
}
