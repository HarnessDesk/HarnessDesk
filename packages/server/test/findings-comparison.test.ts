import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { EvidenceRecord, EvidenceView, FindingRunState } from '@harnessdesk/protocol'

import type { FindingRunSnapshot } from '../src/flow-execution.js'
import { readyGuard, WAITING_FINDINGS, type FlowEvidenceContext } from '../src/flow-evidence.js'
import { foldFindings } from '../src/findings/model.js'
import { closeRound, FindingsPlane, type FindingsPort } from '../src/findings/plane.js'

const A = 'a'.repeat(40)
const B = 'b'.repeat(40)
const ID = 'finding-00000000-0000-4000-8000-000000000001'

/** Reads the actual plane over a closed comparison and its durable selected route. */
const comparison = (blocking: boolean, onPicked = false) => {
  const at = onPicked ? B : A
  const raised: EvidenceRecord = {
    id: 'raise-1', fact: { kind: 'finding', id: ID, state: 'open', at },
    card: { board: 'goal-1', id: 3 }, checkout: { cwd: onPicked ? '/picked' : '/loser', branch: onPicked ? 'attempt-b' : 'attempt-a' },
    seat: 'judge-1', round: 2, observedAt: 1, posted: null,
    finding: {
      version: 1, sequence: 1, operation: 'raise-1',
      origin: { goal: 'goal-1', run: 'run-1', round: 2, card: 3, seat: 'judge-1', at },
      event: { kind: 'raise', title: 'The retry never stops', body: 'A failed request retries forever.', category: 'ordinary', blocking, related: null, anchor: null },
    },
  }
  const picked: EvidenceRecord = {
    id: 'pick-1', fact: { kind: 'review', verdict: 'picked', at: B, by: 'judge-1' },
    card: { board: 'goal-1', id: 3 }, checkout: { cwd: '/picked', branch: 'attempt-b' },
    seat: 'judge-1', round: 2, observedAt: 2, posted: null,
  }
  const records = [raised, picked]
  let facts: readonly EvidenceView[] = [{ record: picked, freshness: { state: 'fresh' }, by: null }]
  const review = { n: 2, role: 'judge', cards: [3], seats: ['judge-1'], evidence: [], state: 'closed' as const, cause: 'to-judge', reviews: true }
  const state: FindingRunState = {
    version: 1, budget: { rounds: 10, withoutProgress: 5 }, closedRounds: [], idleRounds: 0,
    progress: [], series: [], stopped: null, extraRound: null, overrides: [], lastDecision: null,
  }
  let snapshot: FindingRunSnapshot = {
    id: 'run-1', goal: 'goal-1', state: 'running', reason: null, findings: state,
    rounds: [review], slots: {}, pendingFindings: 0, pinned: {}, leads: {},
  }
  snapshot = { ...snapshot, findings: closeRound({
    snapshot, round: review, ledger: { records, views: foldFindings(records), unreadable: 0 }, facts,
    subjects: [
      { card: 1, round: 1, at: A, checkout: { cwd: '/loser', branch: 'attempt-a' } },
      { card: 2, round: 1, at: B, checkout: { cwd: '/picked', branch: 'attempt-b' } },
    ],
  }) }
  const port: FindingsPort = {
    store: {
      read: async () => ({ lines: records.map(record => ({ type: 'evidence' as const, record })), skipped: 0, unreadableCards: [], unscopedSkipped: 0 }),
      append: async () => { throw new Error('read only') },
    },
    seats: { byId: () => null, latestKeptOf: () => null },
    flows: {
      binding: () => null, candidate: async () => null, journal: async () => { throw new Error('read only') }, pending: () => [],
      run: () => snapshot, facts: async () => facts, seriesOfGoal: () => snapshot.findings!.series,
    },
    projectOf: async () => '/repo', headOf: async () => ({ at: B, dirty: false }), now: () => 1, log: () => {},
  }
  return {
    plane: new FindingsPlane(port),
    keptContext: (): FlowEvidenceContext => ({
      goal: 'goal-1', finished: review,
      subjects: [{ card: 2, round: 1, at: B, checkout: { cwd: '/picked', branch: 'attempt-b' } }],
      unsettled: [], cards: [2, 3], reviewers: ['judge-1'], facts, outcomes: ['picked'],
    }),
    accept: () => { snapshot = { ...snapshot, rounds: [...snapshot.rounds, { n: 3, role: 'keep', cards: [4], seats: [], evidence: [picked.id], state: 'running', cause: 'to-keep', reviews: false }] } },
    laterReview: (state: 'running' | 'closed') => { snapshot = { ...snapshot, rounds: [...snapshot.rounds.filter(one => one.n !== 4), { ...review, n: 4, role: 'specialist', cards: [5], state }] } },
    moveFacts: () => { facts = facts.map(one => ({ ...one, freshness: { state: 'moved' } })) },
    restorePick: () => { facts = facts.map(one => ({ ...one, record: { ...one.record, restored: { at: 3 } } })) },
    pendingException: () => { snapshot = { ...snapshot, findings: { ...snapshot.findings!, series: snapshot.findings!.series.map(one => ({ ...one, pending: [ID] })) } } },
  }
}

for (const blocking of [true, false]) {
  test(`an accepted losing ${blocking ? 'blocking' : 'advisory'} finding keeps its explanation through later reviews and moving facts`, async () => {
    const rig = comparison(blocking)
    assert.equal((await rig.plane.list({ goal: 'goal-1' })).rows[0]!.inactiveReason, undefined, 'no explanation before acceptance')
    rig.accept()
    const reason = `The review selected revision ${B.slice(0, 12)} for the next step.`
    const check = async () => {
      const page = await rig.plane.list({ goal: 'goal-1' })
      assert.equal(page.rows[0]!.inactiveReason, reason)
      assert.equal(page.rows[0]!.activeBlocking, false)
      assert.equal(page.rows[0]!.lifecycle.state, 'open')
      assert.equal(page.totals!.blocking, 0)
      assert.equal((await rig.plane.read({ goal: 'goal-1', finding: ID })).finding.inactiveReason, reason)
      assert.equal((await rig.plane.receipt('goal-1')).findings[0]!.inactiveReason, reason)
      assert.equal((await rig.plane.runView('run-1')).blocking, 0)
      assert.equal((await rig.plane.gate('run-1'))!.blockers, 0)
    }
    await check()
    rig.laterReview('running')
    await check()
    rig.laterReview('closed')
    rig.moveFacts()
    await check()
  })
}

test('an accepted selection does not mark the picked subject or a restored pick as Not kept', async () => {
  const picked = comparison(true, true)
  picked.accept()
  const selected = await picked.plane.list({ goal: 'goal-1' })
  assert.equal(selected.rows[0]!.inactiveReason, undefined)
  assert.equal(selected.rows[0]!.activeBlocking, true)
  assert.equal(selected.totals!.blocking, 1)
  assert.equal((await picked.plane.gate('run-1'))!.blockers, 1)
  const restored = comparison(true)
  restored.accept()
  restored.restorePick()
  assert.equal((await restored.plane.list({ goal: 'goal-1' })).rows[0]!.inactiveReason, undefined)
  assert.equal((await restored.plane.gate('run-1'))!.blockers, 1)
  const pending = comparison(true)
  pending.accept()
  pending.pendingException()
  assert.equal((await pending.plane.list({ goal: 'goal-1' })).rows[0]!.inactiveReason, undefined)
  assert.equal((await pending.plane.gate('run-1'))!.pending, true)
})

test('downstream rules over only the kept writer honour the earlier accepted comparison', async () => {
  const rig = comparison(true)
  const guard = async () => readyGuard([{ review: 'picked' }], rig.keptContext(), await rig.plane.gate('run-1'))
  assert.deepEqual(await guard(), { state: 'waiting', reason: WAITING_FINDINGS(1) }, 'no durable acceptance yet')
  rig.accept()
  assert.equal((await guard()).state, 'matched', 'the losing writer is no longer in the dependency closure')
  rig.laterReview('running')
  assert.equal((await guard()).state, 'matched')
  rig.laterReview('closed')
  assert.equal((await guard()).state, 'matched')
  const picked = comparison(true, true)
  picked.accept()
  assert.deepEqual(readyGuard([{ review: 'picked' }], picked.keptContext(), await picked.plane.gate('run-1')),
    { state: 'waiting', reason: WAITING_FINDINGS(1) })
})
