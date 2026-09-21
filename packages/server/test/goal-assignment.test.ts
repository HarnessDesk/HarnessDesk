import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { SeatRecord } from '@harnessdesk/protocol'

import { Assignments, Serial, dispatchAfter, type AssignmentPort } from '../src/goals/assignments.js'
import { goal, seat } from './fixtures/goals.js'

const session = { runtime: 'fake', sessionId: 'one' }

const rig = (over: Partial<AssignmentPort> = {}) => {
  const kept: SeatRecord[] = []
  const writes: string[] = []
  const port: AssignmentPort = {
    goal: (id) => goal(id),
    seats: () => kept,
    known: async () => ({ project: '/work/repo', busy: false }),
    claimable: () => true,
    commit: async (id, card, pointer) => {
      await Promise.resolve()
      const record = seat(`kept-${kept.length}`, { board: id, session: pointer })
      kept.push(record)
      writes.push(`${id}:${card}`)
      return record
    },
    ...over,
  }
  return { kept, writes, port, service: new Assignments(port) }
}

test('concurrent assignments of one conversation keep exactly one Goal Seat', async () => {
  const { kept, writes, service } = rig()
  const results = await Promise.allSettled(['g1', 'g2'].map((id) => service.assign(id, 1, session)))
  assert.equal(results.filter((one) => one.status === 'fulfilled').length, 1)
  assert.equal(kept.length, 1)
  assert.deepEqual(writes, ['g1:1'])
  const failure = results.find((one) => one.status === 'rejected')
  assert.ok(failure?.status === 'rejected')
  assert.match(String(failure.reason), /already holds a Seat/)
})

test('separate service instances share the desk queue', async () => {
  const { port, kept } = rig()
  const serial = new Serial()
  const left = new Assignments(port, serial)
  const right = new Assignments(port, serial)
  const results = await Promise.allSettled([left.assign('g1', 1, session), right.assign('g2', 1, session)])
  assert.equal(results.filter((one) => one.status === 'fulfilled').length, 1)
  assert.equal(kept.length, 1)
})

test('wrapped and wrapping Goals refuse before looking up or writing a conversation', async () => {
  for (const state of ['wrapped', 'wrapping'] as const) {
    let reads = 0
    const { service, writes } = rig({
      goal: () => goal('g1', { state }),
      known: async () => { reads++; return { project: '/work/repo', busy: false } },
    })
    await assert.rejects(service.assign('g1', 1, session), /closing or wrapped/)
    assert.equal(reads, 0)
    assert.deepEqual(writes, [])
  }
})

test('missing runtime history and a foreign project refuse before a Seat is written', async () => {
  for (const known of [null, { project: '/work/elsewhere', busy: false }]) {
    const { service, writes } = rig({ known: async () => known })
    await assert.rejects(service.assign('g1', 1, session), /runtime can still open/)
    assert.deepEqual(writes, [])
  }
})

test('a busy conversation and a role, dependency or file conflict refuse before commit', async () => {
  const busy = rig({ known: async () => ({ project: '/work/repo', busy: true }) })
  await assert.rejects(busy.service.assign('g1', 1, session), /finish its turn/)
  assert.deepEqual(busy.writes, [])
  const conflicted = rig({ claimable: () => false })
  await assert.rejects(conflicted.service.assign('g1', 1, session), /dependency, role or file conflict/)
  assert.deepEqual(conflicted.writes, [])
})

test('restored, closed and standalone Seats are history, not competing Goal membership', async () => {
  const { service, kept } = rig()
  kept.push(seat('restored', { session, restored: { at: 2 } }))
  kept.push(seat('closed', { session, closed: { at: 2, why: 'released' } }))
  kept.push(seat('standalone', { session, board: null }))
  const result = await service.assign('g2', 2, session)
  assert.equal(result.board, 'g2')
  assert.equal(kept.filter((one) => one.board === 'g2').length, 1)
})

test('an invalid card refuses and a failed operation does not poison the serial queue', async () => {
  const { service, writes } = rig()
  await assert.rejects(service.assign('g1', 0, session), /existing card/)
  assert.deepEqual(writes, [])
  const record = await service.assign('g1', 1, session)
  assert.equal(record.board, 'g1')
})

test('dispatch rechecks authority after asynchronous preparation', async () => {
  let allowed = true
  let dispatched = false
  await assert.rejects(dispatchAfter(
    () => allowed ? { ok: true } : { ok: false, reason: 'membership changed' },
    async () => { allowed = false; return 'ready' },
    async () => { dispatched = true },
  ), /membership changed/)
  assert.equal(dispatched, false)
})

test('an initial dispatch refusal performs no preparation or effect', async () => {
  let prepared = false
  let dispatched = false
  await assert.rejects(dispatchAfter(
    () => ({ ok: false, reason: 'dependency waits' }),
    async () => { prepared = true; return 'ready' },
    async () => { dispatched = true },
  ), /dependency waits/)
  assert.deepEqual([prepared, dispatched], [false, false])
})
