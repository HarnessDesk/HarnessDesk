import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { runtimeId, type LedgerReport, type SpendProvenance } from '@harnessdesk/protocol'

import { OverviewStrip } from './OverviewStrip'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

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

const ledger = (provenance: SpendProvenance): LedgerReport =>
  ({
    days: 1,
    currency: 'USD',
    totalCost: provenance === 'unknown' ? null : 12,
    totalTokens: 100,
    provenance,
    coverage: { priced: 1, unpriced: 0, unmetered: 0, estimated: 0, daysCovered: 1, daysRequested: 1 },
    rows: [],
    daily: [],
    scannedAt: null,
  }) as LedgerReport

describe('OverviewStrip usage cost cell', () => {
  it.each([
    ['listPrice', 'list-price equivalent'],
    ['vendorMetered', 'plan metered'],
    ['mixed', 'metered and list-price'],
    ['unknown', 'spend unavailable'],
  ] as const)('names the %s figure and keeps its pricing detail in the title', (provenance, phrase) => {
    act(() =>
      root.render(
        <OverviewStrip
          reports={[]}
          ledger={ledger(provenance)}
          wideLedger={null}
          range={30}
          now={Date.parse('2026-09-30T12:00:00Z')}
          metric="value"
          onMetricChange={() => {}}
          onOpenPlan={() => {}}
        />,
      ),
    )

    const valueButton = host.querySelector<HTMLButtonElement>('button[aria-pressed="true"]')
    expect(valueButton?.textContent?.startsWith('Usage cost')).toBe(true)
    expect(valueButton?.textContent).not.toContain('Selected')
    expect(valueButton?.getAttribute('title')).toBe(`Usage cost (${phrase}). Switch the chart below to cost per day`)
    if (provenance === 'unknown') expect(valueButton?.textContent).toContain('—')
  })
})


describe('OverviewStrip Turns cell', () => {
  it.each([undefined, 0, 12])('only shows turns when they are reported (%s)', (turns) => {
    const report = { ...ledger('listPrice'), totals: { input: 100, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, requests: 1, ...(turns === undefined ? {} : { turns }) } }
    act(() => root.render(<OverviewStrip reports={[]} ledger={report} wideLedger={null} range={30} now={0} metric="value" onMetricChange={() => {}} onOpenPlan={() => {}} />))
    const tile = host.querySelector('button[title^="Turns"]')
    if (turns === undefined) expect(tile).toBeNull()
    else expect(tile?.textContent).toContain(String(turns))
  })
})


it.each([0, 7])('shows the known partial turns subtotal %s with its coverage', (count) => {
  const alpha = runtimeId('alpha'), beta = runtimeId('beta'), gamma = runtimeId('gamma')
  const report = { ...ledger('listPrice'), coverage: { ...ledger('listPrice').coverage, turnsKnownFor: [alpha, beta] },
    rows: [], daily: [
      { day: 1, runtime: alpha, cost: 0, tokens: 1, turns: count },
      { day: 2, runtime: beta, cost: 0, tokens: 1, turns: 0 },
      { day: 2, runtime: gamma, cost: 0, tokens: 1, turns: 100 },
    ] }
  act(() => root.render(<OverviewStrip reports={[]} ledger={report} wideLedger={null} range={30} now={0} metric="value" onMetricChange={() => {}} onOpenPlan={() => {}} />))
  const tile = host.querySelector('button[title^="Turns"]')
  expect(tile?.textContent).toContain(String(count))
  expect(tile?.textContent).toContain('known for 2 of 3 runtimes')
  expect(tile?.textContent).not.toContain('paid a turn')
  expect(tile?.textContent).not.toContain('—')
})

it('keeps the qualifier and suppresses per-turn pricing and trends for partial coverage', () => {
  const alpha = runtimeId('alpha'), beta = runtimeId('beta')
  const report = { ...ledger('listPrice'), totals: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, requests: 1, turns: 99 },
    coverage: { ...ledger('listPrice').coverage, turnsKnownFor: [alpha] },
    daily: [{ day: 1, runtime: alpha, cost: 0, tokens: 1, turns: 4 }, { day: 1, runtime: beta, cost: 0, tokens: 1 }] }
  const paid = [{ runtime: alpha, lanes: [], billing: { fee: { amount: 30, currency: 'USD', period: 'month' } } }] as unknown as Parameters<typeof OverviewStrip>[0]['reports']
  act(() => root.render(<OverviewStrip reports={paid} ledger={report} wideLedger={report} range={30} now={Date.parse('2026-09-30T12:00:00Z')} metric="value" onMetricChange={() => {}} onOpenPlan={() => {}} />))
  const tile = host.querySelector('button[title^="Turns"]')!
  expect(tile.textContent).toContain('known for 1 of 2 runtimes')
  expect(tile.textContent).toContain('4')
  expect(tile.textContent).not.toContain('99')
  expect(tile.textContent).not.toContain('paid a turn')
  expect(tile.textContent).not.toContain('%')
})

it('does not compare a complete current total with a partial previous period', () => {
  const alpha = runtimeId('alpha'), beta = runtimeId('beta')
  const now = new Date(2026, 8, 30, 12).getTime()
  const today = new Date(2026, 8, 30).getTime(), yesterday = new Date(2026, 8, 29).getTime()
  const base = ledger('listPrice')
  const current = { ...base, totals: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, requests: 1, turns: 8 },
    coverage: { ...base.coverage, turnsKnownFor: [alpha], earliestDay: yesterday },
    daily: [{ day: today, runtime: alpha, cost: 0, tokens: 1, turns: 8 }] }
  const wide = { ...current, days: 2, daily: [
    { day: yesterday, runtime: alpha, cost: 0, tokens: 1, turns: 2 },
    { day: yesterday, runtime: beta, cost: 0, tokens: 1, turns: 0 },
    ...current.daily,
  ] }
  const draw = (previous: LedgerReport) => act(() => root.render(<OverviewStrip reports={[]} ledger={current} wideLedger={previous} range={1} now={now} metric="value" onMetricChange={() => {}} onOpenPlan={() => {}} />))
  draw({ ...wide, coverage: { ...wide.coverage, turnsKnownFor: [alpha, beta] } })
  expect(host.querySelector('button[title^="Turns"]')?.textContent).toContain('%')
  draw(wide)
  expect(host.querySelector('button[title^="Turns"]')?.textContent).not.toContain('%')
  const missing = { ...wide, coverage: { ...wide.coverage, turnsKnownFor: [alpha, beta] },
    daily: wide.daily.map(entry => entry.runtime === beta ? { ...entry, turns: undefined } : entry) }
  draw(missing)
  expect(host.querySelector('button[title^="Turns"]')?.textContent).not.toContain('%')
})

it('does not invent a subtotal when a covered daily count is missing', () => {
  const alpha = runtimeId('alpha'), beta = runtimeId('beta')
  const report = { ...ledger('listPrice'), coverage: { ...ledger('listPrice').coverage, turnsKnownFor: [alpha] },
    rows: [], daily: [{ day: 1, runtime: alpha, cost: 0, tokens: 1 }, { day: 1, runtime: beta, cost: 0, tokens: 1 }] }
  act(() => root.render(<OverviewStrip reports={[]} ledger={report} wideLedger={null} range={30} now={0} metric="value" onMetricChange={() => {}} onOpenPlan={() => {}} />))
  expect(host.querySelector('button[title^="Turns"]')?.textContent).toContain('—')
})

it('counts runtimes in both partial-coverage captions', () => {
  const alpha = runtimeId('alpha'), beta = runtimeId('beta')
  const report = { ...ledger('listPrice'), coverage: { ...ledger('listPrice').coverage, turnsKnownFor: [alpha] }, rows: [
    { key: 'alpha', label: 'Alpha', runtime: alpha, cost: 12, tokens: 100, hasUnpriced: false },
    { key: 'beta', label: 'Beta', runtime: beta, cost: null, tokens: null, hasUnpriced: true },
  ] }
  act(() => root.render(<OverviewStrip reports={[]} ledger={report} wideLedger={null} range={30} now={0} metric="value" onMetricChange={() => {}} onOpenPlan={() => {}} />))
  for (const label of ['Turns', 'Tokens']) expect(host.querySelector(`button[title^="${label}"]`)?.textContent).toContain('known for 1 of 2 runtimes')
})
