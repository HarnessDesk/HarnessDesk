import assert from 'node:assert/strict'
import { test } from 'node:test'

import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'

import {
  answerFor,
  answeredInput,
  permissionRequestFor,
  questionCallId,
  questionsOf,
  questionTitled,
} from '../src/ask-user.js'

const input = {
  questions: [
    {
      question: 'Which library should we use?',
      header: 'Library',
      multiSelect: false,
      options: [
        { label: 'date-fns', description: 'Small.' },
        { label: 'dayjs', description: 'Moment-compatible.' },
      ],
    },
  ],
}

test('the questions are read off the tool input as the SDK spells them', () => {
  const asked = questionsOf(input)
  assert.equal(asked.length, 1)
  assert.equal(asked[0]?.question, 'Which library should we use?')
  assert.deepEqual(asked[0]?.options.map((o) => o.label), ['date-fns', 'dayjs'])
})

test('a malformed input yields no questions rather than a throw', () => {
  assert.deepEqual(questionsOf(null), [])
  assert.deepEqual(questionsOf({ questions: 'no' }), [])
  assert.deepEqual(questionsOf({ questions: [{ question: '', options: [] }] }), [])
})

test('one question becomes one permission request whose options are its answers', () => {
  const [asked] = questionsOf(input)
  const request = permissionRequestFor('s1', 'tu-1', asked!)
  assert.equal(request.sessionId, 's1')
  assert.equal(request.toolCall.toolCallId, 'tu-1')
  assert.equal(request.toolCall.title, 'Which library should we use?')
  assert.deepEqual(
    request.options.map((o) => [o.optionId, o.name, o.kind]),
    [['answer-0', 'date-fns', 'allow_once'], ['answer-1', 'dayjs', 'allow_once']],
  )
  // The whole question rides beside the options, for a client that draws
  // questions as questions.
  assert.equal(request._meta.harnessdesk.question.header, 'Library')
  assert.equal(request.toolCall.rawInput.questions[0]?.options[1]?.description, 'Moment-compatible.')
})

test('the chosen option goes back as its label, keyed by the question text', () => {
  const [asked] = questionsOf(input)
  assert.equal(answerFor(asked!, { outcome: 'selected', optionId: 'answer-1' }), 'dayjs')
  assert.equal(answerFor(asked!, { outcome: 'cancelled' }), null)
  assert.equal(answerFor(asked!, { outcome: 'selected', optionId: 'answer-9' }), null)
  assert.equal(answerFor(asked!, undefined), null)
  const answered = answeredInput(input, new Map([[asked!.question, 'dayjs']]))
  assert.deepEqual(answered['answers'], { 'Which library should we use?': 'dayjs' })
  assert.deepEqual(answered['questions'], input.questions)
})

test('the question\'s tool row is titled with the question, never the wire name', () => {
  const titled = questionTitled({
    sessionUpdate: 'tool_call',
    toolCallId: 'tu-1',
    title: 'AskUserQuestion',
    kind: 'other',
    status: 'pending',
    rawInput: input,
  } as never) as { title?: string; kind?: string }
  assert.equal(titled.title, 'Which library should we use?')
  assert.equal(titled.kind, 'think')
  const other = { sessionUpdate: 'tool_call', toolCallId: 'tu-2', title: 'Read src/a.ts', kind: 'read', status: 'pending' }
  assert.equal(questionTitled(other as never), other, 'every other row passes by reference')
})

test('a multi-select answer travels as joined option ids and goes back as joined labels', () => {
  const [asked] = questionsOf({ questions: [{ ...input.questions[0], multiSelect: true }] })
  assert.equal(answerFor(asked!, { outcome: 'selected', optionId: 'answer-0+answer-1' }), 'date-fns, dayjs')
  // A single-select question keeps one label even if a client joined two.
  const [single] = questionsOf(input)
  assert.equal(answerFor(single!, { outcome: 'selected', optionId: 'answer-0+answer-1' }), 'date-fns')
})

test('several questions in one call are several requests, and a dismissed one answers nothing', () => {
  const asked = questionsOf({
    questions: [
      input.questions[0],
      { question: 'Tabs or spaces?', header: 'Style', multiSelect: false, options: [{ label: 'Tabs', description: '' }, { label: 'Spaces', description: '' }] },
    ],
  })
  assert.equal(asked.length, 2)
  assert.deepEqual(asked.map((q) => permissionRequestFor('s1', 'tu-1', q).options.length), [2, 2])
  assert.equal(answerFor(asked[1]!, { outcome: 'cancelled' }), null)
})

test('the base bridge still disallows AskUserQuestion in the line the port removes', () => {
  // The ported createSession in bridge.ts exists to leave that one line out.
  // The day the base stops writing it — or writes it differently — the port
  // is a copy of code that no longer needs copying, and this says so.
  const require = createRequire(import.meta.url)
  const base = require.resolve('@zed-industries/claude-code-acp/dist/acp-agent.js')
  const source = readFileSync(base, 'utf8')
  assert.ok(
    source.includes('const disallowedTools = ["AskUserQuestion"];'),
    'the base bridge no longer disallows AskUserQuestion the way the port assumes — re-examine #createSession in bridge.ts',
  )
})

test('several questions in one call get one tool-call id each, so their cards do not land on each other', () => {
  assert.equal(questionCallId('tu-1', 0, 1), 'tu-1', 'one question keeps the call it belongs to')
  assert.equal(questionCallId('tu-1', 0, 2), 'tu-1#q1')
  assert.equal(questionCallId('tu-1', 1, 2), 'tu-1#q2')
})
