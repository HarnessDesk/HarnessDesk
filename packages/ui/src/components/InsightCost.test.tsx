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
  id: 'source-1', kind: 'corpus', label: 'Recorded transcript', observedAt: 0, checkedAt: 60_000,
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
  expect(container.textContent).toContain('Recorded transcript')
  expect(container.textContent).toContain('minutes since observation')
})
