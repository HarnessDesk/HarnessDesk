import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { FlowSeat } from '@harnessdesk/protocol'

import { chooseSeat, explainRefusal, type SeatOffer } from '../src/agent-seating.js'
import { parseSeat } from '../src/flow.js'

/**
 * Ordered candidates, and an honest refusal.
 *
 * The one outcome this must never produce is a quiet substitution: a review
 * signed by a model that did not write it is worse than no review, so when
 * nothing can be seated the answer names every candidate and why each failed.
 */

const seat = (runtime: string, model?: string, effort?: string) => ({
  runtime,
  ...(model ? { model } : {}),
  ...(effort ? { effort } : {}),
  thinking: false,
})

const offer = (runtime: string, over: Partial<SeatOffer> = {}): SeatOffer => ({
  runtime,
  models: ['m1'],
  efforts: ['high'],
  signedIn: true,
  spent: false,
  ...over,
})

test('the first candidate that can be seated wins', () => {
  const chosen = chooseSeat([seat('cursor', 'm1', 'high'), seat('claude', 'm1', 'high')], [offer('cursor'), offer('claude')])
  assert.equal(chosen.seat?.runtime, 'cursor')
  assert.deepEqual(chosen.passed, [])
})

test('a runtime that is not installed is passed over, with the reason', () => {
  const chosen = chooseSeat([seat('cursor', 'm1', 'high'), seat('claude', 'm1', 'high')], [offer('claude')])
  assert.equal(chosen.seat?.runtime, 'claude')
  assert.equal(chosen.passed.length, 1)
  assert.match(chosen.passed[0]?.why ?? '', /not installed/)
})

test('signed out is passed over — and is not the same reason as absent', () => {
  const chosen = chooseSeat(
    [seat('cursor', 'm1', 'high'), seat('claude', 'm1', 'high')],
    [offer('cursor', { signedIn: false }), offer('claude')],
  )
  assert.equal(chosen.seat?.runtime, 'claude')
  assert.match(chosen.passed[0]?.why ?? '', /signed out/)
})

test('a spent lane is passed over', () => {
  const chosen = chooseSeat(
    [seat('cursor', 'm1', 'high'), seat('claude', 'm1', 'high')],
    [offer('cursor', { spent: true }), offer('claude')],
  )
  assert.equal(chosen.seat?.runtime, 'claude')
  assert.match(chosen.passed[0]?.why ?? '', /spent/)
})

test('a model the runtime does not offer is passed over, and the model is named', () => {
  const chosen = chooseSeat([seat('cursor', 'gone', 'high'), seat('claude', 'm1', 'high')], [offer('cursor'), offer('claude')])
  assert.equal(chosen.seat?.runtime, 'claude')
  assert.match(chosen.passed[0]?.why ?? '', /gone/)
})

test('an effort the runtime does not offer is passed over rather than dropped', () => {
  const chosen = chooseSeat([seat('cursor', 'm1', 'xhigh'), seat('claude', 'm1', 'high')], [offer('cursor'), offer('claude')])
  assert.equal(chosen.seat?.runtime, 'claude')
  assert.match(chosen.passed[0]?.why ?? '', /xhigh/)
})

test('a candidate with no model asks only for the runtime', () => {
  const chosen = chooseSeat([seat('cursor')], [offer('cursor', { models: [] })])
  assert.equal(chosen.seat?.runtime, 'cursor')
})

test('nothing seatable refuses, and the refusal names every candidate', () => {
  const chosen = chooseSeat(
    [seat('cursor', 'm1', 'high'), seat('claude', 'm1', 'high')],
    [offer('cursor', { signedIn: false })],
  )
  assert.equal(chosen.seat, null)
  assert.equal(chosen.passed.length, 2)
  const said = explainRefusal(chosen.passed)
  assert.match(said, /cursor/)
  assert.match(said, /claude/)
  assert.match(said, /signed out/)
})

test('an empty candidate list refuses rather than choosing for you', () => {
  const chosen = chooseSeat([], [offer('cursor')])
  assert.equal(chosen.seat, null)
})

/** A candidate as an `AGENT.md` spells it, read by the parser `prefer` goes through. */
const written = (spec: string): FlowSeat => {
  const parsed = parseSeat(spec)
  assert.ok(typeof parsed !== 'string', `${spec}: ${String(parsed)}`)
  return parsed
}

test('the seat taken is the candidate as written, with nothing filled in', () => {
  const full = seat('cursor', 'm1', 'high')
  assert.deepEqual(chooseSeat([full], [offer('cursor')]).seat, full)
  // No model and no effort asked for, spelled both ways the wire spells
  // nothing, on a runtime that offers several: taking one would be a guess.
  const offers = [offer('cursor', { models: ['m1', 'm2'], efforts: ['low', 'high'] })]
  for (const bare of [seat('cursor'), { runtime: 'cursor', model: null, effort: null, thinking: false }]) {
    assert.deepEqual(chooseSeat([bare], offers).seat, bare)
  }
})

test('a near match is not a match', () => {
  // The spelling is the runtime's. A pick it does not recognise is dropped
  // when the seat opens, and the seat then runs on whatever it had instead.
  const chosen = chooseSeat([seat('cursor', 'M1', 'high'), seat('cursor', 'm1', 'High')], [offer('cursor')])
  assert.equal(chosen.seat, null)
  assert.deepEqual(
    chosen.passed.map((one) => one.why),
    ['cursor does not offer M1', 'cursor does not offer High effort'],
  )
})

test('a candidate below the one taken was never tried, so it is not passed over', () => {
  const chosen = chooseSeat([seat('claude', 'm1', 'high'), seat('cursor', 'm1', 'high')], [offer('claude')])
  assert.equal(chosen.seat?.runtime, 'claude')
  assert.deepEqual(chosen.passed, [])
})

test('a signed-out runtime is reported signed out, not as lacking a model it cannot list', () => {
  // Signed out, a runtime may list no models at all, and "does not offer"
  // would send the reader to change a spec that was right.
  const chosen = chooseSeat(
    [seat('cursor', 'm1', 'high')],
    [offer('cursor', { signedIn: false, models: [], efforts: [] })],
  )
  assert.deepEqual(chosen.passed.map((one) => one.why), ['cursor is signed out'])
})

test('the refusal quotes each candidate as it was written, each with a reason of its own', () => {
  // Five reasons, five sentences: install it, sign in, wait for the window,
  // or change the model or the effort the Agent asks for.
  const specs = ['codex=m1/high', 'gemini=m1/high', 'claude=m1/high', 'cursor=gone/high', 'cursor=m1/xhigh+thinking']
  const chosen = chooseSeat(specs.map(written), [
    offer('gemini', { signedIn: false }),
    offer('claude', { spent: true }),
    offer('cursor'),
  ])
  assert.equal(chosen.seat, null)
  assert.equal(
    explainRefusal(chosen.passed),
    [
      'No seat could be opened for this Agent:',
      '  codex=m1/high — codex is not installed',
      '  gemini=m1/high — gemini is signed out',
      "  claude=m1/high — claude's window is spent",
      '  cursor=gone/high — cursor does not offer gone',
      '  cursor=m1/xhigh+thinking — cursor does not offer xhigh effort',
    ].join('\n'),
  )
})

test('an Agent with no seat to try is told where to name one', () => {
  const said = explainRefusal(chooseSeat([], [offer('cursor')]).passed)
  assert.match(said, /prefer/)
  assert.match(said, /AGENT\.md/)
})
