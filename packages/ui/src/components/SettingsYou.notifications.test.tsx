import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it } from 'vitest'

import { StoreProvider } from '../state/context'
import { emptySnapshot, type AppSnapshot, type AppStore } from '../state/store'
import { kept } from '../lib/inbox'
import { emptyNoticePolicy, withMuted, withSurface, type NoticeSurface } from '../lib/notice-policy'
import { NotificationsSection } from './SettingsYou'

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

const mount = (over: Partial<AppSnapshot> = {}) => {
  let snapshot: AppSnapshot = { ...emptySnapshot(), preferencesLoaded: true, ...over }
  const listeners = new Set<() => void>()
  const patch = (next: Partial<AppSnapshot>) => {
    snapshot = { ...snapshot, ...next }
    for (const listener of listeners) listener()
  }
  const store = {
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    getSnapshot: () => snapshot,
    setNoticeSurface: (kind: string, surface: NoticeSurface | null) =>
      patch({ noticePolicy: withSurface(snapshot.noticePolicy, kind, surface) }),
    clearInbox: () => patch({ inbox: [] }),
    markInboxRead: () => {},
    startSuggestedTask: async () => {},
    setSystemNotification: () => {},
  }
  act(() => {
    root.render(
      <StoreProvider store={store as unknown as AppStore}>
        <NotificationsSection />
      </StoreProvider>,
    )
  })
  return { read: () => snapshot }
}

const select = (title: string) =>
  container.querySelector<HTMLSelectElement>(`select[aria-label='Where "${title}" is shown']`)!

const choose = (element: HTMLSelectElement, value: string) =>
  act(() => {
    element.value = value
    element.dispatchEvent(new Event('change', { bubbles: true }))
  })

it('keeps the guide folded while notification controls remain available', () => {
  mount()
  const text = container.textContent ?? ''
  expect(text).toContain('How messages reach you')
  const guide = [...container.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'How messages reach you')!
  expect(guide.getAttribute('aria-expanded')).toBe('false')
  expect(text).not.toContain('Shown on the composer of the conversation it stops, and nowhere else.')
  expect(text).toContain('When something stops a turn')
  expect(text).toContain('When there is something to do later')
  expect(select('Out of quota').value).toBe('composer')
  expect(container.querySelector('[aria-label="System notifications"]')).not.toBeNull()
})

it('opens all seven guide facts together and folds them with keyboard activation', () => {
  mount()
  const guide = [...container.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'How messages reach you')!
  const shell = guide.closest('[data-slot="rows"]')!
  expect(shell.children).toHaveLength(1)
  act(() => guide.click())
  expect(guide.getAttribute('aria-expanded')).toBe('true')
  expect(shell.children).toHaveLength(8)
  expect([...shell.children].slice(1).every(child => child.getAttribute('data-slot') === 'row')).toBe(true)
  for (const title of ['Something stops a turn', 'Something to do later', 'About one conversation', 'Worth keeping', 'An Agent writes to you', 'The result of what you did', 'The connection drops']) {
    expect(shell.textContent).toContain(title)
  }
  expect(shell.textContent?.match(/Always on\./g)).toHaveLength(2)
  expect(guide.querySelector('[data-slot="disclosure-chevron"]')?.hasAttribute('data-open')).toBe(true)

  act(() => {
    guide.focus()
    // jsdom does not synthesize the native button's click from Enter.
    // Preserve the uncancelled key, then supply the browser's keyboard click.
    const enter = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
    guide.dispatchEvent(enter)
    expect(enter.defaultPrevented).toBe(false)
    guide.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 0 }))
  })
  expect(guide.getAttribute('aria-expanded')).toBe('false')
  expect(shell.children).toHaveLength(1)
  expect(document.activeElement).toBe(guide)
  expect(select('Out of quota').value).toBe('composer')
})

it('each kind says where it is shown, offers only the places it may go, and Off', () => {
  mount()
  const spent = select('Out of quota')
  expect(spent.value).toBe('composer')
  expect([...spent.options].map((option) => option.value)).toEqual(['composer', 'strip', 'inbox', 'off'])
  expect(select('Import from your other runtimes').value).toBe('card')
})

it('states how many messages are muted in the summary row', () => {
  mount()
  const summary = () => [...container.querySelectorAll<HTMLElement>('[data-slot="row"]')]
    .find((row) => row.querySelector('[data-slot="row-title"]')?.textContent === 'Muted messages')
  expect(summary()?.querySelector('[data-slot="row-desc"]')?.textContent).toBe('None muted')

  mount({ noticePolicy: withMuted(emptyNoticePolicy(), 'usage:pace', true) })
  expect(summary()?.querySelector('[data-slot="row-desc"]')?.textContent).toBe('1 muted')
})

it('moving a kind or turning it off is written to the policy', () => {
  const { read } = mount()
  choose(select('On course to run out'), 'inbox')
  expect(read().noticePolicy.surfaces['usage:pace']).toBe('inbox')
  choose(select('On course to run out'), 'off')
  expect(read().noticePolicy.muted).toContain('usage:pace')
  expect(select('On course to run out').value).toBe('off')
})

it('says how many messages are kept and clears them', () => {
  const inbox = kept(kept([], { id: 'a', tone: 'info', title: 'A', at: 1 }), { id: 'b', tone: 'info', title: 'B', at: 2 })
  const { read } = mount({ inbox })
  expect(container.textContent).toContain('2 kept, 2 unread.')
  // The same unread dot the seat wears; the count remains accessible.
  expect(container.querySelector('[data-slot="inbox-button"]')?.textContent).toBe('Inbox, 2 unread')
  expect(container.querySelector('[data-slot="inbox-dot"]')).not.toBeNull()
  act(() => [...container.querySelectorAll('button')].find((button) => button.textContent === 'Clear')!.click())
  expect(read().inbox).toEqual([])
  expect(container.textContent).toContain('Nothing kept.')
})

it('a message from an Agent goes where the Agent asks, to the inbox only, or nowhere', () => {
  const { read } = mount()
  const agents = select('Messages from Agents')
  expect([...agents.options].map((option) => option.textContent)).toEqual(['Where the Agent asks', 'Inbox only', 'Off'])
  choose(agents, 'inbox')
  expect(read().noticePolicy.surfaces['agent:message']).toBe('inbox')
})
