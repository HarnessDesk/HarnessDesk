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


test('account identity remains compatible and validates stable id and nickname', () => {
  const base = { name: 'Jane Doe', email: 'jane@example.com', pictureUrl: null }
  assert.equal(contract.AccountProfile.safeParse(base).success, true)
  assert.deepEqual(contract.AccountProfile.parse({ ...base, id: 'acct-a', nickname: '  Jane  ' }), { ...base, id: 'acct-a', nickname: 'Jane' })
  for (const id of ['', 'a'.repeat(257)]) assert.equal(contract.AccountProfile.safeParse({ ...base, id }).success, false)
  for (const nickname of ['', ' ', 'a'.repeat(81), 1]) assert.equal(contract.AccountProfile.safeParse({ ...base, nickname }).success, false)
  assert.equal(contract.AccountProfile.safeParse({ ...base, nickname: null }).success, true)
})

test('account profile updates accept exactly a nickname or explicit reset', () => {
  const update = schemas['UpdateAccountProfileRequest']
  assert.ok(update, 'nickname mutation must be shared')
  assert.equal(update.safeParse({ nickname: 'Jane' }).success, true)
  assert.equal(update.safeParse({ nickname: null }).success, true)
  for (const value of [{}, { nickname: '' }, { nickname: ' ' }, { nickname: 'a'.repeat(81) }, { nickname: 1 }, { nickname: 'Jane', accountId: 'acct-b' }, { nickname: 'Jane', name: 'Other' }, { nickname: null, email: 'other@example.com' }]) assert.equal(update.safeParse(value).success, false)
})
