import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { runtimeId, sessionKey, type LeadMessageRef } from '@harnessdesk/protocol'
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

it('finds a Team the reply names by its room, the way the phone does, when the desk lists it by its goal', () => {
  // The desk lists a goal's board under the goal's id; the Lead's tools name the Team by its room (the board's own id).
  const listed: LeadRefDesk = { ...desk, teams: new Map([['goal-9', { id: 'room-build', name: 'build a game' } as never]]),
    goals: new Map([['goal-9', { goal: { id: 'goal-9', sentence: 'Build a small game' }, board: { id: 'room-build', name: 'build a game' } } as never]]) }
  expect(leadRefLinks([{ kind: 'team', id: 'room-build', title: 'Team' }], listed).map(link => [link.label, link.target])).toEqual([
    ['build a game', { kind: 'goal', id: 'goal-9' }],
  ])
  expect(leadRefLinks([{ kind: 'goal', id: 'room-build' }], listed).map(link => link.target)).toEqual([{ kind: 'goal', id: 'goal-9' }])
  // Named both ways in one reply, it is still one link.
  expect(leadRefLinks([{ kind: 'team', id: 'room-build' }, { kind: 'goal', id: 'goal-9' }], listed)).toHaveLength(1)
})

it('a reply with no refs links the Team and chat its words name, as the phone does (#2149)', () => {
  const sessions = new Map([[sessionKey('fixture', 'chat-7'), { id: 'chat-7', runtime: runtimeId('fixture'), title: 'Tidy the release notes' }]]) as never
  const named = { ...desk, sessions }
  const text = '"Restore keyboard focus" 团队任务：状态是需要你处理。 I also finished Tidy the release notes.'
  expect(leadRefLinks([], named, text).map(link => [link.label, link.target])).toEqual([
    ['Restore keyboard focus', { kind: 'goal', id: 'goal-1' }],
    ['Tidy the release notes', { kind: 'chat', runtime: runtimeId('fixture'), session: 'chat-7' }],
  ])
  // A reply that carries refs is linked by them alone, never by its words as well.
  expect(leadRefLinks([{ kind: 'team', id: 'room-docs' }], named, text).map(link => link.label)).toEqual(['Docs for Jane Doe'])
})
