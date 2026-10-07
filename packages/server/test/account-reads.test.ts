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

const makeHost = (t: TestContext, runtime: FakeRuntime) => {
  const directory = tempDir('hd-account-reads-')
  const host = new Host({
    state: new StateStore(join(directory, 'state.json')),
    logger: new Logger('test', { level: 'error', console: false }),
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

test('an account change refuses the older shared answer without starting an overlapping read', async (t) => {
  const runtime = new FakeRuntime()
  let calls = 0
  const releases: ((answer: AccountStatus) => void)[] = []
  runtime.getAccount = () => {
    calls += 1
    return new Promise((resolve) => releases.push(resolve))
  }
  const host = makeHost(t, runtime)
  const first = host.call('runtime/account', { runtime: runtime.info.id }).then(
    () => 'stale success', (error: Error) => error.message,
  )
  await flush()
  runtime.emit({ type: 'account/changed', runtime: runtime.info.id })
  const second = host.call('runtime/account', { runtime: runtime.info.id }).then(
    () => 'stale success', (error: Error) => error.message,
  )
  await flush()
  for (const release of releases) release(status)
  const outcomes = await Promise.all([first, second])
  await flush()
  assert.equal(calls, 1)
  assert.ok(outcomes.every((outcome) => /account changed during a read/i.test(outcome)), outcomes.join(', '))
  runtime.getAccount = async () => ({ accounts: [], signInMethods: [] })
  assert.deepEqual(await host.call('runtime/account', { runtime: runtime.info.id }), { accounts: [], signInMethods: [] })
})
