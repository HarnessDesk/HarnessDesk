import assert from 'node:assert/strict'
import test from 'node:test'
import { CLIENT_METHODS, knownMethods, parseClientMessage } from '../src/index.js'

const names = ['lead/repeat/control', 'lead/budget/raise', 'lead/wakes/read', 'lead/thread/read', 'lead/thread/send', 'lead/card/decide', 'lead/settings/read', 'lead/settings/update', 'lead/resume', 'lead/stop', 'lead/action/perform', 'lead/steer', 'lead/memory/read', 'lead/memory/update', 'lead/schedule/read', 'lead/schedule/update']
const chatNames = ['lead/chat/list', 'lead/chat/read', 'lead/chat/start', 'lead/chat/send', 'lead/chat/stop']
const request = (method: string, params: unknown) => parseClientMessage({ id: 1, method, params })

test('the closed Lead window controls validate and none is on the client surface', () => {
  assert.deepEqual(knownMethods.filter(name => name.startsWith('lead/')).sort(), [...names, ...chatNames].sort())
  for (const name of names) assert.equal(Object.hasOwn(CLIENT_METHODS, name), false)
  for (const name of ['lead/wakes/read', 'lead/thread/read', 'lead/settings/read']) assert.doesNotThrow(() => request(name, {}))
  assert.doesNotThrow(() => request('lead/thread/send', { idempotencyKey: 'send-1', text: 'Inspect the check' }))
  assert.doesNotThrow(() => request('lead/resume', { expectedRevision: 0 }))
  assert.doesNotThrow(() => request('lead/stop', { expectedRevision: 0 }))
  assert.doesNotThrow(() => request('lead/settings/update', { expectedRevision: 0, credential: { provider: 'anthropic', key: 'sk-test-not-real-0000' } }))
  assert.doesNotThrow(() => request('lead/card/decide', { version: 1, cardId: 'result', cardType: 'result', expectedRevision: 1, contractDigest: 'a'.repeat(64), choice: 'accept-open-pr' }))
  assert.doesNotThrow(() => request('lead/settings/update', { expectedRevision: 1, follow: { checks: false, reviews: true } }))
  assert.doesNotThrow(() => request('lead/card/decide', { version: 1, cardId: 'plan', cardType: 'plan', expectedRevision: 1, contractDigest: 'a'.repeat(64), choice: 'approve' }))
})

test('Lead controls reject open shapes, invalid fences and unbounded secret/text input', () => {
  const bad: [string, unknown][] = [
    ['lead/thread/read', { key: 'sk-test-not-real-0000' }],
    ['lead/thread/send', { text: 'missing receipt' }],
    ['lead/thread/send', { idempotencyKey: '', text: 'hello' }],
    ['lead/thread/send', { idempotencyKey: 'send', text: 'x'.repeat(16385) }],
    ['lead/stop', { expectedRevision: -1 }], ['lead/stop', { expectedRevision: 1, merge: true }],
    ['lead/resume', { expectedRevision: -1 }], ['lead/resume', { expectedRevision: 1, answer: true }],
    ['lead/settings/update', { expectedRevision: 1, credential: { provider: 'other', key: 'secret' } }],
    ['lead/settings/update', { expectedRevision: 1, credential: { provider: 'anthropic', key: 'x'.repeat(4097) } }],
    ['lead/card/decide', { version: 1, cardId: 'worker', cardType: 'waiting', expectedRevision: 1, choice: 'accept' }],
  ]
  for (const [method, params] of bad) assert.throws(() => request(method, params), { name: 'ValidationError' }, method)
})


test('credential provider validation never echoes a key-shaped value', () => {
  const secret = 'sk-ant-test-not-real-0000' // hd-secrets-ok: synthetic provider credential
  assert.throws(() => request('lead/settings/update', { expectedRevision: 0, credential: { provider: secret, key: null } }), (error: any) =>
    error.name === 'ValidationError' && !String(error).includes(secret))
})


test('Lead ordinary chat operations have bounded closed inputs and narrow client tiers', () => {
  for (const [method, params] of [
    ['lead/chat/list', {}], ['lead/chat/list', { limit: 50, cursor: 'opaque' }],
    ['lead/chat/read', { id: 'agent:session' }], ['lead/chat/start', { text: 'Do the task' }],
    ['lead/chat/send', { id: 'agent:session', text: 'Continue' }], ['lead/chat/stop', { id: 'agent:session' }],
  ] as const) assert.doesNotThrow(() => request(method, params))
  for (const name of chatNames) assert.equal(CLIENT_METHODS[name as keyof typeof CLIENT_METHODS], name.endsWith('/list') || name.endsWith('/read') ? 'read' : 'run')
  for (const [method, params] of [
    ['lead/chat/list', { limit: 0 }], ['lead/chat/list', { limit: 51 }], ['lead/chat/list', { limit: 1.5 }],
    ['lead/chat/read', { id: 'x'.repeat(301) }], ['lead/chat/start', { text: 'x'.repeat(16385) }],
    ['lead/chat/send', { id: 'agent:session', text: 'Continue', permissions: 'bypass' }],
    ['lead/chat/stop', { id: 'agent:session', approve: true }], ['lead/chat/list', { root: '/foreign' }],
  ] as const) assert.throws(() => request(method, params), { name: 'ValidationError' })
})

test('repeat controls and direct allowance raises are person-only closed inputs', () => {
  for (const action of ['pause', 'resume', 'stop', 'run-now']) assert.doesNotThrow(() => request('lead/repeat/control', { taskId: 'repeat-1', action }))
  assert.doesNotThrow(() => request('lead/budget/raise', { logicalGoalId: 'goal-1', caps: { usdMicros: 6_000_000, rounds: 3 }, expectedRevision: 1 }))
  for (const [method, params] of [['lead/repeat/control', { taskId: 'repeat-1', action: 'approve' }], ['lead/budget/raise', { logicalGoalId: 'goal-1', caps: { usdMicros: -1, rounds: 3 }, expectedRevision: 1 }]]) assert.throws(() => request(method as string, params))
})
