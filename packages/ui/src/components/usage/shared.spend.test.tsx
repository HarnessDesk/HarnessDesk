import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, expect, it } from 'vitest'
import type { LedgerReport } from '@harnessdesk/protocol'

import { Spend } from './shared'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLDivElement
let root: ReturnType<typeof createRoot>
beforeEach(() => { host = document.createElement('div'); document.body.append(host); root = createRoot(host) })
afterEach(() => { act(() => root.unmount()); host.remove() })

const emptyLedger = (days: number): LedgerReport => ({
  days,
  currency: 'USD',
  totalCost: null,
  totalTokens: 0,
  provenance: 'unknown',
  coverage: { priced: 0, unpriced: 0, unmetered: 0, estimated: 0, daysCovered: 0, daysRequested: days, earliestDay: null, coveredDays: [] },
  rows: [],
  daily: [],
  scannedAt: null,
})

it('places the empty plot inside a chart card', () => {
  act(() => root.render(<Spend ledger={emptyLedger(30)} wideLedger={emptyLedger(60)} byId={new Map()} tintOf={() => 'blue'} scan={null} now={Date.parse('2026-10-10T12:00:00')} range={30} mode="bars" onModeChange={() => {}} onScan={() => {}} showFooter={false} />))
  const frame = host.querySelector<HTMLElement>('[data-slot="chart-frame"]')!
  const empty = frame.querySelector<HTMLElement>('[data-slot="empty-state"]')!
  const cards = frame.querySelectorAll<HTMLElement>(':scope > [data-slot="chart-card"]')
  expect(cards).toHaveLength(2)
  expect(cards[1]?.contains(empty)).toBe(true)
})

it('does not show zero spend for shorter periods containing unscanned days', () => {
  act(() => root.render(<Spend ledger={emptyLedger(30)} wideLedger={emptyLedger(60)} byId={new Map()} tintOf={() => 'blue'} scan={null} now={Date.parse('2026-10-10T12:00:00')} range={30} mode="bars" onModeChange={() => {}} onScan={() => {}} />))
  const stats = [...host.querySelectorAll('[data-slot="stat"]')]
  expect(stats.find(stat => stat.textContent?.includes('Today'))?.textContent).toContain('Not read yet')
  expect(stats.find(stat => stat.textContent?.includes('Last 7 days'))?.textContent).toContain('Not read yet')
  expect(host.querySelector('[data-slot="chart-title"]')?.textContent).toBe('—')
  expect(host.textContent?.match(/0 of 30 days scanned/g)).toHaveLength(1)
  expect(host.textContent).toContain('No usage recorded in this window')
  expect(host.textContent).not.toContain('unpriced')
})

it('states complete scan coverage once even when the recorded window is empty', () => {
  const now = Date.parse('2026-10-10T12:00:00')
  const ledger = { ...emptyLedger(30), totalCost: 0, coverage: { ...emptyLedger(30).coverage, daysCovered: 30,
    coveredDays: Array.from({ length: 30 }, (_, back) => new Date(2026, 9, 10 - back).getTime()) } }
  act(() => root.render(<Spend ledger={ledger} wideLedger={null} byId={new Map()} tintOf={() => 'blue'} scan={null} now={now} range={30} mode="bars" onModeChange={() => {}} onScan={() => {}} />))
  expect(host.textContent?.match(/30 of 30 days scanned/g)).toHaveLength(1)
  expect(host.textContent).toContain('No usage recorded in this window')
})
