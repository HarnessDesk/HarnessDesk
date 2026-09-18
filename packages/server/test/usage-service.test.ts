import assert from 'node:assert/strict'
import { test } from 'node:test'

import { runtimeId, type AgentRuntime, type RuntimeId, type SpendSummary, type UsageReport } from '@harnessdesk/protocol'

import { UsageService } from '../src/usage/service.js'
import type { MeterReading, UsageMeter } from '../src/usage/meter.js'

/**
 * What the service does when the ledger finishes after the screen is open.
 *
 * A first scan of a machine takes tens of seconds and lands long after the
 * cards are drawn. The money has to reach them without any account being
 * asked a second time — that is the whole point of `settleSpend`.
 */

const METERED = runtimeId('metered')
const SILENT = runtimeId('silent')

const runtime = (id: RuntimeId): AgentRuntime =>
  ({
    info: { id, name: String(id), capabilities: { metered: false }, presentation: { name: String(id) } },
    getRateLimits: async () => null,
    getAccount: async () => ({ accounts: [], signInMethods: [] }),
  }) as unknown as AgentRuntime

const meter: UsageMeter = {
  id: 'test',
  source: { kind: 'file', label: 'from a fixture' },
  read: async (): Promise<MeterReading> => ({
    lanes: [{ id: 'weekly', label: 'Weekly', usedPercent: 40, windowMinutes: 10_080, resetsAt: null }],
    plan: 'Test',
    account: 'someone@example.com',
    credits: null,
    reached: null,
    fetchedAt: 1_000,
    staleAfterMs: 60_000,
  }),
  watchPaths: () => [],
}

const money = (windowCost: number): SpendSummary => ({
  currency: 'USD',
  todayCost: 1,
  windowCost,
  windowDays: 30,
  todayTokens: 10,
  windowTokens: 100,
  provenance: 'listPrice',
  coverage: { priced: 1, unpriced: 0, unmetered: 0, estimated: 0, daysCovered: 1, daysRequested: 30 },
  daily: [],
})

const service = (spendFor: (id: RuntimeId) => SpendSummary | null, seen: UsageReport[]): UsageService =>
  new UsageService({
    runtimes: () => [runtime(METERED), runtime(SILENT)],
    meters: new Map([[METERED, meter]]),
    spend: { spendFor },
    onReport: (report) => seen.push(report),
  })

test('a scan that lands late restates the money without asking again', async () => {
  const seen: UsageReport[] = []
  let scanned = false
  const usage = service((id) => (scanned && id === METERED ? money(12.5) : null), seen)

  const first = await usage.reports()
  assert.equal(first.length, 1, 'only the agent with a meter has anything to say yet')
  assert.equal(first[0]?.spend, null)

  scanned = true
  await usage.settleSpend()

  const restated = usage.cached(METERED)
  assert.equal(restated?.spend?.windowCost, 12.5)
  assert.equal(restated?.fetchedAt, 1_000, 'the reading itself is untouched — only the money changed')
  assert.equal(seen.at(-1)?.runtime, METERED, 'and the renderer hears about it')
  usage.dispose()
})

test('money alone earns a card for an agent that had nothing to report', async () => {
  const seen: UsageReport[] = []
  let scanned = false
  const usage = service((id) => (scanned && id === SILENT ? money(3) : null), seen)

  assert.equal((await usage.reports()).length, 1)
  assert.equal(usage.cached(SILENT), null, 'nothing to say is no card')

  scanned = true
  await usage.settleSpend()
  assert.equal(usage.cached(SILENT)?.spend?.windowCost, 3)
  assert.equal(usage.cached(SILENT)?.source.kind, 'ledger', 'a card made of money says where the money came from')
  usage.dispose()
})

test('a source that fails keeps the last good reading, with the failure beside it', async () => {
  const seen: UsageReport[] = []
  let failing = false
  const flaky: AgentRuntime = {
    info: { id: METERED, name: 'metered', capabilities: { metered: true }, presentation: { name: 'metered' } },
    getRateLimits: async () => {
      if (failing) throw new Error('the provider is down')
      return { planType: 'Pro', windows: [{ label: 'Weekly', usedPercent: 30, windowMinutes: 10_080, resetsAt: null }] }
    },
    getAccount: async () => ({ accounts: [], signInMethods: [] }),
  } as unknown as AgentRuntime

  const usage = new UsageService({
    runtimes: () => [flaky],
    meters: new Map(),
    spend: { spendFor: () => null },
    onReport: (report) => seen.push(report),
    now: () => 5_000,
  })

  const good = (await usage.reports())[0]
  assert.equal(good?.lanes.length, 1)

  failing = true
  const after = (await usage.refresh())[0]
  assert.equal(after?.lanes.length, 1, 'the lanes we knew about are still the best we have')
  assert.equal(after?.fetchedAt, good?.fetchedAt, 'and they are still dated when they were read')
  assert.equal(after?.error?.message, 'the provider is down')
  usage.dispose()
})

/** A meter that answers from a script, one step per read, and throws on a string. */
const scriptedMeter = (steps: (MeterReading | string | null)[]): UsageMeter => ({
  id: 'scripted',
  source: { kind: 'api', label: 'from a script' },
  read: async () => {
    const step = steps.shift()
    if (typeof step === 'string') throw new Error(step)
    return step ?? null
  },
  watchPaths: () => [],
})

const weekly = (usedPercent: number, fetchedAt: number): MeterReading => ({
  lanes: [{ id: 'weekly', label: 'Weekly', usedPercent, windowMinutes: 10_080, resetsAt: null }],
  plan: null,
  account: null,
  credits: null,
  reached: usedPercent >= 100 ? 'weekly' : null,
  fetchedAt,
  staleAfterMs: 60_000,
})

test('a meter that fails keeps its last good reading, with the failure beside it', async () => {
  // It used to be dropped as silence however recently it had answered, so a
  // single 503 took the card back to "no source available".
  const usage = new UsageService({
    runtimes: () => [runtime(METERED)],
    meters: new Map([[METERED, scriptedMeter([weekly(30, 1_000), 'the quota service is down'])]]),
    onReport: () => undefined,
  })
  const good = (await usage.refresh(METERED))[0]
  assert.equal(good?.lanes[0]?.usedPercent, 30)

  const after = (await usage.refresh(METERED))[0]
  assert.equal(after?.lanes[0]?.usedPercent, 30, 'the lanes we knew about are still the best we have')
  assert.equal(after?.fetchedAt, 1_000, 'and they are still dated when they were read')
  assert.equal(after?.error?.message, 'the quota service is down')
  usage.dispose()
})

test('a meter that fails before it has ever answered is still no card', async () => {
  const logged: string[] = []
  const usage = new UsageService({
    runtimes: () => [runtime(METERED)],
    meters: new Map([[METERED, scriptedMeter(['the quota service is down'])]]),
    onReport: () => undefined,
    log: (message) => logged.push(message),
  })
  assert.deepEqual(await usage.refresh(METERED), [])
  assert.deepEqual(logged, ['a usage meter failed'])
  usage.dispose()
})

test("another sign-in's figures are drawn beside the report and never read as the agent's own", async () => {
  // Antigravity's: the `agy` CLI signs in apart from the ACP server, so its
  // quota may be another Google account's. Readiness, the strip and the tray
  // reduce over `lanes`; with the figures elsewhere, none of them can gate
  // the agent on them.
  const spentElsewhere: MeterReading = { ...weekly(100, 2_000), unverified: 'agy CLI sign-in' }
  const signedIn = {
    ...runtime(METERED),
    getAccount: async () => ({ accounts: [{ kind: 'agent', label: 'Google account' }], signInMethods: [] }),
  } as unknown as AgentRuntime
  const usage = new UsageService({
    runtimes: () => [signedIn],
    meters: new Map([[METERED, scriptedMeter([spentElsewhere, 'agy /usage failed: HTTP 503'])]]),
    onReport: () => undefined,
    // Inside the reading's freshness, so `limitsFor` answers from the cache.
    now: () => 3_000,
  })

  const report = (await usage.refresh(METERED))[0]
  assert.deepEqual(report?.lanes, [], 'nothing in the lanes that decide whether the agent can run')
  assert.equal(report?.reached, null)
  assert.equal(report?.unverified?.whose, 'agy CLI sign-in')
  assert.equal(report?.unverified?.lanes[0]?.usedPercent, 100)
  assert.equal(report?.unverified?.reached, 'weekly')
  assert.equal(report?.account, 'Google account', "the agent's own account is not lent to another sign-in's quota")
  assert.equal(report?.source.label, 'from a script')
  assert.equal(await usage.limitsFor(signedIn), null, 'the strip, the ring and the Settings card see nothing')

  // A failure keeps those figures the way it keeps an agent's own — and it is
  // that sign-in's failure, not the agent's: `report.error` is what makes the
  // chip read "Unavailable", and a failing `agy` says nothing about the agent.
  const after = (await usage.refresh(METERED))[0]
  assert.equal(after?.unverified?.lanes[0]?.usedPercent, 100)
  assert.equal(after?.unverified?.fetchedAt, 2_000, 'still dated when they were read')
  assert.equal(after?.unverified?.error?.message, 'agy /usage failed: HTTP 503')
  assert.equal(after?.error, null)
  usage.dispose()
})
