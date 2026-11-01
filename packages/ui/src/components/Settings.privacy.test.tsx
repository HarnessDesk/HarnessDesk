import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { StoreProvider } from '../state/context'
import { emptySnapshot, type AppSnapshot, type AppStore } from '../state/store'
import { PrivacyRows } from './Settings'

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

it('turns account addresses off and on from General', () => {
  const setHideAccountAddresses = vi.fn()
  const snapshot = { ...emptySnapshot(), hideAccountAddresses: false } as AppSnapshot
  const store = { subscribe: () => () => {}, getSnapshot: () => snapshot, setHideAccountAddresses } as unknown as AppStore
  act(() => root.render(<StoreProvider store={store}><PrivacyRows /></StoreProvider>))
  const toggle = container.querySelector<HTMLElement>('[aria-label="Hide account addresses"]')!
  expect(toggle.getAttribute('aria-checked')).toBe('false')
  act(() => toggle.click())
  expect(setHideAccountAddresses).toHaveBeenCalledWith(true)
})
