import assert from 'node:assert/strict'
import { test } from 'node:test'
import { isFindingsWait, WAITING_EXCEPTION, WAITING_LEDGER, WAITING_FINDINGS } from '../src/index.js'

test('recognizes only the shared findings waits, with or without a routing rule', () => {
  for (const wait of [WAITING_FINDINGS(1), WAITING_FINDINGS(3), WAITING_EXCEPTION, WAITING_LEDGER]) {
    assert.equal(isFindingsWait(wait), true)
    assert.equal(isFindingsWait(`Rule after-review: ${wait}`), true)
    assert.equal(isFindingsWait(`${wait} Different wait.`), false)
  }
  for (const wait of [null, 'Waiting for CI to go green at this revision.', 'Waiting for card #7: findings-check has not passed.', 'Waiting for its evidence.']) {
    assert.equal(isFindingsWait(wait), false)
  }
})
