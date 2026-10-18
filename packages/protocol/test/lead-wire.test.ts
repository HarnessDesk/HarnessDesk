import assert from 'node:assert/strict'
import test from 'node:test'
import { CLIENT_METHODS, knownMethods, parseClientMessage } from '../src/index.js'

const names = ['lead/thread/read', 'lead/thread/send', 'lead/card/decide', 'lead/settings/read', 'lead/settings/update', 'lead/resume']
const request = (method: string, params: unknown) => parseClientMessage({ id: 1, method, params })

test('exactly six Lead window controls validate and none is on the client surface', () => {
  assert.deepEqual(knownMethods.filter(name => name.startsWith('lead/')).sort(), [...names].sort())
  for (const name of names) assert.equal(Object.hasOwn(CLIENT_METHODS, name), false)
  for (const name of ['lead/thread/read', 'lead/settings/read']) assert.doesNotThrow(() => request(name, {}))
  assert.doesNotThrow(() => request('lead/thread/send', { idempotencyKey: 'send-1', text: 'Inspect the check' }))
  assert.doesNotThrow(() => request('lead/resume', { expectedRevision: 0 }))
  assert.doesNotThrow(() => request('lead/settings/update', { expectedRevision: 0, credential: { provider: 'anthropic', key: 'sk-test-not-real-0000' } }))
  assert.doesNotThrow(() => request('lead/card/decide', { version: 1, cardId: 'plan', cardType: 'plan', expectedRevision: 1, contractDigest: 'a'.repeat(64), choice: 'approve' }))
})

test('Lead controls reject open shapes, invalid fences and unbounded secret/text input', () => {
  const bad: [string, unknown][] = [
    ['lead/thread/read', { key: 'sk-test-not-real-0000' }],
    ['lead/thread/send', { text: 'missing receipt' }],
    ['lead/thread/send', { idempotencyKey: '', text: 'hello' }],
    ['lead/thread/send', { idempotencyKey: 'send', text: 'x'.repeat(16385) }],
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
