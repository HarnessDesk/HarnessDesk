import assert from 'node:assert/strict'
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { fileURLToPath } from 'node:url'

import type { AgentRuntime, RuntimeHealth } from '@harnessdesk/protocol'

import { AcpRuntime, type AcpLaunchDecision } from '../src/index.js'

const FAKE = fileURLToPath(new URL('./fixtures/fake-acp-agent.mjs', import.meta.url))

const folder = async (t: TestContext): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), 'harnessdesk-acp-discovery-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  return dir
}

const discover = (runtime: AgentRuntime): Promise<void> => {
  assert.ok(runtime.discoverProgram, 'the ACP runtime must support startup discovery')
  return runtime.discoverProgram()
}

const deferred = <T>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

test('discovery reports a missing ACP program on a fresh desk without launching it', async (t) => {
  const dir = await folder(t)
  const runtime = new AcpRuntime({
    id: 'fake-acp', name: 'Fake Agent', command: 'hd-missing-agent', env: { PATH: dir },
    installCommand: 'install-fake-agent',
  })
  t.after(() => runtime.dispose())
  const spawn = t.mock.method(runtime.connection, 'start')
  const changes: RuntimeHealth[] = []
  runtime.onHealthChange((health) => changes.push(health))

  await discover(runtime)

  const health = runtime.health()
  assert.equal(health.state, 'unavailable')
  assert.equal(health.state === 'unavailable' && health.reason, 'notInstalled')
  assert.match(health.state === 'unavailable' ? health.message : '', /Fake Agent/)
  assert.equal(health.state === 'unavailable' && health.remediation, 'Install it with `install-fake-agent`.')
  assert.deepEqual(changes, [health], 'the host hears the discovery failure')
  assert.equal(spawn.mock.callCount(), 0)
  assert.deepEqual(runtime.resourceProcessIds(), [])
})

test('discovery leaves a runnable ACP program idle without launching even a version command', { skip: process.platform === 'win32' }, async (t) => {
  const dir = await folder(t)
  const cli = join(dir, 'hd-fake-agent')
  await writeFile(cli, '#!/bin/sh\necho launched > "$0.launched"\nexit 91\n')
  await chmod(cli, 0o755)
  const runtime = new AcpRuntime({ id: 'fake-acp', name: 'Fake Agent', command: 'hd-fake-agent', env: { PATH: dir } })
  t.after(() => runtime.dispose())
  const spawn = t.mock.method(runtime.connection, 'start')
  const before = runtime.health()

  await discover(runtime)

  assert.deepEqual(runtime.health(), before)
  await assert.rejects(readFile(`${cli}.launched`), { code: 'ENOENT' })
  assert.equal(spawn.mock.callCount(), 0)
  assert.deepEqual(runtime.resourceProcessIds(), [])
})

test('discovery uses the failed-start classification for a non-executable ACP program', { skip: process.platform === 'win32' }, async (t) => {
  const dir = await folder(t)
  const cli = join(dir, 'hd-fake-agent')
  await writeFile(cli, '#!/bin/sh\nexit 91\n')
  await chmod(cli, 0o644)
  const runtime = new AcpRuntime({ id: 'fake-acp', name: 'Fake Agent', command: cli })
  t.after(() => runtime.dispose())
  await discover(runtime)
  const discovered = runtime.health()
  assert.equal(discovered.state, 'unavailable')
  await assert.rejects(runtime.start())
  const started = runtime.health()
  assert.equal(started.state, 'unavailable')
  assert.equal(discovered.state === 'unavailable' && discovered.reason, started.state === 'unavailable' && started.reason)
})

test('discovery honors the host launch refusal without starting the ACP bridge', async (t) => {
  const blocked = { reason: 'notInstalled' as const, message: 'Fake Agent is not installed.', remediation: 'Install Fake Agent.' }
  const runtime = new AcpRuntime({
    id: 'fake-acp', name: 'Fake Agent', command: process.execPath, args: [FAKE],
    resolveLaunch: async (occasion) => {
      assert.equal(occasion, 'recheck', 'discovery does not run start-only preflight commands')
      return { blocked }
    },
  })
  t.after(() => runtime.dispose())
  const spawn = t.mock.method(runtime.connection, 'start')

  await discover(runtime)

  assert.deepEqual(runtime.health(), { state: 'unavailable', ...blocked })
  assert.equal(spawn.mock.callCount(), 0)
})

test('discovery checks the host-chosen command and environment instead of the fallback row', { skip: process.platform === 'win32' }, async (t) => {
  const dir = await folder(t)
  await writeFile(join(dir, 'hd-chosen-agent'), '#!/bin/sh\nexit 91\n', { mode: 0o755 })
  const runtime = new AcpRuntime({
    id: 'fake-acp', name: 'Fake Agent', command: 'hd-missing-agent', env: { PATH: '' },
    resolveLaunch: async () => ({ command: 'hd-chosen-agent', args: [], env: { PATH: dir }, version: null }),
  })
  t.after(() => runtime.dispose())

  await discover(runtime)

  assert.deepEqual(runtime.health(), { state: 'idle' })
  assert.deepEqual(runtime.resourceProcessIds(), [])
})

test('a repeated discovery clears its missing-program health when the program becomes runnable', async (t) => {
  const dir = await folder(t)
  let installed = false
  const runtime = new AcpRuntime({
    id: 'fake-acp', name: 'Fake Agent', command: 'hd-missing-agent', env: { PATH: dir },
    resolveLaunch: async () => installed ? { command: process.execPath, args: [FAKE], version: null } : null,
  })
  t.after(() => runtime.dispose())

  await discover(runtime)
  assert.equal(runtime.health().state, 'unavailable')
  installed = true
  await discover(runtime)

  assert.deepEqual(runtime.health(), { state: 'idle' })
})

test('a start begun during discovery keeps its health when the older lookup fails', async (t) => {
  const pending = deferred<AcpLaunchDecision | null>()
  const runtime = new AcpRuntime({
    id: 'fake-acp', name: 'Fake Agent', command: process.execPath, args: [FAKE],
    resolveLaunch: (occasion) => occasion === 'recheck' ? pending.promise : Promise.resolve(null),
  })
  t.after(() => runtime.dispose())
  const discovering = discover(runtime)
  await runtime.start()
  assert.equal(runtime.health().state, 'ready')
  pending.resolve({ blocked: { reason: 'notInstalled', message: 'An older lookup found no program.' } })
  await discovering

  assert.deepEqual(runtime.health(), { state: 'ready' })
})

test('a failed start begun during discovery keeps its health when the older lookup succeeds', async (t) => {
  const pending = deferred<AcpLaunchDecision | null>()
  const blocked = { reason: 'unknown' as const, message: 'Fake Agent refuses its configuration.' }
  const runtime = new AcpRuntime({
    id: 'fake-acp', name: 'Fake Agent', command: process.execPath, args: [FAKE],
    resolveLaunch: (occasion) => occasion === 'recheck' ? pending.promise : Promise.resolve({ blocked }),
  })
  t.after(() => runtime.dispose())
  const discovering = discover(runtime)
  await assert.rejects(runtime.start())
  pending.resolve(null)
  await discovering

  assert.deepEqual(runtime.health(), { state: 'unavailable', ...blocked })
})

test('disposal during discovery prevents a late lookup from changing health', async () => {
  const pending = deferred<AcpLaunchDecision | null>()
  const runtime = new AcpRuntime({
    id: 'fake-acp', name: 'Fake Agent', command: process.execPath,
    resolveLaunch: () => pending.promise,
  })
  const discovering = discover(runtime)
  await runtime.dispose()
  const before = runtime.health()
  pending.resolve({ blocked: { reason: 'notInstalled', message: 'An older lookup found no program.' } })
  await discovering

  assert.deepEqual(runtime.health(), before)
})

test('discovery settles within its ten-second probe timeout even if the host lookup never answers', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const warnings: unknown[] = []
  const runtime = new AcpRuntime({
    id: 'fake-acp', name: 'Fake Agent', command: process.execPath,
    resolveLaunch: () => new Promise(() => {}),
    logger: { warn: (message, details) => { warnings.push({ message, details }) } },
  })
  t.after(() => runtime.dispose())
  const discovering = discover(runtime)
  t.mock.timers.tick(10_000)
  await discovering

  assert.deepEqual(runtime.health(), { state: 'idle' })
  assert.match(JSON.stringify(warnings), /timed out/i)
  assert.deepEqual(runtime.resourceProcessIds(), [])
})

test('an inconclusive repeat discovery keeps the missing-program health it already found', async (t) => {
  const dir = await folder(t)
  let failing = false
  const runtime = new AcpRuntime({
    id: 'fake-acp', name: 'Fake Agent', command: 'hd-missing-agent', env: { PATH: dir },
    resolveLaunch: async () => { if (failing) throw new Error('Install scan failed.'); return null },
    logger: { warn: () => {} },
  })
  t.after(() => runtime.dispose())
  const seen: RuntimeHealth[] = []
  runtime.onHealthChange((health) => { seen.push(health) })

  await discover(runtime)
  assert.equal(runtime.health().state, 'unavailable')
  failing = true
  await discover(runtime)

  // A scan that could not finish says nothing new: the earlier answer stands, and nothing is announced.
  assert.equal(runtime.health().state, 'unavailable')
  assert.equal(seen.length, 1)
})

test('a rejecting host lookup leaves discovery idle instead of reporting the fallback missing', async (t) => {
  const dir = await folder(t)
  const warnings: unknown[] = []
  const runtime = new AcpRuntime({
    id: 'fake-acp', name: 'Fake Agent', command: 'hd-missing-agent', env: { PATH: dir },
    resolveLaunch: async () => { throw new Error('Install scan failed.') },
    logger: { warn: (message, details) => { warnings.push({ message, details }) } },
  })
  t.after(() => runtime.dispose())

  await discover(runtime)

  assert.deepEqual(runtime.health(), { state: 'idle' })
  assert.match(JSON.stringify(warnings), /Install scan failed/)
  assert.deepEqual(runtime.resourceProcessIds(), [])
})

for (const present of [false, true]) {
  test(`a bridge with a required CLI ${present ? 'present stays idle' : 'missing reports not installed'}`, async (t) => {
    const dir = await folder(t)
    const cli = join(dir, 'hd-required-cli')
    await writeFile(cli, '#!/bin/sh\nexit 91\n', { mode: 0o755 })
    let lookups = 0
    const config = {
      id: 'fake-acp', name: 'Fake Agent', command: process.execPath, args: [FAKE],
      cliRequired: true,
      executable: { command: 'hd-required-cli', env: 'HD_REQUIRED_CLI' },
      resolveExecutable: async (spec: { command: string }) => {
        assert.equal(spec.command, 'hd-required-cli')
        lookups += 1
        return present ? { path: cli, version: '1.0.0' } : null
      },
    }
    const runtime = new AcpRuntime(config)
    t.after(() => runtime.dispose())
    const spawn = t.mock.method(runtime.connection, 'start')

    await discover(runtime)

    assert.equal(lookups, 1, 'discovery reuses the start path executable resolver')
    const health = runtime.health()
    if (present) assert.deepEqual(health, { state: 'idle' })
    else {
      assert.equal(health.state === 'unavailable' && health.reason, 'notInstalled')
      assert.match(health.state === 'unavailable' ? health.message : '', /hd-required-cli/)
    }
    assert.equal(spawn.mock.callCount(), 0)
    assert.deepEqual(runtime.resourceProcessIds(), [])
  })
}

test('a bridge with an embedded CLI stays idle without resolving an optional executable', async (t) => {
  const runtime = new AcpRuntime({
    id: 'fake-acp', name: 'Fake Agent', command: process.execPath,
    executable: { command: 'hd-optional-cli', env: 'HD_OPTIONAL_CLI' },
    resolveExecutable: async () => { assert.fail('the bridge bundles its own CLI') },
  })
  t.after(() => runtime.dispose())

  await discover(runtime)

  assert.deepEqual(runtime.health(), { state: 'idle' })
  assert.deepEqual(runtime.resourceProcessIds(), [])
})
