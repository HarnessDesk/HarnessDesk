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
    // A notice from before crossings carried their figures, with a newer read on the desk, says nothing checkable.
    notice('info:usage:crossing:legacy'),
    // Not a usage notice: never touched.
    { id: 'other', contentKey: 'other', kind: 'app:background', at },
  ]
  assert.deepEqual([...supersededUsageNotices(entries, reports, NOW)].sort(), [dropped, renewed, 'info:usage:crossing:legacy'].sort())
  // With no read newer than a notice, nothing is superseded: there is nothing newer to have said otherwise.
  assert.deepEqual([...supersededUsageNotices([notice(dropped, NOW)], reports, NOW)], [])
})
