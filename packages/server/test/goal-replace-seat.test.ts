import assert from 'node:assert/strict'
import { test } from 'node:test'

import { runtimeId, type BoardEvidence, type SeatRecord } from '@harnessdesk/protocol'

import { GoalPlane, SeatMovedError, type GoalPlanePort } from '../src/goals/plane.js'
import { migrateDesk } from '../src/goals/migration.js'
import { GoalStore } from '../src/goals/store.js'
import { goal, intent, seat } from './fixtures/goals.js'
import { tempDir } from './scratch.js'

/*
 * Carry-on's Seat replacement on the Goal plane (§9.2): a failure closing the
 * old Seat comes after the card already passed to the new one, so it is not
 * reported as a refusal the caller rolls back by closing the new Seat — the
 * replacement keeps the work, and the run finishes the move from where it went.
 */

const session = { runtime: 'fake', sessionId: 's1' }
const unused = async (): Promise<never> => { throw new Error('not needed for a replacement') }

const rig = async (closeId: GoalPlanePort['closeId']) => {
  const home = tempDir('hd-goal-replace-seat-')
  await migrateDesk(home, async () => {})
  const store = new GoalStore(home)
  await store.load()
  await store.save({
    version: 1, goal: goal('g1'),
    board: { nextIntent: 2, messaging: true, intents: [intent(1, { state: 'claimed', claim: { runtime: runtimeId(session.runtime), sessionId: session.sessionId, at: 1, head: null, upstream: null } })], channel: [] },
    citations: [], receipt: null, operation: null,
  }, null)
  const seats: SeatRecord[] = [seat('s1', { session, board: 'g1' })]
  const facts: BoardEvidence = { room: 'g1', stamp: 1, checks: [], refused: [], unreadable: null, cards: [] }
  const moved: string[] = []
  const port: GoalPlanePort = {
    seats: { all: () => seats, byId: (id) => seats.find((one) => one.id === id) ?? null },
    confine: async (input) => ({ root: input.root, cwd: input.cwd ?? input.root }),
    known: async () => ({ project: '/work/repo', busy: false }),
    claimable: () => true,
    sessionCwd: () => '/work/repo',
    opening: unused,
    board: (id) => {
      const document = store.read(id)
      return { ...document.board, id, name: document.goal.sentence, root: document.goal.root, updatedAt: document.goal.updatedAt, members: [] }
    },
    evidence: async () => facts,
    evidenceIds: async () => [],
    flow: () => undefined,
    busy: () => false,
    waits: () => false,
    stranded: () => false,
    held: () => false,
    settledFor: async () => {},
    answer: async () => ({ answer: null, gaps: [] }),
    revision: async () => ({ head: 'deadbeef', dirty: false }),
    changed: () => {},
    activity: () => {},
    ready: () => ({ ok: true }),
    seatAgent: unused,
    openLegacySeat: unused,
    importOpening: unused,
    closeId,
    claim: unused,
    moveClaim: async (_goal, card, from, to) => { moved.push(`#${card} ${from.id}->${to.id}`) },
    releaseClaim: unused,
    refuseMail: async () => {},
    retainLane: async () => {},
    finish: async () => {},
    finishWrap: unused,
    wake: () => {},
  }
  return { plane: new GoalPlane(store, port), seats, moved }
}

test('a failure closing the old Seat after the card moved says the move went through, naming the replacement', async () => {
  const proof = await rig(async (id) => { if (id === 's1') throw new Error('(disk full)') })
  const old = proof.seats[0]!
  const next = seat('s2', { session: { runtime: 'fake', sessionId: 's2' }, board: 'g1' })
  const error = await proof.plane.replaceSeat(old, 1, async () => { proof.seats.push(next); return next }).then(() => null, (thrown: unknown) => thrown)
  assert.ok(error instanceof SeatMovedError, String(error))
  assert.equal(error.record.id, next.id, 'the replacement is named, so the host keeps it')
  assert.deepEqual(proof.moved, ['#1 s1->s2'])
})

test('a failure before anything moved is still a plain refusal, and the new Seat is closed', async () => {
  const closed: string[] = []
  const proof = await rig(async (id) => { closed.push(id) })
  const old = proof.seats[0]!
  const elsewhere = seat('s2', { session: { runtime: 'fake', sessionId: 's2' }, board: 'g2' })
  const error = await proof.plane.replaceSeat(old, 1, async () => elsewhere).then(() => null, (thrown: unknown) => thrown)
  assert.ok(error instanceof Error && !(error instanceof SeatMovedError))
  assert.deepEqual(closed, [String(elsewhere.id)])
  assert.deepEqual(proof.moved, [])
})
