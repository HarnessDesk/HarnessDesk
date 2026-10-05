import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import {
  runtimeId,
  NO_CAPABILITIES,
  type AccountStatus,
  type RuntimeInfo,
  type UsageLane,
  type UsageReport,
} from '@harnessdesk/protocol'

import { StoreProvider } from '../state/context'
import { emptySnapshot, type AppSnapshot, type AppStore } from '../state/store'
import { RuntimesSection } from './SettingsAgents'

/** Default is a neutral mode on a record's name line. Detail pages still
 * report readiness separately; a neutral list mode must not erase that fact. */

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

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

const CLAUDE = runtimeId('claude')

const info: RuntimeInfo = {
  id: CLAUDE,
  name: 'claude',
  presentation: { name: 'Claude Code', tagline: 'A coding agent.' },
  capabilities: { ...NO_CAPABILITIES, account: true },
} as unknown as RuntimeInfo

const signedIn: AccountStatus = {
  accounts: [{ kind: 'oauth', label: 'olivia@acme.dev' }],
  signInMethods: [],
} as unknown as AccountStatus

const signedOut: AccountStatus = { accounts: [], signInMethods: [] } as unknown as AccountStatus

const lane = (over: Partial<UsageLane> & Pick<UsageLane, 'id' | 'usedPercent'>): UsageLane =>
  ({ label: 'Weekly', windowMinutes: 10080, resetsAt: null, ...over }) as UsageLane

/** One account, its account-wide weekly gone — `limit`, which health cannot see. */
const spent: UsageReport = {
  runtime: CLAUDE,
  account: 'olivia@acme.dev',
  plan: 'Max',
  lanes: [lane({ id: 'weekly', usedPercent: 100 })],
  credits: null,
  spend: null,
  reached: 'weekly',
  source: { kind: 'runtime', label: 'its own API' },
  fetchedAt: 0,
  staleAfterMs: 600000,
  error: null,
} as unknown as UsageReport

const mount = async (over: Partial<AppSnapshot>): Promise<void> => {
  const snapshot: AppSnapshot = {
    ...emptySnapshot(),
    status: 'open',
    runtimes: [info],
    activeRuntime: CLAUDE,
    healthByRuntime: { [CLAUDE]: { state: 'ready' } },
    ...over,
  } as unknown as AppSnapshot
  const store = {
    subscribe: () => () => {},
    getSnapshot: () => snapshot,
    loadAccounts: vi.fn(async () => {}),
    agentCatalog: vi.fn(async () => []),
    acpRegistry: vi.fn(async () => ({ agents: [], fetchedAt: 1 })),
    setAccountPrefs: vi.fn(),
    selectRuntime: vi.fn(async () => {}),
    /* The page reads its own health on mount; it answers what the snapshot
       holds, as the real store does. */
    healthFor: vi.fn(async () => (snapshot.healthByRuntime as Record<string, unknown>)[CLAUDE] ?? null),
    optionsFor: vi.fn(async () => []),
    limitsFor: vi.fn(async () => null),
    readPlan: vi.fn(async () => ({ entry: null, suggestion: null, refusal: null })),
    newSessionDefaultsFor: vi.fn(async () => []),
    setNewSessionDefault: vi.fn(async () => []),
  } as unknown as AppStore
  await act(async () => {
    root.render(
      <StoreProvider store={store}>
        <RuntimesSection onSignIn={() => {}} />
      </StoreProvider>,
    )
  })
}

/** The Default chip's state, wherever on the current screen it is. */
const chip = (): string => {
  const found = [...container.querySelectorAll('[data-state]')].find(
    (node) => node.textContent?.trim() === 'Default',
  )
  if (!found) throw new Error('no Default chip on screen')
  return found.getAttribute('data-state') ?? ''
}

it('names each runtime through one record title role', async () => {
  await mount({})
  const row = container.querySelector('[data-slot="agent-row"]')
  expect(row?.getAttribute('data-kind')).toBe('record')
  expect(row?.querySelector('[data-slot="runtime-name"]')?.textContent).toBe('Claude Code')
  expect(row?.querySelector('[data-role="subject"]')).toBeNull()
})

/** The button that opens the agent's own page: the one carrying its name. */
const agentName = (): Element | undefined =>
  [...container.querySelectorAll('button')].find((node) =>
    node.querySelector('[data-slot="runtime-name"]'),
  )

const click = async (node: Element | null | undefined, what: string): Promise<void> => {
  if (!node) throw new Error(`nothing to click: ${what}`)
  await act(async () => {
    node.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}


const back = async (): Promise<void> => {
  await click(
    [...container.querySelectorAll('button')].find((node) => node.textContent?.trim() === 'Runtimes'),
    'the back link',
  )
}

/** The chip as the list header draws it, and as the agent's own page draws it. */
const listAndAgentPage = async (): Promise<string[]> => {
  const header = [...container.querySelectorAll('[data-slot="chip"]')].find(node => node.textContent?.trim() === 'Default')
  expect(header?.getAttribute('data-tone')).toBe('neutral')
  expect(header?.closest('[data-slot="row-title"]')).not.toBeNull()
  await click(agentName(), 'the agent name')
  const agentPage = chip()
  await back()
  return [agentPage]
}

/** The same, plus the chip on the account's own page. */
const everySurface = async (): Promise<string[]> => {
  const [agentPage] = await listAndAgentPage()
  // The account is on the agent's own page, one line in.
  await click(agentName(), 'the agent name')
  await click(
    [...container.querySelectorAll('button')].find((node) =>
      node.textContent?.includes('olivia@acme.dev'),
    ),
    'the account row',
  )
  return [agentPage as string, chip()]
}

it('a default that is signed out says so on its own page, not only in the list', async () => {
  // No account page to check: an agent with no account has no account row.
  await mount({ accountsByRuntime: { [CLAUDE]: signedOut } } as unknown as Partial<AppSnapshot>)
  const states = await listAndAgentPage()
  expect(new Set(states).size).toBe(1)
  expect(states[0]).toBe('signin')
})

it('a default whose plan window is spent says so on all three surfaces', async () => {
  await mount({
    accountsByRuntime: { [CLAUDE]: signedIn },
    usage: [spent],
  } as unknown as Partial<AppSnapshot>)
  const states = await everySurface()
  expect(new Set(states).size).toBe(1)
  expect(states[0]).toBe('limit')
})

it('a default that cannot start is broken on all three, as it always was', async () => {
  await mount({
    accountsByRuntime: { [CLAUDE]: signedIn },
    healthByRuntime: { [CLAUDE]: { state: 'unavailable', reason: 'crashed', message: 'It exited.' } },
  } as unknown as Partial<AppSnapshot>)
  const states = await everySurface()
  expect(new Set(states).size).toBe(1)
  expect(states[0]).toBe('broken')
})

it('a healthy signed-in default is ready on all three', async () => {
  await mount({ accountsByRuntime: { [CLAUDE]: signedIn } } as unknown as Partial<AppSnapshot>)
  const states = await everySurface()
  expect(new Set(states).size).toBe(1)
  expect(states[0]).toBe('ready')
})

it('lists an agent as one line that opens its page, with nothing to fold', async () => {
  await mount({ accountsByRuntime: { [CLAUDE]: signedIn } } as unknown as Partial<AppSnapshot>)
  // The accounts are not a fold under the line any more: the line says who
  // it is signed in as, and its page holds the rest.
  expect(container.querySelector('button[aria-expanded]')).toBeNull()
  expect(agentName()?.textContent).toContain('olivia@acme.dev')
  await click(agentName(), 'the agent name')
  expect([...container.querySelectorAll('[data-slot="section-name"]')].map((node) => node.textContent)).toContain('Accounts')
})
