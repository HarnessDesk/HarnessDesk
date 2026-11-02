import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it } from 'vitest'
import type { LeadWindowProjection } from '@harnessdesk/protocol'
import { AppStore } from '../state/store'
import { StoreProvider } from '../state/context'
import { previewStore } from '../preview/harness'
import { leadBudget, leadContract, leadPlan, leadProjection } from '../preview/lead-fixture'
import { LeadDetails } from './LeadDetails'

const clean: (() => void)[] = []
afterEach(() => { clean.splice(0).forEach(fn => fn()) })
const mount = async (projection: LeadWindowProjection) => {
  const store = new AppStore('ws://localhost:0/'), box = document.createElement('div'); document.body.append(box)
  Object.assign(store.getSnapshot(), previewStore({ leadAvailable: true }).getSnapshot())
  store.lead.changed({ method: 'lead/changed', params: projection })
  const root = createRoot(box)
  await act(async () => root.render(<StoreProvider store={store}><LeadDetails /></StoreProvider>))
  clean.push(() => { act(() => root.unmount()); box.remove() })
  return box
}
const section = (box: HTMLElement, label: string) => box.querySelector<HTMLElement>(`section[aria-label="${label}"]`)

it('shows only the allowance before there is a goal', async () => {
  const box = await mount(leadProjection())
  expect([...box.querySelectorAll('section[data-slot="tool-section"]')].map(one => one.getAttribute('aria-label'))).toEqual(['Spend'])
  expect(section(box, 'Spend')!.textContent).toContain('Up to $5.00')
  expect(section(box, 'Spend')!.textContent).toContain('4 rounds')
  expect(box.querySelector('[aria-label="Change limits"]')).not.toBeNull()
})

it('reads a plan that waits for the person back from the conversation', async () => {
  const box = await mount(leadProjection({ thread: { ...leadProjection().thread!, state: 'awaiting-plan', cards: [leadPlan] } }))
  expect(section(box, 'Goal')!.textContent).toContain(leadContract.goal)
  expect(section(box, 'Plan')!.textContent).toContain('Waiting for you')
  expect(section(box, 'Plan')!.querySelectorAll('[data-state="active"]')).toHaveLength(0)
  expect([...section(box, 'Workers')!.querySelectorAll('[data-slot="list-row"]')].map(row => row.textContent)).toEqual(['Write', 'Review'])
  expect(section(box, 'Workers')!.textContent).not.toContain('builder')
})

it('marks the running step and counts what the goal has spent against its cap', async () => {
  const box = await mount(leadProjection({
    thread: { ...leadProjection().thread!, state: 'running', contract: leadContract, budget: leadBudget },
    progress: { step: 1, steps: 1, runs: 1 },
  }))
  expect(section(box, 'Plan')!.textContent).toContain('Step 1 of 1')
  expect(section(box, 'Spend')!.textContent).toContain('$0.26 of $5.00')
  expect(section(box, 'Spend')!.textContent).toContain('1 of 4')
})

const twoSteps = { ...leadContract, steps: [leadContract.steps[0]!, { ...leadContract.steps[0]!, id: 'check', title: 'Check the result', assignments: [leadContract.steps[0]!.assignments[1]!] }] }
it('marks the steps before the running one done and seats only the running step', async () => {
  const box = await mount(leadProjection({ thread: { ...leadProjection().thread!, state: 'running', contract: twoSteps }, progress: { step: 2, steps: 2, runs: 2 } }))
  expect([...section(box, 'Plan')!.querySelectorAll('[data-state]')].map(item => item.getAttribute('data-state'))).toEqual(['done', 'active'])
  expect([...section(box, 'Workers')!.querySelectorAll('[data-slot="list-row"]')].map(row => row.textContent)).toEqual(['Review'])
})

it('does not guess the step while the goal waits on the person', async () => {
  const box = await mount(leadProjection({ thread: { ...leadProjection().thread!, state: 'waiting-for-user', contract: twoSteps } }))
  expect(section(box, 'Plan')!.textContent).toContain('Needs you')
  expect(section(box, 'Plan')!.querySelectorAll('[data-state="done"], [data-state="active"]')).toHaveLength(0)
  expect(section(box, 'Workers')).toBeNull()
})

it('reads the latest plan card when the Lead revises its plan before approval', async () => {
  const revised = { ...leadPlan, id: 'plan-2', contract: { ...twoSteps, goal: 'Make the empty state keyboard accessible, then check it' } }
  const box = await mount(leadProjection({ thread: { ...leadProjection().thread!, state: 'awaiting-plan', cards: [leadPlan, revised] } }))
  expect(section(box, 'Goal')!.textContent).toContain('then check it')
  expect([...section(box, 'Plan')!.querySelectorAll('[data-state]')]).toHaveLength(2)
})

it('does not claim a total while worker spend is unconfirmed', async () => {
  const box = await mount(leadProjection({ thread: { ...leadProjection().thread!, state: 'running', contract: leadContract, budget: { ...leadBudget, spend: 'stale' } } }))
  expect(section(box, 'Spend')!.textContent).toContain('Not confirmed')
  expect(section(box, 'Spend')!.querySelector('[aria-label="Spent"]')).toBeNull()
})
