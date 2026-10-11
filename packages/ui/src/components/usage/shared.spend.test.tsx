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
  coverage: { priced: 0, unpriced: 0, unmetered: 0, estimated: 0, daysCovered: 0, daysRequested: days },
  rows: [],
  daily: [],
  scannedAt: null,
})

it('uses the chart frame itself as the empty plot body', () => {
  act(() => root.render(<Spend ledger={emptyLedger(30)} wideLedger={emptyLedger(60)} byId={new Map()} tintOf={() => 'blue'} scan={null} now={Date.parse('2026-10-10T12:00:00')} range={30} mode="bars" onModeChange={() => {}} onScan={() => {}} showFooter={false} />))
  const frame = host.querySelector<HTMLElement>('[data-slot="chart-frame"]')!
  const empty = frame.querySelector<HTMLElement>('[data-slot="empty-state"]')!
  expect(empty.parentElement).toBe(frame)
  expect(frame.querySelectorAll(':scope > [data-slot="chart-card"]')).toHaveLength(1)
})
