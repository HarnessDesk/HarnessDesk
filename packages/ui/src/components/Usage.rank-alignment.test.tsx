import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { runtimeId, type LedgerReport } from '@harnessdesk/protocol'

import { Ranked } from './Usage'
import styles from './Usage.module.css'

/**
 * "Where it went"'s change chip is by-agent only, and only real for an agent
 * the previous period actually saw — an agent with nothing recorded before
 * gets no chip. Both shapes have to emit the same six grid cells, or the row
 * without a chip slides its share, tokens and amount one column left (review
 * #1011, B3) — confirmed in `after-where-it-went-light.png`.
 */

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

const mount = (node: ReactNode): void => {
  act(() => root.render(node))
}

const DAY = 86_400_000
const NOW = new Date('2026-09-10T12:00:00').getTime()
const localMidnight = (back: number): number => {
  const date = new Date(NOW)
  date.setHours(0, 0, 0, 0)
  date.setDate(date.getDate() - back)
  return date.getTime()
}

const ALPHA = runtimeId('claude')
const BETA = runtimeId('codex')

describe('Ranked row alignment', () => {
  it('emits the same number of grid cells whether or not a row has a change chip', () => {
    const ledger: LedgerReport = {
      days: 3,
      currency: 'USD',
      totalCost: 70,
      totalTokens: 700,
      provenance: 'listPrice',
      coverage: {
        priced: 2,
        unpriced: 0,
        unmetered: 0,
        estimated: 0,
        daysCovered: 3,
        daysRequested: 3,
        earliestDay: localMidnight(5),
      },
      rows: [
        { key: ALPHA, label: 'Alpha', runtime: ALPHA, tokens: 500, cost: 50, hasUnpriced: false },
        { key: BETA, label: 'Beta', runtime: BETA, tokens: 200, cost: 20, hasUnpriced: false },
      ],
      daily: [],
      scannedAt: NOW,
    }
    const wideLedger: LedgerReport = {
      ...ledger,
      days: 6,
      daily: [
        // The older half: only Alpha spent anything, so Beta's previous
        // total is an honest zero — still no chip, under rankedChange's
        // "a rise from nothing has no percentage" rule — rather than the
        // period being incomplete.
        { day: localMidnight(5), runtime: ALPHA, cost: 10, tokens: 100 },
        { day: localMidnight(4), runtime: ALPHA, cost: 10, tokens: 100 },
        { day: localMidnight(3), runtime: ALPHA, cost: 10, tokens: 100 },
        // The current half: both agents.
        { day: localMidnight(2), runtime: ALPHA, cost: 20, tokens: 200 },
        { day: localMidnight(1), runtime: BETA, cost: 20, tokens: 200 },
      ],
    }

    mount(
      <Ranked
        ledger={ledger}
        wideLedger={wideLedger}
        pivot="runtime"
        range={3}
        now={NOW}
        byId={new Map()}
        tintOf={() => 'blue'}
      />,
    )

    const rows = [...container.querySelectorAll(`.${styles.rank}`)]
    expect(rows).toHaveLength(2)
    // Alpha has a real previous total and gets a chip; Beta's previous total
    // is zero and gets none — but the row itself still emits every cell.
    expect(rows[0]?.textContent).toContain('Alpha')
    expect(rows[0]?.children).toHaveLength(6)
    expect(rows[1]?.textContent).toContain('Beta')
    expect(rows[1]?.children).toHaveLength(6)
  })

  it('reserves no chip column at all on the model or project pivots', () => {
    const ledger: LedgerReport = {
      days: 3,
      currency: 'USD',
      totalCost: 70,
      totalTokens: 700,
      provenance: 'listPrice',
      coverage: {
        priced: 2,
        unpriced: 0,
        unmetered: 0,
        estimated: 0,
        daysCovered: 3,
        daysRequested: 3,
        earliestDay: localMidnight(5),
      },
      rows: [{ key: 'gpt-5.6-sol', label: 'gpt-5.6-sol', runtime: ALPHA, tokens: 500, cost: 50, hasUnpriced: false }],
      daily: [],
      scannedAt: NOW,
    }

    mount(
      <Ranked
        ledger={ledger}
        wideLedger={null}
        pivot="model"
        range={3}
        now={NOW}
        byId={new Map()}
        tintOf={() => 'blue'}
      />,
    )

    const row = container.querySelector(`.${styles.rank}`)
    // No `previousByRuntime` on this pivot, so no chip is ever computed —
    // the row draws five cells, and the grid it sits in is keyed on the
    // pivot so that fifth column never reserves a dead 72px track.
    expect(row?.children).toHaveLength(5)
    expect(row?.getAttribute('data-pivot')).toBe('model')
  })
})
