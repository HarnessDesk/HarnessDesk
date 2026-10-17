import type { ComponentProps } from 'react'
import { installTopBarTestLayout } from '../test/top-bar-layout'
import { DestinationPageScope } from '../panels/destination-page'
import { TopBarProvider, TopBarOutlet } from '../panels/top-bar'
import { ShellHostsProvider, ShellOutlets } from '../panels/shell-hosts'
import { fixedSubject } from '../state/workbench'
import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { RuntimeInfo, RuntimeId, UsageLane, UsageReport } from '@harnessdesk/protocol'
import { NO_CAPABILITIES, runtimeId } from '@harnessdesk/protocol'

import { StoreProvider } from '../state/context'
import { emptySnapshot, type AppSnapshot, type AppStore } from '../state/store'
import { DashboardPage as UsageBody, type DashboardView } from './Usage'

const Usage = (props: ComponentProps<typeof UsageBody>) => <TopBarProvider><ShellHostsProvider><DestinationPageScope owner="destination:dashboard" active><UsageBody {...props} /></DestinationPageScope><TopBarOutlet owner="destination:dashboard" fallback={{place:'Dashboard',more:()=>null}} /></ShellHostsProvider></TopBarProvider>
installTopBarTestLayout()

/**
 * The Dashboard's rail-as-views restructure (the whole-page study's option B):
 * one rail row per view rather than per account, the account itself a choice
 * in the header that every view reads the same way.
 */

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const low: RuntimeInfo = {
  id: runtimeId('low-agent'),
  name: 'Low Agent',
  capabilities: { ...NO_CAPABILITIES, account: true, metered: true },
  presentation: { name: 'Low Agent' },
} as unknown as RuntimeInfo

const good: RuntimeInfo = {
  id: runtimeId('good-agent'),
  name: 'Good Agent',
  capabilities: { ...NO_CAPABILITIES, account: true, metered: true },
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
    workSubject: () => fixedSubject(snapshot.layout),
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
  vi.restoreAllMocks()
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
      onSignIn={() => {}}
    />
  )
}

const render = async (initial: DashboardView = 'overview', store = makeStore()): Promise<void> => {
  await act(async () =>
    root.render(
      <StoreProvider store={store}>
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

describe('the Dashboard first body row lists views', () => {
  it.each([
    [-3 * 3_600_000, 'From a cached read'],
    [60_000, 'Read 2m ago'],
  ])('qualifies a reading from %s ms after this desk opened', async (offset, expected) => {
    const startedAt = performance.timeOrigin
    vi.spyOn(Date, 'now').mockReturnValue(startedAt + 3 * 60_000)
    const store = makeStore()
    Object.assign(store.getSnapshot(), { usage: store.getSnapshot().usage.map(report => ({ ...report, fetchedAt: startedAt + offset })) })
    await render('overview', store)
    expect(document.body.textContent).toContain(expected)
    if (offset < 0) expect(document.body.textContent).not.toContain('Read 3h ago')
  })

  it.each([true, false])('includes a healthy account with limits (native metering: %s)', async metered => {
    const store = makeStore()
    Object.assign(store.getSnapshot(), { runtimes: [low, { ...good, capabilities: { ...good.capabilities, metered } }] })
    await render('overview', store)
    const region = host.querySelector('section[aria-label="What is left"]')!
    expect(region.textContent).toContain('Low Agent')
    expect(region.textContent).toContain('Good Agent')
    expect(region.querySelectorAll('article')).toHaveLength(2)
  })

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
    const badge = plans.querySelector('[data-slot="switcher-count"]')
    expect(badge?.textContent).toContain('1 low')
    const figure = badge?.querySelector('[data-tone="warning"]')
    expect(figure).not.toBeNull()
  })

  it('keeps the shared tabs in view order with one keyboard tab stop', async () => {
    await render('overview')
    const rows = ['Overview', 'Plans', 'Spend', 'Activity', 'Projects'].map(railButton)
    await act(async () => rows[0]!.focus())
    expect(document.activeElement).toBe(rows[0])
    expect(rows.map(row => row.tabIndex)).toEqual([0, -1, -1, -1, -1])

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

  it('takes the read note from the selected account rather than an older account outside its scope', async () => {
    const startedAt = performance.timeOrigin
    vi.spyOn(Date, 'now').mockReturnValue(startedAt + 3 * 60_000)
    const store = makeStore()
    Object.assign(store.getSnapshot(), { usage: store.getSnapshot().usage.map(report => ({ ...report,
      fetchedAt: report.runtime === low.id ? startedAt - 3_600_000 : startedAt + 60_000,
    })) })
    await render('overview', store)
    expect(document.body.textContent).toContain('From a cached read')
    await chooseAccount('Good Agent')
    expect(document.body.textContent).toContain('Read 2m ago')
    expect(document.body.textContent).not.toContain('From a cached read')
  })

  it('scopes whichever view is open, not only the one it was chosen from', async () => {
    await render('spend')
    expect(document.querySelector('[data-topbar-title]')).toBeNull()
    await chooseAccount('Low Agent')
    // The scope moves the control beside the title, the same thing clicking
    // that account in the old rail used to do — the title itself stays the
    // view's own name (review of #1057, NIT 3).
    expect(document.querySelector('[data-topbar-title]')).toBeNull()
    expect(scopeTrigger().textContent).toContain('Low Agent')
  })

  it('keeps the scope when the rail switches views', async () => {
    await render('overview')
    await chooseAccount('Low Agent')
    expect(scopeTrigger().textContent).toContain('Low Agent')
    await act(async () => railButton('Activity').click())
    expect(document.querySelector('[data-topbar-title]')).toBeNull()
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
    const select = document.querySelector<HTMLSelectElement>('select[aria-label="Show by"]')
    return select?.selectedOptions[0]?.textContent === label
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
    expect(isPressed('Last 12 months')).toBe(true)

    const byAgent = document.querySelector<HTMLSelectElement>('select[aria-label="Show by"]')!
    await act(async () => { byAgent.value = 'agent'; byAgent.dispatchEvent(new Event('change', {bubbles:true})) })
    expect(isPressed('By runtime')).toBe(true)

    const callsAfterToggle = ledgerMock.mock.calls.length
    await act(async () => railButton('Activity').click())
    expect(document.body.textContent).toContain('When it ran')
    // Still on "By agent" — the toggle is shared state, not reset by the switch.
    expect(isPressed('By runtime')).toBe(true)

    await act(async () => railButton('Overview').click())
    expect(isPressed('By runtime')).toBe(true)
    expect(ledgerMock.mock.calls.length).toBe(callsAfterToggle)
  })
})
