import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import type { TriggerGoalStatus } from '@harnessdesk/protocol'

import { sceneGoalStatus, sceneWait } from '../preview/intake-fixture'
import { StoreProvider } from '../state/context'
import { emptySnapshot, type AppSnapshot, type AppStore } from '../state/store'
import { GoalIntake } from './GoalIntake'

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

const GOAL = 'goal-pr-12'

const mount = async (status: TriggerGoalStatus | null, storeRoot = '/home/dev/work/storefront') => {
  const snapshot = {
    ...emptySnapshot(),
    goals: new Map([[GOAL, { goal: { id: GOAL, root: storeRoot } } as never]]),
  } as unknown as AppSnapshot
  const store = {
    subscribe: () => () => {},
    getSnapshot: () => snapshot,
    triggerGoal: vi.fn(async () => status),
    askSettings: vi.fn(),
  } as unknown as AppStore
  await act(async () => {
    root.render(
      <StoreProvider store={store}>
        <GoalIntake goal={GOAL} />
      </StoreProvider>,
    )
  })
  return store
}

it('an ordinary Goal asks once and draws nothing at all', async () => {
  const store = await mount(null)
  expect(store.triggerGoal).toHaveBeenCalledWith(GOAL)
  expect(container.innerHTML).toBe('')
})

it('names the exact source for a pull request, an issue and a schedule, honestly', async () => {
  await mount(sceneGoalStatus('pull-request'))
  expect(container.textContent).toContain('Opened from PR #12')

  await mount(sceneGoalStatus('issue'))
  expect(container.textContent).toContain('Opened from issue #7')

  await mount(sceneGoalStatus('schedule'))
  expect(container.textContent).toContain('Opened from a schedule')
})

it('every named stop reason appears verbatim, alongside the partial work it kept', async () => {
  await mount(sceneGoalStatus('stopped'))
  expect(container.textContent).toContain('Out of budget.')
  expect(container.textContent).toContain('The daily cap was reached before this round closed.')
})

it('a held message, a held action, a question and a person step each show Needs you with an owner and a working navigation', async () => {
  const store = await mount(sceneGoalStatus('held-message'))
  const messageRow = [...container.querySelectorAll('button')].find((one) => one.textContent?.includes('held for your review'))
  expect(messageRow).toBeUndefined() // open-goal waits have nowhere further to go from here.
  expect(container.textContent).toContain('Needs you')
  expect(container.textContent).toContain('you')

  await mount(sceneGoalStatus('held-action'))
  expect(container.textContent).toContain('An action is held for your approval.')

  await mount(sceneGoalStatus('question'))
  expect(container.textContent).toContain('nobody answered in time')

  await mount(sceneGoalStatus('person-step'))
  expect(container.textContent).toContain('a person to take the next card')

  const budget = await mount(sceneGoalStatus('stopped'))
  const budgetRow = [...container.querySelectorAll('button')].find((one) => one.textContent?.includes('out of budget'))
  await act(async () => budgetRow?.click())
  expect(budget.askSettings).toHaveBeenCalledWith('workspaces', 'triggers')
})

it('a member wait names who it is waiting on, and a source failure opens this project’s Triggers', async () => {
  await mount(sceneGoalStatus('pull-request'), '/home/dev/work/storefront')
  const store = await mount({
    ...sceneGoalStatus('pull-request'),
    waits: [sceneWait('source')],
  }, '/home/dev/work/storefront')
  const row = [...container.querySelectorAll('button')].find((one) => one.textContent?.includes('could not be read'))
  await act(async () => row?.click())
  expect(store.askSettings).toHaveBeenCalledWith('workspaces', '/home/dev/work/storefront')
})

it('a held-ceiling approval opens Permissions › Ceilings', async () => {
  const store = await mount({
    ...sceneGoalStatus('pull-request'),
    waits: [{
      id: 'wait-approval', goal: GOAL, trigger: 'review-pr', kind: 'approval',
      waitingOn: { kind: 'person', label: 'you' }, sentence: 'A seat is waiting for a held ceiling decision.',
      action: 'open-permissions', createdAt: 1, resolvedAt: null, notification: 'delivered',
    }],
  })
  const row = [...container.querySelectorAll('button')].find((one) => one.textContent?.includes('held ceiling decision'))
  await act(async () => row?.click())
  expect(store.askSettings).toHaveBeenCalledWith('permissions', 'ceilings')
})
