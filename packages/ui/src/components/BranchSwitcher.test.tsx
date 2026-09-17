import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { StoreProvider } from '../state/context'
import { emptySnapshot, type AppSnapshot, type AppStore } from '../state/store'
import { Menu } from '../design'
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
} = {}) => {
  const snapshot = { ...emptySnapshot(), status: 'open' } as AppSnapshot
  const branches = [
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
