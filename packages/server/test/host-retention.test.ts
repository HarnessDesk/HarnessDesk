import assert from 'node:assert/strict'
import { createHook } from 'node:async_hooks'
import { execFile } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { getHeapSnapshot } from 'node:v8'

import { canonicalTranscriptBody, PendingTranscript, approvalId, itemId, sessionId, turnId, type Session, type TurnId } from '@harnessdesk/protocol'
import { Host } from '../src/host.js'
import { StateStore } from '../src/state.js'
import { LoadoutRecorder } from '../src/loadouts.js'
import { TranscriptStore } from '../src/transcripts.js'
import { TranscriptDatabase } from '../src/transcript-database.js'
import { DescriptorCache } from '../src/recovery-descriptor.js'
import { FakeRuntime } from './fixtures/fake-runtime.js'
import { silent } from './fixtures/harness.js'
import { claimed, desk, execution, scopeOf, start, whenChanged } from './fixtures/flow-host-evidence.js'
import { tempDir } from './scratch.js'

const exec = promisify(execFile)
const immediate = () => new Promise<void>(resolve => setImmediate(resolve))

function transcript(runtime: FakeRuntime, id: Session['id'], bytes = 1024, active?: TurnId): void {
  const turn = { id: active ?? turnId(`payload-${id}`), status: 'inProgress' as const, items: [] }
  if (!active) runtime.emit({ type: 'turn/started', sessionId: id, turn })
  runtime.emit({ type: 'item/completed', sessionId: id, turnId: turn.id, item: {
    id: itemId(`output-${id}`), type: 'command', command: 'synthetic-output',
    cwd: '/synthetic', origin: 'agent', actions: [],
    output: randomBytes(bytes * 3 / 4).toString('base64'), status: 'completed',
  } })
  if (!active) runtime.emit({ type: 'turn/completed', sessionId: id, turn: { ...turn, status: 'completed' } })
}

/** Give receipt races a real creation, durable close and verified loaded body. */
async function loadedReceiptFixture(host: Host, runtime: FakeRuntime, root: string) {
  const created = await host.call('session/create', { runtime: runtime.info.id, options: { cwd: root } }) as Session
  const turn = { id: turnId('one'), status: 'inProgress' as const, items: [] }
  runtime.emit({ type: 'turn/started', sessionId: created.id, turn })
  runtime.emit({ type: 'item/completed', sessionId: created.id, turnId: turn.id,
    item: { id: itemId('i'), type: 'assistantMessage', text: 'saved body' } })
  runtime.emit({ type: 'turn/completed', sessionId: created.id, turn: { ...turn, status: 'completed' } })
  await host.call('session/close', { runtime: created.runtime, sessionId: created.id })
  await host.call('session/resume', { runtime: created.runtime, sessionId: created.id })
  await host.call('session/read', { runtime: created.runtime, sessionId: created.id })
  const record = host.registry.get(created.runtime, created.id)!
  record.live = null
  record.cacheClosed = true
  assert.equal(record.running.size, 0)
  assert.equal(record.session.itemsLoaded, true)
  return { body: record.session, record }
}

test('closing a conversation saves its body, releases it from sync, and reads it back on demand', async t => {
  const root = tempDir('hd-retention-close-')
  const host = new Host({ logger: silent, state: new StateStore(join(root, 'state.json')), builtinAgents: root, catalogRefreshMs: 0 })
  t.after(() => host.dispose())
  const runtime = new FakeRuntime()
  host.register(runtime)
  await host.start()
  const session = await host.call('session/create', { runtime: runtime.info.id, options: { cwd: root } }) as Session
  transcript(runtime, session.id)
  const before = host.registry.get(runtime.info.id, session.id)!.session
  const address = { runtime: runtime.info.id, sessionId: session.id }
  await host.call('session/close', address)
  const held = host.registry.get(runtime.info.id, session.id)!
  assert.equal(held.session.itemsLoaded, false)
  assert.deepEqual(held.session.turns, [])
  assert.equal(held.watched.size, 0)
  assert.equal(host.registry.snapshot().find(row => row.id === session.id)?.itemsLoaded, false)
  const read = await host.call('session/read', address) as Session
  assert.deepEqual(read.turns, before.turns, 'the thin runtime read is enriched with durable tool output')
  assert.equal(read.itemsLoaded, true)
  await host.call('session/resume', address)
  assert.deepEqual(host.registry.get(runtime.info.id, session.id)!.session.turns, before.turns)
})

test('a previously settled event write advances the base used by normal close', async t => {
  const root = tempDir('hd-retention-settled-close-')
  const host = new Host({ logger: silent, state: new StateStore(join(root, 'state.json')), builtinAgents: root, catalogRefreshMs: 0 })
  t.after(() => host.dispose())
  const runtime = new FakeRuntime(); host.register(runtime); await host.start()
  let store: TranscriptStore | undefined
  const original = TranscriptStore.prototype.record
  t.mock.method(TranscriptStore.prototype, 'record', function(this: TranscriptStore, session: Parameters<typeof original>[0], options: Parameters<typeof original>[1]) {
    store = this; return original.call(this, session, options)
  })
  const created = await host.call('session/create', { runtime: runtime.info.id, options: { cwd: root } }) as Session
  transcript(runtime, created.id)
  assert.ok(store)
  await store.flush()
  runtime.emit({ type: 'item/completed', sessionId: created.id, turnId: turnId(`payload-${created.id}`), item: { id: itemId('later'), type: 'assistantMessage', text: 'later' } })
  const before = host.registry.get(runtime.info.id, created.id)!.session.turns
  await host.call('session/close', { runtime: runtime.info.id, sessionId: created.id })
  assert.equal(host.registry.get(runtime.info.id, created.id)!.session.itemsLoaded, false)
  const db = new TranscriptDatabase(join(root, 'sessions.sqlite'))
  try { assert.deepEqual(db.read(runtime.info.id, created.id)?.turns, before) } finally { db.close() }
})

test('a conflicting background write keeps the Host body and notifies the conversation', async t => {
  const root = tempDir('hd-retention-background-conflict-')
  const host = new Host({ logger: silent, state: new StateStore(join(root, 'state.json')), builtinAgents: root, catalogRefreshMs: 0 })
  t.after(() => host.dispose())
  const runtime = new FakeRuntime(); host.register(runtime); await host.start()
  let store: TranscriptStore | undefined
  const original = TranscriptStore.prototype.record
  t.mock.method(TranscriptStore.prototype, 'record', function(this: TranscriptStore, session: Parameters<typeof original>[0], options: Parameters<typeof original>[1]) {
    store = this; return original.call(this, session, options)
  })
  const created = await host.call('session/create', { runtime: runtime.info.id, options: { cwd: root } }) as Session
  transcript(runtime, created.id)
  assert.ok(store); await store.flush()
  const db = new TranscriptDatabase(join(root, 'sessions.sqlite'))
  try {
    const saved = db.read(created.runtime, created.id); assert.ok(saved)
    db.write({ ...saved, title: 'external title' })
    const sent: any[] = []; host.addBroadcaster(event => sent.push(event))
    runtime.emit({ type: 'item/completed', sessionId: created.id, turnId: turnId(`payload-${created.id}`), item: { id: itemId('later'), type: 'assistantMessage', text: 'later' } })
    await assert.rejects(store.flush(), /protected/i)
    assert.equal(db.read(created.runtime, created.id)?.title, 'external title')
    assert.equal(host.registry.get(created.runtime, created.id)!.session.itemsLoaded, true)
    assert.ok(sent.some(entry => entry.method === 'event' && entry.params.event.type === 'notice' && /could not be saved/i.test(entry.params.event.message)))
  } finally { db.close(); await store.forget(created.runtime, created.id) }
})

test('reopening a removed row cannot queue an unowned write over a newer durable row', async t => {
  const root = tempDir('hd-retention-reopen-base-')
  const host = new Host({ logger: silent, state: new StateStore(join(root, 'state.json')), builtinAgents: root, catalogRefreshMs: 0 })
  t.after(() => host.dispose())
  const runtime = new FakeRuntime(); host.register(runtime); await host.start()
  const body: Session = { runtime: runtime.info.id, id: sessionId('reopened'), cwd: root, createdAt: 1, updatedAt: 1,
    title: 'old title', status: { type: 'idle' }, itemsLoaded: true,
    turns: [{ id: turnId('one'), status: 'completed', items: [{ id: itemId('i'), type: 'assistantMessage', text: 'saved' }] }] }
  runtime.readSession = async () => body
  const db = new TranscriptDatabase(join(root, 'sessions.sqlite'))
  db.write({ version: 1, runtime: body.runtime, id: body.id, savedAt: 1, cwd: root, createdAt: 1, updatedAt: 1, title: body.title, turns: body.turns })
  await host.call('session/remove', { runtime: body.runtime, sessionId: body.id, removed: true })
  let store: TranscriptStore | undefined, injected = false
  const original = TranscriptStore.prototype.record
  t.mock.method(TranscriptStore.prototype, 'record', function(this: TranscriptStore, session: Parameters<typeof original>[0], options: Parameters<typeof original>[1]) {
    store = this; original.call(this, session, options)
    if (!injected && session.id === body.id) {
      injected = true
      const current = db.read(body.runtime, body.id); assert.ok(current)
      db.write({ ...current, title: 'external title' })
    }
  })
  try {
    await host.call('session/read', { runtime: body.runtime, sessionId: body.id })
    assert.equal(injected, true, 'the reopened read queued its authoritative write')
    assert.ok(store)
    await assert.rejects(store.flush(), /protected|authority/i)
    assert.equal(db.read(body.runtime, body.id)?.title, 'external title')
    assert.equal(host.registry.get(body.runtime, body.id)?.session.title, 'old title')
  } finally { db.close(); await store?.forget(body.runtime, body.id) }
})

test('a newly forked conversation can persist and release its own body', async t => {
  const root = tempDir('hd-retention-fork-close-')
  const host = new Host({ logger: silent, state: new StateStore(join(root, 'state.json')), builtinAgents: root, catalogRefreshMs: 0 })
  t.after(() => host.dispose())
  const runtime = new FakeRuntime(); host.register(runtime); await host.start()
  const created = await host.call('session/create', { runtime: runtime.info.id, options: { cwd: root } }) as Session
  const forked = await host.call('session/fork', { runtime: runtime.info.id, sessionId: created.id }) as Session
  assert.notEqual(forked.id, created.id)
  transcript(runtime, forked.id)
  const before = host.registry.get(runtime.info.id, forked.id)!.session.turns
  await host.call('session/close', { runtime: runtime.info.id, sessionId: forked.id })
  assert.equal(host.registry.get(runtime.info.id, forked.id)!.session.itemsLoaded, false)
  const db = new TranscriptDatabase(join(root, 'sessions.sqlite'))
  try { assert.deepEqual(db.read(runtime.info.id, forked.id)?.turns, before) } finally { db.close() }
})

test('events heard before create returns wait for fresh-record authority', async t => {
  const root = tempDir('hd-retention-create-events-')
  const host = new Host({ logger: silent, state: new StateStore(join(root, 'state.json')), builtinAgents: root, catalogRefreshMs: 0 })
  t.after(() => host.dispose())
  const runtime = new FakeRuntime(); host.register(runtime); await host.start()
  let store: TranscriptStore | undefined
  const record = TranscriptStore.prototype.record
  t.mock.method(TranscriptStore.prototype, 'record', function(this: TranscriptStore, session: Parameters<typeof record>[0], options: Parameters<typeof record>[1]) {
    store = this; return record.call(this, session, options)
  })
  const create = runtime.createSession.bind(runtime)
  runtime.createSession = async options => {
    const live = await create(options)
    transcript(runtime, live.id)
    assert.ok(store)
    await assert.rejects(store.flush())
    return live
  }
  const created = await host.call('session/create', { runtime: runtime.info.id, options: { cwd: root } }) as Session
  const before = host.registry.get(runtime.info.id, created.id)!.session.turns
  await host.call('session/close', { runtime: created.runtime, sessionId: created.id })
  assert.equal(host.registry.get(created.runtime, created.id)!.session.itemsLoaded, false)
  const db = new TranscriptDatabase(join(root, 'sessions.sqlite'))
  try { assert.deepEqual(db.read(created.runtime, created.id)?.turns, before) } finally { db.close() }
})

test('a failed create cannot turn early events into fresh-record authority', async t => {
  const root = tempDir('hd-retention-create-failed-')
  const host = new Host({ logger: silent, state: new StateStore(join(root, 'state.json')), builtinAgents: root, catalogRefreshMs: 0 })
  t.after(() => host.dispose())
  const runtime = new FakeRuntime(); host.register(runtime); await host.start()
  let store: TranscriptStore | undefined, earlyId: Session['id'] | undefined
  const record = TranscriptStore.prototype.record
  t.mock.method(TranscriptStore.prototype, 'record', function(this: TranscriptStore, session: Parameters<typeof record>[0], options: Parameters<typeof record>[1]) {
    store = this; return record.call(this, session, options)
  })
  const create = runtime.createSession.bind(runtime)
  runtime.createSession = async options => {
    const live = await create(options); earlyId = live.id
    transcript(runtime, live.id)
    assert.ok(store); await assert.rejects(store.flush())
    throw new Error('synthetic create failure')
  }
  await assert.rejects(host.call('session/create', { runtime: runtime.info.id, options: { cwd: root } }), /synthetic create failure/)
  assert.ok(store); assert.ok(earlyId)
  await assert.rejects(store.flush(), /authority/i)
  assert.equal(store.protectedPressure().bodies, 1)
  const db = new TranscriptDatabase(join(root, 'sessions.sqlite'))
  try { assert.equal(db.read(runtime.info.id, earlyId), null) } finally { db.close() }
  await store.forget(runtime.info.id, earlyId)
})

test('a create that returns an already-held ID cannot establish a missing base', async t => {
  const root = tempDir('hd-retention-create-existing-')
  const runtime = new FakeRuntime()
  const existing = await runtime.createSession({ cwd: root })
  const host = new Host({ logger: silent, state: new StateStore(join(root, 'state.json')), builtinAgents: root, catalogRefreshMs: 0 })
  t.after(() => host.dispose())
  host.register(runtime); await host.start()
  host.registry.upsert(await runtime.readSession(existing.id), existing)
  runtime.createSession = async () => existing
  let store: TranscriptStore | undefined
  const record = TranscriptStore.prototype.record
  t.mock.method(TranscriptStore.prototype, 'record', function(this: TranscriptStore, session: Parameters<typeof record>[0], options: Parameters<typeof record>[1]) {
    store = this; return record.call(this, session, options)
  })
  const result = await host.call('session/create', { runtime: runtime.info.id, options: { cwd: root } }) as Session
  assert.equal(result.id, existing.id)
  transcript(runtime, existing.id)
  assert.ok(store)
  await assert.rejects(store.flush(), /authority/i)
  assert.equal(store.protectedPressure().bodies, 1)
  await store.forget(runtime.info.id, existing.id)
})

test('a created ID with a different durable body cannot establish a missing base', async t => {
  const root = tempDir('hd-retention-create-stored-')
  const runtime = new FakeRuntime(), id = sessionId('fake-session-1')
  const external = [{ id: turnId('external'), status: 'completed' as const, items: [{ id: itemId('external'), type: 'assistantMessage' as const, text: 'kept' }] }]
  const db = new TranscriptDatabase(join(root, 'sessions.sqlite'))
  db.write({ version: 1, runtime: runtime.info.id, id, savedAt: 1, turns: external }); db.close()
  const host = new Host({ logger: silent, state: new StateStore(join(root, 'state.json')), builtinAgents: root, catalogRefreshMs: 0 })
  t.after(() => host.dispose())
  host.register(runtime); await host.start()
  let store: TranscriptStore | undefined
  const record = TranscriptStore.prototype.record
  t.mock.method(TranscriptStore.prototype, 'record', function(this: TranscriptStore, session: Parameters<typeof record>[0], options: Parameters<typeof record>[1]) {
    store = this; return record.call(this, session, options)
  })
  const created = await host.call('session/create', { runtime: runtime.info.id, options: { cwd: root } }) as Session
  assert.equal(created.id, id)
  transcript(runtime, id)
  assert.ok(store); await assert.rejects(store.flush(), /authority/i)
  const verify = new TranscriptDatabase(join(root, 'sessions.sqlite'))
  try { assert.deepEqual(verify.read(runtime.info.id, id)?.turns, external) } finally { verify.close() }
  await store.forget(runtime.info.id, id)
})

test('close keeps the Host body while another window has a read in flight', async t => {
  const root = tempDir('hd-retention-close-read-fence-')
  const host = new Host({ logger: silent, state: new StateStore(join(root, 'state.json')), builtinAgents: root, catalogRefreshMs: 0 })
  t.after(() => host.dispose())
  const runtime = new FakeRuntime(); host.register(runtime); await host.start()
  const created = await host.call('session/create', { runtime: runtime.info.id, options: { cwd: root } }) as Session
  transcript(runtime, created.id)
  const record = host.registry.get(runtime.info.id, created.id)!, body = record.session
  let release!: () => void, entered!: () => void
  const gate = new Promise<void>(resolve => { release = resolve }), started = new Promise<void>(resolve => { entered = resolve })
  runtime.readSession = async () => { entered(); await gate; return body }
  t.after(() => release())
  const reading = host.call('session/read', { runtime: body.runtime, sessionId: body.id })
  await started
  try {
    await host.call('session/close', { runtime: body.runtime, sessionId: body.id })
    assert.equal(record.session.itemsLoaded, true)
    assert.deepEqual(record.session.turns, body.turns)
  } finally { release(); await reading }
})

test('a failed close-time save retains the body until storage can accept it', async t => {
  const root = tempDir('hd-retention-failed-save-')
  const host = new Host({ logger: silent, state: new StateStore(join(root, 'state.json')), builtinAgents: root, catalogRefreshMs: 0 })
  t.after(() => host.dispose())
  const runtime = new FakeRuntime()
  host.register(runtime)
  await host.start()
  const session = await host.call('session/create', { runtime: runtime.info.id, options: { cwd: root } }) as Session
  transcript(runtime, session.id)
  const db = new DatabaseSync(join(root, 'sessions.sqlite'))
  t.after(() => db.close())
  db.exec("CREATE TRIGGER refuse_body BEFORE INSERT ON bodies BEGIN SELECT RAISE(FAIL, 'synthetic storage refusal'); END")
  const address = { runtime: runtime.info.id, sessionId: session.id }
  await host.call('session/close', address)
  assert.equal(host.registry.get(runtime.info.id, session.id)!.session.itemsLoaded, true)
  db.exec('DROP TRIGGER refuse_body')
  await host.call('session/close', address)
  assert.equal(host.registry.get(runtime.info.id, session.id)!.session.itemsLoaded, false)
})

test('a reopen that overtakes a close-time save keeps its newer live body', async t => {
  const root = tempDir('hd-retention-reopen-')
  const host = new Host({ logger: silent, state: new StateStore(join(root, 'state.json')), builtinAgents: root, catalogRefreshMs: 0 })
  t.after(() => host.dispose())
  const runtime = new FakeRuntime()
  host.register(runtime)
  await host.start()
  const session = await host.call('session/create', { runtime: runtime.info.id, options: { cwd: root } }) as Session
  transcript(runtime, session.id)
  const address = { runtime: runtime.info.id, sessionId: session.id }
  let saved!: () => void
  let continueRelease!: () => void
  const entered = new Promise<void>(resolve => { saved = resolve })
  const heldSave = new Promise<void>(resolve => { continueRelease = resolve })
  const release = TranscriptStore.prototype.releaseFromBase
  t.mock.method(TranscriptStore.prototype, 'releaseFromBase', async function(this: TranscriptStore, session: Parameters<typeof release>[0], generation: Parameters<typeof release>[1], base: Parameters<typeof release>[2], epoch: Parameters<typeof release>[3]) {
    const result = await release.call(this, session, generation, base, epoch)
    saved()
    await heldSave
    return result
  })
  t.after(() => continueRelease())
  const closing = host.call('session/close', address)
  await entered
  await host.call('session/resume', address)
  continueRelease()
  await closing
  const held = host.registry.get(runtime.info.id, session.id)!
  assert.ok(held.live)
  assert.equal(held.session.itemsLoaded, true)
  assert.ok(held.session.turns.some(turn => turn.items.some(item => item.type === 'command')))
})

test('an in-place body edit after close readback cannot release the newer body', async t => {
  const root = tempDir('hd-retention-close-alias-')
  const host = new Host({ logger: silent, state: new StateStore(join(root, 'state.json')), builtinAgents: root, catalogRefreshMs: 0 })
  t.after(() => host.dispose())
  const runtime = new FakeRuntime(); host.register(runtime); await host.start()
  let store: TranscriptStore | undefined
  const recordWrite = TranscriptStore.prototype.record
  t.mock.method(TranscriptStore.prototype, 'record', function(this: TranscriptStore, session: Parameters<typeof recordWrite>[0], options: Parameters<typeof recordWrite>[1]) {
    store = this; return recordWrite.call(this, session, options)
  })
  const created = await host.call('session/create', { runtime: runtime.info.id, options: { cwd: root } }) as Session
  transcript(runtime, created.id)
  const record = host.registry.get(runtime.info.id, created.id)!
  let release!: () => void, entered!: () => void
  const gate = new Promise<void>(resolve => { release = resolve }), started = new Promise<void>(resolve => { entered = resolve })
  const original = TranscriptStore.prototype.releaseFromBase
  t.mock.method(TranscriptStore.prototype, 'releaseFromBase', async function(this: TranscriptStore, session: Parameters<typeof original>[0], generation: Parameters<typeof original>[1], base: Parameters<typeof original>[2], epoch: Parameters<typeof original>[3]) {
    const saved = await original.call(this, session, generation, base, epoch); entered(); await gate; return saved
  })
  t.after(() => release())
  const closing = host.call('session/close', { runtime: created.runtime, sessionId: created.id })
  await started
  const item = record.session.turns[0]!.items[0] as { output: string }
  item.output = 'edited after readback'
  release(); await closing
  assert.equal(record.session.itemsLoaded, true)
  assert.equal(item.output, 'edited after readback')
  assert.ok(store); await store.flush()
  const db = new TranscriptDatabase(join(root, 'sessions.sqlite'))
  try { assert.deepEqual(db.read(created.runtime, created.id)?.turns, record.session.turns) } finally { db.close() }
})

test('a queued body from before remove and undo cannot advance authority afterward', async t => {
  const root = tempDir('hd-retention-undo-queued-')
  const host = new Host({ logger: silent, state: new StateStore(join(root, 'state.json')), builtinAgents: root, catalogRefreshMs: 0 })
  t.after(() => host.dispose())
  const runtime = new FakeRuntime(); host.register(runtime); await host.start()
  let store: TranscriptStore | undefined
  const original = TranscriptStore.prototype.record
  t.mock.method(TranscriptStore.prototype, 'record', function(this: TranscriptStore, session: Parameters<typeof original>[0], options: Parameters<typeof original>[1]) {
    store = this; return original.call(this, session, options)
  })
  const created = await host.call('session/create', { runtime: runtime.info.id, options: { cwd: root } }) as Session
  transcript(runtime, created.id)
  const record = host.registry.get(created.runtime, created.id)!, oldEpoch = record.bodyAuthorityEpoch
  host.registry.holdRemoved(created.runtime, created.id, Date.now() + 60_000)
  assert.equal(host.registry.restoreRemoved(created.runtime, created.id), record)
  assert.ok(record.bodyAuthorityEpoch > oldEpoch)
  assert.ok(store)
  await assert.rejects(store.flush(), /protected/i)
  assert.equal(store.protectedPressure().bodies, 1)
  assert.equal(record.session.itemsLoaded, true)
  await store.forget(created.runtime, created.id)
})

const FLOW = `
version: 2
name: Synthetic retention
roles:
  worker: { kind: agent, uses: implementer, count: 2, grant: read }
seed: { role: worker, title: Finish synthetic work }
rules: []
`

test('settled synthetic Flow runs stay within the retained-heap and main-thread CPU budgets', { timeout: 120_000 }, async t => {
  if (!global.gc) {
    // CI's ordinary runner needs no flags; only this bounded child exposes GC.
    const env = { ...process.env }
    delete env['NODE_TEST_CONTEXT']
    const result = await exec(process.execPath, ['--expose-gc', '--test', '--test-reporter=tap', '--test-name-pattern=settled synthetic', fileURLToPath(import.meta.url)], { timeout: 110_000, env }).catch(error => {
      t.diagnostic(String(error.stdout ?? '')) // Preserve the child's budget failure in CI's parent log.
      throw error
    })
    assert.match(result.stdout, /heapPerRun/, 'the isolated child actually ran the measurement')
    t.diagnostic(result.stdout.trim())
    return
  }
  const d = await desk(t)
  const samples: { runs: number; seats: number; heap: number }[] = []
  const starts = new Map<number, NodeJS.CpuUsage>()
  let longestTaskCpuMs = 0
  const tasks = createHook({
    // CPU consumed by this thread excludes time descheduled on a busy runner
    // and work in other threads. The 500 ms work budget stays the same.
    before(id) { starts.set(id, process.threadCpuUsage()) },
    after(id) {
      const began = starts.get(id)
      if (began !== undefined) {
        const cpu = process.threadCpuUsage(began)
        longestTaskCpuMs = Math.max(longestTaskCpuMs, (cpu.user + cpu.system) / 1000)
      }
      starts.delete(id)
    },
  })
  tasks.enable()
  t.after(() => tasks.disable())
  for (let n = 1; n <= 20; n++) {
    // Removed folders remain historical workspace rows, as in a long-lived desk.
    const folder = join(d.root, `workspace-${n}`)
    await mkdir(folder)
    await d.host.call('workspace/open', { path: folder })
    const run = await start(d, FLOW, {})
    const cards = await claimed(d, run.goal, 'worker', 2)
    for (const card of cards) {
      const id = sessionId(card.claim!.sessionId)
      const active = [...d.host.registry.get(d.runtimes[0]!.info.id, id)!.running].at(-1)
      assert.ok(active)
      transcript(d.runtimes[0]!, id, 512 * 1024, active)
      assert.doesNotMatch(await d.host.teamPlane.complete(card.id, {}, scopeOf(card)), /^Refused/)
      d.runtimes[0]!.sessions.get(id)!.finish()
      await d.host.call('session/close', { runtime: d.runtimes[0]!.info.id, sessionId: id })
    }
    await whenChanged(d, async () => (await execution(d, run.id)).state === 'settled' ? true : null, 'the run to settle')
    await rm(folder, { recursive: true })
    if ([5, 10, 20].includes(n)) {
      await immediate()
      global.gc()
      samples.push({ runs: n, seats: n * 2, heap: process.memoryUsage().heapUsed })
      if (process.env['HD_RETENTION_SNAPSHOTS']) {
        tasks.disable() // snapshot instrumentation is outside the workload budget
        const destination = join(process.env['HD_RETENTION_SNAPSHOTS'], `heap-${n}.heapsnapshot`)
        await mkdir(process.env['HD_RETENTION_SNAPSHOTS'], { recursive: true })
        await pipeline(getHeapSnapshot(), createWriteStream(destination))
        tasks.enable()
      }
    }
  }
  const first = samples[0]!, last = samples.at(-1)!
  const heapPerRun = (last.heap - first.heap) / (last.runs - first.runs)
  const heapPerSeat = heapPerRun / 2
  t.diagnostic(JSON.stringify({ samples, heapPerRun, heapPerSeat, longestTaskCpuMs }))
  assert.ok(heapPerRun < 256 * 1024, `retained heap ${heapPerRun} bytes/run exceeds 256 KiB/run (128 KiB/closed seat)`)
  assert.ok(longestTaskCpuMs < 500, `main-thread task ${longestTaskCpuMs} CPU ms exceeds 500 ms`)
  assert.ok(d.host.registry.all().every(record => !record.live && !record.session.itemsLoaded && record.watched.size === 0), 'every closed body was unloaded')
})

test('a quiet exact host body receives a storage-verified, incarnation-bound receipt', async t => {
  const root = tempDir('hd-retention-receipt-')
  const host = new Host({ logger: silent, state: new StateStore(join(root, 'state.json')), builtinAgents: root, catalogRefreshMs: 0 })
  t.after(() => host.dispose())
  const runtime = new FakeRuntime()
  host.register(runtime)
  await host.start()
  const { body, record } = await loadedReceiptFixture(host, runtime, root)
  const identity = createHash('sha256').update(canonicalTranscriptBody(body.turns).canonical).digest('hex')
  const invoke = host.call.bind(host) as unknown as (method: string, params: unknown) => Promise<{ epoch: string; generation: string; revision: number; identity: string } | null>
  const receipt = await invoke('session/prepare-eviction', { runtime: body.runtime, sessionId: body.id, identity }).catch(error => assert.fail(`receipt method failed: ${String(error)}`))
  assert.ok(receipt)
  assert.equal(receipt!.identity, identity)
  assert.equal(receipt!.generation, record.bodyGeneration)
  assert.equal(receipt!.revision, record.bodyRevision)
  assert.ok(receipt!.epoch)
  assert.equal(await invoke('session/prepare-eviction', { runtime: body.runtime, sessionId: body.id, identity: '0'.repeat(64) }), null)
  record.session = { ...record.session, partialHistory: true }
  assert.equal(await invoke('session/prepare-eviction', { runtime: body.runtime, sessionId: body.id, identity }), null, 'partial history cannot authorize eviction')
})

test('first exact receipt advances a known-missing base for later snapshots', async t => {
  const root = tempDir('hd-retention-first-receipt-')
  const host = new Host({ logger: silent, state: new StateStore(join(root, 'state.json')), builtinAgents: root, catalogRefreshMs: 0 })
  t.after(() => host.dispose())
  const runtime = new FakeRuntime(); host.register(runtime); await host.start()
  const created = await host.call('session/create', { runtime: runtime.info.id, options: { cwd: root } }) as Session
  const record = host.registry.get(created.runtime, created.id)!
  record.session = { ...record.session, itemsLoaded: true, turns: [{ id: turnId('one'), status: 'completed',
    items: [{ id: itemId('i'), type: 'assistantMessage', text: 'saved' }] }] }
  record.live = null; record.cacheClosed = true
  const identity = createHash('sha256').update(canonicalTranscriptBody(record.session.turns).canonical).digest('hex')
  assert.equal(await host.call('session/prepare-eviction', { runtime: created.runtime, sessionId: created.id, identity }), null, 'the first write invalidates the prior cursor')
  assert.ok(await host.call('session/cache-snapshot', { runtime: created.runtime, sessionId: created.id }))
  assert.ok(await host.call('session/prepare-eviction', { runtime: created.runtime, sessionId: created.id, identity }))
})

test('an idle handle-free record earns a cache receipt only after explicit close', async t => {
  const root = tempDir('hd-retention-explicit-close-')
  const host = new Host({ logger: silent, state: new StateStore(join(root, 'state.json')), builtinAgents: root, catalogRefreshMs: 0 })
  t.after(() => host.dispose())
  const runtime = new FakeRuntime(); host.register(runtime); await host.start()
  const created = await host.call('session/create', { runtime: runtime.info.id, options: { cwd: root } }) as Session
  const record = host.registry.get(created.runtime, created.id)!
  record.session = { ...record.session, turns: [{ id: turnId('one'), status: 'completed', items: [{ id: itemId('i'), type: 'assistantMessage', text: 'saved' }] }], itemsLoaded: true }
  record.live = null
  const identity = createHash('sha256').update(canonicalTranscriptBody(record.session.turns).canonical).digest('hex')
  assert.equal(await host.call('session/prepare-eviction', { runtime: created.runtime, sessionId: created.id, identity }), null)
  await host.call('session/close', { runtime: created.runtime, sessionId: created.id })
  assert.ok(await host.call('session/prepare-eviction', { runtime: created.runtime, sessionId: created.id, identity }))
  await host.call('session/read', { runtime: created.runtime, sessionId: created.id })
  assert.equal(await host.call('session/prepare-eviction', { runtime: created.runtime, sessionId: created.id, identity }), null)
})

test('cache snapshot returns the current full Host body and its atomic watermark', async t => {
  const root = tempDir('hd-retention-cache-snapshot-')
  const host = new Host({ logger: silent, state: new StateStore(join(root, 'state.json')), builtinAgents: root, catalogRefreshMs: 0 })
  t.after(() => host.dispose())
  const runtime = new FakeRuntime(); host.register(runtime); await host.start()
  let store: TranscriptStore | undefined
  const original = TranscriptStore.prototype.record
  t.mock.method(TranscriptStore.prototype, 'record', function(this: TranscriptStore, session: Parameters<typeof original>[0], options: Parameters<typeof original>[1]) {
    store = this; return original.call(this, session, options)
  })
  const created = await host.call('session/create', { runtime: runtime.info.id, options: { cwd: root } }) as Session
  transcript(runtime, created.id)
  const active = await host.call('session/cache-snapshot', { runtime: created.runtime, sessionId: created.id })
  assert.ok(active, 'the complete live body can be read before pending persistence settles')
  assert.deepEqual(active.session.turns, host.registry.get(created.runtime, created.id)!.session.turns)
  assert.equal(await host.call('session/prepare-eviction', { runtime: created.runtime, sessionId: created.id, identity: active.identity }), null,
    'a readable active snapshot does not authorize unloading')
  assert.ok(store); await store.flush()
  const snapshot = await host.call('session/cache-snapshot', { runtime: created.runtime, sessionId: created.id })
  assert.ok(snapshot)
  assert.equal(snapshot.watermark.generation, host.registry.get(created.runtime, created.id)!.bodyGeneration)
  assert.equal(snapshot.watermark.revision, host.registry.get(created.runtime, created.id)!.bodyRevision)
  assert.equal(snapshot.identity, createHash('sha256').update(canonicalTranscriptBody(snapshot.session.turns).canonical).digest('hex'))
  await host.call('session/close', { runtime: created.runtime, sessionId: created.id })
  let sourceReads = 0
  runtime.readSession = async () => { sourceReads++; throw new Error('cache snapshot must not read the agent') }
  const revision = host.registry.get(created.runtime, created.id)!.bodyRevision
  const closed = await host.call('session/cache-snapshot', { runtime: created.runtime, sessionId: created.id })
  assert.ok(closed)
  assert.deepEqual(closed.session.turns, snapshot.session.turns)
  assert.equal(host.registry.get(created.runtime, created.id)!.session.itemsLoaded, false)
  assert.equal(host.registry.get(created.runtime, created.id)!.cacheClosed, true)
  assert.equal(host.registry.get(created.runtime, created.id)!.bodyRevision, revision)
  assert.equal(sourceReads, 0)
})

test('an unchanged exact receipt carries the current sequence without invalidating it', async t => {
  const root = tempDir('hd-retention-receipt-sequence-')
  const host = new Host({ logger: silent, state: new StateStore(join(root, 'state.json')), builtinAgents: root, catalogRefreshMs: 0 })
  t.after(() => host.dispose())
  const runtime = new FakeRuntime(); host.register(runtime); await host.start()
  const { body } = await loadedReceiptFixture(host, runtime, root)
  const address = { runtime: body.runtime, sessionId: body.id }
  const snapshot = await host.call('session/cache-snapshot', address); assert.ok(snapshot)
  const notifications: any[] = []; host.addBroadcaster(event => notifications.push(event))
  const receipt = await host.call('session/prepare-eviction', { ...address, identity: snapshot.identity }); assert.ok(receipt)
  assert.equal(receipt.sequence, snapshot.watermark.sequence)
  assert.equal(notifications.filter(event => event.method === 'session/cache-invalidated').length, 0)
})

test('a sequenced notification during verification invalidates the receipt without a body mutation', async t => {
  const root = tempDir('hd-retention-receipt-cursor-race-')
  const host = new Host({ logger: silent, state: new StateStore(join(root, 'state.json')), builtinAgents: root, catalogRefreshMs: 0 })
  t.after(() => host.dispose())
  const runtime = new FakeRuntime(); host.register(runtime); await host.start()
  const { body, record } = await loadedReceiptFixture(host, runtime, root)
  let release!: () => void, entered!: () => void
  const gate = new Promise<void>(resolve => { release = resolve }), started = new Promise<void>(resolve => { entered = resolve })
  const original = TranscriptStore.prototype.persistExactBody
  t.mock.method(TranscriptStore.prototype, 'persistExactBody', async function(this: TranscriptStore, ...args: Parameters<typeof original>) {
    const result = await original.apply(this, args); entered(); await gate; return result
  })
  t.after(() => release())
  const identity = createHash('sha256').update(canonicalTranscriptBody(body.turns).canonical).digest('hex')
  const revision = record.bodyRevision
  const pending = host.call('session/prepare-eviction', { runtime: body.runtime, sessionId: body.id, identity })
  await started
  runtime.emit({ type: 'approval/resolved', sessionId: body.id, approvalId: approvalId('synthetic-absent'), resolution: { outcome: 'decided', decision: { type: 'cancel' } } })
  assert.equal(record.bodyRevision, revision, 'the control changes only the notification sequence')
  release()
  assert.equal(await pending, null)
})

test('a loaded snapshot refuses an externally changed durable base', async t => {
  const root = tempDir('hd-retention-snapshot-base-')
  const host = new Host({ logger: silent, state: new StateStore(join(root, 'state.json')), builtinAgents: root, catalogRefreshMs: 0 })
  t.after(() => host.dispose())
  const runtime = new FakeRuntime(); host.register(runtime); await host.start()
  let store: TranscriptStore | undefined
  const original = TranscriptStore.prototype.record
  t.mock.method(TranscriptStore.prototype, 'record', function(this: TranscriptStore, session: Parameters<typeof original>[0], options: Parameters<typeof original>[1]) {
    store = this; return original.call(this, session, options)
  })
  const created = await host.call('session/create', { runtime: runtime.info.id, options: { cwd: root } }) as Session
  transcript(runtime, created.id)
  assert.ok(store); await store.flush()
  const db = new TranscriptDatabase(join(root, 'sessions.sqlite'))
  try {
    const existing = db.read(created.runtime, created.id); assert.ok(existing)
    db.write({ ...existing, title: 'external changed metadata' })
    assert.equal(await host.call('session/cache-snapshot', { runtime: created.runtime, sessionId: created.id }), null)
  } finally { db.close() }
})

test('a loaded closed body cannot verify a newer external Insight base', async t => {
  const root = tempDir('hd-retention-loaded-insight-base-')
  const host = new Host({ logger: silent, state: new StateStore(join(root, 'state.json')), builtinAgents: root, catalogRefreshMs: 0 })
  t.after(() => host.dispose())
  const runtime = new FakeRuntime(); host.register(runtime); await host.start()
  let store: TranscriptStore | undefined
  const original = TranscriptStore.prototype.record
  t.mock.method(TranscriptStore.prototype, 'record', function(this: TranscriptStore, session: Parameters<typeof original>[0], options: Parameters<typeof original>[1]) {
    store = this; return original.call(this, session, options)
  })
  const created = await host.call('session/create', { runtime: runtime.info.id, options: { cwd: root } }) as Session
  transcript(runtime, created.id)
  assert.ok(store); await store.flush()
  const body = host.registry.get(created.runtime, created.id)!.session
  const identity = createHash('sha256').update(canonicalTranscriptBody(body.turns).canonical).digest('hex')
  const record = host.registry.get(created.runtime, created.id)!
  record.live = null
  record.cacheClosed = true
  assert.equal(record.session.itemsLoaded, true)
  const db = new TranscriptDatabase(join(root, 'sessions.sqlite'))
  try {
    const existing = db.read(created.runtime, created.id); assert.ok(existing)
    const insight = [{ turn: String(body.turns[0]!.id), startedAt: 1, endedAt: 2, seat: 'synthetic', cause: { kind: 'person' as const },
      parent: null, before: null, after: null, generation: '', observedAt: 2, loaded: null }]
    db.write({ ...existing, insight })
    assert.equal(await host.call('session/prepare-eviction', { runtime: created.runtime, sessionId: created.id, identity }), null)
    assert.deepEqual(db.read(created.runtime, created.id)?.insight, insight)
  } finally { db.close(); await store.forget(created.runtime, created.id) }
})

test('a released body cannot obtain a receipt against externally changed durable metadata', async t => {
  const root = tempDir('hd-retention-released-base-')
  const host = new Host({ logger: silent, state: new StateStore(join(root, 'state.json')), builtinAgents: root, catalogRefreshMs: 0 })
  t.after(() => host.dispose())
  const runtime = new FakeRuntime(); host.register(runtime); await host.start()
  const created = await host.call('session/create', { runtime: runtime.info.id, options: { cwd: root } }) as Session
  transcript(runtime, created.id)
  const body = host.registry.get(created.runtime, created.id)!.session
  const identity = createHash('sha256').update(canonicalTranscriptBody(body.turns).canonical).digest('hex')
  await host.call('session/close', { runtime: created.runtime, sessionId: created.id })
  assert.equal(host.registry.get(created.runtime, created.id)!.session.itemsLoaded, false)
  const db = new TranscriptDatabase(join(root, 'sessions.sqlite'))
  try {
    const existing = db.read(created.runtime, created.id); assert.ok(existing)
    db.write({ ...existing, title: 'external changed metadata' })
    assert.equal(await host.call('session/prepare-eviction', { runtime: created.runtime, sessionId: created.id, identity }), null)
  } finally { db.close() }
})

test('a loaded receipt refuses an Insight change between base check and write', async t => {
  const root = tempDir('hd-retention-receipt-insight-race-')
  const host = new Host({ logger: silent, state: new StateStore(join(root, 'state.json')), builtinAgents: root, catalogRefreshMs: 0 })
  t.after(() => host.dispose())
  const runtime = new FakeRuntime(); host.register(runtime); await host.start()
  const { body } = await loadedReceiptFixture(host, runtime, root)
  const insight = [{ turn: String(body.turns[0]!.id), startedAt: 1, endedAt: 2, seat: 'synthetic', cause: { kind: 'person' as const },
    parent: null, before: null, after: null, generation: '', observedAt: 2, loaded: null }]
  const original = TranscriptStore.prototype.persistExactBody
  t.mock.method(TranscriptStore.prototype, 'persistExactBody', async function(this: TranscriptStore, ...args: Parameters<typeof original>) {
    const db = new TranscriptDatabase(join(root, 'sessions.sqlite'))
    try { const stored = db.read(body.runtime, body.id); assert.ok(stored); db.write({ ...stored, insight }) } finally { db.close() }
    return original.apply(this, args)
  })
  const identity = createHash('sha256').update(canonicalTranscriptBody(body.turns).canonical).digest('hex')
  assert.equal(await host.call('session/prepare-eviction', { runtime: body.runtime, sessionId: body.id, identity }), null)
  const db = new TranscriptDatabase(join(root, 'sessions.sqlite'))
  try { assert.deepEqual(db.read(body.runtime, body.id)?.insight, insight) } finally { db.close() }
})

test('a released receipt refuses an Insight change between recovery and write', async t => {
  const root = tempDir('hd-retention-released-insight-race-')
  const host = new Host({ logger: silent, state: new StateStore(join(root, 'state.json')), builtinAgents: root, catalogRefreshMs: 0 })
  t.after(() => host.dispose())
  const runtime = new FakeRuntime(); host.register(runtime); await host.start()
  const created = await host.call('session/create', { runtime: runtime.info.id, options: { cwd: root } }) as Session
  transcript(runtime, created.id)
  const body = host.registry.get(created.runtime, created.id)!.session
  await host.call('session/close', { runtime: created.runtime, sessionId: created.id })
  assert.equal(host.registry.get(created.runtime, created.id)!.session.itemsLoaded, false)
  const insight = [{ turn: String(body.turns[0]!.id), startedAt: 1, endedAt: 2, seat: 'synthetic', cause: { kind: 'person' as const },
    parent: null, before: null, after: null, generation: '', observedAt: 2, loaded: null }]
  const original = TranscriptStore.prototype.persistExactBody
  t.mock.method(TranscriptStore.prototype, 'persistExactBody', async function(this: TranscriptStore, ...args: Parameters<typeof original>) {
    const db = new TranscriptDatabase(join(root, 'sessions.sqlite'))
    try { const stored = db.read(body.runtime, body.id); assert.ok(stored); db.write({ ...stored, insight }) } finally { db.close() }
    return original.apply(this, args)
  })
  const identity = createHash('sha256').update(canonicalTranscriptBody(body.turns).canonical).digest('hex')
  assert.equal(await host.call('session/prepare-eviction', { runtime: body.runtime, sessionId: body.id, identity }), null)
  const db = new TranscriptDatabase(join(root, 'sessions.sqlite'))
  try { assert.deepEqual(db.read(body.runtime, body.id)?.insight, insight) } finally { db.close() }
})

test('a host body mutation during verification invalidates the pending eviction receipt', async t => {
  const root = tempDir('hd-retention-receipt-race-')
  const host = new Host({ logger: silent, state: new StateStore(join(root, 'state.json')), builtinAgents: root, catalogRefreshMs: 0 })
  t.after(() => host.dispose())
  const runtime = new FakeRuntime(); host.register(runtime); await host.start()
  const { body, record } = await loadedReceiptFixture(host, runtime, root)
  let release!: () => void; let entered!: () => void
  const gate = new Promise<void>(resolve => { release = resolve }); const started = new Promise<void>(resolve => { entered = resolve })
  const original = TranscriptStore.prototype.persistExactBody
  t.mock.method(TranscriptStore.prototype, 'persistExactBody', async function(this: TranscriptStore, hostBody: Session, candidate: Session, base: Parameters<typeof original>[2]) {
    const verified = await original.call(this, hostBody, candidate, base); entered(); await gate; return verified
  })
  t.after(() => release())
  const identity = createHash('sha256').update(canonicalTranscriptBody(body.turns).canonical).digest('hex')
  const invoke = host.call.bind(host) as unknown as (method: string, params: unknown) => Promise<unknown>
  const pending = invoke('session/prepare-eviction', { runtime: body.runtime, sessionId: body.id, identity })
  await started
  record.session = { ...record.session, turns: [...record.session.turns, { id: turnId('later'), status: 'completed', items: [] }] }
  release()
  assert.equal(await pending, null)
})

test('a closed Host body can be verified against its saved SQLite body', async t => {
  const root = tempDir('hd-retention-closed-receipt-')
  const host = new Host({ logger: silent, state: new StateStore(join(root, 'state.json')), builtinAgents: root, catalogRefreshMs: 0 })
  t.after(() => host.dispose())
  const runtime = new FakeRuntime(); host.register(runtime); await host.start()
  const created = await host.call('session/create', { runtime: runtime.info.id, options: { cwd: root } }) as Session
  transcript(runtime, created.id)
  const before = host.registry.get(runtime.info.id, created.id)!.session
  const identity = createHash('sha256').update(canonicalTranscriptBody(before.turns).canonical).digest('hex')
  await host.call('session/close', { runtime: runtime.info.id, sessionId: created.id })
  assert.equal(host.registry.get(runtime.info.id, created.id)!.session.itemsLoaded, false)
  const receipt = await host.call('session/prepare-eviction', { runtime: runtime.info.id, sessionId: created.id, identity })
  assert.ok(receipt, 'the released host copy remains independently verifiable from SQLite')
})

test('an in-place transcript mutation during verification invalidates the receipt', async t => {
  const root = tempDir('hd-retention-receipt-inplace-')
  const host = new Host({ logger: silent, state: new StateStore(join(root, 'state.json')), builtinAgents: root, catalogRefreshMs: 0 })
  t.after(() => host.dispose())
  const runtime = new FakeRuntime(); host.register(runtime); await host.start()
  const { body, record } = await loadedReceiptFixture(host, runtime, root)
  let release!: () => void; let entered!: () => void
  const gate = new Promise<void>(resolve => { release = resolve }); const started = new Promise<void>(resolve => { entered = resolve })
  const original = TranscriptStore.prototype.persistExactBody
  t.mock.method(TranscriptStore.prototype, 'persistExactBody', async function(this: TranscriptStore, hostBody: Session, candidate: Session, base: Parameters<typeof original>[2]) {
    const verified = await original.call(this, hostBody, candidate, base); entered(); await gate; return verified
  })
  t.after(() => release())
  const identity = createHash('sha256').update(canonicalTranscriptBody(body.turns).canonical).digest('hex')
  const pending = host.call('session/prepare-eviction', { runtime: body.runtime, sessionId: body.id, identity })
  await started
  ;(record.session.turns[0]!.items[0] as { text: string }).text = 'newer in place'
  release()
  assert.equal(await pending, null)
})

test('body events carry the host generation and revision that folded the event', async t => {
  const root = tempDir('hd-retention-event-fence-')
  const host = new Host({ logger: silent, state: new StateStore(join(root, 'state.json')), builtinAgents: root, catalogRefreshMs: 0 })
  t.after(() => host.dispose())
  const runtime = new FakeRuntime(); host.register(runtime); await host.start()
  const created = await host.call('session/create', { runtime: runtime.info.id, options: { cwd: root } }) as Session
  const events: unknown[] = []
  host.addBroadcaster(event => events.push(event))
  transcript(runtime, created.id)
  const event = events.findLast((v: any) => v.method === 'event' && v.params.event.type === 'turn/completed') as { params: { transcriptFence?: { epoch: string; generation: string; revision: number } } } | undefined
  assert.ok(event?.params.transcriptFence, 'folded transcript event must carry its host fence')
  const record = host.registry.get(runtime.info.id, created.id)!
  assert.equal(event.params.transcriptFence.generation, record.bodyGeneration)
  assert.equal(event.params.transcriptFence.revision, record.bodyRevision)
  assert.ok(event.params.transcriptFence.epoch)
})

test('delivered conversation events carry contiguous per-record sequences', async t => {
  const root = tempDir('hd-retention-event-sequence-')
  const host = new Host({ logger: silent, state: new StateStore(join(root, 'state.json')), builtinAgents: root, catalogRefreshMs: 0 })
  t.after(() => host.dispose())
  const runtime = new FakeRuntime(); host.register(runtime); await host.start()
  const created = await host.call('session/create', { runtime: runtime.info.id, options: { cwd: root } }) as Session
  const events: any[] = []; host.addBroadcaster(event => events.push(event))
  transcript(runtime, created.id)
  const fences = events.filter(entry => entry.method === 'event' && entry.params.event.sessionId === created.id).map(entry => entry.params.transcriptFence)
  assert.ok(fences.length >= 3)
  assert.ok(fences.every(fence => Number.isSafeInteger(fence?.sequence)))
  for (let index = 1; index < fences.length; index++) assert.equal(fences[index].sequence, fences[index - 1].sequence + 1)
})

test('a silent Host session mutation emits a sequenced cache invalidation', async t => {
  const root = tempDir('hd-retention-silent-invalidation-')
  const host = new Host({ logger: silent, state: new StateStore(join(root, 'state.json')), builtinAgents: root, catalogRefreshMs: 0 })
  t.after(() => host.dispose())
  const runtime = new FakeRuntime(); host.register(runtime); await host.start()
  const created = await host.call('session/create', { runtime: runtime.info.id, options: { cwd: root } }) as Session
  const record = host.registry.get(created.runtime, created.id)!
  const events: any[] = []; host.addBroadcaster(event => events.push(event))
  record.session = { ...record.session, title: 'changed locally' }
  runtime.emit({ type: 'session/status', sessionId: created.id, status: { type: 'idle' } })
  const invalidation = events.find(entry => entry.method === 'session/cache-invalidated')
  const event = events.find(entry => entry.method === 'event' && entry.params.event.type === 'session/status')
  assert.ok(invalidation); assert.ok(event)
  assert.equal(invalidation.params.sessionId, created.id)
  assert.equal(event.params.transcriptFence.sequence, invalidation.params.watermark.sequence + 1)
})

test('silent handle and queue ownership changes invalidate a cache watermark', async t => {
  const root = tempDir('hd-retention-ownership-invalidation-')
  const host = new Host({ logger: silent, state: new StateStore(join(root, 'state.json')), builtinAgents: root, catalogRefreshMs: 0 })
  t.after(() => host.dispose())
  const runtime = new FakeRuntime(); host.register(runtime); await host.start()
  const created = await host.call('session/create', { runtime: runtime.info.id, options: { cwd: root } }) as Session
  const record = host.registry.get(created.runtime, created.id)!, live = record.live
  const events: any[] = []; host.addBroadcaster(event => events.push(event))
  record.live = null
  record.live = live
  host.registry.enqueue(record, 'queued', [{ type: 'text', text: 'synthetic' }])
  const invalidations = events.filter(entry => entry.method === 'session/cache-invalidated')
  assert.equal(invalidations.length, 3)
  for (let index = 1; index < invalidations.length; index++) assert.equal(invalidations[index].params.watermark.sequence, invalidations[index - 1].params.watermark.sequence + 1)
})

test('a verified transcript import invalidates the current Host cache watermark', async t => {
  const root = tempDir('hd-retention-import-invalidation-')
  const host = new Host({ logger: silent, state: new StateStore(join(root, 'state.json')), builtinAgents: root, catalogRefreshMs: 0 })
  t.after(() => host.dispose())
  const runtime = new FakeRuntime(); host.register(runtime); await host.start()
  let store: TranscriptStore | undefined
  const recordWrite = TranscriptStore.prototype.record
  t.mock.method(TranscriptStore.prototype, 'record', function(this: TranscriptStore, session: Parameters<typeof recordWrite>[0], options: Parameters<typeof recordWrite>[1]) {
    store = this; return recordWrite.call(this, session, options)
  })
  const created = await host.call('session/create', { runtime: runtime.info.id, options: { cwd: root } }) as Session
  transcript(runtime, created.id)
  assert.ok(store); await store.flush()
  const exported = (await store.exportAll()).find(row => row.id === created.id); assert.ok(exported)
  const saved = exported.data as { savedAt: number; turns: readonly import('@harnessdesk/protocol').Turn[] }
  const events: any[] = []; host.addBroadcaster(event => events.push(event))
  assert.equal(await store.importOne(created.runtime, created.id, { ...exported.data as object, savedAt: saved.savedAt + 1,
    turns: [...saved.turns, { id: turnId('imported'), status: 'completed', items: [{ id: itemId('imported'), type: 'assistantMessage', text: 'imported' }] }] }), 'restored')
  assert.ok(events.some(entry => entry.method === 'session/cache-invalidated' && entry.params.sessionId === created.id))
  assert.equal(await host.call('session/cache-snapshot', { runtime: created.runtime, sessionId: created.id }), null)
  await host.call('session/read', { runtime: created.runtime, sessionId: created.id })
  const reconciled = await host.call('session/cache-snapshot', { runtime: created.runtime, sessionId: created.id })
  assert.ok(reconciled, 'an independently reconciled current Host body is readable again')
  assert.deepEqual(reconciled.session.turns, host.registry.get(created.runtime, created.id)!.session.turns)
})

test('a stale session-started replay cannot replace an unsaved equal-count item', async t => {
  const root = tempDir('hd-retention-pending-same-item-')
  const host = new Host({ logger: silent, state: new StateStore(join(root, 'state.json')), builtinAgents: root, catalogRefreshMs: 0 })
  t.after(() => host.dispose().catch(() => {}))
  const runtime = new FakeRuntime(); host.register(runtime); await host.start()
  const queued: Session[] = [], captures: PendingTranscript[] = []
  const completion = t.mock.method(LoadoutRecorder.prototype, 'turnCompleted')
  let store: TranscriptStore | undefined
  const retain = PendingTranscript.prototype.retainLocal
  t.mock.method(PendingTranscript.prototype, 'retainLocal', function(this: PendingTranscript, ...args: Parameters<typeof retain>) {
    if (!captures.includes(this)) captures.push(this)
    return retain.apply(this, args)
  })
  const original = TranscriptStore.prototype.record
  t.mock.method(TranscriptStore.prototype, 'record', function(this: TranscriptStore, session: Parameters<typeof original>[0], options: Parameters<typeof original>[1]) {
    store = this; queued.push(structuredClone(session)); return original.call(this, session, options)
  })
  const created = await host.call('session/create', { runtime: runtime.info.id, options: { cwd: root } }) as Session
  const turn = { id: turnId('one'), status: 'inProgress' as const, items: [] }
  runtime.emit({ type: 'turn/started', sessionId: created.id, turn })
  runtime.emit({ type: 'item/completed', sessionId: created.id, turnId: turn.id,
    item: { id: itemId('one'), type: 'assistantMessage', text: 'unsaved newer text' } })
  const record = host.registry.get(created.runtime, created.id)!
  const stale: Session = { ...record.session, turns: [{ ...record.session.turns[0]!,
    items: [{ id: itemId('one'), type: 'assistantMessage', text: 'stale replay' }] }] }
  runtime.emit({ type: 'session/started', session: stale })
  assert.ok(queued.some(session => session.turns.some(turn => turn.items.some(item => item.type === 'assistantMessage' && item.text === 'unsaved newer text'))))
  const latest = queued.at(-1)?.turns[0]?.items[0]
  assert.ok(!latest || latest.type !== 'assistantMessage' || latest.text !== 'stale replay', 'a stale replay must not replace the unsaved queued snapshot')
  assert.equal(await host.call('session/cache-snapshot', { runtime: created.runtime, sessionId: created.id }), null,
    'an ambiguous replay cannot be advertised as a complete snapshot')
  const identity = createHash('sha256').update(canonicalTranscriptBody(record.session.turns).canonical).digest('hex')
  assert.equal(await host.call('session/prepare-eviction', { runtime: created.runtime, sessionId: created.id, identity }), null)
  assert.equal(record.transcriptIncomplete, true)
  assert.equal(record.session.itemsLoaded, false)
  assert.equal(captures.length, 1)
  const captured = JSON.stringify(captures[0]!.inspect())
  assert.ok(captured.includes('unsaved newer text'), 'the original unsaved item remains captured')
  assert.ok(captured.includes('stale replay'), 'the conflicting replay is retained separately')
  runtime.emit({ type: 'item/delta', sessionId: created.id, turnId: turn.id, itemId: itemId('one'),
    delta: { kind: 'assistantText', text: 'later activity' } })
  assert.ok(JSON.stringify(captures[0]!.inspect()).includes('later activity'), 'later typed activity is captured')
  for (let i = 0; i < 2; i++) runtime.emit({ type: 'item/delta', sessionId: created.id, turnId: turn.id, itemId: itemId('one'),
    delta: { kind: 'assistantText', text: 'repeat' } })
  runtime.emit({ type: 'turn/completed', sessionId: created.id, turn: { ...turn, status: 'completed' } })
  assert.equal(completion.mock.callCount(), 1, 'Host completion side effects run once while the body is withheld')
  assert.ok(JSON.stringify(captures[0]!.inspect()).includes('repeatrepeat'), 'identical later deltas retain both occurrences in local order')
  record.invalidateBodyAuthority()
  runtime.emit({ type: 'item/delta', sessionId: created.id, turnId: turn.id, itemId: itemId('one'),
    delta: { kind: 'assistantText', text: 'new epoch activity' } })
  assert.equal(captures.length, 2, 'a new authority epoch receives a separate quarantine')
  assert.ok(!JSON.stringify(captures[0]!.inspect()).includes('new epoch activity'))
  assert.ok(JSON.stringify(captures[1]!.inspect()).includes('new epoch activity'))
  assert.ok(store)
  await assert.rejects(store.flush(), /protected/i)
  await assert.rejects(host.call('session/read', { runtime: created.runtime, sessionId: created.id }), /unsaved|unavailable/i)
  await assert.rejects(host.dispose(), /unsaved|protected/i)
})

test('explicit deletion clears quarantined activity without lending it to a later record', async t => {
  const root = tempDir('hd-retention-conflict-delete-')
  const host = new Host({ logger: silent, state: new StateStore(join(root, 'state.json')), builtinAgents: root, catalogRefreshMs: 0 })
  t.after(() => host.dispose().catch(() => {}))
  const runtime = new FakeRuntime(); host.register(runtime); await host.start()
  const created = await host.call('session/create', { runtime: runtime.info.id, options: { cwd: root } }) as Session
  const turn = { id: turnId('one'), status: 'inProgress' as const, items: [] }
  runtime.emit({ type: 'turn/started', sessionId: created.id, turn })
  runtime.emit({ type: 'item/completed', sessionId: created.id, turnId: turn.id,
    item: { id: itemId('one'), type: 'assistantMessage', text: 'unsaved' } })
  const record = host.registry.get(created.runtime, created.id)!
  runtime.emit({ type: 'session/started', session: { ...record.session, turns: [{ ...record.session.turns[0]!,
    items: [{ id: itemId('one'), type: 'assistantMessage', text: 'conflict' }] }] } })
  assert.equal(record.transcriptIncomplete, true)
  await host.call('session/delete', { runtime: created.runtime, sessionId: created.id })
  assert.equal(host.registry.get(created.runtime, created.id), undefined)
  const replacement = host.registry.upsert(created, null)
  assert.notEqual(replacement.bodyGeneration, record.bodyGeneration)
  assert.equal(replacement.transcriptIncomplete, false)
  await host.dispose()
})

test('deletion does not discard a new authority epoch that arrives during the delete', async t => {
  const root = tempDir('hd-retention-conflict-delete-race-')
  const host = new Host({ logger: silent, state: new StateStore(join(root, 'state.json')), builtinAgents: root, catalogRefreshMs: 0 })
  t.after(() => host.dispose().catch(() => {}))
  const runtime = new FakeRuntime(); host.register(runtime); await host.start()
  const captures: PendingTranscript[] = [], retain = PendingTranscript.prototype.retainLocal
  t.mock.method(PendingTranscript.prototype, 'retainLocal', function(this: PendingTranscript, ...args: Parameters<typeof retain>) {
    if (!captures.includes(this)) captures.push(this); return retain.apply(this, args)
  })
  const created = await host.call('session/create', { runtime: runtime.info.id, options: { cwd: root } }) as Session
  const turn = { id: turnId('one'), status: 'inProgress' as const, items: [] }
  runtime.emit({ type: 'turn/started', sessionId: created.id, turn })
  runtime.emit({ type: 'item/completed', sessionId: created.id, turnId: turn.id,
    item: { id: itemId('one'), type: 'assistantMessage', text: 'unsaved' } })
  const record = host.registry.get(created.runtime, created.id)!
  runtime.emit({ type: 'session/started', session: { ...record.session, turns: [{ ...record.session.turns[0]!,
    items: [{ id: itemId('one'), type: 'assistantMessage', text: 'conflict' }] }] } })
  const remove = runtime.deleteSession.bind(runtime)
  runtime.deleteSession = async id => {
    record.invalidateBodyAuthority()
    runtime.emit({ type: 'item/delta', sessionId: id, turnId: turn.id, itemId: itemId('one'),
      delta: { kind: 'assistantText', text: 'new epoch during deletion' } })
    return remove(id)
  }
  await host.call('session/delete', { runtime: created.runtime, sessionId: created.id })
  assert.equal(captures.length, 2)
  assert.ok(JSON.stringify(captures[1]!.inspect()).includes('new epoch during deletion'))
  await assert.rejects(host.dispose(), /unsaved|protected/i)
})

test('a late item after host body release retains the saved turns before folding it', async t => {
  const root = tempDir('hd-retention-late-event-')
  const host = new Host({ logger: silent, state: new StateStore(join(root, 'state.json')), builtinAgents: root, catalogRefreshMs: 0 })
  t.after(() => host.dispose())
  const runtime = new FakeRuntime(); host.register(runtime); await host.start()
  const created = await host.call('session/create', { runtime: runtime.info.id, options: { cwd: root } }) as Session
  transcript(runtime, created.id)
  const prior = host.registry.get(runtime.info.id, created.id)!.session.turns
  await host.call('session/close', { runtime: runtime.info.id, sessionId: created.id })
  assert.equal(host.registry.get(runtime.info.id, created.id)!.session.itemsLoaded, false)
  runtime.emit({ type: 'item/completed', sessionId: created.id, turnId: prior[0]!.id,
    item: { id: itemId('late'), type: 'assistantMessage', text: 'late item' } })
  const actual = host.registry.get(runtime.info.id, created.id)!.session
  assert.equal(actual.itemsLoaded, true)
  assert.deepEqual(actual.turns[0]?.items, [...prior[0]!.items, { id: itemId('late'), type: 'assistantMessage', text: 'late item' }])
})

test('a transient late-event read failure protects old storage and reconciles new output once', async t => {
  const root = tempDir('hd-retention-late-unavailable-')
  const host = new Host({ logger: silent, state: new StateStore(join(root, 'state.json')), builtinAgents: root, catalogRefreshMs: 0 })
  t.after(() => host.dispose())
  const runtime = new FakeRuntime(); host.register(runtime); await host.start()
  const notifications: any[] = []; host.addBroadcaster(event => notifications.push(event))
  const created = await host.call('session/create', { runtime: runtime.info.id, options: { cwd: root } }) as Session
  transcript(runtime, created.id)
  const prior = host.registry.get(runtime.info.id, created.id)!.session.turns
  await host.call('session/close', { runtime: runtime.info.id, sessionId: created.id })
  let unavailable = true
  const original = TranscriptStore.prototype.readRetainedTurnsAtBase
  t.mock.method(TranscriptStore.prototype, 'readRetainedTurnsAtBase', function(this: TranscriptStore, runtimeId: Parameters<typeof original>[0], id: Parameters<typeof original>[1], identity: Parameters<typeof original>[2]) {
    return unavailable ? null : original.call(this, runtimeId, id, identity)
  })
  const item = { id: itemId('late'), type: 'assistantMessage' as const, text: '' }
  runtime.emit({ type: 'item/started', sessionId: created.id, turnId: prior[0]!.id, item })
  runtime.emit({ type: 'item/delta', sessionId: created.id, turnId: prior[0]!.id, itemId: item.id, delta: { kind: 'assistantText', text: 'new output' } })
  const record = host.registry.get(runtime.info.id, created.id)!
  assert.equal((record as unknown as { transcriptIncomplete?: boolean }).transcriptIncomplete, true)
  const db = new DatabaseSync(join(root, 'sessions.sqlite'), { readOnly: true })
  try {
    const row = db.prepare('SELECT payload FROM items WHERE runtime=? AND id=? ORDER BY position,seq').all(runtime.info.id, created.id)
    assert.equal(row.length, prior[0]!.items.length, 'partial new data must not overwrite saved rows')
  } finally { db.close() }
  unavailable = false
  runtime.emit({ type: 'item/completed', sessionId: created.id, turnId: prior[0]!.id, item: { ...item, text: 'new output' } })
  assert.equal((record as unknown as { transcriptIncomplete?: boolean }).transcriptIncomplete, false)
  assert.deepEqual(record.session.turns[0]?.items, [...prior[0]!.items, { ...item, text: 'new output' }])
  const fenced = notifications.flatMap(notification => {
    if (notification.method === 'session/cache-invalidated' && notification.params.sessionId === created.id) return [notification.params.watermark.sequence]
    if (notification.method === 'event' && notification.params.transcriptFence &&
        (notification.params.event.sessionId === created.id || notification.params.event.session?.id === created.id)) return [notification.params.transcriptFence.sequence]
    return []
  })
  const restored = notifications.find(notification => notification.method === 'event' && notification.params.event.type === 'session/started' &&
    notification.params.event.session.id === created.id && notification.params.event.session.turns[0]?.items.some((entry: any) => entry.id === 'late'))
  assert.ok(restored?.params.transcriptFence?.sequence, 'the actual recovery snapshot carries a centrally assigned sequence')
  assert.ok(fenced.every((value: number, index: number) => index === 0 || value === fenced[index - 1] + 1), 'all delivered per-record notifications remain contiguous')
})

test('a stored body changed by another connection before receipt is refused', async t => {
  const root = tempDir('hd-retention-receipt-sqlite-race-')
  const host = new Host({ logger: silent, state: new StateStore(join(root, 'state.json')), builtinAgents: root, catalogRefreshMs: 0 })
  t.after(() => host.dispose())
  const runtime = new FakeRuntime(); host.register(runtime); await host.start()
  const { body } = await loadedReceiptFixture(host, runtime, root)
  let release!: () => void; let entered!: () => void
  const gate = new Promise<void>(resolve => { release = resolve }); const started = new Promise<void>(resolve => { entered = resolve })
  const original = TranscriptStore.prototype.persistExactBody
  t.mock.method(TranscriptStore.prototype, 'persistExactBody', async function(this: TranscriptStore, hostBody: Session, candidate: Session, base: Parameters<typeof original>[2]) {
    const verified = await original.call(this, hostBody, candidate, base); entered(); await gate; return verified
  })
  t.after(() => release())
  const identity = createHash('sha256').update(canonicalTranscriptBody(body.turns).canonical).digest('hex')
  const pending = host.call('session/prepare-eviction', { runtime: body.runtime, sessionId: body.id, identity })
  await started
  const db = new DatabaseSync(join(root, 'sessions.sqlite'))
  try { db.prepare('UPDATE items SET payload=? WHERE runtime=? AND id=?').run(JSON.stringify({ id: 'i', type: 'assistantMessage', text: 'changed elsewhere' }), body.runtime, body.id) }
  finally { db.close() }
  release()
  assert.equal(await pending, null, 'a receipt cannot bless the prior readback after a database change')
})

test('eviction verification cannot overwrite richer stored metadata with equal turns', async t => {
  const root = tempDir('hd-retention-receipt-metadata-')
  const host = new Host({ logger: silent, state: new StateStore(join(root, 'state.json')), builtinAgents: root, catalogRefreshMs: 0 })
  t.after(() => host.dispose())
  const runtime = new FakeRuntime(); host.register(runtime); await host.start()
  const body: Session = { runtime: runtime.info.id, id: sessionId('receipt-metadata'), cwd: root, createdAt: 1, updatedAt: 1,
    title: 'older title', status: { type: 'idle' }, itemsLoaded: true, turns: [{ id: turnId('one'), status: 'completed', items: [{ id: itemId('i'), type: 'assistantMessage', text: 'same' }] }] }
  host.registry.upsert(body, null).cacheClosed = true
  const db = new TranscriptDatabase(join(root, 'sessions.sqlite'))
  try {
    db.write({ version: 1, runtime: body.runtime, id: body.id, savedAt: 1, turns: body.turns, title: 'newer stored title' })
    const identity = createHash('sha256').update(canonicalTranscriptBody(body.turns).canonical).digest('hex')
    assert.equal(await host.call('session/prepare-eviction', { runtime: body.runtime, sessionId: body.id, identity }), null)
    assert.equal(db.read(body.runtime, body.id)?.title, 'newer stored title')
  } finally { db.close() }
})

test('remove and undo while SQLite verification waits invalidates the old receipt', async t => {
  const root = tempDir('hd-retention-receipt-undo-')
  const host = new Host({ logger: silent, state: new StateStore(join(root, 'state.json')), builtinAgents: root, catalogRefreshMs: 0 })
  t.after(() => host.dispose())
  const runtime = new FakeRuntime(); host.register(runtime); await host.start()
  const { body, record } = await loadedReceiptFixture(host, runtime, root)
  let release!: () => void; let entered!: () => void
  const gate = new Promise<void>(resolve => { release = resolve }); const started = new Promise<void>(resolve => { entered = resolve })
  const original = TranscriptStore.prototype.persistExactBody
  t.mock.method(TranscriptStore.prototype, 'persistExactBody', async function(this: TranscriptStore, hostBody: Session, candidate: Session, base: Parameters<typeof original>[2]) {
    const verified = await original.call(this, hostBody, candidate, base); entered(); await gate; return verified
  })
  t.after(() => release())
  const identity = createHash('sha256').update(canonicalTranscriptBody(body.turns).canonical).digest('hex')
  const pending = host.call('session/prepare-eviction', { runtime: body.runtime, sessionId: body.id, identity })
  await started
  host.registry.holdRemoved(body.runtime, body.id, Date.now() + 60_000)
  assert.equal(host.registry.restoreRemoved(body.runtime, body.id), record)
  release()
  assert.equal(await pending, null)
})

test('an in-flight source read prevents a competing eviction receipt', async t => {
  const root = tempDir('hd-retention-read-fence-')
  const host = new Host({ logger: silent, state: new StateStore(join(root, 'state.json')), builtinAgents: root, catalogRefreshMs: 0 })
  t.after(() => host.dispose())
  const runtime = new FakeRuntime(); host.register(runtime); await host.start()
  const body: Session = { runtime: runtime.info.id, id: sessionId('receipt-read'), cwd: root, createdAt: 1, updatedAt: 1,
    status: { type: 'idle' }, itemsLoaded: true, turns: [{ id: turnId('one'), status: 'completed', items: [{ id: itemId('i'), type: 'assistantMessage', text: 'saved body' }] }] }
  host.registry.upsert(body, null)
  let release!: () => void; let entered!: () => void
  const gate = new Promise<void>(resolve => { release = resolve }); const started = new Promise<void>(resolve => { entered = resolve })
  runtime.readSession = async () => { entered(); await gate; return body }
  t.after(() => release())
  const reading = host.call('session/read', { runtime: body.runtime, sessionId: body.id })
  await started
  const identity = createHash('sha256').update(canonicalTranscriptBody(body.turns).canonical).digest('hex')
  try { assert.equal(await host.call('session/prepare-eviction', { runtime: body.runtime, sessionId: body.id, identity }), null) }
  finally { release(); await reading }
})

test('a late session start preserves a saved conversation notice after host body release', async t => {
  const root = tempDir('hd-retention-late-start-')
  const host = new Host({ logger: silent, state: new StateStore(join(root, 'state.json')), builtinAgents: root, catalogRefreshMs: 0 })
  t.after(() => host.dispose())
  const runtime = new FakeRuntime(); host.register(runtime); await host.start()
  const created = await host.call('session/create', { runtime: runtime.info.id, options: { cwd: root } }) as Session
  runtime.emit({ type: 'notice', class: 'conversation', sessionId: created.id, id: 'late-start-notice', level: 'warning', message: 'Synthetic prior notice' })
  const before = host.registry.get(runtime.info.id, created.id)!.session.turns
  assert.ok(before.some(turn => turn.items.some(item => item.type === 'notice')))
  await host.call('session/close', { runtime: runtime.info.id, sessionId: created.id })
  assert.equal(host.registry.get(runtime.info.id, created.id)!.session.itemsLoaded, false)
  runtime.emit({ type: 'session/started', session: { ...created, turns: [], itemsLoaded: true } })
  const after = host.registry.get(runtime.info.id, created.id)!.session
  assert.ok(after.turns.some(turn => turn.items.some(item => item.type === 'notice')), 'a source snapshot must not erase the prior notice')
})

test('late turn completion after release preserves and broadcasts the Host publication once', async t => {
  const root = tempDir('hd-retention-late-publication-')
  const host = new Host({ logger: silent, state: new StateStore(join(root, 'state.json')), builtinAgents: root, catalogRefreshMs: 0 })
  t.after(() => host.dispose())
  const runtime = new FakeRuntime(); host.register(runtime); await host.start()
  const created = await host.call('session/create', { runtime: runtime.info.id, options: { cwd: root } }) as Session
  transcript(runtime, created.id)
  const tid = turnId(`payload-${created.id}`)
  const publication = { id: itemId('pub'), type: 'publication', reference: { kind: 'pullRequest', repo: 'acme/widgets', number: 7, url: 'https://example.com/acme/widgets/pull/7', via: 'gh' } } as unknown as import('@harnessdesk/protocol').AgentItem
  runtime.emit({ type: 'item/completed', sessionId: created.id, turnId: tid, item: publication })
  await host.call('session/close', { runtime: runtime.info.id, sessionId: created.id })
  const events: unknown[] = []; host.addBroadcaster(event => events.push(event))
  const sourceItems = [0, 1, 2].map(n => ({ id: itemId(`source-${n}`), type: 'assistantMessage' as const, text: `source ${n}` }))
  runtime.emit({ type: 'turn/completed', sessionId: created.id, turn: { id: tid, status: 'completed', items: sourceItems } })
  const retained = host.registry.get(runtime.info.id, created.id)!.session.turns[0]!.items
  const outgoing = events.findLast((v: any) => v.method === 'event' && v.params.event.type === 'turn/completed') as { params: { event: { turn: { items: readonly import('@harnessdesk/protocol').AgentItem[] } } } }
  assert.equal(retained.filter(item => item.id === publication.id).length, 1)
  assert.equal(outgoing.params.event.turn.items.filter(item => item.id === publication.id).length, 1)
  assert.deepEqual(outgoing.params.event.turn.items, retained)
})

test('overlapping source reads keep the receipt fenced until every owner settles', async t => {
  const root = tempDir('hd-retention-overlap-read-')
  const host = new Host({ logger: silent, state: new StateStore(join(root, 'state.json')), builtinAgents: root, catalogRefreshMs: 0 })
  t.after(() => host.dispose())
  const runtime = new FakeRuntime(); host.register(runtime); await host.start()
  const body: Session = { runtime: runtime.info.id, id: sessionId('receipt-overlap'), cwd: root, createdAt: 1, updatedAt: 1,
    status: { type: 'idle' }, itemsLoaded: true, turns: [{ id: turnId('one'), status: 'completed', items: [{ id: itemId('i'), type: 'assistantMessage', text: 'saved body' }] }] }
  host.registry.upsert(body, null)
  let entered = 0; let both!: () => void; const started = new Promise<void>(resolve => { both = resolve })
  const releases: (() => void)[] = []
  runtime.readSession = async () => { const gate = new Promise<void>(resolve => { releases.push(resolve) }); if (++entered === 2) both(); await gate; return body }
  t.after(() => { for (const release of releases) release() })
  const first = host.call('session/read', { runtime: body.runtime, sessionId: body.id })
  const second = host.call('session/read', { runtime: body.runtime, sessionId: body.id })
  await started
  const identity = createHash('sha256').update(canonicalTranscriptBody(body.turns).canonical).digest('hex')
  try {
    releases[0]!(); await first
    assert.equal(await host.call('session/prepare-eviction', { runtime: body.runtime, sessionId: body.id, identity }), null)
  } finally { releases[1]!(); await second }
})

test('a close in flight prevents another window receiving an eviction receipt', async t => {
  const root = tempDir('hd-retention-close-fence-')
  const host = new Host({ logger: silent, state: new StateStore(join(root, 'state.json')), builtinAgents: root, catalogRefreshMs: 0 })
  t.after(() => host.dispose())
  const runtime = new FakeRuntime(); host.register(runtime); await host.start()
  const fresh = await host.call('session/create', { runtime: runtime.info.id, options: { cwd: root } }) as Session
  const body: Session = { runtime: runtime.info.id, id: fresh.id, cwd: root, createdAt: 1, updatedAt: 1,
    status: { type: 'idle' }, itemsLoaded: true, turns: [{ id: turnId('one'), status: 'completed', items: [{ id: itemId('i'), type: 'assistantMessage', text: 'saved body' }] }] }
  host.registry.upsert(body, null)
  let release!: () => void; let entered!: () => void
  const gate = new Promise<void>(resolve => { release = resolve }); const started = new Promise<void>(resolve => { entered = resolve })
  const original = TranscriptStore.prototype.releaseFromBase
  t.mock.method(TranscriptStore.prototype, 'releaseFromBase', async function(this: TranscriptStore, candidate: Parameters<typeof original>[0], generation: Parameters<typeof original>[1], base: Parameters<typeof original>[2], epoch: Parameters<typeof original>[3]) {
    const saved = await original.call(this, candidate, generation, base, epoch); entered(); await gate; return saved
  })
  t.after(() => release())
  const closing = host.call('session/close', { runtime: body.runtime, sessionId: body.id })
  await started
  const identity = createHash('sha256').update(canonicalTranscriptBody(body.turns).canonical).digest('hex')
  try { assert.equal(await host.call('session/prepare-eviction', { runtime: body.runtime, sessionId: body.id, identity }), null) }
  finally { release(); await closing }
})

test('descriptor capacity refusal keeps the exact full Host body protected on close', async t => {
  const root = tempDir('hd-retention-descriptor-cap-')
  const options = { logger: silent, state: new StateStore(join(root, 'state.json')), builtinAgents: root, catalogRefreshMs: 0, transcriptDescriptorBudgetBytes: 0 }
  const host = new Host(options); t.after(() => host.dispose())
  const runtime = new FakeRuntime(); host.register(runtime); await host.start()
  const created = await host.call('session/create', { runtime: runtime.info.id, options: { cwd: root } }) as Session
  transcript(runtime, created.id)
  const before = host.registry.get(runtime.info.id, created.id)!.session.turns
  await host.call('session/close', { runtime: runtime.info.id, sessionId: created.id })
  const record = host.registry.get(runtime.info.id, created.id)!
  assert.equal(record.session.itemsLoaded, true, 'capacity refusal protects the Host body')
  assert.deepEqual(record.session.turns, before)
})

test('a successful write without durable readback cannot release the Host body', async t => {
  const root = tempDir('hd-retention-close-readback-')
  const host = new Host({ logger: silent, state: new StateStore(join(root, 'state.json')), builtinAgents: root, catalogRefreshMs: 0 })
  t.after(async () => { await assert.rejects(host.dispose(), /protected/i) })
  const runtime = new FakeRuntime(); host.register(runtime); await host.start()
  const fresh = await host.call('session/create', { runtime: runtime.info.id, options: { cwd: root } }) as Session
  const body: Session = { runtime: runtime.info.id, id: fresh.id, cwd: root, createdAt: 1, updatedAt: 1,
    status: { type: 'idle' }, itemsLoaded: true, turns: [{ id: turnId('one'), status: 'completed', items: [{ id: itemId('i'), type: 'assistantMessage', text: 'saved body' }] }] }
  host.registry.upsert(body, null)
  const db = new DatabaseSync(join(root, 'sessions.sqlite'))
  try {
    db.exec("CREATE TRIGGER lose_close_body AFTER INSERT ON bodies BEGIN DELETE FROM bodies WHERE runtime=new.runtime AND id=new.id; END")
    await host.call('session/close', { runtime: body.runtime, sessionId: body.id })
    const record = host.registry.get(body.runtime, body.id)!
    assert.equal(record.session.itemsLoaded, true)
    assert.deepEqual(record.session.turns, body.turns)
  } finally { db.close() }
})

test('a current fully rehydrated Host body releases its descriptor reservation', async t => {
  const root = tempDir('hd-retention-descriptor-rehydrate-')
  const host = new Host({ logger: silent, state: new StateStore(join(root, 'state.json')), builtinAgents: root, catalogRefreshMs: 0 })
  t.after(() => host.dispose())
  const runtime = new FakeRuntime(); host.register(runtime); await host.start()
  const fresh = await host.call('session/create', { runtime: runtime.info.id, options: { cwd: root } }) as Session
  const body: Session = { runtime: runtime.info.id, id: fresh.id, cwd: root, createdAt: 1, updatedAt: 1,
    status: { type: 'idle' }, itemsLoaded: true, turns: [{ id: turnId('one'), status: 'completed', items: [{ id: itemId('i'), type: 'assistantMessage', text: 'saved' }] }] }
  const record = host.registry.upsert(body, null)
  const original = DescriptorCache.prototype.remove
  let removed = 0
  t.mock.method(DescriptorCache.prototype, 'remove', function(this: DescriptorCache, generation: string) { removed++; return original.call(this, generation) })
  await host.call('session/close', { runtime: body.runtime, sessionId: body.id })
  assert.equal(record.session.itemsLoaded, false)
  runtime.emit({ type: 'item/completed', sessionId: body.id, turnId: turnId('one'), item: { id: itemId('added'), type: 'assistantMessage', text: 'new' } })
  assert.equal(record.session.itemsLoaded, true)
  assert.equal(removed, 1, 'a full current body no longer needs its old descriptor')
})

test('a changed stored base does not retire the recovery descriptor', async t => {
  const root = tempDir('hd-retention-descriptor-changed-')
  const host = new Host({ logger: silent, state: new StateStore(join(root, 'state.json')), builtinAgents: root, catalogRefreshMs: 0 })
  t.after(async () => { await assert.rejects(host.dispose(), /unsaved/i) })
  const runtime = new FakeRuntime(); host.register(runtime); await host.start()
  const fresh = await host.call('session/create', { runtime: runtime.info.id, options: { cwd: root } }) as Session
  const body: Session = { runtime: runtime.info.id, id: fresh.id, cwd: root, createdAt: 1, updatedAt: 1,
    status: { type: 'idle' }, itemsLoaded: true, turns: [{ id: turnId('one'), status: 'completed', items: [{ id: itemId('i'), type: 'assistantMessage', text: 'saved' }] }] }
  const record = host.registry.upsert(body, null)
  await host.call('session/close', { runtime: body.runtime, sessionId: body.id })
  assert.equal(record.session.itemsLoaded, false)
  t.mock.method(TranscriptStore.prototype, 'readRetainedTurnsAtBase', () => [{ id: turnId('one'), status: 'completed', items: [{ id: itemId('i'), type: 'assistantMessage', text: 'different' }] }])
  const original = DescriptorCache.prototype.remove; let removed = 0
  t.mock.method(DescriptorCache.prototype, 'remove', function(this: DescriptorCache, generation: string) { removed++; return original.call(this, generation) })
  runtime.emit({ type: 'item/completed', sessionId: body.id, turnId: turnId('one'), item: { id: itemId('added'), type: 'assistantMessage', text: 'new' } })
  assert.equal(removed, 0)
})

test('late events cannot hydrate from equal turns with different durable metadata', async t => {
  const root = tempDir('hd-retention-descriptor-metadata-')
  const host = new Host({ logger: silent, state: new StateStore(join(root, 'state.json')), builtinAgents: root, catalogRefreshMs: 0 })
  t.after(async () => { await assert.rejects(host.dispose(), /unsaved/i) })
  const runtime = new FakeRuntime(); host.register(runtime); await host.start()
  const fresh = await host.call('session/create', { runtime: runtime.info.id, options: { cwd: root } }) as Session
  const body: Session = { runtime: runtime.info.id, id: fresh.id, cwd: root, createdAt: 1, updatedAt: 1,
    title: 'old', status: { type: 'idle' }, itemsLoaded: true, turns: [{ id: turnId('one'), status: 'completed', items: [{ id: itemId('i'), type: 'assistantMessage', text: 'saved' }] }] }
  const record = host.registry.upsert(body, null)
  await host.call('session/close', { runtime: body.runtime, sessionId: body.id })
  assert.equal(record.session.itemsLoaded, false)
  const db = new TranscriptDatabase(join(root, 'sessions.sqlite'))
  try {
    const stored = db.read(body.runtime, body.id); assert.ok(stored)
    db.write({ ...stored, title: 'changed externally' })
    runtime.emit({ type: 'item/completed', sessionId: body.id, turnId: turnId('one'), item: { id: itemId('later'), type: 'assistantMessage', text: 'new' } })
    assert.equal(record.transcriptIncomplete, true)
    assert.equal(record.session.itemsLoaded, false)
    assert.equal(db.read(body.runtime, body.id)?.title, 'changed externally')
  } finally { db.close() }
})

test('an unavailable saved body retains late item data until exact-base recovery', async t => {
  const root = tempDir('hd-retention-overlay-seeded-')
  const host = new Host({ logger: silent, state: new StateStore(join(root, 'state.json')), builtinAgents: root, catalogRefreshMs: 0 })
  t.after(() => host.dispose())
  const runtime = new FakeRuntime(); host.register(runtime); await host.start()
  const fresh = await host.call('session/create', { runtime: runtime.info.id, options: { cwd: root } }) as Session
  const body: Session = { runtime: runtime.info.id, id: fresh.id, cwd: root, createdAt: 1, updatedAt: 1,
    status: { type: 'idle' }, itemsLoaded: true, turns: [{ id: turnId('one'), status: 'completed', items: [{ id: itemId('i'), type: 'assistantMessage', text: 'saved' }] }] }
  const record = host.registry.upsert(body, null)
  await host.call('session/close', { runtime: body.runtime, sessionId: body.id })
  assert.equal(record.session.itemsLoaded, false)
  let unavailable = true
  const read = TranscriptStore.prototype.readRetainedTurnsAtBase
  t.mock.method(TranscriptStore.prototype, 'readRetainedTurnsAtBase', function(this: TranscriptStore, runtime: Session['runtime'], id: Session['id'], identity: string) {
    return unavailable ? null : read.call(this, runtime, id, identity)
  })
  const item = { id: itemId('late'), type: 'assistantMessage' as const, text: '' }
  const sent: any[] = []; host.addBroadcaster(event => sent.push(event))
  runtime.emit({ type: 'item/started', sessionId: body.id, turnId: turnId('one'), item })
  runtime.emit({ type: 'item/delta', sessionId: body.id, turnId: turnId('one'), itemId: item.id, delta: { kind: 'assistantText', text: 'later' } })
  assert.equal((record as unknown as { transcriptIncomplete?: boolean }).transcriptIncomplete, true)
  assert.equal(record.session.itemsLoaded, false)
  assert.ok(sent.some(entry => entry.method === 'event' && entry.params.event.type === 'notice' && /history.*unavailable/i.test(entry.params.event.message)))
  assert.equal(sent.some(entry => entry.method === 'event' && entry.params.event.type.startsWith('item/')), false)
  await assert.rejects(host.call('session/read', { runtime: body.runtime, sessionId: body.id }), /unavailable/i)
  const identity = createHash('sha256').update(canonicalTranscriptBody(body.turns).canonical).digest('hex')
  assert.equal(await host.call('session/prepare-eviction', { runtime: body.runtime, sessionId: body.id, identity }), null)
  unavailable = false
  runtime.emit({ type: 'item/completed', sessionId: body.id, turnId: turnId('one'), item: { ...item, text: 'later' } })
  assert.equal((record as unknown as { transcriptIncomplete?: boolean }).transcriptIncomplete, false)
  assert.deepEqual(record.session.turns[0]?.items, [...body.turns[0]!.items, { ...item, text: 'later' }])
  const bodyTypes = sent.filter(entry => entry.method === 'event').map(entry => entry.params.event.type)
  assert.ok(bodyTypes.indexOf('session/started') >= 0 && bodyTypes.indexOf('item/completed') > bodyTypes.indexOf('session/started'))
})

test('a completion during storage failure preserves the Host publication once on recovery', async t => {
  const root = tempDir('hd-retention-overlay-publication-')
  const host = new Host({ logger: silent, state: new StateStore(join(root, 'state.json')), builtinAgents: root, catalogRefreshMs: 0 })
  t.after(() => host.dispose())
  const runtime = new FakeRuntime(); host.register(runtime); await host.start()
  const fresh = await host.call('session/create', { runtime: runtime.info.id, options: { cwd: root } }) as Session
  const publication = { id: itemId('publication'), type: 'publication', publication: { number: 7, url: 'https://example.com/acme/widgets/pull/7', via: 'gh' } } as unknown as import('@harnessdesk/protocol').AgentItem
  const body: Session = { runtime: runtime.info.id, id: fresh.id, cwd: root, createdAt: 1, updatedAt: 1,
    status: { type: 'idle' }, itemsLoaded: true, turns: [{ id: turnId('one'), status: 'completed', items: [publication] }] }
  const record = host.registry.upsert(body, null)
  await host.call('session/close', { runtime: body.runtime, sessionId: body.id })
  assert.equal(record.session.itemsLoaded, false)
  let unavailable = true
  const read = TranscriptStore.prototype.readRetainedTurnsAtBase
  t.mock.method(TranscriptStore.prototype, 'readRetainedTurnsAtBase', function(this: TranscriptStore, runtime: Session['runtime'], id: Session['id'], identity: string) {
    return unavailable ? null : read.call(this, runtime, id, identity)
  })
  const events: any[] = []; host.addBroadcaster(event => events.push(event))
  const items = [0, 1, 2].map(n => ({ id: itemId(`source-${n}`), type: 'assistantMessage' as const, text: `source ${n}` }))
  runtime.emit({ type: 'turn/completed', sessionId: body.id, turn: { id: turnId('one'), status: 'completed', items } })
  assert.equal(record.transcriptIncomplete, true)
  assert.equal(events.some(entry => entry.method === 'event' && entry.params.event.type === 'turn/completed'), false)
  unavailable = false
  runtime.emit({ type: 'session/status', sessionId: body.id, status: { type: 'idle' } })
  assert.equal(record.transcriptIncomplete, false)
  assert.equal(record.session.turns[0]!.items.filter(item => item.id === publication.id).length, 1)
  assert.equal(record.session.turns[0]!.items.length, 4)
  const snapshot = events.find(entry => entry.method === 'event' && entry.params.event.type === 'session/started')
  assert.equal(snapshot.params.event.session.turns[0].items.filter((item: { id: string }) => item.id === publication.id).length, 1)
})

test('disposing with an unrecovered overlay reports unsaved activity', async t => {
  const root = tempDir('hd-retention-overlay-dispose-')
  const host = new Host({ logger: silent, state: new StateStore(join(root, 'state.json')), builtinAgents: root, catalogRefreshMs: 0 })
  const runtime = new FakeRuntime(); host.register(runtime); await host.start()
  const fresh = await host.call('session/create', { runtime: runtime.info.id, options: { cwd: root } }) as Session
  const body: Session = { runtime: runtime.info.id, id: fresh.id, cwd: root, createdAt: 1, updatedAt: 1,
    status: { type: 'idle' }, itemsLoaded: true, turns: [{ id: turnId('one'), status: 'completed', items: [{ id: itemId('i'), type: 'assistantMessage', text: 'saved' }] }] }
  host.registry.upsert(body, null)
  await host.call('session/close', { runtime: body.runtime, sessionId: body.id })
  t.mock.method(TranscriptStore.prototype, 'readRetainedTurnsAtBase', () => null)
  runtime.emit({ type: 'item/completed', sessionId: body.id, turnId: turnId('one'), item: { id: itemId('later'), type: 'assistantMessage', text: 'unsaved' } })
  await assert.rejects(host.dispose(), /unsaved/i)
})

test('recovery refuses an externally changed durable base and keeps the current Host body', async t => {
  const root = tempDir('hd-retention-overlay-cas-race-')
  const host = new Host({ logger: silent, state: new StateStore(join(root, 'state.json')), builtinAgents: root, catalogRefreshMs: 0 })
  let disposed = false
  t.after(async () => { if (!disposed) await host.dispose().catch(() => {}) })
  const runtime = new FakeRuntime(); host.register(runtime); await host.start()
  const fresh = await host.call('session/create', { runtime: runtime.info.id, options: { cwd: root } }) as Session
  const body: Session = { runtime: runtime.info.id, id: fresh.id, cwd: root, createdAt: 1, updatedAt: 1,
    status: { type: 'idle' }, itemsLoaded: true, turns: [{ id: turnId('one'), status: 'completed', items: [{ id: itemId('i'), type: 'assistantMessage', text: 'saved' }] }] }
  const record = host.registry.upsert(body, null)
  await host.call('session/close', { runtime: body.runtime, sessionId: body.id })
  const beforeDb = new TranscriptDatabase(join(root, 'sessions.sqlite'))
  const savedRow = beforeDb.read(body.runtime, body.id); beforeDb.close(); assert.ok(savedRow)
  let unavailable = true
  const read = TranscriptStore.prototype.readRetainedTurnsAtBase
  t.mock.method(TranscriptStore.prototype, 'readRetainedTurnsAtBase', function(this: TranscriptStore, runtime: Session['runtime'], id: Session['id'], identity: string) {
    return unavailable ? null : read.call(this, runtime, id, identity)
  })
  runtime.emit({ type: 'item/completed', sessionId: body.id, turnId: turnId('one'), item: { id: itemId('later'), type: 'assistantMessage', text: 'new' } })
  const external = [{ id: turnId('one'), status: 'completed' as const, items: [{ id: itemId('external'), type: 'assistantMessage' as const, text: 'external' }] }]
  let finished!: () => void; const saved = new Promise<void>(resolve => { finished = resolve })
  const original = TranscriptStore.prototype.persistEvolvedBody
  const sent: any[] = []; host.addBroadcaster(event => sent.push(event))
  let inject = true
  t.mock.method(TranscriptStore.prototype, 'persistEvolvedBody', async function(this: TranscriptStore, candidate: Parameters<typeof original>[0], expected: Parameters<typeof original>[1], insight: Parameters<typeof original>[2], current: Parameters<typeof original>[3]) {
    if (inject) {
      inject = false
      const db = new TranscriptDatabase(join(root, 'sessions.sqlite'))
      try { db.write({ version: 1, runtime: body.runtime, id: body.id, savedAt: 1, turns: external }) } finally { db.close() }
    }
    try { return await original.call(this, candidate, expected, insight, current) } finally { finished() }
  })
  unavailable = false
  runtime.emit({ type: 'session/status', sessionId: body.id, status: { type: 'idle' } })
  await saved
  const db = new TranscriptDatabase(join(root, 'sessions.sqlite'))
  try { assert.deepEqual(db.read(body.runtime, body.id)?.turns, external) } finally { db.close() }
  assert.deepEqual(record.session.turns[0]?.items, [...body.turns[0]!.items, { id: itemId('later'), type: 'assistantMessage', text: 'new' }])
  const identity = createHash('sha256').update(canonicalTranscriptBody(record.session.turns).canonical).digest('hex')
  assert.equal(await host.call('session/prepare-eviction', { runtime: body.runtime, sessionId: body.id, identity }), null)
  assert.ok(sent.some(entry => entry.method === 'event' && entry.params.event.type === 'notice' && /could not be saved/i.test(entry.params.event.message)))
  const repaired = new TranscriptDatabase(join(root, 'sessions.sqlite'))
  try { repaired.write(savedRow) } finally { repaired.close() }
  const expected = record.session.turns
  const reopened = await host.call('session/read', { runtime: body.runtime, sessionId: body.id }) as Session
  assert.deepEqual(reopened.turns, expected)
  const verified = new TranscriptDatabase(join(root, 'sessions.sqlite'))
  try { assert.deepEqual(verified.read(body.runtime, body.id)?.turns, expected) } finally { verified.close() }
  await host.dispose(); disposed = true
})

test('recovery advances its verified base before saving an event that arrived during the write', async t => {
  const root = tempDir('hd-retention-overlay-write-race-')
  const host = new Host({ logger: silent, state: new StateStore(join(root, 'state.json')), builtinAgents: root, catalogRefreshMs: 0 })
  t.after(() => host.dispose())
  const runtime = new FakeRuntime(); host.register(runtime); await host.start()
  const fresh = await host.call('session/create', { runtime: runtime.info.id, options: { cwd: root } }) as Session
  const body: Session = { runtime: runtime.info.id, id: fresh.id, cwd: root, createdAt: 1, updatedAt: 1,
    status: { type: 'idle' }, itemsLoaded: true, turns: [{ id: turnId('one'), status: 'completed', items: [{ id: itemId('i'), type: 'assistantMessage', text: 'saved' }] }] }
  const record = host.registry.upsert(body, null)
  await host.call('session/close', { runtime: body.runtime, sessionId: body.id })
  let unavailable = true
  const read = TranscriptStore.prototype.readRetainedTurnsAtBase
  t.mock.method(TranscriptStore.prototype, 'readRetainedTurnsAtBase', function(this: TranscriptStore, runtime: Session['runtime'], id: Session['id'], identity: string) {
    return unavailable ? null : read.call(this, runtime, id, identity)
  })
  runtime.emit({ type: 'item/completed', sessionId: body.id, turnId: turnId('one'), item: { id: itemId('first'), type: 'assistantMessage', text: 'first' } })
  let release!: () => void, entered!: () => void, finished!: () => void
  const gate = new Promise<void>(resolve => { release = resolve }), started = new Promise<void>(resolve => { entered = resolve }), done = new Promise<void>(resolve => { finished = resolve })
  t.after(() => release())
  const original = TranscriptStore.prototype.persistEvolvedBody; let writes = 0
  t.mock.method(TranscriptStore.prototype, 'persistEvolvedBody', async function(this: TranscriptStore, candidate: Parameters<typeof original>[0], expected: Parameters<typeof original>[1], insight: Parameters<typeof original>[2], current: Parameters<typeof original>[3]) {
    const result = await original.call(this, candidate, expected, insight, current)
    if (++writes === 1) { entered(); await gate } else finished()
    return result
  })
  unavailable = false
  runtime.emit({ type: 'session/status', sessionId: body.id, status: { type: 'idle' } })
  await started
  runtime.emit({ type: 'item/completed', sessionId: body.id, turnId: turnId('one'), item: { id: itemId('second'), type: 'assistantMessage', text: 'second' } })
  release(); await done
  const db = new TranscriptDatabase(join(root, 'sessions.sqlite'))
  try { assert.deepEqual(db.read(body.runtime, body.id)?.turns, record.session.turns) } finally { db.close() }
  assert.equal(record.session.turns[0]!.items.length, 3)
  assert.equal(writes, 2)
})

test('descriptor ownership survives undo and is pruned after the record is forgotten', async t => {
  const root = tempDir('hd-retention-descriptor-undo-')
  const host = new Host({ logger: silent, state: new StateStore(join(root, 'state.json')), builtinAgents: root, catalogRefreshMs: 0 })
  t.after(() => host.dispose())
  const runtime = new FakeRuntime(); host.register(runtime); await host.start()
  const fresh = await host.call('session/create', { runtime: runtime.info.id, options: { cwd: root } }) as Session
  const body: Session = { runtime: runtime.info.id, id: fresh.id, cwd: root, createdAt: 1, updatedAt: 1,
    status: { type: 'idle' }, itemsLoaded: true, turns: [{ id: turnId('one'), status: 'completed', items: [{ id: itemId('i'), type: 'assistantMessage', text: 'saved' }] }] }
  const record = host.registry.upsert(body, null)
  await host.call('session/close', { runtime: body.runtime, sessionId: body.id })
  assert.equal(record.session.itemsLoaded, false)
  const original = DescriptorCache.prototype.remove; let removed = 0
  t.mock.method(DescriptorCache.prototype, 'remove', function(this: DescriptorCache, generation: string) { removed++; return original.call(this, generation) })
  host.registry.holdRemoved(body.runtime, body.id, Date.now() + 60_000)
  const other = { ...body, id: sessionId('descriptor-other') }
  host.registry.upsert(other, null)
  await host.call('session/close', { runtime: other.runtime, sessionId: other.id })
  assert.equal(removed, 0)
  assert.equal(host.registry.restoreRemoved(body.runtime, body.id), record)
  host.registry.delete(body.runtime, body.id)
  const replacement = host.registry.upsert(body, null)
  assert.notEqual(replacement.bodyGeneration, record.bodyGeneration)
  await host.call('session/close', { runtime: replacement.runtime, sessionId: replacement.session.id })
  assert.equal(removed, 1)
})
