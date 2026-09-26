import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { LedgerDay, LedgerReport, LedgerRow, SpendCoverage, UsageLane, UsageReport } from '../src/index.js'

/**
 * The token split, `requests`, `SpendCoverage.earliestDay` and the billing
 * shapes are all additive: an old client, an old fixture, or a report built
 * before this PR carries none of them, and must still be a valid value of
 * these types — the compiler checks that by accepting the literals below
 * with the new fields left out entirely, and the assertions check that a
 * generic reader (summing `daily`, reading `rows`) still works over one.
 */

const oldCoverage: SpendCoverage = {
  priced: 3,
  unpriced: 1,
  unmetered: 0,
  estimated: 0,
  daysCovered: 7,
  daysRequested: 7,
  // earliestDay intentionally absent.
}

const oldDay: LedgerDay = {
  day: Date.UTC(2026, 8, 1),
  runtime: 'codex' as LedgerDay['runtime'],
  cost: 1.5,
  tokens: 1000,
  // input/output/cacheRead/cacheWrite/reasoning/requests intentionally absent.
}

const oldRow: LedgerRow = {
  key: 'gpt-5.6-sol',
  label: 'gpt-5.6-sol',
  runtime: 'codex' as LedgerRow['runtime'],
  tokens: 1000,
  cost: 1.5,
  hasUnpriced: false,
  // the six split fields intentionally absent.
}

const oldReport: LedgerReport = {
  days: 7,
  currency: 'USD',
  totalCost: 1.5,
  totalTokens: 1000,
  provenance: 'listPrice',
  coverage: oldCoverage,
  rows: [oldRow],
  daily: [oldDay],
  scannedAt: Date.now(),
  // totals intentionally absent.
}

test('an old-shaped LedgerReport (no split, no requests, no earliestDay) still satisfies the type', () => {
  assert.equal(oldReport.totals, undefined)
  assert.equal(oldReport.coverage.earliestDay, undefined)
  assert.equal(oldReport.rows[0]?.input, undefined)
  assert.equal(oldReport.daily[0]?.requests, undefined)
})

test('a generic reader can still sum an old-shaped report\'s daily and rows', () => {
  // What a chart or a table already does: reduce over `daily`/`rows` reading
  // only the fields that have always been there. Nothing here should throw
  // or read `undefined` where a number was expected.
  const totalFromDaily = oldReport.daily.reduce((sum, entry) => sum + entry.cost, 0)
  const totalFromRows = oldReport.rows.reduce((sum, entry) => sum + (entry.cost ?? 0), 0)
  assert.equal(totalFromDaily, oldReport.totalCost)
  assert.equal(totalFromRows, oldReport.totalCost)
})

const oldLane: UsageLane = {
  id: 'weekly',
  label: 'Weekly',
  usedPercent: 42,
  windowMinutes: 7 * 24 * 60,
  resetsAt: Date.now(),
  // unit/used/limit/layer intentionally absent.
}

const oldReportUsage: UsageReport = {
  runtime: 'codex' as UsageReport['runtime'],
  account: null,
  plan: 'Plus',
  lanes: [oldLane],
  credits: null,
  spend: null,
  reached: null,
  source: { kind: 'runtime', label: 'from its own API' },
  fetchedAt: Date.now(),
  staleAfterMs: 300_000,
  error: null,
  // unverified/billing/turns intentionally absent.
}

test('an old-shaped UsageLane and UsageReport (no billing, no turns, no unit/used/limit/layer) still satisfy the type', () => {
  assert.equal(oldLane.unit, undefined)
  assert.equal(oldLane.layer, undefined)
  assert.equal(oldReportUsage.billing, undefined)
  assert.equal(oldReportUsage.turns, undefined)
  assert.equal(oldReportUsage.lanes[0]?.usedPercent, 42)
})
