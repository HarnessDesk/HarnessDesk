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

it('opens dependencies and says why a wrapped Goal cannot be mutated', () => {
  const snapshot = emptySnapshot() as AppSnapshot
  const store = { subscribe: () => () => {}, getSnapshot: () => snapshot, openGoal: vi.fn(), updateGoal: vi.fn() } as unknown as AppStore
  act(() => root.render(<StoreProvider store={store}><GoalHeader view={view({ state: 'wrapped' })} /></StoreProvider>))
  expect(document.body.textContent).toContain('Prepare it')
  const dep = [...document.querySelectorAll('button')].find(one => one.textContent?.includes('Prepare it'))!
  act(() => dep.click())
  expect(store.openGoal).toHaveBeenCalledWith('g0')
  expect(document.body.textContent).toContain('receipt is kept here')
})

/**
 * A trigger Goal's own origin, budget and "Needs you" waits used to live
 * here too, in `GoalIntake` (deleted with the owner's own design for the
 * four body elements) — this body never asks Intake anything now, for any
 * Goal, trigger-opened or not. `TeamRoomPane.test.tsx` covers the header's
 * own origin chip and hover card, which is where that responsibility moved.
 */
it('never asks Intake for anything, trigger-opened or not', () => {
  const snapshot = emptySnapshot() as AppSnapshot
  const triggerGoal = vi.fn(async () => null)
  const store = { subscribe: () => () => {}, getSnapshot: () => snapshot, openGoal: vi.fn(), updateGoal: vi.fn(), triggerGoal } as unknown as AppStore
  act(() => root.render(<StoreProvider store={store}><GoalHeader view={view({ origin: { kind: 'trigger', trigger: 'review-pr', event: 'e1' } })} /></StoreProvider>))
  expect(triggerGoal).not.toHaveBeenCalled()
  expect(document.body.querySelector('section[aria-label="Trigger origin"]')).toBeNull()
})
