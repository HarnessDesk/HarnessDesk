import assert from 'node:assert/strict'
import { test } from 'node:test'
import { clientTierFor, parseClientMessage, ValidationError } from '../src/index.js'

test('cache snapshot requests require both runtime and session identity', () => {
  const request = (params: unknown) => parseClientMessage({ id: 1, method: 'session/cache-snapshot', params })
  assert.doesNotThrow(() => request({ runtime: 'synthetic', sessionId: 'one' }))
  assert.throws(() => request({ runtime: 'synthetic' }), ValidationError)
  assert.throws(() => request({ sessionId: 'one' }), ValidationError)
})

test('cache snapshots are not exposed on the limited client surface', () => {
  assert.equal(clientTierFor('session/cache-snapshot'), null)
})
