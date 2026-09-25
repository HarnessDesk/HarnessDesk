import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import type { AgentEntry, GoalView } from '@harnessdesk/protocol'

import { StoreProvider } from '../state/context'
import { emptySnapshot, type AppSnapshot, type AppStore } from '../state/store'
import { GoalCreate } from './GoalCreate'

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

const goal = { goal: { id: 'g1' } } as GoalView
const agents = [
  { id: 'builder', definition: { name: 'Builder' }, origin: 'project', path: '/repo/builder', digest: 'a' },
  { id: 'reviewer', definition: { name: 'Reviewer' }, origin: 'project', path: '/repo/reviewer', digest: 'b' },
] as unknown as AgentEntry[]

const mount = (seatGoal: AppStore['seatGoal']) => {
  const snapshot = { ...emptySnapshot(), agents } as unknown as AppSnapshot
  const store = {
    subscribe: () => () => {}, getSnapshot: () => snapshot,
    loadAgents: vi.fn(), createGoal: vi.fn(async () => goal), seatGoal,
    openGoal: vi.fn(),
  } as unknown as AppStore
  const onClose = vi.fn()
  act(() => root.render(<StoreProvider store={store}><GoalCreate root="/repo" onClose={onClose} /></StoreProvider>))
  return { store, onClose }
}

const typeSentence = (value: string): void => {
  const input = document.querySelector<HTMLInputElement>('input[aria-label="What finishes this?"]')!
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

const press = (words: string): void => {
  const button = [...document.querySelectorAll('button')].find(one => one.textContent?.includes(words))
  if (!button) throw new Error(`no button ${words}`)
  act(() => button.click())
}

it('creates once and retries only unfinished staffing', async () => {
  let reviewerAttempts = 0
  const seatGoal = vi.fn(async ({ agent }: { agent: string }) => {
    if (agent === 'reviewer' && reviewerAttempts++ === 0) throw new Error('Reviewer is already busy.')
    return { id: `seat-${agent}` }
  }) as unknown as AppStore['seatGoal']
  const { store, onClose } = mount(seatGoal)
  typeSentence('Ship the checkout rewrite')
  // Seating is several members at once, so each row is a checkbox rather than
  // a switch, which acts the moment it flips.
  for (const control of document.querySelectorAll<HTMLButtonElement>('[role="checkbox"]')) act(() => control.click())
  press('Create Goal')
  await act(async () => {})
  expect(store.createGoal).toHaveBeenCalledTimes(1)
  expect(seatGoal).toHaveBeenCalledTimes(2)
  expect(document.body.textContent).toContain('Reviewer is already busy.')
  expect(onClose).not.toHaveBeenCalled()

  press('Retry unfinished')
  await act(async () => {})
  expect(store.createGoal).toHaveBeenCalledTimes(1)
  expect(seatGoal).toHaveBeenCalledTimes(3)
  expect(store.openGoal).toHaveBeenCalledWith('g1')
  expect(onClose).toHaveBeenCalled()
})

it('validates the one required sentence and creates an unstaffed Goal', async () => {
  const { store } = mount(vi.fn() as unknown as AppStore['seatGoal'])
  expect([...document.querySelectorAll('button')].find(one => one.textContent?.includes('Create Goal'))?.hasAttribute('disabled')).toBe(true)
  typeSentence('  A small goal  ')
  press('Create Goal')
  await act(async () => {})
  expect(store.createGoal).toHaveBeenCalledWith({ root: '/repo', sentence: 'A small goal', checkout: 'shared' })
  expect(store.seatGoal).not.toHaveBeenCalled()
})
