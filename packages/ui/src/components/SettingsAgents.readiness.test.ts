import { describe, expect, it } from 'vitest'

import { runtimeId, type AccountStatus, type RuntimeInfo } from '@harnessdesk/protocol'

import { agentReadiness } from './SettingsAgents'

/**
 * The agent list's aggregate readiness, over an agent's own runtimes (#986).
 *
 * `agentReadiness` used to fall to `signin` the moment no sibling had
 * answered with an account, whether or not any of them had actually said so
 * — an unanswered `runtime/account` and a confirmed sign-out read the same.
 */

const runtime = (id: string, name: string, over: Partial<RuntimeInfo> = {}): RuntimeInfo =>
  ({ id: runtimeId(id), name, capabilities: { account: true }, presentation: { name }, ...over }) as unknown as RuntimeInfo

const signedOut: AccountStatus = {
  accounts: [],
  signInMethods: [{ id: 'browser', label: 'Sign in', flow: 'browser' }],
} as unknown as AccountStatus

const view = (accountsByRuntime: Record<string, AccountStatus>) => ({
  accountsByRuntime: accountsByRuntime as never,
  accountPrefs: {},
  healthByRuntime: {},
  usage: [],
})

describe('agentReadiness', () => {
  it('is not signin before any sibling has answered who is signed in', () => {
    const solo = runtime('solo', 'Solo Agent')
    expect(agentReadiness([solo], view({}))).toBe('unknown')
  })

  it('is signin once every sibling has answered and confirmed nobody is', () => {
    const solo = runtime('solo', 'Solo Agent')
    expect(agentReadiness([solo], view({ solo: signedOut }))).toBe('signin')
  })

  it('stays unknown while any sibling has not answered, even if another has', () => {
    const first = runtime('first', 'Agent')
    const second = runtime('second', 'Agent')
    expect(agentReadiness([first, second], view({ first: signedOut }))).toBe('unknown')
  })

  it('reads ready for an agent that never does accounts through the desk', () => {
    const cline = runtime('cline', 'Cline', { capabilities: { account: false } } as Partial<RuntimeInfo>)
    expect(agentReadiness([cline], view({}))).toBe('ready')
  })
})
