import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { runtimeId, type LedgerDay, type LedgerReport, type RuntimeId, type RuntimeInfo } from '@harnessdesk/protocol'

import { StoreProvider } from '../state/context'
import type { AppStore } from '../state/store'
import { UsageActivity } from './UsageActivity'

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
const CODEX = runtimeId('codex')

const NOW = new Date('2026-09-20T12:00:00').getTime()
const DAY = 86_400_000

/** A realistic-enough month: two agents, one of them heavier, none of it in the future. */
const ledgerReport = (): LedgerReport => {
  const daily: LedgerDay[] = []
  for (let back = 0; back < 60; back += 1) {
    const day = new Date(NOW)
    day.setHours(0, 0, 0, 0)
    day.setDate(day.getDate() - back)
    const dow = day.getDay()
    if (dow === 0 || dow === 6) continue // weekends quiet
    daily.push({ day: day.getTime(), runtime: CLAUDE, cost: 4 + (back % 5), tokens: 400_000 + back * 1000 })
    if (back % 3 === 0) daily.push({ day: day.getTime(), runtime: CODEX, cost: 1, tokens: 90_000 })
  }
  return {
    days: 365,
    currency: 'USD',
    totalCost: daily.reduce((sum, entry) => sum + entry.cost, 0),
    totalTokens: daily.reduce((sum, entry) => sum + entry.tokens, 0),
    provenance: 'listPrice',
    coverage: { priced: daily.length, unpriced: 0, unmetered: 0, estimated: 0, daysCovered: 60, daysRequested: 365 },
    rows: [],
    daily,
    scannedAt: NOW,
  }
}

const byId = new Map<RuntimeId, RuntimeInfo>([
  [CLAUDE, { id: CLAUDE, presentation: { name: 'Claude Code' } } as RuntimeInfo],
  [CODEX, { id: CODEX, presentation: { name: 'Codex' } } as RuntimeInfo],
])

const renderBand = async (ledger = vi.fn(async () => ledgerReport())): Promise<{ ledger: typeof ledger }> => {
  const store = { subscribe: () => () => {}, getSnapshot: () => ({}), ledger } as unknown as AppStore
  await act(async () => {
    root.render(
      <StoreProvider store={store}>
        <UsageActivity byId={byId} scope={null} now={NOW} />
      </StoreProvider>,
    )
    await Promise.resolve()
    await Promise.resolve()
  })
  return { ledger }
}

const findButton = (text: string): HTMLElement | undefined =>
  [...container.querySelectorAll('button')].find((button) => button.textContent?.trim() === text)

it('queries a full year, independent of the money band’s own range', async () => {
  const { ledger } = await renderBand()
  expect(ledger).toHaveBeenCalledWith(expect.objectContaining({ days: 365, groupBy: 'runtime' }))
})

it('refetches the ledger once a scan finishes (#990 item 7)', async () => {
  const ledger = vi.fn(async () => ledgerReport())
  const store = { subscribe: () => () => {}, getSnapshot: () => ({}), ledger } as unknown as AppStore
  await act(async () => {
    root.render(
      <StoreProvider store={store}>
        <UsageActivity byId={byId} scope={null} now={NOW} scanFinishedAt={1} />
      </StoreProvider>,
    )
    await Promise.resolve()
    await Promise.resolve()
  })
  expect(ledger).toHaveBeenCalledTimes(1)

  // A later scan's own finish time — the same prop `Usage.tsx` already
  // passes from `snapshot.scan?.finishedAt` — has to trigger a second
  // fetch, or the band keeps whatever it queried before the first scan
  // completed while every other band on the screen moves on.
  await act(async () => {
    root.render(
      <StoreProvider store={store}>
        <UsageActivity byId={byId} scope={null} now={NOW} scanFinishedAt={2} />
      </StoreProvider>,
    )
    await Promise.resolve()
    await Promise.resolve()
  })
  expect(ledger).toHaveBeenCalledTimes(2)
})

it('switches from the Year grid to one row per agent, and back', async () => {
  await renderBand()
  expect(container.textContent).toContain('When it ran')
  // The Year view's facts name the leading agent, but Codex never leads this
  // fixture — it only appears once the grid draws one row per agent.
  expect(container.textContent).not.toContain('Codex')

  const byAgent = findButton('By agent')
  await act(async () => void byAgent?.click())
  expect(container.textContent).toContain('Claude Code')
  expect(container.textContent).toContain('Codex')

  const year = findButton('Year')
  await act(async () => void year?.click())
  expect(container.textContent).not.toContain('Codex')
})

it('switches the measure from tokens to cost, changing what the facts read', async () => {
  await renderBand()
  const before = container.textContent ?? ''
  expect(before).toMatch(/M|K/) // a token figure, formatted short

  const cost = findButton('Cost')
  await act(async () => void cost?.click())
  const after = container.textContent ?? ''
  expect(after).toContain('$')
})

it("reads a scope no day can be priced for as \"unpriced\", never \"$0\" (#990 item 6)", async () => {
  const day = new Date(NOW)
  day.setHours(0, 0, 0, 0)
  const daily: LedgerDay[] = [{ day: day.getTime(), runtime: CLAUDE, cost: 0, tokens: 400_000 }]
  const unpricedLedger = (): LedgerReport => ({
    days: 365,
    currency: 'USD',
    totalCost: null as unknown as number,
    totalTokens: 400_000,
    provenance: 'listPrice',
    coverage: { priced: 0, unpriced: 1, unmetered: 0, estimated: 0, daysCovered: 1, daysRequested: 365 },
    rows: [],
    daily,
    scannedAt: NOW,
  })
  await renderBand(vi.fn(async () => unpricedLedger()))

  const cost = findButton('Cost')
  await act(async () => void cost?.click())
  // Scoped to the facts card's own total — the first `metric` figure on the
  // band — since a busiest-day tie in an all-not-scanned fixture like this
  // one is a pre-existing, unrelated edge case this test is not about.
  const total = container.querySelector('[data-role="metric"]')
  expect(total?.textContent).toBe('unpriced')
})

it("notes a partly-priced year without hiding it inside the total (#990 item 6)", async () => {
  const daily: LedgerDay[] = []
  for (let back = 0; back < 5; back += 1) {
    const day = new Date(NOW)
    day.setHours(0, 0, 0, 0)
    day.setDate(day.getDate() - back)
    daily.push({ day: day.getTime(), runtime: CLAUDE, cost: back === 0 ? 0 : 4, tokens: 400_000 })
  }
  const partlyUnpriced = (): LedgerReport => ({
    days: 365,
    currency: 'USD',
    totalCost: 16,
    totalTokens: daily.reduce((sum, entry) => sum + entry.tokens, 0),
    provenance: 'listPrice',
    coverage: { priced: 4, unpriced: 1, unmetered: 0, estimated: 0, daysCovered: 5, daysRequested: 365 },
    rows: [],
    daily,
    scannedAt: NOW,
  })
  await renderBand(vi.fn(async () => partlyUnpriced()))

  const cost = findButton('Cost')
  await act(async () => void cost?.click())
  expect(container.textContent).toContain('some unpriced')
})

it('shows a per-agent breakdown in the active cell’s tooltip', async () => {
  await renderBand()
  // Scoped to the grid itself: the foot's legend swatches wear the same
  // `data-level`/`data-state` attributes and would otherwise be picked up too.
  const gridEl = container.querySelector('[role="group"]') as HTMLElement
  // A cell with a non-zero level is guaranteed to carry a tooltip — level 0
  // covers both the quiet zero days and the ones with nothing to point at.
  const target = [...gridEl.querySelectorAll<HTMLElement>('[data-level]')].find(
    (element) => element.dataset['level'] !== '0',
  )
  if (!target) throw new Error('expected at least one non-empty cell in the fixture')
  await act(async () => {
    // React derives enter/leave from bubbling `pointerover`/`pointerout` —
    // `pointerenter` itself does not bubble, so a raw dispatch of it never
    // reaches the delegated listener.
    target.dispatchEvent(new PointerEvent('pointerover', { bubbles: true, pointerType: 'mouse' }))
  })
  const tip = container.querySelector('[data-slot="chart-tip"]')
  expect(tip).not.toBeNull()
  expect(tip?.textContent).toContain('Claude Code')
})


it('levels By agent rows off each agent\'s own cells, not the combined daily totals (#990 item 4)', async () => {
  // Claude spends roughly ten times what Codex does. Under the
  // combined-totals bug every one of Codex's active cells sits well inside
  // Claude's own first quartile and reads as level 1 no matter what Codex
  // itself did that day; levelled off its own cells instead, Codex's own
  // busiest day — a spike well above its usual — reads above the bottom of
  // the scale.
  const daily: LedgerDay[] = []
  for (let back = 0; back < 30; back += 1) {
    const day = new Date(NOW)
    day.setHours(0, 0, 0, 0)
    day.setDate(day.getDate() - back)
    daily.push({ day: day.getTime(), runtime: CLAUDE, cost: 100, tokens: 1_000_000 })
    // Codex's own busiest day (back === 15) spikes to roughly half of
    // Claude's typical day — still a fraction of Claude's total, but well
    // clear of Codex's own quiet baseline.
    const codexTokens = back === 15 ? 500_000 : 50_000
    daily.push({ day: day.getTime(), runtime: CODEX, cost: codexTokens / 10_000, tokens: codexTokens })
  }
  const ledgerReportSkewed = (): LedgerReport => ({
    days: 365,
    currency: 'USD',
    totalCost: daily.reduce((sum, entry) => sum + entry.cost, 0),
    totalTokens: daily.reduce((sum, entry) => sum + entry.tokens, 0),
    provenance: 'listPrice',
    coverage: { priced: daily.length, unpriced: 0, unmetered: 0, estimated: 0, daysCovered: 30, daysRequested: 365 },
    rows: [],
    daily,
    scannedAt: NOW,
  })
  await renderBand(vi.fn(async () => ledgerReportSkewed()))

  const byAgent = findButton('By agent')
  await act(async () => void byAgent?.click())

  // Rows are sorted most-total-first (Claude, then Codex) and drawn as one
  // Fragment per row, so the flat cell list — including the not-scanned
  // placeholders that carry no `data-level` — is Claude's 91 columns
  // followed by Codex's own 91, the same row-major order `HeatGrid`'s own
  // keyboard tests rely on.
  const gridEl = container.querySelector('[role="group"]') as HTMLElement
  const cells = [...gridEl.querySelectorAll<HTMLElement>('[data-level], [data-state]')]
  const AGENT_SPAN_DAYS = 91
  const codexCells = cells.slice(AGENT_SPAN_DAYS, AGENT_SPAN_DAYS * 2).filter((cell) => cell.hasAttribute('data-level'))
  const codexBusiest = codexCells.reduce((best, cell) =>
    Number(best.dataset['level']) >= Number(cell.dataset['level']) ? best : cell,
  )
  expect(codexCells.length).toBeGreaterThan(0)
  expect(codexBusiest.dataset['level']).not.toBe('1')
})
