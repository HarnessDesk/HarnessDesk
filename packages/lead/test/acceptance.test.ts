import assert from 'node:assert/strict'
import { test } from 'node:test'
import { contract, evidence, exported } from './fixtures/loop.js'

test('acceptance refuses stale or incompatible evidence, missing checks, reviews, blockers and incomplete spend', () => {
  const evaluate = exported('evaluateLeadAcceptance')
  const fresh = evidence()
  assert.equal(evaluate(contract, fresh, { now: 100, freshnessMs: 50, revision: 1 }).status, 'reviewed')
  for (const patch of [ { observedAt: 0 }, { revision: 'head-2' }, { contractDigest: 'b'.repeat(64) }, { checks: [] }, { reviews: [] },
    { spendComplete: false }, { complete: false }, { findingsComplete: false },
    { checks: [{ ...fresh.checks[0], counted: false }] }, { checks: [{ ...fresh.checks[0], exit: 1 }] },
    { reviews: [{ ...fresh.reviews[0], verdict: 'request-changes' }] },
    { findings: [{ id: 'finding-1', revision: 'head-1', blocking: true, resolved: false }] } ]) {
    assert.notEqual(evaluate(contract, { ...fresh, ...patch }, { now: 100, freshnessMs: 50, revision: 1 }).status, 'reviewed', JSON.stringify(patch))
  }
})


test('omitting any mandatory acceptance gate cannot produce reviewed acceptance', () => {
  for (const kind of ['check', 'review', 'blocking-findings']) {
    const proposal = { ...contract, assertions: contract.assertions.filter(assertion => assertion.kind !== kind) }
    assert.equal(exported('evaluateLeadAcceptance')(proposal, evidence(), { now: 100, freshnessMs: 50, revision: 1 }).status, 'unknown', kind)
  }
})
