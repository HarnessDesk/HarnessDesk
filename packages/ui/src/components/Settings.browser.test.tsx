import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { StoreProvider } from '../state/context'
import { emptySnapshot, type AppSnapshot, type AppStore } from '../state/store'
import { Settings } from './Settings'

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

it('gives both Browser choice sets named radio keyboard contracts', async () => {
  const snapshot: AppSnapshot = {
    ...emptySnapshot(),
    status: 'open',
    browserPrefs: {
      ...emptySnapshot().browserPrefs,
      placement: 'window',
      externalBinary: '/Applications/Custom Browser.app',
    },
  } as AppSnapshot
  const setBrowserPrefs = vi.fn()
  const store = {
    subscribe: () => () => {},
    getSnapshot: () => snapshot,
    listBrowsers: vi.fn(async () => [
      { name: 'Jane Browser', path: '/Applications/Jane Browser.app' },
      { name: 'Acme Browser', path: '/Applications/Acme Browser.app' },
    ]),
    setBrowserPrefs,
  } as unknown as AppStore

  await act(async () => {
    root.render(
      <StoreProvider store={store}>
        <Settings section="browser" onSection={() => {}} onClose={() => {}} onSignIn={() => {}} />
      </StoreProvider>,
    )
  })

  const groups = container.querySelectorAll<HTMLElement>('[role="radiogroup"]')
  expect([...groups].map((group) => group.getAttribute('aria-label'))).toEqual(['Pages open', 'Which browser'])

  const placement = groups[0]!.querySelectorAll<HTMLButtonElement>('[role="radio"]')
  expect([...placement].map((choice) => choice.tabIndex)).toEqual([-1, 0, -1])
  placement[1]!.focus()
  act(() => placement[1]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })))
  expect(setBrowserPrefs).toHaveBeenCalledWith({ placement: 'system' })
  expect(document.activeElement).toBe(placement[2])

  const browsers = groups[1]!.querySelectorAll<HTMLButtonElement>('[role="radio"]')
  expect([...browsers].map((choice) => choice.tabIndex)).toEqual([0, -1, -1])
  browsers[0]!.focus()
  act(() => browsers[0]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true })))
  expect(setBrowserPrefs).toHaveBeenCalledWith({ externalBinary: '/Applications/Acme Browser.app' })
  expect(document.activeElement).toBe(browsers[2])
  act(() => browsers[2]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true })))
  expect(setBrowserPrefs).toHaveBeenCalledWith({ externalBinary: '' })
  expect(document.activeElement).toBe(browsers[0])
})
