import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import type { AgentEntry, GoalView } from '@harnessdesk/protocol'

import { StoreProvider } from '../state/context'
import { AppStore } from '../state/store'
import { GoalCreate, type GoalCreateProps } from './GoalCreate'

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

const mount = (seatGoal: AppStore['seatGoal'], props: Partial<GoalCreateProps> = {}) => {
  const store = new AppStore('ws://localhost:0/')
  Object.assign(store.getSnapshot(), { agents })
  vi.spyOn(store, 'loadAgents').mockResolvedValue(undefined)
  vi.spyOn(store, 'flowCatalog').mockResolvedValue([])
  vi.spyOn(store, 'agentsIn').mockResolvedValue(agents)
  vi.spyOn(store, 'startTeam').mockResolvedValue(goal)
  vi.spyOn(store, 'seatGoal').mockImplementation(seatGoal)
  vi.spyOn(store, 'teamAdd').mockResolvedValue(undefined)
  vi.spyOn(store, 'openGoal').mockImplementation(() => {})
  const onClose = vi.fn()
  act(() => root.render(<StoreProvider store={store}><GoalCreate root="/repo" onClose={onClose} {...props} /></StoreProvider>))
  return { store, onClose }
}

const typeSentence = (value: string): void => {
  const input = document.querySelector<HTMLTextAreaElement>('textarea[aria-label="What should they do?"]')!
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

it('uses the shared New Team dialog with Just a Team selected', async () => {
  mount(vi.fn())
  await act(async () => {})
  expect(document.querySelector('[role="dialog"]')?.getAttribute('aria-label')).toBe('New Team')
  expect(document.querySelector('[data-slot="selected-flow"]')?.textContent).toContain('Just a Team')
  expect(document.querySelector('[aria-label="Search Flows"]')).toBeNull()
  expect([...document.querySelectorAll('button')].some(one => one.textContent === 'Change')).toBe(true)
})

it('keeps a caller-known project refusal and reports successful reopening', async () => {
  const refusal = '/repo is outside every folder and repository opened here. Open it first.'
  const onProjectOpened = vi.fn()
  const { store } = mount(vi.fn(), { task: 'Investigate the cart', projectProblem: refusal, onProjectOpened })
  vi.spyOn(store, 'openWorkspace').mockResolvedValue(true)
  await act(async () => {})
  expect(document.body.textContent).toContain(refusal)
  const recovery=document.querySelector('[role="alert"]')!.closest('[data-measure]')!
  expect(recovery.getAttribute('data-measure')).toBe('container')
  expect(recovery.querySelector('[data-floating]')).toBeNull()
  await act(async () => press('Open repo'))
  expect(onProjectOpened).toHaveBeenCalledOnce()
  expect(document.body.textContent).not.toContain(refusal)
  expect(document.querySelector<HTMLTextAreaElement>('textarea')?.value).toBe('Investigate the cart')
})

const press = (words: string): void => {
  const button = [...document.querySelectorAll('button')].find(one => one.textContent?.includes(words))
  if (!button) throw new Error(`no button ${words}`)
  act(() => button.click())
}

it('creates once and retries only unfinished staffing', async () => {
  const scroll = vi.spyOn(HTMLElement.prototype, 'scrollIntoView').mockImplementation(() => {})
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
  press('Start')
  await act(async () => {})
  expect(store.startTeam).toHaveBeenCalledTimes(1)
  expect(seatGoal).toHaveBeenCalledTimes(2)
  expect(document.body.textContent).toContain('Reviewer is already busy.')
  const failure = document.querySelector('[role="alert"]')!
  expect(document.activeElement?.contains(failure)).toBe(true)
  expect(scroll.mock.contexts).toContain(document.activeElement)
  expect(scroll).toHaveBeenCalledWith({ block: 'nearest' })
  expect(onClose).not.toHaveBeenCalled()

  press('Retry unfinished')
  await act(async () => {})
  expect(store.startTeam).toHaveBeenCalledTimes(1)
  expect(seatGoal).toHaveBeenCalledTimes(3)
  expect(store.openGoal).toHaveBeenCalledWith('g1')
  expect(onClose).toHaveBeenCalled()
  scroll.mockRestore()
})

it('validates the one required sentence and creates an unstaffed Goal', async () => {
  const { store } = mount(vi.fn() as unknown as AppStore['seatGoal'])
  expect([...document.querySelectorAll('button')].find(one => one.textContent?.includes('Start'))?.hasAttribute('disabled')).toBe(true)
  typeSentence('  A small goal  ')
  press('Start')
  await act(async () => {})
  expect(store.startTeam).toHaveBeenCalledWith({ root: '/repo', sentence: 'A small goal', checkout: 'shared' })
  expect(store.seatGoal).not.toHaveBeenCalled()
})

it('retains the task before seating and does not duplicate it when staffing is retried', async () => {
  const seatGoal = vi.fn().mockRejectedValueOnce(new Error('Builder is busy.')).mockResolvedValue({ id: 'seat-builder' })
  const { store, onClose } = mount(seatGoal, { task: '  Investigate the cart  ', done: 'The cause is documented' })
  act(() => document.querySelector<HTMLButtonElement>('[aria-label="Seat Builder"]')!.click())
  press('Start')
  await act(async () => {})
  expect(store.teamAdd).toHaveBeenCalledWith('g1', { title: 'Investigate the cart' })
  expect(vi.mocked(store.teamAdd).mock.invocationCallOrder[0]!).toBeLessThan(seatGoal.mock.invocationCallOrder[0]!)
  expect(onClose).not.toHaveBeenCalled()
  press('Retry unfinished')
  await act(async () => {})
  expect(store.startTeam).toHaveBeenCalledOnce()
  expect(store.teamAdd).toHaveBeenCalledOnce()
  expect(onClose).toHaveBeenCalledOnce()
})

it('retries a refused initial task before seating or opening the same Team', async () => {
  const { store, onClose } = mount(vi.fn(), { task: 'Investigate the cart', done: 'The cause is documented' })
  vi.mocked(store.teamAdd).mockRejectedValueOnce(new Error('The task could not be saved.'))
  press('Start')
  await act(async () => {})
  expect(document.body.textContent).toContain('The task could not be saved.')
  expect(store.openGoal).not.toHaveBeenCalled()
  expect(onClose).not.toHaveBeenCalled()
  press('Retry unfinished')
  await act(async () => {})
  expect(store.startTeam).toHaveBeenCalledOnce()
  expect(store.teamAdd).toHaveBeenCalledTimes(2)
  expect(store.openGoal).toHaveBeenCalledWith('g1')
})
