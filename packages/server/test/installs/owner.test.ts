import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import type { RuntimeId } from '@harnessdesk/protocol'
import { AgentDirectory, AgentRegistryStore } from '../../src/agent-registry.js'
import { Host, Logger, StateStore } from '../../src/index.js'
import { InstallService } from '../../src/installs/service.js'
import { FakeRuntime } from '../fixtures/fake-runtime.js'

const id = 'fixture-reused' as RuntimeId
const empty = { chosen: null, copies: [] }
const deferred = () => {
  let resolve!: (value: string | null) => void
  const promise = new Promise<string | null>((done) => { resolve = done })
  return { promise, resolve }
}

for (const oldFinishesFirst of [true, false]) {
  test(`install metadata follows its registration when old work finishes ${oldFinishesFirst ? 'first' : 'last'}`, async (t) => {
    const dir = await mkdtemp(join(tmpdir(), 'hd-install-owner-'))
    const store = new AgentRegistryStore(join(dir, 'agents.json'))
    const oldVersion = deferred()
    const newVersion = deferred()
    const agents = new AgentDirectory({ store, build: (config) => new FakeRuntime({ id: config.id as RuntimeId }), usageFor: () => null, which: async () => null })
    let clock = 0
    const installs = new InstallService({
      stateDir: dir, store, now: () => ++clock,
      locate: { home: dir, env: { PATH: '/fixture/bin' }, exists: (path) => path === '/fixture/bin/gemini', realpath: (path) => path, probe: async () => '1.2.3' },
      registryVersion: (registryId) => registryId === 'old' ? oldVersion.promise : newVersion.promise,
    })
    const host = new Host({ logger: new Logger('test', { level: 'error', console: false }), state: new StateStore(join(dir, 'state.json')), agents, installs, catalogRefreshMs: 0 })
    t.after(async () => { oldVersion.resolve(null); newVersion.resolve(null); await host.dispose(); await rm(dir, { recursive: true, force: true }) })
    const add = (name: string) => store.add({ id, name, agent: 'gemini', command: 'gemini' })
    const info = () => host.syncPayload().params.runtimes.find((runtime) => runtime.id === id)
    add('Previous program')
    const oldOwner = new FakeRuntime({ id, name: 'Previous program', version: 'unknown' })
    host.register(oldOwner)
    const oldConfig = store.configs()[0]!
    // An ordinary completed description remains visible to its owner.
    const original = await installs.describe({ ...oldConfig }, undefined, oldOwner)
    assert.ok(original)
    assert.equal(original.chosen?.version, '1.2.3')
    assert.deepEqual(info()?.install, original)
    assert.equal(info()?.version, '1.2.3')
    store.patch(id, { registry: { id: 'old', version: '1.0.0' } })
    const oldPending = installs.describe(oldConfig, empty, oldOwner)
    await host.call('acp/remove', { runtime: id })
    assert.equal(store.entry(id), null)
    const newOwner = new FakeRuntime({ id, name: 'Replacement program', version: 'unknown' })
    host.register(newOwner)
    assert.equal(info()?.install, undefined)
    assert.equal(info()?.version, 'unknown')
    await assert.rejects(host.call('runtime/installs', { runtime: id }), /no install knowledge/)
    add('Replacement program')
    store.patch(id, { registry: { id: 'new', version: '1.0.0' } })
    const newPending = installs.describe(store.configs()[0]!, empty, newOwner)
    if (oldFinishesFirst) {
      oldVersion.resolve('2.0.0')
      assert.equal(await oldPending, null)
      assert.equal(info()?.install, undefined, 'old work cannot publish while the new owner is pending')
      newVersion.resolve('3.0.0')
      const current = await newPending
      assert.deepEqual(info()?.install, current)
    } else {
      newVersion.resolve('3.0.0')
      const current = await newPending
      assert.deepEqual(info()?.install, current)
      oldVersion.resolve('2.0.0')
      assert.equal(await oldPending, null)
      assert.deepEqual(info()?.install, current, 'old work cannot overwrite the new owner')
    }
    const explicit = await host.call('runtime/installs', { runtime: id })
    assert.equal(explicit.chosen?.version, '1.2.3')
    assert.deepEqual(explicit.registryUpdate, { version: '3.0.0' })
    assert.deepEqual(info()?.install, explicit)
  })
}

for (const operation of ['launch', 'executable'] as const) {
  test(`an old ${operation} scan cannot describe a replacement after removal`, async (t) => {
    const dir = await mkdtemp(join(tmpdir(), 'hd-install-scan-owner-'))
    const store = new AgentRegistryStore(join(dir, 'agents.json'))
    const probe = deferred()
    let probes = 0
    const installs = new InstallService({ stateDir: dir, store, locate: {
      home: dir, env: { PATH: '/fixture/bin' }, exists: (path) => path === '/fixture/bin/gemini',
      realpath: (path) => path, probe: () => { probes++; return probe.promise },
    } })
    const agents = new AgentDirectory({ store, build: (config) => new FakeRuntime({ id: config.id as RuntimeId }), usageFor: () => null, which: async () => null })
    const host = new Host({ logger: new Logger('test', { level: 'error', console: false }), state: new StateStore(join(dir, 'state.json')), agents, installs, catalogRefreshMs: 0 })
    t.after(async () => { probe.resolve(null); await host.dispose(); await rm(dir, { recursive: true, force: true }) })
    store.add({ id, name: 'Previous program', agent: 'gemini', command: 'gemini' })
    const owner = new FakeRuntime({ id })
    host.register(owner)
    const config = store.configs()[0]!
    const pending = operation === 'launch' ? installs.launchFor(config, 'start', owner) : installs.executableFor(config, { command: 'gemini', env: 'FIXTURE_EXECUTABLE' }, owner)
    assert.equal(probes, 1)
    await host.call('acp/remove', { runtime: id })
    const missing = undefined as unknown as object
    assert.equal(await installs.describe(config, empty, missing), null)
    assert.equal(await installs.launchFor(config, 'start', missing), null)
    assert.equal(await installs.executableFor(config, { command: 'gemini', env: 'FIXTURE_EXECUTABLE' }, missing), null)
    assert.equal(installs.last(id), null)
    host.register(new FakeRuntime({ id, name: 'Replacement program' }))
    probe.resolve(null)
    assert.equal(await pending, null, 'a retired scan returns no decision')
    assert.equal(host.syncPayload().params.runtimes.find((runtime) => runtime.id === id)?.install, undefined)
    assert.equal(await installs.describe(config, empty, owner), null, 'a retired description is refused at entry')
    assert.equal(await installs.launchFor(config, 'start', owner), null, 'a retired launch is refused at entry')
    assert.equal(await installs.executableFor(config, { command: 'gemini', env: 'FIXTURE_EXECUTABLE' }, owner), null, 'a retired executable is refused at entry')
    assert.equal(probes, 1, 'retired calls do not start a scan')
  })
}

test('a real retired ACP start cannot publish its late first executable scan', async (t) => {
  const { AcpRuntime } = await import('@harnessdesk/adapter-acp')
  const dir = await mkdtemp(join(tmpdir(), 'hd-install-late-first-'))
  const store = new AgentRegistryStore(join(dir, 'agents.json'))
  const cli = join(dir, 'hermes')
  const peer = fileURLToPath(new URL('../../../../adapter-acp/test/fixtures/fake-acp-agent.mjs', import.meta.url))
  await writeFile(cli, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(peer)}\n`, { mode: 0o755 })
  const gate = deferred()
  const entered = deferred()
  let hold = true
  let executableCalls = 0
  const installs = new InstallService({ stateDir: dir, store, locate: {
    home: dir, env: { PATH: dir }, exists: (path) => path === cli,
    realpath: (path) => path, probe: async () => {
      if (hold) { entered.resolve(null); await gate.promise }
      return '1.2.3'
    },
  } })
  const build = (config: ReturnType<typeof store.configs>[number]) => {
    const runtime = new AcpRuntime({
      ...config,
      resolveLaunch: (occasion) => installs.launchFor(config, occasion, runtime),
      resolveExecutable: (spec) => { executableCalls++; return installs.executableFor(config, spec, runtime) },
    })
    return runtime
  }
  const agents = new AgentDirectory({ store, build, usageFor: () => null, which: async () => null })
  const host = new Host({ logger: new Logger('test', { level: 'error', console: false }), state: new StateStore(join(dir, 'state.json')), agents, installs, catalogRefreshMs: 0 })
  t.after(async () => { gate.resolve(null); await host.dispose(); await rm(dir, { recursive: true, force: true }) })
  const add = (command: string, home: string) => store.add({ id, name: command, agent: 'hermes', command, env: { HOME: dir, HERMES_HOME: home, FAKE_ACP_STORE: join(dir, 'fake-store') }, executable: { command: 'hermes', env: 'FIXTURE_EXECUTABLE' } })
  const info = () => host.syncPayload().params.runtimes.find((runtime) => runtime.id === id)!
  add('old-fallback', join(dir, 'old-home'))
  const old = build(store.configs()[0]!)
  host.register(old)
  const start = old.start().then(() => null, (error: Error) => error)
  await entered.promise
  assert.equal(executableCalls, 0)
  await host.call('acp/remove', { runtime: id })
  add('new-fallback', join(dir, 'new-home'))
  const replacement = build(store.configs()[0]!)
  host.register(replacement)
  hold = false
  const current = await host.call('runtime/installs', { runtime: id })
  assert.equal(current.fallback?.command, 'new-fallback')
  assert.match(current.signIn?.terminal ?? '', /new-home/)
  gate.resolve(null)
  assert.ok(await start)
  assert.equal(executableCalls, 1, 'the retired runtime reached its first executable callback after removal')
  assert.deepEqual(info().install, current)
  assert.equal(info().version, '1.2.3')
  assert.equal(info().install?.fallback?.command, 'new-fallback')
  assert.match(info().install?.signIn?.terminal ?? '', /new-home/)
  await replacement.start()
  assert.equal(replacement.health().state, 'ready', 'the live owner can start the scripted ACP peer')
  assert.equal(info().install?.fallback?.command, 'new-fallback')
  assert.match(info().install?.signIn?.terminal ?? '', /new-home/)
})

test('a delayed pin cannot describe a retired runtime while its row is being removed', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'hd-install-late-describe-'))
  const store = new AgentRegistryStore(join(dir, 'agents.json'))
  const check = deferred()
  const disposing = deferred()
  const disposalEntered = deferred()
  class HeldRuntime extends FakeRuntime {
    async checkInstallation() { await check.promise; return { changed: false as const, restarted: false } }
    override async dispose() { disposalEntered.resolve(null); await disposing.promise; await super.dispose() }
  }
  const installs = new InstallService({ stateDir: dir, store, locate: {
    home: dir, env: { PATH: '/fixture/bin' }, exists: (path) => path === '/fixture/bin/gemini',
    realpath: (path) => path, probe: async () => '1.2.3',
  } })
  const agents = new AgentDirectory({ store, build: (config) => new FakeRuntime({ id: config.id as RuntimeId }), usageFor: () => null, which: async () => null })
  const host = new Host({ logger: new Logger('test', { level: 'error', console: false }), state: new StateStore(join(dir, 'state.json')), agents, installs, catalogRefreshMs: 0 })
  t.after(async () => { check.resolve(null); disposing.resolve(null); await host.dispose(); await rm(dir, { recursive: true, force: true }) })
  store.add({ id, name: 'Previous program', agent: 'gemini', command: 'gemini' })
  host.register(new HeldRuntime({ id }))
  const pending = host.call('runtime/installs/use', { runtime: id, path: null }).then(() => null, (error: Error) => error)
  const removing = host.call('acp/remove', { runtime: id })
  await disposalEntered.promise
  check.resolve(null)
  assert.ok(await pending, 'a retired request is refused')
  assert.equal(installs.last(id), null, 'the old row cannot recreate install metadata after forget')
  disposing.resolve(null)
  await removing
})
