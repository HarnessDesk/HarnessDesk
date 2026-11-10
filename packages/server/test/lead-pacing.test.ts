import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { UsageReport } from '@harnessdesk/protocol'
import { choosePacedAccount, pacingPort, type PacingRuntime } from '../src/lead/pacing.js'

const NOW = Date.UTC(2026, 10, 9, 12, 0, 0)
const H = 3_600_000
const runtimes: PacingRuntime[] = [
  { id: 'codex', agent: 'codex', name: 'Codex' },
  { id: 'codex-2', agent: 'codex', name: 'Codex' },
  { id: 'codex-3', agent: 'codex', name: 'Codex' },
  { id: 'claude', agent: 'claude', name: 'Claude Code' },
]
const report = (runtime: string, used: number, resetsIn: number, patch: Partial<UsageReport> = {}): UsageReport => ({
  runtime, account: null, plan: 'Pro', lanes: [{ id: 'session', label: '5 hour', usedPercent: used, windowMinutes: 300, resetsAt: NOW + resetsIn }],
  credits: null, spend: null, reached: used >= 100 ? 'session' : null, source: { kind: 'api', label: 'test' },
  fetchedAt: NOW - 1000, staleAfterMs: 900_000, error: null, ...patch,
} as unknown as UsageReport)
const choose = (pools: unknown, reports: UsageReport[], startable = runtimes, defaultRuntime: string | null = 'codex') =>
  choosePacedAccount({ startable, defaultRuntime, pools, reportOf: id => reports.find(one => one.runtime === id) ?? null, now: NOW })

test('with soonest-reset on, the account that refills first and has room is chosen and named', () => {
  const reports = [report('codex', 20, 4 * H), report('codex-2', 50, 2 * H), report('codex-3', 10, 3 * H)]
  assert.deepEqual(choose({ codex: { pace: 'soonest' } }, reports), { agent: 'codex-2', label: 'Codex · Pro · account 2' })
})

test('an account that is out is skipped, however soon it resets', () => {
  const reports = [report('codex', 20, 4 * H), report('codex-2', 100, H / 2), report('codex-3', 10, 3 * H)]
  assert.equal(choose({ codex: { pace: 'soonest' } }, reports)?.agent, 'codex-3')
})

test('without the setting, or with one account, or with every account out, the desk default stands', () => {
  const reports = [report('codex', 20, 4 * H), report('codex-2', 50, 2 * H)]
  assert.equal(choose({ codex: { whenOut: 'next' } }, reports), null)
  assert.equal(choose(undefined, reports), null)
  assert.equal(choose({ codex: { pace: 'soonest' } }, reports, [runtimes[0]!, runtimes[3]!]), null)
  assert.equal(choose({ codex: { pace: 'soonest' } }, [report('codex', 100, H), report('codex-2', 100, H), report('codex-3', 100, H)]), null)
  assert.equal(choose({ claude: { pace: 'soonest' } }, reports), null)
})

test('the person order decides ties, and a reading that is stale ranks behind a clear one', () => {
  const same = [report('codex', 20, 2 * H), report('codex-2', 20, 2 * H), report('codex-3', 20, 2 * H)]
  assert.equal(choose({ codex: { pace: 'soonest', order: ['codex-3', 'codex'] } }, same)?.agent, 'codex-3')
  const stale = [report('codex', 20, H, { fetchedAt: NOW - 5 * H }), report('codex-2', 20, 3 * H)]
  assert.equal(choose({ codex: { pace: 'soonest' } }, stale)?.agent, 'codex-2')
})

test('a "reached" that is stale or past its reset is unknown, not out, so that account can still be chosen', () => {
  const stale = [report('codex', 100, H, { fetchedAt: NOW - 5 * H }), report('codex-2', 100, H)]
  assert.equal(choose({ codex: { pace: 'soonest' } }, stale)?.agent, 'codex', 'the stale one stays in play; the fresh out one is dropped')
  const refilled = [report('codex', 100, -H), report('codex-2', 100, H)]
  assert.equal(choose({ codex: { pace: 'soonest' } }, refilled)?.agent, 'codex')
})

test('the pool is the one of the desk default, which is named rather than taken from the list head', () => {
  const reports = [report('claude', 20, 4 * H), report('codex', 90, 5 * H), report('codex-2', 50, 2 * H)]
  const startable = [runtimes[3]!, runtimes[0]!, runtimes[1]!]
  assert.equal(choose({ codex: { pace: 'soonest' } }, reports, startable, 'codex')?.agent, 'codex-2')
  assert.equal(choose({ codex: { pace: 'soonest' } }, reports, startable, 'claude'), null, 'claude has no pool and one account')
  assert.equal(choose({ codex: { pace: 'soonest' } }, reports, startable, 'codex-3'), null, 'a default that cannot start leaves nothing to pace')
  assert.equal(choose({ codex: { pace: 'soonest' } }, reports, startable, null), null)
})

test('the host composition reads preferences, keys the pool by the agent of the default, and skips what cannot start', async () => {
  const info: Record<string, { slot?: { agent: string }; presentation: { name: string } }> = {
    codex: { presentation: { name: 'Codex' } },
    'codex-2': { slot: { agent: 'codex' }, presentation: { name: 'Codex' } },
    claude: { presentation: { name: 'Claude Code' } },
  }
  const reports = [report('codex', 90, 5 * H), report('codex-2', 40, 2 * H), report('claude', 10, H)]
  const port = (patch: { start?: string[]; def?: string | null; prefs?: Record<string, unknown> } = {}) => pacingPort({
    startableAgents: () => patch.start ?? ['claude', 'codex', 'codex-2'],
    infoOf: id => info[id],
    defaultRuntime: () => patch.def === undefined ? 'codex' : patch.def,
    preferences: () => patch.prefs ?? { accountPools: { codex: { pace: 'soonest' } } },
    usage: id => reports.find(one => one.runtime === id) ?? null,
    now: () => NOW,
  })
  assert.deepEqual(await port().choose(), { agent: 'codex-2', label: 'Codex · Pro · account 2' })
  assert.equal(await port({ prefs: { accountPools: { 'codex-2': { pace: 'soonest' } } } }).choose(), null, 'the pool is keyed by the agent, not by an extra account id')
  assert.equal(await port({ prefs: {} }).choose(), null)
  assert.equal(await port({ def: 'claude' }).choose(), null)
  assert.equal(await port({ start: ['claude', 'codex-2'] }).choose(), null, 'a default that cannot start is not paced around')
})
