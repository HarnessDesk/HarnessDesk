import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { runtimeId, type LedgerReport } from '@harnessdesk/protocol'
import type { ChartMetric } from '../../lib/ledger'

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

it('does not show zero spend for shorter rowless periods', () => {
  act(() => root.render(<Spend ledger={emptyLedger(30)} wideLedger={emptyLedger(60)} byId={new Map()} tintOf={() => 'blue'} scan={null} now={Date.parse('2026-10-10T12:00:00')} range={30} mode="bars" onModeChange={() => {}} onScan={() => {}} />))
  const stats = [...host.querySelectorAll('[data-slot="stat"]')]
  const today = stats.find(stat => stat.textContent?.includes('Today'))!
  expect(today.querySelector('[data-role="metric"]')?.textContent).toBe('—')
  expect(today.textContent).toContain('No record yet')
  expect(stats.find(stat => stat.textContent?.includes('Last 7 days'))?.textContent).toContain('No record yet')
  expect(host.querySelector('[data-slot="chart-title"]')?.textContent).toBe('—')
  expect(host.textContent?.match(/0 of 30 days with usage/g)).toHaveLength(1)
  expect(host.textContent).toContain('No usage recorded in this window')
  expect(host.textContent).not.toContain('unpriced')
})

it('states complete scan coverage once even when the recorded window is empty', () => {
  const now = Date.parse('2026-10-10T12:00:00')
  const ledger = { ...emptyLedger(30), totalCost: 0, coverage: { ...emptyLedger(30).coverage, daysCovered: 30,
    coveredDays: Array.from({ length: 30 }, (_, back) => new Date(2026, 9, 10 - back).getTime()) } }
  act(() => root.render(<Spend ledger={ledger} wideLedger={null} byId={new Map()} tintOf={() => 'blue'} scan={null} now={now} range={30} mode="bars" onModeChange={() => {}} onScan={() => {}} />))
  expect(host.textContent?.match(/30 of 30 days with usage/g)).toHaveLength(1)
  expect(host.textContent).toContain('No usage recorded in this window')
})


it('agrees across ranges while distinguishing a rowless today from an observed zero', () => {
  const now = new Date(2026, 9, 10, 12).getTime()
  const day = (back: number) => new Date(2026, 9, 10 - back).getTime()
  const coveredDays = [3, 4, 6].map(day)
  const daily = [3, 4, 6].map((back, index) => ({ day: day(back), runtime: runtimeId('fixture'), cost: [10.01, 9.03, 4.05][index]!, tokens: 10 }))
  const ledger = (days: number): LedgerReport => ({ ...emptyLedger(days), totalCost: 23.09, daily,
    coverage: { ...emptyLedger(days).coverage, coveredDays, daysCovered: 3, earliestDay: day(6) } })
  const render = (days: number, report = ledger(days), at = now) => act(() => root.render(<Spend ledger={report} wideLedger={null} byId={new Map()} tintOf={() => 'blue'} scan={null} now={at} range={days} mode="bars" onModeChange={() => {}} onScan={() => {}} />))
  render(7)
  const headline = host.querySelector('[data-slot="chart-title"]')!.textContent
  expect(headline).toBe('$23.09')
  expect(host.textContent).toContain('3 of 7 days with usage')
  expect(host.querySelector('[data-slot="stat"]')?.textContent).toContain('Today—No record yet')
  render(30)
  const week = [...host.querySelectorAll('[data-slot="stat"]')].find(stat => stat.textContent?.includes('Last 7 days'))!
  expect(week.querySelector('[data-role="metric"]')?.textContent).toBe(headline)
  expect(week.textContent).toContain('3 of 7 days with history')
  expect(host.querySelector('[data-slot="stat"]')?.textContent).toContain('Today—No record yet')
  render(7, { ...ledger(7), daily: [...daily, { day: day(0), runtime: runtimeId('fixture'), cost: 0, tokens: 0 }] })
  expect(host.querySelector('[data-slot="stat"]')?.textContent).toContain('Today$0')
  render(7, { ...ledger(7), daily: [], totalCost: 0, coverage: { ...ledger(7).coverage, daysCovered: 0, coveredDays: [] } }, day(1) + 12 * 3600000)
  expect(host.querySelector('[data-slot="stat"]')?.textContent).toContain('Today—No record yet')
})

it('counts runtimes in the turns chart’s coverage footnote', () => {
  const runtime = runtimeId('fixture')
  const ledger = { ...emptyLedger(30), totalCost: 1, daily: [{ day: new Date().setHours(0, 0, 0, 0), runtime, cost: 1, tokens: 10, turns: 1 }], rows: [{ key: 'fixture', label: 'Fixture', runtime, cost: 1, tokens: 10, hasUnpriced: false }],
    coverage: { ...emptyLedger(30).coverage, turnsKnownFor: [runtime] } }
  act(() => root.render(<Spend ledger={ledger} wideLedger={null} byId={new Map()} tintOf={() => 'blue'} scan={null} now={Date.now()} range={30} mode="bars" metric="turns" onModeChange={() => {}} onScan={() => {}} />))
  expect(host.textContent).toContain('turns known for 1 of 1 runtimes')
})


it.each(['cost', 'tokens', 'turns'] as const)('uses record-based wording for a rowless today in %s', metric => {
  const now = new Date(2026, 9, 10, 12).getTime()
  const today = new Date(2026, 9, 10).getTime()
  const yesterday = new Date(2026, 9, 9).getTime()
  const runtime = runtimeId('fixture')
  const base = { ...emptyLedger(7), totalCost: 1, daily: [{ day: yesterday, runtime, cost: 1, tokens: 2, turns: 3 }],
    coverage: { ...emptyLedger(7).coverage, turnsKnownFor: [runtime] } }
  const render = (ledger: LedgerReport) => act(() => root.render(<Spend ledger={ledger} wideLedger={null} byId={new Map()} tintOf={() => 'blue'} scan={null} now={now} range={7} mode="bars" metric={metric} onModeChange={() => {}} onScan={() => {}} />))
  render(base)
  expect(host.querySelector('[data-slot="stat"]')?.textContent).toContain('Today—No record yet')
  render({ ...base, daily: [...base.daily, { day: today, runtime, cost: 0, tokens: 0, turns: 0 }] })
  expect(host.querySelector('[data-slot="stat"]')?.textContent).not.toContain('No record yet')
})

const NOW = new Date(2026, 9, 16, 12).getTime()
const day = (back: number) => new Date(2026, 9, 16 - back).getTime()
const known = runtimeId('known')
const unavailable = runtimeId('unavailable')
const counted = (back: number, turns = 2) => ({ day: day(back), runtime: known, cost: 1, tokens: 10, turns })
const uncounted = (back: number, zero = false) => ({ day: day(back), runtime: unavailable, cost: zero ? 0 : 3, tokens: zero ? 0 : 30 })
const withDaily = (daily: LedgerReport['daily']): LedgerReport => ({
  ...emptyLedger(30), daily,
  rows: [...new Set(daily.map(row => row.runtime))].map(runtime => ({
    key: String(runtime), label: String(runtime), runtime, hasUnpriced: false,
    cost: daily.filter(row => row.runtime === runtime).reduce((sum, row) => sum + row.cost, 0),
    tokens: daily.filter(row => row.runtime === runtime).reduce((sum, row) => sum + row.tokens, 0),
  })),
  totalCost: daily.reduce((sum, row) => sum + row.cost, 0),
  totalTokens: daily.reduce((sum, row) => sum + row.tokens, 0),
  coverage: { ...emptyLedger(30).coverage, turnsKnownFor: [known] },
})
const renderMetric = (ledger: LedgerReport, mode: 'bars' | 'line' = 'bars', metric: ChartMetric = 'turns') =>
  act(() => root.render(<Spend ledger={ledger} wideLedger={null} byId={new Map()} tintOf={() => 'blue'} scan={null} now={NOW} range={30} mode={mode} metric={metric} onModeChange={() => {}} onScan={() => {}} />))
const stat = (label: string) => [...host.querySelectorAll('[data-slot="stat"]')].find(stat => stat.textContent?.startsWith(label))!
const press = (key: string) => act(() => host.querySelector('[role="group"]')!.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true })))

it.each(['bars', 'line'] as const)('names recorded unavailable Today in %s while retaining the dash', mode => {
  renderMetric(withDaily([counted(1), uncounted(0)]), mode)
  expect(stat('Today').querySelector('[data-role="metric"]')?.textContent).toBe('—')
  expect(stat('Today').textContent).toBe('Today—Turns unavailable')
  expect(host.querySelector('[data-slot="day-columns"]')).not.toBeNull()
})

it.each(['bars', 'line'] as const)('names a recorded unavailable week in %s while retaining the dash', mode => {
  renderMetric(withDaily([counted(8), ...Array.from({ length: 7 }, (_, back) => uncounted(back))]), mode)
  expect(stat('Last 7 days').querySelector('[data-role="metric"]')?.textContent).toBe('—')
  expect(stat('Last 7 days').textContent).toBe('Last 7 days—Turns unavailable')
})

it('describes six available days in a fully recorded week as turn counts, retaining the sum', () => {
  renderMetric(withDaily([uncounted(0), ...Array.from({ length: 6 }, (_, index) => counted(index + 1))]))
  expect(stat('Last 7 days').querySelector('[data-role="metric"]')?.textContent).toBe('12')
  expect(stat('Last 7 days').textContent).toContain('6 of 7 days with turn counts')
  expect(stat('Last 7 days').textContent).not.toContain('with history')
  expect(stat('Last 7 days').textContent).not.toContain('so far')
  // An unavailable day outside a tile must not change that tile's caption.
  renderMetric(withDaily([uncounted(8), ...Array.from({ length: 7 }, (_, back) => counted(back))]))
  expect(stat('Last 7 days').textContent).toBe('Last 7 days14so far')
  renderMetric(withDaily([uncounted(8), counted(1)]))
  expect(stat('Today').textContent).toBe('Today—No record yet')
  expect(stat('Last 7 days').textContent).toContain('1 of 7 days with history')
})

it.each(['bars', 'line'] as const)('propagates both unknown causes through the %s chart’s pointer, keyboard and accessible series', mode => {
  renderMetric(withDaily([uncounted(0), uncounted(1), ...[3, 4, 5, 6].map(back => counted(back))]), mode)
  expect(stat('Last 7 days').textContent).toContain('4 of 7 days with turn counts')
  const plot = host.querySelector('[role="group"]')!
  const list = host.querySelector('ul.sr-only')!
  expect(list.children[29]?.textContent).toContain('Turns unavailable')
  expect(list.children[27]?.textContent).toContain('No record yet')
  for (const [index, label] of [[29, 'Turns unavailable'], [27, 'No record yet']] as const) {
    act(() => plot.children[index]!.dispatchEvent(new MouseEvent('pointerover', { bubbles: true })))
    expect(host.querySelector('[data-slot="chart-tip"]')?.textContent).toContain(label)
    expect(host.querySelector('[aria-live]')?.textContent).toContain(label)
    expect((plot.children[index]!.firstElementChild as HTMLElement).style.background).toContain('--hd-chart-heat-not-scanned')
  }
  press('End')
  expect(host.querySelector('[aria-live]')?.textContent).toContain('Turns unavailable')
  press('ArrowLeft')
  press('ArrowLeft')
  expect(host.querySelector('[aria-live]')?.textContent).toContain('No record yet')
  if (mode === 'line') expect(host.querySelector('svg path[stroke-width="4.5"]')).toBeNull()
})

it('keeps explicit known zero numeric, unsupported zero unavailable and mixed-runtime known share available', () => {
  renderMetric(withDaily([counted(1), { ...counted(0, 0), cost: 0, tokens: 0 }]))
  expect(stat('Today').textContent).toBe('Today0so far')
  press('End')
  expect(host.querySelector('[data-slot="chart-tip"]')?.textContent).toContain('No turns yet')
  renderMetric(withDaily([counted(1), uncounted(0, true)]))
  expect(stat('Today').textContent).toBe('Today—Turns unavailable')
  renderMetric(withDaily([counted(0, 5), uncounted(0)]))
  expect(stat('Today').textContent).toBe('Today5so far')
  expect(host.querySelector('[data-slot="chart-title"]')?.textContent).toBe('—')
  expect(host.textContent).toContain('turns known for 1 of 2 runtimes')
  press('End')
  expect(host.querySelector('[aria-live]')?.textContent).not.toMatch(/unavailable|No record/)
})

it.each(['cost', 'tokens'] as const)('keeps recorded %s available regardless of turns support', metric => {
  renderMetric(withDaily(Array.from({ length: 7 }, (_, back) => uncounted(back))), 'bars', metric)
  expect(stat('Last 7 days').textContent).toContain('so far')
  expect(stat('Last 7 days').querySelector('[data-role="metric"]')?.textContent).toBe(metric === 'cost' ? '$21.00' : '210')
  expect(host.textContent).not.toContain('Turns unavailable')
  renderMetric(withDaily([uncounted(0)]), 'bars', metric)
  expect(stat('Last 7 days').textContent).toContain('1 of 7 days with history')
})

it('qualifies the existing empty state only when recorded turn counts are unavailable', () => {
  for (const daily of [[uncounted(0)], [uncounted(0, true)], [uncounted(0), counted(1, 0)]]) {
    renderMetric(withDaily(daily))
    expect(host.querySelector('[data-slot="empty-state"]')?.textContent).toBe('Turn counts unavailable in this window')
    expect(stat('Last 7 days').textContent).toContain(daily.some(row => row.runtime === known) ? '1 of 7 days with turn counts' : 'Turns unavailable')
    expect(host.querySelector('[data-slot="day-columns"]')).toBeNull()
    expect(host.textContent).not.toContain('No turns yet in this window')
  }
  for (const daily of [[], [{ ...counted(0, 0), cost: 0, tokens: 0 }]]) {
    renderMetric(withDaily(daily))
    expect(host.querySelector('[data-slot="empty-state"]')?.textContent).toBe('No turns yet in this window')
    expect(host.querySelector('[data-slot="day-columns"]')).toBeNull()
  }
  for (const metric of ['cost', 'tokens'] as const) {
    renderMetric(withDaily([uncounted(0, true)]), 'bars', metric)
    expect(host.querySelector('[data-slot="empty-state"]')?.textContent).toBe(metric === 'cost' ? 'No priced usage in this window' : 'No tokens yet in this window')
    expect(host.querySelector('[data-slot="day-columns"]')).toBeNull()
  }
})
