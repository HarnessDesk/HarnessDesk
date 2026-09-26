import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { runtimeId, NO_CAPABILITIES, type AccountStatus, type RuntimeInfo, type UsageReport } from '@harnessdesk/protocol'

import { StoreProvider } from '../state/context'
import { emptySnapshot, type AppSnapshot, type AppStore } from '../state/store'
import { RuntimesSection } from './SettingsAgents'

/**
 * The Plan section on an account's own page: "Plan price" (not set with a
 * suggestion, not set without one, and set — "you set this") and "Monthly
 * budget" (only on a key or metered-with-no-fee account).
 */

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

const CLAUDE = runtimeId('claude-code')

const info: RuntimeInfo = {
  id: CLAUDE,
  name: 'claude-code',
  presentation: { name: 'Claude Code' },
  capabilities: { ...NO_CAPABILITIES, account: true },
} as unknown as RuntimeInfo

const status: AccountStatus = {
  accounts: [{ kind: 'oauth', label: 'dev@example.com' }],
  signInMethods: [],
} as unknown as AccountStatus

const baseReport: UsageReport = {
  runtime: CLAUDE,
  account: 'dev@example.com',
  plan: 'Pro',
  lanes: [],
  credits: null,
  spend: null,
  reached: null,
  source: { kind: 'file', label: "from Claude Code's own cache" },
  fetchedAt: 0,
  staleAfterMs: 600_000,
  error: null,
}

const setPlan = vi.fn(async (input: unknown) => input)

const mount = async (
  report: UsageReport,
  readPlans: () => Promise<{ entries: []; suggestions: readonly unknown[] }>,
): Promise<AppStore> => {
  const snapshot: AppSnapshot = {
    ...emptySnapshot(),
    status: 'open',
    runtimes: [info],
    activeRuntime: CLAUDE,
    accountsByRuntime: { [CLAUDE]: status },
    healthByRuntime: { [CLAUDE]: { state: 'ready' } },
    usage: [report],
  } as unknown as AppSnapshot
  const store = {
    subscribe: () => () => {},
    getSnapshot: () => snapshot,
    loadAccounts: vi.fn(async () => {}),
    limitsFor: vi.fn(async () => null),
    readPlans: vi.fn(readPlans as never),
    setPlan,
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
  const accountLine = [...container.querySelectorAll('button')].find((node) =>
    node.textContent?.includes('dev@example.com'),
  )
  if (accountLine) await act(async () => accountLine.click())
  return store
}

const text = (): string => container.textContent ?? ''

describe('the Plan section', () => {
  it('not set, with a suggestion: offers it, dated and linked, in one click', async () => {
    await mount(baseReport, async () => ({
      entries: [],
      suggestions: [
        { runtime: CLAUDE, planMatch: 'Pro', amount: 20, currency: 'USD', period: 'month', sourceUrl: 'https://claude.com/pricing', checkedAt: '2026-09-26' },
      ],
    }))
    expect(text()).toContain('Use $20/mo')
    expect(text()).toContain('claude.com')
    expect(text()).toContain('2026-09-26')
    expect(text()).toContain('Other amount…')

    const use = [...container.querySelectorAll('button')].find((node) => node.textContent?.startsWith('Use $20/mo'))
    expect(use).toBeTruthy()
    await act(async () => use!.click())
    expect(setPlan).toHaveBeenCalledWith({
      runtime: CLAUDE,
      account: 'dev@example.com',
      fee: { amount: 20, currency: 'USD', period: 'month' },
    })
  })

  it('not set, with nothing to suggest: says so and offers to set one', async () => {
    await mount({ ...baseReport, plan: 'Max 20x' }, async () => ({ entries: [], suggestions: [] }))
    expect(text()).toContain('No suggested price for this plan')
    expect([...container.querySelectorAll('button')].some((node) => node.textContent === 'Set price…')).toBe(true)
  })

  it('set: shows the amount, "you set this", and Edit/Clear', async () => {
    const withFee: UsageReport = {
      ...baseReport,
      billing: { kinds: [], fee: { amount: 20, currency: 'USD', period: 'month', source: 'user' } },
    }
    await mount(withFee, async () => ({ entries: [], suggestions: [] }))
    expect(text()).toContain('$20 a month')
    expect(text()).toContain('you set this')
    expect([...container.querySelectorAll('button')].some((node) => node.textContent === 'Edit')).toBe(true)
    expect([...container.querySelectorAll('button')].some((node) => node.textContent === 'Clear')).toBe(true)
  })

  it('a vendor-sourced fee never says "you set this"', async () => {
    const vendorFee: UsageReport = {
      ...baseReport,
      billing: { kinds: ['windows'], fee: { amount: 200, currency: 'USD', period: 'month', source: 'vendor' } },
    }
    await mount(vendorFee, async () => ({ entries: [], suggestions: [] }))
    expect(text()).toContain('$200 a month')
    expect(text()).not.toContain('you set this')
  })

  it('a monthly budget is offered only on a metered account with no fee, never a plain window account', async () => {
    await mount(baseReport, async () => ({ entries: [], suggestions: [] }))
    expect(text()).not.toContain('Monthly budget')

    const metered: UsageReport = { ...baseReport, billing: { kinds: ['metered'] } }
    await act(async () => root.unmount())
    root = createRoot(container)
    await mount(metered, async () => ({ entries: [], suggestions: [] }))
    expect(text()).toContain('Monthly budget')
    expect(text()).toContain('Set budget…')
  })

  it('a set budget shows its amount and Edit/Clear', async () => {
    const metered: UsageReport = {
      ...baseReport,
      billing: { kinds: ['metered'], budget: { amount: 50, currency: 'USD', period: 'month' } },
    }
    await mount(metered, async () => ({ entries: [], suggestions: [] }))
    expect(text()).toContain('$50 a month')
  })
})
