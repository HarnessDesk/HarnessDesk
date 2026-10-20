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
  expect(document.querySelector('[data-slot="dialog-description"]')?.textContent).toBe('Click a folder to enter it; open the one you are in.')
  const crumbs = [...document.querySelectorAll('[data-slot="breadcrumb-page"], [data-slot="breadcrumb-item"] button')]
  expect(crumbs.some((el) => el.textContent === 'harness-desk')).toBe(true)
})

it('bounds only a host refusal and restores the ordinary instruction when cleared', async () => {
  const { store } = rig()
  const render = (problem?: string) => act(async () => root.render(<StoreProvider store={store}><FolderPicker onClose={() => {}} problem={problem} /></StoreProvider>))
  await render()
  expect(document.querySelector('[data-slot="dialog-description"]')?.hasAttribute('data-scroll')).toBe(false)
  const problem = 'The chosen chats location contains an opened project: /work/' + 'nested-directory/'.repeat(45) + 'project'
  await render(problem)
  expect(document.querySelector('[data-slot="dialog-description"]')?.textContent).toBe(problem)
  expect(document.querySelector('[data-slot="dialog-description"]')?.hasAttribute('data-scroll')).toBe(true)
  await render()
  expect(document.querySelector('[data-slot="dialog-description"]')?.hasAttribute('data-scroll')).toBe(false)
})

it('reports a chosen folder only after it has opened successfully (#1720)', async () => {
  const { store } = rig()
  let finish!: (opened: boolean) => void
  store.openWorkspace = vi.fn(() => new Promise<boolean>(resolve => { finish = resolve }))
  const close = vi.fn()
  await act(async () => root.render(<StoreProvider store={store}><FolderPicker onClose={close} /></StoreProvider>))
  const open = [...document.querySelectorAll<HTMLButtonElement>('button')].find(one => one.textContent?.startsWith('Open “'))!
  expect(open).toBeDefined()
  act(() => open.click())
  expect(close).not.toHaveBeenCalled()
  await act(async () => finish(true))
  expect(close).toHaveBeenCalledWith(true)
})

it('invalidates a cancelled open before the parent unmounts the picker (#1720)', async () => {
  const { store } = rig()
  let finish!: (opened: boolean) => void
  store.openWorkspace = vi.fn(() => new Promise<boolean>(resolve => { finish = resolve }))
  const close = vi.fn()
  await act(async () => root.render(<StoreProvider store={store}><FolderPicker onClose={close} /></StoreProvider>))
  const buttons = [...document.querySelectorAll<HTMLButtonElement>('button')]
  act(() => buttons.find(one => one.textContent?.startsWith('Open “'))!.click())
  act(() => buttons.find(one => one.textContent === 'Cancel')!.click())
  expect(close).toHaveBeenCalledTimes(1)
  expect(close).toHaveBeenCalledWith(undefined)
  await act(async () => finish(true))
  expect(close).toHaveBeenCalledTimes(1)
})

it.each(['Cancel', 'Escape', 'unmount'])('ignores an old folder open after %s without settling a new choice (#1720)', async dismissal => {
  const { store } = rig()
  const pending: ((opened: boolean) => void)[] = []
  store.openWorkspace = vi.fn(() => new Promise<boolean>(resolve => { pending.push(resolve) }))
  let resolveChoice: ((chosen: boolean) => void) | null = null
  const close = (chosen = false) => {
    root.render(<StoreProvider store={store}>{null}</StoreProvider>)
    resolveChoice?.(chosen)
    resolveChoice = null
  }
  // App keeps one resolver, replacing it whenever a new picker is requested.
  const choose = () => new Promise<boolean>(resolve => {
    resolveChoice?.(false)
    resolveChoice = resolve
    root.render(<StoreProvider store={store}><FolderPicker onClose={close} /></StoreProvider>)
  })
  const button = (prefix: string) => [...document.querySelectorAll<HTMLButtonElement>('button')]
    .find(one => one.textContent?.startsWith(prefix))!
  let first!: Promise<boolean>
  await act(async () => { first = choose() })
  act(() => button('Open “').click())
  await act(async () => {
    if (dismissal === 'Cancel') button('Cancel').click()
    else if (dismissal === 'Escape') document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    else root.render(<StoreProvider store={store}>{null}</StoreProvider>)
  })
  expect(document.querySelector('[role="dialog"]')).toBeNull()
  if (dismissal !== 'unmount') await expect(first).resolves.toBe(false)

  const send = vi.fn()
  let second!: Promise<boolean>
  await act(async () => {
    second = choose()
    void second.then(chosen => { if (chosen) send() })
  })
  await act(async () => pending[0]!(true))
  expect(send).not.toHaveBeenCalled()
  expect(document.querySelector('[role="dialog"]')).not.toBeNull()
  act(() => button('Open “').click())
  await act(async () => pending[1]!(true))
  await expect(second).resolves.toBe(true)
  expect(send).toHaveBeenCalledTimes(1)
  expect(document.querySelector('[role="dialog"]')).toBeNull()
})
