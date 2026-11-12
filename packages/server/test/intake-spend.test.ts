import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { UsageSample } from '../src/ledger/insight.js'
import { budgetRefusal } from '../src/intake/budget.js'
import { attributeSample, CONSULT_TOTAL_WENT_DOWN, CONSULT_USAGE_UNKNOWN, goalSpend, meterSample, meterTotal, meterTurn, openMeter, settleConsult, spendOf, type SessionMeter } from '../src/intake/spend.js'

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

test('a consult’s final live reading is reconciled with an earlier corpus reading, never added to it, and never hidden by it', () => {
  const consult = meterTurn(meter({ seat: 'seat-1/ask/1' }), { started: 100 })
  const live = (usd: number, over: Partial<UsageSample> = {}) => sample({ key: 'consult:alpha:s1', usd: exact(usd), to: 130, ...over })
  // The review's case: the corpus read $0.10 mid-turn, the live conversation's final total is $0.42, the Goal's cap is $0.20.
  const midway = meterSample(consult, sample({ usd: exact(0.1), to: 110 }))
  const settled = meterTurn(settleConsult(midway, live(0.42)), { ended: 130 })
  assert.equal(meterTotal(settled, 200).micros, 420_000, 'the final reading stands')
  const check = { now: 0, deadline: 1, closedRounds: 0, roundLimit: 9, idleRounds: 0, idleLimit: 9, lane: 'available' as const, paused: false, limitMicros: 200_000 }
  assert.match(budgetRefusal({ ...check, spentMicros: goalSpend([settled], 200).spentMicros }) ?? '', /spend limit/, 'and the Goal at its $0.20 cap refuses')
  // Per-call corpus figures and the live session total are one spend, counted once.
  const calls = fold(consult, [sample({ scope: 'call', key: 'c1', usd: exact(0.06) }), sample({ scope: 'call', key: 'c2', usd: exact(0.04) })])
  assert.equal(meterTotal(meterTurn(settleConsult(calls, live(0.42)), { ended: 130 }), 200).micros, 420_000)
  // A live total below what the corpus already read is not one cumulative count: unknown, never the larger figure.
  assert.equal(meterTotal(meterTurn(settleConsult(meterSample(consult, sample({ usd: exact(0.5) })), live(0.42)), { ended: 130 }), 200).micros, null)
  // A final reading the meter cannot vouch for leaves it unknown: the corpus figure may not have been complete.
  assert.equal(meterTotal(settleConsult(midway, live(0, { usd: { value: null, quality: 'unknown' }, moneyBasis: 'unknown' })), 200).micros, null)
})

const capCheck = (limit: number, spentMicros: number | null) => budgetRefusal({
  now: 0, deadline: 1, closedRounds: 0, roundLimit: 9, idleRounds: 0, idleLimit: 9, lane: 'available', paused: false, limitMicros: limit, spentMicros,
})

test('round 3: a total that resets mid-consult — $0.30 read, then a final $0.12 — is unknown, and a $0.35 cap refuses', () => {
  const consult = meterTurn(meter({ seat: 'seat-1/ask/1' }), { started: 100 })
  const before = meterSample(consult, sample({ usd: exact(0.3), to: 110 }))
  const settled = meterTurn(settleConsult(before, sample({ key: 'consult:alpha:s1', usd: exact(0.12), to: 130 })), { ended: 130 })
  assert.equal(settled.unknown, CONSULT_TOTAL_WENT_DOWN)
  assert.equal(meterTotal(settled, 200).micros, null, 'not a known $0.30')
  assert.match(capCheck(350_000, goalSpend([settled], 200).spentMicros) ?? '', /Spend is unknown/)
  // The same through per-call corpus figures: $0.30 counted, a final $0.12 is below it.
  const calls = fold(consult, [sample({ scope: 'call', key: 'c1', usd: exact(0.2) }), sample({ scope: 'call', key: 'c2', usd: exact(0.1) })])
  assert.equal(meterTotal(meterTurn(settleConsult(calls, sample({ key: 'consult:alpha:s1', usd: exact(0.12), to: 130 })), { ended: 130 }), 200).micros, null)
  // A later corpus reading cannot clear it either: only a missing final reading is repaired.
  assert.equal(meterSample(settled, sample({ usd: exact(0.4), to: 140 })).unknown, CONSULT_TOTAL_WENT_DOWN)
})

test('round 3: no final reading — $0.10 read mid-turn, nothing at its end — is unknown and refused until a reading at or after the turn’s end', () => {
  const consult = meterTurn(meter({ seat: 'seat-1/ask/1' }), { started: 100 })
  const midway = meterSample(consult, sample({ usd: exact(0.1), to: 110 }))
  const settled = meterTurn(settleConsult(midway, null), { ended: 130 })
  assert.equal(settled.unknown, CONSULT_USAGE_UNKNOWN)
  assert.equal(goalSpend([settled], 200).spentMicros, null, 'not a known $0.10')
  assert.match(capCheck(350_000, goalSpend([settled], 200).spentMicros) ?? '', /Spend is unknown/)
  // Every record read again, the latest still from before the turn ended: still unknown.
  const stale = meterSample(settled, sample({ usd: exact(0.12), to: 120 }))
  assert.equal(stale.unknown, CONSULT_USAGE_UNKNOWN)
  assert.equal(goalSpend([stale], 200).spentMicros, null)
  // A record at the turn's end is its final reading, and repairs it.
  const final = meterSample(stale, sample({ usd: exact(0.2), to: 130 }))
  assert.equal(final.unknown, null)
  assert.equal(meterTotal(final, 200).micros, 200_000)
  assert.equal(capCheck(350_000, goalSpend([final], 200).spentMicros), null, 'and the cap admits again')
})

test('round 4: a corpus that replays $0.10 after $0.12 latches nothing, and the $0.20 final still repairs the spend', () => {
  const consult = meterTurn(meter({ seat: 'seat-1/ask/1' }), { started: 100 })
  const unknown = meterTurn(settleConsult(consult, null), { ended: 130 })
  // Every read hands back everything the corpus holds, in the order it found it.
  const first = fold(unknown, [sample({ key: 'r1', usd: exact(0.1), to: 110 })])
  const second = fold(first, [sample({ key: 'r1', usd: exact(0.1), to: 110 }), sample({ key: 'r2', usd: exact(0.12), to: 120 })])
  assert.deepEqual({ unknown: second.unknown, lastMicros: second.lastMicros }, { unknown: CONSULT_USAGE_UNKNOWN, lastMicros: 120_000 })
  const third = fold(second, [
    sample({ key: 'r1', usd: exact(0.1), to: 110 }), sample({ key: 'r2', usd: exact(0.12), to: 120 }), sample({ key: 'r3', usd: exact(0.2), to: 130 }),
  ])
  assert.equal(third.unknown, null, 'the replayed $0.10 is not a total that went down')
  assert.equal(meterTotal(third, 200).micros, 200_000, 'the final $0.20 is the whole')
  assert.equal(capCheck(350_000, goalSpend([third], 200).spentMicros), null)
  // The same replay after the repair changes nothing.
  assert.deepEqual(fold(third, [sample({ key: 'r1', usd: exact(0.1), to: 110 }), sample({ key: 'r3', usd: exact(0.2), to: 130 })]), third)
  // A lower total taken after the last one counted is still a total that went down.
  assert.match(meterSample(third, sample({ key: 'r4', usd: exact(0.15), to: 140 })).unknown ?? '', /went down/)
})

test('a consult’s unknown spend is repaired by a later valid reading, and a question never sent is a known zero', () => {
  const consult = meterTurn(meter({ seat: 'seat-1/ask/1' }), { started: 100 })
  const unknown = meterTurn(settleConsult(consult, null), { ended: 130 })
  assert.equal(unknown.unknown, CONSULT_USAGE_UNKNOWN)
  assert.equal(goalSpend([unknown], 200).spentMicros, null)
  const repaired = meterSample(unknown, sample({ usd: exact(0.3), to: 140 }))
  assert.equal(repaired.unknown, null)
  assert.equal(meterTotal(repaired, 200).micros, 300_000, 'the first valid reading of the consult reconciles it')
  // An invalid one does not: it is a reading the meter cannot vouch for, so the spend stays unknown for good.
  const invalid = meterSample(unknown, sample({ usd: { value: null, quality: 'unknown' }, to: 140 }))
  assert.notEqual(invalid.unknown, null, 'an invalid one does not')
  assert.notEqual(meterSample(invalid, sample({ usd: exact(0.3), to: 150 })).unknown, null)
  // Any other unknown stays as it was.
  const other = meterSample(meter({ fresh: false }), sample())
  assert.equal(meterSample(other, sample({ usd: exact(9), to: 999 })).unknown, other.unknown)
  // Withdrawn before the question went: the turn it was about to start is forgotten, and nothing was spent.
  const unsent = settleConsult(consult, 'unsent')
  assert.deepEqual(meterTotal(unsent, 200), { micros: 0, why: null })
})
