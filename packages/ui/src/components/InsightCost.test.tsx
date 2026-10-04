import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it } from 'vitest'
import type { InsightMetric, InsightReport, InsightSource } from '@harnessdesk/protocol'

import { InsightCost } from './InsightCost'

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

const source: InsightSource = {
  id: 'source-1', kind: 'corpus', label: 'Recorded usage', observedAt: 0, checkedAt: 60_000,
  stale: true, problem: null,
}
const metric = (value: number | null, quality: InsightMetric['quality'], coverage: InsightMetric['coverage'] = 'complete'): InsightMetric => ({
  value, quality, coverage, unit: 'usd', basis: 'listPrice', sourceIds: ['source-1'], missing: coverage === 'partial' ? ['One source did not report cache writes.'] : [],
})
const report = (): InsightReport => ({
  id: 'report', generatedAt: 60_000, query: { root: '/repo', from: 0, to: 60_000 }, goals: [], seats: [], goal: 'goal-1', receipt: 'receipt-1',
  totals: { usd: metric(3, 'estimate', 'partial'), tokens: { ...metric(4, 'floor'), unit: 'tokens', basis: 'observed' }, activeMs: { ...metric(null, 'unknown'), unit: 'milliseconds', basis: 'unknown' }, turns: { ...metric(1, 'exact'), unit: 'count', basis: 'observed' } },
  elapsedMs: { ...metric(null, 'unknown'), unit: 'milliseconds', basis: 'unknown' },
  breakdowns: [
    { dimension: 'seat', rows: [{ key: 'seat-1', label: 'Seat one', amounts: { usd: metric(0, 'exact'), tokens: { ...metric(null, 'unknown'), unit: 'tokens', basis: 'observed' }, activeMs: { ...metric(null, 'unknown'), unit: 'milliseconds', basis: 'unknown' }, turns: { ...metric(1, 'exact'), unit: 'count', basis: 'observed' } }, seat: 'seat-1', goal: 'goal-1', session: null, message: null, note: null, elapsedMs: { ...metric(null, 'unknown'), unit: 'milliseconds', basis: 'unknown' } }], unattributed: { usd: metric(null, 'unknown', 'none'), tokens: { ...metric(null, 'unknown'), unit: 'tokens', basis: 'observed', coverage: 'none' }, activeMs: { ...metric(null, 'unknown'), unit: 'milliseconds', basis: 'unknown' }, turns: { ...metric(null, 'unknown'), unit: 'count', basis: 'observed' } }, reason: 'No unique historical Seat could be established.' },
    { dimension: 'agent', rows: [{ key: 'agent-1', label: 'Agent one', amounts: { usd: metric(2, 'floor'), tokens: { ...metric(null, 'unknown'), unit: 'tokens', basis: 'observed' }, activeMs: { ...metric(null, 'unknown'), unit: 'milliseconds', basis: 'unknown' }, turns: { ...metric(1, 'exact'), unit: 'count', basis: 'observed' } }, seat: null, goal: 'goal-1', session: null, message: null, note: 'Streaming usage remains a floor.', elapsedMs: { ...metric(null, 'unknown'), unit: 'milliseconds', basis: 'unknown' } }], unattributed: { usd: metric(null, 'unknown', 'none'), tokens: { ...metric(null, 'unknown'), unit: 'tokens', basis: 'observed', coverage: 'none' }, activeMs: { ...metric(null, 'unknown'), unit: 'milliseconds', basis: 'unknown' }, turns: { ...metric(null, 'unknown'), unit: 'count', basis: 'observed' } }, reason: null },
  ],
  sources: [source], recordedSpend: [], provenance: { state: 'unavailable', note: 'Commit associations are unavailable.' }, gaps: [],
})

it('keeps total fixed while alternate views retain zero, floor, estimate and unknown qualification', () => {
  act(() => root.render(<InsightCost report={report()} loading={false} problem={null} onRefresh={() => {}} onSeat={() => {}} onSession={() => {}} onMessage={() => {}} />))
  expect(container.textContent).toContain('$3.00')
  expect(container.textContent).toContain('Estimate')
  expect(container.textContent).toContain('Estimated known subtotal')
  expect(container.textContent).toContain('$0.00')
  expect(container.textContent).toContain('Unknown')
  const agent = [...container.querySelectorAll('button')].find((button) => button.textContent === 'By Agent')
  expect(agent).toBeTruthy()
  act(() => agent?.dispatchEvent(new MouseEvent('click', { bubbles: true })))
  expect(container.textContent).toContain('$3.00')
  expect(container.textContent).toContain('Agent one')
  expect(container.textContent).toContain('At least')
  expect(container.textContent).toContain('Recorded usage')
  expect(container.textContent).toContain('minutes since observation')
})

it('leaves receipt rows inert when no navigation handler exists', () => {
  act(() => root.render(<InsightCost report={report()} loading={false} problem={null} onRefresh={() => {}} />))
  const title = [...container.querySelectorAll('[class*="_rowTitle_"]')].find((node) => node.textContent === 'Seat one')
  const seat = title?.closest('div[class*="_row_"]')
  expect(seat).toBeTruthy()
  expect(() => act(() => seat?.dispatchEvent(new MouseEvent('click', { bubbles: true })))).not.toThrow()
})

it('labels vendor-metered costs distinctly from list-price estimates', () => {
  const base = report()
  const vendor = { ...base, totals: { ...base.totals, usd: { ...base.totals.usd, basis: 'vendorMetered' as const, quality: 'exact' as const } } }
  act(() => root.render(<InsightCost report={vendor} loading={false} problem={null} onRefresh={() => {}} />))
  expect(container.textContent).toContain('Vendor-metered cost')
})

it('does not call a mixed subtotal vendor-and-list-priced when another portion is unknown', () => {
  const base = report()
  const mixedPartial = {
    ...base,
    totals: { ...base.totals, usd: { ...base.totals.usd, basis: 'mixed' as const, quality: 'floor' as const, coverage: 'partial' as const } },
  }
  act(() => root.render(<InsightCost report={mixedPartial} loading={false} problem={null} onRefresh={() => {}} />))
  expect(container.textContent).toContain('Vendor- or list-price cost; another portion is unknown')
  expect(container.textContent).not.toContain('Vendor-metered and list-price cost')
})

it('keeps safe source read status when its observation time is unknown', () => {
  const unreadable = {
    ...report(),
    sources: [{ ...source, observedAt: null, stale: true, problem: 'Recorded usage source could not be discovered.' }],
  }
  act(() => root.render(<InsightCost report={unreadable} loading={false} problem={null} onRefresh={() => {}} />))
  const sources = [...container.querySelectorAll('button')].find((button) => button.textContent === 'Sources')
  act(() => sources?.dispatchEvent(new MouseEvent('click', { bubbles: true })))

  expect(document.body.textContent).toContain('Observation time unknown')
  expect(document.body.textContent).toContain(`Read ${new Date(source.checkedAt).toLocaleString()}`)
  expect(document.body.textContent).toContain('Stale')
  expect(document.body.textContent).toContain('Recorded usage source could not be discovered.')
})

it('receipt cost detail keeps its breakdown and refresh while the total is presented in Record', () => {
  let refreshes = 0
  act(() => root.render(<InsightCost report={report()} loading={false} problem={null} onRefresh={() => { refreshes++ }} {...{ detailOnly: true }} />))
  expect(container.textContent).not.toContain('$3.00')
  expect(container.textContent).toContain('Seat one')
  const refresh = [...container.querySelectorAll('button')].find(one => one.textContent === 'Refresh')!
  act(() => refresh.click())
  expect(refreshes).toBe(1)
})

it('keeps breakdown tabs inside the Rows card named by Cost detail and says shared facts once', () => {
  const base = report()
  const common = metric(1, 'exact')
  const amounts = { ...base.totals, usd: common }
  const three = { ...base, totals: amounts, breakdowns: ['seat', 'goal', 'agent'].map(dimension => ({
    ...base.breakdowns[0]!, dimension: dimension as 'seat' | 'goal' | 'agent', unattributed: amounts,
    rows: [1, 2].map(n => ({ ...base.breakdowns[0]!.rows[0]!, key: `part-${n}`, label: `Part ${n}`, amounts })),
  })) }
  act(() => root.render(<InsightCost report={three} loading={false} problem={null} onRefresh={() => {}} detailOnly />))
  const head = container.querySelector('[data-section-head]')!
  expect(head.nextElementSibling?.getAttribute('data-slot')).toBe('rows')
  expect(container.querySelector('[role="tablist"]')?.closest('[data-slot="rows"]')).toBe(head.nextElementSibling)
  for (const row of container.querySelectorAll('[data-slot="row"]')) {
    expect(row.textContent).not.toContain('Recorded usage')
    expect(row.textContent).not.toContain('minutes since observation')
  }
  // In detailOnly these common facts are already beside the aggregate in Record.
  expect(container.textContent).toContain('read separately from the wrap')
})

it('keeps unknown unattributed facts without repeating the aggregate source and age on measured Seats', () => {
  const base = report()
  const unknown = { ...base.breakdowns[0]!.unattributed, usd: { ...metric(null, 'unknown', 'none'), sourceIds: [] } }
  const measured = { ...base, totals: { ...base.totals, usd: metric(1, 'exact') }, breakdowns: [{ ...base.breakdowns[0]!, unattributed: unknown }] }
  act(() => root.render(<InsightCost report={measured} loading={false} problem={null} onRefresh={() => {}} detailOnly />))
  const rows = [...container.querySelectorAll('[data-slot="row"]')]
  const seat = rows.find(row => row.textContent?.includes('Seat one'))!
  expect(seat.textContent).not.toContain('Recorded usage')
  expect(seat.textContent).not.toContain('minutes since observation')
  const unassigned = rows.find(row => row.textContent?.includes('Unattributed'))!
  expect(unassigned.textContent).toContain('No measured source')
  expect(unassigned.textContent).toContain('Observation time unavailable')
})
