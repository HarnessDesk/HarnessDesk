import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as contract from '../src/index.js'

const schemas = contract as unknown as Record<string, { safeParse(value: unknown): { success: boolean } }>
const deskId = 'A'.repeat(22)
test('desk link schemas distinguish polling from browser approval and validate proofs', () => {
  assert.ok(schemas['StartDeskLinkRequest'], 'desk link must be in the shared contract')
  assert.equal(schemas['StartDeskLinkRequest']!.safeParse({ deskPub: 'A'.repeat(43), name: 'Studio Mac', challenge: 'A'.repeat(43), sig: 'A'.repeat(86) }).success, true)
  assert.equal(schemas['PollDeskLinkRequest']!.safeParse({ userCode: 'ABCD-EFGH' }).success, false)
  assert.equal(schemas['DeskLinkCodeRequest']!.safeParse({ pollSecret: 'A'.repeat(43) }).success, false)
  assert.equal(schemas['PollDeskLinkResponse']!.safeParse({ status: 'approved', deskId }).success, true)
  assert.equal(schemas['PollDeskLinkResponse']!.safeParse({ status: 'approved' }).success, false)
})
test('desk account schemas validate identity and phone data without inventing missing fields', () => {
  assert.ok(schemas['DeskAccountResponse'], 'desk account response must be shared')
  const response = { account: { name: 'Jane Doe', email: 'jane@example.com', pictureUrl: null }, desk: { deskId, name: 'Studio Mac' }, phones: [{ deviceId: deskId, name: 'Phone', lastSeenAt: null }] }
  assert.equal(schemas['DeskAccountResponse']!.safeParse(response).success, true)
  assert.equal(schemas['DeskAccountResponse']!.safeParse({ ...response, account: { name: null, email: null, pictureUrl: 'javascript:alert(1)' } }).success, false)
  assert.equal(schemas['RenameDeskRequest']!.safeParse({ name: ' ' }).success, false)
  assert.equal(schemas['RevokeDeskRequest']!.safeParse({ deskId: 'bad' }).success, false)
})
