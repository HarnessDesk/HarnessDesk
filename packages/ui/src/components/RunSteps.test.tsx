import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { RunSteps } from './RunSteps'
import { runFixture } from '../preview/run-view-fixture'
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
it('keeps repeated rounds, future steps, their states and selection in shared step rows', () => {
  const fixture = runFixture()
  const container = document.createElement('div')
  const root = createRoot(container)
  const select = vi.fn()
  const future = vi.fn()
  try {
    act(() => root.render(<RunSteps input={fixture} selectedRow={null} onSelect={select} onSelectStep={future} />))
    expect(container.querySelectorAll('[data-step-row]')).toHaveLength(5)
    expect(container.textContent).toContain('Taken')
    expect(container.textContent).toContain('Not reached')
    expect(container.textContent).toContain('Round 4')
    expect(container.querySelector('[data-selected]')?.textContent).toContain('Round 4')
    const buttons = [...container.querySelectorAll('button')]
    act(() => buttons[0]!.click())
    expect(select).toHaveBeenCalledWith('round-1')
    act(() => buttons.at(-1)!.click())
    expect(future).toHaveBeenCalledWith('person')
    expect(container.querySelector('[data-slot="inspector-footer"]')?.textContent).toContain('lights its node on Flow')
  } finally { act(() => root.unmount()) }
})
it('uses kind tiles and chips, toned outcomes, and trailing time and counts while Round stays the second line', () => {
  const container = document.createElement('div')
  const root = createRoot(container)
  try {
    act(() => root.render(<RunSteps input={runFixture('attempts')} selectedRow={null} onSelect={() => {}} />))
    const rows = [...container.querySelectorAll('[data-step-row]')]
    expect(rows).toHaveLength(5)
    const chips = (row: Element) => [...row.querySelectorAll('[data-slot="chip"]')].map(chip => [chip.textContent, chip.getAttribute('data-tone')])
    expect(chips(rows[0]!)).toContainEqual(['Published', 'success'])
    expect(chips(rows[1]!)).toContainEqual(['Pass', 'success'])
    expect(chips(rows[2]!)).toContainEqual(['Request changes', 'warning'])
    expect(chips(rows[3]!)).toContainEqual(['Working', 'info'])
    expect(chips(rows[4]!)).toContainEqual(['Not reached', 'neutral'])
    expect(rows[1]!.querySelector('[data-slot="icon-tile"]')?.getAttribute('data-tint')).toBe('sky')
    expect(rows[4]!.querySelector('[data-slot="icon-tile"]')?.getAttribute('data-tint')).toBe('amber')
    expect(rows[1]!.querySelector('[data-slot="list-row-subtitle"]')?.textContent).toBe('Round 2')
    expect(rows[1]!.querySelector('[data-slot="list-row-trail"]')?.textContent).toContain('2 runs')
    expect(rows[1]!.querySelector('[data-slot="list-row-title"]')?.textContent).toContain('Check')
  } finally { act(() => root.unmount()) }
})
it('does not give a stopped step a live clock or a working chip', () => {
  const fixture = runFixture('running')
  const container = document.createElement('div')
  const root = createRoot(container)
  try {
    act(() => root.render(<RunSteps input={{ ...fixture, execution: { ...fixture.execution, state: 'stopped', currentEndedAt: fixture.execution.startedAt! + 900_000 } }} selectedRow={null} onSelect={() => {}} />))
    expect(container.textContent).toContain('Stopped')
    expect(container.textContent).not.toContain('Working')
    expect(container.textContent).not.toContain('so far')
  } finally { act(() => root.unmount()) }
})
