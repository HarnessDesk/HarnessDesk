import assert from 'node:assert/strict'
import { test } from 'node:test'

import { activityOf, checkedDependencies, factsOfGoal, membersOf } from '@harnessdesk/protocol'
import type { EvidenceRecord } from '@harnessdesk/protocol'

import { goal, seat } from './fixtures/goals.js'

test('membership includes only open kept Seats on this Goal', () => {
  const records = [
    seat(),
    seat('closed', { closed: { at: 2, why: 'released' } }),
    seat('restored', { restored: { at: 3 } }),
    seat('other', { board: 'g2' }),
    seat('loose', { board: null }),
  ]
  assert.deepEqual(membersOf(goal(), records).map((one) => one.id), ['s1'])
  assert.deepEqual(membersOf(goal('g1', { state: 'wrapping' }), records).map((one) => one.id), ['s1'])
  assert.deepEqual(membersOf(goal('g1', { state: 'wrapped' }), records), [])
  assert.equal(records.length, 5)
})

test('dependency edits reject direct, transitive and already-corrupt cycles', () => {
  const one = goal()
  const two = goal('g2', { dependsOn: ['g1'] })
  const three = goal('g3', { dependsOn: ['g2'] })
  const circular = /These Goals would wait on each other/
  assert.throws(() => checkedDependencies(one, ['g1'], [one]), circular)
  assert.throws(() => checkedDependencies(one, ['g3'], [one, two, three]), circular)
  assert.throws(() => checkedDependencies(one, ['g2'], [
    goal('g2', { dependsOn: ['g3'] }),
    goal('g3', { dependsOn: ['g2'] }),
  ]), circular)
})

test('every reachable dependency must exist in this project', () => {
  const one = goal()
  const invalid = /Choose an existing Goal in this project/
  assert.throws(() => checkedDependencies(one, ['missing'], []), invalid)
  assert.throws(() => checkedDependencies(one, ['g2'], [goal('g2', { root: '/work/other' })]), invalid)
  assert.throws(() => checkedDependencies(one, ['g2'], [goal('g2', { dependsOn: ['gone'] })]), invalid)
  assert.throws(() => checkedDependencies(one, ['g2'], [
    goal('g2', { dependsOn: ['g3'] }), goal('g3', { root: '/work/other' }),
  ]), invalid)
})

test('dependency limits count unique edges and preserve order without sharing an array', () => {
  const all = Array.from({ length: 129 }, (_, index) => goal(`d${index}`))
  const ids = all.slice(0, 128).map((one) => one.id)
  const checked = checkedDependencies(goal(), ids, all)
  assert.deepEqual(checked, ids)
  assert.notEqual(checked, ids)
  assert.throws(() => checkedDependencies(goal(), all.map((one) => one.id), all), /up to 128 Goals/)
  assert.throws(() => checkedDependencies(goal(), ['d0', 'd0'], all), /Choose each dependency once/)
})

test('a diamond dependency graph is valid', () => {
  const all = [goal('b', { dependsOn: ['d'] }), goal('c', { dependsOn: ['d'] }), goal('d')]
  assert.deepEqual(checkedDependencies(goal(), ['c', 'b'], all), ['c', 'b'])
})

const activity = {
  needsYou: false,
  busy: false,
  liveFlow: false,
  cards: [{ state: 'done' }],
  dependencies: [],
}

test('needs-you precedes busy, while wrapped Goals have no live activity', () => {
  assert.equal(activityOf(goal(), { ...activity, needsYou: true, busy: true }), 'needs-you')
  assert.equal(activityOf(goal('g1', { state: 'wrapped' }), { ...activity, needsYou: true }), null)
  assert.equal(activityOf(goal('g1', { state: 'wrapping' }), activity), 'working')
})

test('empty Goals, live flows, busy work and unfinished cards cannot be ready', () => {
  assert.equal(activityOf(goal(), { ...activity, cards: [] }), 'working')
  assert.equal(activityOf(goal(), { ...activity, busy: true }), 'working')
  assert.equal(activityOf(goal(), { ...activity, liveFlow: true }), 'working')
  for (const state of ['open', 'claimed', 'blocked']) {
    assert.equal(activityOf(goal(), { ...activity, cards: [{ state }] }), 'working')
  }
  assert.equal(activityOf(goal(), activity), 'ready-to-wrap')
  assert.equal(activityOf(goal(), { ...activity, cards: [{ state: 'abandoned' }] }), 'ready-to-wrap')
})

test('missing, open and wrapping dependencies wait; every wrapped dependency releases the wait', () => {
  const waiting = goal('g1', { dependsOn: ['g2'] })
  assert.equal(activityOf(waiting, activity), 'working')
  for (const state of ['open', 'wrapping'] as const) {
    assert.equal(activityOf(waiting, { ...activity, dependencies: [goal('g2', { state })] }), 'working')
  }
  assert.equal(activityOf(waiting, {
    ...activity, dependencies: [goal('g2', { state: 'wrapped', receipt: 'receipt-2' })],
  }), 'ready-to-wrap')
})

test('receipt attribution includes released Seats and card facts, once, but no unscoped spend', () => {
  const fact = { kind: 'spend', usd: 1, turns: 1, exact: false } as const
  const facts: EvidenceRecord[] = [
    { id: 'ours', fact, seat: 's1', observedAt: 1 },
    { id: 'card', fact, card: { board: 'g1', id: 1 }, observedAt: 1 },
    { id: 'both', fact, seat: 's1', card: { board: 'g1', id: 1 }, observedAt: 1 },
    { id: 'other', fact, seat: 's2', observedAt: 1 },
    { id: 'unknown', fact, observedAt: 1 },
  ]
  assert.deepEqual(factsOfGoal('g1', [seat('s1', { closed: { at: 2, why: 'released' } })], facts)
    .map((one) => one.id), ['ours', 'card', 'both'])
  assert.equal(facts.length, 5)
})
