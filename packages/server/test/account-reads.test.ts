import assert from 'node:assert/strict'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'

import type { AccountStatus } from '@harnessdesk/protocol'

import { Host, Logger, StateStore } from '../src/index.js'
import { FakeRuntime } from './fixtures/fake-runtime.js'
import { tempDir } from './scratch.js'

const flush = () => new Promise<void>((resolve) => setImmediate(resolve))
const status: AccountStatus = { accounts: [{ kind: 'apiKey', label: 'Demo account' }], signInMethods: [] }

const makeHost = (t: TestContext, runtime: FakeRuntime, logger = new Logger('test', { level: 'error', console: false })) => {
  const directory = tempDir('hd-account-reads-')
  const host = new Host({
    state: new StateStore(join(directory, 'state.json')),
    logger,
    catalogRefreshMs: 0,
    idleStopMs: 0,
  })
  host.register(runtime)
  t.after(async () => {
    await host.dispose()
    await rm(directory, { recursive: true, force: true })
  })
  return host
}

test('client deadlines and retries keep one adapter account read, with a ten-second host deadline', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const runtime = new FakeRuntime()
  let calls = 0
  let active = 0
  let peak = 0
  const releases: (() => void)[] = []
  runtime.getAccount = () => {
    calls += 1
    peak = Math.max(peak, ++active)
    return new Promise<AccountStatus>((resolve) => releases.push(() => { active -= 1; resolve(status) }))
  }
  const host = makeHost(t, runtime)
  const outcomes: string[] = []
  const reads: Promise<unknown>[] = []
  for (let retry = 0; retry < 3; retry += 1) {
    reads.push(host.call('runtime/account', { runtime: runtime.info.id }).then(
      (answer) => { outcomes.push('value'); return answer },
      (error: Error) => { outcomes.push(error.message) },
    ))
    await flush()
    if (retry === 0) {
      t.mock.timers.tick(9_999)
      await flush()
      assert.equal(outcomes.length, 0, 'the host deadline has not expired')
      t.mock.timers.tick(1)
    } else t.mock.timers.tick(10_000)
    await flush()
  }
  t.diagnostic(`three client deadlines: adapter calls=${calls}, peak active=${peak}, settled host calls=${outcomes.length}`)
  // Always release the fake, including on the unfixed implementation.
  for (const release of releases) release()
  await Promise.all(reads)
  await flush()
  assert.equal(calls, 1, 'retries must not accumulate adapter reads')
  assert.equal(peak, 1)
  assert.equal(outcomes.length, 3)
  assert.ok(outcomes.every((outcome) => /account read timed out after 10000ms/i.test(outcome)))

  // A late success releases the hold but is never replayed to a newer caller.
  runtime.getAccount = async () => ({ accounts: [], signInMethods: [] })
  assert.deepEqual(await host.call('runtime/account', { runtime: runtime.info.id }), { accounts: [], signInMethods: [] })
})

test('concurrent account callers share a read and a completed read is not cached', async (t) => {
  const runtime = new FakeRuntime()
  let calls = 0
  let release!: (answer: AccountStatus) => void
  const releases: ((answer: AccountStatus) => void)[] = []
  runtime.getAccount = () => {
    calls += 1
    return new Promise((resolve) => { release = resolve; releases.push(resolve) })
  }
  const host = makeHost(t, runtime)
  const first = host.call('runtime/account', { runtime: runtime.info.id })
  const second = host.call('runtime/account', { runtime: runtime.info.id })
  await flush()
  for (const answer of releases) answer(status)
  assert.deepEqual(await Promise.all([first, second]), [status, status])
  assert.equal(calls, 1)
  const third = host.call('runtime/account', { runtime: runtime.info.id })
  await flush()
  release({ accounts: [], signInMethods: [] })
  assert.deepEqual(await third, { accounts: [], signInMethods: [] })
  assert.equal(calls, 2)
})

test('an account failure releases the read for retry, including synchronous throws', async (t) => {
  const runtime = new FakeRuntime()
  const host = makeHost(t, runtime)
  for (const synchronous of [false, true]) {
    runtime.getAccount = () => {
      if (synchronous) throw new Error('fixture failure')
      return Promise.reject(new Error('fixture failure'))
    }
    await assert.rejects(host.call('runtime/account', { runtime: runtime.info.id }), /fixture failure/)
    runtime.getAccount = async () => status
    assert.deepEqual(await host.call('runtime/account', { runtime: runtime.info.id }), status)
  }
})

test('a silent runtime does not hold another account or a replacement with the same id', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const runtime = new FakeRuntime()
  let reject!: (error: Error) => void
  runtime.getAccount = () => new Promise((_resolve, rejectRead) => { reject = rejectRead })
  const host = makeHost(t, runtime)
  const old = host.call('runtime/account', { runtime: runtime.info.id }).then(
    () => 'unexpected success', (error: Error) => error.message,
  )
  await flush()
  t.mock.timers.tick(10_000)
  await flush()
  const other = new FakeRuntime({ id: 'other-account' as never })
  other.getAccount = async () => status
  host.register(other)
  assert.deepEqual(await host.call('runtime/account', { runtime: other.info.id }), status)
  const replacement = new FakeRuntime({ id: runtime.info.id })
  replacement.getAccount = async () => status
  host.register(replacement)
  assert.deepEqual(await host.call('runtime/account', { runtime: runtime.info.id }), status)
  reject(new Error('late fixture failure'))
  assert.match(await old, /account read timed out after 10000ms/i)
})

test('a late rejection releases a timed-out registration for a fresh read', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const runtime = new FakeRuntime()
  let reject!: (error: Error) => void
  runtime.getAccount = () => new Promise((_resolve, rejectRead) => { reject = rejectRead })
  const host = makeHost(t, runtime)
  const expired = assert.rejects(host.call('runtime/account', { runtime: runtime.info.id }), /timed out/)
  await flush()
  t.mock.timers.tick(10_000)
  await expired
  reject(new Error('late fixture failure'))
  await flush()
  runtime.getAccount = async () => status
  assert.deepEqual(await host.call('runtime/account', { runtime: runtime.info.id }), status)
})

/*
 * A change notice says the account is different from what a read begun before
 * it may report, so a caller the notice finds mid-read is owed an answer from a
 * read that begins after it — not the older adapter's, and not an error. The
 * error it used to get ("Account changed during a read. Try again.") reached
 * every caller as `unavailable`, and a signed-in Codex says `account/updated`
 * about 0.6 s after it is up: the first seat resolved in that window was refused.
 */
test('an account change hands a read in flight to a fresh read, not to an error or the older adapter', async (t) => {
  const runtime = new FakeRuntime()
  let calls = 0
  const releases: ((answer: AccountStatus) => void)[] = []
  runtime.getAccount = () => {
    calls += 1
    return new Promise((resolve) => releases.push(resolve))
  }
  const host = makeHost(t, runtime)
  t.after(() => { for (const release of releases) release(status) })
  const first = host.call('runtime/account', { runtime: runtime.info.id }).catch((error: Error) => error.message)
  await flush()
  runtime.emit({ type: 'account/changed', runtime: runtime.info.id })
  const second = host.call('runtime/account', { runtime: runtime.info.id }).catch((error: Error) => error.message)
  const third = host.call('runtime/account', { runtime: runtime.info.id }).catch((error: Error) => error.message)
  await flush()
  assert.equal(calls, 2, 'the change starts one fresh read, shared by everybody who asks after it, while the old adapter is still pending')
  const fresh: AccountStatus = { accounts: [], signInMethods: [] }
  releases[1]!(fresh)
  assert.deepEqual(await Promise.all([first, second, third]), [fresh, fresh, fresh])
  releases[0]!(status)
  await flush()
})

test('an account change with no read in flight starts none', async (t) => {
  const runtime = new FakeRuntime()
  let calls = 0
  runtime.getAccount = async () => { calls += 1; return status }
  const host = makeHost(t, runtime)
  runtime.emit({ type: 'account/changed', runtime: runtime.info.id })
  await flush()
  assert.equal(calls, 0)
  assert.deepEqual(await host.call('runtime/account', { runtime: runtime.info.id }), status)
  runtime.emit({ type: 'account/changed', runtime: runtime.info.id })
  await flush()
  assert.equal(calls, 1, 'a completed read is not repeated by a later change')
})

for (const late of ['success', 'failure'] as const) {
  test(`an invalidated adapter's late ${late} cannot release a newer shared read or change what its callers were told`, async (t) => {
    const runtime = new FakeRuntime()
    const attempts: { resolve: (answer: AccountStatus) => void; reject: (error: Error) => void }[] = []
    runtime.getAccount = () => new Promise((resolve, reject) => attempts.push({ resolve, reject }))
    const host = makeHost(t, runtime)
    t.after(() => { for (const attempt of attempts) attempt.resolve(status) })
    const old = host.call('runtime/account', { runtime: runtime.info.id }).catch((error: Error) => error.message)
    await flush()
    runtime.emit({ type: 'account/changed', runtime: runtime.info.id })
    const fresh = host.call('runtime/account', { runtime: runtime.info.id }).catch((error: Error) => error.message)
    await flush()
    if (late === 'success') attempts[0]!.resolve(status)
    else attempts[0]!.reject(new Error('late fixture failure'))
    await flush()
    const joined = host.call('runtime/account', { runtime: runtime.info.id }).catch((error: Error) => error.message)
    await flush()
    assert.equal(attempts.length, 2, 'old settlement must leave the newer read shared')
    const answer: AccountStatus = { accounts: [], signInMethods: [] }
    attempts[1]!.resolve(answer)
    assert.deepEqual(await Promise.all([old, fresh, joined]), [answer, answer, answer],
      'the caller the change found mid-read gets the fresh answer, whatever the older adapter said later')
  })
}

for (const teardown of ['dispose', 'unregister', 'replace'] as const) {
  test(`${teardown} clears a silent account read's deadline and refuses its callers`, async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    const timers = t.mock.method(globalThis, 'setTimeout')
    const cleared = t.mock.method(globalThis, 'clearTimeout')
    const runtime = new FakeRuntime()
    let release!: (answer: AccountStatus) => void
    runtime.getAccount = () => new Promise((resolve) => { release = resolve })
    const host = makeHost(t, runtime)
    t.after(() => release(status))
    let outcome: string | undefined
    const read = host.call('runtime/account', { runtime: runtime.info.id }).then(
      () => { outcome = 'stale success' }, (error: Error) => { outcome = error.message },
    )
    await flush()
    const deadline = timers.mock.calls.find((call) => call.arguments[1] === 10_000)!.result
    if (teardown === 'dispose') await host.dispose()
    else if (teardown === 'unregister') await host.unregister(runtime.info.id)
    else host.register(new FakeRuntime({ id: runtime.info.id }))
    await flush()
    assert.ok(cleared.mock.calls.some((call) => call.arguments[0] === deadline), 'teardown must clear the deadline timer')
    assert.match(outcome ?? 'still pending', /account read.*closed/i)
    await read
  })
}

test('a silent account read warns once per deadline with its runtime named', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const logger = new Logger('test', { console: false })
  const warnings = t.mock.method(Logger.prototype, 'warn')
  const runtime = new FakeRuntime()
  let release!: (answer: AccountStatus) => void
  runtime.getAccount = () => new Promise((resolve) => { release = resolve })
  const host = makeHost(t, runtime, logger)
  t.after(() => release(status))
  const first = assert.rejects(host.call('runtime/account', { runtime: runtime.info.id }), /timed out/)
  await flush()
  t.mock.timers.tick(10_000)
  await first
  await assert.rejects(host.call('runtime/account', { runtime: runtime.info.id }), /timed out/)
  t.mock.timers.tick(10_000)
  const deadlines = () => warnings.mock.calls.filter((call) => /account read.*timed out/i.test(call.arguments[0]))
  assert.equal(deadlines().length, 1, 'retries must not repeat the warning')
  assert.deepEqual(deadlines()[0]!.arguments[1], { runtime: runtime.info.id, afterMs: 10_000 })
  release(status)
  await flush()
  const next = assert.rejects(host.call('runtime/account', { runtime: runtime.info.id }), /timed out/)
  await flush()
  t.mock.timers.tick(10_000)
  await next
  assert.equal(deadlines().length, 2, 'a new held read gets its own warning')
})

test('the account deadline includes waiting for a runtime start', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const runtime = new FakeRuntime()
  let started!: () => void
  const entered = new Promise<void>((resolve) => { started = resolve })
  let release!: () => void
  const barrier = new Promise<void>((resolve) => { release = resolve })
  const host = makeHost(t, runtime)
  await host.start()
  runtime.setHealth({ state: 'idle' })
  runtime.start = async () => {
    started()
    await barrier
    runtime.setHealth({ state: 'ready' })
  }
  let calls = 0
  runtime.getAccount = async () => { calls += 1; return status }
  t.after(release)
  const starting = host.call('session/create', { runtime: runtime.info.id, options: { cwd: '/w' } })
  await entered
  let outcome: string | undefined
  const reading = host.call('runtime/account', { runtime: runtime.info.id }).then(
    () => { outcome = 'stale success' }, (error: Error) => { outcome = error.message },
  )
  await flush()
  t.mock.timers.tick(9_999)
  await flush()
  assert.equal(outcome, undefined)
  t.mock.timers.tick(1)
  await flush()
  assert.match(outcome ?? 'still pending', /account read timed out after 10000ms/i)
  assert.equal(calls, 0, 'the deadline fires before the adapter account call can start')
  release()
  await Promise.all([starting, reading])
  await flush()
  assert.equal(calls, 1)
})
