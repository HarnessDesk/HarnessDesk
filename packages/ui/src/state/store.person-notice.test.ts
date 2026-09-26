import { beforeEach, expect, it, vi } from 'vitest'

import type { HostMethodName, PersonNotice } from '@harnessdesk/protocol'

import { withSurface } from '../lib/notice-policy'
import { AppStore } from './store'

/**
 * A message an Agent sent the person, as a window routes it: the person's
 * setting for "Messages from Agents" decides between the sending
 * conversation's composer, the inbox, and nowhere.
 */

let store: AppStore
let requests: { method: string; params: unknown }[]

beforeEach(async () => {
  store = new AppStore('ws://localhost:0/')
  requests = []
  vi.spyOn(store.transport, 'request').mockImplementation((async (method: HostMethodName, params: unknown) => {
    requests.push({ method, params })
    if (method === 'workspace/open') return { path: '/repo', name: 'repo', lastOpenedAt: 1 }
    if (method === 'workspace/recent') return []
    if (method === 'session/create') return { id: 'new-1', runtime: 'codex', cwd: '/repo', status: { type: 'idle' }, createdAt: 0, updatedAt: 0, turns: [], itemsLoaded: true }
    if (method === 'app/state/get') return {}
    return null
  }) as never)
  // A message routes by the real policy, which only exists once preferences
  // have answered — exactly as a launched window would have by the time any
  // of this could arrive. See the `queues a message that arrives too early`
  // test below for what happens when one does not wait for this.
  await store.loadPreferences()
  requests.length = 0
})

const push = (notice: PersonNotice) =>
  (store.transport as unknown as { handlers: { onNotification(notification: unknown): void } }).handlers.onNotification({
    method: 'person/notice',
    params: { notice },
  })

const notice = (over: Partial<PersonNotice> = {}): PersonNotice => ({
  id: 'codex/s1:1',
  from: { runtime: 'codex', sessionId: 's1', name: 'Checkout hardening' },
  where: 'inbox',
  title: 'Five cards done',
  at: 1,
  ...over,
})

it('news goes to the inbox, attributed and unread, and is kept once however many windows hear it', () => {
  push(notice({ task: 'Review PR 971' }))
  push(notice({ task: 'Review PR 971' }))
  const inbox = store.getSnapshot().inbox
  expect(inbox).toHaveLength(1)
  expect(inbox[0]).toMatchObject({ kind: 'agent:message', read: false, task: 'Review PR 971', from: { name: 'Checkout hardening' } })
  // Kept in host preferences, which is what survives a relaunch.
  expect(requests.some((request) => request.method === 'app/state/set' && JSON.stringify(request.params).includes('Five cards done'))).toBe(true)
})

it('a decision waits on its conversation’s composer, is kept in the inbox too, and dismissing it there marks both read', () => {
  push(notice({ id: 'd1', where: 'composer', title: 'A or B?' }))
  expect(store.getSnapshot().agentNotices.map((entry) => entry.id)).toEqual(['d1'])
  // Kept under the same id, unread, so a question asked of a conversation
  // nobody is watching is never lost to it.
  expect(store.getSnapshot().inbox.map((entry) => entry.id)).toEqual(['d1'])
  expect(store.getSnapshot().inbox[0]?.read).toBe(false)
  store.dismissAgentNotice('d1')
  expect(store.getSnapshot().agentNotices).toHaveLength(0)
  expect(store.getSnapshot().inbox[0]?.read).toBe(true)
})

it('"Inbox only" keeps even a decision in the inbox, and Off drops it', () => {
  ;(store as unknown as { setNoticeSurface(kind: string, surface: 'inbox' | null): void }).setNoticeSurface('agent:message', 'inbox')
  push(notice({ id: 'd2', where: 'composer', title: 'A or B?' }))
  expect(store.getSnapshot().agentNotices).toHaveLength(0)
  expect(store.getSnapshot().inbox.map((entry) => entry.id)).toEqual(['d2'])
  store.setNoticeSurface('agent:message', null)
  push(notice({ id: 'd3' }))
  expect(store.getSnapshot().inbox.map((entry) => entry.id)).toEqual(['d2'])
  expect(withSurface).toBeTypeOf('function')
})

it('a suggested task starts a conversation on the sender’s runtime whose first message is the task, and reads the message', async () => {
  await store.openWorkspace('/repo')
  push(notice({ task: 'Review PR 971' }))
  await store.startSuggestedTask('codex/s1:1')
  const started = requests.find((request) => request.method === 'session/create')
  expect(started?.params).toMatchObject({ runtime: 'codex' })
  const sent = requests.find((request) => request.method === 'turn/send')
  expect(JSON.stringify(sent?.params)).toContain('Review PR 971')
  expect(store.getSnapshot().inbox[0]?.read).toBe(true)
})

/**
 * A message can arrive before `loadPreferences` answers — the host pushes it
 * the moment it happens, with no regard for how far a given window has got
 * through its own startup. Judging it against the snapshot's starting
 * guesses — an empty inbox, an unmuted policy — used to both drop whatever
 * `app/state/set` was about to write over the real inbox once it loaded, and
 * ignore a mute the real policy would have honoured. It has to wait.
 */
const withPendingPreferences = () => {
  const early = new AppStore('ws://localhost:0/')
  let resolvePreferences: (value: unknown) => void = () => {}
  vi.spyOn(early.transport, 'request').mockImplementation((async (method: HostMethodName) => {
    if (method === 'app/state/get') return new Promise((resolve) => { resolvePreferences = resolve })
    return null
  }) as never)
  const loaded = early.loadPreferences()
  const pushEarly = (one: PersonNotice) =>
    (early.transport as unknown as { handlers: { onNotification(notification: unknown): void } }).handlers.onNotification({
      method: 'person/notice',
      params: { notice: one },
    })
  return { early, loaded, pushEarly, resolvePreferences: (preferences: unknown) => resolvePreferences(preferences) }
}

it('queues a message that arrives before preferences answer, rather than judging it by the snapshot’s starting guesses', async () => {
  const { early, loaded, pushEarly, resolvePreferences } = withPendingPreferences()
  pushEarly(notice({ id: 'early-1' }))
  // Not yet: the policy that would place it has not been read back.
  expect(early.getSnapshot().inbox).toHaveLength(0)
  expect(early.getSnapshot().preferencesLoaded).toBe(false)
  resolvePreferences({
    inbox: [{ id: 'kept-earlier', tone: 'neutral', title: 'From before this launch', at: 0, read: true }],
  })
  await loaded
  // Applied once the real inbox is in hand, merged into it rather than
  // replacing it — the previous launch's message is still there.
  expect(early.getSnapshot().inbox.map((entry) => entry.id)).toEqual(['early-1', 'kept-earlier'])
})

it('drops a queued message once preferences say its kind is muted', async () => {
  const { early, loaded, pushEarly, resolvePreferences } = withPendingPreferences()
  pushEarly(notice({ id: 'muted-1' }))
  resolvePreferences({ noticePolicy: { muted: ['agent:message'], records: {}, seen: [], surfaces: {}, kept: [] } })
  await loaded
  expect(early.getSnapshot().inbox).toHaveLength(0)
})
