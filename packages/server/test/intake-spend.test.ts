import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { UsageSample } from '../src/ledger/insight.js'
import { attributeSample, goalSpend, meterSample, meterTotal, meterTurn, openMeter, spendOf, type SessionMeter } from '../src/intake/spend.js'

/*
 * A trigger Goal's spend is each of its Seats' own attributed cost, from
 * Insight's source-qualified samples: counted once, never a runtime-wide or
 * shared total, and unknown — never zero — whenever it cannot be vouched for.
 */

const source = { id: 'source', kind: 'corpus' as const, label: 'Recorded usage', observedAt: 10, checkedAt: 10, stale: false, problem: null }
const exact = (value: number) => ({ value, quality: 'exact' as const })

const sample = (over: Partial<UsageSample> = {}): UsageSample => ({
  key: 'k1', source, runtime: 'alpha', sessionId: 's1', turnId: null, requestId: null, project: '/work/project', model: 'model-a',
  from: 100, to: 110, scope: 'session', includesChildren: null,
  input: exact(10), output: exact(10), cacheRead: exact(0), cacheWrite: exact(0),
  usd: exact(0.5), moneyBasis: 'vendorMetered', ...over,
})

const meter = (over: Partial<Parameters<typeof openMeter>[0]> = {}): SessionMeter => openMeter({
  seat: 'seat-1', runtime: 'alpha', sessionId: 's1', project: '/work/project', openedAt: 50, fresh: true, delegation: 'none', ...over,
})

const fold = (start: SessionMeter, samples: readonly UsageSample[]): SessionMeter => samples.reduce(meterSample, start)

test('usage is attributed once and unknown is never zero', () => {
  // A cumulative session total read again, or read twice, counts once: the delta from the Seat's own zero.
  const once = fold(meter(), [sample({ usd: exact(0.5) }), sample({ usd: exact(0.5) }), sample({ usd: exact(1.25), to: 120 })])
  assert.equal(meterTotal(once, 200).micros, 1_250_000)
  // A per-call sample counts once by its key; a replayed call is nothing.
  const calls = fold(meter(), [
    sample({ scope: 'call', key: 'c1', usd: exact(0.1) }), sample({ scope: 'call', key: 'c1', usd: exact(0.1) }), sample({ scope: 'call', key: 'c2', usd: exact(0.2) }),
  ])
  assert.equal(meterTotal(calls, 200).micros, 300_000)
  // Another session's sample changes nothing.
  assert.deepEqual(meterSample(meter(), sample({ sessionId: 's2' })), meter())

  // Every way a figure cannot be vouched for is unknown, and stays unknown.
  const unknowns: readonly [string, SessionMeter][] = [
    ['no dollars (credits, or nothing reported)', meterSample(meter(), sample({ usd: { value: null, quality: 'unknown' } }))],
    ['a floor, not a total', meterSample(meter(), sample({ usd: { value: 2, quality: 'floor' } }))],
    ['a missing price', meterSample(meter(), sample({ moneyBasis: 'unknown' }))],
    ['delegated work it cannot separate', meterSample(meter({ delegation: 'some' }), sample({ includesChildren: null }))],
    ['delegation the host cannot tell', meterSample(meter({ delegation: 'unknown' }), sample())],
    ['a total that went down', fold(meter(), [sample({ usd: exact(2) }), sample({ usd: exact(1), to: 130 })])],
    ['both kinds of total at once', fold(meter(), [sample({ scope: 'session' }), sample({ scope: 'call', key: 'c9' })])],
    ['a session not seen starting at zero', meterSample(meter({ fresh: false }), sample())],
    ['a list-price total across a model change', fold(meter(), [sample({ moneyBasis: 'listPrice', model: 'a' }), sample({ moneyBasis: 'listPrice', model: 'b', usd: exact(1) })])],
  ]
  for (const [what, one] of unknowns) {
    assert.equal(meterTotal(one, 200).micros, null, what)
    assert.ok(meterTotal(one, 200).why, `${what}: says why`)
    assert.equal(spendOf(one, 200).totalMicros, null, what)
    assert.equal(spendOf(one, 200).provenance, 'unknown', what)
    // Nothing later repairs it: a good sample after an unknown one is still unknown.
    assert.equal(meterTotal(meterSample(one, sample({ usd: exact(9), to: 999 })), 1000).micros, null, `${what}: stays unknown`)
  }
  // Delegated work whose inclusion the host knows is counted.
  assert.equal(meterTotal(meterSample(meter({ delegation: 'some' }), sample({ includesChildren: true })), 200).micros, 500_000)

  // A Seat that never had a turn has spent a known nothing; one that worked since its last reading has not been metered.
  assert.equal(meterTotal(meter(), 200).micros, 0)
  assert.equal(meterTotal(meterTurn(meter(), { started: 60, ended: 90 }), 200).micros, null)
  const read = meterTurn(once, { started: 121, ended: 125 })
  assert.equal(meterTotal(read, 200).micros, null, 'a turn ended after the last reading')
  const inTurn = meterTurn(once, { started: 125 })
  assert.equal(meterTotal(inTurn, 130).micros, 1_250_000)
  assert.equal(meterTotal(inTurn, 120 + 61_000).micros, null, 'a reading older than a minute during a turn')

  // One unknown Seat makes the Goal's spend unknown; never a partial sum.
  assert.deepEqual(goalSpend([once, calls], 200), { spentMicros: 1_550_000, provenance: 'vendorMetered', why: null })
  assert.equal(goalSpend([once, unknowns[0]![1]], 200).spentMicros, null)

  // Attribution: exactly one Seat's window, or nothing — never a runtime-wide or shared total.
  const window = (id: string, openedAt: number, closedAt: number | null) => ({ id, runtime: 'alpha', sessionId: 's1', project: '/work/project', openedAt, closedAt, restored: false })
  assert.equal(attributeSample(sample(), [window('seat-1', 50, null)]), 'seat-1')
  assert.equal(attributeSample(sample({ sessionId: null }), [window('seat-1', 50, null)]), null, 'a runtime-wide total')
  assert.equal(attributeSample(sample(), [window('seat-1', 50, null), window('seat-2', 60, null)]), null, 'two Seats could own it')
  assert.equal(attributeSample(sample({ from: 40 }), [window('seat-1', 50, null)]), null, 'from before the Seat opened')
})

test('vendor and list-price totals retain their provenance', () => {
  const vendor = fold(meter(), [sample({ usd: exact(0.4), moneyBasis: 'vendorMetered' })])
  const list = fold(meter({ seat: 'seat-2', sessionId: 's2' }), [
    sample({ sessionId: 's2', scope: 'call', key: 'c1', usd: exact(0.3), moneyBasis: 'listPrice' }),
    sample({ sessionId: 's2', scope: 'call', key: 'c2', usd: exact(0.1), moneyBasis: 'listPrice', model: 'model-b' }),
  ])
  assert.deepEqual([spendOf(vendor, 200).totalMicros, spendOf(vendor, 200).provenance], [400_000, 'vendorMetered'])
  assert.deepEqual([spendOf(list, 200).totalMicros, spendOf(list, 200).provenance], [400_000, 'listPrice'], 'per-call list prices split by model')
  assert.deepEqual(goalSpend([vendor], 200).provenance, 'vendorMetered')
  assert.deepEqual(goalSpend([list], 200).provenance, 'listPrice')
  assert.deepEqual(goalSpend([vendor, list], 200), { spentMicros: 800_000, provenance: 'mixed', why: null })
  // A known zero before any reading names no basis rather than borrowing one.
  assert.deepEqual(goalSpend([meter()], 200), { spentMicros: 0, provenance: 'unknown', why: null })
  // One session's basis cannot change part-way.
  assert.equal(meterTotal(fold(meter(), [sample({ moneyBasis: 'vendorMetered' }), sample({ moneyBasis: 'listPrice', usd: exact(1) })]), 200).micros, null)
})
