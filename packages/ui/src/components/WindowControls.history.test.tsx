import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { StoreProvider } from '../state/context'
import { emptySnapshot, type AppStore } from '../state/store'
import { WindowControls } from './WindowControls'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

afterEach(() => { vi.unstubAllGlobals() })

it('hands folded sidebar history to main, then returns it on resize', () => {
  let resize = () => {}
  const disconnect = vi.fn()
  vi.stubGlobal('ResizeObserver', class {
    constructor(callback: () => void) { resize = callback }
    observe() {}
    disconnect = disconnect
  })
  const column = document.createElement('div')
  column.setAttribute('data-left-top', '')
  column.innerHTML = '<div><span data-left-history style="display: none"></span></div>'
  document.body.append(column)
  const history = column.querySelector<HTMLElement>('[data-left-history]')!
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  const snapshot = { ...emptySnapshot(), sidebarCollapsed: false, navCanBack: true, navCanForward: false }
  const navigateBack = vi.fn(async () => {})
  const store = { getSnapshot: () => snapshot, subscribe: () => () => {}, navigateBack, navigateForward: vi.fn() } as unknown as AppStore
  try {
    act(() => root.render(<StoreProvider store={store}><WindowControls /></StoreProvider>))
    expect([...container.querySelectorAll('button')].map(button => button.getAttribute('aria-label'))).toEqual(['Back', 'Forward'])
    expect(container.querySelector<HTMLButtonElement>('[aria-label="Forward"]')!.disabled).toBe(true)
    act(() => container.querySelector<HTMLButtonElement>('[aria-label="Back"]')!.click())
    expect(navigateBack).toHaveBeenCalledOnce()
    act(() => { history.style.display = 'flex'; resize() })
    expect(container.querySelectorAll('button')).toHaveLength(0)
    act(() => { history.style.display = 'none'; resize() })
    expect(container.querySelectorAll('button')).toHaveLength(2)
  } finally {
    act(() => root.unmount())
    container.remove()
    column.remove()
  }
  expect(disconnect).toHaveBeenCalled()
})
