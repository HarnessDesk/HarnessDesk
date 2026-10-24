import assert from 'node:assert/strict'
import { test } from 'node:test'
import { CLIENT_METHODS, clientTierFor, parseClientMessage, ValidationError } from '../src/index.js'
const request = (method: string, params: unknown) => parseClientMessage({ id: 1, method, params })
test('app account controls validate desk names, phone ids and boolean preferences at the wire', () => {
  assert.doesNotThrow(() => request('account/status', {}))
  assert.doesNotThrow(() => request('account/signOut', { localOnly: true }))
  assert.throws(() => request('account/signOut', { localOnly: 'true' }), ValidationError)
  assert.doesNotThrow(() => request('account/renameDesk', { name: 'Studio Mac' }))
  assert.doesNotThrow(() => request('account/unlinkPhone', { deviceId: 'A'.repeat(22) }))
  for (const name of ['', ' ', 'x'.repeat(81), 1]) assert.throws(() => request('account/renameDesk', { name }), ValidationError)
  for (const deviceId of ['', 'short', 'A'.repeat(21) + 'B']) assert.throws(() => request('account/unlinkPhone', { deviceId }), ValidationError)
  assert.throws(() => request('account/setReachable', { reachable: 'true' }), ValidationError)
})
test('app account identity and controls are confined to the local renderer door', () => {
  for (const method of ['account/status', 'account/signIn', 'account/openSignIn', 'account/cancel', 'account/signOut', 'account/phones', 'account/unlinkPhone', 'account/renameDesk', 'account/setReachable']) {
    assert.equal(clientTierFor(method), null, method)
    assert.equal(Object.hasOwn(CLIENT_METHODS, method), false, method)
  }
})
