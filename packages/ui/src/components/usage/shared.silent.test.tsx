import { describe, expect, it } from 'vitest'

import { NO_CAPABILITIES, runtimeId, type AccountStatus, type RuntimeInfo } from '@harnessdesk/protocol'

import { silentAgentsOf } from './shared'

/**
 * `silentAgentsOf` is the Dashboard's "has nothing to report — sign in" list, not its Not reporting cards. It needs
 * no usage-read gate (review round 4 of #2118, item 2): an agent enters it only on the account read's own answer
 * that nobody is signed in, and until that answer arrives the agent reads `unknown`, not silent.
 */

const CURSOR = runtimeId('cursor')
const info = { id: CURSOR, name: 'cursor', presentation: { name: 'Cursor' }, capabilities: { ...NO_CAPABILITIES, account: true } } as unknown as RuntimeInfo
const base = { activeRuntime: null, health: null, usage: [] }

describe('which agents the Dashboard calls signed out', () => {
  it('calls no agent signed out before its account read has answered, whatever the usage reads say', () => {
    expect(silentAgentsOf([info], { ...base, accountsByRuntime: {} })).toEqual([])
  })

  it('calls an agent signed out once its account read answered that nobody is signed in', () => {
    const nobody = { accounts: [], signInMethods: [] } as unknown as AccountStatus
    expect(silentAgentsOf([info], { ...base, accountsByRuntime: { [CURSOR]: nobody } }).map((agent) => agent.info.id)).toEqual([CURSOR])
  })

  it('does not call an agent signed out whose account read has not been made yet', () => {
    const unchecked = { accounts: [], signInMethods: [], unchecked: true } as unknown as AccountStatus
    expect(silentAgentsOf([info], { ...base, accountsByRuntime: { [CURSOR]: unchecked } })).toEqual([])
  })
})
