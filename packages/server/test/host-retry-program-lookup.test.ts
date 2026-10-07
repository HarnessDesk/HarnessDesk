import assert from 'node:assert/strict'
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { fileURLToPath } from 'node:url'

import { CodexRuntime } from '@harnessdesk/adapter-codex'
import { runtimeId, type AgentRuntime, type RuntimeHealth } from '@harnessdesk/protocol'

import { Host, Logger, StateStore, type HostOptions } from '../src/index.js'
import { FakeRuntime } from './fixtures/fake-runtime.js'

/**
 * A program is not always findable, or ready to answer, the first time the
 * desk asks for it. The PATH the person's shell builds lands in the background
 * after the runtimes were first asked, and a machine that has just started is
 * slow for a while. The desk opens without waiting on either, so the look that
 * was promised is made afterwards, in the background: when the PATH changes
 * (`Host.retryProgramLookup`), and for a program that was there and would not
 * answer, on a short schedule after the desk opens.
 */
const silent = new Logger('test', { level: 'error', console: false })

const notInstalled: RuntimeHealth = { state: 'unavailable', reason: 'notInstalled', message: 'Fake is not installed on this machine.' }
const unreadable: RuntimeHealth = {
  state: 'unavailable',
  reason: 'unreadable',
  message: 'Fake was found at /usr/local/bin/fake but would not report its version: it exited with code 127.',
  remediation: 'Run `fake --version` in a terminal to see why, then choose Fake again.',
}

/** A runtime whose program is found only once the test says the machine has it. */
class Program extends FakeRuntime {
  starts = 0
  found = false
  /** The ask that answers, for a program that is slow rather than absent. */
  answersOn: number | null = null
  /** Held start: a runtime that is still looking when the PATH lands. */
  gate: Promise<void> | null = null
  failure: RuntimeHealth = notInstalled

  override async start(): Promise<void> {
    this.starts += 1
    // What it looked at when it was asked, before any wait: a start held open
    // answers about the machine as it was, not as it is when released.
    const sawIt = this.found || (this.answersOn !== null && this.starts >= this.answersOn)
    await this.gate
    if (!sawIt) {
      this.setHealth(this.failure)
      throw new Error(this.failure.state === 'unavailable' ? this.failure.message : 'unavailable')
    }
    await super.start()
  }
}

const until = async (condition: () => boolean, what: string): Promise<void> => {
  const deadline = Date.now() + 10_000
  while (!condition()) {
    assert.ok(Date.now() < deadline, what)
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** A desk that has made its first ask of every runtime, with no schedule unless the test names one. */
const desk = async (t: TestContext, options: Partial<HostOptions>, ...runtimes: AgentRuntime[]): Promise<Host> => {
  const dir = await mkdtemp(join(tmpdir(), 'hd-retry-lookup-'))
  const host = new Host({
    logger: silent,
    state: new StateStore(join(dir, 'state.json')),
    version: '9.9.9',
    catalogRefreshMs: 0,
    idleStopMs: 0,
    retryDelaysMs: [],
    ...options,
  })
  for (const runtime of runtimes) host.register(runtime)
  // A test may close the desk itself, and its cleanup then closes it again.
  const dispose = host.dispose.bind(host)
  let closing: Promise<void> | null = null
  host.dispose = () => (closing ??= dispose())
  t.after(async () => {
    await host.dispose()
    await rm(dir, { recursive: true, force: true })
  })
  await host.start()
  return host
}

test('an agent that was not installed when it was first asked is started once the PATH has it', async (t) => {
  const one = new Program({ id: runtimeId('one') })
  const host = await desk(t, {}, one)
  assert.deepEqual(one.health(), one.failure, 'the first ask found nothing')

  one.found = true
  await host.retryProgramLookup()

  assert.deepEqual(one.health(), { state: 'ready' })
  assert.equal(one.starts, 2)
})

test('an agent whose program was there and would not answer is asked again when the PATH lands', async (t) => {
  const one = new Program({ id: runtimeId('one') })
  one.failure = unreadable
  const host = await desk(t, {}, one)
  assert.deepEqual(one.health(), unreadable, 'the first ask found a copy that would not answer')

  // A launcher that needs a folder only the shell's PATH names: found from the first, runnable only after.
  one.found = true
  await host.retryProgramLookup()

  assert.deepEqual(one.health(), { state: 'ready' })
  assert.equal(one.starts, 2)
})

test('only what a PATH could change is asked again', async (t) => {
  const missing = new Program({ id: runtimeId('missing') })
  const silentCopy = new Program({ id: runtimeId('silent') })
  silentCopy.failure = unreadable
  const broken = new Program({ id: runtimeId('broken') })
  broken.failure = { state: 'unavailable', reason: 'unknown', message: 'It was found and would not run.' }
  const old = new Program({ id: runtimeId('old') })
  old.failure = { state: 'unavailable', reason: 'versionTooOld', message: 'Too old.', remediation: 'Upgrade.' }
  const down = new Program({ id: runtimeId('down') })
  down.failure = { state: 'unavailable', reason: 'crashed', message: 'It crashed.' }
  const host = await desk(t, {}, missing, silentCopy, broken, old, down)
  for (const runtime of [missing, silentCopy, broken, old, down]) runtime.found = true

  await host.retryProgramLookup()

  assert.deepEqual([missing.health().state, silentCopy.health().state], ['ready', 'ready'])
  assert.deepEqual([broken.starts, old.starts, down.starts], [1, 1, 1], 'none of these was a PATH\'s doing')
})

test('a runtime still looking when the PATH lands is judged after it finishes, not before', async (t) => {
  const one = new Program({ id: runtimeId('one') })
  let release!: () => void
  one.gate = new Promise<void>((resolve) => { release = resolve })
  // The host stops waiting on a slow start and carries on; the start itself runs on.
  const host = await desk(t, { startTimeoutMs: 20 }, one)
  t.after(() => release())
  assert.equal(one.starts, 1, 'asked, and still looking')

  // The PATH lands now. The ask in flight looked before it did and will fail after it.
  one.found = true
  one.gate = null
  const asking = host.retryProgramLookup()
  release()
  await asking

  assert.equal(one.starts, 2, 'asked again, after the first ask settled')
  assert.deepEqual(one.health(), { state: 'ready' })
})

test('a start that never settles does not turn the look off for the others', async (t) => {
  // An agent that speaks a protocol we do not never answers `initialize`: its start neither resolves nor rejects.
  const wedged = new Program({ id: runtimeId('wedged') })
  wedged.gate = new Promise<void>(() => undefined)
  const missing = new Program({ id: runtimeId('missing') })
  const host = await desk(t, { startTimeoutMs: 50 }, wedged, missing)
  assert.deepEqual(missing.health(), missing.failure, 'the first ask found nothing')

  missing.found = true
  const asking = host.retryProgramLookup()

  await until(() => missing.health().state === 'ready', 'the agent the PATH made findable waited on one that never answers')
  await asking
  assert.equal(wedged.starts, 1, 'and the one that never answers was left alone')
})

test('nothing to ask again is not a start', async (t) => {
  const one = new Program({ id: runtimeId('one') })
  one.found = true
  const host = await desk(t, {}, one)

  await host.retryProgramLookup()

  assert.equal(one.starts, 1)
})

test('a program that would not answer is asked again on a schedule, without waiting for a PATH', async (t) => {
  const one = new Program({ id: runtimeId('one') })
  one.failure = unreadable
  one.answersOn = 3
  const started = Date.now()

  await desk(t, { retryDelaysMs: [10, 10, 10, 10] }, one)
  assert.ok(Date.now() - started < 5_000, 'the desk did not wait on its own schedule')
  assert.equal(one.starts, 1, 'the first ask is made when the desk opens')

  await until(() => one.health().state === 'ready', `never asked again: ${JSON.stringify(one.health())}`)
  assert.equal(one.starts, 3, 'one ask per wait, until it answered')
})

test('the schedule has an end', async (t) => {
  const one = new Program({ id: runtimeId('one') })
  one.failure = unreadable

  await desk(t, { retryDelaysMs: [5, 5] }, one)
  await until(() => one.starts === 3, 'the schedule was not run')
  await pause(100)

  assert.equal(one.starts, 3, 'the first ask and one more after each wait, then it is left alone')
})

test('only a program that would not answer is on the schedule', async (t) => {
  const missing = new Program({ id: runtimeId('missing') })
  const broken = new Program({ id: runtimeId('broken') })
  broken.failure = { state: 'unavailable', reason: 'unknown', message: 'It was found and would not run.' }
  const silentCopy = new Program({ id: runtimeId('silent') })
  silentCopy.failure = unreadable

  await desk(t, { retryDelaysMs: [5, 5] }, missing, broken, silentCopy)
  await until(() => silentCopy.starts === 3, 'the schedule was not run')
  await pause(50)

  assert.deepEqual([missing.starts, broken.starts], [1, 1], 'a PATH is what could change those, and a PATH has its own look')
})

test('a quit cancels what is left of the schedule', async (t) => {
  // The schedule's timers are the ones set for 60 ms. A quit has to clear each,
  // not merely find nobody to ask when they fire: a timer left behind is work
  // the desk did not finish closing.
  const set: unknown[] = []
  const cleared = new Set<unknown>()
  const setTimer = globalThis.setTimeout
  const clearTimer = globalThis.clearTimeout
  t.mock.method(globalThis, 'setTimeout', ((handler: never, ms?: number, ...rest: never[]) => {
    const timer = setTimer(handler, ms, ...rest)
    if (ms === 60) set.push(timer)
    return timer
  }) as typeof setTimeout)
  t.mock.method(globalThis, 'clearTimeout', ((timer: never) => {
    cleared.add(timer)
    return clearTimer(timer)
  }) as typeof clearTimeout)
  const one = new Program({ id: runtimeId('one') })
  one.failure = unreadable
  const host = await desk(t, { retryDelaysMs: [60] }, one)
  assert.equal(one.starts, 1)
  assert.equal(set.length, 1, 'the schedule is armed when the desk opens')

  await host.dispose()
  await pause(200)

  assert.ok(set.every((timer) => cleared.has(timer)), 'the quit cleared the schedule')
  assert.equal(one.starts, 1, 'and nothing is asked after the desk has closed')
})

test('an overdue empty successful version probe is retried by the host schedule', { skip: process.platform === 'win32' }, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'hd-empty-probe-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const cli = join(dir, 'fake-launcher')
  const count = join(dir, 'probes')
  const fixture = fileURLToPath(new URL('../../../adapter-codex/dist/test/fixtures/fake-codex.mjs', import.meta.url))
  const quote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`
  await writeFile(cli, [
    '#!/bin/sh',
    'if [ "$1" = --version ]; then',
    `  if [ ! -f ${quote(count)} ]; then echo probe > ${quote(count)}; exit 0; fi`,
    `  echo probe >> ${quote(count)}`,
    'fi',
    `exec ${quote(process.execPath)} ${quote(fixture)} "$@"`,
    '',
  ].join('\n'))
  await chmod(cli, 0o755)
  const runtime = new CodexRuntime({ binaryPath: cli, codexHome: join(dir, 'agent-home'),
    discovery: { env: { PATH: dir }, locations: [] } })
  let now = 0
  const clock = t.mock.method(performance, 'now', () => { const value = now; now += 10_001; return value })
  const seen: RuntimeHealth[] = []
  const unsubscribe = runtime.onHealthChange((health) => {
    seen.push(health)
    if (health.state === 'unavailable') clock.mock.restore()
  })
  t.after(unsubscribe)
  await desk(t, { retryDelaysMs: [50, 50] }, runtime)
  const first = seen.find((health) => health.state === 'unavailable')
  assert.ok(first?.state === 'unavailable')
  assert.equal(first.reason, 'unreadable')
  assert.match(first.message, /did not answer within 10 seconds/)
  await until(() => runtime.health().state === 'ready', 'the empty probe was never retried')
  assert.equal((await readFile(count, 'utf8')).trim().split('\n').length, 2)
})
