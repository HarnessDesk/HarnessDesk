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


it('keeps the Turns tile for partial coverage even when the total is unknown', () => {
  const alpha = runtimeId('alpha')
  const report = { ...ledger('listPrice'), coverage: { ...ledger('listPrice').coverage, turnsKnownFor: [alpha] },
    rows: [{ key: 'alpha', label: 'Alpha', runtime: alpha, cost: 12, tokens: 100, hasUnpriced: false }] }
  act(() => root.render(<OverviewStrip reports={[]} ledger={report} wideLedger={null} range={30} now={0} metric="value" onMetricChange={() => {}} onOpenPlan={() => {}} />))
  expect(host.querySelector('button[title^="Turns"]')?.textContent).toContain('—')
})
