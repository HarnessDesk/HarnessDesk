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

test('library reads are on the read tier while plan and apply stay off the client surface', () => {
  for (const method of ['library/read', 'library/definition', 'library/usage']) {
    assert.equal(clientTierFor(method), 'read', method)
  }
  for (const method of ['library/plan', 'library/apply']) {
    assert.equal(clientTierFor(method), null, method)
    assert.equal(Object.hasOwn(CLIENT_METHODS, method), false, method)
  }
})

test('session loadout is a read with a required session and optional runtime', () => {
  assert.equal(clientTierFor('session/loadout'), 'read')
  assert.doesNotThrow(() => request('session/loadout', { session: 'demo' }))
  assert.doesNotThrow(() => request('session/loadout', { session: 'demo', runtime: 'fake' }))
  for (const params of [{}, { session: 1 }, { session: 'demo', runtime: false }]) {
    assert.throws(() => request('session/loadout', params), ValidationError)
  }
})

test('historical Seat evidence is available at the client read tier', () => {
  assert.equal(clientTierFor('evidence/seat'), 'read')
  assert.doesNotThrow(() => request('evidence/seat', { runtime: 'fake', sessionId: 'demo' }))
})

test('Seat attachment readback is available at the client read tier', () => {
  assert.equal(clientTierFor('attachment/seat'), 'read')
  assert.doesNotThrow(() => request('attachment/seat', { seat: 'seat-demo' }))
  assert.throws(() => request('attachment/seat', { seat: '' }), ValidationError)
})
