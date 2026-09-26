import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const { toast } = vi.hoisted(() => {
  const toast = Object.assign(vi.fn(), { error: vi.fn(), warning: vi.fn() })
  return { toast }
})
vi.mock('../ui/toast', () => ({ toast }))

import { ComposerNotice, InboxButton, InboxList, NoticeCard, NoticeStrip, showToast, type NoticeMessage } from './Notices'

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(async () => {
  await act(() => root.unmount())
  document.body.innerHTML = ''
  vi.clearAllMocks()
})

const update: NoticeMessage = { id: 'update', tone: 'info', title: 'Relaunch to update', body: 'HarnessDesk 0.2.5 is ready.', action: { label: 'Relaunch', onSelect: vi.fn(), shortcut: '⌘R' } }
const offer: NoticeMessage = { id: 'offer', title: 'Skills to share', body: 'Nothing is copied until you confirm.' }

const button = (name: string) =>
  [...host.querySelectorAll('button')].find((node) => node.getAttribute('aria-label') === name || node.textContent?.trim().startsWith(name)) as HTMLButtonElement

it('shows one card at a time, says how many wait, and pages between them', async () => {
  const onDismiss = vi.fn()
  await act(() => root.render(<NoticeCard messages={[update, offer]} onDismiss={onDismiss} />))
  expect(host.textContent).toContain('Relaunch to update')
  expect(host.textContent).not.toContain('Skills to share')
  expect(host.textContent).toContain('1 of 2')
  await act(() => button('Next message').click())
  expect(host.textContent).toContain('Skills to share')
  await act(() => button('Dismiss').click())
  expect(onDismiss).toHaveBeenCalledWith('offer')
})

it('a single card has no pager, and its action carries its shortcut', async () => {
  await act(() => root.render(<NoticeCard messages={[update]} onDismiss={() => {}} />))
  expect(host.textContent).not.toContain('1 of 1')
  expect(host.querySelector('kbd')?.textContent).toBe('⌘R')
  await act(() => button('Relaunch').click())
  expect(update.action?.onSelect).toHaveBeenCalled()
})

it('a composer notice wears its tone and says its action as a link', async () => {
  await act(() => root.render(<ComposerNotice message={{ id: 'pace', tone: 'warning', title: 'On course to run out.', action: { label: 'Switch agent', onSelect: () => {} } }} />))
  const notice = host.querySelector('[data-slot="composer-notice"]')
  expect(notice?.getAttribute('data-tone')).toBe('warning')
  expect(notice?.getAttribute('role')).toBe('status')
  expect(button('Switch agent')).toBeTruthy()
})

it('a strip shows one message and pages like the card', async () => {
  await act(() => root.render(<NoticeStrip messages={[update, offer]} onDismiss={() => {}} />))
  expect(host.textContent).toContain('Relaunch to update')
  await act(() => button('Next message').click())
  expect(host.textContent).toContain('Skills to share')
})

it('the inbox bell says how many are unread and tints itself only then', async () => {
  await act(() => root.render(<InboxButton unread={3} />))
  const bell = host.querySelector('[data-slot="inbox-button"]')
  expect(bell?.getAttribute('aria-label')).toBe('Inbox, 3 unread')
  expect(bell?.hasAttribute('data-unread')).toBe(true)
  await act(() => root.render(<InboxButton unread={0} />))
  expect(host.querySelector('[data-slot="inbox-button"]')?.hasAttribute('data-unread')).toBe(false)
})

it('the inbox marks a message read when it is opened, and says so when empty', async () => {
  const onOpen = vi.fn()
  await act(() => root.render(<InboxList messages={[{ ...offer, at: 0 }, { ...update, read: true, at: 0 }]} onOpen={onOpen} now={5 * 60_000} />))
  const items = host.querySelectorAll('li')
  expect(items[0]?.hasAttribute('data-unread')).toBe(true)
  expect(items[1]?.hasAttribute('data-unread')).toBe(false)
  expect(items[0]?.querySelector('time')?.textContent).toBe('5m')
  await act(() => button('Mark read').click())
  expect(onOpen).toHaveBeenCalledWith('offer')
  await act(() => root.render(<InboxList messages={[]} />))
  expect(host.textContent).toContain('Nothing kept.')
})

it('a toast takes the same message, by tone', () => {
  showToast({ tone: 'danger', title: 'Could not save', body: 'The disk is full.' })
  expect(toast.error).toHaveBeenCalledWith('Could not save', { description: 'The disk is full.' })
  showToast({ title: 'Backup saved', action: { label: 'Show', onSelect: () => {} } })
  expect(toast).toHaveBeenCalledWith('Backup saved', expect.objectContaining({ action: expect.objectContaining({ label: 'Show' }) }))
})
