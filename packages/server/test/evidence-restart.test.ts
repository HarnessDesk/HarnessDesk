import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'

import { runtimeId, type SeatRecord, type Session } from '@harnessdesk/protocol'

import { evidenceDesk, writeAgent } from './fixtures/evidence-desk.js'
import { EvidencePlane } from '../src/evidence/plane.js'
import { tempDir } from './scratch.js'

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
  assert.deepEqual(reopened.settings?.ceiling, { level: 'edit', hold: 'asked' })
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

test('a ceiling-only Agent survives restart in its own words', async (t) => {
  const first = await evidenceDesk(t)
  await mkdir(join(first.stateDir, 'agents', 'reader'), { recursive: true })
  await writeFile(join(first.stateDir, 'agents', 'reader', 'AGENT.md'), '---\nname: Reader\nceiling: read\nprefer: [fake]\n---\nRead only.\n', 'utf8')
  const session = (await first.host.call('agent/seat', { id: 'reader', cwd: first.repo.dir })) as Session
  const before = (await first.host.call('evidence/seat', { runtime: 'fake', sessionId: String(session.id) })) as SeatRecord
  assert.deepEqual(before.standing, { kind: 'ceiling', level: 'read' })
  assert.deepEqual(before.ceiling, { level: 'read', hold: 'asked' })
  await first.host.call('session/close', { runtime: runtimeId('fake'), sessionId: session.id })
  await first.stop()
  const second = await evidenceDesk(t, {}, { stateDir: first.stateDir, repo: first.repo })
  const reopened = (await second.host.call('session/resume', { runtime: runtimeId('fake'), sessionId: session.id })) as Session
  assert.equal(reopened.settings?.agent, 'reader')
  assert.deepEqual(reopened.settings?.ceiling, { level: 'read', hold: 'asked' })
})

test('historical null ceilings stay unknown, stored holds are exact, and imported or flow records restore no Agent', async () => {
  const dir = tempDir('hd-evidence-restore-')
  const plane = new EvidencePlane(
    { dir, seenFile: join(dir, 'seen.json') },
    { board: () => null, cwdOf: () => null, push: () => {}, log: () => {} },
  )
  const project = '/work/repo'
  const opening = (id: string, ceiling: SeatRecord['ceiling'], over: Partial<SeatRecord> = {}) => ({
    type: 'seat' as const,
    record: {
      id,
      agent: { id: 'reader', name: 'Reader', origin: 'user' as const },
      briefDigest: 'digest',
      seat: { runtime: 'fake' },
      seatLabel: 'Fake Runtime',
      passedOver: [],
      standing: { kind: 'ceiling' as const, level: 'read' as const },
      ceiling,
      checkout: { cwd: project, project, branch: 'main', head: null },
      session: { runtime: 'fake', sessionId: id },
      board: null,
      role: null,
      openedAt: 1,
      ...over,
    },
  })
  await plane.store.append(project, 'seats', [
    opening('null', null),
    opening('held', { level: 'read', hold: 'held' }),
    opening('asked', { level: 'publish', hold: 'asked' }),
    opening('imported', { level: 'merge', hold: 'held' }, { restored: { at: 2 } }),
    opening('flow', { level: 'edit', hold: 'asked' }, { agent: null, briefDigest: null, standing: { kind: 'permission', permission: 'read' }, board: 'room', role: 'worker' }),
  ])
  await plane.load()
  assert.deepEqual(plane.seatedAs('fake', 'null')?.ceiling, null)
  assert.deepEqual(plane.seatedAs('fake', 'null')?.standing, { kind: 'ceiling', level: 'read' })
  const held = plane.seatedAs('fake', 'held')
  const asked = plane.seatedAs('fake', 'asked')
  assert.deepEqual({ ceiling: held?.ceiling, ceilingNote: held?.ceilingNote }, expectCeiling('read', 'held'))
  assert.deepEqual({ ceiling: asked?.ceiling, ceilingNote: asked?.ceilingNote }, expectCeiling('publish', 'asked'))
  assert.equal(plane.seatedAs('fake', 'imported'), null)
  assert.equal(plane.seatedAs('fake', 'flow'), null)
})

const expectCeiling = (level: 'read' | 'publish', hold: 'held' | 'asked') => ({
  ceiling: { level, hold },
  ceilingNote: null,
})
