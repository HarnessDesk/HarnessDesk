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

it('saves machine defaults and releases only through the host', async () => {
  const lane = { id: 'l1', goal: 'g1', seat: null, cwd: '/repo/lane', branch: 'lane', ports: { start: 30000, end: 30019 }, browserProfile: 'lane-a', state: 'retained', createdAt: 1 }
  const snapshot = { ...emptySnapshot(), lanePreferences: { start: 30000, width: 20, browserProfile: true }, lanes: [lane] } as unknown as AppSnapshot
  const store = { subscribe: () => () => {}, getSnapshot: () => snapshot, loadLanePreferences: vi.fn(), saveLanePreferences: vi.fn(), releaseLane: vi.fn(async () => ({ ...lane, state: 'released' })) } as unknown as AppStore
  act(() => root.render(<StoreProvider store={store}><LaneSettings root="/repo" /></StoreProvider>))
  act(() => [...document.querySelectorAll('button')].find(one => one.textContent === 'Save')!.click())
  await act(async () => {})
  expect(store.saveLanePreferences).toHaveBeenCalledWith({ start: 30000, width: 20, browserProfile: true })
  act(() => [...document.querySelectorAll('button')].find(one => one.textContent?.includes('Release ports'))!.click())
  await act(async () => {})
  expect(store.releaseLane).toHaveBeenCalledWith('l1')
  expect(document.body.textContent).toContain('/repo/lane')
})
