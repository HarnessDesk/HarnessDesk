import assert from 'node:assert/strict'
import { test } from 'node:test'

import { pacedOrder, pacingAdvice, useFirstNote, type UsageLane, type UsageReport } from '../src/index.js'

const NOW = Date.UTC(2026, 10, 9, 12, 0, 0)
const H = 3_600_000

const lane = (patch: Partial<UsageLane> & { usedPercent: number; resetsAt: number | null }): UsageLane =>
  ({ id: 'session', label: '5 hour', windowMinutes: 300, ...patch })

const report = (runtime: string, lanes: UsageLane[], patch: Partial<UsageReport> = {}): UsageReport => ({
  runtime: runtime as UsageReport['runtime'], account: null, plan: null, lanes, credits: null, spend: null, reached: null,
  source: { kind: 'api', label: 'from its API' }, fetchedAt: NOW - 60_000, staleAfterMs: 15 * 60_000, error: null, ...patch,
})

const order = (reports: UsageReport[], ids: string[]) =>
  pacedOrder(ids.map(id => ({ id })), id => reports.filter(one => one.runtime === id), NOW).map(one => one.id)

test('the account that resets soonest, with room, goes first', () => {
  const reports = [
    report('a', [lane({ usedPercent: 20, resetsAt: NOW + 4 * H })]),
    report('b', [lane({ usedPercent: 60, resetsAt: NOW + 1 * H })]),
    report('c', [lane({ usedPercent: 10, resetsAt: NOW + 2 * H })]),
  ]
  assert.deepEqual(order(reports, ['a', 'b', 'c']), ['b', 'c', 'a'])
})

test('an account that is out goes last however soon it resets', () => {
  const reports = [
    report('a', [lane({ usedPercent: 100, resetsAt: NOW + 10 * 60_000 })]),
    report('b', [lane({ usedPercent: 30, resetsAt: NOW + 5 * H })]),
  ]
  assert.deepEqual(order(reports, ['a', 'b']), ['b', 'a'])
})

test('an almost spent account is tried after one with room', () => {
  const reports = [
    report('a', [lane({ usedPercent: 95, resetsAt: NOW + 10 * 60_000 })]),
    report('b', [lane({ usedPercent: 30, resetsAt: NOW + 5 * H })]),
  ]
  assert.deepEqual(order(reports, ['a', 'b']), ['b', 'a'])
})

test('an unread, stale or failed account keeps the person order behind the ones that are known', () => {
  const reports = [
    report('a', [lane({ usedPercent: 10, resetsAt: NOW + H })], { fetchedAt: NOW - 3 * H }),
    report('c', [lane({ usedPercent: 40, resetsAt: NOW + 9 * H })]),
    report('d', [], { error: { message: 'x' } as UsageReport['error'] }),
  ]
  assert.deepEqual(order(reports, ['a', 'b', 'c', 'd']), ['c', 'a', 'b', 'd'])
})

test('equal resets keep the person order', () => {
  const reports = [
    report('a', [lane({ usedPercent: 20, resetsAt: NOW + H })]),
    report('b', [lane({ usedPercent: 50, resetsAt: NOW + H })]),
  ]
  assert.deepEqual(order(reports, ['b', 'a']), ['b', 'a'])
})

test('a reset already in the past is not a soonest reset', () => {
  const reports = [
    report('a', [lane({ usedPercent: 20, resetsAt: NOW - H })]),
    report('b', [lane({ usedPercent: 20, resetsAt: NOW + 8 * H })]),
  ]
  assert.deepEqual(order(reports, ['a', 'b']), ['b', 'a'])
})

test('use it first: more than half left and the reset is close', () => {
  const note = useFirstNote(report('a', [lane({ usedPercent: 30, resetsAt: NOW + H })]), NOW)
  assert.deepEqual(note, { laneId: 'session', remainingPercent: 70, resetsAt: NOW + H })
})

test('use it first stays quiet when half or less is left, the reset is far, or it is the wrong kind of window', () => {
  const quiet = (r: UsageReport) => assert.equal(useFirstNote(r, NOW), null)
  quiet(report('a', [lane({ usedPercent: 50, resetsAt: NOW + H })]))
  quiet(report('a', [lane({ usedPercent: 30, resetsAt: NOW + 3 * H })]))
  quiet(report('a', [lane({ usedPercent: 30, resetsAt: null })]))
  quiet(report('a', [lane({ usedPercent: 30, resetsAt: NOW - H })]))
  quiet(report('a', [lane({ usedPercent: 30, resetsAt: NOW + H, scope: 'Opus' })]))
  quiet(report('a', [lane({ usedPercent: 30, resetsAt: NOW + H, placeholder: true })]))
  quiet(report('a', [lane({ usedPercent: 30, resetsAt: NOW + H })], { fetchedAt: NOW - 3 * H }))
  quiet(report('a', [lane({ usedPercent: 30, resetsAt: NOW + H })], { error: { message: 'x' } as UsageReport['error'] }))
  quiet(report('a', [lane({ usedPercent: 30, resetsAt: NOW + H }), lane({ id: 'weekly', usedPercent: 100, resetsAt: NOW + 50 * H, windowMinutes: 10080 })]))
})

test('a weekly window is close inside a quarter of its length, and a window of unstated length inside a day', () => {
  const week = (resetsAt: number) => report('a', [lane({ id: 'weekly', usedPercent: 20, resetsAt, windowMinutes: 10080 })])
  assert.equal(useFirstNote(week(NOW + 40 * H), NOW)?.laneId, 'weekly')
  assert.equal(useFirstNote(week(NOW + 43 * H), NOW), null)
  const open = (resetsAt: number) => report('a', [lane({ id: 'allowance', usedPercent: 20, resetsAt, windowMinutes: null })])
  assert.ok(useFirstNote(open(NOW + 23 * H), NOW))
  assert.equal(useFirstNote(open(NOW + 25 * H), NOW), null)
})

test('an account whose tightest window is nearly spent is not told to be used first, nor does it lead', () => {
  const week = (used: number) => lane({ id: 'weekly', label: 'Weekly', usedPercent: used, resetsAt: NOW + 50 * H, windowMinutes: 10080 })
  const tight = report('a', [lane({ usedPercent: 20, resetsAt: NOW + H }), week(98)])
  assert.equal(useFirstNote(tight, NOW), null, '80% of the 5h window left, 2% of the week')
  const roomy = report('b', [lane({ usedPercent: 50, resetsAt: NOW + 4 * H }), week(50)])
  assert.deepEqual(order([report('a', [lane({ usedPercent: 10, resetsAt: NOW + H }), week(99)]), roomy], ['a', 'b']), ['b', 'a'], '90% of 5h but 1% weekly must not lead')
  assert.ok(useFirstNote(report('c', [lane({ usedPercent: 20, resetsAt: NOW + H }), week(50)]), NOW), 'a roomy week leaves the note on')
})

test('a window that has already refilled is neither nearly spent nor the reset that leads', () => {
  const refilled = report('a', [lane({ usedPercent: 98, resetsAt: NOW - H }), lane({ id: 'weekly', usedPercent: 40, resetsAt: NOW + 60 * H, windowMinutes: 10080 })])
  const other = report('b', [lane({ usedPercent: 40, resetsAt: NOW + 5 * H })])
  assert.deepEqual(order([refilled, other], ['a', 'b']), ['b', 'a'], 'the week is the only reset a has; b refills first')
  assert.notEqual(order([report('a', [lane({ usedPercent: 98, resetsAt: NOW - H })]), report('z', [lane({ usedPercent: 95, resetsAt: NOW + H })])], ['z', 'a'])[0], 'z',
    'a refilled window outranks one that is nearly spent')
})

test('a reached limit that is stale, failed or already past its reset is unknown, not out', () => {
  const spent = (patch: Partial<UsageReport>) => report('a', [lane({ usedPercent: 100, resetsAt: NOW + H })], { reached: 'session', ...patch })
  const fine = report('b', [lane({ usedPercent: 40, resetsAt: NOW + 5 * H })])
  assert.deepEqual(order([spent({}), fine], ['a', 'b']), ['b', 'a'], 'a fresh reading of a spent account is last')
  assert.deepEqual(order([spent({ fetchedAt: NOW - 3 * H }), fine], ['a', 'b']), ['b', 'a'], 'a stale reading proves nothing, so it ranks as unknown')
  const unknown = order([report('a', [lane({ usedPercent: 100, resetsAt: NOW - H })], { reached: 'session' }), report('c', [lane({ usedPercent: 100, resetsAt: NOW + H })], { reached: 'session' })], ['c', 'a'])
  assert.deepEqual(unknown, ['a', 'c'], 'a spent window whose reset has passed ranks above one still spent')
})

const weekly = (usedPercent: number, resetsAt: number): UsageLane =>
  lane({ id: 'weekly', label: 'Weekly', usedPercent, resetsAt, windowMinutes: 10080 })
const advise = (reports: UsageReport[]) => pacingAdvice(reports.map(one => ({ id: one.runtime, report: one })), NOW)

test('which account first: the one about to reset with most of its week unspent, with its reset time (Q15)', () => {
  // b has less left than a, but its week refills in 20 hours with 70% unspent: that allowance is lost unless it is used.
  const advice = advise([
    report('a', [weekly(10, NOW + 6 * 24 * H)]),
    report('b', [weekly(30, NOW + 20 * H)]),
  ])
  assert.deepEqual(advice, { id: 'b', reason: 'use-first', laneId: 'weekly', laneLabel: 'Weekly', remainingPercent: 70, resetsAt: NOW + 20 * H, readAt: NOW - 60_000 })
})

test('with nothing about to be lost, the advice is the account with room whose window refills soonest', () => {
  const advice = advise([
    report('a', [weekly(40, NOW + 6 * 24 * H)]),
    report('b', [weekly(40, NOW + 3 * 24 * H)]),
    report('c', [weekly(95, NOW + 2 * H)]),
  ])
  assert.equal(advice?.id, 'b')
  assert.equal(advice?.reason, 'resets-soonest')
  assert.equal(advice?.resetsAt, NOW + 3 * 24 * H)
  assert.equal(advice?.remainingPercent, 60)
})

test('a stale or failed reading never decides the advice, and with no fresh reading there is none', () => {
  const kept = report('a', [weekly(10, NOW + 10 * H)], { error: { message: 'x' } as UsageReport['error'] })
  const stale = report('b', [weekly(10, NOW + 10 * H)], { fetchedAt: NOW - 3 * H })
  assert.equal(advise([kept, stale]), null)
  assert.equal(advise([kept, stale, report('c', [weekly(50, NOW + 5 * 24 * H)])])?.id, 'c')
})

test('of two accounts about to lose allowance, the one that resets first leads', () => {
  const advice = advise([
    report('a', [weekly(20, NOW + 30 * H)]),
    report('b', [weekly(40, NOW + 10 * H)]),
  ])
  assert.equal(advice?.id, 'b')
  assert.equal(advice?.reason, 'use-first')
})
