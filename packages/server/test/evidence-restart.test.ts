import assert from 'node:assert/strict'
import { test } from 'node:test'

import { runtimeId, type SeatRecord, type Session } from '@harnessdesk/protocol'

import { evidenceDesk, writeAgent } from './fixtures/evidence-desk.js'

/*
 * The half of phase 4's "done" a restart proves: a closed conversation's Seat
 * record is still there after a restart, and the conversation still wears the
 * Agent it was seated as — the in-memory copy phases 1–3 kept is gone with the
 * process, and the durable one takes its place.
 */

test('after a restart, a closed conversation still has its Seat record, and still wears its Agent', async (t) => {
  const first = await evidenceDesk(t)
  await writeAgent(first.stateDir)
  const session = (await first.host.call('agent/seat', { id: 'scout', cwd: first.repo.dir })) as Session
  const before = (await first.host.call('evidence/seat', { runtime: 'fake', sessionId: String(session.id) })) as SeatRecord
  // Closing a pane is window management: the Seat is not closed by it.
  await first.host.call('session/close', { runtime: runtimeId('fake'), sessionId: session.id })
  await first.stop()

  const second = await evidenceDesk(t, {}, { stateDir: first.stateDir, repo: first.repo })
  const after = (await second.host.call('evidence/seat', { runtime: 'fake', sessionId: String(session.id) })) as SeatRecord
  assert.deepEqual(after, before, 'the record, whole, as it was written')

  const reopened = (await second.host.call('session/resume', { runtime: runtimeId('fake'), sessionId: session.id })) as Session
  assert.equal(reopened.settings?.agent, 'scout')
  assert.equal(reopened.settings?.briefDigest, before.briefDigest)
  assert.equal(reopened.settings?.permission, 'read')
  assert.equal(reopened.settings?.seatLabel, before.seatLabel)
})

test('a deleted conversation’s Seat record is still there after a restart, and says how it closed', async (t) => {
  const first = await evidenceDesk(t)
  await writeAgent(first.stateDir)
  const session = (await first.host.call('agent/seat', { id: 'scout', cwd: first.repo.dir })) as Session
  await first.host.call('session/delete', { runtime: runtimeId('fake'), sessionId: session.id })
  const before = (await first.host.call('evidence/seat', { runtime: 'fake', sessionId: String(session.id) })) as SeatRecord
  assert.equal(before.closed?.why, 'deleted')
  await first.stop()

  const second = await evidenceDesk(t, {}, { stateDir: first.stateDir, repo: first.repo })
  assert.deepEqual(await second.host.call('evidence/seat', { runtime: 'fake', sessionId: String(session.id) }), before)
})

test('a conversation never seated is restored as a plain one', async (t) => {
  const { host } = await evidenceDesk(t)
  await host.call('session/resume', { runtime: runtimeId('fake'), sessionId: 'never-seated' as never })
  const held = host.registry.get(runtimeId('fake'), 'never-seated' as never)
  assert.equal(held?.seatedAs, null)
  assert.equal(held?.session.settings?.agent, undefined)
})
