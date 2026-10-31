import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import type { LeadMemory, LeadSchedule } from '@harnessdesk/protocol'
import { LeadMemorySettings, LeadScheduleSettings, leadCitedLines } from './LeadPlanSettings'
import { leadContract } from '../preview/lead-fixture'
import { createLeadFixtureStore } from '../preview/frames-lead'
import { StoreProvider } from '../state/context'
import { LeadPlanSettingsSection } from './LeadPlanSettings'

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

it('shows approved repeat runs and uses person controls without rewriting their contract', () => {
  const control = vi.fn(), contract = { ...leadContract, repeat: { every: 'mondays' as const, at: '09:00' } }
  const repeating: LeadSchedule = { version: 1, quiet: null, tasks: [{ ...schedule.tasks[0]!, every: 'mondays', approved: { contract, contractDigest: contract.digest }, perRunCaps: contract.caps,
    runs: [{ slot: 1, at: 1, state: 'started', logicalGoalId: 'goal-one', outcome: 'accepted', usdMicros: 1200000, rounds: 2 }, { slot: 2, at: 2, state: 'skipped', reason: 'The last run waits for you.' }] }] }
  const box = mount(<LeadScheduleSettings label="Dex" schedule={repeating} pending={false} save={vi.fn()} control={control} canRunNow />)
  expect(box.textContent).toContain('Approved once')
  act(() => button(box, 'Runs').click())
  expect(box.textContent).toContain('Accepted')
  expect(box.textContent).toContain('$1.20 · 2 rounds')
  expect(box.textContent).toContain('The last run waits for you.')
  expect(box.textContent).toContain('Next run:')
  expect(box.textContent).not.toContain('The Lead has work open.')
  act(() => button(box, 'Pause').click())
  expect(control).toHaveBeenCalledWith('task-1', 'pause')
  act(() => button(box, 'Run once now').click())
  expect(control).toHaveBeenCalledWith('task-1', 'run-now')
  act(() => button(box, 'Stop').click())
  expect(control).toHaveBeenCalledWith('task-1', 'stop')
})

it('resumes a paused repeat and disables an immediate run while the Lead is busy', () => {
  const control = vi.fn(), task = { ...schedule.tasks[0]!, paused: true, runs: [] }
  const box = mount(<LeadScheduleSettings label="Dex" schedule={{ ...schedule, tasks: [task] }} pending={false} save={vi.fn()} control={control} canRunNow={false} />)
  act(() => button(box, 'Runs').click())
  expect(button(box, 'Run once now').disabled).toBe(true)
  expect(button(box, 'Run once now').title).toBe('The Lead has work open.')
  expect(box.querySelector('[data-repeat-runs]')?.textContent).toContain('The Lead has work open.')
  expect(box.textContent).toContain('Runs are skipped until you resume.')
  act(() => button(box, 'Resume').click())
  expect(control).toHaveBeenCalledWith('task-1', 'resume')
})

it('uses short dates without seconds and adds a year only for runs outside the current year', () => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date(2026, 9, 30, 12))
  try {
    const task = { ...schedule.tasks[0]!, every: 'mondays' as const, runs: [
      { slot: new Date(2026, 9, 26, 9).getTime(), at: 1, state: 'started' as const },
      { slot: new Date(2025, 9, 27, 9).getTime(), at: 2, state: 'started' as const }
    ] }
    const box = mount(<LeadScheduleSettings label="Dex" schedule={{ ...schedule, tasks: [task] }} pending={false} save={vi.fn()} control={vi.fn()} canRunNow />)
    act(() => button(box, 'Runs').click())
    expect(box.textContent).toContain('Next run: Mon, Nov 2, 9:00 AM')
    expect(box.textContent).toContain('Mon, Oct 26, 9:00 AM')
    expect(box.textContent).toContain('Mon, Oct 27, 2025, 9:00 AM')
    expect(box.textContent).not.toContain('2026')
    expect(box.textContent).not.toContain('9:00:00')
  } finally { vi.useRealTimers() }
})

it('refreshes an open Runs view when a skipped slot changes only the schedule', async () => {
  vi.useFakeTimers()
  const store = createLeadFixtureStore('settings-runs')
  let current = schedule
  vi.spyOn(store.lead, 'readSchedule').mockImplementation(async () => current)
  const box = document.createElement('div'), root = createRoot(box); document.body.append(box)
  try {
    await act(async () => root.render(<StoreProvider store={store}><LeadPlanSettingsSection label="Dex" focus="repeat:task-1" /></StoreProvider>))
    expect(box.textContent).toContain('No runs yet')
    current = { ...schedule, tasks: [{ ...schedule.tasks[0]!, runs: [{ slot: 1, at: 1, state: 'skipped', reason: 'The last run waits for you.' }] }] }
    await act(async () => vi.advanceTimersByTimeAsync(30000))
    expect(box.textContent).toContain('The last run waits for you.')
  } finally { act(() => root.unmount()); box.remove(); vi.useRealTimers() }
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

it('offers project seeds without acting, then persists an accept or a dismissal in the schedule', () => {
  const save = vi.fn(), empty: LeadSchedule = { version: 1, quiet: { from: '22:00', to: '07:00' }, tasks: [] }
  const projects = [{ path: '/workspace/widgets', name: 'Widgets' }, { path: '/workspace/docs', name: 'Docs' }]
  const box = mount(<LeadScheduleSettings label="Dex" schedule={empty} projects={projects} pending={false} save={save} />)
  expect(box.textContent).toContain('Check CI on Widgets')
  expect(save).not.toHaveBeenCalled()
  act(() => button(box, 'Accept').click())
  const accepted = save.mock.calls[0]![0]
  expect(accepted.tasks).toHaveLength(1)
  expect(accepted.tasks[0]).toMatchObject({ project: '/workspace/widgets', every: 'weekdays', at: '09:00', enabled: true, lastRunAt: null })
  expect(accepted.quiet).toEqual(empty.quiet)
  expect(accepted.seedChoices).toContain('ci:/workspace/widgets')
  act(() => button(box, 'Dismiss').click())
  expect(save.mock.calls[1]![0]).toMatchObject({ tasks: [], seedChoices: ['ci:/workspace/widgets'] })
  const reopened = mount(<LeadScheduleSettings label="Dex" schedule={accepted} projects={projects} pending={false} save={save} />)
  expect(reopened.querySelectorAll('[data-lead-seed]')).toHaveLength(1)
  expect(reopened.querySelector('[data-lead-seed]')?.textContent).toContain('Docs')
})
