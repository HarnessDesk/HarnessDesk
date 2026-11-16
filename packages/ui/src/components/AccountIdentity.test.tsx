import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import type { HarnessDeskAccountStatus } from '@harnessdesk/protocol'
import { StoreProvider } from '../state/context'
import { emptySnapshot, type AppStore } from '../state/store'
import { HarnessDeskAccountSection } from './HarnessDeskAccount'
import { AppearanceSection, GeneralSection } from './SettingsYou'
import { PersonFace } from '../design'
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let container: HTMLDivElement, root: Root
beforeEach(() => { container = document.createElement('div'); document.body.append(container); root = createRoot(container) })
afterEach(() => { act(() => root.unmount()); container.remove() })
const account: HarnessDeskAccountStatus = { status: 'signedIn', account: { id: 'jane', name: 'Jane Doe', nickname: 'Jane at work', email: 'jane@example.com', pictureUrl: null }, desk: { name: 'Work Mac', reachable: false }, phones: [] }
const button = (label: string) => [...document.querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent === label)!
const input = () => document.querySelector<HTMLInputElement>('input')!
const type = (value: string) => act(() => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input(), value); input().dispatchEvent(new Event('input', { bubbles: true })) })
const mount = (node: ReactNode = <HarnessDeskAccountSection />, status = account, appIcon: unknown = 'wizard') => {
  let snapshot = { ...emptySnapshot(), harnessDeskAccount: status, appIcon }
  const listeners = new Set<() => void>()
  const patch = (next: Partial<typeof snapshot>) => { snapshot = { ...snapshot, ...next }; listeners.forEach(one => one()) }
  const updateHarnessDeskProfile = vi.fn(async (nickname: string | null) => { patch({ harnessDeskAccount: { ...account, account: { ...account.account!, nickname } } }) })
  const renameHarnessDesk = vi.fn(async (_name: string) => {})
  const setAppIcon = vi.fn((icon: unknown) => patch({ appIcon: icon }))
  const store = { getSnapshot: () => snapshot, subscribe: (one: () => void) => { listeners.add(one); return () => listeners.delete(one) }, updateHarnessDeskProfile, renameHarnessDesk, setAppIcon } as unknown as AppStore
  act(() => root.render(<StoreProvider store={store}>{node}</StoreProvider>))
  return { patch, updateHarnessDeskProfile, renameHarnessDesk, setAppIcon, snapshot: () => snapshot }
}
it('Account shows the committed display name and email with explicit cancel/save and empty reset', async () => {
  const { updateHarnessDeskProfile, snapshot } = mount()
  expect(container.textContent).toContain('Jane at work')
  expect(container.textContent).toContain('Display name')
  expect(container.textContent).toContain('jane@example.com')
  expect(container.textContent).not.toContain('This desk')
  expect(container.textContent).not.toContain('Local profile')
  expect(container.querySelector('[role="radiogroup"]')).toBeNull()
  act(() => button('Edit').click()); type('Draft')
  act(() => input().blur())
  expect(updateHarnessDeskProfile).not.toHaveBeenCalled()
  act(() => button('Cancel').click())
  act(() => button('Edit').click()); expect(input().value).toBe('Jane at work'); type('  ')
  await act(async () => button('Save').click())
  expect(updateHarnessDeskProfile).toHaveBeenCalledWith(null)
  expect(snapshot().harnessDeskAccount.account?.name).toBe('Jane Doe')
  expect(document.querySelector('[role="dialog"]')).toBeNull()
  expect(container.textContent).toContain('Jane Doe')
})
it('failed save retains draft and committed identity; switching accounts closes stale edits/errors', async () => {
  const { updateHarnessDeskProfile, patch } = mount()
  updateHarnessDeskProfile.mockRejectedValueOnce(new Error('Try again.'))
  act(() => button('Edit').click()); type('New name')
  await act(async () => button('Save').click())
  expect(input().value).toBe('New name')
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain('Try again.')
  expect(container.textContent).toContain('Jane at work')
  act(() => patch({ harnessDeskAccount: { ...account, account: { ...account.account!, id: 'other', nickname: 'Demo Person' } } }))
  expect(document.querySelector('[role="dialog"]')).toBeNull()
  expect(document.body.textContent).not.toContain('Try again.')
})
it('IME Enter does not save, ordinary Enter saves a trimmed nickname', async () => {
  const { updateHarnessDeskProfile } = mount()
  act(() => button('Edit').click()); type('  Jane  ')
  await act(async () => input().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true, cancelable: true })))
  expect(updateHarnessDeskProfile).not.toHaveBeenCalled()
  await act(async () => input().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })))
  expect(updateHarnessDeskProfile).toHaveBeenCalledWith('Jane')
})
it('General offers signed-out rename and retains the failed draft', async () => {
  const { renameHarnessDesk } = mount(<GeneralSection rows={null} />, { status: 'signedOut', desk: account.desk, phones: [] })
  expect(container.textContent).toContain('This desk'); expect(container.textContent).toContain('Work Mac')
  act(() => button('Rename').click()); expect(input().maxLength).toBe(80); type('Travel Mac')
  renameHarnessDesk.mockRejectedValueOnce(new Error('Could not rename.'))
  await act(async () => [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find(one => one.textContent === 'Rename')!.click())
  expect(renameHarnessDesk).toHaveBeenCalledWith('Travel Mac'); expect(input().value).toBe('Travel Mac')
  expect(container.textContent).toContain('Work Mac')
})
it('Appearance opens artwork in a dialog and preserves unknown values until an explicit choice', () => {
  const { setAppIcon } = mount(<AppearanceSection />, account, 'future-icon')
  expect(container.querySelector('[data-slot="picture-choices"]')).toBeNull()
  act(() => button('Change…').click())
  const dialog = document.querySelector('[role="dialog"]')!
  expect(dialog.textContent).toContain('cannot draw')
  expect(dialog.querySelector('[role="radio"][aria-checked="true"]')).toBeNull()
  act(() => dialog.querySelector<HTMLButtonElement>('[aria-label="Wizard"]')!.click())
  expect(setAppIcon).toHaveBeenCalledWith('wizard')
  act(() => button('Restore default').click()); expect(setAppIcon).toHaveBeenLastCalledWith(null)
  act(() => button('Done').click()); expect(document.querySelector('[role="dialog"]')).toBeNull()
})
it('missing, unsafe and failed person pictures never show app artwork', () => {
  for (const url of [undefined, 'https://example.com/photo.png', 'data:image/png;base64,AAAA']) {
    act(() => root.render(<PersonFace pictureDataUrl={url} size={24} />))
    const picture = container.querySelector('img')
    if (picture) act(() => picture.dispatchEvent(new Event('error')))
    expect(container.querySelector('img')).toBeNull()
    expect(container.querySelector('.brand-harnessdesk')).toBeNull()
    expect(container.querySelector('svg')).not.toBeNull()
  }
})

it('an older signed-in profile without id or email still opens its display-name editor', () => {
  mount(undefined, { ...account, account: { name: 'Jane Doe', email: null, pictureUrl: null } })
  act(() => button('Edit').click())
  expect(document.querySelector('[role="dialog"]')).not.toBeNull()
})
