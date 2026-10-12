import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it } from 'vitest'

import { StoreProvider } from '../state/context'
import { emptySnapshot, type AppSnapshot, type AppStore } from '../state/store'
import { dock, zoomArea } from '../state/workbench'
import { WindowControls } from './WindowControls'

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
  expect([...container.querySelectorAll('button')].map(button => button.getAttribute('aria-label'))).toEqual(['Show sidebar', 'Search everything', 'Back', 'Forward'])
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
