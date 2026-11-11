import assert from 'node:assert/strict'
import { test } from 'node:test'

import { keptReading, laneRunsOutAt, usageStandingOf, type UsageLane, type UsageReport } from '../src/index.js'

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

test('a failed refresh with no figures of its own is unknown', () => {
  const standing = usageStandingOf(report({ lanes: [], error: { message: 'no answer' } }), NOW)
  assert.equal(standing.status, 'unknown')
  assert.equal(keptReading(report({ lanes: [], error: { message: 'no answer' } })), false)
})

test('a failed refresh keeps the last good figures and their standing, dated when they were read (#2094)', () => {
  const kept = report({ lanes: [lane({ usedPercent: 38 })], fetchedAt: NOW - 25 * 60_000, error: { message: 'no answer' } })
  assert.equal(keptReading(kept), true)
  const standing = usageStandingOf(kept, NOW)
  assert.equal(standing.status, 'ready')
  assert.equal(standing.left, 62)
})

test('a kept reading never forecasts a run-out from figures it could not refresh', () => {
  // Fresh, this burn is Short; read before the refresh failed, the rate is not known, so it says only what is left.
  const burning = lane({ usedPercent: 60, resetsAt: NOW + 4 * HOUR })
  assert.equal(usageStandingOf(report({ lanes: [burning] }), NOW).status, 'short')
  const standing = usageStandingOf(report({ lanes: [burning], error: { message: 'no answer' } }), NOW)
  assert.equal(standing.status, 'ready')
  assert.equal(standing.runsOutAt, null)
})

test('a kept reading that was Out stops saying Out once its window has reset', () => {
  const out = report({ lanes: [lane({ id: 'weekly', usedPercent: 100, resetsAt: NOW + HOUR })] })
  assert.equal(usageStandingOf(out, NOW).status, 'out')
  assert.equal(usageStandingOf(out, NOW).backAt, NOW + HOUR)
  // The refresh after its reset fails, so the only figures are the ones read while it was out.
  const kept = { ...out, error: { message: 'no answer' } }
  const before = usageStandingOf(kept, NOW + HOUR / 2)
  assert.equal(before.status, 'out')
  assert.equal(before.backAt, NOW + HOUR)
  const after = usageStandingOf(kept, NOW + 2 * HOUR)
  assert.notEqual(after.status, 'out')
  assert.equal(after.status, 'unknown')
  assert.equal(after.backAt, null)
})

test('a kept balance is still a reading: a failed refresh of a prepaid account keeps its amount', () => {
  const kept = report({ lanes: [], credits: { remaining: 4.5, unit: 'USD', unlimited: false }, error: { message: 'no answer' } })
  assert.equal(keptReading(kept), true)
  assert.notEqual(usageStandingOf(kept, NOW).status, 'unknown')
})

test('a spent account-wide lane is out, and says when it is back', () => {
  const standing = usageStandingOf(report({ lanes: [lane({ usedPercent: 100 })] }), NOW)
  assert.equal(standing.status, 'out')
  assert.equal(standing.backAt, NOW + 4 * HOUR)
})

test('with two account-wide windows spent, it is back when the last of them resets', () => {
  const standing = usageStandingOf(
    report({
      lanes: [
        lane({ usedPercent: 100, resetsAt: NOW + 4 * HOUR }),
        lane({ id: 'weekly', label: 'Weekly', usedPercent: 100, windowMinutes: 10_080, resetsAt: NOW + HOUR }),
      ],
      reached: 'weekly',
    }),
    NOW,
  )
  assert.equal(standing.status, 'out')
  assert.equal(standing.backAt, NOW + 4 * HOUR)
})

test('a spent window that gives no reset leaves the account without a Back time', () => {
  const standing = usageStandingOf(
    report({ lanes: [lane({ usedPercent: 100 }), lane({ id: 'weekly', label: 'Weekly', usedPercent: 100, resetsAt: null })] }),
    NOW,
  )
  assert.equal(standing.status, 'out')
  assert.equal(standing.backAt, null)
})

test('a reached limit no lane explains withholds the Back time, even beside a spent window', () => {
  const standing = usageStandingOf(report({ lanes: [lane({ usedPercent: 100 })], reached: 'spend_limit_reached' }), NOW)
  assert.equal(standing.status, 'out')
  assert.equal(standing.backAt, null)
})

test('with every model spent, it is back when the first of them resets', () => {
  const standing = usageStandingOf(
    report({
      lanes: [
        lane({ id: 'opus', label: 'Opus', scope: 'Opus', usedPercent: 100, resetsAt: NOW + 3 * HOUR }),
        lane({ id: 'sonnet', label: 'Sonnet', scope: 'Sonnet', usedPercent: 100, resetsAt: NOW + HOUR }),
      ],
    }),
    NOW,
  )
  assert.equal(standing.status, 'out')
  assert.equal(standing.backAt, NOW + HOUR)
})

test('a reached limit that names no lane is out, but borrows no reset from a healthy lane', () => {
  const standing = usageStandingOf(report({ reached: 'spend_limit_reached' }), NOW)
  assert.equal(standing.status, 'out')
  assert.equal(standing.backAt, null)
})

test('a spent model is not a spent account', () => {
  const standing = usageStandingOf(
    report({ lanes: [lane(), lane({ id: 'opus', label: 'Weekly', scope: 'Opus', usedPercent: 100, windowMinutes: 10_080 })] }),
    NOW,
  )
  assert.equal(standing.status, 'ready')
  assert.equal(standing.scopedOut?.id, 'opus')
})

test('a kept reading still names the model it last read as spent', () => {
  const standing = usageStandingOf(
    report({
      lanes: [lane(), lane({ id: 'opus', label: 'Weekly', scope: 'Opus', usedPercent: 100, windowMinutes: 10_080 })],
      error: { message: 'no answer' },
    }),
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

test('a weekly that runs out before its reset is short behind a healthy session, and is the lane named', () => {
  // A day before the weekly reset with 90% gone: it empties in about 2.3 hours.
  const weekly = lane({ id: 'weekly', label: 'Weekly', usedPercent: 90, windowMinutes: 10_080, resetsAt: NOW + 24 * HOUR })
  const standing = usageStandingOf(report({ lanes: [lane(), weekly] }), NOW)
  assert.equal(standing.status, 'short')
  assert.equal(standing.lane?.id, 'weekly')
  assert.equal(standing.left, 10)
  assert.equal(standing.runsOutAt, laneRunsOutAt(weekly, NOW))
})

test('when every model is spent the account is out, not one model out', () => {
  const scoped = (id: string) => lane({ id, label: id, scope: id, usedPercent: 100 })
  const standing = usageStandingOf(report({ lanes: [scoped('opus'), scoped('sonnet')] }), NOW)
  assert.equal(standing.status, 'out')
  assert.equal(standing.scopedOut, null)
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
  // It says the window that is low, not the healthy Session in front of it.
  assert.equal(standing.lane?.id, 'weekly')
  assert.equal(standing.left, 15)
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

test('a debt beside a healthy key limit is overdrawn when the source says the credits are what it hit', () => {
  const standing = usageStandingOf(report({ credits: { remaining: -0.4, unit: 'USD' }, reached: 'credits' }), NOW)
  // Plans reads the same report as Overdrawn; the card and the phone must not say Out.
  assert.equal(standing.status, 'overdrawn')
  assert.equal(standing.backAt, null)
})

test('the scoped model the source reached is the one named out, ahead of an earlier spent one', () => {
  const standing = usageStandingOf(
    report({
      lanes: [
        lane(),
        lane({ id: 'sonnet', label: 'Weekly', scope: 'Sonnet', usedPercent: 100, windowMinutes: 10_080 }),
        lane({ id: 'opus', label: 'Weekly', scope: 'Opus', usedPercent: 100, windowMinutes: 10_080 }),
      ],
      reached: 'opus',
    }),
    NOW,
  )
  assert.equal(standing.status, 'ready')
  assert.equal(standing.scopedOut?.id, 'opus')
})

test('a standing the balance decided carries no lane figure or reset beside it', () => {
  for (const remaining of [-0.4, 0]) {
    const standing = usageStandingOf(report({ credits: { remaining, unit: 'USD' }, reached: 'credits' }), NOW)
    assert.equal(standing.status, remaining < 0 ? 'overdrawn' : 'out')
    assert.equal(standing.lane, null)
    assert.equal(standing.left, null)
  }
})
