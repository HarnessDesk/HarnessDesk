import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { FlowStepRow } from './FlowStepRow'
import { flowModel } from '../../lib/flow-model'
import { runFixture } from '../../preview/run-view-fixture'
import type { FlowStepRun } from '../../lib/flow-overlay'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const model = flowModel(runFixture().execution.document.flow)
const run: FlowStepRun = { state: 'done', runs: 2, durationMs: 840_000, since: null, line: 'published', seats: ['seat-0'] }
it('keeps kind, outcome, face tint and trailing recorded facts together in a selectable row', () => {
  const container = document.createElement('div')
  const root = createRoot(container)
  const select = vi.fn()
  try {
    act(() => root.render(<FlowStepRow step={model.steps[0]!} run={run} subtitle="Round 1" selected onSelect={select}
      faces={new Map([['seat-0', <span>Runtime face</span>]])} faceTints={new Map([['seat-0', 'teal']])} />))
    expect(container.querySelector('[data-slot="icon-tile"]')?.getAttribute('data-tint')).toBe('teal')
    expect(container.textContent).toContain('Runtime face')
    expect(container.querySelector('[data-slot="chip"][data-tint="violet"]')?.textContent).toBe('Agent')
    expect(container.querySelector('[data-slot="chip"][data-tone="success"]')?.textContent).toBe('Published')
    expect(container.querySelector('[data-slot="list-row-subtitle"]')?.textContent).toBe('Round 1')
    expect(container.querySelector('[data-slot="list-row-trail"]')?.textContent).toContain('14m · 2 runs')
    expect(container.querySelector('button')?.getAttribute('aria-current')).toBe('true')
    act(() => container.querySelector('button')!.click())
    expect(select).toHaveBeenCalledWith('writer')
  } finally { act(() => root.unmount()) }
})
it('keeps unavailable check time and counts unknown, and a future step quiet', () => {
  const container = document.createElement('div')
  const root = createRoot(container)
  try {
    act(() => root.render(<FlowStepRow step={model.steps[1]!} run={{ ...run, runs: null, durationMs: null, seats: [], line: 'pass' }} />))
    expect(container.querySelector('[data-slot="icon-tile"]')?.getAttribute('data-tint')).toBe('sky')
    expect(container.querySelector('[title="Time not recorded"]')).not.toBeNull()
    expect(container.querySelector('[title="Run count unavailable"]')).not.toBeNull()
    act(() => root.render(<FlowStepRow step={model.steps[3]!} run={{ ...run, state: 'future', runs: 0, seats: [] }} />))
    expect(container.querySelector('[data-slot="chip"][data-tone="neutral"]')?.textContent).toBe('Not reached')
    expect(container.querySelector('[data-slot="list-row-trail"]')?.textContent).not.toContain('runs')
  } finally { act(() => root.unmount()) }
})
it('advances waiting time and keeps terminal durations fixed', () => {
  const container = document.createElement('div')
  const root = createRoot(container)
  try {
    act(() => root.render(<FlowStepRow step={model.steps[3]!} run={{ ...run, state: 'waiting', durationMs: 0, since: 1000 }} now={61_000} />))
    expect(container.querySelector('[data-slot="list-row-trail"]')?.textContent).toContain('1m')
    expect(container.querySelector('[data-slot="chip"][data-tone="warning"]')?.textContent).toBe('Needs you')
    act(() => root.render(<FlowStepRow step={model.steps[0]!} run={{ ...run, state: 'stopped', since: 1000 }} now={1_000_000} />))
    expect(container.querySelector('[data-slot="list-row-trail"]')?.textContent).toContain('14m')
    expect(container.textContent).not.toContain('Published')
  } finally { act(() => root.unmount()) }
})
