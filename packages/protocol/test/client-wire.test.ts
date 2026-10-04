import assert from 'node:assert/strict'
import test from 'node:test'
import { CLIENT_METHODS, clientTierFor, parseClientMessage, ValidationError } from '../src/index.js'

const request = (method: string, params: unknown) => parseClientMessage({ id: 1, method, params })

test('client hello validates bounded identity and subscribe validates topics and scope', () => {
  assert.doesNotThrow(() => request('client/hello', { client: { name: 'test', version: '1' }, protocol: 1 }))
  for (const field of ['name', 'version']) {
    assert.throws(() => request('client/hello', { client: { name: 'test', version: '1', [field]: 'x'.repeat(65) }, protocol: 1 }), ValidationError)
  }
  assert.doesNotThrow(() => request('client/subscribe', { topics: ['runs', 'cards', 'teams', 'waiting', 'notices'], scope: { run: 'r1' } }))
  assert.throws(() => request('client/subscribe', { topics: ['sessions'] }), ValidationError)
  assert.throws(() => request('client/subscribe', { topics: [], scope: { run: '' } }), ValidationError)
})

test('execution listing validates its optional filters', () => {
  assert.doesNotThrow(() => request('flow/executions', {}))
  assert.doesNotThrow(() => request('flow/executions', { team: 'g1', project: '/repo', active: false }))
  assert.throws(() => request('flow/executions', { active: 'yes' }), ValidationError)
})

test('seat and review subscriptions and read-only review rounds validate', () => {
  assert.doesNotThrow(() => request('client/subscribe', { topics: ['seats', 'reviews'] }))
  assert.doesNotThrow(() => request('finding/run', { goal: 'demo-team', run: 'demo-run' }))
  assert.throws(() => request('finding/run', { goal: 'demo-team', run: '' }), ValidationError)
})

test('a check’s recorded attempts are a window read, so the client door does not answer them at any tier', () => {
  assert.equal(clientTierFor('flow/check/attempts'), null)
  assert.equal(clientTierFor('flow/check/attempts', { run: 'r1', card: 1 }), null)
  assert.equal(Object.hasOwn(CLIENT_METHODS, 'flow/check/attempts'), false)
})
