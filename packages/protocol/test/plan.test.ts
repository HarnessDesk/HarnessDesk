import assert from 'node:assert/strict'
import { test } from 'node:test'

import { PLAN_ARRAY_KEYS, planLabel, planStatus } from '../src/plan.js'

/**
 * One reading of a plan entry, shared by the plugin that writes plans and the
 * renderer that draws them. It lives here because the two had a vocabulary
 * each, and a task one of them called done the other called pending.
 */

test('the words every agent actually sends are the states they mean', () => {
  // Measured across every transcript on this machine: Cursor sends
  // TODO_STATUS_*, Claude Code sends the bare words, ours sends its own.
  assert.equal(planStatus('TODO_STATUS_PENDING'), 'pending')
  assert.equal(planStatus('TODO_STATUS_IN_PROGRESS'), 'inProgress')
  assert.equal(planStatus('TODO_STATUS_COMPLETED'), 'done')
  assert.equal(planStatus('completed'), 'done')
  assert.equal(planStatus('in_progress'), 'inProgress')
  assert.equal(planStatus('inProgress'), 'inProgress')
  assert.equal(planStatus('pending'), 'pending')
  assert.equal(planStatus('done'), 'done')
})

test('a word that contains another is not that other word', () => {
  // Substring matching read `incomplete` as finished and `not_done` as done —
  // the exact inversion of what they say — and `inactive` as in progress.
  assert.notEqual(planStatus('incomplete'), 'done')
  assert.notEqual(planStatus('not_done'), 'done')
  assert.notEqual(planStatus('not done'), 'done')
  assert.notEqual(planStatus('inactive'), 'inProgress')
})

test('a cancelled task is its own state, and never a pending one', () => {
  // Read as pending, an abandoned task reaches the next agent's hand-off as
  // work still to do. `TODO_STATUS_CANCELLED` also carries the word `todo`,
  // which is what a looser reading matched on.
  assert.equal(planStatus('cancelled'), 'cancelled')
  assert.equal(planStatus('canceled'), 'cancelled')
  assert.equal(planStatus('TODO_STATUS_CANCELLED'), 'cancelled')
  assert.equal(planStatus('abandoned'), 'cancelled')
})

test('a status nobody recognises is silence, not a state', () => {
  assert.equal(planStatus('bananas'), null)
  assert.equal(planStatus(undefined), null)
  assert.equal(planStatus(42), null)
})

test('a label is a string under one of the keys, or there is no label', () => {
  assert.equal(planLabel({ task: 'a' }), 'a')
  assert.equal(planLabel({ content: 'b' }), 'b')
  assert.equal(planLabel({ title: 'c' }), 'c')
  // `String({})` is "[object Object]", a task nobody wrote.
  assert.equal(planLabel({ task: { nested: 1 } }), null)
  assert.equal(planLabel({ task: '   ' }), null)
  assert.equal(planLabel({ name: 'not a plan key' }), null)
})

test('a plan key is one an agent uses, and `steps` is not one', () => {
  // A CI or workflow tool's own list is `steps: [{title, status}]` to the
  // letter; anchoring on that key handed it the conversation's plan.
  assert.equal((PLAN_ARRAY_KEYS as readonly string[]).includes('todos'), true)
  assert.equal((PLAN_ARRAY_KEYS as readonly string[]).includes('tasks'), true)
  assert.equal((PLAN_ARRAY_KEYS as readonly string[]).includes('plan'), true)
  assert.equal((PLAN_ARRAY_KEYS as readonly string[]).includes('steps'), false)
})

test('a negation spelled as one word is still pending', () => {
  // #62: incomplete, unfinished and undone read as no status at all.
  assert.equal(planStatus('incomplete'), 'pending')
  assert.equal(planStatus('unfinished'), 'pending')
  assert.equal(planStatus('undone'), 'pending')
  // And the two-word spellings still say the same.
  assert.equal(planStatus('not_done'), 'pending')
})

test('in before complete is a negation however it is joined, and in_progress is still running', () => {
  // Round 1 of #158: split by case or a separator, `incomplete` is `in` and `complete`, which read as done.
  for (const status of ['inComplete', 'in_complete', 'in-complete', 'IN_COMPLETE']) assert.equal(planStatus(status), 'pending', status)
  assert.equal(planStatus('in_progress'), 'inProgress')
  assert.equal(planStatus('inProgress'), 'inProgress')
})
