import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'

import { runtimeId, type RuntimeHealth } from '@harnessdesk/protocol'

import { Host, Logger, StateStore } from '../src/index.js'
import { FakeRuntime } from './fixtures/fake-runtime.js'

/**
 * The PATH the person's shell builds lands after the runtimes were first asked.
 * An agent installed where only that PATH looks is "not installed" in those
 * first moments, and `Host.retryNotInstalled` is the look that was promised and
 * never made: asked again once the PATH has changed, and only about what a PATH
 * could change.
 */
const silent = new Logger('test', { level: 'error', console: false })

/** A runtime whose program is found only once the test says the PATH has it. */
class Program extends FakeRuntime {
  starts = 0
  found = false
  /** Held start: a runtime that is still looking when the PATH lands. */
  gate: Promise<void> | null = null
  failure: RuntimeHealth = { state: 'unavailable', reason: 'notInstalled', message: 'Fake is not installed on this machine.' }

  override async start(): Promise<void> {
    this.starts += 1
    // What it looked at when it was asked, before any wait: a start held open
    // answers about the machine as it was, not as it is when released.
    const sawIt = this.found
    await this.gate
    if (!sawIt) {
      this.setHealth(this.failure)
      throw new Error(this.failure.state === 'unavailable' ? this.failure.message : 'unavailable')
    }
    await super.start()
  }
}

const desk = async (t: TestContext, ...runtimes: Program[]): Promise<Host> => {
  const dir = await mkdtemp(join(tmpdir(), 'hd-retry-missing-'))
  const host = new Host({
    logger: silent,
    state: new StateStore(join(dir, 'state.json')),
    version: '9.9.9',
    catalogRefreshMs: 0,
    idleStopMs: 0,
  })
  for (const runtime of runtimes) host.register(runtime)
  t.after(async () => {
    await host.dispose()
    await rm(dir, { recursive: true, force: true })
  })
  await host.start()
  return host
}

test('an agent that was not installed when it was first asked is started once the PATH has it', async (t) => {
  const one = new Program({ id: runtimeId('one') })
  const host = await desk(t, one)
  assert.deepEqual(one.health(), one.failure, 'the first ask found nothing')

  one.found = true
  await host.retryNotInstalled()

  assert.deepEqual(one.health(), { state: 'ready' })
  assert.equal(one.starts, 2)
})

test('only what a PATH could change is asked again', async (t) => {
  const missing = new Program({ id: runtimeId('missing') })
  const broken = new Program({ id: runtimeId('broken') })
  broken.failure = { state: 'unavailable', reason: 'unknown', message: 'It was found and would not run.' }
  const old = new Program({ id: runtimeId('old') })
  old.failure = { state: 'unavailable', reason: 'versionTooOld', message: 'Too old.', remediation: 'Upgrade.' }
  const host = await desk(t, missing, broken, old)
  for (const runtime of [missing, broken, old]) runtime.found = true

  await host.retryNotInstalled()

  assert.equal(missing.health().state, 'ready')
  assert.deepEqual([broken.starts, old.starts], [1, 1], 'neither was a PATH\'s doing')
})

test('a runtime still looking when the PATH lands is judged after it finishes, not before', async (t) => {
  const one = new Program({ id: runtimeId('one') })
  let release!: () => void
  one.gate = new Promise<void>((resolve) => { release = resolve })
  const dir = await mkdtemp(join(tmpdir(), 'hd-retry-missing-'))
  const host = new Host({
    logger: silent,
    state: new StateStore(join(dir, 'state.json')),
    version: '9.9.9',
    catalogRefreshMs: 0,
    idleStopMs: 0,
    // The host stops waiting on a slow start and carries on; the start itself runs on.
    startTimeoutMs: 20,
  })
  host.register(one)
  t.after(async () => {
    release()
    await host.dispose()
    await rm(dir, { recursive: true, force: true })
  })
  await host.start()
  assert.equal(one.starts, 1, 'asked, and still looking')

  // The PATH lands now. The ask in flight looked before it did and will fail after it.
  one.found = true
  one.gate = null
  const asking = host.retryNotInstalled()
  release()
  await asking

  assert.equal(one.starts, 2, 'asked again, after the first ask settled')
  assert.deepEqual(one.health(), { state: 'ready' })
})

test('nothing to ask again is not a start', async (t) => {
  const one = new Program({ id: runtimeId('one') })
  one.found = true
  const host = await desk(t, one)

  await host.retryNotInstalled()

  assert.equal(one.starts, 1)
})
