import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { runtimeId, type LeadMessageRef } from '@harnessdesk/protocol'
import { createLeadFixtureStore } from '../preview/frames-lead'
import { leadRuntime, leadWorkFixture } from '../preview/lead-fixture'
import { StoreProvider } from '../state/context'
import { LeadRefs, leadRefLinks, type LeadRefDesk } from './LeadRefs'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const clean: (() => void)[] = []
afterEach(() => { clean.splice(0).forEach(fn => fn()); vi.restoreAllMocks() })

const work = { ...leadWorkFixture, items: [
  ...leadWorkFixture.items.filter(item => item.id === 'work-3'),
  { ...leadWorkFixture.items.find(item => item.id === 'work-2')!, links: { chats: [], teams: [], prs: ['acme/widgets#42'], issues: [] } },
  { ...leadWorkFixture.items.find(item => item.id === 'work-6')!, links: { chats: [], teams: ['room-gone'], prs: [], issues: [] } },
] }
const desk: LeadRefDesk = {
  runtimes: [leadRuntime], sessions: new Map(), chats: new Set(['fixture:chat-3']), work,
  teams: new Map([['room-docs', { id: 'room-docs', name: 'Docs for Jane Doe' } as never]]),
  goals: new Map([['goal-1', { goal: { id: 'goal-1', sentence: 'Restore keyboard focus' } } as never]]),
}

it('links only what the desk has, under the desk\'s own names, once each', () => {
  const refs: LeadMessageRef[] = [
    { kind: 'work', id: 'work-3', title: 'A title the model made up' },
    { kind: 'team', id: 'room-docs', title: '<b>Model name</b>' },
    { kind: 'goal', id: 'goal-1' },
    { kind: 'team', id: 'room-gone', title: 'Not on this desk' },
    { kind: 'chat', id: 'other:chat-9', title: 'Unknown runtime' },
    { kind: 'session', id: 'fixture:chat-unknown' },
    { kind: 'chat', id: 'fixture:chat-3', title: 'Same chat as work-3' },
    { kind: 'work', id: 'work-2' },
    { kind: 'work', id: 'work-6' },
  ]
  expect(leadRefLinks(refs, desk).map(link => [link.label, link.target.kind])).toEqual([
    ['Make the empty state keyboard accessible', 'chat'],
    ['Docs for Jane Doe', 'team'],
    ['Restore keyboard focus', 'goal'],
    ['Fix the retry status list', 'pr'],
  ])
})

it('names a known chat with no desk title by the model\'s title, as plain text', () => {
  const [link] = leadRefLinks([{ kind: 'session', id: 'fixture:chat-3', title: '\x1b[31mReview\n  pass' }], desk)
  expect(link?.label).toBe('Review pass')
  expect(link?.target).toEqual({ kind: 'chat', runtime: runtimeId('fixture'), session: 'chat-3' })
})

it('a reply\'s refs open the chat they name on this desk', async () => {
  const store = createLeadFixtureStore('work-ledger'), box = document.createElement('div'); document.body.append(box)
  const open = vi.spyOn(store, 'openSession').mockResolvedValue(undefined as never)
  const root = createRoot(box)
  await act(async () => root.render(<StoreProvider store={store}><LeadRefs refs={[{ kind: 'work', id: 'work-3' }, { kind: 'team', id: 'room-gone' }]} /></StoreProvider>))
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
  clean.push(() => { act(() => root.unmount()); box.remove() })
  const links = [...box.querySelectorAll<HTMLButtonElement>('[data-slot="lead-refs"] button')]
  expect(links.map(link => link.textContent)).toEqual(['Make the empty state keyboard accessible'])
  await act(async () => links[0]!.click())
  expect(open).toHaveBeenCalledWith('chat-3', { runtime: 'fixture' })
})
