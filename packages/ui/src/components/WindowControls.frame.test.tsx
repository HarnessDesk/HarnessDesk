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
const draw = (width: number, sidebarRow = false, settings = false) => {
  const container = document.createElement('div')
  document.body.append(container)
  containers.push(container)
  const root = createRoot(container)
  roots.push(root)
  const base = emptySnapshot()
  const snapshot = { ...base, windowWidth: width, narrowWindow: width < FRAME.fold.sidebarFloats, sidebarCollapsed: true,
    navCanBack: true, navCanForward: true, workbench: settings ? { ...base.workbench, navigation: { ...base.workbench.navigation,
      current: { kind: 'settings' as const, route: { kind: 'section' as const, section: 'general' as const, focus: null } } } } : base.workbench }
  const back = vi.fn(async () => {})
  const forward = vi.fn(async () => {})
  const store = { getSnapshot: () => snapshot, subscribe: () => () => {}, toggleSidebar: vi.fn(), navigateBack: back, navigateForward: forward } as unknown as AppStore
  act(() => root.render(<StoreProvider store={store}><WindowControls {...{ sidebarRow }} /></StoreProvider>))
  return { container, back, forward }
}
it('keeps Search beside the sidebar toggle when the narrow column is hidden', () => {
  const { container } = draw(720)
  expect([...container.querySelectorAll('button')].map(button => button.getAttribute('aria-label'))).toEqual(['Show sidebar', 'Search everything'])
})

it.each([720, 1440])('keeps only the sidebar toggle in the Settings lead at %i', width => {
  const { container } = draw(width, false, true)
  expect([...container.querySelectorAll('button')].map(button => button.getAttribute('aria-label'))).toEqual(['Show sidebar'])
})

it('keeps Search in the window lead while a wide column is hidden', () => {
  const { container } = draw(1440)
  expect([...container.querySelectorAll('button')].map(button => button.getAttribute('aria-label'))).toEqual([
    'Show sidebar', 'Search everything', 'Back', 'Forward',
  ])
})

it('opens the search palette from the hidden-column Search button', () => {
  const { container } = draw(1440)
  let opened = 0
  const listen = () => { opened += 1 }
  window.addEventListener('harnessdesk:search', listen)
  try {
    container.querySelector<HTMLButtonElement>('button[aria-label="Search everything"]')!.click()
    expect(opened).toBe(1)
  } finally {
    window.removeEventListener('harnessdesk:search', listen)
  }
})
it('keeps sidebar back and forward reachable in the floating column', () => {
  const { container, back, forward } = draw(720, true)
  expect(container.querySelectorAll('button')).toHaveLength(4)
  act(() => container.querySelector<HTMLButtonElement>('[aria-label="Back"]')!.click())
  act(() => container.querySelector<HTMLButtonElement>('[aria-label="Forward"]')!.click())
  expect(back).toHaveBeenCalledOnce()
  expect(forward).toHaveBeenCalledOnce()
})
it('keeps Search at every hidden-column width and crosses the FRAME window threshold exactly', () => {
  expect(draw(1440).container.querySelectorAll('button')).toHaveLength(4)
  expect(draw(FRAME.fold.sidebarFloats).container.querySelectorAll('button')).toHaveLength(4)
  expect(draw(FRAME.fold.sidebarFloats - 1).container.querySelectorAll('button')).toHaveLength(2)
})
