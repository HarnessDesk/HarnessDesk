import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { BoardEvidence, SeatRecord } from '@harnessdesk/protocol'

import { GoalPlane, type GoalPlanePort } from '../src/goals/plane.js'
import { migrateDesk } from '../src/goals/migration.js'
import { GoalStore } from '../src/goals/store.js'
import { goal, intent, seat } from './fixtures/goals.js'
import { tempDir } from './scratch.js'

const rig = async () => {
  const home = tempDir('hd-goal-plane-')
  await migrateDesk(home, async () => {})
  const store = new GoalStore(home)
  await store.load()
  await store.save({
    version: 1, goal: goal(),
    board: { nextIntent: 2, messaging: true, intents: [intent(1, { state: 'done' })], channel: [] },
    citations: [], receipt: null, operation: null,
  }, null)
  let facts: BoardEvidence = { room: 'g1', stamp: 1, checks: [], refused: [], unreadable: null, cards: [] }
  let readError = false
  const seats: SeatRecord[] = []
  const transitions: string[] = []
  const forbidden = async (): Promise<never> => { throw new Error('This test must not seat or close a conversation') }
  const port: GoalPlanePort = {
    seats: { all: () => seats, byId: (id) => seats.find((one) => one.id === id) ?? null },
    confine: async (input) => ({ root: input.root, cwd: input.cwd ?? input.root }),
    known: async () => ({ project: '/work/repo', busy: false }),
    claimable: () => true,
    opening: forbidden,
    board: (id) => {
      const document = store.read(id)
      return { ...document.board, id, name: document.goal.sentence, root: document.goal.root,
        updatedAt: document.goal.updatedAt, members: [] }
    },
    evidence: async () => { if (readError) throw new Error('evidence unavailable'); return facts },
    flow: () => undefined,
    busy: () => false,
    waits: () => false,
    stranded: () => false,
    held: () => false,
    changed: () => {},
    activity: (_id, previous, next) => { transitions.push(`${previous}:${next}`) },
    ready: () => ({ ok: true }),
    seatAgent: forbidden,
    openLegacySeat: forbidden,
    importOpening: forbidden,
    closeId: forbidden,
    claim: forbidden,
    releaseClaim: forbidden,
    refuseMail: forbidden,
    finish: forbidden,
    finishWrap: forbidden,
    wake: () => {},
  }
  return {
    store, seats, port, transitions,
    plane: new GoalPlane(store, port),
    facts: (next: BoardEvidence) => { facts = next },
    failRead: () => { readError = true },
  }
}

test('a done card without observed evidence needs a person; a current passing check makes it ready', async () => {
  const proof = await rig()
  assert.equal((await proof.plane.view('g1')).activity, 'needs-you')
  await proof.plane.refresh('g1')
  assert.deepEqual(proof.transitions, [])
  proof.facts({
    room: 'g1', stamp: 2, checks: ['verify'], refused: [], unreadable: null,
    cards: [{ card: 1, running: [], facts: [{
      record: { id: 'fact', card: { board: 'g1', id: 1 }, observedAt: 2,
        fact: { kind: 'check', name: 'verify', run: 'node --test', exit: 0, timedOut: false,
          at: 'a'.repeat(40), dirty: false, tail: '' } },
      freshness: { state: 'fresh' }, by: null,
    }] }],
  })
  await proof.plane.refresh('g1')
  assert.equal((await proof.plane.view('g1')).activity, 'ready-to-wrap')
  assert.deepEqual(proof.transitions, ['needs-you:ready-to-wrap'])
})

test('an evidence read failure is visible and never makes settled work ready', async () => {
  const proof = await rig()
  proof.failRead()
  const view = await proof.plane.view('g1')
  assert.equal(view.problem, 'evidence unavailable')
  assert.notEqual(view.activity, 'ready-to-wrap')
})

test('creation persists an empty Goal without seating; dependency waits still allow a sentence edit', async () => {
  const proof = await rig()
  const created = await proof.plane.create({ root: '/work/repo', sentence: '  A separate effort  ', dependsOn: ['g1'] })
  assert.equal(created.goal.sentence, 'A separate effort')
  assert.deepEqual(created.members, [])
  assert.deepEqual(created.board.intents, [])
  assert.equal(proof.plane.canDispatch(created.goal.id).ok, false)
  const changed = await proof.plane.update(created.goal.id, 0, { sentence: 'A clearer sentence' })
  assert.equal(changed.goal.revision, 1)
  assert.equal(changed.goal.sentence, 'A clearer sentence')
  await assert.rejects(proof.plane.update(created.goal.id, 0, { sentence: 'stale edit' }), /Goal changed/)
})

test('restored Goal history has no members and cannot dispatch or accept edits', async () => {
  const proof = await rig()
  const document = proof.store.read('g1')
  await proof.store.save({ ...document, restored: { at: 2 }, goal: { ...document.goal, revision: 1 } }, 0)
  proof.seats.push(seat())
  const view = await proof.plane.view('g1')
  assert.deepEqual(view.members, [])
  assert.equal(view.activity, null)
  assert.match(view.problem!, /came from a backup/)
  assert.equal(proof.plane.canDispatch('g1').ok, false)
  await assert.rejects(proof.plane.update('g1', 1, { sentence: 'continue' }), /read-only/)
})
