import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { StoreProvider } from '../state/context'
import { emptySnapshot, type AppSnapshot, type AppStore } from '../state/store'
import { GoalMigrationBanner } from './GoalMigrationBanner'

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

it('acknowledges a successful room migration and removes its durable banner', async () => {
  let snapshot = { ...emptySnapshot(), goalMigrationPending: true } as AppSnapshot
  const listeners = new Set<() => void>()
  const ack = vi.fn(async () => {
    snapshot = { ...snapshot, goalMigrationPending: false }
    listeners.forEach((listener) => listener())
  })
  const store = {
    getSnapshot: () => snapshot,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => listeners.delete(listener) },
    ackGoalMigration: ack,
  } as unknown as AppStore
  act(() => root.render(<StoreProvider store={store}><GoalMigrationBanner /></StoreProvider>))
  expect(document.body.textContent).toContain('Rooms are now Goals')
  act(() => [...document.querySelectorAll('button')].find((one) => one.textContent === 'Got it')!.click())
  await act(async () => {})
  expect(ack).toHaveBeenCalledOnce()
  expect(document.body.textContent).not.toContain('Rooms are now Goals')
})

it('does not turn a Goal storage failure into a migration success banner', () => {
  const snapshot = { ...emptySnapshot(), goalMigrationPending: false, goalProblem: 'The Goal store could not be read.' }
  const store = { getSnapshot: () => snapshot, subscribe: () => () => {} } as unknown as AppStore
  act(() => root.render(<StoreProvider store={store}><GoalMigrationBanner /></StoreProvider>))
  expect(document.body.textContent).not.toContain('Rooms are now Goals')
})
