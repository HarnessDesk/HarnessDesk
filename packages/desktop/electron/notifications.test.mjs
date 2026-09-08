import assert from 'node:assert/strict'
import { test } from 'node:test'

import { decide, relevant, SYSTEM_NOTIFICATION_KINDS } from './notifications.mjs'

/**
 * The rules for what leaves the app as a macOS notification. Four kinds,
 * nothing while the window is watched, each kind silenceable, and every body
 * built from what actually happened rather than a generic sentence.
 */

const context = (over = {}) => ({
  focused: false,
  prefs: {},
  agentName: (id) => (id === 'codex' ? 'OpenAI Codex' : id),
  sessionTitle: () => 'Fix the flaky test',
  ...over,
})

const turnCompleted = (status, error = null) => ({
  method: 'event',
  params: {
    runtime: 'codex',
    event: {
      type: 'turn/completed',
      sessionId: 's1',
      turn: { id: 't1', status, ...(error ? { error: { message: error } } : {}) },
    },
  },
})

const approval = (fields) => ({
  method: 'event',
  params: {
    runtime: 'codex',
    event: { type: 'approval/requested', approval: { sessionId: 's1', ...fields } },
  },
})

test('a finished turn names the agent and the conversation', () => {
  const plan = decide(turnCompleted('completed'), context())
  assert.ok(plan)
  assert.equal(plan.kind, 'turns')
  assert.equal(plan.title, 'OpenAI Codex finished')
  assert.equal(plan.body, 'Fix the flaky test')
  assert.equal(plan.sessionId, 's1', 'a click knows which conversation to open')
})

test('a failed turn carries the error, not a shrug', () => {
  const plan = decide(turnCompleted('failed', 'rate limit reached'), context())
  assert.ok(plan)
  assert.equal(plan.kind, 'failures')
  assert.match(plan.body, /rate limit reached/)
})

test('an interrupted turn is never announced — the user did it', () => {
  assert.equal(decide(turnCompleted('interrupted'), context()), null)
})

test('nothing while the window is focused', () => {
  assert.equal(decide(turnCompleted('completed'), context({ focused: true })), null)
})

test('a command approval says what it wants to run', () => {
  const plan = decide(
    approval({ type: 'command', command: 'rm -rf node_modules', options: [] }),
    context(),
  )
  assert.ok(plan)
  assert.equal(plan.kind, 'approvals')
  assert.match(plan.body, /rm -rf node_modules/)
})

test('a question from the agent is "needs you", with the question itself', () => {
  const plan = decide(
    approval({
      type: 'userInput',
      tool: 'AskUserQuestion',
      questions: [{ id: 'q', question: 'Which database should we use?', multiSelect: false, options: [] }],
    }),
    context(),
  )
  assert.ok(plan)
  assert.equal(plan.kind, 'needsYou')
  assert.equal(plan.title, 'OpenAI Codex needs you')
  assert.match(plan.body, /Which database/)
})

test('each kind honours its own switch, and the master wins over all', () => {
  assert.equal(decide(turnCompleted('completed'), context({ prefs: { turns: false } })), null)
  assert.equal(
    decide(turnCompleted('failed', 'x'), context({ prefs: { failures: false } })),
    null,
  )
  assert.equal(
    decide(approval({ type: 'command', command: 'ls' }), context({ prefs: { approvals: false } })),
    null,
  )
  assert.equal(
    decide(approval({ type: 'userInput', questions: [] }), context({ prefs: { needsYou: false } })),
    null,
  )
  // One switch off does not touch the others.
  const still = decide(turnCompleted('completed'), context({ prefs: { failures: false } }))
  assert.ok(still)
  // The master switch silences everything at once.
  assert.equal(decide(turnCompleted('completed'), context({ prefs: { enabled: false } })), null)
})

test('a body is one line and never a novel', () => {
  const plan = decide(
    approval({ type: 'command', command: `echo ${'x'.repeat(500)}`, options: [] }),
    context(),
  )
  assert.ok(plan)
  assert.ok(plan.body.length <= 140)
})

test('the settings page and the decider agree on the kinds', () => {
  assert.deepEqual(
    SYSTEM_NOTIFICATION_KINDS.map((entry) => entry.kind).sort(),
    ['approvals', 'failures', 'needsYou', 'turns'],
  )
})

test('the cheap pre-check never filters what decide would have shown', () => {
  // The shell calls `relevant` before paying for preferences, so the one
  // wrong thing it could do is reject a notification `decide` would act on.
  // Everything decide acts on must pass; what it rejects, decide must have
  // returned null for anyway.
  assert.equal(relevant(turnCompleted('completed')), true)
  assert.equal(relevant(turnCompleted('failed')), true)
  assert.equal(relevant(approval({ type: 'command', command: 'ls', options: [] })), true)

  const noise = [
    null,
    { method: 'sync', params: {} },
    { method: 'runtime/healthChanged', params: {} },
    { method: 'event', params: { runtime: 'codex', event: { type: 'session/updated' } } },
    { method: 'event', params: { runtime: 'codex', event: { type: 'turn/delta', chunk: 'x' } } },
  ]
  for (const notification of noise) {
    assert.equal(relevant(notification), false)
    assert.equal(decide(notification, context()), null, 'rejected means decide had nothing to say')
  }
})
