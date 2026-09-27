import assert from 'node:assert/strict'
import { test } from 'node:test'

import { runtimeId, type PlanEntry, type UsageReport } from '@harnessdesk/protocol'

import { mergePlanIntoReport, planOverlay } from '../../src/usage/plan-merge.js'

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

/* --------------------------------------------------------------- overlay */

test('planOverlay folds the stored entry in, reading the store fresh', async () => {
  const stored: PlanEntry = { fee: { amount: 20, currency: 'USD', period: 'month', source: 'user', setAt: 1 } }
  let reads = 0
  const overlay = planOverlay({
    entryFor: async () => {
      reads += 1
      return stored
    },
  })
  const merged = await overlay(baseReport)
  assert.deepEqual(merged.billing?.fee, { amount: 20, currency: 'USD', period: 'month', source: 'user' })
  await overlay(baseReport)
  assert.equal(reads, 2, 'the file is read once per call, never cached across calls')
})

test('planOverlay skips the read entirely for an account-less report', async () => {
  let asked = false
  const overlay = planOverlay({ entryFor: async () => { asked = true; return null } })
  const anonymous: UsageReport = { ...baseReport, account: null }
  const merged = await overlay(anonymous)
  assert.equal(merged, anonymous)
  assert.equal(asked, false)
})

test('planOverlay logs and passes the report through unmerged when the store cannot be read (BLOCKING 2)', async () => {
  const logged: unknown[] = []
  const overlay = planOverlay(
    { entryFor: async () => { throw new Error('~/.harnessdesk/plans.json was not read: it is not JSON') } },
    (message, details) => logged.push({ message, details }),
  )
  const merged = await overlay(baseReport)
  assert.equal(merged, baseReport, 'the report passes through unmerged rather than the call rejecting')
  assert.equal(logged.length, 1)
})
