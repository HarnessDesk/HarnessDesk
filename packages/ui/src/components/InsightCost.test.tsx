import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
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
  vi.restoreAllMocks()
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

it('keeps the Cost recovery action outside its warning sentence', () => {
 const onRefresh = vi.fn()
 act(() => root.render(<InsightCost report={null} loading={false} problem="Source unavailable." onRefresh={onRefresh} />))
 const note = container.querySelector('[data-slot="note"]')!
 const retry = note.querySelector<HTMLButtonElement>('button')!
 expect(note.querySelector('[data-slot="note-text"]')?.textContent).toBe('Recorded usage could not be read. Source unavailable.')
 expect(note.querySelector('[data-slot="note-text"]')?.contains(retry)).toBe(false)
 expect(retry.textContent).toBe('Retry')
 act(() => retry.click())
 expect(onRefresh).toHaveBeenCalledOnce()
})

it('shares the all-missing cohort note beneath Receipt Cost', () => {
 const base = report(); const b = base.breakdowns[0]!
 const shown = { ...base, breakdowns: [{ ...b, rows: [1, 2].map(n => ({ ...b.rows[0]!, key: `seat-${n}`, label: `Seat ${n}`, note: 'Brief cohort unavailable' })) }] }
 act(() => root.render(<InsightCost report={shown} loading={false} problem={null} detailOnly onRefresh={() => {}} />))
 expect(container.querySelector('dl')?.textContent).not.toContain('Brief cohort unavailable')
 expect([...container.querySelectorAll('[data-slot="note"]')].filter(note => note.textContent === 'Brief cohort unavailable')).toHaveLength(1)
})

it('keeps total fixed while alternate views retain zero, floor, estimate and unknown qualification', () => {
  act(() => root.render(<InsightCost report={report()} loading={false} problem={null} onRefresh={() => {}} onSeat={() => {}} onSession={() => {}} onMessage={() => {}} />))
  expect(container.textContent).toContain('$3.00')
  expect(container.textContent).toContain('Estimate')
  expect(container.textContent).toContain('Estimated known subtotal')
  expect(container.textContent).toContain('No unique historical Seat could be established.')
  expect(container.textContent).toContain('minutes since observation')
  expect(container.textContent).toContain('$0.00')
  expect(container.textContent).toContain('Unknown')
  const agent = [...container.querySelectorAll('button')].find((button) => button.textContent === 'By Agent')
  expect(agent).toBeTruthy()
  act(() => agent?.dispatchEvent(new MouseEvent('click', { bubbles: true })))
  expect(container.textContent).toContain('$3.00')
  expect(container.textContent).toContain('Agent one')
  expect(container.textContent).toContain('At least')
  expect(container.textContent).toContain('Streaming usage remains a floor.')
  expect(container.textContent).toContain('Recorded usage')
  act(() => [...container.querySelectorAll('button')].find(button => button.textContent === 'Sources')!.click())
  expect(document.body.textContent).toContain('minutes since observation')
})

it('leaves receipt rows inert when no navigation handler exists', () => {
  act(() => root.render(<InsightCost report={report()} loading={false} problem={null} onRefresh={() => {}} />))
  const seat = [...container.querySelectorAll('[data-slot="key-value-row"]')].find(node => node.textContent === 'Seat one$0.00')
  expect(seat).toBeTruthy()
  expect(() => act(() => seat?.dispatchEvent(new MouseEvent('click', { bubbles: true })))).not.toThrow()
})

it('labels vendor-metered costs distinctly from list-price estimates', () => {
  const base = report()
  const vendor = { ...base, totals: { ...base.totals, usd: { ...base.totals.usd, basis: 'vendorMetered' as const, quality: 'exact' as const } } }
  act(() => root.render(<InsightCost report={vendor} loading={false} problem={null} onRefresh={() => {}} />))
  act(() => [...container.querySelectorAll('button')].find(button => button.textContent === 'Sources')!.click())
  expect(document.body.textContent).toContain('Vendor-metered cost')
})

it('does not call a mixed subtotal vendor-and-list-priced when another portion is unknown', () => {
  const base = report()
  const mixedPartial = {
    ...base,
    totals: { ...base.totals, usd: { ...base.totals.usd, basis: 'mixed' as const, quality: 'floor' as const, coverage: 'partial' as const } },
  }
  act(() => root.render(<InsightCost report={mixedPartial} loading={false} problem={null} onRefresh={() => {}} />))
  act(() => [...container.querySelectorAll('button')].find(button => button.textContent === 'Sources')!.click())
  expect(document.body.textContent).toContain('Vendor- or list-price cost; another portion is unknown')
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

it('receipt cost keeps its breakdown, total footer and refresh', () => {
  let refreshes = 0
  act(() => root.render(<InsightCost report={report()} loading={false} problem={null} onRefresh={() => { refreshes++ }} {...{ detailOnly: true }} />))
  expect(container.querySelector('[data-footer]')?.textContent).toContain('$3.00')
  expect(container.textContent).toContain('Seat one')
  const refresh = [...container.querySelectorAll('button')].find(one => one.textContent === 'Refresh')!
  act(() => refresh.click())
  expect(refreshes).toBe(1)
})

it('keeps breakdown tabs above its numeric list and shows total source age beside the total', () => {
  const base = report()
  const common = metric(1, 'exact')
  const amounts = { ...base.totals, usd: common }
  const three = { ...base, totals: amounts, breakdowns: ['seat', 'goal', 'agent'].map(dimension => ({
    ...base.breakdowns[0]!, dimension: dimension as 'seat' | 'goal' | 'agent', unattributed: amounts,
    rows: [1, 2].map(n => ({ ...base.breakdowns[0]!.rows[0]!, key: `part-${n}`, label: `Part ${n}`, amounts })),
  })) }
  act(() => root.render(<InsightCost report={three} loading={false} problem={null} onRefresh={() => {}} detailOnly />))
  const head = container.querySelector('[data-section-head]')!
  expect(head.nextElementSibling?.getAttribute('data-slot')).toBe('tabs')
  expect(head.nextElementSibling?.nextElementSibling?.getAttribute('data-slot')).toBe('key-value')
  for (const row of container.querySelectorAll('[data-slot="key-value-row"]')) {
    if (!row.hasAttribute('data-footer')) expect(row.textContent).not.toContain('Recorded usage')
  }
  expect(container.querySelector('[data-footer]')?.textContent).toContain('minutes since observation')
  // In detailOnly the common source age is already beside the aggregate in Record.
  expect(container.textContent).toContain('read separately from the wrap')
})

it('keeps unknown unattributed facts without repeating the aggregate source and age on measured Seats', () => {
  const base = report()
  const unknown = { ...base.breakdowns[0]!.unattributed, usd: { ...metric(null, 'unknown', 'none'), sourceIds: [] } }
  const measured = { ...base, totals: { ...base.totals, usd: metric(1, 'exact') }, breakdowns: [{ ...base.breakdowns[0]!, unattributed: unknown }] }
  act(() => root.render(<InsightCost report={measured} loading={false} problem={null} onRefresh={() => {}} detailOnly />))
  const rows = [...container.querySelectorAll('[data-slot="key-value-row"]')]
  const seat = rows.find(row => row.textContent?.includes('Seat one'))!
  expect(seat.textContent).not.toContain('Recorded usage')
  expect(seat.textContent).not.toContain('minutes since observation')
  const unassigned = rows.find(row => row.textContent?.includes('Unattributed'))!
  expect(unassigned.textContent).toContain('Unknown')
  act(() => [...container.querySelectorAll('button')].find(button => button.textContent === 'Sources')!.click())
  expect(document.body.textContent).toContain('No measured source')
  expect(document.body.textContent).toContain('Observation time unavailable')
})

it('puts the recorded total after its numeric KeyValue parts and keeps source sentences in Sources', () => {
 act(()=>root.render(<InsightCost report={report()} loading={false} problem={null} onRefresh={()=>{}} />))
 const rows=[...container.querySelectorAll('[data-slot="key-value-row"]')]
 expect(rows.map(r=>r.textContent)).toContain('Seat one$0.00')
 expect(rows.at(-1)?.textContent).toContain('Recorded usage')
 expect(rows.at(-1)?.textContent).toContain('$3.00')
 expect(container.querySelector('dl')?.textContent).toContain('minutes since observation')
 expect(rows.find(r=>r.textContent?.includes('Unattributed'))?.hasAttribute('title')).toBe(false)
})


it('shows common host notes once beneath Cost and keeps figures paired with short keys', () => {
  const base = report()
  const breakdown = base.breakdowns[0]!
  const repeated = { ...base, breakdowns: [{ ...breakdown,
    rows: [1, 2, 3, 4].map(n => ({ ...breakdown.rows[0]!, key: `seat-${n}`, label: `Seat ${n}`, note: 'Recorded brief cohort' })),
    reason: 'Recorded corpus rows without a unique historical Seat remain unattributed.',
  }] }
  act(() => root.render(<InsightCost report={repeated} loading={false} problem={null} onRefresh={() => {}} />))
  expect(container.querySelector('dl')?.textContent).not.toContain('Recorded brief cohort')
  expect([...container.querySelectorAll('[data-slot="note"]')].filter(n => n.textContent === 'Recorded brief cohort')).toHaveLength(1)
  expect([...container.querySelectorAll('dt')].map(n => n.textContent)).toEqual(['Seat 1', 'Seat 2', 'Seat 3', 'Seat 4', 'Unattributed', 'Recorded usage'])
  expect(container.querySelector('dt [data-role="subject"]')).toBeNull()
  expect(container.querySelector('[data-slot="key-value-note"]')?.textContent).toContain('Recorded corpus rows')
})

it('leaves varying cohort exceptions on their own full-width note line', () => {
  const base = report()
  const b = base.breakdowns[0]!
  const varied = { ...base, breakdowns: [{ ...b, rows: [
    { ...b.rows[0]!, note: 'Recorded brief cohort' },
    { ...b.rows[0]!, key: 'missing', label: 'Seat two', note: 'Brief cohort unavailable' },
  ] }] }
  act(() => root.render(<InsightCost report={varied} loading={false} problem={null} onRefresh={() => {}} />))
  const row = [...container.querySelectorAll('[data-slot="key-value-row"]')].find(n => n.textContent?.includes('Seat two'))!
  expect(row.querySelector('dt')?.textContent).toBe('Seat two')
  expect(row.querySelector('[data-slot="key-value-note"]')?.textContent).toBe('Brief cohort unavailable')
  expect(row.hasAttribute('title')).toBe(false)
})


it('names four scanned Goal files once in the recorded total', () => {
  vi.spyOn(Date, 'now').mockReturnValue(12 * 60_000)
  const base = report()
  const sources = [1, 2, 3, 4].map(n => ({ ...source, id: `file-${n}` }))
  const fourFiles = { ...base, sources, totals: { ...base.totals, usd: { ...base.totals.usd, sourceIds: sources.map(s => s.id) } } }
  act(() => root.render(<InsightCost report={fourFiles} loading={false} problem={null} onRefresh={() => {}} />))
  expect(container.querySelector('[data-footer] [data-slot="key-value-note"]')?.textContent).toBe('4 files · 12 minutes since observation')
  expect(container.querySelector('[data-footer]')?.textContent).not.toContain('Recorded usage, Recorded usage')
})

it('keeps the normal cohort note shared while missing briefs remain tied to their Seats', () => {
  const base = report(); const b = base.breakdowns[0]!
  const varied = { ...base, breakdowns: [{ ...b, rows: [
    { ...b.rows[0]!, key: 'one', label: 'Seat one', note: 'Recorded brief cohort' },
    { ...b.rows[0]!, key: 'two', label: 'Seat two', note: 'Recorded brief cohort' },
    { ...b.rows[0]!, key: 'missing', label: 'Seat three', note: 'Brief cohort unavailable' },
  ] }] }
  act(() => root.render(<InsightCost report={varied} loading={false} problem={null} onRefresh={() => {}} />))
  expect(container.querySelector('dl')?.textContent).not.toContain('Recorded brief cohort')
  expect([...container.querySelectorAll('[data-slot="note"]')].filter(n => n.textContent === 'Recorded brief cohort')).toHaveLength(1)
  const row = [...container.querySelectorAll('[data-slot="key-value-row"]')].find(n => n.textContent?.includes('Seat three'))!
  expect(row.querySelector('[data-slot="key-value-note"]')?.textContent).toBe('Brief cohort unavailable')
})
