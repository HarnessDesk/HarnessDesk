import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { GoalView } from '@harnessdesk/protocol'
import { StoreProvider } from '../state/context'
import { emptySnapshot, type AppSnapshot, type AppStore } from '../state/store'
import { GoalHeader } from './GoalHeader'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let container: HTMLDivElement; let root: Root
beforeEach(() => { container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container) })
afterEach(() => { act(() => root.unmount()); container.remove() })

const view = (patch: Partial<GoalView['goal']> = {}): GoalView => ({
  goal: { id: 'g1', root: '/repo', cwd: '/repo', sentence: 'Ship it', state: 'open', revision: 2, checkout: 'shared', dependsOn: ['g0'], origin: { kind: 'person' }, createdAt: 1, updatedAt: 2, receipt: null, ...patch },
  activity: 'working', waitingOn: [{ id: 'g0', sentence: 'Prepare it' }], members: [],
  board: { id: 'g1', name: 'Ship it', root: '/repo', updatedAt: 2, members: [], messaging: true, intents: [], channel: [] }, receipt: null, problem: null,
})

it('opens dependencies and disables mutations for wrapped history', () => {
  const snapshot = emptySnapshot() as AppSnapshot
  const store = { subscribe: () => () => {}, getSnapshot: () => snapshot, openGoal: vi.fn(), updateGoal: vi.fn() } as unknown as AppStore
  const onWrap = vi.fn()
  act(() => root.render(<StoreProvider store={store}><GoalHeader view={view({ state: 'wrapped' })} onWrap={onWrap} /></StoreProvider>))
  expect(document.body.textContent).toContain('Prepare it')
  const dep = [...document.querySelectorAll('button')].find(one => one.textContent?.includes('Prepare it'))!
  act(() => dep.click())
  expect(store.openGoal).toHaveBeenCalledWith('g0')
  expect([...document.querySelectorAll('button')].find(one => one.textContent === 'Wrap')?.hasAttribute('disabled')).toBe(true)
  expect(document.body.textContent).toContain('receipt is kept here')
})

it('a plain conversation’s Goal never asks Intake for anything', () => {
  const snapshot = emptySnapshot() as AppSnapshot
  const triggerGoal = vi.fn(async () => null)
  const store = { subscribe: () => () => {}, getSnapshot: () => snapshot, openGoal: vi.fn(), updateGoal: vi.fn(), triggerGoal } as unknown as AppStore
  act(() => root.render(<StoreProvider store={store}><GoalHeader view={view()} onWrap={() => {}} /></StoreProvider>))
  expect(triggerGoal).not.toHaveBeenCalled()
  expect(document.body.querySelector('section[aria-label="Trigger origin"]')).toBeNull()
})

it('a trigger Goal shows its origin, drawn from the host’s own label', async () => {
  const snapshot = { ...emptySnapshot(), goals: new Map([['g1', view({ origin: { kind: 'trigger', trigger: 'review-pr', event: 'e1' } })]]) } as unknown as AppSnapshot
  const triggerGoal = vi.fn(async () => ({
    goal: 'g1', trigger: 'review-pr', source: 'pull-request' as const, label: 'from PR #12', url: null,
    budget: null, waits: [],
  }))
  const store = { subscribe: () => () => {}, getSnapshot: () => snapshot, openGoal: vi.fn(), updateGoal: vi.fn(), triggerGoal } as unknown as AppStore
  await act(async () => {
    root.render(
      <StoreProvider store={store}>
        <GoalHeader view={view({ origin: { kind: 'trigger', trigger: 'review-pr', event: 'e1' } })} onWrap={() => {}} />
      </StoreProvider>,
    )
  })
  expect(triggerGoal).toHaveBeenCalledWith('g1')
  expect(document.body.textContent).toContain('Opened from PR #12')
})
