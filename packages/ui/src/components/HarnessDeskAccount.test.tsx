import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { HarnessDeskAccountStatus } from '@harnessdesk/protocol'
import { StoreProvider } from '../state/context'
import { emptySnapshot, type AppStore } from '../state/store'
import { HarnessDeskAccountSection } from './HarnessDeskAccount'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let container: HTMLDivElement
let root: Root
beforeEach(() => { container = document.createElement('div'); document.body.append(container); root = createRoot(container) })
afterEach(() => { act(() => root.unmount()); container.remove() })
const account: HarnessDeskAccountStatus = {
  status: 'signedIn', account: { name: 'Jane Doe', email: 'jane@example.com', pictureUrl: null },
  desk: { name: 'Jane’s MacBook Pro', reachable: true },
  phones: [{ deviceId: 'AAAAAAAAAAAAAAAAAAAAAA', name: 'iPhone', lastSeenAt: null }],
}
const mount = (status = account, sidebarCollapsed = false) => {
  const setHarnessDeskReachable = vi.fn(async () => {})
  const unlinkHarnessDeskPhone = vi.fn(async () => {})
  const renameHarnessDesk = vi.fn(async () => {})
  const signInToHarnessDesk = vi.fn(async () => {})
  const signOutOfHarnessDesk = vi.fn(async () => {})
  const snapshot = { ...emptySnapshot(), harnessDeskAccount: status, sidebarCollapsed }
  const store = { subscribe: () => () => {}, getSnapshot: () => snapshot,
    setHarnessDeskReachable, unlinkHarnessDeskPhone, renameHarnessDesk, signInToHarnessDesk, signOutOfHarnessDesk,
  } as unknown as AppStore
  act(() => root.render(<StoreProvider store={store}><HarnessDeskAccountSection /></StoreProvider>))
  return { setHarnessDeskReachable, unlinkHarnessDeskPhone, renameHarnessDesk, signInToHarnessDesk, signOutOfHarnessDesk }
}
const button = (name: string) => [...document.querySelectorAll<HTMLButtonElement>('button')].find(one => one.textContent === name)!
it('shows the account, desk and linked phones; keeps unavailable code pairing honest', () => {
  mount()
  expect(container.textContent).toContain('jane@example.com')
  expect(container.textContent).toContain('Jane’s MacBook Pro')
  expect(container.textContent).toContain('iPhone')
  expect(container.textContent).toContain('Sign in on your phone with the same account to add another.')
  expect(container.textContent).toContain('Not available in this build')
  expect(button('Show code').disabled).toBe(true)
})
it('updates phone reachability through the host', async () => {
  const { setHarnessDeskReachable } = mount()
  await act(async () => container.querySelector<HTMLButtonElement>('[role="switch"]')!.click())
  expect(setHarnessDeskReachable).toHaveBeenCalledWith(false)
})
it('confirms a phone unlink before removing its access', async () => {
  const { unlinkHarnessDeskPhone } = mount()
  act(() => button('Unlink').click())
  expect(unlinkHarnessDeskPhone).not.toHaveBeenCalled()
  const dialog = document.querySelector('[role="alertdialog"]')!
  expect(dialog.textContent).toContain('Unlink iPhone?')
  await act(async () => [...dialog.querySelectorAll('button')].find(one => one.textContent === 'Unlink')!.click())
  expect(unlinkHarnessDeskPhone).toHaveBeenCalledWith('AAAAAAAAAAAAAAAAAAAAAA')
})
it('offers sign-in while signed out without offering account-only controls', async () => {
  const { signInToHarnessDesk } = mount({ status: 'signedOut', desk: { name: 'Demo desk', reachable: false }, phones: [] })
  await act(async () => button('Sign in…').click())
  expect(signInToHarnessDesk).toHaveBeenCalledOnce()
  expect(container.querySelector('[role="switch"]')).toBeNull()
})

it('formats host last-seen timestamps as Unix seconds', () => {
  mount({ ...account, phones: [{ ...account.phones[0]!, lastSeenAt: Math.floor(Date.now() / 1000) - 120 }] })
  expect(container.textContent).toContain('Last seen 2m ago')
})
it('opens an eighty-character desk rename field and only writes on confirmation', async () => {
  const { renameHarnessDesk } = mount()
  act(() => button('Rename').click())
  const dialog = document.querySelector('[role="dialog"]')!
  const field = dialog.querySelector<HTMLInputElement>('input[aria-label="Desk name"]')!
  expect(field.maxLength).toBe(80)
  expect(renameHarnessDesk).not.toHaveBeenCalled()
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(field, 'Demo laptop')
    field.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await act(async () => [...dialog.querySelectorAll('button')].find(one => one.textContent === 'Rename')!.click())
  expect(renameHarnessDesk).toHaveBeenCalledWith('Demo laptop')
})

it('leaves the pending sign-in banner to the visible sidebar', () => {
  mount({ status: 'pending', desk: account.desk, phones: [], pending: { userCode: 'ABCD-EFGH', verifyUrl: 'https://app.harnessdesk.app/link#code=ABCD-EFGH', expiresAt: Math.floor(Date.now() / 1000) + 60 } })
  expect(container.textContent).not.toContain('Finish in your browser')
})

it('offers desk-only sign-out after the cloud is unreachable and explains the remaining account link', async () => {
  const { signOutOfHarnessDesk } = mount()
  signOutOfHarnessDesk.mockRejectedValueOnce(Object.assign(new Error('The account service could not be reached.'), { code: 'accountCloudUnreachable' }))
  act(() => button('Sign out…').click())
  expect(button('Sign out on this desk only')).toBeUndefined()
  await act(async () => button('Sign out').click())
  const dialog = document.querySelector('[role="alertdialog"]')!
  expect(dialog.textContent).toContain('This desk stays linked to your account until you unlink it from another device.')
  await act(async () => button('Sign out on this desk only').click())
  expect(signOutOfHarnessDesk).toHaveBeenLastCalledWith(true)
  expect(document.querySelector('[role="alertdialog"]')).toBeNull()
})

it('keeps other sign-out failures retryable without offering desk-only sign-out', async () => {
  const { signOutOfHarnessDesk } = mount()
  signOutOfHarnessDesk.mockRejectedValueOnce(new Error('Secure storage is unavailable.'))
  act(() => button('Sign out…').click())
  await act(async () => button('Sign out').click())
  expect(document.querySelector('[role="alertdialog"]')?.textContent).toContain('Secure storage is unavailable.')
  expect(button('Sign out on this desk only')).toBeUndefined()
  await act(async () => button('Sign out').click())
  expect(signOutOfHarnessDesk).toHaveBeenLastCalledWith()
  expect(document.querySelector('[role="alertdialog"]')).toBeNull()
})

it('names the configured cloud host in the pending sign-in banner', () => {
  mount({ status: 'pending', desk: account.desk, phones: [], pending: { userCode: 'ABCD-EFGH', verifyUrl: 'https://app-staging.harnessdesk.app/link#code=ABCD-EFGH', expiresAt: Math.floor(Date.now() / 1000) + 60 } }, true)
  expect(container.textContent).toContain('Sign in on app-staging.harnessdesk.app.')
  expect(container.textContent).not.toContain('app.harnessdesk.app')
})

it.each(['not a URL', 'javascript:alert(1)', 'file:///tmp/link'])('uses a generic browser instruction for an invalid approval URL: %s', verifyUrl => {
  mount({ status: 'pending', desk: account.desk, phones: [], pending: { userCode: 'ABCD-EFGH', verifyUrl, expiresAt: Math.floor(Date.now() / 1000) + 60 } }, true)
  expect(container.textContent).toContain('Sign in using your browser.')
  expect(container.textContent).not.toContain('app.harnessdesk.app')
})
