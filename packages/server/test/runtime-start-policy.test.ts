import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { AcpRuntime } from '@harnessdesk/adapter-acp'
import { CodexRuntime } from '@harnessdesk/adapter-codex'
import { runtimeId, type AgentRuntime, type ModelInfo, type WireNotification } from '@harnessdesk/protocol'
import { Host, Logger, StateStore } from '../src/index.js'
import { CredentialBroker } from '../src/credentials.js'
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
  override async start() { this.starts++; await this.barrier; await super.start() }
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
  const token = 'synthetic-login-token-never-cache'
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
