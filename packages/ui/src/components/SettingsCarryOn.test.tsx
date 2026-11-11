import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { DEFAULT_CARRY_ON, type CarryOnPolicy } from '@harnessdesk/protocol'

import { StoreProvider } from '../state/context'
import { emptySnapshot, type AppSnapshot, type AppStore } from '../state/store'
import { CarryOnSection } from './SettingsCarryOn'

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

/** A store whose policy changes the way the real one's does: optimistically, and back when a write fails. */
const mount = (initial: CarryOnPolicy, lands = true) => {
  let snapshot = { ...emptySnapshot(), status: 'open', carryOnPolicy: initial } as AppSnapshot
  const listeners = new Set<() => void>()
  const set = (policy: CarryOnPolicy) => { snapshot = { ...snapshot, carryOnPolicy: policy }; listeners.forEach(listener => listener()) }
  const setCarryOnPolicy = vi.fn(async (policy: CarryOnPolicy) => {
    const before = snapshot.carryOnPolicy
    set(policy)
    if (!lands) set(before)
  })
  const store = {
    subscribe: (listener: () => void) => { listeners.add(listener); return () => listeners.delete(listener) },
    getSnapshot: () => snapshot,
    loadCarryOnPolicy: vi.fn(async () => {}),
    setCarryOnPolicy,
  } as unknown as AppStore
  act(() => root.render(<StoreProvider store={store}><CarryOnSection /></StoreProvider>))
  return { setCarryOnPolicy, store }
}

const radios = (): HTMLButtonElement[] =>
  [...container.querySelectorAll<HTMLButtonElement>('[aria-label="When a usage limit is reached"] [role="radio"]')]
/** A choice row's own label: the first line of its text, before any description. */
const title = (one: HTMLElement) => one.querySelector('[data-slot="row-choice-mark"] + span > span')?.textContent
const chosen = () => radios().filter(one => one.getAttribute('aria-checked') === 'true').map(title)
const others = () => container.querySelector<HTMLElement>('[aria-label="Use other agents too"]')!

it('asks by default, lets other agents carry on, and offers the four answers a card offers', async () => {
  const { store } = mount(DEFAULT_CARRY_ON)
  await act(async () => {})
  expect(store.loadCarryOnPolicy).toHaveBeenCalled()
  expect(radios().map(title)).toEqual(['Ask me', 'Switch to another account', 'Wait until it resets', 'Stop'])
  expect(chosen()).toEqual(['Ask me'])
  expect(others().getAttribute('aria-checked')).toBe('true')
  // Where its provider sees the text is a consequence, so it is said on the row.
  expect(container.textContent).toContain('its recent text goes to that agent’s provider')
})

it('writes the whole policy on a choice, and turning other agents off keeps the choice', async () => {
  const { setCarryOnPolicy } = mount(DEFAULT_CARRY_ON)
  await act(async () => {})
  await act(async () => radios()[1]!.click())
  expect(setCarryOnPolicy).toHaveBeenLastCalledWith({ onLimit: 'switch', otherAgents: true })
  expect(chosen()).toEqual(['Switch to another account'])
  await act(async () => others().click())
  expect(setCarryOnPolicy).toHaveBeenLastCalledWith({ onLimit: 'switch', otherAgents: false })
})

it('has nothing to switch under Wait or Stop, so other agents is held', async () => {
  mount({ onLimit: 'stop', otherAgents: true })
  await act(async () => {})
  expect(others().hasAttribute('data-disabled') || others().getAttribute('aria-disabled') === 'true').toBe(true)
})

it('puts the old answer back when the write does not land', async () => {
  mount(DEFAULT_CARRY_ON, false)
  await act(async () => {})
  await act(async () => radios()[3]!.click())
  expect(chosen()).toEqual(['Ask me'])
})
