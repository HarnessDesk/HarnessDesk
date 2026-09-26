import assert from 'node:assert/strict'
import { test } from 'node:test'

import { runtimeId } from '@harnessdesk/protocol'

import { PLAN_SUGGESTIONS, suggestionFor } from '../../src/usage/plan-prices.js'

test('every suggestion carries a source URL and a checked date', () => {
  for (const row of PLAN_SUGGESTIONS) {
    assert.ok(row.sourceUrl.startsWith('https://'), row.planMatch)
    assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(row.checkedAt), row.planMatch)
    assert.ok(row.amount > 0)
  }
})

test('matching is case-insensitive against the report\'s own plan string', () => {
  const found = suggestionFor(runtimeId('claude-code'), 'pro')
  assert.ok(found)
  assert.equal(found?.amount, 20)
  assert.equal(found?.planMatch, 'Pro')
})

test('a runtime with no matching row, or a plan with no row at all, answers null', () => {
  assert.equal(suggestionFor(runtimeId('claude-code'), 'Max 20x'), null)
  assert.equal(suggestionFor(runtimeId('claude-code'), null), null)
  assert.equal(suggestionFor(runtimeId('unknown-runtime'), 'Pro'), null)
})

test('a suggestion is inert data — computing it never writes anything a stored entry would carry', () => {
  const found = suggestionFor(runtimeId('cursor'), 'Ultra')
  assert.deepEqual(found, {
    runtime: runtimeId('cursor'),
    planMatch: 'Ultra',
    amount: 200,
    currency: 'USD',
    period: 'month',
    sourceUrl: 'https://cursor.com/docs/account/pricing',
    checkedAt: '2026-09-26',
  })
  // Nothing about calling this ever produces a PlanEntry/'source': 'user' —
  // that only happens through `PlanStore.set()`, exercised in plan-store.test.ts.
  assert.equal((found as unknown as { source?: unknown }).source, undefined)
})
