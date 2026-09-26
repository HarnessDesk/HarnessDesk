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

beforeEach(() => {
  store = new AppStore('ws://localhost:0/')
  requests = []
  vi.spyOn(store.transport, 'request').mockImplementation((async (method: HostMethodName, params: unknown) => {
    requests.push({ method, params })
    if (method === 'workspace/open') return { path: '/repo', name: 'repo', lastOpenedAt: 1 }
    if (method === 'workspace/recent') return []
    if (method === 'session/create') return { id: 'new-1', runtime: 'codex', cwd: '/repo', status: { type: 'idle' }, createdAt: 0, updatedAt: 0, turns: [], itemsLoaded: true }
    return null
  }) as never)
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

it('a decision waits on its conversation’s composer, and can be put away', () => {
  push(notice({ id: 'd1', where: 'composer', title: 'A or B?' }))
  expect(store.getSnapshot().agentNotices.map((entry) => entry.id)).toEqual(['d1'])
  expect(store.getSnapshot().inbox).toHaveLength(0)
  store.dismissAgentNotice('d1')
  expect(store.getSnapshot().agentNotices).toHaveLength(0)
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
