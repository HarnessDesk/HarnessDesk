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
