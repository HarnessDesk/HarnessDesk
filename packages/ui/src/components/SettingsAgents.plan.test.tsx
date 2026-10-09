import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { runtimeId, NO_CAPABILITIES, type AccountStatus, type PlanRead, type RuntimeInfo, type UsageReport } from '@harnessdesk/protocol'

import { StoreProvider } from '../state/context'
import { emptySnapshot, type AppSnapshot, type AppStore } from '../state/store'
import { RuntimesSection } from './SettingsAgents'

/**
 * The Plan section on an account's own page: "Plan price" (not set with a
 * suggestion, not set without one, and set — "you set this") and "Monthly
 * budget" (a key account, a metered one, or one that already has a budget
 * stored — BLOCKING 3's fix reads both rows from the account's own stored
 * entry, `usage/plan/read`, never from `report.billing`).
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

const mount = async (report: UsageReport, readPlan: () => Promise<PlanRead>): Promise<AppStore> => {
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
    transport: { request: vi.fn(async () => null) },
    subscribe: () => () => {},
    getSnapshot: () => snapshot,
    loadAccounts: vi.fn(async () => {}),
    limitsFor: vi.fn(async () => null),
    readPlan: vi.fn(readPlan as never),
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
      entry: null,
      suggestion: { runtime: CLAUDE, planMatch: 'Pro', amount: 20, currency: 'USD', period: 'month', sourceUrl: 'https://claude.com/pricing', checkedAt: '2026-09-26' },
      refusal: null,
    }))
    expect(text()).toContain('Use $20/mo')
    expect(text()).toContain('claude.com')
    expect(text()).toContain('2026-09-26')
    expect(text()).toContain('Other amount…')
    // The button reads amount/period only (BLOCKING 4) — the plan match and
    // source used to ride on the button label itself, which is what ran the
    // button off the card.
    const use = [...container.querySelectorAll('button')].find((node) => node.textContent?.startsWith('Use $20/mo'))
    expect(use?.textContent).toBe('Use $20/mo')

    await act(async () => use!.click())
    expect(setPlan).toHaveBeenCalledWith({
      runtime: CLAUDE,
      account: 'dev@example.com',
      fee: { amount: 20, currency: 'USD', period: 'month' },
    })
  })

  it('not set, with nothing to suggest: says so and offers to set one', async () => {
    await mount({ ...baseReport, plan: 'Max 20x' }, async () => ({ entry: null, suggestion: null, refusal: null }))
    // Rule 9: shortened — the second half only repeated the button beside it.
    expect(text()).toContain('No suggested price for this plan.')
    expect(text()).not.toContain('enter one yourself')
    expect([...container.querySelectorAll('button')].some((node) => node.textContent === 'Set price…')).toBe(true)
  })

  it('set: shows the amount, "you set this", and Edit/Clear', async () => {
    await mount(baseReport, async () => ({
      entry: { fee: { amount: 20, currency: 'USD', period: 'month', source: 'user', setAt: 1 } },
      suggestion: null,
      refusal: null,
    }))
    expect(text()).toContain('$20 a month')
    expect(text()).toContain('you set this')
    expect([...container.querySelectorAll('button')].some((node) => node.textContent === 'Edit')).toBe(true)
    expect([...container.querySelectorAll('button')].some((node) => node.textContent === 'Clear')).toBe(true)
  })

  it('a plans.json refusal shows as a Note instead of going blank (BLOCKING 2)', async () => {
    await mount(baseReport, async () => ({
      entry: null,
      suggestion: null,
      refusal: '~/.harnessdesk/plans.json was not read: it is not JSON',
    }))
    expect(text()).toContain('was not read')
    expect(text()).toContain('it is not JSON')
  })

  it('a monthly budget is offered on a metered account, a key account, or one that already has a budget stored', async () => {
    await mount(baseReport, async () => ({ entry: null, suggestion: null, refusal: null }))
    expect(text()).not.toContain('Monthly budget')

    const metered: UsageReport = { ...baseReport, billing: { kinds: ['metered'] } }
    await act(async () => root.unmount())
    root = createRoot(container)
    await mount(metered, async () => ({ entry: null, suggestion: null, refusal: null }))
    expect(text()).toContain('Monthly budget')
    expect(text()).toContain('Set budget…')
  })

  it('a metered account with a fee already set still offers its budget row (NIT: a stored budget must stay reachable)', async () => {
    const metered: UsageReport = { ...baseReport, billing: { kinds: ['metered'] } }
    await mount(metered, async () => ({
      entry: { fee: { amount: 20, currency: 'USD', period: 'month', source: 'user', setAt: 1 } },
      suggestion: null,
      refusal: null,
    }))
    expect(text()).toContain('Monthly budget')
  })

  it('a set budget shows its amount and Edit/Clear', async () => {
    const metered: UsageReport = { ...baseReport, billing: { kinds: ['metered'] } }
    await mount(metered, async () => ({
      entry: { budget: { amount: 50, currency: 'USD', period: 'month', setAt: 1 } },
      suggestion: null,
      refusal: null,
    }))
    expect(text()).toContain('$50 a month')
  })
})

describe('two accounts on one runtime', () => {
  const OTHER = { kind: 'oauth', label: 'other@example.com' }

  it('each shows its own fee and budget, never the sibling\'s (BLOCKING 3)', async () => {
    const reportA: UsageReport = { ...baseReport, account: 'dev@example.com', plan: 'Pro' }
    const reportB: UsageReport = { ...baseReport, account: 'other@example.com', plan: 'Pro', billing: { kinds: ['metered'] } }
    const entries: Record<string, PlanRead> = {
      'dev@example.com': { entry: { fee: { amount: 20, currency: 'USD', period: 'month', source: 'user', setAt: 1 } }, suggestion: null, refusal: null },
      'other@example.com': { entry: { budget: { amount: 75, currency: 'USD', period: 'month', setAt: 1 } }, suggestion: null, refusal: null },
    }
    const readPlan = vi.fn(async (params: { account: string }) => entries[params.account] ?? { entry: null, suggestion: null, refusal: null })

    const snapshot: AppSnapshot = {
      ...emptySnapshot(),
      status: 'open',
      runtimes: [info],
      activeRuntime: CLAUDE,
      accountsByRuntime: { [CLAUDE]: { accounts: [{ kind: 'oauth', label: 'dev@example.com' }, OTHER], signInMethods: [] } as unknown as AccountStatus },
      healthByRuntime: { [CLAUDE]: { state: 'ready' } },
      usage: [reportA, reportB],
    } as unknown as AppSnapshot
    const store = {
      transport: { request: vi.fn(async () => null) },
    subscribe: () => () => {},
      getSnapshot: () => snapshot,
      loadAccounts: vi.fn(async () => {}),
      limitsFor: vi.fn(async () => null),
      readPlan,
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

    const devLine = [...container.querySelectorAll('button')].find((node) => node.textContent?.includes('dev@example.com'))
    await act(async () => devLine!.click())
    expect(text()).toContain('$20 a month')
    expect(text()).not.toContain('$75 a month')
    expect(readPlan).toHaveBeenCalledWith(expect.objectContaining({ account: 'dev@example.com' }))

    await act(async () => root.unmount())
    root = createRoot(container)
    await act(async () => {
      root.render(
        <StoreProvider store={store}>
          <RuntimesSection onSignIn={() => {}} />
        </StoreProvider>,
      )
    })
    const agentLine2 = container.querySelector('[data-slot="agent-row"]')
    if (agentLine2) await act(async () => (agentLine2 as HTMLButtonElement).click())
    const otherLine = [...container.querySelectorAll('button')].find((node) => node.textContent?.includes('other@example.com'))
    await act(async () => otherLine!.click())
    expect(text()).toContain('$75 a month')
    expect(text()).not.toContain('$20 a month')
    expect(readPlan).toHaveBeenCalledWith(expect.objectContaining({ account: 'other@example.com' }))
  })
})
