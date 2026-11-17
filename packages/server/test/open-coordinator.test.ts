import assert from 'node:assert/strict'
import { test } from 'node:test'
import { OpenCoordinator, OpenUnavailableError } from '../src/open-coordinator.js'

const deferred = <T>() => {
  let resolve!: (value: T) => void, reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
const fixture = () => {
  const timers = new Set<() => void>()
  const coordinator = new OpenCoordinator({ deadlineMs: 120_000, schedule: callback => { timers.add(callback); return () => { timers.delete(callback) } } })
  const expire = () => { for (const callback of [...timers]) callback() }
  return { coordinator, expire, timers }
}

test('joined callers count independently and share only one owned attempt', async () => {
  const { coordinator: c, timers } = fixture(), runtime = {}, result = deferred<object>(), handle = {}
  let starts = 0
  const start = () => { starts++; return { result: result.promise, retire: async () => {} } }
  const first = c.open(runtime, 's', start), second = c.open(runtime, 's', start)
  assert.deepEqual(c.counts(runtime, 's'), { opened: 2, pending: 2 })
  assert.equal(starts, 1)
  result.resolve(handle)
  assert.equal(await first, handle); assert.equal(await second, handle)
  assert.deepEqual(c.counts(runtime, 's'), { opened: 2, pending: 0 })
  assert.equal(timers.size, 0)
})

test('detach invalidates no-record waiters and quarantines until owned retirement', async () => {
  const { coordinator: c } = fixture(), runtime = {}, result = deferred<object>(), retired = deferred<void>()
  let retireCalls = 0, starts = 0
  const first = c.open(runtime, 's', () => { starts++; return { result: result.promise, retire: () => { retireCalls++; return retired.promise } } })
  const second = c.open(runtime, 's', () => { throw new Error('joined must not start') })
  const firstRefusal = assert.rejects(first, OpenUnavailableError), secondRefusal = assert.rejects(second, OpenUnavailableError)
  c.detach(runtime, 's')
  await Promise.all([firstRefusal, secondRefusal])
  assert.deepEqual(c.counts(runtime, 's'), { opened: 2, pending: 0 })
  assert.equal(retireCalls, 1)
  await assert.rejects(c.open(runtime, 's', () => { starts++; throw new Error('must stay quarantined') }), OpenUnavailableError)
  assert.equal(starts, 1)
  retired.resolve(); await retired.promise; await Promise.resolve()
  const newer = {}, third = c.open(runtime, 's', () => ({ result: Promise.resolve(newer), retire: async () => {} }))
  assert.equal(await third, newer)
  result.resolve({}); await result.promise; await Promise.resolve()
  assert.deepEqual(c.counts(runtime, 's'), { opened: 3, pending: 0 })
})

test('deadline rejects waiters; failed retirement holds quarantine until exact runtime death', async () => {
  const { coordinator: c, expire } = fixture(), oldRuntime = {}, replacement = {}, result = deferred<object>()
  const first = c.open(oldRuntime, 's', () => ({ result: result.promise, retire: async () => { throw new Error('unproven') } }))
  const refused = assert.rejects(first, OpenUnavailableError)
  expire(); await refused; await Promise.resolve()
  await assert.rejects(c.open(oldRuntime, 's', () => { throw new Error('quarantined') }), OpenUnavailableError)
  const newer = {}, next = c.open(replacement, 's', () => ({ result: Promise.resolve(newer), retire: async () => {} }))
  assert.equal(await next, newer)
  c.runtimeDied(oldRuntime)
  const after = {}, resumed = c.open(oldRuntime, 's', () => ({ result: Promise.resolve(after), retire: async () => {} }))
  assert.equal(await resumed, after)
  result.resolve({}); await result.promise; await Promise.resolve()
  assert.deepEqual(c.counts(oldRuntime, 's'), { opened: 2, pending: 0 })
})

test('runtime detach invalidates each key without changing another runtime', async () => {
  const { coordinator: c } = fixture(), a = {}, b = {}, held = deferred<object>()
  const one = c.open(a, 'one', () => ({ result: held.promise, retire: async () => {} }))
  const two = c.open(a, 'two', () => ({ result: held.promise, retire: async () => {} }))
  const other = c.open(b, 'one', () => ({ result: held.promise, retire: async () => {} }))
  const checks = [assert.rejects(one, OpenUnavailableError), assert.rejects(two, OpenUnavailableError)]
  c.detach(a); await Promise.all(checks)
  assert.equal(c.counts(a, 'one').pending, 0); assert.equal(c.counts(a, 'two').pending, 0)
  assert.equal(c.counts(b, 'one').pending, 1)
  const value = {}; held.resolve(value); assert.equal(await other, value)
})

test('attempt authority is revoked before retirement and cannot be restored by a late result', async () => {
  const { coordinator: c } = fixture(), runtime = {}, result = deferred<object>(), retirement = deferred<void>()
  let current!: () => boolean, currentWhenRetired = true
  const first = c.open(runtime, 's', authority => {
    current = authority.current
    return { result: result.promise, retire: () => { currentWhenRetired = current(); return retirement.promise } }
  })
  const refused = assert.rejects(first, OpenUnavailableError)
  assert.equal(current(), true)
  c.detach(runtime, 's'); await refused
  assert.equal(currentWhenRetired, false)
  retirement.resolve(); await retirement.promise; await Promise.resolve()
  const next = deferred<object>()
  let newCurrent!: () => boolean
  const nextResult = c.open(runtime, 's', authority => { newCurrent = authority.current; return { result: next.promise, retire: async () => {} } })
  result.resolve({}); await result.promise; await Promise.resolve()
  assert.equal(current(), false); assert.equal(newCurrent(), true)
  next.resolve({}); await nextResult
})

test('late old completion cannot decrement a pending successor', async () => {
  const { coordinator: c } = fixture(), runtime = {}, old = deferred<object>(), newer = deferred<object>()
  const first = c.open(runtime, 's', () => ({ result: old.promise, retire: async () => {} }))
  const refused = assert.rejects(first, OpenUnavailableError)
  c.detach(runtime, 's'); await refused; await Promise.resolve()
  const second = c.open(runtime, 's', () => ({ result: newer.promise, retire: async () => {} }))
  old.resolve({}); await old.promise; await Promise.resolve()
  assert.deepEqual(c.counts(runtime, 's'), { opened: 2, pending: 1 })
  newer.resolve({}); await second
  assert.equal(c.counts(runtime, 's').pending, 0)
})

test('a synchronous detach during start revokes the installed attempt and retires it', async () => {
  const { coordinator: c } = fixture(), runtime = {}, result = deferred<object>(), retired = deferred<void>()
  let current!: () => boolean, retiredCalls = 0
  const first = c.open(runtime, 's', authority => {
    current = authority.current
    c.detach(runtime, 's')
    return { result: result.promise, retire: () => { retiredCalls++; return retired.promise } }
  })
  await assert.rejects(first, OpenUnavailableError)
  assert.equal(current(), false); assert.equal(retiredCalls, 1)
  await assert.rejects(c.open(runtime, 's', () => { throw new Error('quarantine bypass') }), OpenUnavailableError)
  retired.resolve(); await retired.promise
})

test('a synchronous reentrant open joins the installed placeholder', async () => {
  const { coordinator: c } = fixture(), runtime = {}, result = deferred<object>()
  let nested!: Promise<object>, starts = 0
  const first = c.open(runtime, 's', () => {
    starts++
    nested = c.open(runtime, 's', () => { starts++; throw new Error('second attempt') })
    return { result: result.promise, retire: async () => {} }
  })
  const handle = {}; result.resolve(handle)
  assert.equal(await first, handle); assert.equal(await nested, handle); assert.equal(starts, 1)
  assert.deepEqual(c.counts(runtime, 's'), { opened: 2, pending: 0 })
})

test('start throws after reentrant join and rejects every caller without stranded state', async () => {
  const { coordinator: c } = fixture(), runtime = {}
  let nested!: Promise<object>
  const first = c.open<object>(runtime, 's', () => {
    nested = c.open(runtime, 's', () => { throw new Error('second attempt') })
    throw new Error('start failed')
  })
  await assert.rejects(first, /start failed/); await assert.rejects(nested, /start failed/)
  assert.deepEqual(c.counts(runtime, 's'), { opened: 2, pending: 0 })
  await assert.rejects(c.open(runtime, 's', () => { throw new Error('quarantine bypass') }), OpenUnavailableError)
  c.runtimeDied(runtime)
})

test('a rejected result requires proven retirement before another attempt', async () => {
  const { coordinator: c } = fixture(), runtime = {}, failed = deferred<object>(), retirement = deferred<void>()
  let retireCalls = 0, starts = 0
  const first = c.open(runtime, 's', () => { starts++; return { result: failed.promise, retire: () => { retireCalls++; return retirement.promise } } })
  const refused = assert.rejects(first, /peer timeout/)
  failed.reject(new Error('peer timeout')); await refused
  assert.equal(retireCalls, 1)
  await assert.rejects(c.open(runtime, 's', () => { starts++; throw new Error('quarantine bypass') }), OpenUnavailableError)
  assert.equal(starts, 1)
  retirement.resolve(); await retirement.promise; await Promise.resolve()
  assert.ok(await c.open(runtime, 's', () => ({ result: Promise.resolve({}), retire: async () => {} })))
})

test('detach wins over a result resolved before delivery', async () => {
  const { coordinator: c } = fixture(), runtime = {}, result = deferred<object>()
  let current!: () => boolean
  const first = c.open(runtime, 's', authority => { current = authority.current; return { result: result.promise, retire: async () => {} } })
  const refused = assert.rejects(first, OpenUnavailableError)
  result.resolve({}); c.detach(runtime, 's')
  await refused; assert.equal(current(), false)
})

// Defensive reentrancy: reuse of a dead key is forbidden by the production contract, but cannot let an
// old callback clear a later quarantine even if a caller violates that contract.
test('an old late-bound retirement cannot release a newer generation quarantine', async () => {
  const { coordinator: c } = fixture(), owner = {}, oldResult = deferred<object>(), oldRetire = deferred<void>()
  const nextResult = deferred<object>(), nextRetire = deferred<void>()
  let newer!: Promise<object>, newerRefused!: Promise<void>, oldRetireCalls = 0
  const old = c.open(owner, 's', () => {
    c.detach(owner, 's')
    c.runtimeDied(owner)
    newer = c.open(owner, 's', () => ({ result: nextResult.promise, retire: () => nextRetire.promise }))
    newerRefused = assert.rejects(newer, OpenUnavailableError)
    c.detach(owner, 's')
    return { result: oldResult.promise, retire: () => { oldRetireCalls++; return oldRetire.promise } }
  })
  await assert.rejects(old, OpenUnavailableError); await newerRefused
  assert.equal(oldRetireCalls, 1)
  oldRetire.resolve(); await oldRetire.promise; await Promise.resolve()
  await assert.rejects(c.open(owner, 's', () => { throw new Error('new quarantine released') }), OpenUnavailableError)
  nextRetire.resolve(); await nextRetire.promise; await Promise.resolve()
  assert.ok(await c.open(owner, 's', () => ({ result: Promise.resolve({}), retire: async () => {} })))
})

test('mixed caller completions share one handle and return their own types', async () => {
  const { coordinator: c } = fixture(), owner = {}, result = deferred<{ id: string }>(), handle = { id: 's' }
  let starts = 0
  const start = () => { starts++; return { result: result.promise, retire: async () => {} } }
  const session = c.open(owner, 's', start, async live => ({ session: live.id }))
  const raw = c.open(owner, 's', start, async live => live)
  result.resolve(handle)
  assert.deepEqual(await session, { session: 's' }); assert.equal(await raw, handle); assert.equal(starts, 1)
  assert.deepEqual(c.counts(owner, 's'), { opened: 2, pending: 0 })
})

test('detach fences a slow caller completion and preserves published holder', async () => {
  const { coordinator: c } = fixture(), owner = {}, hold = deferred<void>(), entered = deferred<void>(), retired = deferred<void>()
  let authority!: () => boolean, published: boolean | undefined
  const start = () => ({ result: Promise.resolve({ id: 's' }), retire: (state: { published: boolean }) => { published = state.published; return retired.promise } })
  const slow = c.open(owner, 's', start, async (_live, caller) => { authority = caller.current; entered.resolve(); await hold.promise; return 'late' })
  const refused = assert.rejects(slow, OpenUnavailableError)
  const fast = c.open(owner, 's', start, async () => 'published')
  assert.equal(await fast, 'published'); await entered.promise
  c.detach(owner, 's'); await refused
  assert.equal(authority(), false); assert.equal(published, true)
  hold.resolve(); await hold.promise; await Promise.resolve()
  assert.equal(c.counts(owner, 's').pending, 0)
  retired.resolve()
})

test('a caller joining after adapter result shares its in-flight completion', async () => {
  const { coordinator: c } = fixture(), owner = {}, hold = deferred<void>(), entered = deferred<void>(), handle = {}
  let starts = 0
  const start = () => { starts++; return { result: Promise.resolve(handle), retire: async () => {} } }
  const first = c.open(owner, 's', start, async live => { entered.resolve(); await hold.promise; return live })
  await entered.promise
  const second = c.open(owner, 's', start, async live => live)
  assert.equal(await second, handle); assert.equal(starts, 1)
  hold.resolve(); assert.equal(await first, handle)
})

test('open count survives owner generation replacement under a shared lifetime key', async () => {
  const { coordinator: c } = fixture(), lifetime = {}, old = {}, next = {}
  await c.open(old, 's', () => ({ result: Promise.resolve({}), retire: async () => {} }), undefined, lifetime)
  c.runtimeDied(old)
  await c.open(next, 's', () => ({ result: Promise.resolve({}), retire: async () => {} }), undefined, lifetime)
  assert.deepEqual(c.counts(next, 's', lifetime), { opened: 2, pending: 0 })
})

test('detach between delivery scheduling and completion prevents its side effects', async () => {
  const { coordinator: c } = fixture(), owner = {}, result = deferred<object>()
  let effects = 0
  const open = c.open(owner, 's', () => ({ result: result.promise, retire: async () => {} }), async () => { effects++; return 'done' })
  const refused = assert.rejects(open, OpenUnavailableError)
  void result.promise.then(() => c.detach(owner, 's'))
  result.resolve({}); await refused; await Promise.resolve()
  assert.equal(effects, 0)
})

test('unavailable opens retain a retryable runtime-down classification', () => {
  const error = new OpenUnavailableError()
  assert.equal(error.code, 'notRunning')
})

test('exclusive cleanup seals the flight before an asynchronous close', async () => {
  const { coordinator: c } = fixture(), owner = {}, gate = deferred<void>(), entered = deferred<void>()
  const first = c.open(owner, 's', authority => ({ result: (async () => { assert.equal(authority.exclusive(), true); entered.resolve(); await gate.promise; return {} })(), retire: async () => {} }))
  await entered.promise
  await assert.rejects(c.open(owner, 's', () => { throw new Error('joined sealed cleanup') }), OpenUnavailableError)
  gate.resolve(); await first
})
