import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { StoreProvider } from '../state/context'
import { emptySnapshot, type AppSnapshot, type AppStore } from '../state/store'
import { Menu, Submenu } from '../design'
import { BranchSwitcher } from './BranchSwitcher'

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

const rig = async (options: {
  checkoutBranch?: (root: string, branch: string, opts: { create: boolean }) => Promise<boolean>
  branches?: readonly { name: string; current: boolean; committedAt: number }[]
} = {}) => {
  const snapshot = { ...emptySnapshot(), status: 'open' } as AppSnapshot
  const branches = options.branches ?? [
    { name: 'main', current: true, committedAt: 1000 },
    { name: 'feature/alpha', current: false, committedAt: 2000 },
    { name: 'feature/beta', current: false, committedAt: 3000 },
  ]
  const checkoutBranch = options.checkoutBranch ?? vi.fn(async () => true)
  const store = {
    subscribe: () => () => {},
    getSnapshot: () => snapshot,
    listBranches: vi.fn(async () => branches),
    checkoutBranch,
  } as unknown as AppStore

  const onDone = vi.fn()

  await act(async () => {
    root.render(
      <StoreProvider store={store}>
        <Menu close={onDone}>
          <BranchSwitcher root="/repo" onDone={onDone} />
        </Menu>
      </StoreProvider>,
    )
  })

  return { store, checkoutBranch, onDone }
}

it('disables the in-flight branch and prevents duplicate checkouts (#391)', async () => {
  let resolveCheckout!: (val: boolean) => void
  const pendingCheckout = new Promise<boolean>((resolve) => {
    resolveCheckout = resolve
  })

  const checkoutBranch = vi.fn(() => pendingCheckout)
  await rig({ checkoutBranch })

  const items = [...container.querySelectorAll<HTMLButtonElement>('button[role="menuitemradio"]')]
  expect(items).toHaveLength(3)

  const alphaBtn = items.find((btn) => btn.textContent?.includes('feature/alpha'))!
  expect(alphaBtn).toBeDefined()
  expect(alphaBtn.getAttribute('aria-disabled')).not.toBe('true')

  // Click feature/alpha to start checkout
  act(() => {
    alphaBtn.click()
  })

  expect(checkoutBranch).toHaveBeenCalledTimes(1)
  expect(checkoutBranch).toHaveBeenCalledWith('/repo', 'feature/alpha', { create: false })

  // While in flight, feature/alpha itself must be disabled!
  expect(alphaBtn.getAttribute('aria-disabled')).toBe('true')
  expect(alphaBtn.textContent).toContain('…')

  // Clicking it again while in flight must not trigger another checkout
  act(() => {
    alphaBtn.click()
  })
  expect(checkoutBranch).toHaveBeenCalledTimes(1)

  // Resolve checkout
  await act(async () => {
    resolveCheckout(true)
  })
})

it('announces a failed checkout in the canonical alert', async () => {
  await rig({ checkoutBranch: vi.fn(async () => false) })

  const alpha = [...container.querySelectorAll<HTMLButtonElement>('button[role="menuitemradio"]')]
    .find((button) => button.textContent?.includes('feature/alpha'))
  await act(async () => {
    alpha?.click()
  })

  const alert = container.querySelector('[data-slot="alert"]')
  expect(alert?.getAttribute('role')).toBe('alert')
  expect(alert?.textContent).toContain(
    'Could not switch to feature/alpha. The working tree may have uncommitted changes.',
  )
})

const delayedRig = async (entry = 'ArrowRight') => {
  // The flyout is drawn before the list is read, with one row in it: the
  // create row at its foot. → lands there, where Enter lands too, and the
  // branches arriving above it do not take the focus from it.
  let read!: (list: readonly { name: string; current: boolean; committedAt: number }[]) => void
  const store = {
    subscribe: () => () => {},
    getSnapshot: () => ({ ...emptySnapshot(), status: 'open' }) as AppSnapshot,
    listBranches: vi.fn(() => new Promise((resolve) => { read = resolve })),
    checkoutBranch: vi.fn(async () => true),
  } as unknown as AppStore
  act(() => {
    root.render(
      <StoreProvider store={store}>
        <Menu close={() => {}}>
          <Submenu label="Branch main">
            <BranchSwitcher root="/repo" onDone={() => {}} />
          </Submenu>
        </Menu>
      </StoreProvider>,
    )
  })
  const frame = () => act(async () => { await new Promise((resolve) => requestAnimationFrame(resolve)) })
  const button = (label: string) =>
    [...document.querySelectorAll<HTMLButtonElement>('button')].find((node) => node.textContent?.startsWith(label))
  await frame()
  const row = button('Branch main')!
  act(() => row.focus())
  act(() => {
    row.dispatchEvent(new KeyboardEvent('keydown', { key: entry, bubbles: true }))
    // jsdom does not generate a native button's click from Enter.
    if (entry === 'Enter') row.click()
  })
  await frame()
  expect(row.getAttribute('aria-expanded')).toBe('true')
  expect(document.activeElement).toBe(button('Create and checkout new branch'))
  // The list may take longer than Submenu's three-frame step-in window.
  for (let i = 0; i < 4; i++) await frame()

  return { read, button, frame }
}

it.each([
  ['ArrowRight', 'ArrowUp'], ['ArrowRight', 'ArrowDown'],
  ['Enter', 'ArrowUp'], ['Enter', 'ArrowDown'],
])('%s step-in: the first %s after delayed branches arrive moves from Create (#782)', async (entry, key) => {
  const { read, button, frame } = await delayedRig(entry)
  await act(async () => {
    read([
      { name: 'main', current: true, committedAt: 1000 },
      { name: 'feature/alpha', current: false, committedAt: 2000 },
    ])
  })
  await frame()
  expect(button('feature/alpha')).toBeDefined()
  expect(document.activeElement).toBe(button('Create and checkout new branch'))
  expect(document.activeElement?.hasAttribute('data-highlighted')).toBe(true)
  act(() => {
    document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }))
  })
  await frame()
  const target = button(key === 'ArrowUp' ? 'feature/alpha' : 'main')
  expect(document.activeElement).toBe(target)
  expect(target?.hasAttribute('data-highlighted')).toBe(true)
})

it('keeps navigation usable with no matches and after clearing the filter', async () => {
  await rig({ branches: Array.from({ length: 6 }, (_, index) => ({
    name: index === 0 ? 'main' : `feature/${index}`,
    current: index === 0,
    committedAt: 1000,
  })) })
  const search = container.querySelector<HTMLInputElement>('input')!
  const setQuery = (value: string) => act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(search, value)
    search.dispatchEvent(new Event('input', { bubbles: true }))
  })
  setQuery('no-matching-branch')
  expect(container.textContent).toContain('No branch matches.')
  const create = [...container.querySelectorAll<HTMLButtonElement>('button')]
    .find((button) => button.textContent?.startsWith('Create and checkout'))!
  act(() => create.focus())
  for (const key of ['ArrowUp', 'ArrowDown']) {
    await act(async () => {
      create.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }))
      await new Promise((resolve) => requestAnimationFrame(resolve))
    })
    expect(document.activeElement).toBe(create)
  }
  setQuery('')
  await act(async () => { await new Promise((resolve) => requestAnimationFrame(resolve)) })
  act(() => {
    create.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }))
  })
  expect(document.activeElement?.textContent).toContain('feature/5')
})

it('does not take focus from the create field when branches arrive', async () => {
  const { read, button, frame } = await delayedRig()
  act(() => button('Create and checkout new branch')!.click())
  const input = document.querySelector<HTMLInputElement>('input[placeholder="new-branch-name"]')!
  expect(document.activeElement).toBe(input)
  await act(async () => { read([{ name: 'main', current: true, committedAt: 1000 }]) })
  await frame()
  expect(document.activeElement).toBe(input)
})

it('keeps the search autofocus when a searchable list arrives', async () => {
  const { read, frame } = await delayedRig()
  await act(async () => {
    read(Array.from({ length: 6 }, (_, index) => ({
      name: `feature/${index}`, current: index === 0, committedAt: 1000,
    })))
  })
  await frame()
  expect(document.activeElement).toBe(document.querySelector('input[placeholder="Search repo branches"]'))
})
