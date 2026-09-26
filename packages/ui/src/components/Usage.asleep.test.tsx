import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { AccountStatus, RuntimeInfo } from '@harnessdesk/protocol'
import { NO_CAPABILITIES, runtimeId } from '@harnessdesk/protocol'

import { StoreProvider } from '../state/context'
import { emptySnapshot, type AppSnapshot, type AppStore } from '../state/store'
import { Usage } from './Usage'

/**
 * The Dashboard's "has nothing to report" callout (#986).
 *
 * `asleep` used to pick the first tracked agent `readinessOf` called
 * `signin`, and that included one that had simply not answered
 * `runtime/account` yet — still loading, or a read that failed silently. The
 * callout and its "Sign in to X" button then claimed a sign-in was needed for
 * however long the read took, or forever if it never came back.
 */

const codex = {
  id: runtimeId('codex'),
  name: 'OpenAI Codex',
  capabilities: { ...NO_CAPABILITIES, account: true },
  presentation: { name: 'OpenAI Codex' },
} as unknown as RuntimeInfo

const signedOut: AccountStatus = {
  accounts: [],
  signInMethods: [{ id: 'browser', label: 'Sign in', flow: 'browser' }],
} as unknown as AccountStatus

const storeWith = (accountsByRuntime: AppSnapshot['accountsByRuntime']): AppStore => {
  const snapshot = {
    ...emptySnapshot(),
    status: 'open',
    runtimes: [codex],
    activeRuntime: codex.id,
    health: { state: 'ready' },
    healthByRuntime: { [codex.id]: { state: 'ready' } },
    accountsByRuntime,
  } as AppSnapshot
  return {
    subscribe: () => () => {},
    getSnapshot: () => snapshot,
    transport: { request: vi.fn(async () => null) },
    loadAccounts: vi.fn(async () => {}),
    loadUsage: vi.fn(async () => {}),
    refreshUsage: vi.fn(async () => {}),
    ledger: vi.fn(async () => null),
  } as unknown as AppStore
}

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

const render = async (accountsByRuntime: AppSnapshot['accountsByRuntime']): Promise<void> => {
  await act(async () =>
    root.render(
      <StoreProvider store={storeWith(accountsByRuntime)}>
        <Usage onClose={() => {}} onSignIn={() => {}} />
      </StoreProvider>,
    ),
  )
}

describe('the "has nothing to report" callout', () => {
  it('does not offer a sign-in before the agent has answered who is signed in', async () => {
    // Codex is absent from accountsByRuntime altogether.
    await render({})
    expect(document.body.textContent).not.toContain('has nothing to report')
    expect(document.body.textContent).not.toContain('Sign in to')
  })

  it('still offers a sign-in once the agent has answered and confirmed nobody is', async () => {
    await render({ [codex.id]: signedOut })
    expect(document.body.textContent).toContain('has nothing to report')
    expect(document.body.textContent).toContain('Sign in to OpenAI Codex')
  })
})
