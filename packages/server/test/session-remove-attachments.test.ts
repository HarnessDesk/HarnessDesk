import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Session } from '@harnessdesk/protocol'

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
  if (undoFirst) {
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
  assert.equal((await recordOf(desk, session)).epoch, 1)
  assert.equal(closes, 1, 'successful admission does not close the resumed handle')
})
