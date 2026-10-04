import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import noticeCss from './Notices.module.css?raw'

const { toast } = vi.hoisted(() => {
  const toast = Object.assign(vi.fn(), { error: vi.fn(), warning: vi.fn(), promise: vi.fn() })
  return { toast }
})
vi.mock('../ui/toast', () => ({ toast }))

import { ComposerNotice, InboxList, InboxPanel, NoticeCard, NoticeStrip, showProgress, showToast, type NoticeMessage } from './Notices'

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

it('gives one-line composer copy a control-height box and moves its lead only when copy wraps', () => {
  expect(noticeCss).toMatch(/\.composer\s*\{[^}]*align-items:\s*center/s)
  expect(noticeCss).toMatch(/\.composer \.line\s*\{[^}]*min-height:\s*var\(--hd-btn-h-sm\)/s)
  expect(noticeCss).toMatch(/\.composer \.lineText\s*\{[^}]*overflow-wrap:\s*anywhere/s)
  expect(noticeCss).toMatch(/\.lineText\s*\{[^}]*min-width:\s*0/s)
  expect(noticeCss).toMatch(/\.composer\[data-wrapped\] > \[data-slot='notice-lead'\]\s*\{[^}]*align-self:\s*flex-start/s)
})

it('lets unbreakable card copy wrap while the one-line strip stays clipped', () => {
  expect(noticeCss).toMatch(/\.card \[data-part='notice-title'\]\s*\{[^}]*overflow-wrap:\s*anywhere/s)
  expect(noticeCss).toMatch(/\.cardBody\s*\{[^}]*overflow-wrap:\s*anywhere/s)
  expect(noticeCss).toMatch(/\.strip \.line\s*\{[^}]*overflow:\s*hidden[^}]*white-space:\s*nowrap[^}]*text-overflow:\s*ellipsis/s)
})

const button = (name: string) =>
  [...host.querySelectorAll('button')].find((node) => node.getAttribute('aria-label') === name || node.textContent?.trim().startsWith(name)) as HTMLButtonElement

it('shows one card at a time, says how many wait, and pages between them', async () => {
  const onDismiss = vi.fn()
  await act(() => root.render(<NoticeCard messages={[update, offer]} onDismiss={onDismiss} />))
  expect(host.textContent).toContain('Relaunch to update')
  expect(host.querySelector('[data-part="notice-title"][data-slot="text"][data-role="subject"]')?.textContent).toBe('Relaunch to update')
  expect(host.textContent).not.toContain('Skills to share')
  expect(host.textContent).toContain('1 of 2')
  expect(host.querySelector('[data-slot="notice-pager"]')?.getAttribute('role')).toBe('toolbar')
  await act(() => button('Next message').click())
  expect(host.textContent).toContain('Skills to share')
  await act(() => button('Dismiss').click())
  expect(onDismiss).toHaveBeenCalledWith('offer')
})

it('uses one pager tab stop and moves it by toolbar keys, skipping disabled buttons', async () => {
  await act(() => root.render(<NoticeCard messages={[update, offer, { ...offer, id: 'third' }]} onDismiss={() => {}} />))
  const previous = button('Previous message')
  const next = button('Next message')
  const press = async (target: HTMLButtonElement, key: string) => {
    await act(() => target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true })))
  }

  expect([previous.tabIndex, next.tabIndex]).toEqual([-1, 0])
  await press(next, 'ArrowLeft')
  expect(document.activeElement).toBe(next) // Previous is disabled at the first page.
  await act(() => next.click())
  expect(host.textContent).toContain('2 of 3')

  await press(next, 'Home')
  expect(document.activeElement).toBe(previous)
  expect([previous.tabIndex, next.tabIndex]).toEqual([0, -1])
  await press(previous, 'End')
  expect(document.activeElement).toBe(next)
  await press(next, 'ArrowLeft')
  expect(document.activeElement).toBe(previous)
  await press(previous, 'ArrowLeft')
  expect(document.activeElement).toBe(next)
})

it('keeps inbox notice leads full size in a first-line-height wrapper', async () => {
  await act(() => root.render(<InboxList messages={[{ ...offer, read: false }]} />))
  const lead = host.querySelector('[data-size="md"]')
  expect(lead?.parentElement?.className).toContain('h-(--hd-line-sm)')
  expect(lead?.querySelector('svg')?.getAttribute('width')).toBe('14')
})

it('pulls each trailing notice glyph to the surface text edge', async () => {
  await act(() => root.render(<NoticeStrip messages={[update, offer]} onDismiss={() => {}} />))
  for (const name of ['Next message', 'Dismiss']) {
    expect(button(name).className).toContain('me-(--edge-pull)')
  }

  await act(() => root.render(<InboxList messages={[{ ...offer, read: false }]} onMarkAllRead={() => {}} onClear={() => {}} />))
  expect(button('Clear the inbox').className).toContain('me-(--edge-pull)')
  expect(host.querySelector('[data-slot="inbox-list"]')?.hasAttribute('data-surface')).toBe(true)
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
  await act(() => root.render(<InboxPanel messages={[offer, update, { ...offer, id: 'third' }]} />))
  const bell = host.querySelector('[data-slot="inbox-button"]')
  expect(bell?.hasAttribute('data-unread')).toBe(true)
  expect(bell?.textContent).toBe('Inbox, 3 unread')
  expect(bell?.querySelector('[aria-hidden]')).not.toBeNull()
  await act(() => root.render(<InboxPanel messages={[{ ...offer, read: true }]} />))
  expect(host.querySelector('[data-slot="inbox-button"]')?.hasAttribute('data-unread')).toBe(false)
})

it('lets the header use the rail target while the default Inbox keeps its target', async () => {
  await act(() => root.render(<InboxPanel messages={[]} size="icon-xs" side="bottom" />))
  expect(host.querySelector('button')?.className).toContain('size-(--hd-icon-target)')
  expect(host.querySelector('button')?.querySelector('.sr-only')?.textContent).toBe('Inbox')
  expect(host.querySelector('button')?.title).toBe('Inbox')
  await act(() => root.render(<InboxPanel messages={[]} />))
  expect(host.querySelector('button')?.className).toContain('size-(--hd-btn-h-sm)')
})

it('the inbox marks a message read when it is opened, and says so when empty', async () => {
  const onOpen = vi.fn()
  await act(() => root.render(<InboxList messages={[{ ...offer, at: 0 }, { ...update, read: true, at: 0 }]} onOpen={onOpen} now={5 * 60_000} />))
  const items = host.querySelectorAll('li')
  expect(items[0]?.hasAttribute('data-unread')).toBe(true)
  expect(items[1]?.hasAttribute('data-unread')).toBe(false)
  expect(items[0]?.querySelector('[data-slot="text"][data-role="row"]')?.textContent).toBe('Skills to share')
  expect(host.querySelector('[data-part="inbox-heading"][data-slot="text"][data-role="subject"]')?.textContent).toBe('Inbox')
  expect(items[0]?.querySelector('time')?.textContent).toBe(new Date(0).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }))
  await act(() => host.querySelector<HTMLButtonElement>('[title="Mark read"]')!.click())
  expect(onOpen).toHaveBeenCalledWith('offer')
  expect(host.textContent).toContain('· 1 new')
  expect(host.querySelector('button[aria-expanded="true"]')).not.toBeNull()
  await act(() => root.render(<InboxList messages={[]} />))
  expect(host.textContent).toContain('Nothing kept yet')
})

it('a toast takes the same message, by tone', () => {
  showToast({ tone: 'danger', title: 'Could not save', body: 'The disk is full.' })
  expect(toast.error).toHaveBeenCalledWith('Could not save', { description: 'The disk is full.' })
  showToast({ title: 'Backup saved', action: { label: 'Show', onSelect: () => {} } })
  expect(toast).toHaveBeenCalledWith('Backup saved', expect.objectContaining({ action: expect.objectContaining({ label: 'Show' }) }))
})

it('a message from an Agent leads with its face instead of the tone dot', async () => {
  await act(() => root.render(<ComposerNotice message={{ id: 'agent', title: 'Opus wants a decision.', mark: <span data-testid="face">O</span> }} />))
  expect(host.querySelector('[data-testid="face"]')).toBeTruthy()
  expect(host.querySelector('svg')).toBeNull()
  expect(host.querySelector('[data-testid="face"]')?.parentElement?.parentElement?.className).toContain('h-(--hd-line)')
  // It is a face, so it takes the shape chosen for faces; a tone's icon does not.
  expect(host.querySelector('[data-testid="face"]')?.parentElement?.getAttribute('data-shape')).toBe('face')
})

it('a tone leads with its icon in the plain tile, not a face', async () => {
  await act(() => root.render(<ComposerNotice message={{ id: 'plain', title: 'Reconnecting.', tone: 'warning' }} />))
  expect(host.querySelector('svg')?.parentElement?.hasAttribute('data-shape')).toBe(false)
})

it('work that takes a moment is one toast that turns into how it ended', () => {
  const work = Promise.resolve(4)
  showProgress(work, { working: 'Importing skills…', done: (count) => `Imported ${count} skills.`, failed: 'Could not import.' })
  expect(toast.promise).toHaveBeenCalledWith(work, expect.objectContaining({ loading: 'Importing skills…', error: 'Could not import.' }))
})

it('expands a kept message in place, with its count, detail and actions', async () => {
  const opened = vi.fn()
  const muted = vi.fn()
  await act(() => root.render(<InboxList messages={[{ id: 'config', title: 'Ignored two settings', body: 'Runs without them.', count: 3, at: 1, read: false, actions: [{ label: 'Open the file', onSelect: opened }, { label: "Don't show this again", onSelect: muted }] }]} onOpen={() => {}} now={1000} />))
  expect(host.textContent).toContain('×3')
  expect(host.textContent).not.toContain('Runs without them.')
  await act(() => button('Ignored two settings').click())
  expect(button('Ignored two settings').getAttribute('aria-expanded')).toBe('true')
  expect(host.textContent).toContain('Runs without them.')
  await act(() => button('Open the file').click())
  expect(opened).toHaveBeenCalledOnce()
  expect(button('Ignored two settings').getAttribute('aria-expanded')).toBe('true')
  await act(() => button("Don't show this again").click())
  expect(muted).toHaveBeenCalledOnce()
})
