import { describe, expect, it } from 'vitest'
import type { Account } from '@harnessdesk/protocol'
import { accountName, shownDeskName } from './accounts'

it('handles a missing account label when no agent name is supplied', () => {
  const account = { kind: 'oauth', anonymous: true } as Account
  expect(accountName(account, undefined)).toBe('')
  expect(accountName({ ...account, email: 'dev@example.com' }, undefined)).toBe('dev')
  expect(accountName(account, { nickname: 'Work' })).toBe('Work')
})

describe('the HarnessDesk account name while addresses are hidden', () => {
  it('cuts a name that is itself an address, and never falls back to the email', () => {
    expect(shownDeskName({ name: 'jane@example.com', email: 'jane@example.com' }, true)).toBe('jane')
    expect(shownDeskName({ name: null, email: 'jane@example.com' }, true)).toBeNull()
    expect(shownDeskName({ name: 'Jane Doe', email: 'jane@example.com' }, true)).toBe('Jane Doe')
    expect(shownDeskName({ name: null, email: 'jane@example.com' }, false)).toBe('jane@example.com')
  })
})
