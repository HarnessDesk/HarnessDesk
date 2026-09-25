import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { StoreProvider } from '../state/context'
import { emptySnapshot, type AppSnapshot, type AppStore } from '../state/store'
import { LaneSettings } from './LaneSettings'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let container: HTMLDivElement; let root: Root
beforeEach(() => { container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container) })
afterEach(() => { act(() => root.unmount()); container.remove() })

const lane = { id: 'l1', goal: 'g1', seat: null, cwd: '/repo/lane', branch: 'lane', ports: { start: 30000, end: 30019 }, browserProfile: 'lane-a', state: 'retained', createdAt: 1 }
const mount = () => {
  const snapshot = { ...emptySnapshot(), lanePreferences: { start: 30000, width: 20, browserProfile: true }, lanes: [lane] } as unknown as AppSnapshot
  const store = { subscribe: () => () => {}, getSnapshot: () => snapshot, loadLanePreferences: vi.fn(), saveLanePreferences: vi.fn(async () => {}), releaseLane: vi.fn(async () => ({ ...lane, state: 'released' })) } as unknown as AppStore
  act(() => root.render(<StoreProvider store={store}><LaneSettings root="/repo" /></StoreProvider>))
  return store
}
const input = (label: string): HTMLInputElement => container.querySelector(`input[aria-label="${label}"]`) as HTMLInputElement
const type = (field: HTMLInputElement, value: string): void => {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  act(() => { setter?.call(field, value); field.dispatchEvent(new Event('input', { bubbles: true })) })
}
const enter = (field: HTMLInputElement): void => { act(() => { field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })) }) }

it('applies each lane default as it is changed, with no Save button', async () => {
  const store = mount()
  expect([...container.querySelectorAll('button')].some((one) => one.textContent === 'Save')).toBe(false)
  type(input('Starting port'), '31000')
  enter(input('Starting port'))
  await act(async () => {})
  expect(store.saveLanePreferences).toHaveBeenLastCalledWith({ start: 31000, width: 20, browserProfile: true })
  act(() => (container.querySelector('[role="switch"]') as HTMLElement).click())
  await act(async () => {})
  expect(store.saveLanePreferences).toHaveBeenLastCalledWith({ start: 30000, width: 20, browserProfile: false })
})

it('keeps a port the host would refuse in its field, says why, and saves nothing', async () => {
  const store = mount()
  type(input('Ports per lane'), '0')
  enter(input('Ports per lane'))
  await act(async () => {})
  expect(store.saveLanePreferences).not.toHaveBeenCalled()
  expect(input('Ports per lane').value).toBe('0')
  expect(input('Ports per lane').getAttribute('aria-invalid')).toBe('true')
  expect(container.querySelector('[role="alert"]')?.textContent).toContain('width from 1 to 1000')
})

it('releases a retained lane only through the host', async () => {
  const store = mount()
  act(() => [...document.querySelectorAll('button')].find(one => one.textContent?.includes('Release ports'))!.click())
  await act(async () => {})
  expect(store.releaseLane).toHaveBeenCalledWith('l1')
  expect(document.body.textContent).toContain('/repo/lane')
})
