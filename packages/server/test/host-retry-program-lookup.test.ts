import assert from 'node:assert/strict'
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
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
  // These lookup tests begin after each agent has been explicitly tried;
  // launch itself now tries only the default, without waiting on it.
  await Promise.all(runtimes.map(async runtime => {
    await host.call('runtime/warm', { runtime: runtime.info.id })
    let timer: ReturnType<typeof setTimeout> | undefined
    await Promise.race([
      host.call('runtime/models', { runtime: runtime.info.id }).catch(() => {}),
      new Promise<void>(resolve => { timer = setTimeout(resolve, options.startTimeoutMs ?? 5000) }),
    ])
    clearTimeout(timer)
  }))
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

/**
 * The desk opens by starting only its default agent, so any other agent sits
 * idle until something asks it, and an idle agent reads as ready. One whose
 * program could not be found or run last time is the exception: the desk
 * already had that answer, and drawing it ready until somebody opened its page
 * is drawing it wrong (#1774). So the desk remembers it, and asks that agent
 * again as it opens.
 */
const relaunch = async (dir: string, own: (host: Host) => void, ...runtimes: AgentRuntime[]): Promise<Host> => {
  const host = new Host({
    logger: silent,
    state: new StateStore(join(dir, 'state.json')),
    version: '9.9.9',
    catalogRefreshMs: 0,
    idleStopMs: 0,
    retryDelaysMs: [],
  })
  // The default is the first registered, and it is the one launch starts.
  host.register(new FakeRuntime({ id: runtimeId('default') }))
  for (const runtime of runtimes) host.register(runtime)
  own(host)
  await host.start()
  return host
}

const relaunchFixture = async (t: TestContext, prefix: string) => {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  const hosts: Host[] = []
  // Register before any launch; failed starts and manually closed hosts still belong here.
  let cleanup: Promise<void> | undefined
  t.after(() => (cleanup ??= (async () => {
    const results = await Promise.allSettled(hosts.map(host => host.dispose()))
    const failures = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected')
    // Keep state for inspection when a failed shutdown may leave writers alive.
    if (failures.length) throw new AggregateError(failures.map(result => result.reason), 'host cleanup failed')
    await rm(dir, { recursive: true, force: true })
  })()))
  return { dir, relaunch: (...runtimes: AgentRuntime[]) => relaunch(dir, host => {
    const dispose = host.dispose.bind(host)
    let closing: Promise<void> | undefined
    host.dispose = () => (closing ??= dispose())
    hosts.push(host)
  }, ...runtimes) }
}

test('relaunch fixture waits for every host before removing its directory', async (t) => {
  const hooks: Array<() => unknown> = []
  const context = { after: (hook: () => unknown) => { hooks.push(hook) } } as unknown as TestContext
  const fixture = await relaunchFixture(context, 'hd-retry-cleanup-')
  t.after(() => hooks[0]!())
  const first = await fixture.relaunch()
  await first.dispose()
  const second = await fixture.relaunch()
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  let started!: () => void
  const disposing = new Promise<void>(resolve => { started = resolve })
  const dispose = second.dispose.bind(second)
  second.dispose = async () => {
    started()
    await gate
    await writeFile(join(fixture.dir, 'last-write'), 'done')
    await dispose()
  }
  const cleanup = Promise.resolve(hooks[0]!())
  try {
    const began = await Promise.race([disposing.then(() => true), cleanup.then(() => false)])
    assert.equal(began, true, 'cleanup must begin host disposal before directory removal')
    assert.ok((await stat(fixture.dir)).isDirectory(), 'directory remains while disposal is held')
    release()
    await cleanup
    await assert.rejects(stat(fixture.dir), { code: 'ENOENT' })
  } finally {
    release()
    await cleanup
    await rm(fixture.dir, { recursive: true, force: true })
  }
})

test('relaunch fixture owns a host whose start fails', async (t) => {
  const hooks: Array<() => unknown> = []
  const context = { after: (hook: () => unknown) => { hooks.push(hook) } } as unknown as TestContext
  const fixture = await relaunchFixture(context, 'hd-retry-failed-start-')
  t.after(() => hooks[0]!())
  const disposed: Host[] = []
  const dispose = Host.prototype.dispose
  t.mock.method(Host.prototype, 'start', async () => { throw new Error('controlled start failure') })
  t.mock.method(Host.prototype, 'dispose', async function (this: Host) {
    disposed.push(this)
    await dispose.call(this)
  })

  await assert.rejects(fixture.relaunch(), /controlled start failure/)
  await hooks[0]!()
  assert.equal(disposed.length, 1, 'the host whose start failed was disposed once')
  await assert.rejects(stat(fixture.dir), { code: 'ENOENT' })
})

const ask = async (host: Host, runtime: AgentRuntime): Promise<void> => {
  await host.call('runtime/warm', { runtime: runtime.info.id })
  await host.call('runtime/models', { runtime: runtime.info.id }).catch(() => {})
}

test('a failed spawn is remembered and unavailable as the desk next opens', async (t) => {
  const { relaunch: open } = await relaunchFixture(t, 'hd-spawn-relaunch-')
  const id = runtimeId('one')
  const failure = { state: 'unavailable', reason: 'spawnFailed', message: 'Fake could not spawn.' } satisfies RuntimeHealth
  const first = new Program({ id })
  first.failure = failure
  const before = await open(first)
  await ask(before, first)
  await before.dispose()

  const second = new Program({ id })
  second.failure = failure
  const after = await open(second)
  await pause(100)
  assert.equal(second.starts, 1, 'the failed spawn must be asked again at launch')
  const health = after.syncPayload().params.health?.find(entry => entry.runtime === id)?.health
  assert.deepEqual(health, failure)
})

test('a fresh desk uses discovery failure before any session asks the agent', async (t) => {
  const { dir, relaunch: open } = await relaunchFixture(t, 'hd-discovery-first-')
  class DiscoveredProgram extends Program {
    discoveries = 0
    async discoverProgram(): Promise<void> {
      this.discoveries += 1
      this.setHealth(unreadable)
    }
  }
  const program = new DiscoveredProgram({ id: runtimeId('one') })
  program.setHealth({ state: 'idle' })
  const host = await open(program)
  await pause(100)
  assert.equal(program.discoveries, 1, 'startup should use the program discovery')
  assert.equal(program.starts, 0, 'discovery does not launch the agent')
  assert.deepEqual(host.syncPayload().params.health?.find(entry => entry.runtime === program.info.id)?.health, unreadable)
  await host.dispose()
  const cache = JSON.parse(await readFile(join(dir, 'runtime-cache.json'), 'utf8'))
  assert.equal(cache.runtimes.one.wouldNotStart, 'unreadable', 'discovery seeds the same remembered program failure')
})

test('the PATH re-ask waits for a discovery in flight before judging the runtime', async (t) => {
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  t.after(() => release())
  const { dir, relaunch: open } = await relaunchFixture(t, 'hd-discovery-path-')
  let discovered!: () => void
  const discoveryFinished = new Promise<void>(resolve => { discovered = resolve })
  class DiscoveredProgram extends Program {
    discoveries = 0
    async discoverProgram(): Promise<void> {
      this.discoveries += 1
      const sawIt = this.found
      await gate
      this.setHealth(sawIt ? { state: 'idle' } : notInstalled)
      discovered()
    }
  }
  const program = new DiscoveredProgram({ id: runtimeId('one') })
  program.setHealth({ state: 'idle' })
  const host = await open(program)
  assert.equal(program.discoveries, 1, 'startup discovery is still looking')
  assert.equal(program.starts, 0, 'startup has not launched the unused agent')

  // Discovery saw the old PATH; the one re-ask must use the new one after it settles.
  program.found = true
  const asking = host.retryProgramLookup()
  release()
  await discoveryFinished
  await asking

  assert.equal(program.discoveries, 2, 'the PATH re-ask repeats discovery after the older lookup finishes')
  assert.equal(program.starts, 0, 'a PATH re-ask must not launch an unused agent')
  assert.deepEqual(program.health(), { state: 'idle' })
  assert.deepEqual(host.syncPayload().params.health?.find(entry => entry.runtime === program.info.id)?.health, { state: 'idle' })
  await host.dispose()
  const cache = JSON.parse(await readFile(join(dir, 'runtime-cache.json'), 'utf8'))
  assert.equal(cache.runtimes.one.wouldNotStart, undefined, 'recovered discovery must not start the agent at the next boot')
})

test('the PATH re-ask re-discovers a settled missing program without starting it', async (t) => {
  const { relaunch: open } = await relaunchFixture(t, 'hd-discovery-path-settled-')
  class DiscoveredProgram extends Program {
    discoveries = 0
    async discoverProgram(): Promise<void> {
      this.discoveries += 1
      this.setHealth(this.found ? { state: 'idle' } : notInstalled)
    }
  }
  const program = new DiscoveredProgram({ id: runtimeId('one') })
  program.setHealth({ state: 'idle' })
  const host = await open(program)
  await until(() => program.health().state === 'unavailable', 'startup discovery did not finish')

  program.found = true
  await host.retryProgramLookup()

  assert.equal(program.discoveries, 2)
  assert.equal(program.starts, 0)
  assert.deepEqual(program.health(), { state: 'idle' })

  // Once explicitly started, a later PATH failure belongs to the start path.
  await ask(host, program)
  assert.equal(program.starts, 1)
  program.setHealth(notInstalled)
  await host.retryProgramLookup()
  assert.equal(program.starts, 2, 'a runtime that did start keeps the existing re-start behavior')
  assert.equal(program.discoveries, 2)
})

test('a stop that says unknown is not remembered as a program failure', async (t) => {
  const { dir, relaunch: open } = await relaunchFixture(t, 'hd-stop-relaunch-')
  const id = runtimeId('one')
  const first = new Program({ id })
  first.found = true
  const before = await open(first)
  await ask(before, first)
  first.setHealth({ state: 'unavailable', reason: 'unknown', message: 'Stopped.' })
  await before.dispose()

  const again = new Program({ id })
  await open(again)
  await pause(100)
  assert.equal(again.starts, 0, 'stopping does not ask the agent again next launch')
  const cache = JSON.parse(await readFile(join(dir, 'runtime-cache.json'), 'utf8'))
  assert.equal(cache.runtimes.one.wouldNotStart, undefined)
})

test('startup discovers a never-started Codex without launching its app-server', { skip: process.platform === 'win32' }, async (t) => {
  const { dir, relaunch: open } = await relaunchFixture(t, 'hd-codex-discovery-first-')
  const cli = join(dir, 'codex')
  const invocations = join(dir, 'invocations')
  const quote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`
  await writeFile(cli, `#!/bin/sh\nprintf '%s\\n' "$*" >> ${quote(invocations)}\nexit 127\n`)
  await chmod(cli, 0o755)
  const runtime = new CodexRuntime({ binaryPath: cli, codexHome: join(dir, 'agent-home'),
    discovery: { env: { PATH: dir }, locations: [] } })
  const host = await open(runtime)
  await until(() => runtime.health().state === 'unavailable', 'startup never discovered the broken program')
  const health = host.syncPayload().params.health?.find(entry => entry.runtime === runtime.info.id)?.health
  assert.ok(health?.state === 'unavailable')
  assert.equal(health.reason, 'unreadable')
  assert.match(health.message, /would not report its version/)
  // Closed here, before the folder is removed, so nothing is still writing to it.
  await host.dispose()
  const args = await readFile(invocations, 'utf8')
  assert.match(args, /--version/, 'discovery must have probed the fake program')
  assert.doesNotMatch(args, /app-server/, 'discovery must never launch the app-server')
})

test('a Codex that would not report its version is asked again as the desk next opens, not drawn idle', async (t) => {
  const { dir, relaunch: open } = await relaunchFixture(t, 'hd-retry-relaunch-')
  const cli = join(dir, 'codex')
  await writeFile(cli, '#!/bin/sh\nexit 1\n')
  await chmod(cli, 0o755)
  const codex = (): CodexRuntime => new CodexRuntime({ binaryPath: cli, codexHome: join(dir, 'agent-home'),
    discovery: { env: { PATH: dir }, locations: [] } })

  const first = codex()
  const before = await open(first)
  await ask(before, first)
  await until(() => first.health().state === 'unavailable', 'the first ask never found the copy broken')
  await before.dispose()

  const second = codex()
  await open(second)
  assert.notEqual(second.health().state, 'ready')
  await until(() => second.health().state === 'unavailable', 'the desk opened with the broken copy drawn idle')
  const health = second.health()
  assert.ok(health.state === 'unavailable')
  assert.equal(health.reason, 'unreadable')
  assert.match(health.message, /would not report its version/)
})

test('an agent asked again at launch that now starts is left cold the time after', async (t) => {
  const { relaunch: open } = await relaunchFixture(t, 'hd-retry-relaunch-')
  const id = runtimeId('one')

  const broken = new Program({ id })
  broken.failure = unreadable
  const before = await open(broken)
  await ask(before, broken)
  assert.deepEqual(broken.health(), unreadable)
  await before.dispose()

  const fixed = new Program({ id })
  fixed.found = true
  const during = await open(fixed)
  await until(() => fixed.health().state === 'ready', 'the agent that failed last time was not asked at launch')
  assert.equal(fixed.starts, 1)
  await during.dispose()

  const after = new Program({ id })
  after.found = true
  await open(after)
  await pause(100)
  assert.equal(after.starts, 0, 'an agent that started last time waits to be asked, like any other')
})

test('an agent that failed for a reason of its own is not asked at launch', async (t) => {
  const { relaunch: open } = await relaunchFixture(t, 'hd-retry-relaunch-')
  const id = runtimeId('one')

  const down = new Program({ id })
  down.failure = { state: 'unavailable', reason: 'crashed', message: 'It crashed.' }
  const before = await open(down)
  await ask(before, down)
  assert.equal(down.health().state, 'unavailable')
  await before.dispose()

  const again = new Program({ id })
  await open(again)
  await pause(100)
  assert.equal(again.starts, 0, 'a crash is not a fact about the program on disk')
})

test('an agent that was missing and then crashed is not asked at launch', async (t) => {
  const { relaunch: open } = await relaunchFixture(t, 'hd-retry-relaunch-')
  const id = runtimeId('one')

  const program = new Program({ id })
  const before = await open(program)
  await ask(before, program)
  assert.deepEqual(program.health(), notInstalled)
  // Installed since, and it got as far as running before it fell over.
  program.setHealth({ state: 'unavailable', reason: 'crashed', message: 'It crashed.' })
  await before.dispose()

  const again = new Program({ id })
  await open(again)
  await pause(100)
  assert.equal(again.starts, 0, 'the missing program is not the reason any more')
})
