import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it } from 'vitest'

import { StoreProvider } from '../state/context'
import { emptySnapshot, type AppSnapshot, type AppStore } from '../state/store'
import { kept } from '../lib/inbox'
import { withSurface, type NoticeSurface } from '../lib/notice-policy'
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

it('opens on what each kind of message is for, then groups the kinds by it', () => {
  mount()
  const text = container.textContent ?? ''
  expect(text).toContain('How messages reach you')
  expect(text.indexOf('When something stops a turn')).toBeGreaterThan(text.indexOf('How messages reach you'))
  expect(text).toContain('When there is something to do later')
})

it('each kind says where it is shown, offers only the places it may go, and Off', () => {
  mount()
  const spent = select('Out of quota')
  expect(spent.value).toBe('composer')
  expect([...spent.options].map((option) => option.value)).toEqual(['composer', 'strip', 'inbox', 'off'])
  expect(select('Import from your other agents').value).toBe('card')
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
  // The kept messages themselves, not only their count.
  expect(container.querySelectorAll('[data-slot="inbox-list"] li')).toHaveLength(2)
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
