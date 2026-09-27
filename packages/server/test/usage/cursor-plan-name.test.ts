import assert from 'node:assert/strict'
import { test } from 'node:test'

import { planName } from '../../src/usage/cursor.js'

/**
 * `plan-prices.ts`'s Cursor "Pro Plus" row is pinned to exactly what
 * `planName` produces for a `pro_plus` membership — title-casing only the
 * first character, never the vendor page's own two-word "Pro Plus" — so a
 * wrong guess at the API's own casing can never silently fail to match, or
 * worse, match the wrong tier.
 */
test('planName title-cases only the first character, never a vendor page\'s own spelling', () => {
  assert.equal(planName('pro'), 'Pro')
  assert.equal(planName('pro_plus'), 'Pro_plus')
  assert.equal(planName('ultra'), 'Ultra')
})

test('planName answers null for nothing to report', () => {
  assert.equal(planName(undefined), null)
  assert.equal(planName(''), null)
})
