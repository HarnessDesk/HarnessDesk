import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import type { LeadMemory, LeadSchedule } from '@harnessdesk/protocol'
import { LeadMemorySettings, LeadScheduleSettings, leadCitedLines } from './LeadPlanSettings'

const clean: (() => void)[] = []
afterEach(() => clean.splice(0).forEach(fn => fn()))
const mount = (node: React.ReactNode) => {
  const box = document.createElement('div'); document.body.append(box)
  const root = createRoot(box)
  act(() => root.render(node))
  clean.push(() => { act(() => root.unmount()); box.remove() })
  return box
}
const button = (box: HTMLElement, label: string) => [...box.querySelectorAll('button')].find(one => one.textContent === label)!

const schedule: LeadSchedule = { version: 1, quiet: null, tasks: [{ id: 'task-1', title: 'Morning tidy', goal: 'Close stale branches', every: 'weekdays', at: '09:00', enabled: true, lastRunAt: null }] }
const memory: LeadMemory = { version: 1, items: [
  { id: 'm-1', text: 'Prefer small pull requests', state: 'kept', at: 1 },
  { id: 'm-2', text: 'Run the linter before review', state: 'suggested', at: 2 }] }

it('lists a task with when it runs, and removes it whole', () => {
  const save = vi.fn(), box = mount(<LeadScheduleSettings label="Dex" schedule={schedule} pending={false} save={save} />)
  expect(box.textContent).toContain('Morning tidy')
  expect(box.textContent).toContain('Weekdays · 09:00')
  act(() => button(box, 'Remove').click())
  expect(save).toHaveBeenCalledWith({ version: 1, quiet: null, tasks: [] })
})

it('keeps or discards a suggested line, and marks a line the open plan follows', () => {
  const save = vi.fn(), box = mount(<LeadMemorySettings label="Dex" memory={memory} cited={new Set([1])} pending={false} save={save} />)
  expect(box.textContent).toContain('Used in this plan')
  expect(box.textContent).toContain('Suggested')
  act(() => button(box, 'Keep').click())
  expect(save.mock.calls[0]![0].items[1]).toMatchObject({ id: 'm-2', state: 'kept' })
  act(() => button(box, 'Discard').click())
  expect(save.mock.calls[1]![0].items.map((item: { id: string }) => item.id)).toEqual(['m-1'])
})

it('reads the lines a plan cites from its step titles', () => {
  expect([...leadCitedLines([{ type: 'plan', title: 'Add the export (m2)' } as never])]).toEqual([2])
  expect(leadCitedLines([{ type: 'result', title: '(m1)' } as never]).size).toBe(0)
})
