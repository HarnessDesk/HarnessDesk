import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { HeatGrid, type HeatGridCell, type HeatGridRow } from './HeatGrid'

/**
 * The behaviour a screenshot cannot check: the grid is one tab stop, arrow
 * keys walk a 2D cursor rather than the browser's own Tab order, and Escape
 * is swallowed only when there is a cursor to put away — the same bug a
 * chart's Escape once had, closing the whole Dashboard along with itself
 * (`chart.test.tsx` guards the same rule for `DayColumns`).
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

const grid = (): HTMLElement => container.querySelector('[role="group"]') as HTMLElement
const tip = (): HTMLElement | null => container.querySelector('[data-slot="chart-tip"]')

const press = (key: string, target: EventTarget = grid()): void => {
  act(() => {
    target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
  })
}

/** One long row, so a horizontal walk has somewhere to go. */
const cell = (day: number): HeatGridCell => ({
  key: String(day),
  level: (day % 5) as HeatGridCell['level'],
  state: 'filled',
  ariaLabel: `Day ${day}`,
  tooltip: { title: `tip for day ${day}` },
})

const longRow = (length: number): readonly HeatGridRow[] => [
  { key: 'row', cells: Array.from({ length }, (_, index) => cell(index)) },
]

describe('HeatGrid keyboard navigation', () => {
  it('walks 12 ArrowRight presses onto the 12th cell, using functional state', () => {
    mount(<HeatGrid label="Test grid" rows={longRow(20)} columns={20} />)
    for (let index = 0; index < 12; index += 1) press('ArrowRight')
    const active = container.querySelector('[data-active]') as HTMLElement
    expect(active).not.toBeNull()
    // 12 presses from no cursor: the first press enters the grid at column 0,
    // and the next 11 each move one further — landing on the 12th cell.
    const cells = [...container.querySelectorAll('[data-level], [data-state]')]
    expect(cells.indexOf(active)).toBe(11)
  })

  it('shows the active cell’s tooltip content', () => {
    mount(<HeatGrid label="Test grid" rows={longRow(5)} columns={5} />)
    expect(tip()).toBeNull()
    press('ArrowRight')
    expect(tip()?.textContent).toContain('tip for day 0')
    press('ArrowRight')
    expect(tip()?.textContent).toContain('tip for day 1')
  })

  it('swallows Escape only when a cursor is active, and lets it through otherwise', () => {
    // A document-level Escape listener stands in for the Dashboard window
    // that used to close on this same key (#206-style bug).
    mount(<HeatGrid label="Test grid" rows={longRow(5)} columns={5} />)
    const heard: string[] = []
    const onDocumentKey = (event: Event): void => void heard.push((event as KeyboardEvent).key)
    document.addEventListener('keydown', onDocumentKey)
    try {
      // No cursor yet: Escape is the screen's to answer.
      press('Escape')
      expect(heard).toEqual(['Escape'])
      heard.length = 0

      // With a cursor active, Escape is swallowed before it reaches the document.
      press('ArrowRight')
      press('Escape')
      expect(heard).toEqual(['ArrowRight'])
      expect(container.querySelector('[data-active]')).toBeNull()
    } finally {
      document.removeEventListener('keydown', onDocumentKey)
    }
  })

  it('moves by row on ArrowDown/ArrowUp and by column on ArrowLeft/ArrowRight', () => {
    const rows: readonly HeatGridRow[] = [
      { key: 'a', cells: [cell(0), cell(1)] },
      { key: 'b', cells: [cell(10), cell(11)] },
    ]
    mount(<HeatGrid label="Test grid" rows={rows} columns={2} />)
    press('ArrowRight') // enters at (0,0)
    press('ArrowDown') // (1,0)
    expect(tip()?.textContent).toContain('tip for day 10')
    press('ArrowRight') // (1,1)
    expect(tip()?.textContent).toContain('tip for day 11')
    press('ArrowUp') // (0,1)
    expect(tip()?.textContent).toContain('tip for day 1')
  })
})
