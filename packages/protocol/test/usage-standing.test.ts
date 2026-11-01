import assert from 'node:assert/strict'
import { test } from 'node:test'

import { laneRunsOutAt, usageStandingOf, type UsageLane, type UsageReport } from '../src/index.js'

const NOW = Date.UTC(2026, 10, 1, 12, 0)
const HOUR = 3_600_000

const lane = (over: Partial<UsageLane> = {}): UsageLane => ({
  id: 'session',
  label: 'Session',
  usedPercent: 10,
  windowMinutes: 300,
  resetsAt: NOW + 4 * HOUR,
  ...over,
})

const report = (over: Partial<UsageReport> = {}): UsageReport => ({
  runtime: 'claude' as UsageReport['runtime'],
  account: 'dev@example.com',
  plan: null,
  lanes: [lane()],
  credits: null,
  spend: null,
  reached: null,
  source: { kind: 'api', label: 'from the account' },
  fetchedAt: NOW,
  staleAfterMs: 600_000,
  error: null,
  ...over,
})

test('an account with room, burning slowly, is ready', () => {
  const standing = usageStandingOf(report(), NOW)
  assert.equal(standing.status, 'ready')
  assert.equal(standing.left, 90)
  assert.equal(standing.runsOutAt, null)
})

test('a failed reading is unknown whatever its lanes say', () => {
  const standing = usageStandingOf(report({ error: { message: 'no answer' } }), NOW)
  assert.equal(standing.status, 'unknown')
})

test('a spent account-wide lane is out, and says when it is back', () => {
  const standing = usageStandingOf(report({ lanes: [lane({ usedPercent: 100 })] }), NOW)
  assert.equal(standing.status, 'out')
  assert.equal(standing.backAt, NOW + 4 * HOUR)
})

test('a spent model is not a spent account', () => {
  const standing = usageStandingOf(
    report({ lanes: [lane(), lane({ id: 'opus', label: 'Weekly', scope: 'Opus', usedPercent: 100, windowMinutes: 10_080 })] }),
    NOW,
  )
  assert.equal(standing.status, 'ready')
  assert.equal(standing.scopedOut?.id, 'opus')
})

test('a rate that empties the window before its reset is short, with the time', () => {
  // One hour into a five-hour window with 60% gone: empty in 40 minutes.
  const burning = lane({ usedPercent: 60, resetsAt: NOW + 4 * HOUR })
  const standing = usageStandingOf(report({ lanes: [burning] }), NOW)
  assert.equal(standing.status, 'short')
  assert.equal(standing.runsOutAt, laneRunsOutAt(burning, NOW))
  assert.ok(standing.runsOutAt !== null && standing.runsOutAt - NOW === 40 * 60_000)
})

test('a window too new to extrapolate is not short', () => {
  const fresh = lane({ usedPercent: 4, resetsAt: NOW + 5 * HOUR - 60_000 })
  assert.equal(laneRunsOutAt(fresh, NOW), null)
  assert.equal(usageStandingOf(report({ lanes: [fresh] }), NOW).status, 'ready')
})

test('a low weekly behind a healthy session is low', () => {
  const standing = usageStandingOf(
    report({
      lanes: [
        lane({ resetsAt: NOW + 4.5 * HOUR }),
        lane({ id: 'weekly', label: 'Weekly', usedPercent: 85, windowMinutes: 10_080, resetsAt: NOW + 160 * HOUR }),
      ],
    }),
    NOW,
  )
  assert.equal(standing.status, 'low')
})

test('a balance below zero is overdrawn; at zero it is out; above it is ready', () => {
  const credits = (remaining: number): UsageReport['credits'] => ({ remaining, unit: 'USD' })
  assert.equal(usageStandingOf(report({ lanes: [], credits: credits(-2.15) }), NOW).status, 'overdrawn')
  // A source that also says the credits limit was reached is still a debt, not a reset to wait for.
  assert.equal(usageStandingOf(report({ lanes: [], credits: credits(-0.016), reached: 'credits' }), NOW).status, 'overdrawn')
  assert.equal(usageStandingOf(report({ lanes: [], credits: credits(0) }), NOW).status, 'out')
  assert.equal(usageStandingOf(report({ lanes: [], credits: credits(8.8) }), NOW).status, 'ready')
})

test('a balance beside a measured plan lane does not decide the standing', () => {
  const standing = usageStandingOf(report({ credits: { remaining: -1, unit: 'USD' } }), NOW)
  assert.equal(standing.status, 'ready')
})
