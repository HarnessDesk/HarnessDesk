import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { StoreProvider } from '../state/context'
import { emptySnapshot, type AppStore } from '../state/store'
import { BranchCreateDialog } from './BranchCreateDialog'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let container: HTMLDivElement
let root: Root
beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(() => { act(() => root.unmount()); container.remove() })

const rig = (checkoutBranch = vi.fn(async () => true)) => {
  const snapshot = emptySnapshot()
  const store = { subscribe: () => () => {}, getSnapshot: () => snapshot, checkoutBranch } as unknown as AppStore
  const onDone = vi.fn(), onClose = vi.fn()
  act(() => root.render(<StoreProvider store={store}><BranchCreateDialog root="/code/storefront" onDone={onDone} onClose={onClose} /></StoreProvider>))
  const input = document.querySelector<HTMLInputElement>('input')!
  const type = (value: string) => act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  const button = (label: string) => [...document.querySelectorAll<HTMLButtonElement>('button')].find(one => one.textContent === label)!
  return { input, type, button, checkoutBranch, onDone, onClose }
}

it('trims the branch name, submits Enter once while busy, and closes after success', async () => {
  let resolve!: (value: boolean) => void
  const checkoutBranch = vi.fn(() => new Promise<boolean>(done => { resolve = done }))
  const host = rig(checkoutBranch)
  expect(host.button('Create').disabled).toBe(true)
  host.type('  feature/search  ')
  const enter = () => host.input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
  act(() => { enter() })
  act(() => { enter(); host.button('Create').click() })
  expect(checkoutBranch).toHaveBeenCalledTimes(1)
  expect(checkoutBranch).toHaveBeenCalledWith('/code/storefront', 'feature/search', { create: true })
  expect(host.button('Keep current branch').disabled).toBe(true)
  expect(host.onClose).not.toHaveBeenCalled()
  await act(async () => resolve(true))
  expect(host.onDone).toHaveBeenCalledOnce()
  expect(host.onClose).toHaveBeenCalledOnce()
})

it.each([false, new Error('Branch already exists.')])('keeps creation refusal visible and allows retry (%s)', async failure => {
  const checkoutBranch = vi.fn().mockImplementationOnce(async () => {
    if (failure instanceof Error) throw failure
    return failure
  }).mockResolvedValue(true)
  const host = rig(checkoutBranch)
  host.type('feature/search')
  await act(async () => host.button('Create').click())
  const alert = document.querySelector('[role="alert"]')!
  expect(alert.textContent).toContain(failure instanceof Error ? failure.message : 'Could not create feature/search.')
  expect(host.onClose).not.toHaveBeenCalled()
  await act(async () => host.button('Create').click())
  expect(host.onClose).toHaveBeenCalledOnce()
})

it('keeps the branch without calling checkout on cancel', () => {
  const host = rig()
  act(() => host.button('Keep current branch').click())
  expect(host.onClose).toHaveBeenCalledOnce()
  expect(host.checkoutBranch).not.toHaveBeenCalled()
})
