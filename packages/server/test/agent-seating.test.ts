import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { ConfigOption, FlowSeat } from '@harnessdesk/protocol'

import {
  chooseSeat,
  differences,
  differencesOf,
  durationWords,
  explainRefusal,
  fixOf,
  openedOtherwise,
  passedFor,
  reasonAgainst,
  runningOf,
  sentenceOf,
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
    'cursor runs it on model m2, not m1, and at medium effort, not high',
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

test('a seat that asks for thinking off is held to it — the allowance for a model that always thinks is for silence only', () => {
  // `+thinking` is the only switch the grammar writes, so an explicit `false`
  // comes from a seating's own `seats`, and it is something the caller asked.
  const off: FlowSeat = { runtime: 'cursor', model: 'm1', effort: 'high', thinking: false }
  assert.deepEqual(differences(off, running({ thinking: false })), [])
  assert.deepEqual(differences(off, running({ thinking: true, thinkingFixed: 'M1 always thinks.' })), [
    'with thinking on, which was asked to be off (M1 always thinks)',
  ])
  assert.deepEqual(differences(off, running({ thinking: true })), ['with thinking on, which was asked to be off'])
  assert.equal(
    openedOtherwise(off, running({ thinking: true, thinkingFixed: 'M1 always thinks.' })),
    'cursor runs it with thinking on, which was asked to be off (M1 always thinks)',
  )
  // Said nothing of thinking, on a model that always thinks: still the model asked for.
  assert.deepEqual(differences(written('cursor=m1/high'), running({ thinking: true, thinkingFixed: 'M1 always thinks.' })), [])
})

/*
 * A reason a surface can act on. The sentence is the host's — it quotes the
 * runtime's wire id, which a surface may not show — so every candidate also
 * carries what the reason is and what removes it, and a surface words both.
 */

test('every reason carries what removes it, and the sentence is unchanged', () => {
  const chosen = chooseSeat(
    ['ghost=m1', 'gone=m1', 'old=m1', 'mute=m1', 'out=m1', 'spent=m1', 'unread=m1', 'cursor=nope', 'cursor=m1/xhigh'].map(
      written,
    ),
    [
      offer('gone', { notInstalled: true }),
      offer('old', { unavailable: 'Old 0.1 is too old.' }),
      offer('mute', { silent: 30 }),
      offer('out', { signedIn: false }),
      offer('spent', { spent: true }),
      offer('unread', { models: null }),
      offer('cursor'),
    ],
  )
  assert.equal(chosen.seat, null)
  assert.deepEqual(
    chosen.passed.map((one) => [one.reason, fixOf(one.seat.runtime, one.reason)]),
    [
      [{ kind: 'notInstalled', added: false }, { kind: 'add', runtime: 'ghost' }],
      [{ kind: 'notInstalled', added: true }, { kind: 'install', runtime: 'gone' }],
      [{ kind: 'unavailable', detail: 'Old 0.1 is too old' }, { kind: 'runtime', runtime: 'old' }],
      [{ kind: 'noAnswer', after: 30 }, { kind: 'runtime', runtime: 'mute' }],
      [{ kind: 'signedOut' }, { kind: 'signIn', runtime: 'out' }],
      [{ kind: 'spent' }, { kind: 'usage', runtime: 'spent' }],
      [{ kind: 'modelsUnread', model: 'm1' }, { kind: 'runtime', runtime: 'unread' }],
      [{ kind: 'noModel', model: 'nope' }, { kind: 'seats' }],
      [{ kind: 'noEffort', effort: 'xhigh' }, { kind: 'seats' }],
    ],
  )
  // The sentence is still the one a refusal has always said, and one function says it.
  assert.deepEqual(
    chosen.passed.map((one) => one.why),
    [
      'ghost is not installed',
      'gone is not installed',
      'old is unavailable: Old 0.1 is too old',
      'mute did not answer within 30 ms when asked whether it is signed in',
      'out is signed out',
      "spent's window is spent",
      'cannot tell whether unread offers m1: its model list could not be read',
      'cursor does not offer nope',
      'cursor does not offer xhigh effort',
    ],
  )
  for (const one of chosen.passed) assert.equal(one.why, sentenceOf(one.seat.runtime, one.reason))
})

test('a runtime nobody added and one whose program is missing read the same and are fixed differently', () => {
  // Both are "not installed" to a reader of the refusal; the first is fixed in
  // Settings by adding it, the second by installing what it runs.
  assert.deepEqual(reasonAgainst(written('codex'), []), { kind: 'notInstalled', added: false })
  assert.deepEqual(reasonAgainst(written('codex'), [offer('codex', { notInstalled: true })]), {
    kind: 'notInstalled',
    added: true,
  })
  assert.equal(reasonAgainst(written('codex'), [offer('codex')]), null)
})

test('what only an open seat can say is a reason too, worded as the refusal always worded it', () => {
  const asked = written('cursor=m1/high')
  const opened = passedFor(asked, {
    kind: 'openedOtherwise',
    differences: [{ field: 'effort', asked: 'high', running: 'medium' }],
  })
  assert.equal(opened.why, 'cursor runs it at medium effort, not high')
  assert.equal(opened.why, openedOtherwise(asked, running({ effort: 'medium' })))
  assert.deepEqual(fixOf('cursor', opened.reason), { kind: 'seats' })
  const failed = passedFor(asked, { kind: 'couldNotOpen', detail: 'the bridge exited' })
  assert.equal(failed.why, 'cursor could not open a conversation: the bridge exited')
  assert.deepEqual(fixOf('cursor', failed.reason), { kind: 'runtime', runtime: 'cursor' })
})

/*
 * An id that names no runtime at all — `prefer: [claude]`, the spelling the
 * spec itself uses, where the real id is `claude-code` — reads the same "not
 * installed" a reader would expect, but *Add* is a dead end for it: there is
 * nothing to add. It gets its own reason, fixed by editing the seats.
 */

test('an id nothing knows is its own reason, fixed by editing the seats — never offered "add"', () => {
  assert.deepEqual(reasonAgainst(written('praxis'), [offer('praxis', { unknownRuntime: true })]), {
    kind: 'unknownRuntime',
  })
  assert.equal(sentenceOf('praxis', { kind: 'unknownRuntime' }), 'praxis does not name a runtime this desk knows')
  assert.deepEqual(fixOf('praxis', { kind: 'unknownRuntime' }), { kind: 'seats' })
})

test('a silent offer of 0ms is still a reason of its own, not read as the placeholder "signed out"', () => {
  // `silent` is a deadline, and 0 is a real (if silly) one: `!signedIn` must
  // not win just because `0` is falsy.
  assert.deepEqual(reasonAgainst(written('cursor'), [offer('cursor', { silent: 0, signedIn: false })]), {
    kind: 'noAnswer',
    after: 0,
  })
})

test('durationWords says milliseconds under a second and rounds to whole seconds above it', () => {
  assert.equal(durationWords(30), '30 ms')
  assert.equal(durationWords(999), '999 ms')
  assert.equal(durationWords(1_000), '1 second')
  assert.equal(durationWords(1_499), '1 second')
  assert.equal(durationWords(1_500), '2 seconds')
  assert.equal(durationWords(10_000), '10 seconds')
})

/*
 * `differencesOf` is the one place that decides what differs once a seat is
 * open; `sentenceOf` must rebuild the refusal's sentence from its output
 * alone, byte for byte, or the two would be free to drift apart.
 */

test('the structured version of an opened difference names the field, what was asked and what runs', () => {
  const asked = written('cursor=m1/high+thinking')
  assert.deepEqual(differencesOf(asked, running({ model: 'm2', effort: 'medium', thinking: false })), [
    { field: 'model', asked: 'm1', running: 'm2' },
    { field: 'effort', asked: 'high', running: 'medium' },
    { field: 'thinking', asked: true, running: false },
  ])
  assert.deepEqual(differencesOf(asked, running({ model: null, effort: null, thinking: false })), [
    { field: 'model', asked: 'm1', running: null },
    { field: 'effort', asked: 'high', running: null },
    { field: 'thinking', asked: true, running: false },
  ])
  // Thinking only: the runtime's own words for why it will not move, carried
  // apart from the boolean state so a sentence can still quote them.
  assert.deepEqual(differencesOf(asked, running({ thinking: false, thinkingFixed: 'M1 has no thinking mode.' })), [
    { field: 'thinking', asked: true, running: false, fixed: 'M1 has no thinking mode' },
  ])
  const off: FlowSeat = { runtime: 'cursor', model: 'm1', effort: 'high', thinking: false }
  assert.deepEqual(differencesOf(off, running({ thinking: true, thinkingFixed: 'M1 always thinks.' })), [
    { field: 'thinking', asked: false, running: true, fixed: 'M1 always thinks' },
  ])
  // Not asked either way, and left on with no stated reason: `asked` is null,
  // distinct from the `false` a seating writes on purpose.
  assert.deepEqual(differencesOf(written('cursor=m1/high'), running({ thinking: true })), [
    { field: 'thinking', asked: null, running: true },
  ])
  // What the seat does not name is not a difference, structured either.
  assert.deepEqual(differencesOf(written('cursor'), running({ model: 'm9', effort: 'low' })), [])
})

test('sentenceOf rebuilds the opened-otherwise sentence from the structured differences, byte for byte', () => {
  const asked = written('cursor=m1/high+thinking')
  const busy = running({ model: 'm2', effort: 'medium', thinking: false, thinkingFixed: 'M1 has no thinking mode.' })
  const found = differencesOf(asked, busy)
  assert.equal(
    sentenceOf('cursor', { kind: 'openedOtherwise', differences: found }),
    'cursor runs it on model m2, not m1, and at medium effort, not high, and without thinking, which was asked for (M1 has no thinking mode)',
  )
  assert.equal(openedOtherwise(asked, busy), sentenceOf('cursor', { kind: 'openedOtherwise', differences: found }))
})
