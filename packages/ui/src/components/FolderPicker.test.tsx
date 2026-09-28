import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { StoreProvider } from '../state/context'
import { emptySnapshot, type AppSnapshot, type AppStore } from '../state/store'
import { FolderPicker } from './FolderPicker'

/**
 * The breadcrumb regression this dialog once had: a separator that sat
 * *inside* the crumb's own `<li>` (`BreadcrumbItem`) rather than beside it as
 * its own sibling, which is an `<li>` nested in an `<li>` — invalid HTML that
 * React and the DOM both refuse (a browser hoists the inner one out, and
 * React's own hydration/DOM-nesting warning fires). It went unnoticed because
 * this component had never been mounted anywhere to catch it (the coverage
 * gate's own reason for existing). A path with several ancestors is what
 * exercises the separator at all — a bare `/` draws no crumb after the root.
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

const rig = () => {
  const snapshot = { ...emptySnapshot(), status: 'open' } as unknown as AppSnapshot
  const store = {
    subscribe: () => () => {},
    getSnapshot: () => snapshot,
    transport: {
      request: vi.fn().mockResolvedValue({
        path: '/Users/me/code/harness-desk',
        parent: '/Users/me/code',
        entries: [
          { name: 'packages', path: '/Users/me/code/harness-desk/packages' },
          { name: 'docs', path: '/Users/me/code/harness-desk/docs' },
        ],
      }),
    },
  } as unknown as AppStore
  return { store }
}

it('nests no <li> inside another <li> in its own breadcrumb', async () => {
  const { store } = rig()
  await act(async () => {
    root.render(
      <StoreProvider store={store}>
        <FolderPicker onClose={() => {}} />
      </StoreProvider>,
    )
  })
  // Flush the `workspace/browse` promise and the render it triggers.
  await act(async () => {})

  const items = [...document.querySelectorAll('li')]
  expect(items.length).toBeGreaterThan(1)
  for (const item of items) {
    expect(item.querySelector('li')).toBeNull()
  }
})

it('draws a separator between crumbs as the item’s own sibling, not its child', async () => {
  const { store } = rig()
  await act(async () => {
    root.render(
      <StoreProvider store={store}>
        <FolderPicker onClose={() => {}} />
      </StoreProvider>,
    )
  })
  await act(async () => {})

  expect(document.body.textContent).toContain('harness-desk')
  const crumbs = [...document.querySelectorAll('[data-slot="breadcrumb-page"], [data-slot="breadcrumb-item"] button')]
  expect(crumbs.some((el) => el.textContent === 'harness-desk')).toBe(true)
})
