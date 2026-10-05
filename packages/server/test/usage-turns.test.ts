import assert from 'node:assert/strict'
import { test } from 'node:test'

import { runtimeId, type AgentRuntime, type SpendSummary, type UsageBilling, type UsageReport } from '@harnessdesk/protocol'

import { UsageService, type SpendSource } from '../src/usage/service.js'
import type { MeterReading, UsageMeter } from '../src/usage/meter.js'

/**
 * `UsageReport.turns` — "Turns", `docs/usage-dashboard.md` — filled from the
 * ledger's own count, with `unitsPerTurn` priced in the lane's own unit: an
 * allowance in requests, Value for a balance or a metered key, and never a
 * figure for a plain percent window or too thin a sample.
 */

const RUNTIME = runtimeId('agent')

const runtime = (): AgentRuntime =>
  ({
    info: { id: RUNTIME, name: 'agent', capabilities: { metered: false }, presentation: { name: 'agent' } },
    health: () => ({ state: 'ready' }),
    getRateLimits: async () => null,
    getAccount: async () => ({ accounts: [], signInMethods: [] }),
  }) as unknown as AgentRuntime

const meterWith = (billing: UsageBilling): UsageMeter => ({
  id: 'test',
  source: { kind: 'file', label: 'from a fixture' },
  read: async (): Promise<MeterReading> => ({
    lanes: [{ id: 'plan', label: 'Plan', usedPercent: 10, windowMinutes: null, resetsAt: null }],
    plan: 'Test',
    account: 'someone@example.com',
    credits: null,
    reached: null,
    fetchedAt: 1_000,
    staleAfterMs: 60_000,
    billing,
  }),
  watchPaths: () => [],
})

const money = (windowCost: number): SpendSummary => ({
  currency: 'USD',
  todayCost: windowCost,
  windowCost,
  windowDays: 30,
  todayTokens: 10,
  windowTokens: 100,
  provenance: 'listPrice',
  coverage: { priced: 1, unpriced: 0, unmetered: 0, estimated: 0, daysCovered: 1, daysRequested: 30 },
  daily: [],
})

interface FakeSpend {
  readonly turns: { count: number; since: number; source?: 'agent' | 'desk' } | null
  readonly requests: number
  readonly windowCost: number
}

const spendSourceFor = (fake: FakeSpend): SpendSource => ({
  spendFor: () => money(fake.windowCost),
  turnsFor: () => (fake.turns ? { ...fake.turns, source: fake.turns.source ?? 'agent' } : null),
  requestsFor: () => fake.requests,
  valueFor: () => fake.windowCost,
})

const oneReport = async (billing: UsageBilling, fake: FakeSpend): Promise<UsageReport | null> => {
  const usage = new UsageService({
    runtimes: () => [runtime()],
    meters: new Map([[RUNTIME, meterWith(billing)]]),
    spend: spendSourceFor(fake),
    onReport: () => {},
  })
  const [report] = await usage.reports()
  usage.dispose()
  return report ?? null
}

test('an allowance lane in requests prices a turn in ledger requests per turn', async () => {
  const report = await oneReport(
    { kinds: ['allowance'] },
    { turns: { count: 20, since: 1 }, requests: 100, windowCost: 0 },
  )
  assert.equal(report?.turns?.count, 20)
  assert.equal(report?.turns?.unitsPerTurn, 5, '100 ledger requests over 20 turns')
})

test('a balance or a metered key prices a turn in Value — vendor cost or list price', async () => {
  const balance = await oneReport(
    { kinds: ['balance'] },
    { turns: { count: 15, since: 1 }, requests: 0, windowCost: 30 },
  )
  assert.equal(balance?.turns?.unitsPerTurn, 2, '$30 over 15 turns')

  const metered = await oneReport(
    { kinds: ['metered'] },
    { turns: { count: 10, since: 1 }, requests: 0, windowCost: 25 },
  )
  assert.equal(metered?.turns?.unitsPerTurn, 2.5)
})

test('a plain percent window has no per-turn figure yet', async () => {
  const report = await oneReport(
    { kinds: ['windows'] },
    { turns: { count: 50, since: 1 }, requests: 0, windowCost: 100 },
  )
  assert.equal(report?.turns?.count, 50, 'the count is still honest')
  assert.equal(report?.turns?.unitsPerTurn, null, 'no history of lane snapshots to divide by turns yet')
})

test('fewer than ten turns in the window reports the count with no rate', async () => {
  const report = await oneReport(
    { kinds: ['allowance'] },
    { turns: { count: 9, since: 1 }, requests: 900, windowCost: 0 },
  )
  assert.equal(report?.turns?.count, 9)
  assert.equal(report?.turns?.unitsPerTurn, null, 'nine is too few to call a rate')
})

test('a runtime the ledger was never told about has no turns at all — never a zero', async () => {
  const report = await oneReport({ kinds: ['windows'] }, { turns: null, requests: 0, windowCost: 0 })
  assert.equal(report?.turns, undefined)
})

test('zero turns in the window is the same as none — nothing to price yet', async () => {
  const report = await oneReport({ kinds: ['allowance'] }, { turns: { count: 0, since: 1 }, requests: 0, windowCost: 0 })
  assert.equal(report?.turns, undefined)
})

test('a SpendSource with no turnsFor at all — an older ledger — reports no turns rather than throwing', async () => {
  const usage = new UsageService({
    runtimes: () => [runtime()],
    meters: new Map([[RUNTIME, meterWith({ kinds: ['allowance'] })]]),
    spend: { spendFor: () => money(0) },
    onReport: () => {},
  })
  const [report] = await usage.reports()
  assert.equal(report?.turns, undefined)
  usage.dispose()
})

test('a desk-sourced runtime\'s rate is exact or null, never account-wide requests over desk-only turns', async () => {
  const allowance = await oneReport(
    { kinds: ['allowance'] },
    { turns: { count: 20, since: 1, source: 'desk' }, requests: 100, windowCost: 0 },
  )
  assert.equal(allowance?.turns?.count, 20, 'the count itself is still honest')
  assert.equal(allowance?.turns?.unitsPerTurn, null, 'desk-only turns never divide an account-wide request count')

  const balance = await oneReport(
    { kinds: ['balance'] },
    { turns: { count: 15, since: 1, source: 'desk' }, requests: 0, windowCost: 30 },
  )
  assert.equal(balance?.turns?.unitsPerTurn, null, 'desk-only turns never divide an account-wide balance either')
})

test('an agent-sourced runtime still prices a turn — the desk-sourced rule does not blanket every runtime', async () => {
  const report = await oneReport(
    { kinds: ['allowance'] },
    { turns: { count: 20, since: 1, source: 'agent' }, requests: 100, windowCost: 0 },
  )
  assert.equal(report?.turns?.unitsPerTurn, 5, 'an agent\'s own transcript covers standalone use exactly as well as desk use')
})
