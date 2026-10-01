import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { RuntimeInfo, RuntimeId, UsageLane, UsageReport } from '@harnessdesk/protocol'
import { NO_CAPABILITIES, runtimeId } from '@harnessdesk/protocol'

import { StoreProvider } from '../state/context'
import { emptySnapshot, type AppSnapshot, type AppStore } from '../state/store'
import { Usage, type DashboardView } from './Usage'

/**
 * The Dashboard's rail-as-views restructure (the whole-page study's option B):
 * one rail row per view rather than per account, the account itself a choice
 * in the header that every view reads the same way.
 */

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const low: RuntimeInfo = {
  id: runtimeId('low-agent'),
  name: 'Low Agent',
  capabilities: { ...NO_CAPABILITIES, account: true },
  presentation: { name: 'Low Agent' },
} as unknown as RuntimeInfo

const good: RuntimeInfo = {
  id: runtimeId('good-agent'),
  name: 'Good Agent',
  capabilities: { ...NO_CAPABILITIES, account: true },
  presentation: { name: 'Good Agent' },
} as unknown as RuntimeInfo

const lane = (usedPercent: number): UsageLane => ({
  id: 'weekly',
  label: 'Weekly',
  scope: null,
  usedPercent,
  windowMinutes: 7 * 24 * 60,
  resetsAt: Date.now() + 86_400_000,
  usageKnown: true,
})

const reportFor = (info: RuntimeInfo, usedPercent: number): UsageReport => ({
  runtime: info.id,
  account: null,
  plan: null,
  lanes: [lane(usedPercent)],
  credits: null,
  spend: null,
  reached: null,
  source: { kind: 'api', label: 'from a fake source' },
  fetchedAt: Date.now(),
  staleAfterMs: 5 * 60_000,
  error: null,
})

const makeStore = (): AppStore => {
  const snapshot = {
    ...emptySnapshot(),
    status: 'open',
    runtimes: [low, good],
    activeRuntime: low.id,
    usage: [reportFor(low, 90), reportFor(good, 10)],
  } as AppSnapshot
  return {
    subscribe: () => () => {},
    getSnapshot: () => snapshot,
    transport: { request: vi.fn(async () => null) },
    loadAccounts: vi.fn(async () => {}),
    loadUsage: vi.fn(async () => {}),
    refreshUsage: vi.fn(async () => {}),
    ledger: vi.fn(async () => null),
    setUsageTracked: vi.fn(),
    setSpendChartMode: vi.fn(),
    scanUsage: vi.fn(),
    openGoal: vi.fn(),
    readUsageInsight: vi.fn(async () => null),
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

/** A harness that owns `view`/`scope` the way `App.tsx` does — `Usage` itself is fully controlled. */
const Harness = ({ initial = 'overview' as DashboardView }: { initial?: DashboardView }) => {
  const [view, setView] = useState<DashboardView>(initial)
  const [scope, setScope] = useState<RuntimeId | null>(null)
  return (
    <Usage
      view={view}
      scope={scope}
      onView={setView}
      onScope={setScope}
      onClose={() => {}}
      onSignIn={() => {}}
    />
  )
}

const render = async (initial: DashboardView = 'overview'): Promise<void> => {
  await act(async () =>
    root.render(
      <StoreProvider store={makeStore()}>
        <Harness initial={initial} />
      </StoreProvider>,
    ),
  )
}

const railButton = (label: string): HTMLButtonElement => {
  const button = [...document.querySelectorAll('button')].find((node) => node.textContent?.includes(label))
  expect(button, `no rail row for "${label}"`).toBeDefined()
  return button!
}

describe('the Dashboard rail lists views', () => {
  it('switches the page shown when a different row is clicked', async () => {
    await render('overview')
    expect(document.body.textContent).toContain('What is left')
    await act(async () => railButton('Activity').click())
    expect(document.body.textContent).toContain('When it ran')
    expect(document.body.textContent).not.toContain('What is left')
  })

  it('shows "N low" on Plans, in the warn tone, when an account is spent or low', async () => {
    await render('overview')
    const plans = railButton('Plans')
    const badge = plans.closest('[data-slot="sidebar-menu-item"]')?.querySelector('[data-slot="sidebar-menu-badge"]')
    expect(badge?.textContent).toContain('1 low')
    const figure = badge?.querySelector('[data-tone="warning"]')
    expect(figure).not.toBeNull()
  })

  it('moves focus row to row with Tab, in the order drawn', async () => {
    await render('overview')
    const rows = ['Overview', 'Plans', 'Spend', 'Activity', 'Projects'].map(railButton)
    rows[0]!.focus()
    expect(document.activeElement).toBe(rows[0])
    // A row is a plain button — Tab moves through them in document order,
    // the same as any other list of buttons, Settings' rail included.
    for (let index = 1; index < rows.length; index += 1) {
      expect(rows[index]!.tabIndex).not.toBe(-1)
    }
  })
})

describe('the header’s account scope', () => {
  const openScopeMenu = async (): Promise<void> => {
    const trigger = document.querySelector<HTMLButtonElement>('[title="Scope the dashboard to one account"]')!
    await act(async () => trigger.click())
  }

  const chooseAccount = async (name: string): Promise<void> => {
    await openScopeMenu()
    const row = [...document.querySelectorAll('[role="menuitemradio"]')].find((node) =>
      node.textContent?.includes(name),
    )
    expect(row, `no scope row for "${name}"`).toBeDefined()
    await act(async () => (row as HTMLElement).click())
  }

  const scopeTrigger = (): HTMLButtonElement =>
    document.querySelector<HTMLButtonElement>('[title="Scope the dashboard to one account"]')!

  it('scopes whichever view is open, not only the one it was chosen from', async () => {
    await render('spend')
    expect(document.querySelector('h1')?.textContent).toBe('Spend')
    await chooseAccount('Low Agent')
    // The scope moves the control beside the title, the same thing clicking
    // that account in the old rail used to do — the title itself stays the
    // view's own name (review of #1057, NIT 3).
    expect(document.querySelector('h1')?.textContent).toBe('Spend')
    expect(scopeTrigger().textContent).toContain('Low Agent')
  })

  it('keeps the scope when the rail switches views', async () => {
    await render('overview')
    await chooseAccount('Low Agent')
    expect(scopeTrigger().textContent).toContain('Low Agent')
    await act(async () => railButton('Activity').click())
    expect(document.querySelector('h1')?.textContent).toBe('Activity')
    expect(scopeTrigger().textContent).toContain('Low Agent')
  })
})

/**
 * "When it ran" is one query and one pair of toggles, owned by `Usage.tsx`
 * and shared by Overview and Activity (review of #1057, item 4) — and,
 * on Overview, it reads the same scope as every other band (item 3).
 */
describe('the heatmap band', () => {
  const renderWithStore = async (initial: DashboardView = 'overview'): Promise<AppStore> => {
    const store = makeStore()
    await act(async () =>
      root.render(
        <StoreProvider store={store}>
          <Harness initial={initial} />
        </StoreProvider>,
      ),
    )
    return store
  }

  const isPressed = (label: string): boolean => {
    const button = [...document.querySelectorAll('button')].find((node) => node.textContent?.trim() === label)
    return button?.hasAttribute('data-pressed') ?? false
  }

  it('follows the scope on Overview, the way every other band does', async () => {
    const store = await renderWithStore('overview')
    const ledgerMock = store.ledger as unknown as ReturnType<typeof vi.fn>
    ledgerMock.mockClear()
    const trigger = document.querySelector<HTMLButtonElement>('[title="Scope the dashboard to one account"]')!
    await act(async () => trigger.click())
    const row = [...document.querySelectorAll('[role="menuitemradio"]')].find((node) => node.textContent?.includes('Low Agent'))
    expect(row, 'no scope row for "Low Agent"').toBeDefined()
    await act(async () => (row as HTMLElement).click())
    // The year query — `days: 365` — is the one "When it ran" makes; it has
    // to carry the newly-chosen runtime the way the money band's own query
    // already does.
    expect(
      ledgerMock.mock.calls.some((call: unknown[]) => {
        const query = call[0] as { days?: number; runtime?: RuntimeId }
        return query.days === 365 && query.runtime === low.id
      }),
    ).toBe(true)
  })

  it('makes no new ledger request when switching Overview → Activity → Overview, and keeps its toggles', async () => {
    const store = await renderWithStore('overview')
    const ledgerMock = store.ledger as unknown as ReturnType<typeof vi.fn>
    expect(isPressed('Year')).toBe(true)

    const byAgent = [...document.querySelectorAll('button')].find((node) => node.textContent?.trim() === 'By agent')
    expect(byAgent, 'no "By agent" toggle').toBeDefined()
    await act(async () => byAgent!.click())
    expect(isPressed('By agent')).toBe(true)

    const callsAfterToggle = ledgerMock.mock.calls.length
    await act(async () => railButton('Activity').click())
    expect(document.body.textContent).toContain('When it ran')
    // Still on "By agent" — the toggle is shared state, not reset by the switch.
    expect(isPressed('By agent')).toBe(true)

    await act(async () => railButton('Overview').click())
    expect(isPressed('By agent')).toBe(true)
    expect(ledgerMock.mock.calls.length).toBe(callsAfterToggle)
  })
})
