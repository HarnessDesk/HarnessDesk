import assert from 'node:assert/strict'
import { test } from 'node:test'
import { itemId, type Session } from '@harnessdesk/protocol'

import { deskWithMergeAgent, recordOf, reviewAndApprove } from './attachments-lifecycle.test.js'

const seated = async (t: { after(fn: () => unknown): void }) => {
  const desk = await deskWithMergeAgent(t)
  await reviewAndApprove(desk)
  const session = await desk.client.call('agent/seat', {
    id: 'reviewer', cwd: desk.work, project: desk.work, permission: 'merge',
  }) as Session
  const params = { runtime: session.runtime, sessionId: session.id }
  const seat = desk.harness.host.registry.attachmentSeatOf(session.runtime, session.id)!
  const original = desk.runtime.sessions.get(session.id)!
  // Like the real adapters, release the live handle but keep stored history.
  original.close = async () => {
    await original.interrupt()
    desk.runtime.sessions.delete(session.id)
    desk.runtime.emit({ type: 'session/closed', sessionId: session.id })
  }
  return { desk, session, params, seat }
}

for (const how of ['during Undo', 'after Undo', 'after expiry'] as const) {
  test(`Resume ${how} keeps frozen attachments and an open registry handle`, async t => {
    const { desk, session, params, seat } = await seated(t)
    const opened = desk.runtime.attachmentsGiven.get(session.id)!
    if (how === 'after expiry') {
      t.after(() => t.mock.timers.reset())
      t.mock.timers.enable({ apis: ['Date'], now: Date.now() })
    }
    await desk.client.call('session/remove', { ...params, removed: true })
    if (how === 'after Undo') await desk.client.call('session/remove', { ...params, removed: false })
    if (how === 'after expiry') {
      t.mock.timers.tick(8_000)
      desk.harness.host.registry.sweepRemoved(Date.now())
    }
    const resumed = await desk.client.call('session/resume', params) as Session
    assert.equal(resumed.id, session.id)
    const live = desk.runtime.sessions.get(session.id)!
    assert.equal(desk.harness.host.registry.get(session.runtime, session.id)?.live, live)
    assert.equal(desk.harness.host.registry.attachmentSeatOf(session.runtime, session.id), seat)
    const reopened = desk.runtime.attachmentsGiven.get(session.id)!
    assert.notEqual(reopened.key, opened.key)
    assert.deepEqual(reopened.skills, opened.skills)
    assert.deepEqual(reopened.mcp, opened.mcp)
    const receipt = await recordOf(desk, session)
    assert.equal(receipt.epoch, 1)
    assert.deepEqual(receipt.results.map(one => one.status), ['loaded', 'loaded'])
    await desk.client.call('turn/send', { ...params, input: [{ type: 'text', text: 'Continue with approved attachments.' }] })
    assert.ok(desk.harness.host.registry.get(session.runtime, session.id)?.running.size)
  })
}

for (const undoFirst of [false, true]) test(`a failed frozen receipt ${undoFirst ? 'after Undo' : 'during Undo'} closes its handle; retry records one epoch`, async t => {
  const { desk, session, params, seat } = await seated(t)
  await desk.client.call('session/remove', { ...params, removed: true })
  if (undoFirst) await desk.client.call('session/remove', { ...params, removed: false })
  const plane = desk.harness.host.attachmentsPlane
  const record = plane.record.bind(plane)
  const fail = t.mock.method(plane, 'record', async () => { throw new Error('Synthetic receipt write refusal') })
  let closes = 0
  const resume = desk.runtime.resumeSession.bind(desk.runtime)
  desk.runtime.resumeSession = async (...args: Parameters<typeof resume>) => {
    const live = await resume(...args)
    live.close = async () => {
      closes += 1
      desk.runtime.sessions.delete(session.id)
      desk.runtime.emit({ type: 'session/closed', sessionId: session.id })
    }
    return live
  }
  await assert.rejects(desk.client.call('session/resume', params), /Synthetic receipt write refusal/)
  assert.equal(closes, 1)
  const failed = desk.harness.host.registry.get(session.runtime, session.id)
  const pendingTurns = undoFirst ? structuredClone(failed?.session.turns ?? []) : []
  if (undoFirst) {
    assert.ok(pendingTurns.length > 0, 'the failed close retained observed activity before retry')
    assert.equal(failed?.live, null, 'the admitted entry never holds the closed handle')
    assert.equal(failed?.attachmentSeat, seat)
  } else {
    assert.equal(failed, undefined)
    assert.ok(!desk.harness.host.syncPayload().params.sessions.some(one => one.id === session.id))
    assert.ok(!(await desk.harness.host.call('session/index', {})).data.some(one => one.id === session.id))
  }
  assert.equal(desk.runtime.sessions.has(session.id), false)
  assert.equal((await plane.read(seat))?.epoch, 0)
  fail.mock.mockImplementation(record)
  await desk.client.call('session/resume', params)
  if (undoFirst) {
    const current = desk.harness.host.registry.get(session.runtime, session.id)!.session.turns
    for (const turn of pendingTurns) assert.deepEqual(current.find(candidate => candidate.id === turn.id)?.items, turn.items)
  }
  assert.equal((await recordOf(desk, session)).epoch, 1)
  assert.equal(closes, 1, 'successful admission does not close the resumed handle')
})

test('a stale failed receipt settles before a newer owner can reopen', async t => {
  const { desk, session, params } = await seated(t)
  await desk.client.call('session/remove', { ...params, removed: true })
  await desk.client.call('session/remove', { ...params, removed: false })
  const plane = desk.harness.host.attachmentsPlane, record = plane.record.bind(plane)
  let entered!: () => void, release!: () => void, finished!: () => void, calls = 0
  const began = new Promise<void>(resolve => { entered = resolve }), gate = new Promise<void>(resolve => { release = resolve }), done = new Promise<void>(resolve => { finished = resolve })
  t.mock.method(plane, 'record', async (...args: Parameters<typeof record>) => {
    calls++
    if (calls === 1) { entered(); await gate; finished(); throw new Error('late receipt refusal') }
    return record(...args)
  })
  let closes = 0
  const resume = desk.runtime.resumeSession.bind(desk.runtime)
  desk.runtime.resumeSession = async (...args: Parameters<typeof resume>) => {
    const live = await resume(...args)
    const close = live.close.bind(live)
    live.close = async () => { closes++; await close() }
    return live
  }
  const first = desk.harness.host.call('session/resume', params)
  const outcome = first.catch(() => null)
  try {
    await began
    desk.harness.host.registry.detachAll(session.runtime, session.id)
    desk.runtime.dieResumeOwner(session.id)
    await assert.rejects(desk.harness.host.call('session/resume', params), /earlier open|notRunning/)
    desk.runtime.sessions.delete(session.id)
    release(); await done; await outcome
    await new Promise(resolve => setImmediate(resolve))
    await desk.harness.host.call('session/resume', params)
    const current = desk.harness.host.registry.get(session.runtime, session.id)?.live
    assert.ok(current)
    assert.equal(closes, 0, 'old failure cannot close a newer holder')
  } finally { release(); await outcome }
})

test('a caller arriving after early attachment waits for one shared receipt publication', async t => {
  const { desk, session, params } = await seated(t)
  await desk.client.call('session/remove', { ...params, removed: true })
  await desk.client.call('session/remove', { ...params, removed: false })
  const plane = desk.harness.host.attachmentsPlane, record = plane.record.bind(plane)
  let entered!: () => void, release!: () => void, calls = 0
  const began = new Promise<void>(resolve => { entered = resolve }), gate = new Promise<void>(resolve => { release = resolve })
  t.mock.method(plane, 'record', async (...args: Parameters<typeof record>) => { calls++; entered(); await gate; return record(...args) })
  const first = desk.harness.host.call('session/resume', params)
  await began
  assert.ok(desk.harness.host.registry.get(session.runtime, session.id)?.live, 'Host has attached the handle before receipt completion')
  let done = false
  const second = desk.harness.host.call('session/settings', { ...params, patch: {} }).then(value => { done = true; return value })
  try {
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(done, false)
    assert.equal(desk.harness.host.registry.opens(session.runtime, session.id).pending, 2)
  } finally { release() }
  await Promise.all([first, second])
  assert.equal(calls, 1)
})

test('a shared pending opener is not closed when receipt finalization fails', async t => {
  const { desk, session, params } = await seated(t)
  await desk.client.call('session/remove', { ...params, removed: true })
  await desk.client.call('session/remove', { ...params, removed: false })
  const plane = desk.harness.host.attachmentsPlane
  let entered!: () => void, release!: () => void, closes = 0
  const began = new Promise<void>(resolve => { entered = resolve }), gate = new Promise<void>(resolve => { release = resolve })
  t.mock.method(plane, 'record', async () => { entered(); await gate; throw new Error('receipt refusal') })
  const resume = desk.runtime.resumeSession.bind(desk.runtime)
  desk.runtime.resumeSession = async (...args: Parameters<typeof resume>) => {
    const live = await resume(...args), close = live.close.bind(live)
    live.close = async () => { closes++; await close() }
    return live
  }
  const first = desk.harness.host.call('session/resume', params)
  const firstError = assert.rejects(first, /receipt refusal/)
  await began
  const second = desk.harness.host.call('session/settings', { ...params, patch: {} })
  const secondError = assert.rejects(second, /receipt refusal/)
  try {
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(desk.harness.host.registry.opens(session.runtime, session.id).pending, 2)
  } finally { release() }
  await Promise.all([firstError, secondError])
  assert.equal(closes, 0, 'a failed shared attempt cannot close a handle claimed by another caller')
})

test('a detached receipt writer cannot append an epoch after the await', async t => {
  const { desk, session, params, seat } = await seated(t)
  await desk.client.call('session/remove', { ...params, removed: true })
  await desk.client.call('session/remove', { ...params, removed: false })
  const plane = desk.harness.host.attachmentsPlane, record = plane.record.bind(plane)
  let entered!: () => void, release!: () => void, finished!: () => void
  const began = new Promise<void>(resolve => { entered = resolve }), gate = new Promise<void>(resolve => { release = resolve }), done = new Promise<void>(resolve => { finished = resolve })
  t.mock.method(plane, 'record', async (...args: Parameters<typeof record>) => {
    entered(); await gate
    try { return await record(...args) } finally { finished() }
  })
  const first = desk.harness.host.call('session/resume', params), outcome = first.catch(() => null)
  try {
    await began
    desk.harness.host.registry.detachAll(session.runtime, session.id)
    await outcome
  } finally { release(); await done }
  assert.equal((await plane.read(seat))?.epoch, 0, 'a stale opener must not append its receipt')
})

test('resuming an already live filtered Seat does not append another receipt', async t => {
  const { desk, session, params, seat } = await seated(t)
  await desk.client.call('session/remove', { ...params, removed: true })
  await desk.client.call('session/remove', { ...params, removed: false })
  await desk.client.call('session/resume', params)
  const live = desk.harness.host.registry.get(session.runtime, session.id)?.live
  assert.ok(live)
  assert.equal((await planeRead())?.epoch, 1)
  await desk.client.call('session/resume', params)
  assert.equal(desk.harness.host.registry.get(session.runtime, session.id)?.live, live)
  assert.equal((await planeRead())?.epoch, 1)
  function planeRead() { return desk.harness.host.attachmentsPlane.read(seat) }
})

test('receipt failure does not close a handle replaced before finalization', async t => {
  const { desk, session, params } = await seated(t)
  await desk.client.call('session/remove', { ...params, removed: true })
  await desk.client.call('session/remove', { ...params, removed: false })
  const plane = desk.harness.host.attachmentsPlane
  let entered!: () => void, release!: () => void, closes = 0
  const began = new Promise<void>(resolve => { entered = resolve }), gate = new Promise<void>(resolve => { release = resolve })
  t.mock.method(plane, 'record', async () => { entered(); await gate; throw new Error('receipt refusal') })
  const resume = desk.runtime.resumeSession.bind(desk.runtime)
  desk.runtime.resumeSession = async (...args: Parameters<typeof resume>) => {
    const live = await resume(...args), close = live.close.bind(live)
    live.close = async () => { closes++; await close() }
    return live
  }
  const opening = desk.harness.host.call('session/resume', params), rejected = assert.rejects(opening, /receipt refusal/)
  try {
    await began
    const record = desk.harness.host.registry.get(session.runtime, session.id)!, old = record.live!
    const replacement = Object.create(old) as typeof old
    record.live = replacement
    release(); await rejected
    assert.equal(record.live, replacement)
    assert.equal(closes, 0, 'a handle the registry no longer owns cannot be closed by the old finalizer')
  } finally { release(); await rejected }
})

test('receipt failure preserves the same handle independently admitted while reopening', async t => {
  const { desk, session, params } = await seated(t)
  await desk.client.call('session/remove', { ...params, removed: true })
  await desk.client.call('session/remove', { ...params, removed: false })
  const plane = desk.harness.host.attachmentsPlane
  let entered!: () => void, release!: () => void, closes = 0
  const began = new Promise<void>(resolve => { entered = resolve }), gate = new Promise<void>(resolve => { release = resolve })
  t.mock.method(plane, 'record', async () => { entered(); await gate; throw new Error('receipt refusal') })
  const resume = desk.runtime.resumeSession.bind(desk.runtime)
  desk.runtime.resumeSession = async (...args: Parameters<typeof resume>) => {
    const live = await resume(...args), close = live.close.bind(live)
    live.close = async () => { closes++; await close() }
    return live
  }
  const opening = desk.harness.host.call('session/resume', params)
  const rejected = assert.rejects(opening, /receipt refusal/)
  try {
    await began
    const independent = desk.harness.host.registry.get(session.runtime, session.id)?.live
    assert.ok(independent)
    // Model an independent Host admission that has already completed by the time receipt fails.
    const releaseIndependent = desk.harness.host.registry.opening(session.runtime, session.id)
    releaseIndependent()
    release()
    await rejected
    assert.equal(closes, 0, 'the same object can have an independent holder')
    assert.equal(desk.runtime.sessions.get(session.id), independent)
  } finally { release(); await rejected }
})

test('receipt failure preserves a handle when the adapter cannot attest ownership', async t => {
  const { desk, session, params } = await seated(t)
  await desk.client.call('session/remove', { ...params, removed: true })
  await desk.client.call('session/remove', { ...params, removed: false })
  const failure = t.mock.method(desk.harness.host.attachmentsPlane, 'record', async () => { throw new Error('receipt refusal') })
  let closes = 0
  const resume = desk.runtime.resumeSession.bind(desk.runtime)
  desk.runtime.resumeSession = async (...args: Parameters<typeof resume>) => {
    const live = await resume(...args), close = live.close.bind(live)
    live.close = async () => { closes++; await close() }
    return live
  }
  const begin = desk.runtime.beginResumeAttempt.bind(desk.runtime)
  desk.runtime.beginResumeAttempt = (...args: Parameters<typeof begin>) => {
    const attempt = begin(...args)
    return { result: attempt.result, retire: attempt.retire }
  }
  // The Host's exact-owner subscription is released only after its retirement
  // work has settled. Owner death itself is synchronous but does not await it.
  let retirementSettled!: () => void
  const settled = new Promise<void>(resolve => { retirementSettled = resolve })
  const onDeath = desk.runtime.onResumeOwnerDied.bind(desk.runtime)
  t.mock.method(desk.runtime, 'onResumeOwnerDied', (listener: Parameters<typeof onDeath>[0]) => {
    const unsubscribe = onDeath(listener)
    return () => { unsubscribe(); retirementSettled() }
  })
  await assert.rejects(desk.harness.host.call('session/resume', params), /receipt refusal/)
  assert.equal(closes, 0, 'unknown ownership does not authorize closing')
  assert.ok(desk.runtime.sessions.has(session.id))
  const held = desk.harness.host.registry.get(session.runtime, session.id)!
  const turn = held.session.turns.at(-1)!
  assert.ok(turn)
  desk.runtime.emit({ type: 'item/completed', sessionId: session.id, turnId: turn.id,
    item: { id: itemId('quarantined-output'), type: 'assistantMessage', text: 'quarantined old output' } })
  assert.ok(!JSON.stringify(held.session).includes('quarantined old output'), 'withheld output never reaches the Host transcript')
  const apply = t.mock.method(desk.harness.host.registry, 'apply')
  desk.runtime.emit({ type: 'session/closed', sessionId: session.id })
  assert.ok(apply.mock.calls.some(call => call.arguments[1].type === 'session/closed'), 'close events remain observable')
  await new Promise(resolve => setImmediate(resolve))
  await new Promise(resolve => setImmediate(resolve))
  const resumes = desk.runtime.resumes
  await assert.rejects(desk.harness.host.call('session/resume', params), /earlier open/)
  assert.equal(desk.runtime.resumes, resumes, 'unknown ownership remains quarantined until owner death')
  desk.runtime.sessions.delete(session.id) // the fake owner's process has died
  desk.runtime.dieResumeOwner(session.id)
  await settled
  failure.mock.restore()
  await desk.harness.host.call('session/resume', params)
  assert.equal(desk.runtime.resumes, resumes + 1, 'a new generation can reopen after proven death')
  desk.runtime.emit({ type: 'item/completed', sessionId: session.id, turnId: turn.id, item: { id: itemId('new-owner-output'), type: 'assistantMessage', text: 'new owner output' } })
  assert.ok(JSON.stringify(desk.harness.host.registry.get(session.runtime, session.id)?.session).includes('new owner output'), 'new owner events are accepted')
})

test('closing a conversation during receipt finalization revokes the pending reopen', async t => {
  const { desk, session, params, seat } = await seated(t)
  await desk.client.call('session/remove', { ...params, removed: true })
  await desk.client.call('session/remove', { ...params, removed: false })
  const plane = desk.harness.host.attachmentsPlane, record = plane.record.bind(plane)
  let entered!: () => void, release!: () => void
  const began = new Promise<void>(resolve => { entered = resolve }), gate = new Promise<void>(resolve => { release = resolve })
  t.mock.method(plane, 'record', async (...args: Parameters<typeof record>) => { entered(); await gate; return record(...args) })
  const opening = desk.harness.host.call('session/resume', params)
  const outcome = opening.then(() => 'resolved', () => 'rejected')
  try {
    await began
    await desk.harness.host.call('session/close', params)
    release()
    assert.equal(await outcome, 'rejected')
    assert.equal((await plane.read(seat))?.epoch, 0)
    assert.equal(desk.harness.host.registry.get(session.runtime, session.id)?.live, null)
  } finally { release(); await outcome }
})

test('a runtime close event during receipt finalization revokes the pending reopen', async t => {
  const { desk, session, params, seat } = await seated(t)
  await desk.client.call('session/remove', { ...params, removed: true })
  await desk.client.call('session/remove', { ...params, removed: false })
  const plane = desk.harness.host.attachmentsPlane, record = plane.record.bind(plane)
  let entered!: () => void, release!: () => void
  const began = new Promise<void>(resolve => { entered = resolve }), gate = new Promise<void>(resolve => { release = resolve })
  t.mock.method(plane, 'record', async (...args: Parameters<typeof record>) => { entered(); await gate; return record(...args) })
  const opening = desk.harness.host.call('session/resume', params)
  const outcome = opening.then(() => 'resolved', () => 'rejected')
  try {
    await began
    desk.runtime.emit({ type: 'session/closed', sessionId: session.id })
    release()
    assert.equal(await outcome, 'rejected')
    assert.equal((await plane.read(seat))?.epoch, 0)
  } finally { release(); await outcome }
})

test('a runtime close while owned cleanup is pending revokes the opener without waiting for cleanup', async t => {
  const { desk, session, params } = await seated(t)
  await desk.client.call('session/remove', { ...params, removed: true })
  await desk.client.call('session/remove', { ...params, removed: false })
  t.mock.method(desk.harness.host.attachmentsPlane, 'record', async () => { throw new Error('receipt refusal') })
  let entered!: () => void, release!: () => void
  const began = new Promise<void>(resolve => { entered = resolve }), gate = new Promise<void>(resolve => { release = resolve })
  const resume = desk.runtime.resumeSession.bind(desk.runtime)
  desk.runtime.resumeSession = async (...args: Parameters<typeof resume>) => {
    const live = await resume(...args), close = live.close.bind(live)
    live.close = async () => { entered(); await gate; await close() }
    return live
  }
  const opening = desk.harness.host.call('session/resume', params)
  const rejected = assert.rejects(opening, /receipt refusal/)
  try {
    await began
    desk.runtime.emit({ type: 'session/closed', sessionId: session.id })
    await rejected
  } finally { release(); await rejected }
})

test('a dead resume owner cannot let a successor overtake pending Host worktree preparation', async t => {
  const { desk, session, params } = await seated(t)
  await desk.client.call('session/remove', { ...params, removed: true })
  await desk.client.call('session/remove', { ...params, removed: false })
  const { SessionWorktrees } = await import('../src/session-worktrees.js')
  const original = SessionWorktrees.prototype.prepare
  let entered!: () => void, release!: () => void, finished!: () => void, calls = 0
  const began = new Promise<void>(resolve => { entered = resolve }), gate = new Promise<void>(resolve => { release = resolve }), drained = new Promise<void>(resolve => { finished = resolve })
  t.mock.method(SessionWorktrees.prototype, 'prepare', async function (this: InstanceType<typeof SessionWorktrees>, ...args: Parameters<typeof original>) {
    if (++calls === 3) { entered(); await gate; try { return await original.apply(this, args) } finally { finished() } }
    return original.apply(this, args)
  })
  const first = desk.harness.host.call('session/resume', params)
  const outcome = first.then(() => 'resolved', () => 'rejected')
  try {
    await began
    desk.harness.host.registry.detachAll(session.runtime, session.id)
    desk.runtime.dieResumeOwner(session.id)
    assert.equal(await outcome, 'rejected')
    desk.runtime.sessions.delete(session.id)
    const before = desk.runtime.resumes
    const successor = desk.harness.host.call('session/resume', params)
    const successorResult = successor.then(() => 'opened', () => 'refused')
    await new Promise(resolve => setTimeout(resolve, 200))
    assert.equal(calls, 3, 'new owner must not enter Host preparation before old work settles')
    assert.equal(desk.runtime.resumes, before, 'new owner must not overtake pending Host preparation')
    release()
    await successorResult
    await drained
    await new Promise(resolve => setImmediate(resolve))
    const resumed = await desk.harness.host.call('session/resume', params) as Session
    assert.equal(resumed.id, session.id, 'a fresh owner can open after Host work settles')
  } finally { release(); await outcome }
})

test('a dead owner cannot let a successor overtake pending reopen completion', async t => {
  const { desk, session, params } = await seated(t)
  await desk.client.call('session/remove', { ...params, removed: true })
  await desk.client.call('session/remove', { ...params, removed: false })
  const { SessionIndexRepos } = await import('../src/session-index-repos.js')
  const original = SessionIndexRepos.prototype.refreshMissing
  let entered!: () => void, release!: () => void, finished!: () => void, calls = 0
  const began = new Promise<void>(resolve => { entered = resolve }), gate = new Promise<void>(resolve => { release = resolve }), drained = new Promise<void>(resolve => { finished = resolve })
  t.mock.method(SessionIndexRepos.prototype, 'refreshMissing', async function (this: InstanceType<typeof SessionIndexRepos>, ...args: Parameters<typeof original>) {
    if (++calls === 1) { entered(); await gate; try { return await original.apply(this, args) } finally { finished() } }
    return original.apply(this, args)
  })
  const first = desk.harness.host.call('session/resume', params), outcome = first.then(() => 'resolved', () => 'rejected')
  try {
    await began
    desk.harness.host.registry.detachAll(session.runtime, session.id)
    desk.runtime.dieResumeOwner(session.id)
    assert.equal(await outcome, 'rejected')
    desk.runtime.sessions.delete(session.id)
    const before = desk.runtime.resumes
    const successor = desk.harness.host.call('session/resume', params).then(() => 'opened', () => 'refused')
    await new Promise(resolve => setTimeout(resolve, 200))
    assert.equal(desk.runtime.resumes, before, 'new owner must wait for old completion')
    release(); await successor; await drained
  } finally { release(); await outcome }
})

for (const receiptOutcome of ['resolve', 'reject'] as const) test(`an expired reopen cannot use a handle before or after its frozen receipt ${receiptOutcome}s`, async t => {
  const { desk, session, params } = await seated(t)
  await desk.client.call('session/remove', { ...params, removed: true })
  await desk.client.call('session/remove', { ...params, removed: false })
  let entered!: () => void, release!: () => void, finished!: () => void, expire: (() => void) | undefined
  const began = new Promise<void>(resolve => { entered = resolve }), gate = new Promise<void>(resolve => { release = resolve }), done = new Promise<void>(resolve => { finished = resolve })
  const record = desk.harness.host.attachmentsPlane.record.bind(desk.harness.host.attachmentsPlane)
  t.mock.method(desk.harness.host.attachmentsPlane, 'record', async (...args: Parameters<typeof record>) => {
    entered(); await gate; try {
      if (receiptOutcome === 'reject') throw new Error('late receipt refusal')
      return await record(...args)
    } finally { finished() }
  })
  let releases = 0, settled!: () => void
  const retirementSettled = new Promise<void>(resolve => { settled = resolve })
  const onDeath = desk.runtime.onResumeOwnerDied.bind(desk.runtime)
  t.mock.method(desk.runtime, 'onResumeOwnerDied', (listener: Parameters<typeof onDeath>[0]) => {
    const unsubscribe = onDeath(listener)
    return () => { unsubscribe(); if (++releases === 2) settled() }
  })
  const realTimeout = globalThis.setTimeout
  t.mock.method(globalThis, 'setTimeout', ((fn: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) => {
    if (ms === 120_000) expire = () => fn(...args)
    return realTimeout(fn, ms, ...args)
  }) as typeof setTimeout)
  const opening = desk.harness.host.call('session/resume', params), outcome = opening.then(() => 'resolved', () => 'rejected')
  try {
    await began
    assert.ok(expire, 'the real coordinator deadline is armed')
    expire()
    assert.equal(await outcome, 'rejected')
    const send = () => desk.harness.host.call('turn/send', { ...params, input: [{ type: 'text', text: 'must not send' }] })
    await assert.rejects(send(), /earlier open|notRunning/)
    await assert.rejects(desk.harness.host.call('session/options/set', { ...params, optionId: 'tone', value: 'cheerful' }), /earlier open|notRunning/)
    release(); await done; await retirementSettled
    await assert.rejects(send(), /earlier open|notRunning/)
    await assert.rejects(desk.harness.host.call('session/options/set', { ...params, optionId: 'tone', value: 'cheerful' }), /earlier open|notRunning/)
  } finally { release(); await outcome }
})

test('a finalized attachment receipt remains usable when later reopen completion expires', async t => {
  const { desk, params } = await seated(t)
  await desk.client.call('session/remove', { ...params, removed: true })
  await desk.client.call('session/remove', { ...params, removed: false })
  const { SessionIndexRepos } = await import('../src/session-index-repos.js')
  const original = SessionIndexRepos.prototype.refreshMissing
  let entered!: () => void, release!: () => void, expire: (() => void) | undefined
  const began = new Promise<void>(resolve => { entered = resolve }), gate = new Promise<void>(resolve => { release = resolve })
  t.mock.method(SessionIndexRepos.prototype, 'refreshMissing', async function (this: InstanceType<typeof SessionIndexRepos>, ...args: Parameters<typeof original>) {
    entered(); await gate; return original.apply(this, args)
  })
  const realTimeout = globalThis.setTimeout
  t.mock.method(globalThis, 'setTimeout', ((fn: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) => {
    if (ms === 120_000) expire = () => fn(...args)
    return realTimeout(fn, ms, ...args)
  }) as typeof setTimeout)
  const opening = desk.harness.host.call('session/resume', params), outcome = opening.then(() => 'resolved', () => 'rejected')
  try {
    await began
    assert.ok(expire)
    expire()
    assert.equal(await outcome, 'rejected')
    await desk.harness.host.call('session/options/set', { ...params, optionId: 'tone', value: 'cheerful' })
    await desk.harness.host.call('turn/send', { ...params, input: [{ type: 'text', text: 'valid finalized handle' }] })
  } finally { release(); await outcome }
})

test('an independently live handle remains usable when another open expires', async t => {
  const { desk, session, params } = await seated(t)
  const live = desk.harness.host.registry.get(session.runtime, session.id)?.live
  assert.ok(live)
  const { SessionIndexRepos } = await import('../src/session-index-repos.js')
  const original = SessionIndexRepos.prototype.refreshMissing
  let entered!: () => void, release!: () => void, expire: (() => void) | undefined
  const began = new Promise<void>(resolve => { entered = resolve }), gate = new Promise<void>(resolve => { release = resolve })
  t.mock.method(SessionIndexRepos.prototype, 'refreshMissing', async function (this: InstanceType<typeof SessionIndexRepos>, ...args: Parameters<typeof original>) {
    entered(); await gate; return original.apply(this, args)
  })
  const realTimeout = globalThis.setTimeout
  t.mock.method(globalThis, 'setTimeout', ((fn: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) => {
    if (ms === 120_000) expire = () => fn(...args)
    return realTimeout(fn, ms, ...args)
  }) as typeof setTimeout)
  const opening = desk.harness.host.call('session/resume', params), outcome = opening.then(() => 'resolved', () => 'rejected')
  try {
    await began
    assert.ok(expire); expire()
    assert.equal(await outcome, 'rejected')
    assert.equal(desk.harness.host.registry.get(session.runtime, session.id)?.live, live)
    await desk.harness.host.call('session/options/set', { ...params, optionId: 'tone', value: 'cheerful' })
    await desk.harness.host.call('turn/send', { ...params, input: [{ type: 'text', text: 'valid existing handle' }] })
  } finally { release(); await outcome }
})
