import assert from 'node:assert/strict'
import { test } from 'node:test'
import { accountDisplayName, accountUserActor, roomUserIdentity } from '../src/index.js'

test('account display name prefers nickname, provider name, then the privacy-aware address fallback', () => {
  assert.equal(accountDisplayName({ nickname: 'Work Jane', name: 'Jane Doe', email: 'jane@example.com' }), 'Work Jane')
  assert.equal(accountDisplayName({ nickname: null, name: 'Jane Doe', email: 'jane@example.com' }), 'Jane Doe')
  assert.equal(accountDisplayName({ email: 'jane@example.com' }), 'jane@example.com')
  assert.equal(accountDisplayName({ email: 'jane@example.com' }, true), null)
  assert.equal(accountDisplayName({ nickname: 'jane@example.com' }, true), 'jane')
})

test('unknown and historical user actors never borrow a current account identity', () => {
  for (const actor of [null, undefined, 1, [], {}, { kind: 'user' }, { kind: 'agent', accountId: 'jane' }, { kind: 'user', accountId: 1 }, { kind: 'user', accountId: ' ' }, { kind: 'user', accountId: 'x'.repeat(257) }]) {
    assert.equal(roomUserIdentity(actor), null)
  }
  assert.deepEqual(roomUserIdentity({ kind: 'user', accountId: 'jane', name: 'Work Jane', email: 'jane@example.com', picture: 'data:image/png' }), { accountId: 'jane', name: 'Work Jane' })
  assert.deepEqual(roomUserIdentity({ kind: 'user', accountId: 'jane', name: 'jane@example.com' }), { accountId: 'jane' })
})

test('the host actor uses only known id and safe nickname/provider name', () => {
  assert.deepEqual(accountUserActor(undefined), { kind: 'user' })
  assert.deepEqual(accountUserActor({ name: 'Jane Doe', email: 'jane@example.com' }), { kind: 'user' })
  assert.deepEqual(accountUserActor({ id: 'jane', nickname: 'Work Jane', name: 'Jane Doe', email: 'jane@example.com' }), { kind: 'user', accountId: 'jane', name: 'Work Jane' })
  assert.deepEqual(accountUserActor({ id: 'jane', nickname: null, name: 'Jane Doe' }), { kind: 'user', accountId: 'jane', name: 'Jane Doe' })
  assert.deepEqual(accountUserActor({ id: 'jane', email: 'jane@example.com' }), { kind: 'user', accountId: 'jane' })
  assert.deepEqual(accountUserActor({ id: 'jane', name: 'jane@example.com' }), { kind: 'user', accountId: 'jane' })
})
