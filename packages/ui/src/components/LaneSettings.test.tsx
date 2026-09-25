import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { StoreProvider } from '../state/context'
import { emptySnapshot, type AppSnapshot, type AppStore } from '../state/store'
import { LaneSettings } from './LaneSettings'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let container: HTMLDivElement; let root: Root
beforeEach(() => {
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container)
  vi.spyOn(document, 'hasFocus').mockReturnValue(true)
})
afterEach(() => { act(() => root.unmount()); container.remove(); vi.restoreAllMocks() })

const lane = { id: 'l1', goal: 'g1', seat: null, cwd: '/repo/lane', branch: 'lane', ports: { start: 30000, end: 30019 }, browserProfile: 'lane-a', state: 'retained', createdAt: 1 }
/** A host that holds each save open until the test lets it answer. */
const mount = (save: (prefs: unknown) => Promise<void> = async () => {}) => {
  const snapshot = { ...emptySnapshot(), lanePreferences: { start: 30000, width: 20, browserProfile: true }, lanes: [lane] } as unknown as AppSnapshot
  const store = { subscribe: () => () => {}, getSnapshot: () => snapshot, loadLanePreferences: vi.fn(), saveLanePreferences: vi.fn(save), releaseLane: vi.fn(async () => ({ ...lane, state: 'released' })) } as unknown as AppStore
  act(() => root.render(<StoreProvider store={store}><LaneSettings root="/repo" /></StoreProvider>))
  return store
}
const input = (label: string): HTMLInputElement => container.querySelector(`input[aria-label="${label}"]`) as HTMLInputElement
const type = (field: HTMLInputElement, value: string): void => {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  act(() => { setter?.call(field, value); field.dispatchEvent(new Event('input', { bubbles: true })) })
}
const press = (field: HTMLInputElement, key: string): void => { act(() => { field.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })) }) }
const note = (field: HTMLInputElement): string | null | undefined => {
  const id = field.getAttribute('aria-describedby')
  return id ? document.getElementById(id)?.textContent : null
}

it('applies each lane default as it is changed, with no Save button', async () => {
  const store = mount()
  expect([...container.querySelectorAll('button')].some((one) => one.textContent === 'Save')).toBe(false)
  type(input('Starting port'), '31000')
  press(input('Starting port'), 'Enter')
  await act(async () => {})
  expect(store.saveLanePreferences).toHaveBeenLastCalledWith({ start: 31000, width: 20, browserProfile: true })
  type(input('Ports per lane'), '40')
  press(input('Ports per lane'), 'Enter')
  await act(async () => {})
  expect(store.saveLanePreferences).toHaveBeenLastCalledWith(expect.objectContaining({ width: 40 }))
})

it('builds a quick second edit on the first, not on the value last drawn', async () => {
  let answer!: () => void
  const store = mount(() => new Promise<void>((resolve) => { answer = resolve }))
  type(input('Starting port'), '31000')
  press(input('Starting port'), 'Enter')
  // The host has not answered the port yet when the switch is flipped.
  act(() => (container.querySelector('[role="switch"]') as HTMLElement).click())
  expect(store.saveLanePreferences).toHaveBeenLastCalledWith({ start: 31000, width: 20, browserProfile: false })
  await act(async () => { answer() })
})

it('keeps a port the host would refuse in its field, reads the reason with it, and saves nothing', async () => {
  const store = mount()
  type(input('Ports per lane'), '0')
  press(input('Ports per lane'), 'Enter')
  await act(async () => {})
  expect(store.saveLanePreferences).not.toHaveBeenCalled()
  expect(input('Ports per lane').value).toBe('0')
  expect(input('Ports per lane').getAttribute('aria-invalid')).toBe('true')
  expect(note(input('Ports per lane'))).toContain('width from 1 to 1000')
  expect(input('Starting port').getAttribute('aria-describedby')).toBeNull()
})

it('keeps each field’s reason its own: mending another does not clear it, and Escape in it does', async () => {
  mount()
  type(input('Ports per lane'), '0')
  press(input('Ports per lane'), 'Enter')
  type(input('Starting port'), '31000')
  press(input('Starting port'), 'Enter')
  await act(async () => {})
  // The port was taken; the width is still refused, and still says why.
  expect(input('Ports per lane').getAttribute('aria-invalid')).toBe('true')
  expect(note(input('Ports per lane'))).toContain('width from 1 to 1000')
  press(input('Ports per lane'), 'Escape')
  expect(input('Ports per lane').value).toBe('20')
  expect(input('Ports per lane').getAttribute('aria-invalid')).toBeNull()
  expect(container.querySelector('[role="alert"]')).toBeNull()
})

it('releases a retained lane only through the host', async () => {
  const store = mount()
  act(() => [...document.querySelectorAll('button')].find(one => one.textContent?.includes('Release ports'))!.click())
  await act(async () => {})
  expect(store.releaseLane).toHaveBeenCalledWith('l1')
  expect(document.body.textContent).toContain('/repo/lane')
})
