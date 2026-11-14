import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { itemId, sessionId, turnId, type AgentItem, type Session, type Turn } from '@harnessdesk/protocol'
import { Host } from '../src/host.js'
import { StateStore } from '../src/state.js'
import { TranscriptDatabase } from '../src/transcript-database.js'
import { TranscriptStore } from '../src/transcripts.js'
import { reconcileProseReplay } from '../src/reconcile-prose.js'
import { FakeRuntime, FakeSession } from './fixtures/fake-runtime.js'
import { AcpRuntime } from '@harnessdesk/adapter-acp'
import { silent } from './fixtures/harness.js'

const message = (id: string, text: string, role: 'user' | 'assistant'): AgentItem => role === 'user'
  ? { id: itemId(id), type: 'userMessage', content: [{ type: 'text', text }] }
  : { id: itemId(id), type: 'assistantMessage', text }
const turn = (id: string, items: AgentItem[]): Turn => ({ id: turnId(id), status: 'completed', items })
const words = (turns: readonly Turn[]) => turns.flatMap(t => t.items.flatMap(item => item.type === 'userMessage'
  ? item.content.flatMap(part => part.type === 'text' ? [part.text] : [])
  : item.type === 'assistantMessage' ? [item.text] : []))

test('renumbered prose-only replay after a steer does not duplicate persisted messages', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'hd-steer-replay-'))
  const sid = sessionId('steer-session')
  const runtime = new FakeRuntime()
  const host = new Host({ logger: silent, state: new StateStore(join(dir, 'state.json')), builtinAgents: dir, catalogRefreshMs: 0, idleStopMs: 0 })
  host.register(runtime); await host.start()
  let disposed = false, cold: Host | undefined
  t.after(async () => { if (cold) await cold.dispose(); if (!disposed) await host.dispose(); await rm(dir, { recursive: true, force: true }) })
  const empty: Session = { ...new FakeSession(runtime, sid, { cwd: dir, model: 'fake-1' }, {}).snapshot(), itemsLoaded: true }
  const first = turn('turn-1', [message('live-u1', 'p1', 'user'), message('live-a1', 'answer one', 'assistant'), { id: itemId('host-note'), type: 'notice', kind: 'conversation:warning', text: 'Host-only saved notice' }, message('live-steer', 'steer', 'user'), message('live-after', 'answer after steer', 'assistant')])
  const second = turn('turn-2', [message('live-u2', 'p2', 'user'), message('live-a2', 'answer two', 'assistant')])
  runtime.emit({ type: 'session/started', session: empty })
  for (const current of [first, second]) {
    runtime.emit({ type: 'turn/started', sessionId: sid, turn: { ...current, status: 'inProgress', items: [] } })
    for (const item of current.items) runtime.emit({ type: 'item/completed', sessionId: sid, turnId: current.id, item })
    runtime.emit({ type: 'turn/completed', sessionId: sid, turn: current })
  }
  await host.dispose(); disposed = true
  const expected = ['p1', 'answer one', 'steer', 'answer after steer', 'p2', 'answer two']
  const before = new TranscriptDatabase(join(dir, 'sessions.sqlite'))
  try { assert.deepEqual(words(before.read(runtime.info.id, sid)!.turns), expected) } finally { before.close() }
  const replay: Session = { ...empty, turns: [
    turn('turn-1', [message('replay-u1', 'p1', 'user'), message('replay-a1', 'answer one', 'assistant')]),
    turn('turn-2', [message('replay-steer', 'steer', 'user'), message('replay-after', 'answer after steer', 'assistant')]),
    turn('turn-3', [message('replay-u2', 'p2', 'user'), message('replay-a2', 'answer two', 'assistant')]),
  ] }
  const next = new FakeRuntime()
  next.readSession = async () => { next.emit({ type: 'session/started', session: replay }); return replay }
  cold = new Host({ logger: silent, state: new StateStore(join(dir, 'state.json')), builtinAgents: dir, catalogRefreshMs: 0, idleStopMs: 0 })
  cold.register(next); await cold.start()
  const read = await cold.call('session/read', { runtime: next.info.id, sessionId: sid }) as Session
  await cold.dispose(); cold = undefined
  const after = new TranscriptDatabase(join(dir, 'sessions.sqlite'))
  let stored: readonly Turn[]
  try { stored = after.read(runtime.info.id, sid)!.turns } finally { after.close() }
  const notes = (turns: readonly Turn[]) => turns.flatMap(one => one.items.filter(item => item.type === 'notice' && item.id === itemId('host-note')))
  assert.deepEqual({ read: words(read.turns), sqlite: words(stored), readNotes: notes(read.turns).length, storedNotes: notes(stored).length }, { read: expected, sqlite: expected, readNotes: 1, storedNotes: 1 }, JSON.stringify(read.turns))
})

test('a reused turn and message ID cannot pair different person prompts', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'hd-steer-identity-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const runtime = new FakeRuntime(), sid = sessionId('identity-session')
  const base: Session = { ...new FakeSession(runtime, sid, { cwd: dir, model: 'fake-1' }, {}).snapshot(), itemsLoaded: true }
  const store = new TranscriptStore(join(dir, 'transcripts'))
  t.after(() => store.close())
  store.record({ ...base, turns: [turn('same-turn', [message('same-user', 'original person request', 'user'), message('old-answer', 'old answer', 'assistant'), message('old-extra', 'old extra', 'assistant')])] }, { now: true })
  await store.flush()
  const replay = { ...base, turns: [turn('same-turn', [message('same-user', 'different person request', 'user'), message('new-answer', 'new answer', 'assistant')])] }
  assert.deepEqual(words((await store.enrich(replay)).turns), ['different person request', 'new answer'])
})

test('the same prompt still restores a thinner turn by ID', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'hd-steer-thin-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const runtime = new FakeRuntime(), sid = sessionId('thin-session')
  const base: Session = { ...new FakeSession(runtime, sid, { cwd: dir, model: 'fake-1' }, {}).snapshot(), itemsLoaded: true }
  const store = new TranscriptStore(join(dir, 'transcripts'))
  t.after(() => store.close())
  const prompt = message('same-user', 'same request', 'user')
  store.record({ ...base, turns: [turn('same-turn', [prompt, message('old-extra', 'saved work', 'assistant'), message('answer', 'answer', 'assistant')])] }, { now: true })
  await store.flush()
  const replay = { ...base, turns: [turn('same-turn', [prompt, message('answer', 'answer', 'assistant')])] }
  assert.deepEqual(words((await store.enrich(replay)).turns), ['same request', 'saved work', 'answer'])
})

test('reordered repeated prompts do not borrow the other turn’s saved work', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'hd-steer-repeated-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const runtime = new FakeRuntime(), sid = sessionId('repeated-session')
  const base: Session = { ...new FakeSession(runtime, sid, { cwd: dir, model: 'fake-1' }, {}).snapshot(), itemsLoaded: true }
  const store = new TranscriptStore(join(dir, 'transcripts'))
  t.after(() => store.close())
  const first = [message('first-user', 'repeat', 'user'), message('first-a', 'first answer', 'assistant'), message('first-extra', 'first saved step', 'assistant')]
  const second = [message('second-user', 'repeat', 'user'), message('second-a', 'second answer', 'assistant'), message('second-extra', 'second saved step', 'assistant')]
  store.record({ ...base, turns: [turn('one', first), turn('two', second)] }, { now: true }); await store.flush()
  const replay = { ...base, turns: [turn('one', second.slice(0, 2)), turn('two', first.slice(0, 2))] }
  assert.deepEqual(words((await store.enrich(replay)).turns), ['repeat', 'second answer', 'repeat', 'first answer'])
})

test('explicit rollback removes the discarded turn from durable history', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'hd-steer-rollback-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const runtime = new FakeRuntime(), sid = sessionId('rollback-session')
  const base: Session = { ...new FakeSession(runtime, sid, { cwd: dir, model: 'fake-1' }, {}).snapshot(), itemsLoaded: true }
  const store = new TranscriptStore(join(dir, 'transcripts'))
  t.after(() => store.close())
  const first = turn('one', [message('first', 'keep', 'user')])
  const second = turn('two', [message('second', 'remove', 'user')])
  store.record({ ...base, turns: [first, second] }, { now: true }); await store.flush()
  await store.dropTurns(base.runtime, sid, 1)
  assert.deepEqual(words((await store.recover(base.runtime, sid))!.turns), ['keep'])
  assert.deepEqual(words((await store.enrich({ ...base, turns: [first] })).turns), ['keep'])
})

test('identical repeated replay rows cannot identify the owner of a saved-only marker after reorder', () => {
  // The runtime regenerates turn and item IDs. Both earlier turns have the
  // same visible person request and answer; only the host saw this marker.
  const marker: AgentItem = { id: itemId('host-marker'), type: 'notice', kind: 'conversation:warning', text: 'Host-only saved notice' }
  const saved = [
    turn('old-first', [message('old-u1', 'repeat', 'user'), message('old-a1', 'answer', 'assistant'), marker]),
    turn('old-second', [message('old-u2', 'repeat', 'user'), message('old-a2', 'answer', 'assistant')]),
  ]
  const replay = () => [
    turn('replay-1', [message('replay-u1', 'repeat', 'user'), message('replay-a1', 'answer', 'assistant')]),
    turn('replay-2', [message('replay-u2', 'repeat', 'user'), message('replay-a2', 'answer', 'assistant')]),
  ]
  // These are two different underlying histories with byte-identical Host
  // inputs: in one the runtime keeps order, in the other it swaps the two
  // equal exchanges before assigning its synthetic IDs. No replay field says
  // which occurred. Preserving marker ownership requires opposite positions.
  const ordered = { saved, read: replay(), sourceOrder: ['old-first', 'old-second'] }
  const swapped = { saved, read: replay(), sourceOrder: ['old-second', 'old-first'] }
  assert.deepEqual({ saved: ordered.saved, read: ordered.read }, { saved: swapped.saved, read: swapped.read })
  assert.equal(ordered.sourceOrder.indexOf('old-first'), 0)
  assert.equal(swapped.sourceOrder.indexOf('old-first'), 1)
})

for (const mode of ['announcement', 'read return', 'resume', 'new ids'] as const) test(`ambiguous repeated replay preserves the durable body before ${mode}`, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'hd-steer-ambiguous-'))
  const sid = sessionId('ambiguous-session'), runtime = new FakeRuntime()
  const makeHost = () => new Host({ logger: silent, state: new StateStore(join(dir, 'state.json')), builtinAgents: dir, catalogRefreshMs: 0, idleStopMs: 0 })
  const host = makeHost(); host.register(runtime); await host.start()
  let disposed = false, cold: Host | undefined
  t.after(async () => { if (cold) await cold.dispose().catch(() => {}); if (!disposed) await host.dispose(); await rm(dir, { recursive: true, force: true }) })
  const base: Session = { ...new FakeSession(runtime, sid, { cwd: dir, model: 'fake-1' }, {}).snapshot(), itemsLoaded: true }
  const saved = [
    turn('one', [message('u1', 'repeat', 'user'), message('a1', 'answer', 'assistant'), { id: itemId('owned'), type: 'notice', kind: 'conversation:warning', text: 'saved notice' }]),
    turn('two', [message('u2', 'repeat', 'user'), message('a2', 'answer', 'assistant')]),
  ]
  runtime.emit({ type: 'session/started', session: { ...base, turns: saved } })
  await host.dispose(); disposed = true
  const replay: Session = { ...base, turns: [
    turn(mode === 'new ids' ? 'new-one' : 'one', [message('new-u1', 'repeat', 'user'), message('new-a1', 'answer', 'assistant')]),
    turn(mode === 'new ids' ? 'new-two' : 'two', [message('new-u2', 'repeat', 'user'), message('new-a2', 'answer', 'assistant')]),
  ] }
  const next = new FakeRuntime(); next.readSession = async () => { if (mode === 'announcement') next.emit({ type: 'session/started', session: replay }); return replay }
  if (mode === 'resume') next.resumeSession = async () => { next.emit({ type: 'session/started', session: replay }); return new FakeSession(next, sid, { cwd: dir, model: 'fake-1' }, {}) }
  cold = makeHost(); cold.register(next); await cold.start()
  const read = await cold.call(mode === 'resume' ? 'session/resume' : 'session/read', { runtime: next.info.id, sessionId: sid }) as Session
  assert.equal(read.historyPending, true, 'the ambiguous replay is held for recovery')
  assert.deepEqual(read.turns, saved, 'the protected view does not guess or graft a marker')
  const db = new TranscriptDatabase(join(dir, 'sessions.sqlite'))
  try { assert.deepEqual(db.read(runtime.info.id, sid)!.turns, saved, 'SQLite remains the previous exact body') } finally { db.close() }
  await assert.rejects(cold.dispose(), /unsaved|protected/i)
  cold = undefined
})

test('distinct prompts anchor saved-only notices despite repeated answer text', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'hd-steer-unique-prompts-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const runtime = new FakeRuntime(), sid = sessionId('unique-prompts')
  const base: Session = { ...new FakeSession(runtime, sid, { cwd: dir, model: 'fake-1' }, {}).snapshot(), itemsLoaded: true }
  const store = new TranscriptStore(join(dir, 'transcripts')); t.after(() => store.close())
  const notice: AgentItem = { id: itemId('host'), type: 'notice', kind: 'conversation:warning', text: 'saved notice' }
  const held = [turn('one', [message('u1', 'first', 'user'), message('a1', 'okay', 'assistant'), notice, message('u2', 'second', 'user'), message('a2', 'okay', 'assistant')])]
  store.record({ ...base, turns: held }, { now: true }); await store.flush()
  const replay = { ...base, turns: [turn('one', [message('new-u1', 'first', 'user'), message('new-a1', 'okay', 'assistant')]), turn('two', [message('new-u2', 'second', 'user'), message('new-a2', 'okay', 'assistant')])] }
  const result = await store.enrich(replay)
  assert.deepEqual(words(result.turns), ['first', 'okay', 'second', 'okay'])
  assert.equal(result.turns[0]!.items[2]?.id, notice.id)
})

for (const method of ['session/read', 'session/resume'] as const) test(`a scripted ACP ${method} reconciles a steered turn with live timestamps`, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'hd-acp-steer-replay-')), sid = sessionId('acp-steer-session')
  const path = join(dir, 'agent-store.json')
  await writeFile(path, JSON.stringify({ [sid]: { sessionId: sid, cwd: dir, turns: [['p1'], ['steer'], ['p2']] } }))
  const runtime = new FakeRuntime(), host = new Host({ logger: silent, state: new StateStore(join(dir, 'state.json')), builtinAgents: dir, catalogRefreshMs: 0, idleStopMs: 0 })
  host.register(runtime); await host.start()
  let disposed = false, cold: Host | undefined
  t.after(async () => { if (cold) await cold.dispose().catch(() => {}); if (!disposed) await host.dispose(); await rm(dir, { recursive: true, force: true }) })
  const base: Session = { ...new FakeSession(runtime, sid, { cwd: dir, model: 'fake-1' }, {}).snapshot(), itemsLoaded: true }
  const first = { ...turn('turn-1', [message('u1', 'p1', 'user'), message('a1', 'hearing: p1 done.', 'assistant'), message('steer', 'steer', 'user'), message('as', 'hearing: steer done.', 'assistant')]), startedAt: 1000, completedAt: 2000, durationMs: 1000 }
  const second = { ...turn('turn-2', [message('u2', 'p2', 'user'), message('a2', 'hearing: p2 done.', 'assistant')]), startedAt: 3000, completedAt: 4000, durationMs: 1000 }
  runtime.emit({ type: 'session/started', session: { ...base, turns: [first, second] } })
  await host.dispose(); disposed = true
  const peer = new AcpRuntime({ id: String(runtime.info.id), name: 'Fake ACP Agent', command: process.execPath,
    args: [join(process.cwd(), 'packages/adapter-acp/test/fixtures/fake-acp-agent.mjs')], env: { FAKE_ACP_STORE: path } })
  cold = new Host({ logger: silent, state: new StateStore(join(dir, 'state.json')), builtinAgents: dir, catalogRefreshMs: 0, idleStopMs: 0 })
  cold.register(peer); await cold.start()
  const read = await cold.call(method, { runtime: peer.info.id, sessionId: sid }) as Session
  assert.notEqual(read.historyPending, true, 'a unique ordinary ACP replay reconciles')
  assert.deepEqual(words(read.turns), ['p1', 'hearing: p1 done.', 'steer', 'hearing: steer done.', 'p2', 'hearing: p2 done.'])
  assert.equal(read.turns.length, 2, 'the exactly matched live segmentation remains intact')
  assert.equal(read.turns[0]?.startedAt, 1000)
  assert.equal(read.turns[0]?.completedAt, 2000)
  assert.equal(read.turns[0]?.durationMs, 1000)
  assert.equal(read.turns[1]?.startedAt, 3000)
  await cold.dispose(); cold = undefined
  const db = new TranscriptDatabase(join(dir, 'sessions.sqlite'))
  try { assert.deepEqual(words(db.read(runtime.info.id, sid)!.turns), words(read.turns)) } finally { db.close() }
})

test('an ambiguous replay cannot overwrite a released durable body during rehydration', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'hd-steer-released-'))
  const runtime = new FakeRuntime(), host = new Host({ logger: silent, state: new StateStore(join(dir, 'state.json')), builtinAgents: dir, catalogRefreshMs: 0, idleStopMs: 0 })
  host.register(runtime); await host.start()
  t.after(async () => { await host.dispose().catch(() => {}); await rm(dir, { recursive: true, force: true }) })
  const created = await host.call('session/create', { runtime: runtime.info.id, options: { cwd: dir } }) as Session
  const saved = [
    turn('one', [message('u1', 'repeat', 'user'), message('a1', 'answer', 'assistant'), { id: itemId('owned'), type: 'notice', kind: 'conversation:warning', text: 'saved notice' }]),
    turn('two', [message('u2', 'repeat', 'user'), message('a2', 'answer', 'assistant')]),
  ]
  runtime.emit({ type: 'session/started', session: { ...created, turns: saved, itemsLoaded: true } })
  await host.call('session/close', { runtime: runtime.info.id, sessionId: created.id })
  const held = host.registry.get(runtime.info.id, created.id)!
  assert.equal(held.session.itemsLoaded, false, 'the real close releases its body')
  const replay = { ...created, itemsLoaded: true, turns: [
    turn('one', [message('new-u1', 'repeat', 'user'), message('new-a1', 'answer', 'assistant')]),
    turn('two', [message('new-u2', 'repeat', 'user'), message('new-a2', 'answer', 'assistant')]),
  ] }
  runtime.emit({ type: 'session/started', session: replay })
  assert.equal(held.transcriptIncomplete, true)
  assert.deepEqual(held.session.turns, saved)
  const db = new TranscriptDatabase(join(dir, 'sessions.sqlite'))
  try { assert.deepEqual(db.read(runtime.info.id, created.id)!.turns, saved) } finally { db.close() }
})

test('an ambiguous replay cannot overwrite a released durable body on a silent read', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'hd-steer-released-'))
  const runtime = new FakeRuntime(), host = new Host({ logger: silent, state: new StateStore(join(dir, 'state.json')), builtinAgents: dir, catalogRefreshMs: 0, idleStopMs: 0 })
  host.register(runtime); await host.start()
  t.after(async () => { await host.dispose().catch(() => {}); await rm(dir, { recursive: true, force: true }) })
  const created = await host.call('session/create', { runtime: runtime.info.id, options: { cwd: dir } }) as Session
  const saved = [
    turn('one', [message('u1', 'repeat', 'user'), message('a1', 'answer', 'assistant'), { id: itemId('owned'), type: 'notice', kind: 'conversation:warning', text: 'saved notice' }]),
    turn('two', [message('u2', 'repeat', 'user'), message('a2', 'answer', 'assistant')]),
  ]
  runtime.emit({ type: 'session/started', session: { ...created, turns: saved, itemsLoaded: true } })
  await host.call('session/close', { runtime: runtime.info.id, sessionId: created.id })
  const held = host.registry.get(runtime.info.id, created.id)!
  assert.equal(held.session.itemsLoaded, false, 'the real close releases its body')
  const replay = { ...created, itemsLoaded: true, turns: [
    turn('one', [message('new-u1', 'repeat', 'user'), message('new-a1', 'answer', 'assistant')]),
    turn('two', [message('new-u2', 'repeat', 'user'), message('new-a2', 'answer', 'assistant')]),
  ] }
  runtime.readSession = async () => replay
  const read = await host.call('session/read', { runtime: runtime.info.id, sessionId: created.id }) as Session
  assert.equal(read.historyPending, true)
  assert.deepEqual(read.turns, saved)
  const db = new TranscriptDatabase(join(dir, 'sessions.sqlite'))
  try { assert.deepEqual(db.read(runtime.info.id, created.id)!.turns, saved) } finally { db.close() }
})


test('large repeated-prompt history remains protected without pairing by text', () => {
  const runtime = new FakeRuntime(), sid = sessionId('large-replay')
  const base: Session = { ...new FakeSession(runtime, sid, { cwd: '/synthetic', model: 'fake-1' }, {}).snapshot(), itemsLoaded: true }
  const count = 3_000
  const held = Array.from({ length: count }, (_, n) => turn(`old-${n}`, [message(`old-u${n}`, 'repeat', 'user'), message(`old-a${n}`, 'answer', 'assistant')]))
  const replay = Array.from({ length: count }, (_, n) => turn(`new-${n}`, [message(`new-u${n}`, 'repeat', 'user'), message(`new-a${n}`, 'answer', 'assistant')]))
  assert.deepEqual(reconcileProseReplay({ ...base, turns: replay }, { turns: held }), { kind: 'ambiguous' })
  assert.equal(held.length, count)
  assert.equal(replay.length, count)
})

for (const announces of [true, false]) test(`stable repeated prompt identities remain readable on ${announces ? 'announcement' : 'silent read'}`, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'hd-stable-repeat-')), sid = sessionId('stable-repeat')
  const runtime = new FakeRuntime()
  const makeHost = () => new Host({ logger: silent, state: new StateStore(join(dir, 'state.json')), builtinAgents: dir, catalogRefreshMs: 0, idleStopMs: 0 })
  const host = makeHost(); host.register(runtime); await host.start()
  let closed = false, cold: Host | undefined
  t.after(async () => { if (cold) await cold.dispose().catch(() => {}); if (!closed) await host.dispose(); await rm(dir, { recursive: true, force: true }) })
  const base: Session = { ...new FakeSession(runtime, sid, { cwd: dir, model: 'fake-1' }, {}).snapshot(), itemsLoaded: true }
  const notice: AgentItem = { id: itemId('host-notice'), type: 'notice', kind: 'conversation:warning', text: 'host-only' }
  const saved = [turn('one', [message('u1', 'continue', 'user'), message('a1', 'first answer', 'assistant'), notice]),
    turn('two', [message('u2', 'continue', 'user'), message('a2', 'second answer', 'assistant')])]
  runtime.emit({ type: 'session/started', session: { ...base, turns: saved } })
  await host.dispose(); closed = true
  const replay: Session = { ...base, turns: [turn('one', saved[0]!.items.slice(0, 2) as AgentItem[]), turn('two', [...saved[1]!.items])] }
  const next = new FakeRuntime(); next.readSession = async () => { if (announces) next.emit({ type: 'session/started', session: replay }); return replay }
  cold = makeHost(); cold.register(next); await cold.start()
  const read = await cold.call('session/read', { runtime: next.info.id, sessionId: sid }) as Session
  assert.notEqual(read.historyPending, true, 'unchanged message identities are not ambiguous')
  assert.deepEqual(read.turns.map(turn => turn.items), saved.map(turn => turn.items), 'the omitted host notice remains on its original turn')
  await cold.dispose(); cold = undefined
  const db = new TranscriptDatabase(join(dir, 'sessions.sqlite'))
  try { assert.deepEqual(db.read(runtime.info.id, sid)!.turns.map(turn => turn.items), saved.map(turn => turn.items)) } finally { db.close() }
})
