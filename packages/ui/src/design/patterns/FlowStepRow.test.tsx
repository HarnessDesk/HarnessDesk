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
it('reserves one activity mark column for retained faces and kind glyphs without resizing either', () => {
  const container = document.createElement('div'), root = createRoot(container)
  try {
    act(() => root.render(<>
      <FlowStepRow activity step={model.steps[0]!} run={run}
        faces={new Map([['seat-0', <svg data-retained-face="" width="13" height="13" />]])} />
      <FlowStepRow activity step={model.steps[1]!} run={{ ...run, seats: [], line: 'pass' }} />
    </>))
    const marks = [...container.querySelectorAll('[data-slot="flow-activity-mark"]')]
    expect(marks).toHaveLength(2)
    for (const mark of marks) {
      expect(mark.className).toContain('size-4')
      expect(mark.className).toContain('items-center')
      expect(mark.className).toContain('justify-center')
      expect(mark.querySelector('[data-slot="icon-tile"]')).toBeNull()
    }
    expect(marks[0]!.querySelector('svg')?.getAttribute('width')).toBe('13')
    expect(marks[1]!.querySelector('svg')?.getAttribute('width')).toBe('16')
  } finally { act(() => root.unmount()) }
})
it('keeps kind, outcome, plain runtime marks and trailing recorded facts together in a selectable row', () => {
  const container = document.createElement('div')
  const root = createRoot(container)
  const select = vi.fn()
  try {
    act(() => root.render(<FlowStepRow step={model.steps[0]!} run={run} subtitle="Round 1" selected onSelect={select}
      faces={new Map([['seat-0', <span>Runtime face</span>]])} faceTints={new Map([['seat-0', 'teal']])} />))
    expect(container.querySelector('[data-slot="icon-tile"]')).toBeNull()
    expect(container.querySelector('[data-slot="flow-row-mark"]')?.getAttribute('aria-label')).toBe('1 seat')
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
    expect(container.querySelector('[data-slot="icon-tile"]')).toBeNull()
    expect(container.querySelector('[data-slot="flow-row-mark"] .lucide-square-terminal')).not.toBeNull()
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
    expect(container.querySelector('[data-slot="chip"][data-tone="warning"]')?.textContent).toBe('Waiting for you')
    act(() => root.render(<FlowStepRow step={model.steps[0]!} run={{ ...run, state: 'stopped', since: 1000 }} now={1_000_000} />))
    expect(container.querySelector('[data-slot="list-row-trail"]')?.textContent).toContain('14m')
    expect(container.textContent).not.toContain('Published')
  } finally { act(() => root.unmount()) }
})

it('uses Waiting for you for approval waits and keeps future steps free of outcome lines', () => {
  const container = document.createElement('div')
  const root = createRoot(container)
  try {
    act(() => root.render(<FlowStepRow timeline step={model.steps[0]!} run={{ ...run, state: 'waiting' }} />))
    expect(container.textContent).toContain('Waiting for you')
    expect(container.textContent).not.toContain('Needs you')
    act(() => root.render(<FlowStepRow timeline step={{ ...model.steps[3]!, line: 'closed' }} run={{ ...run, state: 'future', line: null }} />))
    expect(container.textContent).toContain('Not reached')
    expect(container.textContent).not.toContain('closed')
  } finally { act(() => root.unmount()) }
})

it.each([
  ['working', 'info'], ['needs you', 'warning'], ['request changes', 'warning'],
  ['published', 'success'], ['pass', 'success'], ['passed', 'success'], ['done', 'success'],
  ['approve', 'success'], ['approved', 'success'], ['fail', 'danger'], ['failed', 'danger'],
  ['unknown outcome', 'neutral'],
])('gives the recorded %s outcome the %s tone', (line, tone) => {
  const container = document.createElement('div')
  const root = createRoot(container)
  try {
    act(() => root.render(<FlowStepRow step={model.steps[0]!} run={{ ...run, line }} />))
    const state = container.querySelector('[data-slot="list-row-trail"] [data-slot="chip"]')!
    expect(state.getAttribute('data-tone')).toBe(tone)
  } finally { act(() => root.unmount()) }
})

it('marks a recorded failed check as failed on the flat Timeline', () => {
  const container = document.createElement('div'), root = createRoot(container)
  try {
    act(() => root.render(<FlowStepRow timeline step={model.steps[1]!} run={{ ...run, line: 'fail' }} />))
    expect(container.querySelector('[data-slot="timeline-item"]')?.getAttribute('data-state')).toBe('danger')
    expect(container.querySelector('[data-slot="timeline-indicator"]')?.getAttribute('aria-label')).toBe('Failed')
  } finally { act(() => root.unmount()) }
})
it('qualifies advancing Timeline time and keeps a stopped duration fixed', () => {
  const container = document.createElement('div'), root = createRoot(container)
  try {
    act(() => root.render(<FlowStepRow timeline step={model.steps[0]!} run={{ ...run, state: 'working', durationMs: 0, since: 1000 }} now={61_000} />))
    expect(container.querySelector('[data-slot="run-time"]')?.textContent).toBe('1m so far')
    act(() => root.render(<FlowStepRow timeline step={model.steps[0]!} run={{ ...run, state: 'stopped', since: 1000 }} now={1_000_000} />))
    expect(container.querySelector('[data-slot="run-time"]')?.textContent).toBe('14m')
    expect(container.textContent).not.toContain('so far')
  } finally { act(() => root.unmount()) }
})

it('keeps every recorded seat mark unframed and announces the multi-seat count', () => {
  const container = document.createElement('div'), root = createRoot(container)
  try {
    act(() => root.render(<FlowStepRow step={model.steps[0]!} run={{ ...run, seats: ['one', 'two'] }}
      faces={new Map([['one', <span>First runtime</span>], ['two', <span>Second runtime</span>]])} />))
    const mark = container.querySelector('[data-slot="flow-row-mark"]')!
    expect(mark.getAttribute('aria-label')).toBe('2 seats')
    expect(mark.textContent).toContain('First runtime')
    expect(mark.textContent).toContain('Second runtime')
    expect(mark.querySelector('[data-slot="icon-tile"], [data-tint]')).toBeNull()
  } finally { act(() => root.unmount()) }
})
