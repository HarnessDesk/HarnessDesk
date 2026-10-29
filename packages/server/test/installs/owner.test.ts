import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

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
      locate: { home: dir, env: { PATH: '' }, exists: () => false, probe: async () => null },
      registryVersion: (registryId) => registryId === 'old' ? oldVersion.promise : newVersion.promise,
    })
    const host = new Host({ logger: new Logger('test', { level: 'error', console: false }), state: new StateStore(join(dir, 'state.json')), agents, installs, catalogRefreshMs: 0 })
    t.after(async () => { oldVersion.resolve(null); newVersion.resolve(null); await host.dispose(); await rm(dir, { recursive: true, force: true }) })
    const add = (name: string) => store.add({ id, name, agent: 'antigravity-acp', command: 'fixture-command' })
    const info = () => host.syncPayload().params.runtimes.find((runtime) => runtime.id === id)
    add('Previous program')
    host.register(new FakeRuntime({ id, name: 'Previous program' }))
    const oldConfig = store.configs()[0]!
    // An ordinary completed description remains visible to its owner.
    const original = await installs.describe({ ...oldConfig }, empty)
    assert.ok(original)
    assert.deepEqual(info()?.install, original)
    store.patch(id, { registry: { id: 'old', version: '1.0.0' } })
    const oldPending = installs.describe(oldConfig, empty)
    await host.call('acp/remove', { runtime: id })
    assert.equal(store.entry(id), null)
    host.register(new FakeRuntime({ id, name: 'Replacement program' }))
    assert.equal(info()?.install, undefined)
    await assert.rejects(host.call('runtime/installs', { runtime: id }), /no install knowledge/)
    add('Replacement program')
    store.patch(id, { registry: { id: 'new', version: '1.0.0' } })
    const newPending = installs.describe(store.configs()[0]!, empty)
    if (oldFinishesFirst) {
      oldVersion.resolve('2.0.0')
      await oldPending
      assert.equal(info()?.install, undefined, 'old work cannot publish while the new owner is pending')
      newVersion.resolve('3.0.0')
      const current = await newPending
      assert.deepEqual(info()?.install, current)
    } else {
      newVersion.resolve('3.0.0')
      const current = await newPending
      assert.deepEqual(info()?.install, current)
      oldVersion.resolve('2.0.0')
      await oldPending
      assert.deepEqual(info()?.install, current, 'old work cannot overwrite the new owner')
    }
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
    host.register(new FakeRuntime({ id }))
    const config = store.configs()[0]!
    const pending = operation === 'launch' ? installs.launchFor(config) : installs.executableFor(config, { command: 'gemini', env: 'FIXTURE_EXECUTABLE' })
    assert.equal(probes, 1)
    await host.call('acp/remove', { runtime: id })
    host.register(new FakeRuntime({ id, name: 'Replacement program' }))
    probe.resolve(null)
    await pending
    assert.equal(host.syncPayload().params.runtimes.find((runtime) => runtime.id === id)?.install, undefined)
  })
}
