import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { SeatRecord } from '@harnessdesk/protocol'

import { Assignments, Serial, dispatchAfter, UNOBSERVED_LOADING_REFUSAL, type AssignmentPort } from '../src/goals/assignments.js'
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

test('loose session cannot inherit unobserved loading', async () => {
  // No port answer at all for `attachmentsObserved` (a host not yet wired
  // for phase 12) keeps today's behavior unchanged.
  const legacy = rig()
  const record = await legacy.service.assign('g1', 1, session)
  assert.equal(record.board, 'g1')

  // Wired, but this exact live session's loading was never observed.
  const unobserved = rig({ attachmentsObserved: async () => false })
  await assert.rejects(unobserved.service.assign('g1', 1, session), new RegExp(UNOBSERVED_LOADING_REFUSAL.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  assert.deepEqual(unobserved.writes, [], 'refused before commit — no Seat is written for an opaque native load set')

  // Observed and matching: the ordinary path still succeeds.
  const observed = rig({ attachmentsObserved: async () => true })
  const kept = await observed.service.assign('g1', 1, session)
  assert.equal(kept.board, 'g1')
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

// Added in phase 10 (Task 3): an existing empty Goal is reserved for one front-door run, in the Goal queue, at one revision.
test('two starts race for one empty Goal', async () => {
  const { GoalPlane } = await import('../src/goals/plane.js')
  const { GoalStore } = await import('../src/goals/store.js')
  const { migrateDesk } = await import('../src/goals/migration.js')
  const { GOAL_TAKEN } = await import('../src/goals/operations.js')
  const { tempDir } = await import('./scratch.js')
  const home = tempDir('hd-goal-reserve-')
  await migrateDesk(home, async () => {})
  const store = new GoalStore(home)
  await store.load()
  const empty = (id: string, over: Partial<ReturnType<typeof goal>> = {}) => store.save({
    version: 1, goal: goal(id, over), board: { nextIntent: 1, messaging: true, intents: [], channel: [] },
    citations: [], receipt: null, operation: null,
  }, null)
  await empty('g1')
  const seats: SeatRecord[] = []
  const forbidden = async (): Promise<never> => { throw new Error('A reservation seats nobody') }
  const plane = new GoalPlane(store, {
    seats: { all: () => seats, byId: (id) => seats.find((one) => one.id === id) ?? null },
    confine: async (input) => ({ root: input.root, cwd: input.cwd ?? input.root }),
    known: async () => null,
    claimable: () => false,
    opening: forbidden,
    board: (id) => {
      const document = store.read(id)
      return { ...document.board, id, name: document.goal.sentence, root: document.goal.root, updatedAt: document.goal.updatedAt, members: [] }
    },
    evidence: async (room) => ({ room, stamp: 1, checks: [], refused: [], unreadable: null, cards: [] }),
    evidenceIds: async () => [],
    flow: () => undefined,
    busy: () => false,
    waits: () => false,
    stranded: () => false,
    held: () => false,
    settledFor: async () => {},
    answer: async () => ({ answer: null, gaps: [] }),
    revision: async () => ({ head: null, dirty: null }),
    changed: () => {},
    activity: () => {},
    ready: () => ({ ok: true }),
    seatAgent: forbidden,
    openLegacySeat: forbidden,
    importOpening: forbidden,
    closeId: forbidden,
    claim: forbidden,
    releaseClaim: forbidden,
    refuseMail: forbidden,
    retainLane: forbidden,
    finish: forbidden,
    finishWrap: forbidden,
    wake: () => {},
  })
  const reserve = (run: string, revision = 0, id = 'g1', root = '/work/repo') =>
    plane.reserveEmptyFlowGoal({ goal: id, revision, run, operation: 'start', root })

  // Two starts previewed at the same revision, at once: exactly one wins.
  const results = await Promise.allSettled([reserve('run-a'), reserve('run-b')])
  assert.equal(results.filter((one) => one.status === 'fulfilled').length, 1)
  const lost = results.find((one) => one.status === 'rejected')
  assert.ok(lost?.status === 'rejected')
  const winner = results[0]!.status === 'fulfilled' ? 'run-a' : 'run-b'
  const reserved = store.read('g1')
  assert.deepEqual(reserved.flowReservation, { run: winner, operation: 'start' })
  assert.equal(reserved.goal.revision, 1)
  assert.deepEqual(reserved.board.intents, [], 'no card was added')
  assert.equal(seats.length, 0, 'no member was added')
  // A later start that read the reserved Goal's own revision is still refused: the Goal is taken.
  await assert.rejects(reserve('run-c', 1), new RegExp(GOAL_TAKEN.replace(/[.]/g, '\\.')))
  assert.deepEqual(store.read('g1').flowReservation, { run: winner, operation: 'start' })
  // The winner asking again after a lost answer is answered as done, and writes nothing.
  await reserve(winner, 0)
  assert.equal(store.read('g1').goal.revision, 1)
  // Work of any kind — a card, a Seat — or another project refuses before anything is written.
  await empty('g2', { root: '/work/repo', cwd: '/work/repo' })
  const withCard = store.read('g2')
  await store.save({ ...withCard, board: { ...withCard.board, nextIntent: 2, intents: [{ id: 1, title: 'x', state: 'open', files: [], dependsOn: [], claim: null, createdAt: 1, updatedAt: 1 }] }, goal: { ...withCard.goal, revision: 1 } }, 0)
  await assert.rejects(reserve('run-d', 1, 'g2'), new RegExp(GOAL_TAKEN.replace(/[.]/g, '\\.')))
  await empty('g3')
  seats.push(seat('member', { board: 'g3' }))
  await assert.rejects(reserve('run-e', 0, 'g3'), new RegExp(GOAL_TAKEN.replace(/[.]/g, '\\.')))
  await empty('g4')
  await assert.rejects(reserve('run-f', 0, 'g4', '/work/other'), /another project/)
  for (const id of ['g2', 'g3', 'g4']) assert.equal(store.read(id).flowReservation, undefined)
  // The reservation is on the Goal's view, so a window finds its run after a reload.
  assert.deepEqual((await plane.view('g1')).reservation, { run: winner })
  // Let go only by the run that holds it, in the Goal queue, advancing the revision: another run's release changes nothing.
  const other = winner === 'run-a' ? 'run-b' : 'run-a'
  await plane.releaseFlowReservation({ goal: 'g1', run: other, operation: 'start' })
  assert.deepEqual(store.read('g1').flowReservation, { run: winner, operation: 'start' })
  assert.equal(store.read('g1').goal.revision, 1)
  await plane.releaseFlowReservation({ goal: 'g1', run: winner, operation: 'start' })
  assert.equal(store.read('g1').flowReservation, undefined)
  assert.equal(store.read('g1').goal.revision, 2)
  assert.equal((await plane.view('g1')).reservation, undefined)
  // Empty and free again: a fresh start at the new revision reserves it.
  await reserve('run-g', 2)
  assert.deepEqual(store.read('g1').flowReservation, { run: 'run-g', operation: 'start' })
})
