;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { NO_CAPABILITIES, runtimeId, type RuntimeId, type RuntimeInfo, type UsageBilling, type UsageLane, type UsageReport } from '@harnessdesk/protocol'

import { entriesFromReports, entriesFromSilent, NotReportingList } from './NotReporting'
import { PlansTable, ShapeFilters } from './PlansTable'
import { planRows, primaryShapeOf, shapeCountsOf } from '../../lib/plans-table'

const NOW = new Date('2026-09-26T12:00:00').getTime()
const DAY = 86_400_000

const info = (id: string, name: string): RuntimeInfo =>
  ({
    id: runtimeId(id),
    name,
    capabilities: { ...NO_CAPABILITIES },
    presentation: { name },
  }) as unknown as RuntimeInfo

const lane = (over: Partial<UsageLane> & Pick<UsageLane, 'id' | 'usedPercent'>): UsageLane => ({
  label: over.label ?? over.id,
  windowMinutes: 10_080,
  resetsAt: NOW + 2 * DAY,
  ...over,
})

const billing = (kinds: UsageBilling['kinds'], over: Partial<UsageBilling> = {}): UsageBilling => ({ kinds, ...over })

const report = (over: Partial<UsageReport>): UsageReport => ({
  runtime: runtimeId('a'),
  account: null,
  plan: null,
  lanes: [],
  credits: null,
  spend: null,
  reached: null,
  source: { kind: 'runtime', label: 'from its own API' },
  fetchedAt: NOW,
  staleAfterMs: 5 * 60_000,
  error: null,
  ...over,
})

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

const mount = (element: React.ReactElement): void => {
  act(() => root.render(element))
}

const rowFor = (name: string): HTMLElement => {
  const found = [...document.querySelectorAll<HTMLElement>('button[aria-expanded]')].find((node) =>
    (node.getAttribute('aria-label') ?? node.textContent)?.includes(name),
  )
  expect(found).toBeDefined()
  return found as HTMLElement
}

describe('ShapeFilters', () => {
  it('shows one chip per shape, each with its own count, plus All', () => {
    const counts = shapeCountsOf(
      [
        report({ billing: billing(['windows']) }),
        report({ billing: billing(['windows']) }),
        report({ billing: billing(['allowance']) }),
        report({ billing: billing(['balance']) }),
      ].map(primaryShapeOf),
      2,
    )
    mount(<ShapeFilters counts={counts} value="all" onChange={() => {}} />)
    const text = host.textContent ?? ''
    expect(text).toContain('All · 6')
    expect(text).toContain('Windows · 2')
    expect(text).toContain('Allowances · 1')
    expect(text).toContain('Balances · 1')
    expect(text).not.toContain('Keys')
    expect(text).not.toContain('Free')
    expect(text).toContain('Not reporting · 2')
  })

  it('reports the picked filter on change', () => {
    const onChange = vi.fn()
    const counts = shapeCountsOf([report({ billing: billing(['windows']) })].map(primaryShapeOf))
    mount(<ShapeFilters counts={counts} value="all" onChange={onChange} />)
    const windows = [...document.querySelectorAll('button')].find((b) => b.textContent?.includes('Windows'))
    act(() => windows?.click())
    expect(onChange).toHaveBeenCalledWith('windows')
  })
})

/** `planRows` at a fixed clock, the same thing `PlansView` hands `PlansTable` now (review of #1069, B3). */
const rowsFor = (reports: readonly UsageReport[]): ReturnType<typeof planRows> => planRows(reports, NOW)

const byIdOf = (...infos: readonly RuntimeInfo[]): ReadonlyMap<RuntimeId, RuntimeInfo> =>
  new Map(infos.map((one) => [one.id, one]))

describe('PlansTable', () => {
  it('draws account activity only on its expanded Plans row and omits null figures', () => {
    const windows = info('activity-agent', 'Activity Agent')
    const active = report({
      runtime: windows.id,
      account: 'activity@example.com',
      billing: billing(['windows']),
      accountActivity: {
        days: [{ day: new Date(2026, 8, 26).getTime(), tokens: 1_234_567 }],
        lifetimeTokens: 1_234_567_890,
        peakDailyTokens: null,
        currentStreakDays: 9,
        longestStreakDays: null,
      },
    })
    const activeRow = rowsFor([active])[0]!
    mount(
      <PlansTable
        rows={[activeRow]}
        byId={byIdOf(windows)}
        now={NOW}
        filter="all"
        preferenceFor={() => ({})}
        onRefreshAccount={() => {}}
        onStopTracking={() => {}}
        onOpenPlanSettings={() => {}}
        initialExpanded={activeRow.key}
      />,
    )

    expect(host.textContent).toContain('All machines')
    expect(host.textContent).toContain('1.2M tokens · 30d')
    expect(host.textContent).toContain('9-day streak')
    expect(host.textContent).toContain('1.2B lifetime')
    expect(host.querySelector('[data-slot="sparkline"]')).toBeNull()

    act(() => root.unmount())
    root = createRoot(host)
    const withoutActivity = report({ runtime: windows.id, account: 'local@example.com', billing: billing(['windows']) })
    const localRow = rowsFor([withoutActivity])[0]!
    mount(
      <PlansTable
        rows={[localRow]}
        byId={byIdOf(windows)}
        now={NOW}
        filter="all"
        preferenceFor={() => ({})}
        onRefreshAccount={() => {}}
        onStopTracking={() => {}}
        onOpenPlanSettings={() => {}}
        initialExpanded={localRow.key}
      />,
    )
    expect(host.querySelector('[data-slot="account-activity"]')).toBeNull()

    act(() => root.unmount())
    root = createRoot(host)
    const partial = report({
      runtime: windows.id,
      account: 'partial@example.com',
      billing: billing(['windows']),
      accountActivity: {
        days: [{ day: new Date(2026, 8, 26).getTime(), tokens: 25 }],
        lifetimeTokens: null,
        peakDailyTokens: null,
        currentStreakDays: null,
        longestStreakDays: null,
      },
    })
    const partialRow = rowsFor([partial])[0]!
    mount(
      <PlansTable
        rows={[partialRow]}
        byId={byIdOf(windows)}
        now={NOW}
        filter="all"
        preferenceFor={() => ({})}
        onRefreshAccount={() => {}}
        onStopTracking={() => {}}
        onOpenPlanSettings={() => {}}
        initialExpanded={partialRow.key}
      />,
    )
    expect(host.textContent).toContain('25 tokens · 30d')
    expect(host.textContent).not.toContain('streak')
    expect(host.textContent).not.toContain('lifetime')
  })

  it('does not show an activity band for hidden summary fields alone', () => {
    const windows = info('activity-agent', 'Activity Agent')
    const mountActivity = (account: string, activity: NonNullable<UsageReport['accountActivity']>) => {
      const one = report({ runtime: windows.id, account, billing: billing(['windows']), accountActivity: activity })
      const row = rowsFor([one])[0]!
      mount(
        <PlansTable
          rows={[row]}
          byId={byIdOf(windows)}
          now={NOW}
          filter="all"
          preferenceFor={() => ({})}
          onRefreshAccount={() => {}}
          onStopTracking={() => {}}
          onOpenPlanSettings={() => {}}
          initialExpanded={row.key}
        />,
      )
    }
    const hiddenOnly = [
      {
        days: [], lifetimeTokens: null, peakDailyTokens: 10,
        currentStreakDays: null, longestStreakDays: null,
      },
      {
        days: [], lifetimeTokens: null, peakDailyTokens: null,
        currentStreakDays: null, longestStreakDays: 8,
      },
    ] as const

    hiddenOnly.forEach((activity, index) => {
      if (index > 0) {
        act(() => root.unmount())
        root = createRoot(host)
      }
      mountActivity(`hidden-${index}@example.com`, activity)
      expect(host.querySelector('[data-slot="account-activity"]')).toBeNull()
    })
  })

  it('expands a row on Enter and collapses it on Escape', () => {
    const codex = info('codex', 'OpenAI Codex')
    const reports = [report({ runtime: codex.id, account: 'me@example.com', lanes: [lane({ id: 'weekly', usedPercent: 40 })], billing: billing(['windows']) })]
    mount(
      <PlansTable
        rows={rowsFor(reports)}
        byId={byIdOf(codex)}
        now={NOW}
        filter="all"
        preferenceFor={() => ({})}
        onRefreshAccount={() => {}}
        onStopTracking={() => {}}
        onOpenPlanSettings={() => {}}
      />,
    )
    const row = rowFor('me@example.com')
    expect(row.getAttribute('aria-expanded')).toBe('false')
    expect(document.querySelector('article[data-slot="card"]')).toBeNull()

    act(() => row.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })))
    expect(rowFor('me@example.com').getAttribute('aria-expanded')).toBe('true')
    expect(document.querySelector('article[data-slot="card"]')).not.toBeNull()

    act(() => rowFor('me@example.com').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })))
    expect(rowFor('me@example.com').getAttribute('aria-expanded')).toBe('false')
    expect(document.querySelector('article[data-slot="card"]')).toBeNull()
  })

  it('expands and collapses on click too, one row at a time', () => {
    const codex = info('codex', 'OpenAI Codex')
    const claude = info('claude', 'Claude Code')
    const reports = [
      report({ runtime: codex.id, account: 'a@example.com', lanes: [lane({ id: 'weekly', usedPercent: 10 })], billing: billing(['windows']) }),
      report({ runtime: claude.id, account: 'b@example.com', lanes: [lane({ id: 'weekly', usedPercent: 20 })], billing: billing(['windows']) }),
    ]
    mount(
      <PlansTable
        rows={rowsFor(reports)}
        byId={byIdOf(codex, claude)}
        now={NOW}
        filter="all"
        preferenceFor={() => ({})}
        onRefreshAccount={() => {}}
        onStopTracking={() => {}}
        onOpenPlanSettings={() => {}}
      />,
    )
    act(() => rowFor('a@example.com').click())
    expect(rowFor('a@example.com').getAttribute('aria-expanded')).toBe('true')
    expect(rowFor('b@example.com').getAttribute('aria-expanded')).toBe('false')

    // Opening the second closes the first — one open at a time.
    act(() => rowFor('b@example.com').click())
    expect(rowFor('a@example.com').getAttribute('aria-expanded')).toBe('false')
    expect(rowFor('b@example.com').getAttribute('aria-expanded')).toBe('true')
  })

  it('renders each shape\'s own body when expanded', () => {
    const windows = info('windows-agent', 'Windows Agent')
    const allowance = info('allowance-agent', 'Allowance Agent')
    const balance = info('balance-agent', 'Balance Agent')
    const key = info('key-agent', 'Key Agent')
    const free = info('free-agent', 'Free Agent')

    const reports = [
      report({ runtime: windows.id, account: 'w@example.com', billing: billing(['windows']), lanes: [lane({ id: 'weekly', label: 'Weekly', usedPercent: 40 })] }),
      report({
        runtime: allowance.id,
        account: 'al@example.com',
        billing: billing(['allowance']),
        lanes: [lane({ id: 'monthly', usedPercent: 62.4, unit: 'requests', used: 312, limit: 500 })],
        turns: { count: 40, unitsPerTurn: 3.2, since: NOW - 14 * DAY },
      }),
      report({
        runtime: balance.id,
        account: 'bal@example.com',
        billing: billing(['balance']),
        credits: { remaining: 0.88, unit: 'USD' },
        balanceHistory: {
          unit: 'USD',
          points: [
            { at: NOW - 3 * DAY, remaining: 1.1 },
            { at: NOW - DAY, remaining: 0.95 },
          ],
        },
      }),
      report({
        runtime: key.id,
        account: 'k@example.com',
        billing: billing(['metered'], { budget: { amount: 50, currency: 'USD', period: 'month' } }),
        spend: { currency: 'USD', todayCost: null, windowCost: 22.4, windowDays: 30, todayTokens: null, windowTokens: null, provenance: 'listPrice', coverage: null },
      }),
      report({
        runtime: free.id,
        account: 'f@example.com',
        billing: billing(['free']),
        spend: { currency: 'USD', todayCost: null, windowCost: null, windowDays: 30, todayTokens: null, windowTokens: 1_100_000, provenance: 'listPrice', coverage: null },
      }),
    ]
    mount(
      <PlansTable
        rows={rowsFor(reports)}
        byId={byIdOf(windows, allowance, balance, key, free)}
        now={NOW}
        filter="all"
        preferenceFor={() => ({})}
        onRefreshAccount={() => {}}
        onStopTracking={() => {}}
        onOpenPlanSettings={() => {}}
      />,
    )

    act(() => rowFor('w@example.com').click())
    expect(document.querySelector('article[data-slot="card"]')).not.toBeNull()
    act(() => rowFor('w@example.com').click()) // collapse before opening the next

    act(() => rowFor('al@example.com').click())
    expect(host.textContent ?? '').toContain('turns')
    act(() => rowFor('al@example.com').click())

    act(() => rowFor('bal@example.com').click())
    expect(host.textContent ?? '').toContain('$0.88')
    const balanceChart = document.querySelector<HTMLElement>('[data-slot="day-columns"] [role="group"][aria-label^="Balance per day"]')
    expect(balanceChart).not.toBeNull()
    expect(document.querySelector('svg path[stroke="var(--hd-accent)"]')).not.toBeNull()
    act(() => balanceChart?.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true, cancelable: true })))
    expect(host.textContent ?? '').toContain('$0.95')
    expect(document.querySelector('[data-slot="day-columns"] > div > div[aria-hidden="true"]')?.textContent ?? '').toContain('$')
    act(() => rowFor('bal@example.com').click())

    act(() => rowFor('k@example.com').click())
    expect(host.textContent ?? '').toContain('spent this month')
    expect(host.textContent ?? '').toContain('budget left')
    act(() => rowFor('k@example.com').click())

    act(() => rowFor('f@example.com').click())
    expect(host.textContent ?? '').toContain('Tokens this period')
    expect(host.textContent ?? '').toContain('1.1M tokens')
    // Free never shows a meter, whatever else is on the frame — scoped to the
    // Free body itself, since every other row's own table bar is still on
    // screen regardless of which row is expanded.
    const freeFrame = document.querySelector('[data-shape="free"]')
    expect(freeFrame).not.toBeNull()
    expect(freeFrame?.querySelector('[data-slot="segment-meter"]')).toBeNull()
    expect(freeFrame?.querySelector('[role="progressbar"]')).toBeNull()
  })

  it('shows the next-reading message when balance history has fewer than two points', () => {
    const balance = info('balance-agent', 'Balance Agent')
    const onlyPoint = report({
      runtime: balance.id,
      account: 'bal@example.com',
      billing: billing(['balance']),
      credits: { remaining: 0.88, unit: 'USD' },
      balanceHistory: { unit: 'USD', points: [{ at: NOW - DAY, remaining: 0.95 }] },
    })

    mount(
      <PlansTable
        rows={rowsFor([onlyPoint])}
        byId={byIdOf(balance)}
        now={NOW}
        filter="all"
        preferenceFor={() => ({})}
        onRefreshAccount={() => {}}
        onStopTracking={() => {}}
        onOpenPlanSettings={() => {}}
      />,
    )
    act(() => rowFor('bal@example.com').click())
    expect(host.textContent ?? '').toContain('Balance history starts with the next reading')
    expect(document.querySelector('[data-slot="day-columns"]')).toBeNull()
  })

  it('renders a signed chart for a Balance history that crosses zero', () => {
    const balance = info('balance-agent', 'Balance Agent')
    const crossing = report({
      runtime: balance.id,
      account: 'bal@example.com',
      billing: billing(['balance']),
      credits: { remaining: -1, unit: 'USD' },
      balanceHistory: {
        unit: 'USD',
        points: [
          { at: NOW - 2 * DAY, remaining: 2 },
          { at: NOW - DAY, remaining: -1 },
        ],
      },
    })
    mount(
      <PlansTable
        rows={rowsFor([crossing])}
        byId={byIdOf(balance)}
        now={NOW}
        filter="all"
        preferenceFor={() => ({})}
        onRefreshAccount={() => {}}
        onStopTracking={() => {}}
        onOpenPlanSettings={() => {}}
      />,
    )
    act(() => rowFor('bal@example.com').click())
    expect(document.querySelector('[data-zero-line]')).not.toBeNull()
    expect(document.querySelector('svg path[stroke="var(--hd-accent)"]')?.getAttribute('d')).toContain('0.00')
  })

  it('keeps $0 on the axis for a balance that never reached it, so money left never reads as out', () => {
    const balance = info('balance-agent', 'Balance Agent')
    const healthy = report({
      runtime: balance.id,
      account: 'bal@example.com',
      billing: billing(['balance']),
      credits: { remaining: 5, unit: 'USD' },
      balanceHistory: {
        unit: 'USD',
        points: [
          { at: NOW - 2 * DAY, remaining: 10 },
          { at: NOW - DAY, remaining: 5 },
        ],
      },
    })
    mount(
      <PlansTable
        rows={rowsFor([healthy])}
        byId={byIdOf(balance)}
        now={NOW}
        filter="all"
        preferenceFor={() => ({})}
        onRefreshAccount={() => {}}
        onStopTracking={() => {}}
        onOpenPlanSettings={() => {}}
      />,
    )
    act(() => rowFor('bal@example.com').click())
    const chart = document.querySelector('[data-slot="day-columns"]')
    // The axis reads top, middle, bottom: the bottom tick is $0, not the
    // lowest reading ($5.00), which would draw money left at the floor.
    expect(chart?.textContent).toMatch(/^\$10\.00\$5\.00\$0\$/)
    expect(document.querySelector('[data-zero-line]')).toBeNull()
  })

  // No limit is "never full, never empty" (docs/usage-dashboard.md) — Free, a
  // Key with no budget, and a shape-less "not reporting" row all leave
  // `leftOf`'s own percent null, and the table's Left cell must draw no
  // meter at all for any of them, not the hollow/dashed track `SegmentMeter`
  // itself draws for an unknown figure elsewhere.
  it('draws no meter in the Left cell for a row with nothing to measure against', () => {
    const free = info('free-agent', 'Free Agent')
    const keyNoBudget = info('key-agent', 'Key Agent')
    const reports = [
      report({ runtime: free.id, account: 'free@example.com', billing: billing(['free']) }),
      report({ runtime: keyNoBudget.id, account: 'nobudget@example.com', billing: billing(['metered']) }),
    ]
    mount(
      <PlansTable
        rows={rowsFor(reports)}
        byId={byIdOf(free, keyNoBudget)}
        now={NOW}
        filter="all"
        preferenceFor={() => ({})}
        onRefreshAccount={() => {}}
        onStopTracking={() => {}}
        onOpenPlanSettings={() => {}}
      />,
    )
    for (const account of ['free@example.com', 'nobudget@example.com']) {
      const cells = rowFor(account).closest('tr')?.querySelectorAll('td') ?? []
      const leftCell = cells[2]
      expect(leftCell?.querySelector('[data-slot="segment-meter"]')).toBeNull()
      expect(leftCell?.textContent).toBe('No limit')
    }
  })

  // A spent balance is a real zero, not "nothing to report" — its track
  // still draws, in the danger tone, unlike Free/Key-no-budget above.
  it('shows the amount and Out status for a spent Balance row', () => {
    const balance = info('balance-agent', 'Balance Agent')
    const reports = [report({ runtime: balance.id, account: 'spent@example.com', billing: billing(['balance']), credits: { remaining: 0, unit: 'USD' } })]
    mount(
      <PlansTable
        rows={rowsFor(reports)}
        byId={byIdOf(balance)}
        now={NOW}
        filter="all"
        preferenceFor={() => ({})}
        onRefreshAccount={() => {}}
        onStopTracking={() => {}}
        onOpenPlanSettings={() => {}}
      />,
    )
    const cells = rowFor('spent@example.com').closest('tr')?.querySelectorAll('td') ?? []
    expect(cells[2]?.querySelector('[role="progressbar"]')).toBeNull()
    expect(cells[2]?.textContent).toBe('$0')
    expect(cells[1]?.textContent).toBe('Out')
    act(() => rowFor('spent@example.com').click())
    expect(host.querySelector('[data-shape="balance"]')?.textContent).toContain('Out — top up to continue.')
  })

  it('uses the same overage word and tone in the row and expanded frame', () => {
    const account = info('overage-agent', 'Overage Agent')
    const overage = report({
      runtime: account.id,
      account: 'overage@example.com',
      billing: billing(['allowance'], { overage: { enabled: true, spent: 4.5, currency: 'USD' } }),
      lanes: [lane({ id: 'monthly', usedPercent: 20 })],
    })
    mount(
      <PlansTable
        rows={rowsFor([overage])}
        byId={byIdOf(account)}
        now={NOW}
        filter="all"
        preferenceFor={() => ({})}
        onRefreshAccount={() => {}}
        onStopTracking={() => {}}
        onOpenPlanSettings={() => {}}
      />,
    )

    const disclosure = rowFor('overage@example.com')
    const rowChip = disclosure.closest('tr')?.querySelector<HTMLElement>('[data-slot="chip"]')
    expect(rowChip?.textContent).toBe('On overage')
    expect(rowChip?.dataset['tone']).toBe('warning')

    act(() => disclosure.click())
    const frame = host.querySelector('[data-shape="allowance"]')
    const frameChip = [...(frame?.querySelectorAll<HTMLElement>('[data-slot="chip"]') ?? [])]
      .find((chip) => chip.textContent === 'On overage')
    expect(frameChip?.dataset['tone']).toBe('warning')
  })

  // A not-reporting row (`primaryShapeOf` is `'none'`) reads its own status —
  // never Free/Key's "No limit," which means "no limit by design" rather
  // than "nothing came back" — and every other cell it cannot fill reads
  // "—", agreeing with the shape filter's own "Not reporting" count.
  it('reads "Not reporting," never "No limit," for a shape-less row', () => {
    const silent = info('silent-agent', 'Silent Agent')
    const reports = [report({ runtime: silent.id, account: 'nothing@example.com' })]
    mount(
      <PlansTable
        rows={rowsFor(reports)}
        byId={byIdOf(silent)}
        now={NOW}
        filter="all"
        preferenceFor={() => ({})}
        onRefreshAccount={() => {}}
        onStopTracking={() => {}}
        onOpenPlanSettings={() => {}}
      />,
    )
    const cells = rowFor('nothing@example.com').closest('tr')?.querySelectorAll('td') ?? []
    const [, statusCell, leftCell, resetsCell] = cells
    expect(statusCell?.textContent).toBe('Not reporting')
    expect(leftCell?.textContent).toBe('—')
    expect(resetsCell?.textContent).toBe('—')

    const counts = shapeCountsOf(rowsFor(reports).map((row) => row.shape))
    expect(counts.none).toBe(1)
  })

  it('builds real table semantics — column headers, and a row whose trailing cell holds the disclosure', () => {
    const codex = info('codex', 'OpenAI Codex')
    const reports = [report({ runtime: codex.id, account: 'me@example.com', lanes: [lane({ id: 'weekly', usedPercent: 40 })], billing: billing(['windows']) })]
    mount(
      <PlansTable
        rows={rowsFor(reports)}
        byId={byIdOf(codex)}
        now={NOW}
        filter="all"
        preferenceFor={() => ({})}
        onRefreshAccount={() => {}}
        onStopTracking={() => {}}
        onOpenPlanSettings={() => {}}
      />,
    )
    expect(host.querySelector('table')).not.toBeNull()
    const headers = [...host.querySelectorAll('th')].map((node) => node.textContent)
    expect(headers).toEqual(['Account', 'Status', 'Left', 'Resets', 'Details'])
    const row = rowFor('me@example.com')
    expect(row.closest('td')?.parentElement?.tagName).toBe('TR')
    expect(row.getAttribute('aria-controls')).toBeTruthy()
    // The table owns the full-width row rule; its embedded disclosure has no edge.
    expect(row.classList.contains('border-b')).toBe(false)
    expect(row.classList.contains('rounded-none')).toBe(false)
  })

  // Escape inside the expanded body — its own Refresh button, say — collapses
  // the row rather than reaching the window's own Escape handler
  // (review of #1069, N3).
  it('collapses on Escape from inside the expanded body, and returns focus to the row', () => {
    const codex = info('codex', 'OpenAI Codex')
    const reports = [report({ runtime: codex.id, account: 'me@example.com', lanes: [lane({ id: 'weekly', usedPercent: 40 })], billing: billing(['windows']) })]
    mount(
      <PlansTable
        rows={rowsFor(reports)}
        byId={byIdOf(codex)}
        now={NOW}
        filter="all"
        preferenceFor={() => ({})}
        onRefreshAccount={() => {}}
        onStopTracking={() => {}}
        onOpenPlanSettings={() => {}}
      />,
    )
    act(() => rowFor('me@example.com').click())
    expect(rowFor('me@example.com').getAttribute('aria-expanded')).toBe('true')
    const bodyId = rowFor('me@example.com').getAttribute('aria-controls')
    const body = document.getElementById(bodyId ?? '')
    expect(body).not.toBeNull()
    const insideButton = body?.querySelector('button')
    expect(insideButton).toBeTruthy()
    const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
    act(() => insideButton?.dispatchEvent(event))
    expect(event.defaultPrevented).toBe(true)
    expect(rowFor('me@example.com').getAttribute('aria-expanded')).toBe('false')
    expect(document.activeElement).toBe(rowFor('me@example.com'))
  })

  it('threads onOpenPlanSettings through the Key body\'s footer', () => {
    const key = info('key-agent', 'Key Agent')
    const onOpenPlanSettings = vi.fn()
    const reports = [report({ runtime: key.id, account: 'k@example.com', billing: billing(['metered']) })]
    mount(
      <PlansTable
        rows={rowsFor(reports)}
        byId={byIdOf(key)}
        now={NOW}
        filter="all"
        preferenceFor={() => ({})}
        onRefreshAccount={() => {}}
        onStopTracking={() => {}}
        onOpenPlanSettings={onOpenPlanSettings}
      />,
    )
    act(() => rowFor('k@example.com').click())
    const setBudget = [...document.querySelectorAll('button')].find((b) => b.textContent === 'Set a budget')
    expect(setBudget).toBeDefined()
    act(() => setBudget?.click())
    expect(onOpenPlanSettings).toHaveBeenCalledWith(key.id)
  })

  it('shows an empty state when the filter matches nothing', () => {
    const reports: UsageReport[] = []
    mount(
      <PlansTable
        rows={rowsFor(reports)}
        byId={byIdOf()}
        now={NOW}
        filter="metered"
        preferenceFor={() => ({})}
        onRefreshAccount={() => {}}
        onStopTracking={() => {}}
        onOpenPlanSettings={() => {}}
      />,
    )
    expect(host.textContent ?? '').toContain('No account matches this filter')
  })

  it('shows the not-reporting body for a row with no shape at all', () => {
    const silent = info('silent-agent', 'Silent Agent')
    const reports = [report({ runtime: silent.id, account: 'nothing@example.com' })]
    mount(
      <PlansTable
        rows={rowsFor(reports)}
        byId={byIdOf(silent)}
        now={NOW}
        filter="all"
        preferenceFor={() => ({})}
        onRefreshAccount={() => {}}
        onStopTracking={() => {}}
        onOpenPlanSettings={() => {}}
      />,
    )
    act(() => rowFor('nothing@example.com').click())
    expect(host.textContent ?? '').toContain('This agent reports no plan usage here.')
  })
})

describe('NotReportingList', () => {
  it('renders nothing with no entries', () => {
    mount(<NotReportingList entries={[]} />)
    expect(host.textContent ?? '').toBe('')
  })

  it('gives a silent agent its reason and a sign-in fix', () => {
    const codex = info('codex', 'OpenAI Codex')
    const onSignIn = vi.fn()
    const entries = entriesFromSilent([{ info: codex, reason: 'It reports its plan once an account is connected.' }], onSignIn)
    mount(<NotReportingList entries={entries} />)
    expect(host.textContent ?? '').toContain('It reports its plan once an account is connected.')
    const button = [...document.querySelectorAll('button')].find((b) => b.textContent?.includes('Sign in to OpenAI Codex'))
    expect(button).toBeDefined()
    act(() => button?.click())
    expect(onSignIn).toHaveBeenCalledWith(codex.id)
  })

  it('gives a shape-less report its reason and a refresh fix', () => {
    const codex = info('codex', 'OpenAI Codex')
    const onRefresh = vi.fn()
    const entries = entriesFromReports([report({ runtime: codex.id, account: 'x@example.com' })], byIdOf(codex), onRefresh)
    mount(<NotReportingList entries={entries} />)
    expect(host.textContent ?? '').toContain('This agent reports no plan usage here.')
    const button = [...document.querySelectorAll('button')].find((b) => b.textContent === 'Refresh')
    expect(button).toBeDefined()
    act(() => button?.click())
    expect(onRefresh).toHaveBeenCalledWith(codex.id)
  })

  it('draws no control when there is nothing to do', () => {
    const codex = info('codex', 'OpenAI Codex')
    const entries = entriesFromSilent([{ info: codex, reason: 'It reports its plan once an account is connected.' }])
    mount(<NotReportingList entries={entries} />)
    expect(host.querySelector('[data-slot="row-ctl"]')).toBeNull()
    expect([...document.querySelectorAll('button')].some((b) => b.textContent?.includes('Sign in'))).toBe(false)
  })
})

it('combines each shape into one Left cell and moves disclosure to the trailing cell', () => {
 const reports = [
  report({ account:'window@example.com', billing:billing(['windows']), lanes:[lane({id:'Weekly',usedPercent:21})] }),
  report({ account:'balance@example.com', billing:billing(['balance']), credits:{remaining:14,unit:'USD'}, turns:{unitsPerTurn:0.1,count:10,since:NOW-DAY} }),
  report({ account:'free@example.com', billing:billing(['free']) }),
 ]
 mount(<PlansTable rows={rowsFor(reports)} byId={byIdOf(info('a','Alpha'))} now={NOW} filter="all" preferenceFor={()=>({})} onRefreshAccount={()=>{}} onStopTracking={()=>{}} onOpenPlanSettings={()=>{}} />)
 expect([...host.querySelectorAll('th')].map(n=>n.textContent)).toEqual(['Account','Status','Left','Resets','Details'])
 const cells=(name:string)=>rowFor(name).closest('tr')!.querySelectorAll('td')
 expect(cells('window@example.com')[2]!.textContent).toBe('79%')
 expect(cells('window@example.com')[2]!.querySelector('[data-slot="progress"]')).not.toBeNull()
 expect(cells('balance@example.com')[2]!.textContent).toContain('$14')
 expect(cells('balance@example.com')[2]!.textContent).toContain('≈ 140 turns')
 expect(cells('balance@example.com')[2]!.querySelector('[role="progressbar"]')).toBeNull()
 expect(cells('free@example.com')[2]!.textContent).toBe('No limit')
 expect(cells('window@example.com')[0]!.querySelector('button')).toBeNull()
 expect(rowFor('window@example.com').closest('td')).toBe(cells('window@example.com')[4])
})

it('keeps a plain account row and does not repeat the runtime when it is the title', () => {
 const agent = info('alpha', 'Alpha')
 mount(<PlansTable rows={rowsFor([report({ runtime: agent.id, billing: billing(['free']) })])} byId={byIdOf(agent)} now={NOW} filter="all" preferenceFor={() => ({})} onRefreshAccount={() => {}} onStopTracking={() => {}} onOpenPlanSettings={() => {}} />)
 const row = host.querySelector('tbody tr')!
 expect(row.hasAttribute('data-interactive')).toBe(false)
 const texts = row.querySelectorAll('td:first-child [data-slot="text"]')
 expect(texts[0]?.textContent).toBe('Alpha')
 expect(texts[1]?.textContent).toBe('free tier')
})
