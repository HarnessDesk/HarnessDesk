import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { StoreProvider } from '../state/context'
import { emptySnapshot, type AppSnapshot, type AppStore } from '../state/store'
import { Sidebar } from './Sidebar'

/**
 * The sidebar's filter and the Escape key.
 *
 * A filter with words in it spends the key clearing them and says so, with
 * `preventDefault`, so a sidebar floating over a narrow window stays open for
 * the list the filter just gave back. An empty filter has nothing to clear:
 * it lets the key go on to whatever it would have closed — it used to spend
 * it on leaving the field, and the sidebar took a second press to put away.
 */

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

const mount = (): HTMLInputElement => {
  const snapshot = { ...emptySnapshot(), status: 'open' } as AppSnapshot
  const store = {
    subscribe: () => () => {},
    getSnapshot: () => snapshot,
    searchHistory: vi.fn(async () => {}),
  } as unknown as AppStore
  act(() => {
    root.render(
      <StoreProvider store={store}>
        <Sidebar
          onOpenSettings={() => {}}
          onOpenPlugins={() => {}}
          onOpenUsage={() => {}}
          onBrowseFolders={() => {}}
          onSignIn={() => {}}
          onSearch={() => {}}
        />
      </StoreProvider>,
    )
  })
  const filter = container.querySelector<HTMLInputElement>('input[aria-label="Filter sessions"]')
  if (!filter) throw new Error('no filter')
  return filter
}

const escape = (target: Element): KeyboardEvent => {
  const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
  act(() => {
    target.dispatchEvent(event)
  })
  return event
}

const type = (input: HTMLInputElement, text: string): void => {
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  act(() => {
    setValue?.call(input, text)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

it('an empty filter lets Escape go on to what it would close; one with words spends it clearing them', () => {
  const filter = mount()
  act(() => filter.focus())
  expect(escape(filter).defaultPrevented).toBe(false)

  act(() => filter.focus())
  type(filter, 'retry')
  expect(filter.value).toBe('retry')
  expect(escape(filter).defaultPrevented).toBe(true)
  expect(filter.value).toBe('')
})
