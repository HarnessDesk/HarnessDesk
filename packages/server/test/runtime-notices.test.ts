import assert from 'node:assert/strict'
import { test } from 'node:test'
import { join } from 'node:path'
import { Host } from '../src/host.js'
import { StateStore } from '../src/state.js'
import { FakeRuntime } from './fixtures/fake-runtime.js'
import { silent } from './fixtures/harness.js'
import { tempDir } from './scratch.js'
import { runtimeId, runtimeNoticeKey, type AgentEvent } from '@harnessdesk/protocol'
import { retainRuntimeNotice, readRuntimeNotices } from '../src/runtime-notices.js'

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
