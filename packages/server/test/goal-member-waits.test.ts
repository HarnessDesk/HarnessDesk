import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { SeatRecord } from '@harnessdesk/protocol'

import { MemberWaits, type MemberStatus } from '../src/goals/member-waits.js'
import { memberNames } from '../src/goals/members.js'
import { seat } from './fixtures/goals.js'

const namedSeat = (
  id: string,
  name: string | null,
  seatLabel: string,
  openedAt: number,
): SeatRecord => seat(id, {
  agent: name === null ? null : { id: `agent-${id}`, name, origin: 'project' },
  seatLabel,
  openedAt,
})

test('member names are stable, deterministic and collision-free without changing history', () => {
  const seats = [
    namedSeat('later', 'Builder', 'Fast', 2),
    namedSeat('first', 'Builder', 'Fast', 1),
    namedSeat('literal', 'Builder · Fast 2', 'Careful', 3),
    namedSeat('legacy', null, 'Plain', 4),
  ]
  const historical = { from: 'Builder', text: 'already recorded' }
  const names = memberNames(seats, { legacy: 'Imported' })

  assert.deepEqual([...names], [
    ['first', 'Builder · Fast'],
    ['later', 'Builder · Fast 2'],
    ['literal', 'Builder · Fast 2 2'],
    ['legacy', 'Imported'],
  ])
  assert.equal(new Set(names.values()).size, seats.length)
  assert.deepEqual(historical, { from: 'Builder', text: 'already recorded' })
})

test('same-label reviewer Seats are named by role and ordinal', () => {
  const names = memberNames([
    seat('reviewer-3', { seatLabel: 'Cursor · Gemini 3.8 Flash', role: 'reviewer', openedAt: 3 }),
    seat('reviewer-1', { seatLabel: 'Cursor · Gemini 3.8 Flash', role: 'reviewer', openedAt: 1 }),
    seat('reviewer-2', { seatLabel: 'Cursor · Gemini 3.8 Flash', role: 'reviewer', openedAt: 2 }),
  ])

  assert.deepEqual([...names], [
    ['reviewer-1', 'reviewer 1'],
    ['reviewer-2', 'reviewer 2'],
    ['reviewer-3', 'reviewer 3'],
  ])
})

test('same-label Seats without a role keep the label and use numeric suffixes', () => {
  const names = memberNames([
    seat('seat-2', { seatLabel: 'Cursor · Gemini 3.8 Flash', openedAt: 2 }),
    seat('seat-1', { seatLabel: 'Cursor · Gemini 3.8 Flash', openedAt: 1 }),
  ])

  assert.deepEqual([...names], [
    ['seat-1', 'Cursor · Gemini 3.8 Flash'],
    ['seat-2', 'Cursor · Gemini 3.8 Flash 2'],
  ])
})

test('same-label Seats number a role only when it repeats', () => {
  const names = memberNames([
    seat('reviewer-2', { seatLabel: 'Cursor · Gemini 3.8 Flash', role: 'reviewer', openedAt: 2 }),
    seat('fixer', { seatLabel: 'Cursor · Gemini 3.8 Flash', role: 'fixer', openedAt: 1 }),
    seat('reviewer-3', { seatLabel: 'Cursor · Gemini 3.8 Flash', role: 'reviewer', openedAt: 3 }),
    seat('reviewer-1', { seatLabel: 'Cursor · Gemini 3.8 Flash', role: 'reviewer', openedAt: 4 }),
  ])

  assert.deepEqual([...names], [
    ['fixer', 'fixer'],
    ['reviewer-2', 'reviewer 1'],
    ['reviewer-3', 'reviewer 2'],
    ['reviewer-1', 'reviewer 3'],
  ])
})

test('two same-label groups of one role number across the room, never both from 1', () => {
  const names = memberNames([
    seat('gemini-a', { seatLabel: 'Cursor · Gemini 3.8 Flash', role: 'reviewer', openedAt: 1 }),
    seat('codex-a', { seatLabel: 'Codex · GPT-5.6', role: 'reviewer', openedAt: 2 }),
    seat('gemini-b', { seatLabel: 'Cursor · Gemini 3.8 Flash', role: 'reviewer', openedAt: 3 }),
    seat('codex-b', { seatLabel: 'Codex · GPT-5.6', role: 'reviewer', openedAt: 4 }),
  ])

  assert.deepEqual([...names], [
    ['gemini-a', 'reviewer 1'],
    ['codex-a', 'reviewer 2'],
    ['gemini-b', 'reviewer 3'],
    ['codex-b', 'reviewer 4'],
  ])
})

test('Seats sharing an Agent name still include different seat labels', () => {
  const names = memberNames([
    namedSeat('opus', 'Reviewer', 'Cursor · Opus', 1),
    namedSeat('gemini', 'Reviewer', 'Cursor · Gemini', 2),
  ])

  assert.deepEqual([...names], [
    ['opus', 'Reviewer · Cursor · Opus'],
    ['gemini', 'Reviewer · Cursor · Gemini'],
  ])
})

test('a wait is owned by the turn captured at registration', async (t) => {
  let status: MemberStatus = { exists: true, turn: 't1', stopped: null }
  const waits = new MemberWaits(() => status)
  const controller = new AbortController()
  t.after(() => controller.abort())
  const answer = waits.wait('caller', 'member', 3, 50_000, controller.signal)
  status = { exists: true, turn: 't2', stopped: null }

  waits.ended('member', 't1', null)

  assert.equal(waits.size, 0)
  assert.equal(await answer, 'idle; cycle: 4')
})

test('a wait reads status once and uses one deadline without polling', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let reads = 0
  const waits = new MemberWaits(() => {
    reads++
    return { exists: true, turn: 't1', stopped: null }
  })
  let settled = false
  const answer = waits.wait('caller', 'member', 0, 1_000).then((value) => {
    settled = true
    return value
  })

  t.mock.timers.tick(999)
  await Promise.resolve()
  assert.equal(settled, false)
  assert.equal(reads, 1)
  assert.equal(waits.size, 1)
  t.mock.timers.tick(1)
  assert.equal(await answer, 'still working; cycle: 1')
  assert.equal(reads, 1)
  assert.equal(waits.size, 0)

  const defaultAnswer = waits.wait('caller', 'member')
  t.mock.timers.tick(49_999)
  assert.equal(waits.size, 1)
  t.mock.timers.tick(1)
  assert.equal(await defaultAnswer, 'still working; cycle: 1')
})

test('every terminal path settles once, clears its timer and keeps replies on one line', async () => {
  const status = new Map<string, MemberStatus>([
    ['running', { exists: true, turn: 't1', stopped: null }],
    ['stopped', { exists: true, turn: null, stopped: 'quota\nended' }],
  ])
  const waits = new MemberWaits((member) => status.get(member) ?? { exists: false, turn: null, stopped: null })

  assert.equal(await waits.wait('caller', 'missing', 0, 1_000), 'gone; cycle: 1')
  assert.equal(await waits.wait('caller', 'stopped', 1, 1_000), 'stopped: quota ended; cycle: 2')

  const failed = waits.wait('caller', 'running', 2, 50_000)
  waits.ended('running', 't1', 'failed\ncleanly')
  waits.ended('running', 't1', 'duplicate')
  assert.equal(await failed, 'stopped: failed cleanly; cycle: 3')

  const departed = waits.wait('caller', 'running', 0, 50_000)
  waits.gone('running')
  assert.equal(await departed, 'gone; cycle: 1')

  const callerGone = waits.wait('caller', 'running', 0, 50_000)
  waits.gone('caller')
  assert.equal(await callerGone, 'gone; cycle: 1')

  const cancelled = waits.wait('caller', 'running', 0, 50_000)
  waits.cancel('caller')
  assert.equal(await cancelled, 'stopped: the calling turn ended; cycle: 1')

  const wrapped = waits.wait('caller', 'running', 0, 50_000)
  waits.close('the Goal wrapped')
  assert.equal(await wrapped, 'stopped: the Goal wrapped; cycle: 1')

  const shutdown = waits.wait('caller', 'running', 0, 50_000)
  waits.close()
  assert.equal(await shutdown, 'stopped: the desk closed; cycle: 1')
  assert.equal(waits.size, 0)
})

test('validation, self-wait, capacity and an aborted invocation refuse without timers', async () => {
  const waits = new MemberWaits(() => ({ exists: true, turn: 't1', stopped: null }))
  await assert.rejects(waits.wait('caller', 'member', Number.MAX_SAFE_INTEGER), /nonnegative safe cycle/)
  await assert.rejects(waits.wait('caller', 'member', -1), /nonnegative safe cycle/)
  await assert.rejects(waits.wait('caller', 'member', 0, 999), /between 1000 and 50000/)
  await assert.rejects(waits.wait('caller', 'caller'), /Choose another member/)
  const controller = new AbortController()
  controller.abort()
  assert.equal(await waits.wait('caller', 'member', 4, 1_000, controller.signal), 'stopped: the calling turn ended; cycle: 5')

  const pending = Array.from({ length: 128 }, (_, index) => waits.wait(`caller-${index}`, 'member'))
  assert.equal(waits.size, 128)
  await assert.rejects(waits.wait('overflow', 'member'), /already has 128 member waits/)
  waits.close()
  await Promise.all(pending)
  assert.equal(waits.size, 0)
})
