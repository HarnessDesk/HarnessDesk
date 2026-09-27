import assert from 'node:assert/strict'
import { test } from 'node:test'

import { runtimeId, type BoardEvidence, type SeatRecord } from '@harnessdesk/protocol'

import { GoalPlane, type GoalPlanePort } from '../src/goals/plane.js'
import { migrateDesk } from '../src/goals/migration.js'
import { GoalStore } from '../src/goals/store.js'
import { goal, intent, seat } from './fixtures/goals.js'
import { tempDir } from './scratch.js'

/*
 * Review round 2 on #1042: `GoalPlane.release` reads where a Seat's checkout
 * stands before staging ever closes it, bounded by the same 10s timeout
 * every other stop capture uses (`STOP_HEAD_TIMEOUT_MS`). A checkout that
 * never answers must still let the release through, recording nothing —
 * never hang the Goal queue waiting on it. This is the one case that needs a
 * controllable, deterministic clock rather than a real checkout: the
 * real-Host test in `goal-host.test.ts` covers a real, answering one.
 */

const session = { runtime: 'fake', sessionId: 's1' }

/** A minimal `GoalPlanePort` sufficient to run `release()` and `view()` end to end, with one already-claimed card. */
const rig = async (revision: GoalPlanePort['revision'], sessionCwd: GoalPlanePort['sessionCwd']) => {
  const home = tempDir('hd-goal-release-stop-')
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
  const closed: string[] = []
  const released: string[] = []
  const port: GoalPlanePort = {
    seats: { all: () => seats, byId: (id) => seats.find((one) => one.id === id) ?? null },
    confine: async (input) => ({ root: input.root, cwd: input.cwd ?? input.root }),
    known: async () => ({ project: '/work/repo', busy: false }),
    claimable: () => true,
    sessionCwd,
    opening: async () => { throw new Error('not needed for release') },
    board: (id) => {
      const document = store.read(id)
      return { ...document.board, id, name: document.goal.sentence, root: document.goal.root,
        updatedAt: document.goal.updatedAt, members: [] }
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
    revision,
    changed: () => {},
    activity: () => {},
    ready: () => ({ ok: true }),
    seatAgent: async () => { throw new Error('not needed for release') },
    openLegacySeat: async () => { throw new Error('not needed for release') },
    importOpening: async () => { throw new Error('not needed for release') },
    closeId: async (id) => { closed.push(id) },
    claim: async () => { throw new Error('not needed for release') },
    releaseClaim: async (goalId, seatId, until) => {
      released.push(seatId)
      const document = store.read(goalId)
      const next = document.board.intents.map((one) => one.id === 1
        ? { ...one, state: 'open' as const, claim: null, ...(until ? { until } : {}) }
        : one)
      await store.save({ ...document, board: { ...document.board, intents: next },
        goal: { ...document.goal, revision: document.goal.revision + 1 } }, document.goal.revision)
    },
    refuseMail: async () => {},
    retainLane: async () => {},
    finish: async () => {},
    finishWrap: async () => { throw new Error('not needed for release') },
    wake: () => {},
  }
  return { store, plane: new GoalPlane(store, port), closed, released }
}

test('a slow checkout still lets the release finish within the timeout, recording nothing', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const proof = await rig(() => new Promise(() => {}), () => '/work/repo')
  const releasing = proof.plane.release('g1', 's1')
  // `release` runs behind its own serial queue, one microtask away: let it
  // start and register its stop-read timer before the clock is moved.
  await Promise.resolve()
  // Deterministic: the mocked clock ticked exactly to the stop-read deadline
  // (10s, `STOP_HEAD_TIMEOUT_MS`), never a real 10s wait a CI box might miss.
  t.mock.timers.tick(10_000)
  await releasing
  assert.deepEqual(proof.closed, ['s1'])
  assert.deepEqual(proof.released, ['s1'])
  const card = proof.store.read('g1').board.intents.find((one) => one.id === 1)
  assert.equal(card?.state, 'open')
  assert.equal(card?.claim, null)
  assert.equal(card?.until, undefined, 'a checkout that never answered records nothing, never a guess')
})

test('a checkout with nothing to read (no live session) also records nothing, without waiting at all', async (t) => {
  const proof = await rig(async () => ({ head: 'deadbeef', dirty: false }), () => null)
  await proof.plane.release('g1', 's1')
  const card = proof.store.read('g1').board.intents.find((one) => one.id === 1)
  assert.equal(card?.until, undefined)
})
