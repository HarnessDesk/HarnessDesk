import { expect, it } from 'vitest'
import { runtimeId, type Account, type RuntimeInfo } from '@harnessdesk/protocol'
import { runtimeAccountBadge } from './accounts'

const runtime = (id: string, agent = 'alpha'): RuntimeInfo => ({ id: runtimeId(id), name: 'Alpha', slot: { agent: runtimeId(agent) }, presentation: { name: 'Alpha' } } as RuntimeInfo)
const account = (label: string): Account => ({ kind: 'oauth', label })
const runtimes = [runtime('one'), runtime('two'), runtime('other', 'beta')]
const accounts = { one: { accounts: [account('alice@example.com')] }, two: { accounts: [account('amy@example.com')] }, other: { accounts: [account('alice@example.com')] } }

it('qualifies only families with two signed-in accounts, using unique letters', () => {
  expect(runtimeAccountBadge(runtimes[0]!, runtimes, accounts, {})).toBe('AL')
  expect(runtimeAccountBadge(runtimes[1]!, runtimes, accounts, {})).toBe('AM')
  expect(runtimeAccountBadge(runtimes[2]!, runtimes, accounts, {})).toBeUndefined()
  expect(runtimeAccountBadge(runtimes[0]!, runtimes, { [runtimeId('one')]: accounts.one }, {})).toBeUndefined()
})

it('uses nicknames, stays stable when runtime order changes, and resolves identical initials', () => {
  const prefs = { 'one:oauth:alice@example.com': { nickname: 'Work' }, 'two:oauth:amy@example.com': { nickname: 'Personal' } }
  expect(runtimeAccountBadge(runtimes[0]!, runtimes, accounts, prefs)).toBe('W')
  expect(runtimeAccountBadge(runtimes[1]!, [...runtimes].reverse(), accounts, prefs)).toBe('P')
  const same = { ...prefs, 'two:oauth:amy@example.com': { nickname: 'Work' } }
  const first = runtimeAccountBadge(runtimes[0]!, runtimes, accounts, same)
  const second = runtimeAccountBadge(runtimes[1]!, runtimes, accounts, same)
  expect(first).toHaveLength(2)
  expect(second).toHaveLength(2)
  expect(first).not.toBe(second)
  expect(runtimeAccountBadge(runtimes[0]!, [...runtimes].reverse(), accounts, same)).toBe(first)
})

it('qualifies several accounts returned by one runtime and names the requested account', () => {
  const info = runtimes[0]!
  const first = account('alice@example.com')
  const second = account('amy@example.com')
  const several = { [info.id]: { accounts: [first, second] } }
  expect(runtimeAccountBadge(info, [info], several, {}, first)).toBe('AL')
  expect(runtimeAccountBadge(info, [info], several, {}, second)).toBe('AM')
})
