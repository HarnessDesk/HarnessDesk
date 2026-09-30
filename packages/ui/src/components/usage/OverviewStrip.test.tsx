import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { LedgerReport, SpendProvenance } from '@harnessdesk/protocol'

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

describe('OverviewStrip Value cell', () => {
  it.each([
    ['listPrice', 'list-price equivalent'],
    ['vendorMetered', 'plan metered'],
    ['mixed', 'metered and list-price'],
    ['unknown', 'spend unavailable'],
  ] as const)('labels %s as Value and keeps its pricing detail in the title', (provenance, phrase) => {
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
    expect(valueButton?.textContent?.startsWith('Value')).toBe(true)
    expect(valueButton?.getAttribute('title')).toBe(`Value (${phrase}). Switch the chart below to cost per day`)
    if (provenance === 'unknown') expect(valueButton?.textContent).toContain('unpriced')
  })
})
