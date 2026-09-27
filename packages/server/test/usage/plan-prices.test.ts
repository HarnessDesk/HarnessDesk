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

/**
 * One test per kept row, each pinned to the exact string its own reader
 * produces (`cursor-plan-name.test.ts`, `usage-meter.test.ts`,
 * `preview/signin-fixture.ts`'s Codex report) — never a guess at a vendor
 * page's own spelling, which is how a suggestion could silently never fire
 * or fire for the wrong plan.
 */
test('every kept row matches the exact string its reader produces', () => {
  assert.equal(suggestionFor(runtimeId('claude-code'), 'Pro')?.amount, 20, "claude-file.ts's planFor('default_claude_pro')")
  assert.equal(suggestionFor(runtimeId('codex'), 'plus')?.amount, 20, "adapter-codex's own account.planType")
  assert.equal(suggestionFor(runtimeId('cursor'), 'Pro')?.amount, 20, "cursor.ts's planName('pro')")
  assert.equal(suggestionFor(runtimeId('cursor'), 'Pro_plus')?.amount, 60, "cursor.ts's planName('pro_plus')")
  assert.equal(suggestionFor(runtimeId('cursor'), 'Ultra')?.amount, 200, "cursor.ts's planName('ultra')")
})

test('a suggestion never matches the wrong plan — a vendor page\'s own spelling does not fire', () => {
  assert.equal(suggestionFor(runtimeId('cursor'), 'Pro Plus'), null, 'the vendor page\'s two-word spelling is not what the reader produces')
  assert.equal(suggestionFor(runtimeId('cursor'), 'Pro+'), null)
})

/**
 * Copilot and Gemini are dropped entirely (NIT): the only `copilot_plan`
 * this repo has ever observed is `'business'`, and Gemini's tier name has
 * no observed value at all, so neither vendor's Pro/Pro+/Google AI Pro row
 * could ever be shown to match its own reader's real output.
 */
test('Copilot and Gemini carry no rows — nothing here shows what their readers actually produce for a paid tier', () => {
  assert.equal(PLAN_SUGGESTIONS.some((row) => row.runtime === runtimeId('github-copilot-cli')), false)
  assert.equal(PLAN_SUGGESTIONS.some((row) => row.runtime === runtimeId('gemini')), false)
})
