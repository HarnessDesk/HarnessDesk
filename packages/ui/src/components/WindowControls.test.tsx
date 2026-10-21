import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { StoreProvider } from '../state/context'
import { emptySnapshot, type AppSnapshot, type AppStore } from '../state/store'
import { dock, zoomArea } from '../state/workbench'
import { WindowControls } from './WindowControls'
import { Menu } from '../design'

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

it('leaves right-panel controls to WorkTools and renders the wide navigation lead', () => {
  const snapshot = { ...emptySnapshot(), sidebarCollapsed: true }
  const store = {
    subscribe: () => () => undefined,
    getSnapshot: () => snapshot,
    toggleSidebar: () => undefined,
    navigateBack: async () => undefined,
    navigateForward: async () => undefined,
  } as unknown as AppStore
  act(() => root.render(<StoreProvider store={store}><WindowControls /></StoreProvider>))
  expect(container.querySelector('[aria-label*="right panel"]')).toBeNull()
  expect([...container.querySelectorAll('button')].map(button => button.getAttribute('aria-label'))).toEqual(['Show sidebar', 'Back', 'Forward'])
})

it('has no right-panel toggle while a zoom on another area hides the panel', () => {
  // Neither "Hide the right panel" (it is not drawn) nor "Show" (it would
  // uncollapse behind the zoom) tells the truth until the zoom is handed back.
  let snapshot: AppSnapshot = emptySnapshot()
  snapshot = {
    ...snapshot,
    workbench: zoomArea(dock(snapshot.workbench, 'right', { kind: 'changes' }), 'main', 'window'),
  }
  const store = {
    subscribe: () => () => undefined,
    getSnapshot: () => snapshot,
    toggleSidebar: () => undefined,
    navigateBack: async () => undefined,
    navigateForward: async () => undefined,
    togglePanel: () => undefined,
  } as unknown as AppStore

  act(() => root.render(<StoreProvider store={store}><WindowControls /></StoreProvider>))
  expect(container.querySelector('[aria-label*="right panel"]')).toBeNull()
})

it('folds history into real menu actions while preserving navigation refusals', () => {
  const snapshot = { ...emptySnapshot(), sidebarCollapsed: true, navCanBack: true, navCanForward: false }
  const back = vi.fn(), forward = vi.fn(), close = vi.fn()
  const store = { subscribe: () => () => {}, getSnapshot: () => snapshot, navigateBack: back, navigateForward: forward } as unknown as AppStore
  act(() => root.render(<StoreProvider store={store}><Menu close={close}><WindowControls menu close={close} /></Menu></StoreProvider>))
  const rows = [...container.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]
  expect(rows.map(one => one.textContent)).toEqual(['Back', 'Forward'])
  expect(rows[1]!.getAttribute('aria-disabled')).toBe('true')
  act(() => rows[0]!.click())
  expect(back).toHaveBeenCalledOnce()
  expect(forward).not.toHaveBeenCalled()
  expect(close).toHaveBeenCalled()
})
