import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { AcpRuntime } from '@harnessdesk/adapter-acp'
import { CodexRuntime } from '@harnessdesk/adapter-codex'
import { runtimeId, type AgentRuntime, type ModelInfo, type WireNotification } from '@harnessdesk/protocol'
import { Host, Logger, StateStore } from '../src/index.js'
import { CredentialBroker } from '../src/credentials.js'
import { RuntimeCache } from '../src/runtime-cache.js'
import { FakeRuntime } from './fixtures/fake-runtime.js'

const silent = new Logger('test', { console: false, level: 'error' })
const peer = fileURLToPath(new URL('../../../adapter-acp/test/fixtures/fake-acp-agent.mjs', import.meta.url))
const codex = fileURLToPath(new URL('../../../adapter-codex/test/fixtures/fake-codex.mjs', import.meta.url))
const waitFor = async (check: () => boolean | Promise<boolean>): Promise<void> => {
  const until = Date.now() + 5000
  while (!await check()) {
    assert.ok(Date.now() < until, 'observation did not arrive')
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}
const makeHost = (dir: string, runtimes: readonly AgentRuntime[]) => {
  const host = new Host({ logger: silent, state: new StateStore(join(dir, 'state.json')), catalogRefreshMs: 0, idleStopMs: 0, retryDelaysMs: [] })
  for (const runtime of runtimes) host.register(runtime)
  return host
}
class HeldRuntime extends FakeRuntime {
  starts = 0
  release!: () => void
  barrier = new Promise<void>(resolve => { this.release = resolve })
  override async start() { this.starts++; this.setHealth({ state: 'starting' }); await this.barrier; await super.start() }
}

test('launch returns before the default is ready and never starts the other runtime', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'hd-start-policy-'))
  const defaultRuntime = new HeldRuntime({ id: runtimeId('default') })
  const other = new HeldRuntime({ id: runtimeId('other') })
  const host = makeHost(dir, [other, defaultRuntime])
  await writeFile(join(dir, 'state.json'), JSON.stringify({ preferences: { activeRuntime: 'default' }, workspaces: [] }))
  t.after(async () => { defaultRuntime.release(); other.release(); await host.dispose(); await rm(dir, { recursive: true, force: true }) })
  const start = host.start()
  assert.equal(await Promise.race([start.then(() => 'returned'), new Promise(resolve => setTimeout(() => resolve('blocked'), 300))]), 'returned')
  assert.equal(defaultRuntime.starts, 1)
  assert.equal(other.starts, 0)
  defaultRuntime.release()
  await waitFor(() => defaultRuntime.health().state === 'ready')
})

for (const adapter of ['acp', 'codex'] as const) {
  test(`${adapter} restores observations without a process and replaces them live`, async t => {
    const dir = await mkdtemp(join(tmpdir(), 'hd-runtime-cache-'))
    const spawns = join(dir, 'spawns')
    const make = (): AgentRuntime => adapter === 'acp'
      ? new AcpRuntime({ id: 'cached', name: 'Cached', command: process.execPath, args: [peer], env: { FAKE_ACP_START_DELAY_MS: '100', FAKE_ACP_SPAWNS: spawns } })
      : new CodexRuntime({ id: runtimeId('cached'), name: 'Cached', binaryPath: codex, clientName: 'test', env: { HOME: dir, CODEX_HOME: dir } })
    let host = makeHost(dir, [new FakeRuntime(), make()])
    t.after(async () => { await host.dispose(); await rm(dir, { recursive: true, force: true }) })
    await host.start()
    const created = await host.call('session/create', { runtime: runtimeId('cached'), options: { cwd: dir } })
    assert.ok(created)
    const models = await host.call('runtime/models', { runtime: runtimeId('cached') }) as readonly ModelInfo[]
    assert.ok(models.length > 0)
    const options = await host.call('runtime/options', { runtime: runtimeId('cached') })
    const defaults = await host.call('runtime/sessionDefaults', { runtime: runtimeId('cached') })
    const commands = await host.call('runtime/skills', { runtime: runtimeId('cached') })
    const account = await host.call('runtime/account', { runtime: runtimeId('cached') })
    await waitFor(async () => {
      try { return JSON.parse(await readFile(join(dir, 'runtime-cache.json'), 'utf8')).runtimes.cached.models?.length > 0 } catch { return false }
    })
    await host.dispose()
    const restored = make()
    host = makeHost(dir, [new FakeRuntime(), restored])
    await host.start()
    assert.equal(restored.health().state, 'idle')
    assert.deepEqual(await host.call('runtime/models', { runtime: runtimeId('cached') }), models)
    assert.deepEqual(await host.call('runtime/options', { runtime: runtimeId('cached') }), options)
    assert.deepEqual(await host.call('runtime/sessionDefaults', { runtime: runtimeId('cached') }), defaults)
    assert.deepEqual((await host.call('runtime/skills', { runtime: runtimeId('cached') })).map(command => command.name), commands.map(command => command.name))
    assert.deepEqual((await host.call('runtime/account', { runtime: runtimeId('cached') })).accounts.map(entry => entry.label), account.accounts.map(entry => entry.label))
    assert.equal(restored.resourceProcessIds?.().length, 0)
    const notifications: WireNotification[] = []
    host.addBroadcaster(notification => notifications.push(notification))
    const control = defaults.find(option => option.type === 'select' && option.choices.some(choice => choice.value !== option.currentValue))
    assert.ok(control?.type === 'select')
    const value = control.choices.find(choice => choice.value !== control.currentValue)!.value
    const edited = await host.call('runtime/sessionDefaults', { runtime: runtimeId('cached'), values: { [control.id]: value } })
    assert.equal(edited.find(option => option.id === control.id)?.currentValue, value)
    await host.call('session/create', { runtime: runtimeId('cached'), options: { cwd: dir } })
    await waitFor(() => notifications.some(n => n.method === 'event' && n.params.event.type === 'catalog/changed'))
    assert.ok(notifications.some(n => n.method === 'event' && n.params.event.type === 'account/changed'))
  })
}

for (const [forced, methods] of [
  ['api', ['apiKey']],
  ['chatgpt', ['chatgpt', 'chatgptDeviceCode']],
  ['', ['chatgpt', 'chatgptDeviceCode', 'apiKey']],
] as const) {
  test(`cached account preserves ${forced || 'unrestricted'} sign-in policy through live reads and disk`, async t => {
    const dir = await mkdtemp(join(tmpdir(), 'hd-cached-signin-policy-'))
    const make = (policy: string) => new CodexRuntime({ id: runtimeId('signin'), binaryPath: codex, clientName: 'test',
      env: { HOME: dir, CODEX_HOME: dir, FAKE_CODEX_ACCOUNT: 'signedOut', FAKE_CODEX_FORCED_LOGIN: policy } })
    const live = make(forced)
    let host = makeHost(dir, [new FakeRuntime(), live])
    t.after(async () => { await host.dispose(); await rm(dir, { recursive: true, force: true }) })
    await host.start()
    await host.call('session/create', { runtime: live.info.id, options: { cwd: dir } })
    const account = await host.call('runtime/account', { runtime: live.info.id })
    assert.deepEqual(account.signInMethods.map(method => method.id), methods)
    await host.dispose()

    const cache = new RuntimeCache(join(dir, 'runtime-cache.json'), error => { throw error })
    await cache.load()
    const restored = make('')
    t.after(() => restored.dispose())
    restored.restoreObservations(cache.get('signin'))
    assert.deepEqual((await restored.getAccount()).signInMethods.map(method => method.id), methods,
      'a cached account must not reconstruct a forbidden flow')
    assert.equal(restored.health().state, 'idle')
    assert.deepEqual(restored.resourceProcessIds(), [])
    host = makeHost(dir, [new FakeRuntime(), restored])
    await host.start()
    assert.deepEqual((await host.call('runtime/account', { runtime: restored.info.id })).signInMethods.map(method => method.id), methods)
    assert.equal(restored.health().state, 'idle')
    assert.deepEqual(restored.resourceProcessIds(), [])

    await restored.start()
    assert.deepEqual((await host.call('runtime/account', { runtime: restored.info.id })).signInMethods.map(method => method.id),
      ['chatgpt', 'chatgptDeviceCode', 'apiKey'], 'a live read replaces the cached restriction')
    await host.dispose()
    const refreshed = make('api')
    t.after(() => refreshed.dispose())
    const refreshedCache = new RuntimeCache(join(dir, 'runtime-cache.json'), error => { throw error })
    await refreshedCache.load()
    refreshed.restoreObservations(refreshedCache.get('signin'))
    assert.deepEqual((await refreshed.getAccount()).signInMethods.map(method => method.id),
      ['chatgpt', 'chatgptDeviceCode', 'apiKey'], 'the new live policy survives another restart')
  })
}

test('intent uses persisted total cost, shares starts, and unknown observations stay unknown', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'hd-warm-'))
  const spawns = join(dir, 'spawns')
  const make = (id: string) => new AcpRuntime({ id, name: id, command: process.execPath, args: [peer], env: { FAKE_ACP_START_DELAY_MS: '100', FAKE_ACP_SPAWNS: spawns } })
  const fast = make('fast'), slow = make('slow'), unknown = make('unknown')
  await writeFile(join(dir, 'runtime-cache.json'), JSON.stringify({ version: 1, runtimes: {
    fast: { start: { readyMs: 100, modelsMs: 399 } }, slow: { models: [{ id: 'saved', displayName: 'Saved', reasoningLevels: [], supportsImages: false }], start: { readyMs: 100, modelsMs: 400 } },
  } }))
  const host = makeHost(dir, [new FakeRuntime(), fast, slow, unknown])
  t.after(async () => { await host.dispose(); await rm(dir, { recursive: true, force: true }) })
  await host.start()
  assert.equal(unknown.health().state, 'idle')
  assert.equal(await unknown.knownModels(), null)
  await assert.rejects(unknown.listSkills(), /has not said/)
  const warm = (runtime: string) => host.call('runtime/warm', { runtime: runtimeId(runtime) })
  assert.equal(await warm('fast'), null)
  assert.equal(fast.health().state, 'idle')
  for (let i = 0; i < 3; i++) assert.equal(await warm('slow'), null)
  const cached = await host.call('runtime/models', { runtime: runtimeId('slow') })
  assert.equal(cached[0]?.id, 'saved', 'saved models answer during the first background start')
  assert.notEqual(slow.health().state, 'ready')
  await warm('unknown')
  await waitFor(() => slow.health().state === 'ready' && unknown.health().state === 'ready')
  assert.equal((await readFile(spawns, 'utf8')).trim().split('\n').length, 2)
  await waitFor(async () => {
    try { return JSON.parse(await readFile(join(dir, 'runtime-cache.json'), 'utf8')).runtimes.slow.start.modelsMs !== null } catch { return false }
  })
  const saved = JSON.parse(await readFile(join(dir, 'runtime-cache.json'), 'utf8'))
  assert.ok(saved.runtimes.slow.start.readyMs >= 100)
})

test('a token handed through sign-in never reaches the display cache', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'hd-cache-signin-'))
  const token = 'synthetic-login-token-never-cache' // hd-secrets-ok: deliberate credential lookalike for cache exclusion
  let host: Host
  const runtime = new AcpRuntime({ id: 'account', name: 'Account', command: process.execPath, args: [peer],
    secrets: [{ env: 'SYNTHETIC_KEY', label: 'Synthetic account' }],
    resolveSecret: env => host.credentials.peek(CredentialBroker.secretName('account', env)),
  })
  host = makeHost(dir, [new FakeRuntime(), runtime])
  t.after(async () => { await host.dispose(); await rm(dir, { recursive: true, force: true }) })
  await host.start()
  await host.call('runtime/apiKey/store', { runtime: runtimeId('account'), methodId: 'apiKey:SYNTHETIC_KEY', value: token })
  await host.call('session/create', { runtime: runtimeId('account'), options: { cwd: dir } })
  const account = await host.call('runtime/account', { runtime: runtimeId('account') })
  assert.equal(account.accounts[0]?.kind, 'apiKey')
  await waitFor(async () => { try { return (await readFile(join(dir, 'runtime-cache.json'), 'utf8')).includes('Synthetic account') } catch { return false } })
  const text = await readFile(join(dir, 'runtime-cache.json'), 'utf8')
  assert.ok(!text.includes(token))
  assert.ok(!text.includes('SYNTHETIC_KEY'))
})

test('adapter-owned refresh starts are measured again, including the first live model probe', async t => {
  class CountingRuntime extends AcpRuntime {
    starts = 0
    override async start() { this.starts++; await super.start() }
  }
  const dir = await mkdtemp(join(tmpdir(), 'hd-refresh-cost-'))
  const runtime = new CountingRuntime({ id: 'refresh', name: 'Refresh', command: process.execPath, args: [peer], env: { FAKE_ACP_START_DELAY_MS: '60', FAKE_ACP_MODEL_DELAY_MS: '80' } })
  const host = makeHost(dir, [new FakeRuntime(), runtime])
  t.after(async () => { await host.dispose(); await rm(dir, { recursive: true, force: true }) })
  const cost = async () => JSON.parse(await readFile(join(dir, 'runtime-cache.json'), 'utf8')).runtimes.refresh?.start
  await host.start()
  await host.call('runtime/warm', { runtime: runtimeId('refresh') })
  await waitFor(async () => { try { return (await cost())?.modelsMs >= 80 } catch { return false } })
  await waitFor(async () => JSON.parse(await readFile(join(dir, 'runtime-cache.json'), 'utf8')).runtimes.refresh?.commands !== undefined)
  const before = await cost()
  const refreshing = host.call('runtime/refreshCatalog', { runtime: runtimeId('refresh') })
  await waitFor(() => runtime.health().state === 'starting')
  for (let i = 0; i < 3; i++) await host.call('runtime/warm', { runtime: runtimeId('refresh') })
  const refreshed = await refreshing
  assert.equal(refreshed.refreshed, true)
  assert.equal(runtime.starts, 2, 'intent does not duplicate an adapter-owned start')
  await waitFor(async () => { const after = await cost(); return after.readyMs !== before.readyMs && after.modelsMs >= 80 })
})

test('models learned after an unanswered first probe finish that start measurement', async t => {
  class LateModels extends FakeRuntime {
    learned = false
    async knownModels() { return this.learned ? this.models : null }
    observations() { return this.learned ? { models: this.models } : {} }
    learn() { this.learned = true; this.emit({ type: 'catalog/changed', runtime: this.info.id }) }
  }
  const dir = await mkdtemp(join(tmpdir(), 'hd-late-models-'))
  const runtime = new LateModels({ id: runtimeId('late') })
  const host = makeHost(dir, [new FakeRuntime(), runtime])
  t.after(async () => { await host.dispose(); await rm(dir, { recursive: true, force: true }) })
  const cost = async () => JSON.parse(await readFile(join(dir, 'runtime-cache.json'), 'utf8')).runtimes.late?.start
  await host.start()
  await host.call('runtime/warm', { runtime: runtime.info.id })
  await waitFor(async () => { try { return (await cost())?.modelsMs === null } catch { return false } })
  await new Promise(resolve => setTimeout(resolve, 50))
  runtime.learn()
  await waitFor(async () => (await cost()).modelsMs >= 40)
})

for (const method of ['agent/seat', 'agent/seat/dry'] as const) {
  test(`${method} starts a cold unavailable candidate but passes over a later failure`, async t => {
    class CountingRuntime extends FakeRuntime {
      starts = 0
      override async start() { this.starts++; await super.start() }
    }
    const dir = await mkdtemp(join(tmpdir(), 'hd-cold-seat-'))
    const runtime = new CountingRuntime({ id: runtimeId('cold') })
    const host = makeHost(dir, [new FakeRuntime(), runtime])
    t.after(async () => { await host.dispose(); await rm(dir, { recursive: true, force: true }) })
    await mkdir(join(dir, 'agents', 'reviewer'), { recursive: true })
    await writeFile(join(dir, 'agents', 'reviewer', 'AGENT.md'), '---\nname: Reviewer\npermission: read\nprefer: [cold]\n---\nRead the diff.\n')
    await host.start()
    await host.call('workspace/open', { path: dir })
    assert.equal(runtime.health().state, 'unavailable')
    assert.equal(runtime.starts, 0)
    const read = () => method === 'agent/seat'
      ? host.call('agent/seat', { id: 'reviewer', cwd: dir })
      : host.call('agent/seat/dry', { ids: ['reviewer'] })
    const seated = await read()
    if ('runtime' in seated) assert.equal(seated.runtime, runtime.info.id)
    else {
      assert.equal(seated[0]?.candidates[0]?.state, 'taken')
      assert.equal(runtime.sessions.size, 0, 'a dry run opens no conversation')
    }
    assert.equal(runtime.starts, 1)
    if (method === 'agent/seat/dry') {
      runtime.setHealth({ state: 'idle' })
      await read()
      assert.equal(runtime.health().state, 'idle', 'later dry runs keep idle observations passive')
      assert.equal(runtime.starts, 1)
    }
    runtime.setHealth({ state: 'unavailable', reason: 'crashed', message: 'Synthetic process failure' })
    if (method === 'agent/seat') await assert.rejects(read(), /Synthetic process failure/)
    else {
      const plans = await host.call('agent/seat/dry', { ids: ['reviewer'] })
      assert.equal(plans[0]?.candidates[0]?.state, 'passed')
      assert.deepEqual(plans[0]?.candidates[0]?.reason, { kind: 'unavailable', detail: 'Synthetic process failure' })
    }
    assert.equal(runtime.starts, 1, 'an observed failure is passed over without restarting')
  })
}

for (const initialState of ['idle', 'unavailable'] as const) {
  for (const method of ['flow/preview', 'agent/seat'] as const) {
    test(`${method} passes a held ${initialState} startup over within the startup deadline`, { timeout: 5000 }, async t => {
      const dir = await mkdtemp(join(tmpdir(), 'hd-seat-start-'))
      const held = new HeldRuntime({ id: runtimeId('held') })
      held.setHealth(initialState === 'idle' ? { state: 'idle' } : { state: 'unavailable', reason: 'unknown', message: 'Not started' })
      const available = new FakeRuntime()
      await mkdir(join(dir, 'agents', 'reviewer'), { recursive: true })
      await writeFile(join(dir, 'agents', 'reviewer', 'AGENT.md'), '---\nname: Reviewer\npermission: read\nprefer: [held, fake]\nanswers: [done]\n---\nRead the diff.\n')
      const host = new Host({ logger: silent, state: new StateStore(join(dir, 'state.json')), startTimeoutMs: 30, seatReadDeadlineMs: 30, catalogRefreshMs: 0, idleStopMs: 0, retryDelaysMs: [] })
      host.register(available); host.register(held)
      t.after(async () => { held.release(); await host.dispose(); await rm(dir, { recursive: true, force: true }) })
      await host.start()
      await host.call('workspace/open', { path: dir })
      // The start cannot settle until released below. Returning while it is
      // held proves the startup wait yielded; seating's disk work does not
      // have to race an unrelated wall-clock timer.
      const result = await host.call(method, method === 'agent/seat' ? { id: 'reviewer', cwd: dir } : { root: dir, source: 'version: 2\nname: Preview\nroles:\n  reviewer: { kind: agent, uses: reviewer }\nseed: { role: reviewer, title: Read }\n' })
      if (method === 'agent/seat') assert.equal((result as { runtime: string }).runtime, 'fake', 'the available fallback is seated')
      assert.equal(held.starts, 1)
      assert.equal(held.health().state, 'starting', 'the held start has not settled behind the result')
      held.release()
      await waitFor(() => held.health().state === 'ready')
    })
  }
}

test('warm and a live operation join an adapter-owned start without starting again', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'hd-direct-start-'))
  const runtime = new HeldRuntime({ id: runtimeId('direct') })
  runtime.setHealth({ state: 'idle' })
  const host = makeHost(dir, [new FakeRuntime(), runtime])
  t.after(async () => { runtime.release(); await host.dispose(); await rm(dir, { recursive: true, force: true }) })
  await host.start()
  runtime.setHealth({ state: 'starting' })
  const direct = runtime.start()
  await host.call('runtime/warm', { runtime: runtime.info.id })
  const opening = host.call('session/create', { runtime: runtime.info.id, options: { cwd: dir } })
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.equal(runtime.starts, 1, 'the adapter already owns this start')
  runtime.release()
  await direct
  assert.ok(await opening)
  assert.equal(runtime.starts, 1)
})

for (const adapter of ['acp', 'codex'] as const) {
  test(`${adapter} cached signed-out state still offers configured sign-in without spawning`, async t => {
    const dir = await mkdtemp(join(tmpdir(), 'hd-idle-signin-'))
    const runtime: AgentRuntime = adapter === 'acp'
      ? new AcpRuntime({ id: 'signin', name: 'Sign in', command: process.execPath, args: [peer], account: { login: { command: process.execPath, args: ['-e', 'process.exit(0)'] } } })
      : new CodexRuntime({ id: runtimeId('signin'), name: 'Sign in', binaryPath: codex, clientName: 'test', env: { HOME: dir, CODEX_HOME: dir } })
    await writeFile(join(dir, 'runtime-cache.json'), JSON.stringify({ version: 1, runtimes: { signin: { account: { accounts: [], signInMethods: [{ id: 'browser', label: 'Sign in', flow: 'browser' }] }, start: { readyMs: 100, modelsMs: 100 } } } }))
    const host = makeHost(dir, [new FakeRuntime(), runtime])
    t.after(async () => { await host.dispose(); await rm(dir, { recursive: true, force: true }) })
    await host.start()
    await host.call('runtime/warm', { runtime: runtime.info.id })
    const account = await host.call('runtime/account', { runtime: runtime.info.id })
    assert.ok(account.signInMethods.some(method => method.flow === 'browser'), 'cached signed-out is not an agent with no sign-in')
    assert.equal(runtime.health().state, 'idle')
    assert.equal(runtime.resourceProcessIds?.().length, 0)
  })
}
