import assert from 'node:assert/strict'
import { test } from 'node:test'

import { runtimeId, type PlanEntry, type UsageReport } from '@harnessdesk/protocol'

import { mergePlanIntoReport } from '../../src/usage/plan-merge.js'

const baseReport: UsageReport = {
  runtime: runtimeId('claude-code'),
  account: 'dev@example.com',
  plan: 'Pro',
  lanes: [],
  credits: null,
  spend: null,
  reached: null,
  source: { kind: 'file', label: 'from its own cache' },
  fetchedAt: 0,
  staleAfterMs: 0,
  error: null,
}

test('no stored entry leaves the report untouched (same instance)', () => {
  assert.equal(mergePlanIntoReport(baseReport, null), baseReport)
  assert.equal(mergePlanIntoReport(baseReport, {}), baseReport)
})

test('a stored fee and budget merge in with source "user"', () => {
  const stored: PlanEntry = {
    fee: { amount: 20, currency: 'USD', period: 'month', source: 'user', setAt: 1 },
    budget: { amount: 50, currency: 'USD', period: 'month', setAt: 1 },
  }
  const merged = mergePlanIntoReport(baseReport, stored)
  assert.deepEqual(merged.billing?.fee, { amount: 20, currency: 'USD', period: 'month', source: 'user' })
  assert.deepEqual(merged.billing?.budget, { amount: 50, currency: 'USD', period: 'month' })
  assert.deepEqual(merged.billing?.kinds, [])
})

test('a vendor-reported fee always wins over the stored one', () => {
  const withVendorFee: UsageReport = {
    ...baseReport,
    billing: { kinds: ['windows'], fee: { amount: 999, currency: 'USD', period: 'month', source: 'vendor' } },
  }
  const stored: PlanEntry = { fee: { amount: 20, currency: 'USD', period: 'month', source: 'user', setAt: 1 } }
  const merged = mergePlanIntoReport(withVendorFee, stored)
  assert.deepEqual(merged.billing?.fee, { amount: 999, currency: 'USD', period: 'month', source: 'vendor' })
})

test('a stored budget applies beside an existing vendor billing shape without touching its kinds', () => {
  const report: UsageReport = { ...baseReport, billing: { kinds: ['windows', 'metered'] } }
  const stored: PlanEntry = { budget: { amount: 25, currency: 'USD', period: 'month', setAt: 1 } }
  const merged = mergePlanIntoReport(report, stored)
  assert.deepEqual(merged.billing?.kinds, ['windows', 'metered'])
  assert.deepEqual(merged.billing?.budget, { amount: 25, currency: 'USD', period: 'month' })
})
