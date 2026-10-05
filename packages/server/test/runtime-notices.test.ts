import assert from 'node:assert/strict'
import { test } from 'node:test'
import { join } from 'node:path'
import { Host } from '../src/host.js'
import { StateStore } from '../src/state.js'
import { FakeRuntime } from './fixtures/fake-runtime.js'
import { silent } from './fixtures/harness.js'
import { tempDir } from './scratch.js'
import { runtimeId, runtimeNoticeKey, type AgentEvent } from '@harnessdesk/protocol'
import { retainRuntimeNotice, readRuntimeNotices, keepRuntimeInboxEntry, mergeNoticePreferences } from '../src/runtime-notices.js'

const event = (): Extract<AgentEvent, { type: 'notice' }> => ({ type: 'notice', kind: 'runtime:config', class: 'info', level: 'warning', message: 'Ignored settings', detail: { summary: 'Ignored settings', settings: ['features.bogus'], file: '/Users/user/.config/agent.toml' }, id: 'event-1', at: 1 })
test('runtime information is retained before a client joins, counted and read after a restart', () => {
  const first = retainRuntimeNotice([], runtimeId('demo'), event())
  assert.equal(first.length, 1)
  const second = retainRuntimeNotice(first, runtimeId('demo'), { ...event(), id: 'event-2', at: 2 })
  assert.equal(second.length, 1)
  assert.equal(second[0]?.event.count, 2)
  assert.equal(second[0]?.event.at, 2)
  assert.deepEqual(readRuntimeNotices(JSON.parse(JSON.stringify(second))), second)
})
test('conversation notices never enter runtime information history', () => {
  assert.deepEqual(retainRuntimeNotice([], runtimeId('demo'), { ...event(), kind: 'conversation:warning', class: 'conversation', sessionId: 's1' as never }), [])
})


test('a runtime starting before any client connects keeps its information in host preferences', async t => {
  const base = tempDir('hd-runtime-notices-')
  const state = new StateStore(join(base, 'state.json'))
  class StartingRuntime extends FakeRuntime {
    override async start() { await super.start(); this.emit(event()) }
  }
  const host = new Host({ logger: silent, state, builtinAgents: join(base, 'agents'), libraryHome: join(base, 'library') })
  t.after(() => host.dispose())
  host.register(new StartingRuntime())
  await host.start()
  const preferences = await host.call('app/state/get', {})
  const retained = readRuntimeNotices(preferences['runtimeNotices'])
  assert.equal(retained.length, 1)
  assert.equal(retained[0]?.event.detail?.settings[0], 'features.bogus')
  assert.equal(retained[0]?.event.count, 1)
})


test('runtime counts outlive the bounded information history, including muted kinds', () => {
  const runtime = runtimeId('demo')
  const counts: Record<string, number> = {}
  let history = retainRuntimeNotice([], runtime, event(), counts)
  for (let n = 2; n <= 7; n++) history = retainRuntimeNotice(history, runtime, { ...event(), id: `event-${n}`, at: n }, counts)
  counts[runtimeNoticeKey(runtime, event())] = 7
  for (let n = 0; n < 100; n++) history = retainRuntimeNotice(history, runtime, { ...event(), id: `other-${n}`, message: `Other ${n}`, at: 10 + n }, counts)
  assert.equal(history.some(entry => entry.event.message === event().message), false)
  const next = retainRuntimeNotice(history, runtime, { ...event(), id: 'next', at: 110 }, counts)
  assert.equal(next[0]?.event.count, 8)
})

for (const rejects of [false, true]) test(`shutdown waits for a ${rejects ? 'refused' : 'delayed'} runtime information write`, async t => {
  const base = tempDir('hd-runtime-notice-shutdown-')
  let release!: () => void
  const delayed = new Promise<void>(resolve => { release = resolve })
  class DelayedState extends StateStore {
    override async setPreferences(patch: Record<string, unknown>) {
      if ('runtimeNotices' in patch) {
        await delayed
        if (rejects) throw new Error('Fixture write refused')
      }
      await super.setPreferences(patch)
    }
  }
  const state = new DelayedState(join(base, 'state.json'))
  const host = new Host({ logger: silent, state, builtinAgents: join(base, 'agents'), libraryHome: join(base, 'library') })
  const runtime = new FakeRuntime()
  host.register(runtime)
  await host.start()
  runtime.emit(event())
  let closed = false
  const closing = host.dispose().then(() => { closed = true })
  t.after(async () => { release(); await closing })
  try {
    await new Promise(resolve => setTimeout(resolve, 50))
    assert.equal(closed, false, 'the event writer is part of shutdown')
  } finally {
    release()
    await closing
  }
  assert.equal(closed, true, 'a refused write cannot strand shutdown')
})

test('a conversation notice keeps its scope when its event id matches retained information', async t => {
  const base = tempDir('hd-runtime-notice-scope-')
  const state = new StateStore(join(base, 'state.json'))
  const host = new Host({ logger: silent, state, builtinAgents: join(base, 'agents'), libraryHome: join(base, 'library') })
  t.after(() => host.dispose())
  const runtime = new FakeRuntime()
  const events: AgentEvent[] = []
  host.addBroadcaster(notification => { if (notification.method === 'event') events.push(notification.params.event) })
  host.register(runtime)
  await host.start()
  runtime.emit(event())
  runtime.emit({ ...event(), class: 'conversation', kind: 'conversation:warning', sessionId: 's1' as never, message: 'Scoped update' })
  const last = events.at(-1)
  assert.equal(last?.type === 'notice' && last.sessionId, 's1')
  assert.equal(last?.type === 'notice' && last.message, 'Scoped update')
  assert.equal(last?.type === 'notice' && last.class, 'conversation')
})

test('an information replay matches its content as well as its event id', async t => {
  const base = tempDir('hd-runtime-notice-replay-')
  const state = new StateStore(join(base, 'state.json'))
  const host = new Host({ logger: silent, state, builtinAgents: join(base, 'agents'), libraryHome: join(base, 'library') })
  t.after(() => host.dispose())
  const runtime = new FakeRuntime()
  const events: AgentEvent[] = []
  host.addBroadcaster(notification => { if (notification.method === 'event') events.push(notification.params.event) })
  host.register(runtime)
  await host.start()
  runtime.emit(event())
  runtime.emit({ ...event(), message: 'Another warning' })
  runtime.emit(event())
  const last = events.at(-1)
  assert.equal(last?.type === 'notice' && last.message, event().message)
  assert.deepEqual(readRuntimeNotices(state.state.preferences['runtimeNotices']).map(entry => entry.event.count), [1, 1])
})


test('runtime Inbox writes merge with current host read, clear and mute memory', async t => {
  const base = tempDir('hd-inbox-merge-')
  const state = new StateStore(join(base, 'state.json'))
  const host = new Host({ logger: silent, state, builtinAgents: join(base, 'agents'), libraryHome: join(base, 'library') })
  t.after(() => host.dispose())
  await host.start()
  const entry = { id: 'content:config', contentKey: 'content:config', kind: 'runtime:config', title: 'Ignored setting', tone: 'warning' as const, at: 1, count: 1, lastEvent: 'first' }
  const call = (value: typeof entry) => host.call('app/inbox/keepInfo', { entry: value })
  await call(entry)
  await call(entry)
  let preferences = await host.call('app/state/get', {})
  assert.equal((preferences['inbox'] as { count: number }[])[0]?.count, 1, 'two windows keep one occurrence')
  const policy = { ...(preferences['noticePolicy'] as object), muted: [], seen: ['standing'], records: { standing: { count: 2, at: 1 } }, surfaces: {} }
  await state.setPreferences({ inbox: [{ ...entry, read: true }], noticePolicy: policy })
  await call({ ...entry, count: 2, at: 2, lastEvent: 'second' })
  preferences = await host.call('app/state/get', {})
  assert.equal((preferences['inbox'] as { read: boolean; count: number }[])[0]?.read, true)
  assert.deepEqual(preferences['noticePolicy'], policy)
  await state.setPreferences({ inbox: [] })
  await call({ ...entry, count: 3, at: 3, lastEvent: 'third' })
  assert.deepEqual((await host.call('app/state/get', {}))['inbox'], [], 'cleared unchanged content stays cleared')
  const muted = { ...policy, muted: ['runtime:config'] }
  await state.setPreferences({ noticePolicy: muted })
  await call({ ...entry, id: 'content:new', contentKey: 'content:new', count: 1 })
  preferences = await host.call('app/state/get', {})
  assert.deepEqual(preferences['inbox'], [])
  assert.deepEqual(preferences['noticePolicy'], muted)
})


test('reads and clears from a stale window remain effective after runtime content repeats', async t => {
  const base = tempDir('hd-inbox-content-repeat-')
  const state = new StateStore(join(base, 'state.json'))
  const host = new Host({ logger: silent, state, builtinAgents: join(base, 'agents'), libraryHome: join(base, 'library') })
  t.after(() => host.dispose())
  await host.start()
  const first = { id: 'content:config', contentKey: 'content:config', kind: 'runtime:config', title: 'Ignored setting', tone: 'warning' as const, at: 1, count: 1, lastEvent: 'first' }
  const keep = (entry: typeof first) => host.call('app/inbox/keepInfo', { entry })
  await keep(first)
  await keep({ ...first, at: 2, count: 2, lastEvent: 'second' })
  await host.call('app/state/set', {
    patch: { inbox: [{ ...first, read: true }] },
    noticeBase: { inbox: [{ ...first, read: false }] },
  })
  assert.deepEqual(state.state.preferences['inbox'], [{ ...first, at: 2, count: 2, lastEvent: 'second', read: true }], 'a read from the first copy applies to the repeated content')
  await keep({ ...first, at: 3, count: 3, lastEvent: 'third' })
  assert.deepEqual(state.state.preferences['inbox'], [{ ...first, at: 3, count: 3, lastEvent: 'third', read: true }], 'another repeat keeps the read state')

  await host.call('app/state/set', { patch: { inbox: [] }, noticeBase: { inbox: [{ ...first, read: false }] } })
  assert.deepEqual(state.state.preferences['inbox'], [], 'a clear from the first copy removes the repeated content')
  await keep({ ...first, at: 4, count: 4, lastEvent: 'fourth' })
  assert.deepEqual(state.state.preferences['inbox'], [], 'another repeat does not restore cleared content')
})


test('a malformed stored Inbox count does not poison a new occurrence', () => {
  const entry = { id: 'content:warning', contentKey: 'content:warning', kind: 'runtime:warning', title: 'Warning', tone: 'warning' as const, at: 2, count: 2 }
  const patch = keepRuntimeInboxEntry({ inbox: [{ ...entry, at: 1, count: 'invalid', read: true }] }, entry)
  assert.equal((patch?.['inbox'] as { count: number }[])[0]?.count, 2)
})


test('a runtime Inbox merge returns current memory even for a replay, cleared content or a mute', async t => {
  const base = tempDir('hd-inbox-answer-')
  const state = new StateStore(join(base, 'state.json'))
  const host = new Host({ logger: silent, state, builtinAgents: join(base, 'agents'), libraryHome: join(base, 'library') })
  t.after(() => host.dispose())
  await host.start()
  const entry = { id: 'content:config', contentKey: 'content:config', kind: 'runtime:config', title: 'Ignored setting', tone: 'warning' as const, at: 1, count: 1, lastEvent: 'first' }
  const call = () => host.call('app/inbox/keepInfo', { entry })
  assert.deepEqual(await call(), await host.call('app/state/get', {}))
  assert.deepEqual(await call(), await host.call('app/state/get', {}))
  await state.setPreferences({ inbox: [], noticePolicy: { kept: [entry.contentKey], muted: ['runtime:config'] } })
  assert.deepEqual(await call(), await host.call('app/state/get', {}))
})

test('stale content Inbox writes preserve the latest details while merging read state', async t => {
  const base = tempDir('hd-inbox-stale-write-')
  const state = new StateStore(join(base, 'state.json'))
  const host = new Host({ logger: silent, state, builtinAgents: join(base, 'agents'), libraryHome: join(base, 'library') })
  t.after(() => host.dispose())
  await host.start()
  const old = { id: 'content:old', contentKey: 'content:old', kind: 'runtime:warning', title: 'Old warning', at: 1, read: false }
  const newer = { id: 'new', title: 'New message', at: 2, read: false }
  await state.setPreferences({ inbox: [newer], noticePolicy: { kept: [old.contentKey] } })
  await host.call('app/state/set', { patch: { inbox: [{ ...old, read: true }] }, noticeBase: { inbox: [old] } })
  assert.deepEqual(state.state.preferences['inbox'], [newer])
  const latest = { ...old, at: 3, count: 3 }
  await state.setPreferences({ inbox: [latest, newer] })
  await host.call('app/state/set', { patch: { inbox: [{ ...old, read: true }] }, noticeBase: { inbox: [old] } })
  assert.deepEqual(state.state.preferences['inbox'], [{ ...latest, read: true }, newer], 'a stale content read keeps the current details and marks that content read')
  const readSnapshot = { ...old, read: true }
  await host.call('app/state/set', { patch: { inbox: [old, newer] }, noticeBase: { inbox: [readSnapshot, newer] } })
  assert.deepEqual(state.state.preferences['inbox'], [{ ...latest, read: true }, newer], 'a stale unread copy cannot reverse a read')
  await host.call('app/state/set', { patch: { inbox: [] }, noticeBase: { inbox: [old] } })
  assert.deepEqual(state.state.preferences['inbox'], [newer], 'clearing the content-keyed row preserves other newer rows')
})


test('a cached policy changes only the chosen kind and preserves another window mute and content memory', async t => {
  const base = tempDir('hd-policy-stale-write-')
  const state = new StateStore(join(base, 'state.json'))
  const host = new Host({ logger: silent, state, builtinAgents: join(base, 'agents'), libraryHome: join(base, 'library') })
  t.after(() => host.dispose())
  await host.start()
  const old = { muted: [], kept: [], seen: [], records: {}, surfaces: {} }
  const current = { ...old, muted: ['runtime:config'], kept: ['content:config'] }
  await state.setPreferences({ noticePolicy: current })
  await host.call('app/state/set', { patch: { noticePolicy: { ...old, muted: ['runtime:warning'] } }, noticeBase: { noticePolicy: old } })
  assert.deepEqual(state.state.preferences['noticePolicy'], { ...current, muted: ['runtime:config', 'runtime:warning'] })
})


test('cached standing-message writes preserve newer-first order and a read on the same occurrence', () => {
  const old = { id: 'goal', title: 'Goal update', at: 1, read: false }
  const other = { id: 'other', title: 'Other message', at: 2, read: false }
  const refreshed = { ...old, title: 'Goal finished', at: 3 }
  assert.deepEqual(mergeNoticePreferences({ inbox: [other, old] }, { inbox: [refreshed, other] }, { inbox: [other, old] })['inbox'], [refreshed, other])
})

test('a delayed standing-message copy preserves a read on the same occurrence', () => {
  const refreshed = { id: 'goal', title: 'Goal finished', at: 3, read: false }
  assert.deepEqual(mergeNoticePreferences({ inbox: [{ ...refreshed, read: true }] }, { inbox: [refreshed] }, { inbox: [] })['inbox'], [{ ...refreshed, read: true }], 'another window cannot make the identical occurrence unread')
})

test('a recurring standing notice is unread after another window read its earlier occurrence', async t => {
  const base = tempDir('hd-inbox-recur-read-')
  const state = new StateStore(join(base, 'state.json'))
  const host = new Host({ logger: silent, state, builtinAgents: join(base, 'agents'), libraryHome: join(base, 'library') })
  t.after(() => host.dispose())
  await host.start()
  const earlier = { id: 'signin:demo', title: 'Agent is not signed in', at: 1, read: false }
  const later = { ...earlier, at: 2 }
  const runtimeTombstone = 'content:runtime-warning'
  await state.setPreferences({ inbox: [earlier], noticePolicy: { kept: ['signin:demo', runtimeTombstone] } })

  // Window A ends the previous condition and has read its row. Window B still
  // has the old row as its baseline when the same notice id recurs.
  await host.call('app/state/set', {
    patch: { inbox: [{ ...earlier, read: true }], noticePolicy: { kept: [runtimeTombstone] } },
    noticeBase: { inbox: [earlier], noticePolicy: { kept: ['signin:demo', runtimeTombstone] } },
  })
  await host.call('app/state/set', { patch: { inbox: [later] }, noticeBase: { inbox: [earlier] } })
  assert.deepEqual(state.state.preferences['inbox'], [later], 'the later occurrence is new and unread')
  await state.setPreferences({ noticePolicy: { kept: [runtimeTombstone, 'signin:demo'] } })
  await host.call('app/state/set', { patch: { inbox: [{ ...later, at: 3 }] }, noticeBase: { inbox: [earlier] } })
  assert.deepEqual(state.state.preferences['inbox'], [later], 'another window cannot replay the active occurrence as a newer one')

  // A delayed read or clear from Window A belongs to the earlier occurrence.
  await host.call('app/state/set', { patch: { inbox: [{ ...earlier, read: true }] }, noticeBase: { inbox: [earlier] } })
  await host.call('app/state/set', { patch: { inbox: [] }, noticeBase: { inbox: [earlier] } })
  assert.deepEqual(state.state.preferences['inbox'], [later], 'stale edits cannot read or remove the later occurrence')
  assert.deepEqual(state.state.preferences['noticePolicy'], { kept: [runtimeTombstone, 'signin:demo'] }, 'Inbox edits preserve host tombstones')
})

test('a recurring standing notice can return after a clear, while a replay of it stays cleared', async t => {
  const base = tempDir('hd-inbox-recur-clear-')
  const state = new StateStore(join(base, 'state.json'))
  const host = new Host({ logger: silent, state, builtinAgents: join(base, 'agents'), libraryHome: join(base, 'library') })
  t.after(() => host.dispose())
  await host.start()
  const earlier = { id: 'signin:demo', title: 'Agent is not signed in', at: 1, read: false }
  const later = { ...earlier, at: 2 }
  const runtimeTombstone = 'content:runtime-warning'
  await state.setPreferences({ inbox: [earlier], noticePolicy: { kept: ['signin:demo', runtimeTombstone] } })

  // Window A clears the earlier row. Window B still has its earlier snapshot
  // when it delivers the genuinely newer occurrence.
  await host.call('app/state/set', {
    patch: { inbox: [], noticePolicy: { kept: [runtimeTombstone] } },
    noticeBase: { inbox: [earlier], noticePolicy: { kept: ['signin:demo', runtimeTombstone] } },
  })
  await host.call('app/state/set', { patch: { inbox: [later] }, noticeBase: { inbox: [earlier] } })
  assert.deepEqual(state.state.preferences['inbox'], [later], 'the new occurrence is admitted unread')
  await state.setPreferences({ noticePolicy: { kept: [runtimeTombstone, 'signin:demo'] } })

  // Clearing that occurrence leaves its identity behind so a delayed replay
  // from Window B cannot put it back.
  await host.call('app/state/set', { patch: { inbox: [] }, noticeBase: { inbox: [later] } })
  await host.call('app/state/set', {
    patch: { noticePolicy: { kept: [runtimeTombstone] } },
    noticeBase: { noticePolicy: { kept: [runtimeTombstone, 'signin:demo'] } },
  })
  await host.call('app/state/set', { patch: { inbox: [later] }, noticeBase: { inbox: [earlier] } })
  assert.deepEqual(state.state.preferences['inbox'], [], 'the identical replay remains cleared')
  assert.deepEqual((state.state.preferences['noticePolicy'] as { kept: string[] }).kept, [runtimeTombstone], 'the replay does not remove host tombstones')

  const next = { ...later, at: 3 }
  await host.call('app/state/set', { patch: { inbox: [next] }, noticeBase: { inbox: [later] } })
  assert.deepEqual(state.state.preferences['inbox'], [next], 'a later occurrence can be admitted after the clear')
})
