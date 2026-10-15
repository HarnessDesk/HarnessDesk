import { RuntimesTestPage as RuntimesSection } from '../test-support/settings-page'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { runtimeId, NO_CAPABILITIES, type AccountStatus, type RuntimeInfo } from '@harnessdesk/protocol'

import { StoreProvider } from '../state/context'
import { emptySnapshot, type AppSnapshot, type AppStore } from '../state/store'
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

/**
 * What the account page says about a key, by where the agent reads it from.
 *
 * "HarnessDesk holds no copy" was true of every key the agent read from
 * somewhere else, until an agent could read one ahead of the key HarnessDesk
 * hands it; the page now says which of the two it is.
 */

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

const DEEP = runtimeId('keyed-agent')

const info: RuntimeInfo = {
  id: DEEP,
  name: 'keyed-agent',
  presentation: { name: 'Keyed Agent' },
  capabilities: { ...NO_CAPABILITIES, account: true },
} as unknown as RuntimeInfo

const mount = async (account: Record<string, unknown>): Promise<void> => {
  const status = {
    accounts: [{ kind: 'externalKey', label: 'Keyed API key', planType: 'its own store', ...account }],
    signInMethods: [{ id: 'key', flow: 'apiKey', label: 'API key', keyLabel: 'Keyed API key' }],
  } as unknown as AccountStatus
  const snapshot: AppSnapshot = {
    ...emptySnapshot(),
    status: 'open',
    runtimes: [info],
    activeRuntime: DEEP,
    accountsByRuntime: { [DEEP]: status },
    healthByRuntime: { [DEEP]: { state: 'ready' } },
    usage: [],
    credentialProtection: 'encrypted by the system keychain',
  } as unknown as AppSnapshot
  const store = {
    transport: { request: vi.fn(async () => null) },
    subscribe: () => () => {},
    getSnapshot: () => snapshot,
    loadAccounts: vi.fn(async () => {}),
    limitsFor: vi.fn(async () => null),
    readPlan: vi.fn(async () => ({ entry: null, suggestion: null, refusal: null })),
    loadUsage: vi.fn(async () => {}),
    agentCatalog: vi.fn(async () => []),
    acpRegistry: vi.fn(async () => ({ agents: [], fetchedAt: 1 })),
    setAccountPrefs: vi.fn(),
    healthFor: vi.fn(async () => null),
    optionsFor: vi.fn(async () => []),
    newSessionDefaultsFor: vi.fn(async () => []),
  } as unknown as AppStore
  await act(async () => {
    root.render(
      <StoreProvider store={store}>
        <RuntimesSection onSignIn={() => {}} />
      </StoreProvider>,
    )
  })
  const agentLine = container.querySelector('[data-slot="agent-row"]')
  if (agentLine) await act(async () => (agentLine as HTMLButtonElement).click())
  const accountLine = [...container.querySelectorAll('button')].find((node) => node.textContent?.includes('Keyed API key'))
  if (accountLine) await act(async () => accountLine.click())
}

const text = (): string => container.textContent ?? ''

describe('the account page for a key the agent reads from somewhere else', () => {
  it('says HarnessDesk holds no copy when it holds none', async () => {
    await mount({})
    expect(text()).toContain('Read from its own store. HarnessDesk holds no copy.')
  })

  it('says the copy HarnessDesk keeps comes after it, rather than that there is none', async () => {
    await mount({ storedCopy: true })
    expect(text()).toContain('Read from its own store, which comes before the copy HarnessDesk keeps — encrypted by the system keychain.')
    expect(text()).not.toContain('holds no copy')
  })
})
