import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it } from 'vitest'

import { StoreProvider } from '../state/context'
import { emptySnapshot, type AppSnapshot, type AppStore } from '../state/store'
import { collapseDock, dock, toggleDock, zoomArea } from '../state/workbench'
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

it('shows the hidden right-panel count and names the control accessibly', () => {
  const listeners = new Set<() => void>()
  let snapshot: AppSnapshot = emptySnapshot()
  snapshot = {
    ...snapshot,
    workbench: collapseDock(
      dock(dock(snapshot.workbench, 'right', { kind: 'changes' }), 'right', { kind: 'activity' }),
      'right',
      true,
    ),
  }
  const store = {
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    getSnapshot: () => snapshot,
    toggleSidebar: () => undefined,
    navigateBack: async () => undefined,
    navigateForward: async () => undefined,
    togglePanel: (area: 'right') => {
      snapshot = { ...snapshot, workbench: toggleDock(snapshot.workbench, area) }
      listeners.forEach((listener) => listener())
    },
  } as unknown as AppStore

  act(() => root.render(<StoreProvider store={store}><WindowControls /></StoreProvider>))
  let button = container.querySelector<HTMLButtonElement>('[aria-label="Show the right panel — 2 views"]')
  expect(button).not.toBeNull()
  expect(button?.querySelector('[data-slot="badge"]')?.textContent).toBe('2')

  act(() => button?.click())
  button = container.querySelector<HTMLButtonElement>('[aria-label="Hide the right panel"]')
  expect(button).not.toBeNull()
  expect(button?.querySelector('[data-slot="badge"]')).toBeNull()
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
