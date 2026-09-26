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
