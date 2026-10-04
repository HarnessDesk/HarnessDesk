import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { runTimeline } from '../lib/run-timeline'
import { overviewRun } from '../preview/team-overview-fixture'
import { RunView } from './RunView'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

it('selects a stable row id and sanitizes the brief and in-flight words', () => {
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  const onSelect = vi.fn()
  const execution = { ...overviewRun(), operations: [{ key: 'seat-1', kind: 'seat' as const, state: 'finished' as const, card: 1, seat: 'seat-0' }], brief: '<script>secret</script>Retry <b>the call</b>' }
  const model = runTimeline({ execution, cards: [{ id: 1, title: 'Build', state: 'claimed', files: [], dependsOn: [], createdAt: 1, updatedAt: 1 }] })
  try {
    act(() => root.render(<RunView model={model} number={1} selectedRow={null} onSelect={onSelect} doing={new Map([['seat-0', 'Editing src/retry.ts']])} />))
    expect(container.textContent).toContain('Run 1')
    expect(container.textContent).toContain('Retry the call')
    expect(container.textContent).not.toContain('secret')
    expect(container.textContent).toContain('Editing src/retry.ts')
    act(() => (container.querySelector('[data-row="card-1-1"]') as HTMLButtonElement).click())
    expect(onSelect).toHaveBeenCalledWith('card-1-1')
  } finally { act(() => root.unmount()); container.remove() }
})

it('shows the empty timeline when the Run has a brief but no rounds yet', () => {
  const container = document.createElement('div')
  const root = createRoot(container)
  const model = runTimeline({ execution: { ...overviewRun(), brief: 'Retry the call', rounds: [] }, cards: [] })
  try {
    act(() => root.render(<RunView model={model} number={1} selectedRow={null} onSelect={() => {}} />))
    expect(container.textContent).toContain('No rounds have opened yet')
  } finally { act(() => root.unmount()) }
})

it('reads Start with the existing short clock, without seconds or a raw locale date', () => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date(2026, 9, 3, 12, 45))
  const container = document.createElement('div')
  const root = createRoot(container)
  const model = runTimeline({ execution: { ...overviewRun(), startedAt: new Date(2026, 9, 3, 12, 34, 56).getTime() }, cards: [] })
  try {
    act(() => root.render(<RunView model={model} number={1} selectedRow={null} onSelect={() => {}} />))
    const start = container.querySelector('[data-kind="start"]')!.textContent
    expect(start).toContain('12:34')
    expect(start).not.toContain('12:34:56')
    expect(start).not.toContain('/2026')
  } finally { act(() => root.unmount()); vi.useRealTimers() }
})

const withFlow = (props: Partial<Parameters<typeof RunView>[0]> = {}) => {
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  const model = runTimeline({ execution: { ...overviewRun(), brief: 'Retry the call' }, cards: [{ id: 1, title: 'Build', state: 'claimed', files: [], dependsOn: [], createdAt: 1, updatedAt: 1 }] })
  act(() => root.render(<RunView model={model} number={1} selectedRow={null} onSelect={() => {}} flow={<p data-testid="the-flow">The drawing</p>} {...props} />))
  return { container, done: () => { act(() => root.unmount()); container.remove() } }
}

it.each(['running', 'stopped', 'settled', 'stalled'] as const)('offers Stop run… in the header only when the Run is running (%s)', state => {
  const onStop = vi.fn()
  const { container, done } = withFlow({ model: runTimeline({ execution: overviewRun(state), cards: [] }), onStop })
  try {
    const stop = [...container.querySelectorAll<HTMLButtonElement>('[data-slot="run-header"] button')].find(one => one.textContent === 'Stop run…')
    if (state === 'running') { expect(stop).toBeDefined(); act(() => stop!.click()); expect(onStop).toHaveBeenCalledOnce() }
    else expect(stop).toBeUndefined()
  } finally { done() }
})
const choice = (container: HTMLElement, name: string): HTMLButtonElement =>
  [...container.querySelectorAll<HTMLButtonElement>('[role="radiogroup"][aria-label="Show the Run as"] [role="radio"]')].find(one => one.textContent === name)!

it('has no switch when there is no Flow to show', () => {
  const { container, done } = withFlow({ flow: undefined })
  try {
    expect(container.querySelector('[role="radiogroup"]')).toBeNull()
    expect(container.querySelector('[aria-label="Run timeline"]')).not.toBeNull()
  } finally { done() }
})

it('opens on the timeline, with the Flow one choice away in the header', () => {
  const { container, done } = withFlow()
  try {
    const header = container.querySelector('[data-slot="run-header"]')!
    expect([...header.querySelectorAll('[role="radio"]')].map(one => one.textContent)).toEqual(['Timeline', 'Flow'])
    expect(choice(container, 'Timeline').getAttribute('aria-checked')).toBe('true')
    expect(container.querySelector('[aria-label="Run timeline"]')).not.toBeNull()
    expect(container.querySelector('[data-testid="the-flow"]')).toBeNull()
  } finally { done() }
})

it('swaps the timeline for the Flow, keeps the header, and swaps back', () => {
  const { container, done } = withFlow()
  try {
    act(() => choice(container, 'Flow').click())
    expect(container.querySelector('[data-testid="the-flow"]')).not.toBeNull()
    expect(container.querySelector('[aria-label="Run timeline"]')).toBeNull()
    expect(container.querySelector('[data-slot="run-header"]')!.textContent).toContain('Run 1')
    act(() => choice(container, 'Timeline').click())
    expect(container.querySelector('[data-testid="the-flow"]')).toBeNull()
    expect(container.querySelector('[aria-label="Run timeline"]')).not.toBeNull()
  } finally { done() }
})

it('answers to a caller that chooses the view, and says what was chosen', () => {
  const onView = vi.fn()
  const { container, done } = withFlow({ view: 'flow', onView })
  try {
    expect(container.querySelector('[data-testid="the-flow"]')).not.toBeNull()
    expect(choice(container, 'Flow').getAttribute('aria-checked')).toBe('true')
    act(() => choice(container, 'Timeline').click())
    expect(onView).toHaveBeenCalledWith('timeline')
    expect(container.querySelector('[data-testid="the-flow"]')).not.toBeNull()
  } finally { done() }
})
