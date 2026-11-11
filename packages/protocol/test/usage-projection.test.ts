import assert from 'node:assert/strict'
import { test } from 'node:test'

import { isSilentUsage, runtimeId, supersededUsageNotices, trackedUsage, usageCrossingKey, type UsageReport } from '../src/index.js'

const NOW = Date.UTC(2026, 10, 11, 12, 0, 0)
const report = (runtime: string, patch: Partial<UsageReport> = {}): UsageReport => ({
  runtime: runtimeId(runtime), account: null, plan: null, lanes: [], credits: null, spend: null, reached: null,
  source: { kind: 'api', label: 'from its API' }, fetchedAt: NOW - 60_000, staleAfterMs: 15 * 60_000, error: null, ...patch,
})

test('every tracked agent is one entry: its readings, or one that says it is not reporting', () => {
  const runtimes = ['claude', 'codex', 'codex-2', 'opencode', 'gemini'].map(id => ({ id: runtimeId(id) }))
  const reports = [report('claude'), report('codex'), report('codex-2', { spend: { currency: 'USD', todayCost: 1, windowCost: 2115, windowDays: 30, provenance: 'reported' } as never }), report('gone')]
  const tracked = trackedUsage(runtimes, reports, [runtimeId('codex-2')], NOW)
  assert.deepEqual(tracked.map(one => [one.runtime, isSilentUsage(one)]), [
    ['claude', false], ['codex', false], ['opencode', true], ['gemini', true],
  ])
  // A silent entry claims no reading: it was never read, so it has no read time of its own.
  const silent = tracked.find(one => one.runtime === 'opencode')!
  assert.equal(silent.lanes.length, 0)
  assert.equal(silent.fetchedAt, NOW)
  assert.equal(isSilentUsage(report('claude')), false)
})

test('an allowance notice leaves once a newer read no longer says what it said', () => {
  const HOUR = 3_600_000
  const weekly = (used: number, resetsAt: number) => [{ id: 'weekly', label: 'Weekly', usedPercent: used, usageKnown: true, windowMinutes: 7 * 24 * 60, resetsAt }]
  const at = NOW - 3 * 24 * HOUR
  const reset = NOW + 4 * 24 * HOUR
  const notice = (key: string, when = at) => ({ id: key, contentKey: key, kind: 'usage:crossing', at: when })
  const still = usageCrossingKey({ runtime: runtimeId('codex'), account: 'dev@example.com', lane: 'weekly', resetsAt: reset, threshold: 80 })
  const dropped = usageCrossingKey({ runtime: runtimeId('claude'), account: null, lane: 'weekly', resetsAt: reset, threshold: 95 })
  const renewed = usageCrossingKey({ runtime: runtimeId('codex'), account: 'team@acme.dev', lane: 'weekly', resetsAt: NOW - HOUR, threshold: 80 })
  const unread = usageCrossingKey({ runtime: runtimeId('cursor'), account: null, lane: 'weekly', resetsAt: reset, threshold: 80 })
  const reports = [
    report('codex', { account: 'dev@example.com', lanes: weekly(84, reset) as never }),
    // The window filled past 95% and then a newer read says it is under it: the notice no longer holds.
    report('claude', { lanes: weekly(40, reset) as never }),
    // A new cycle opened: the figures the notice gave belong to a window that has gone.
    report('codex', { account: 'team@acme.dev', lanes: weekly(85, NOW + 7 * 24 * HOUR - HOUR) as never }),
  ]
  const entries = [
    notice(still), notice(dropped), notice(renewed), notice(unread),
    // A notice from before crossings carried their figures, and that names no agent: nothing can say it is over, so it stays.
    notice('info:usage:crossing:legacy'),
    // Not a usage notice: never touched.
    { id: 'other', contentKey: 'other', kind: 'app:background', at },
  ]
  assert.deepEqual([...supersededUsageNotices(entries, reports, NOW)].sort(), [dropped, renewed].sort())
  // With no read newer than a notice, nothing is superseded: there is nothing newer to have said otherwise.
  assert.deepEqual([...supersededUsageNotices([notice(dropped, NOW)], reports, NOW)], [])
})

test('a notice from before crossings carried figures leaves only when its own agent has been read again', () => {
  const at = NOW - 3 * 24 * 3_600_000
  const legacy = (id: string, title: string) => ({ id, kind: 'usage:crossing', at, title })
  const names = new Map([[runtimeId('codex'), 'Codex'], [runtimeId('codex-2'), 'Codex 2'], [runtimeId('cursor'), 'Cursor'], [runtimeId('claude'), 'Claude Code']])
  const entries = [
    legacy('codex-old', 'Codex — Weekly is 80% used, 20% left.'),
    // The longer name wins: this one is Codex 2's, and Codex 2 has not been read since.
    legacy('codex-2-old', 'Codex 2 · Jane Doe — Weekly is 95% used.'),
    legacy('cursor-old', 'Cursor — Requests is 80% used.'),
    // Every account of the agent must have been read since: one of Claude Code's two has not.
    legacy('claude-old', 'Claude Code · dev@example.com — Session is 80% used.'),
    legacy('nobody', 'Something else — Weekly is 80% used.'),
  ]
  const reports = [
    report('codex', { account: 'dev@example.com' }), report('codex', { account: 'team@acme.dev' }),
    report('cursor', { fetchedAt: at - 1 }),
    report('claude', { account: 'dev@example.com' }), report('claude', { account: 'team@acme.dev', fetchedAt: at - 1 }),
  ]
  assert.deepEqual([...supersededUsageNotices(entries, reports, NOW, names)], ['codex-old'])
  // Without names nothing can be told, and every one of them stays.
  assert.deepEqual([...supersededUsageNotices(entries, reports, NOW)], [])
})

test('Not reporting is said of an agent that was asked, never of one a fresh start has not read yet', () => {
  const runtimes = ['claude', 'codex'].map(id => ({ id: runtimeId(id) }))
  // Straight after a start the cache is empty and nothing has been asked: no claim either way.
  assert.deepEqual(trackedUsage(runtimes, [], [], NOW, () => false), [])
  // Once the first read finishes, an agent that answered nothing is the one that is not reporting.
  const after = trackedUsage(runtimes, [report('claude')], [], NOW, id => id === runtimeId('codex') || id === runtimeId('claude'))
  assert.deepEqual(after.map(one => [one.runtime, isSilentUsage(one)]), [['claude', false], ['codex', true]])
  // Only the flag makes a stand-in: a real report that happens to have nothing in it is a reading, not silence.
  const empty = report('codex', { source: { kind: 'runtime', label: 'no source available' } })
  assert.equal(isSilentUsage(empty), false)
  assert.equal(after.find(one => one.runtime === runtimeId('codex'))!.notReporting, true)
})
