import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { AcpRuntime } from '@harnessdesk/adapter-acp'
import { Host, Logger, StateStore } from '../src/index.js'

const FAKE = fileURLToPath(new URL('../../../adapter-acp/dist/test/fixtures/fake-acp-agent.mjs', import.meta.url))

test('host calls wait for an adapter-owned last-handle stop before reopening', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'hd-acp-release-race-'))
  const runtime = new AcpRuntime({ id: 'shared', name: 'Shared', command: process.execPath, args: [FAKE],
    sharedSessionProcess: true, env: { FAKE_ACP_NO_CLOSE: '1', FAKE_ACP_STORE: join(dir, 'store.json') } })
  const host = new Host({ logger: new Logger('test', { console: false }), state: new StateStore(join(dir, 'state.json')),
    catalogRefreshMs: 0, idleStopMs: 0, sessionRestMs: 0 })
  let release!: () => void
  const barrier = new Promise<void>(resolve => { release = resolve })
  t.after(async () => { release(); await host.dispose(); await rm(dir, { recursive: true, force: true }) })
  host.register(runtime)
  await host.start()
  const session = await runtime.createSession({ cwd: dir })
  await runtime.listSkills()
  const connection = runtime.connectionFor(session.id)
  const stop = connection.stop.bind(connection)
  let entered!: () => void
  const entering = new Promise<void>(resolve => { entered = resolve })
  connection.stop = async () => {
    const stopped = stop()
    entered()
    await barrier
    await stopped
  }
  const closing = session.close()
  await entering
  const listing = host.call('session/list', { runtime: runtime.info.id })
  const opening = host.call('session/create', { runtime: runtime.info.id, options: { cwd: dir } })
  const results = Promise.allSettled([listing, opening])
  release()
  await closing
  assert.deepEqual((await results).map(result => result.status), ['fulfilled', 'fulfilled'])
  assert.equal(runtime.health().state, 'ready')
})

const waitFor = async (check: () => boolean): Promise<void> => {
  const deadline = Date.now() + 3_000
  while (!check()) {
    assert.ok(Date.now() < deadline, 'host lifecycle did not settle')
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}

const hello = (): { type: 'text'; text: string }[] => [{ type: 'text', text: 'Hello' }]

for (const door of ['session/resume', 'turn/send'] as const) {
  test(`personal rest restores model and mode before ${door} on a peer that forgets picks`, async (t) => {
    const dir = await mkdtemp(join(tmpdir(), 'hd-acp-rest-picks-'))
    const runtime = new AcpRuntime({ id: 'picks', name: 'Picks', command: process.execPath, args: [FAKE],
      env: { FAKE_ACP_STORE: join(dir, 'store.json') } })
    const host = new Host({ logger: new Logger('test', { console: false }), state: new StateStore(join(dir, 'state.json')),
      catalogRefreshMs: 0, idleStopMs: 25, sessionRestMs: 25 })
    t.after(async () => { await host.dispose(); await rm(dir, { recursive: true, force: true }) })
    host.register(runtime)
    await host.start()
    const session = await host.call('session/create', { runtime: runtime.info.id, options: { cwd: dir } }) as { id: string }
    const params = { runtime: runtime.info.id, sessionId: session.id as never }
    for (const [optionId, value] of [['model', 'large'], ['mode', 'terse']] as const) {
      await host.call('session/options/set', { ...params, optionId, value })
    }
    // The agent stores a conversation at its first message, so only a prompted one can be reopened.
    await host.call('turn/send', { ...params, input: hello() })
    const record = host.registry.get(runtime.info.id, params.sessionId)!
    await waitFor(() => record.live === null)
    await host.call(door, { ...params, ...(door === 'turn/send' ? { input: [{ type: 'text', text: 'Continue' }] } : {}) })
    assert.deepEqual(record.live!.options().filter(option => ['model', 'mode'].includes(option.id))
      .map(option => [option.id, option.currentValue]).sort(), [['mode', 'terse'], ['model', 'large']])
  })
}

test('the rest keeps a conversation the agent was never prompted in, which it could not reopen', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'hd-acp-rest-unprompted-'))
  // Stores a conversation at its first message and lists nothing before it, as most agents do.
  const runtime = new AcpRuntime({ id: 'unprompted', name: 'Unprompted', command: process.execPath, args: [FAKE],
    env: { FAKE_ACP_STORE: join(dir, 'store.json') } })
  const host = new Host({ logger: new Logger('test', { console: false }), state: new StateStore(join(dir, 'state.json')),
    catalogRefreshMs: 0, idleStopMs: 25, sessionRestMs: 25 })
  t.after(async () => { await host.dispose(); await rm(dir, { recursive: true, force: true }) })
  host.register(runtime)
  await host.start()
  const drafted = await host.call('session/create', { runtime: runtime.info.id, options: { cwd: dir } }) as { id: string }
  const prompted = await host.call('session/create', { runtime: runtime.info.id, options: { cwd: dir } }) as { id: string }
  await host.call('turn/send', { runtime: runtime.info.id, sessionId: prompted.id as never, input: hello() })
  const spoken = host.registry.get(runtime.info.id, prompted.id as never)!
  // The sweep has had its chance once it has rested the conversation it may rest.
  await waitFor(() => spoken.live === null)
  // Nothing is stored for a conversation with no turn, so its handle is the only way back to it.
  const completed = new Promise<void>(resolve => {
    const off = runtime.subscribe(event => {
      if ('sessionId' in event && event.sessionId === drafted.id && event.type === 'turn/completed') { off(); resolve() }
    })
  })
  await host.call('turn/send', { runtime: runtime.info.id, sessionId: drafted.id as never, input: hello() })
  await completed
})

for (const door of ['session/resume', 'turn/send'] as const) {
  test(`a held pick the agent now greys does not make the conversation unopenable through ${door}`, async (t) => {
    const dir = await mkdtemp(join(tmpdir(), 'hd-acp-rest-greyed-'))
    // Cannot honour the voice control once a stored conversation is opened again.
    const runtime = new AcpRuntime({ id: 'greyed', name: 'Greyed', command: process.execPath, args: [FAKE],
      env: { FAKE_ACP_STORE: join(dir, 'store.json'), FAKE_ACP_GREY_ON_LOAD: 'voice' } })
    const host = new Host({ logger: new Logger('test', { console: false }), state: new StateStore(join(dir, 'state.json')),
      catalogRefreshMs: 0, idleStopMs: 25, sessionRestMs: 25 })
    t.after(async () => { await host.dispose(); await rm(dir, { recursive: true, force: true }) })
    host.register(runtime)
    await host.start()
    const session = await host.call('session/create', { runtime: runtime.info.id, options: { cwd: dir } }) as { id: string }
    const params = { runtime: runtime.info.id, sessionId: session.id as never }
    await host.call('session/options/set', { ...params, optionId: 'voice', value: 'pirate' })
    await host.call('turn/send', { ...params, input: hello() })
    const record = host.registry.get(runtime.info.id, params.sessionId)!
    await waitFor(() => record.live === null)
    await host.call(door, { ...params, ...(door === 'turn/send' ? { input: hello() } : {}) })
    assert.equal(record.live!.options().find(option => option.id === 'voice')?.currentValue, 'plain',
      'the pick had no place in the reopened conversation and was dropped')
    assert.equal(record.restedOptions, undefined, 'the held picks are spent')
  })
}

test('host close of a refused handle clears it and the following send streams a reply', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'hd-acp-refused-host-'))
  const runtime = new AcpRuntime({ id: 'refusal', name: 'Refusal', command: process.execPath, args: [FAKE],
    env: { FAKE_ACP_STORE: join(dir, 'store.json'), FAKE_ACP_STORE_DRAFTS: '1', FAKE_ACP_CLOSE_FAIL: '1' } })
  const host = new Host({ logger: new Logger('test', { console: false }), state: new StateStore(join(dir, 'state.json')),
    catalogRefreshMs: 0, idleStopMs: 0, sessionRestMs: 0 })
  t.after(async () => { await host.dispose(); await rm(dir, { recursive: true, force: true }) })
  host.register(runtime)
  await host.start()
  const session = await host.call('session/create', { runtime: runtime.info.id, options: { cwd: dir } }) as { id: string }
  const params = { runtime: runtime.info.id, sessionId: session.id as never }
  const record = host.registry.get(runtime.info.id, params.sessionId)!
  const old = record.live
  await host.call('session/close', params)
  assert.equal(record.live, null)
  let items = 0
  const completed = new Promise<void>(resolve => {
    const off = runtime.subscribe(event => {
      if (!('sessionId' in event) || event.sessionId !== params.sessionId) return
      if (event.type === 'item/started' || event.type === 'item/completed') items++
      if (event.type === 'turn/completed') { off(); resolve() }
    })
  })
  await host.call('turn/send', { ...params, input: [{ type: 'text', text: 'Reply after reopening' }] })
  await completed
  assert.notEqual(record.live, old)
  assert.ok(items > 0, 'reopened handle routes reply items to the host')
})
