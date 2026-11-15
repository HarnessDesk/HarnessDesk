import { test } from 'node:test'
import assert from 'node:assert/strict'
import { compareReceipt, compareSnapshot } from './receipt-diagnostics.mjs'

test('receipt and snapshot diagnostics disclose comparisons only', () => {
  const before = { identity: 'private-identity', watermark: { epoch: 'private-epoch', generation: 'private-generation', revision: 3, sequence: 4 } }
  const receipt = { identity: before.identity, ...before.watermark }
  assert.ok(Object.values(compareReceipt(before, receipt)).every(Boolean))
  assert.equal(compareReceipt(before, { ...receipt, revision: 4 }).revisionMatches, false)
  assert.equal(compareSnapshot(before, null).present, false)
  const changed = compareSnapshot(before, { ...before, identity: 'another-private-identity' })
  assert.equal(changed.present, true)
  assert.equal(changed.identityMatches, false)
  assert.doesNotMatch(JSON.stringify([changed, compareReceipt(before, receipt)]), /private/)
})
