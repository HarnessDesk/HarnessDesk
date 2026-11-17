import assert from 'node:assert/strict'
import { test } from 'node:test'
import { managedResumeAttempt } from '../src/managed-resume-attempt.js'

const gate = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes }); return { promise, resolve } }

test('managed attempt waits for readiness and forwards its exact owner to the raw receiver', async () => {
  const ready = gate<void>(), result = gate<object>(), owner = {}, handle = {}, calls: object[] = []
  const raw = { begin(id: string, supplied: object) { assert.equal(this, raw); assert.equal(id, 's'); calls.push(supplied); return { result: result.promise, retire: async () => {} } } }
  const attempt = managedResumeAttempt(async start => { await ready.promise; return start() }, () => raw.begin('s', owner))
  assert.equal(calls.length, 0)
  ready.resolve(); await ready.promise; await Promise.resolve(); assert.deepEqual(calls, [owner])
  result.resolve(handle); assert.equal(await attempt.result, handle)
})

test('retiring during readiness prevents a late raw start', async () => {
  const ready = gate<void>(); let calls = 0
  const attempt = managedResumeAttempt(async start => { await ready.promise; return start() }, () => { calls++; return { result: Promise.resolve({}), retire: async () => {} } })
  const failure = assert.rejects(attempt.result, /earlier open/)
  await attempt.retire({ published: false }); ready.resolve(); await failure
  assert.equal(calls, 0)
})

test('retirement forwards published state to the exact started attempt', async () => {
  const ready = gate<void>(), result = gate<object>(); let sent: boolean | undefined
  const attempt = managedResumeAttempt(async start => { await ready.promise; return start() }, () => ({ result: result.promise, retire: async state => { sent = state.published } }))
  ready.resolve(); await ready.promise; await Promise.resolve()
  await attempt.retire({ published: true }); assert.equal(sent, true)
  result.resolve({}); await attempt.result
})

test('fake resume ownership rejects the wrong generation and retires a gated start without opening', async () => {
  const { FakeRuntime } = await import('./fixtures/fake-runtime.js')
  const { runtimeId, sessionId } = await import('@harnessdesk/protocol')
  const fake = new FakeRuntime({ id: runtimeId('resume-owner') }), id = sessionId('s'), hold = gate<void>()
  fake.resumeAttemptGate = hold.promise
  const owner = fake.resumeOwner(id), died: object[] = []
  fake.onResumeOwnerDied(value => died.push(value))
  assert.throws(() => fake.beginResumeAttempt(id, {}, {}), /owner/)
  const attempt = fake.beginResumeAttempt(id, {}, owner)
  const refused = assert.rejects(attempt.result, /retired/)
  const retirement = attempt.retire({ published: false })
  hold.resolve(); await Promise.all([refused, retirement])
  assert.equal(fake.resumes, 0)
  fake.dieResumeOwner(id)
  assert.deepEqual(died, [owner]); assert.notEqual(fake.resumeOwner(id), owner)
})

test('retirement during the rest barrier prevents a subsequent readiness start', async () => {
  const rest = gate<void>()
  let starts = 0, opens = 0
  const attempt = managedResumeAttempt(async (start, check) => {
    await rest.promise
    check()
    starts++ // mirrors the managed proxy invoking #ensureStarted after rest
    return start()
  }, () => { opens++; return { result: Promise.resolve({}), retire: async () => {} } })
  const failed = assert.rejects(attempt.result, /earlier open/)
  await attempt.retire({ published: false })
  rest.resolve()
  await failed
  assert.equal(starts, 0, 'a revoked attempt cannot start the runtime after a rest wait')
  assert.equal(opens, 0)
})

test('a dispatched readiness start settles, but retirement prevents its subsequent raw open', async () => {
  const starting = gate<void>(), entered = gate<void>()
  let starts = 0, settled = 0, opens = 0
  const attempt = managedResumeAttempt(async (start, check) => {
    check(); starts++; entered.resolve()
    await starting.promise
    settled++
    check()
    return start()
  }, () => { opens++; return { result: Promise.resolve({}), retire: async () => {} } })
  const failed = assert.rejects(attempt.result, /earlier open/)
  await entered.promise
  await attempt.retire({ published: false })
  starting.resolve()
  await failed
  assert.equal(starts, 1)
  assert.equal(settled, 1, 'the already-dispatched start may settle')
  assert.equal(opens, 0, 'no raw open follows retirement')
})
