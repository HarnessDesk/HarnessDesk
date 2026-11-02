import { describe, expect, it } from 'vitest'
import type { Account } from '@harnessdesk/protocol'
import { accountName, shownDeskName } from './accounts'

it('handles a missing account label when no agent name is supplied', () => {
  const account = { kind: 'oauth', anonymous: true } as Account
  expect(accountName(account, undefined)).toBe('')
  expect(accountName({ ...account, email: 'dev@example.com' }, undefined)).toBe('dev')
  expect(accountName(account, { nickname: 'Work' })).toBe('Work')
  // A nickname typed as an address is shown as typed, and cut at the @ only
  // while addresses are hidden.
  expect(accountName(account, { nickname: 'jane@example.com' })).toBe('jane@example.com')
  expect(accountName(account, { nickname: 'jane@example.com' }, undefined, true)).toBe('jane')
})

describe('the HarnessDesk account name while addresses are hidden', () => {
  it('cuts a name that is itself an address, and never falls back to the email', () => {
    expect(shownDeskName({ name: 'jane@example.com', email: 'jane@example.com' }, true)).toBe('jane')
    expect(shownDeskName({ name: null, email: 'jane@example.com' }, true)).toBeNull()
    expect(shownDeskName({ name: 'Jane Doe', email: 'jane@example.com' }, true)).toBe('Jane Doe')
    expect(shownDeskName({ name: null, email: 'jane@example.com' }, false)).toBe('jane@example.com')
  })
})
