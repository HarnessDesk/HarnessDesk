import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { CodexRuntime } from '@harnessdesk/adapter-codex'
import { AcpRuntime } from '@harnessdesk/adapter-acp'
import { runtimeId, sessionId, type AgentRuntime, type AgentSession, type Lane, type Session } from '@harnessdesk/protocol'
import { Host, Logger, StateStore } from '../src/index.js'
import { environmentForCheckout, environmentForSession, laneEnvironmentFor } from '../src/goals/lane-environment.js'
import type { HostContext } from '../src/methods/context.js'
import { sessionMethods } from '../src/methods/sessions.js'
import { SessionIndex } from '../src/session-index.js'
import { FakeRuntime } from './fixtures/fake-runtime.js'

const lane: Lane = {
  id: 'lane-1', goal: 'goal-1', seat: 'seat-1', cwd: '/work/lane-1', branch: 'lane-1',
  ports: { start: 30000, end: 30019 }, browserProfile: null, state: 'retained', createdAt: 1,
}
const id = sessionId('conversation-1')

// Like an uncached adapter, this runtime learns environment support only at
// startup. The live proxy starts it after the handler has assembled options.
const laneContext = (supported: boolean) => {
  const source = new FakeRuntime({ capabilities: { sessionEnvironment: false } })
  let starts = 0
  const ensureStarted = async () => {
    if (source.health().state === 'ready') return
    starts++
    // Negotiation answers asynchronously; calling start without joining it
    // must not be enough to pass the handler's capability decision.
    await Promise.resolve()
    Object.assign(source.info, { capabilities: { ...source.info.capabilities, sessionEnvironment: supported } })
    await source.start()
  }
  const runtime = new Proxy(source, {
    get(target, key) {
      if (key === 'createSession' || key === 'resumeSession' || key === 'forkSession') {
        return async (...args: unknown[]) => {
          await ensureStarted()
          return Reflect.apply(target[key], target, args)
        }
      }
      const value: unknown = Reflect.get(target, key, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  }) as AgentRuntime
  const seat = { id: lane.seat!, session: { runtime: String(runtime.info.id), sessionId: String(id) }, checkout: { cwd: lane.cwd } }
  const transcript: Session = {
    id, runtime: runtime.info.id, cwd: lane.cwd, status: { type: 'idle' }, createdAt: 1, updatedAt: 1, turns: [], itemsLoaded: true,
  }
  const ctx = {
    runtimes: { resolve: () => runtime, ensureStarted },
    laneEnvironment: {
      forCheckout: (cwd: string) => environmentForCheckout(cwd, [lane]),
      forSession: async (owner: string, conversation: string) => laneEnvironmentFor(runtime, environmentForSession(owner, conversation, [lane], [seat])),
    },
    evidence: { seats: { latestKeptOf: () => null, latestOf: () => seat } },
    registry: { forReopen: () => undefined, upsert: (session: Session, live: AgentSession) => ({ session, live }) },
    sessionIndex: { reopen: () => {}, record: () => {} },
    sessions: {
      attach: async () => transcript,
      read: async () => transcript,
      cannotReopen: (_runtime: unknown, error: Error) => error.message,
    },
  } as unknown as HostContext
  return { ctx, source, starts: () => starts }
}

for (const method of ['session/create', 'session/resume', 'session/fork'] as const) {
  for (const supported of [true, false]) {
    test(`${method} resolves cold lane support before supplying retained variables (${supported})`, async () => {
      const { ctx, source, starts } = laneContext(supported)
      await sessionMethods[method](ctx, { runtime: source.info.id, sessionId: id, options: { cwd: lane.cwd } })
      const options = method === 'session/resume' ? source.lastResumeOptions
        : method === 'session/fork' ? source.lastForkOptions : source.lastCreateOptions
      assert.deepEqual(options?.environment, supported ? environmentForCheckout(lane.cwd, [lane]) : undefined)
      assert.equal(starts(), 1)
    })
  }
}

const silent = new Logger('test', { console: false, level: 'error' })
const codex = fileURLToPath(new URL('../../../adapter-codex/test/fixtures/fake-codex.mjs', import.meta.url))

test('a known host-only archive works offline without starting its agent', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'hd-offline-archive-'))
  const runtime = new AcpRuntime({ id: 'offline', name: 'Offline agent', command: join(dir, 'missing-agent') })
  let starts = 0
  const start = runtime.start.bind(runtime)
  runtime.start = async () => { starts++; await start() }
  const target = sessionId('offline-conversation')
  const index = new SessionIndex(join(dir, 'sessions.sqlite'))
  index.upsert({ id: target, runtime: runtime.info.id, cwd: dir, title: 'Offline conversation', preview: null, status: { type: 'idle' }, createdAt: 1, updatedAt: 1 })
  index.close()
  const host = new Host({ logger: silent, state: new StateStore(join(dir, 'state.json')), catalogRefreshMs: 0, idleStopMs: 0, retryDelaysMs: [] })
  host.register(new FakeRuntime())
  host.register(runtime)
  t.after(async () => { await host.dispose(); await rm(dir, { recursive: true, force: true }) })
  await host.start()
  assert.equal(runtime.info.capabilities.archiveHistory, false)
  for (const archived of [true, false]) {
    await host.call('session/archive', { runtime: runtime.info.id, sessionId: target, archived })
    const marks = JSON.parse(await readFile(join(dir, 'archive.json'), 'utf8')) as { entries: { sessionId: string }[] }
    assert.equal(marks.entries.some(row => row.sessionId === target), archived)
    const page = await host.call('session/index', { runtimes: [runtime.info.id], archived: archived ? 'only' : 'exclude' })
    assert.ok(page.data.some(row => row.id === target), 'the local index follows the mark')
  }
  assert.equal(starts, 0)
})

test('a cold native rename reaches the agent and survives later history reads', async t => {
  for (const desk of [false, true]) await t.test(desk ? 'retained desk conversation' : 'history preview', async t => {
    const dir = await mkdtemp(join(tmpdir(), 'hd-cold-name-'))
    const runtime = new CodexRuntime({ id: runtimeId('native'), binaryPath: codex, clientName: 'test', env: { HOME: dir, CODEX_HOME: dir, FAKE_CODEX_MUTABLE_HISTORY: '1' } })
    const target = sessionId('thread-2')
    if (desk) {
      const index = new SessionIndex(join(dir, 'sessions.sqlite'))
      index.upsert({ id: target, runtime: runtime.info.id, cwd: dir, title: null,
        status: { type: 'notLoaded' }, createdAt: 1, updatedAt: 1 })
      index.close()
    }
    const host = new Host({ logger: silent, state: new StateStore(join(dir, 'state.json')), catalogRefreshMs: 0, idleStopMs: 0, retryDelaysMs: [] })
    host.register(new FakeRuntime())
    host.register(runtime)
    t.after(async () => { await host.dispose(); await rm(dir, { recursive: true, force: true }) })
    await host.start()
    assert.equal(runtime.health().state, 'idle')
    assert.equal(runtime.info.capabilities.nameHistory, false)
    const title = 'Review the startup policy'
    await host.call('session/setTitle', { runtime: runtime.info.id, sessionId: target, title })
    const listed = await host.call('session/list', { runtime: runtime.info.id })
    const native = await runtime.listSessions()
    assert.equal(native.data.find(row => row.id === target)?.title, title, 'the agent keeps the name')
    assert.equal(runtime.health().state, 'ready')
    await assert.rejects(readFile(join(dir, 'names.json'), 'utf8'), { code: 'ENOENT' })
    assert.equal(listed.data.find(row => row.id === target)?.title, title, 'learning native naming cannot discard the name')
    const indexed = await host.call('session/index', { runtimes: [runtime.info.id] })
    if (desk) assert.equal(indexed.data.find(row => row.id === target)?.title, title)
    else assert.ok(!indexed.data.some(row => row.id === target), 'renaming a preview does not adopt it')
    await host.call('history/import', { runtime: runtime.info.id })
    for (let i = 0; i < 100; i++) {
      const status = await host.call('history/status', { runtime: runtime.info.id })
      if (status?.state !== 'running') break
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    assert.equal((await host.call('history/status', { runtime: runtime.info.id }))?.state, 'done')
    assert.equal((await host.call('session/read', { runtime: runtime.info.id, sessionId: target })).title, title)
    const page = desk ? await host.call('session/index', { runtimes: [runtime.info.id] })
      : await host.call('history/list', { runtimes: [runtime.info.id], query: title })
    assert.equal(page.data.find(row => row.id === target)?.title, title, 'import and a later read keep the chosen title')
  })
})

test('a known host-only name works offline without starting its agent', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'hd-offline-name-'))
  const runtime = new AcpRuntime({ id: 'offline', name: 'Offline agent', command: join(dir, 'missing-agent') })
  runtime.start = async () => { assert.fail('a local rename must not start an agent') }
  const host = new Host({ logger: silent, state: new StateStore(join(dir, 'state.json')), catalogRefreshMs: 0, idleStopMs: 0, retryDelaysMs: [] })
  host.register(runtime)
  t.after(async () => { await host.dispose(); await rm(dir, { recursive: true, force: true }) })
  await host.call('session/setTitle', { runtime: runtime.info.id, sessionId: id, title: 'Offline conversation' })
  const names = JSON.parse(await readFile(join(dir, 'names.json'), 'utf8')) as { entries: { sessionId: string; name: string }[] }
  assert.deepEqual(names.entries, [{ runtime: runtime.info.id, sessionId: id, name: 'Offline conversation' }])
})

for (const method of ['session/archive', 'session/delete'] as const) {
  test(`${method} learns native history support on first use without a cache`, async t => {
    const dir = await mkdtemp(join(tmpdir(), 'hd-cold-history-'))
    const runtime = new CodexRuntime({ id: runtimeId('native'), binaryPath: codex, clientName: 'test', env: { HOME: dir, CODEX_HOME: dir } })
    const host = new Host({ logger: silent, state: new StateStore(join(dir, 'state.json')), catalogRefreshMs: 0, idleStopMs: 0, retryDelaysMs: [] })
    host.register(new FakeRuntime())
    host.register(runtime)
    t.after(async () => { await host.dispose(); await rm(dir, { recursive: true, force: true }) })
    await host.start()
    assert.equal(runtime.health().state, 'idle')
    assert.equal(runtime.info.capabilities.archiveHistory, false)
    assert.equal(runtime.info.capabilities.deleteHistory, false)
    const target = sessionId('thread-2')
    if (method === 'session/delete') await assert.rejects(host.call(method, { runtime: runtime.info.id, sessionId: target }), /Trash/)
    else await host.call(method, { runtime: runtime.info.id, sessionId: target, archived: true })
    assert.equal(runtime.health().state, 'ready')
    const nativeArchived = await runtime.listSessions({ archived: 'only' })
    const archived = await host.call('session/list', { runtime: runtime.info.id, archived: 'only' })
    if (method === 'session/archive') {
      assert.ok(nativeArchived.data.some(row => row.id === target), 'the agent itself keeps the archive')
      assert.ok(archived.data.some(row => row.id === target), 'the native archive owns the change')
      await assert.rejects(readFile(join(dir, 'archive.json'), 'utf8'), { code: 'ENOENT' })
      await host.call('session/archive', { runtime: runtime.info.id, sessionId: target, archived: false })
      assert.ok((await host.call('session/list', { runtime: runtime.info.id })).data.some(row => row.id === target))
    } else {
      assert.equal(runtime.info.capabilities.deleteHistory, 'erase')
      assert.ok((await host.call('session/list', { runtime: runtime.info.id })).data.some(row => row.id === target))
      assert.deepEqual(archived.data.map(row => row.id), nativeArchived.data.map(row => row.id), 'a refused erase leaves the agent archive unchanged')
    }
  })
}
