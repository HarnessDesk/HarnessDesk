import { expect, it } from 'vitest'
import type { Account } from '@harnessdesk/protocol'
import { accountName } from './accounts'

it('handles a missing account label when no agent name is supplied', () => {
  const account = { kind: 'oauth', anonymous: true } as Account
  expect(accountName(account, undefined)).toBe('')
  expect(accountName({ ...account, email: 'dev@example.com' }, undefined)).toBe('dev')
  expect(accountName(account, { nickname: 'Work' })).toBe('Work')
})
