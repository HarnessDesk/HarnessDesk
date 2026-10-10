import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { StoreProvider } from '../state/context'
import { emptySnapshot, type AppStore } from '../state/store'
import { FRAME } from '../design/frame'
import { WindowControls } from './WindowControls'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const roots: ReturnType<typeof createRoot>[] = []
const containers: HTMLElement[] = []
afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount())
  for (const container of containers.splice(0)) container.remove()
})
const draw = (width: number, sidebarRow = false) => {
  const container = document.createElement('div')
  document.body.append(container)
  containers.push(container)
  const root = createRoot(container)
  roots.push(root)
  const snapshot = { ...emptySnapshot(), windowWidth: width, narrowWindow: width < FRAME.fold.sidebarFloats, sidebarCollapsed: true, navCanBack: true, navCanForward: true }
  const back = vi.fn(async () => {})
  const forward = vi.fn(async () => {})
  const store = { getSnapshot: () => snapshot, subscribe: () => () => {}, toggleSidebar: vi.fn(), navigateBack: back, navigateForward: forward } as unknown as AppStore
  act(() => root.render(<StoreProvider store={store}><WindowControls {...{ sidebarRow }} /></StoreProvider>))
  return { container, back, forward }
}
it('uses only the sidebar toggle in the narrow window lead', () => {
  const { container } = draw(720)
  expect([...container.querySelectorAll('button')].map(button => button.getAttribute('aria-label'))).toEqual(['Show sidebar'])
})
it('keeps sidebar back and forward reachable in the floating column', () => {
  const { container, back, forward } = draw(720, true)
  expect(container.querySelectorAll('button')).toHaveLength(3)
  act(() => container.querySelector<HTMLButtonElement>('[aria-label="Back"]')!.click())
  act(() => container.querySelector<HTMLButtonElement>('[aria-label="Forward"]')!.click())
  expect(back).toHaveBeenCalledOnce()
  expect(forward).toHaveBeenCalledOnce()
})
it('uses three controls for a hidden wide column and crosses the FRAME window threshold exactly', () => {
  expect(draw(1440).container.querySelectorAll('button')).toHaveLength(3)
  expect(draw(FRAME.fold.sidebarFloats).container.querySelectorAll('button')).toHaveLength(3)
  expect(draw(FRAME.fold.sidebarFloats - 1).container.querySelectorAll('button')).toHaveLength(1)
})
