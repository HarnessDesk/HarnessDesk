import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { ConfigOption, FlowSeat } from '@harnessdesk/protocol'

import {
  chooseSeat,
  differences,
  explainRefusal,
  openedOtherwise,
  runningOf,
  type SeatOffer,
  type SeatRunning,
} from '../src/agent-seating.js'
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

/*
 * What the chooser cannot know by itself: a list that could not be read, and
 * efforts nobody can list before a session exists. Each is told apart from the
 * answer it would otherwise be mistaken for.
 */

test('a model list that could not be read is not a list of nothing', () => {
  // Null is unread; empty is "takes no model". Mistaken for empty, a failed
  // read would refuse a spec that was right as "does not offer".
  const chosen = chooseSeat([seat('cursor', 'gemini-3.8-flash', 'high')], [offer('cursor', { models: null })])
  assert.equal(chosen.seat, null)
  assert.deepEqual(chosen.passed.map((one) => one.why), [
    'cannot tell whether cursor offers gemini-3.8-flash: its model list could not be read',
  ])
  // Unread only matters to a candidate that names a model.
  assert.equal(chooseSeat([seat('cursor')], [offer('cursor', { models: null })]).seat?.runtime, 'cursor')
})

test('efforts nobody can list before seating let the candidate through, to be held to it once open', () => {
  const asked = seat('cursor', 'm1', 'xhigh')
  assert.deepEqual(chooseSeat([asked], [offer('cursor', { efforts: null })]).seat, asked)
  // The control: an effort list that was read still refuses what it lacks.
  assert.equal(chooseSeat([asked], [offer('cursor')]).seat, null)
})

test("a runtime that cannot open a conversation is passed over in its own words, on one line", () => {
  const chosen = chooseSeat(
    [seat('gemini', 'm1'), seat('claude', 'm1')],
    [offer('gemini', { unavailable: 'Gemini CLI 0.9 is too old:\n  1.0 or newer is needed.' }), offer('claude')],
  )
  assert.equal(chosen.seat?.runtime, 'claude')
  assert.deepEqual(chosen.passed.map((one) => one.why), [
    'gemini is unavailable: Gemini CLI 0.9 is too old: 1.0 or newer is needed',
  ])
})

/** A conversation's controls, the way a runtime declares them. */
const controls = (values: {
  model?: string
  effort?: string
  thinking?: boolean
  thinkingFixed?: string
}): ConfigOption[] => [
  ...(values.model !== undefined
    ? [{ type: 'select' as const, id: 'model', label: 'Model', currentValue: values.model, choices: [] }]
    : []),
  ...(values.effort !== undefined
    ? [{ type: 'select' as const, id: 'effort', label: 'Effort', currentValue: values.effort, choices: [] }]
    : []),
  ...(values.thinking !== undefined
    ? [
        {
          type: 'boolean' as const,
          id: 'thinking',
          label: 'Thinking',
          currentValue: values.thinking,
          ...(values.thinkingFixed ? { disabled: values.thinkingFixed } : {}),
        },
      ]
    : []),
]

test('what a conversation runs is read from the controls a seat sets, and its settings when it has no model control', () => {
  assert.deepEqual(runningOf(controls({ model: 'm1', effort: 'high', thinking: true }), { cwd: '/w', model: 'other' }), {
    model: 'm1',
    effort: 'high',
    thinking: true,
    thinkingFixed: null,
  })
  assert.deepEqual(
    runningOf(controls({ thinking: false, thinkingFixed: 'M2 has no thinking mode.' }), { cwd: '/w', model: 'm2' }),
    { model: 'm2', effort: null, thinking: false, thinkingFixed: 'M2 has no thinking mode.' },
  )
  assert.deepEqual(runningOf([], { cwd: '/w', model: '' }), {
    model: null,
    effort: null,
    thinking: false,
    thinkingFixed: null,
  })
})

const running = (over: Partial<SeatRunning> = {}): SeatRunning => ({
  model: 'm1',
  effort: 'high',
  thinking: false,
  thinkingFixed: null,
  ...over,
})

test('an opened seat is held to the model and effort it asked for, and each difference names the field', () => {
  const asked = written('cursor=m1/high')
  assert.deepEqual(differences(asked, running()), [])
  assert.equal(openedOtherwise(asked, running()), null)
  assert.deepEqual(differences(asked, running({ model: 'm2' })), ['on model m2, not m1'])
  assert.deepEqual(differences(asked, running({ model: null })), ['on no model it would name, not m1'])
  assert.deepEqual(differences(asked, running({ effort: 'medium' })), ['at medium effort, not high'])
  assert.deepEqual(differences(asked, running({ effort: null })), ['with no effort setting, not at high effort'])
  assert.equal(
    openedOtherwise(asked, running({ model: 'm2', effort: 'medium' })),
    'cursor opened on model m2, not m1, and at medium effort, not high — so it was closed',
  )
  // What the seat does not name is not held against it.
  assert.deepEqual(differences(written('cursor'), running({ model: 'm9', effort: 'low' })), [])
})

test('thinking is held to what the spec says either way, except where the model decides it', () => {
  const thinking = written('cursor=m1/high+thinking')
  const plain = written('cursor=m1/high')
  assert.deepEqual(differences(thinking, running({ thinking: true })), [])
  assert.deepEqual(differences(thinking, running({ thinking: false })), ['without thinking, which was asked for'])
  // Asked on a model that cannot think: refused all the same, in the runtime's words.
  assert.deepEqual(
    differences(thinking, running({ thinking: false, thinkingFixed: 'M1 has no thinking mode.' })),
    ['without thinking, which was asked for (M1 has no thinking mode)'],
  )
  // Not asked, and left on by a switch that would not turn off: that is somebody else's seat.
  assert.deepEqual(differences(plain, running({ thinking: true })), [
    'with thinking on, which was not asked for and would not turn off',
  ])
  // Not asked, on a model that always thinks: the model asked for, thinking included.
  assert.deepEqual(differences(plain, running({ thinking: true, thinkingFixed: 'M1 always thinks.' })), [])
})
