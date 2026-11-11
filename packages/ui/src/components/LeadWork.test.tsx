import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it } from 'vitest'
import { LEAD_WORK_GROUP_LABELS } from '@harnessdesk/protocol'
import { StoreProvider } from '../state/context'
import { createLeadFixtureStore } from '../preview/frames-lead'
import { leadWorkFixture } from '../preview/lead-fixture'
import { LeadDetails } from './LeadDetails'
import { leadWorkGroups } from './LeadWork'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const clean: (() => void)[] = []
afterEach(() => { clean.splice(0).forEach(fn => fn()) })
const mount = async (scene: 'work-ledger' | 'empty') => {
  const store = createLeadFixtureStore(scene), box = document.createElement('div'); document.body.append(box)
  const root = createRoot(box)
  await act(async () => root.render(<StoreProvider store={store}><LeadDetails /></StoreProvider>))
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
  clean.push(() => { act(() => root.unmount()); box.remove() })
  return { box, store }
}
const groups = (box: HTMLElement) => [...box.querySelectorAll<HTMLElement>('[data-work-group]')].map(group => group.getAttribute('data-work-group'))
const items = (box: HTMLElement, group: string) => [...box.querySelectorAll(`[data-work-group="${group}"] [data-work-item]`)].map(row => row.getAttribute('data-work-item'))

it('groups the host board in the order the phone uses, Needs you first, and keeps a stage nobody set here', () => {
  expect(leadWorkGroups(leadWorkFixture).map(entry => entry.label)).toEqual([LEAD_WORK_GROUP_LABELS['needs-you'], 'Working', 'In review', 'Done'])
  expect(leadWorkGroups({ version: 1, more: 0, items: leadWorkFixture.items.filter(item => item.group !== 'needs-you') })[0]!.group).toBe('working')
})

it('draws the Work card in the rail from the host board: four groups, the wait on the line that earns it', async () => {
  const { box } = await mount('work-ledger')
  const card = box.querySelector<HTMLElement>('section[aria-label="Work"]')!
  expect(card).not.toBeNull()
  expect(groups(box)).toEqual(['needs-you', 'working', 'in-review', 'done', 'reminders'])
  expect(items(box, 'needs-you')).toEqual(['work-4'])
  expect(items(box, 'working')).toEqual(['work-3', 'work-5'])
  expect(card.textContent).toContain('Needs you · 1')
  expect(box.querySelector('[data-work-item="work-4"]')!.textContent).toContain('An approval waits for you')
  expect(box.querySelector('[data-work-item="work-3"]')!.textContent).not.toContain('A chat is working')
  expect(card.textContent).toContain('5')
})

it('Done closes the item through the host and it moves to Done; nothing else on the desk is touched', async () => {
  const { box, store } = await mount('work-ledger')
  const calls: string[] = []
  const request = store.transport.request.bind(store.transport)
  store.transport.request = (async (method: string, params: unknown) => { calls.push(method); return request(method as never, params as never) }) as typeof store.transport.request
  await act(async () => { box.querySelector<HTMLButtonElement>('[aria-label="Actions for Rename the status column"]')!.click() })
  const done = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(item => item.textContent?.startsWith('Done'))!
  expect(document.body.textContent).toContain('Closing leaves its chats, Teams and pull requests as they are.')
  await act(async () => { done.click(); await new Promise(resolve => setTimeout(resolve, 0)) })
  expect(calls).toEqual(['lead/work/close'])
  expect(groups(box)).toEqual(['working', 'in-review', 'done', 'reminders'])
  expect(items(box, 'done')).toEqual(['work-4', 'work-6', 'work-1'])
})

it('a working item’s menu stops its chat with the same stop the chat sends, and a stopped item says Stopped', async () => {
  const { box, store } = await mount('work-ledger')
  const calls: { method: string; params: unknown }[] = []
  const request = store.transport.request.bind(store.transport)
  store.transport.request = (async (method: string, params: unknown) => { calls.push({ method, params }); return request(method as never, params as never) }) as typeof store.transport.request
  expect(box.querySelector('[data-work-item="work-6"]')!.textContent).toContain('Stopped')
  expect(box.querySelector('[data-work-item="work-1"]')!.textContent).not.toContain('Stopped')
  await act(async () => { box.querySelector<HTMLButtonElement>('[aria-label="Actions for Rename the status column"]')!.click() })
  expect([...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].some(item => item.textContent?.startsWith('Stop'))).toBe(false)
  await act(async () => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) })
  await act(async () => { box.querySelector<HTMLButtonElement>('[aria-label="Actions for Make the empty state keyboard accessible"]')!.click() })
  const stop = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(item => item.textContent?.startsWith('Stop'))!
  expect(stop).toBeDefined()
  await act(async () => { stop.click(); await new Promise(resolve => setTimeout(resolve, 0)) })
  expect(calls.map(call => call.method)).toEqual(['turn/interrupt'])
  expect(calls[0]!.params).toMatchObject({ runtime: 'fixture', sessionId: 'chat-3' })
})

it('a reminder whose message was never written says Missed, and one still being said does not claim it was', async () => {
  const { box, store } = await mount('work-ledger')
  const fired = leadWorkFixture.reminders!.find(entry => entry.id === 'remind-1')!
  const { delivery: _said, deliveredAt: _at, ...waking } = fired
  await act(async () => { store.lead.changed({ method: 'lead/work/changed', params: { ...leadWorkFixture, reminders: [
    { ...fired, delivery: 'missed', deliveredAt: fired.firedAt! + 60_000 }, { ...waking, id: 'remind-4' }] } }) })
  const missed = box.querySelector<HTMLElement>('[data-work-reminder="remind-1"]')!, pending = box.querySelector<HTMLElement>('[data-work-reminder="remind-4"]')!
  expect(missed.textContent).toContain('Missed ')
  expect(missed.textContent).not.toMatch(/Said|Fired/)
  expect(pending.textContent).toContain('not said yet')
  expect(pending.textContent).not.toContain('Said ')
})

it('a live board from the host replaces the card, and no tracked work draws no card', async () => {
  const { box, store } = await mount('empty')
  expect(box.querySelector('section[aria-label="Work"]')).toBeNull()
  await act(async () => { store.lead.changed({ method: 'lead/work/changed', params: leadWorkFixture }) })
  expect(groups(box)).toEqual(['needs-you', 'working', 'in-review', 'done', 'reminders'])
})

const reminders = (box: HTMLElement) => [...box.querySelectorAll('[data-work-reminder]')].map(row => row.getAttribute('data-work-reminder'))

it('lists each reminder with when it is due or fired, and Cancel removes one through the host', async () => {
  const { box, store } = await mount('work-ledger')
  expect(reminders(box)).toEqual(['remind-2', 'remind-3', 'remind-1'])
  const set = box.querySelector<HTMLElement>('[data-work-reminder="remind-2"]')!, fired = box.querySelector<HTMLElement>('[data-work-reminder="remind-1"]')!
  const checkBack = box.querySelector<HTMLElement>('[data-work-reminder="remind-3"]')!
  expect(set.textContent).toContain('Send the changelog to the team')
  expect(set.textContent).toContain('Due ')
  expect(set.textContent).not.toContain('Fired')
  expect(set.textContent).not.toContain('Check-back')
  // The Lead's own check-back names the work by its title and says what kind it is, on the label's line.
  expect(checkBack.textContent).toContain('Check on Fix the retry status list')
  expect(checkBack.textContent).toContain('Check-back')
  expect(checkBack.textContent).not.toContain('work-2')
  // A person's reminder the Lead told them about says Said once, with its time, never Fired, and has nothing left to cancel.
  expect(fired.textContent?.match(/Said /g)).toHaveLength(1)
  expect(fired.textContent).not.toContain('Fired')
  expect(fired.querySelector('button')).toBeNull()
  const calls: { method: string; params: unknown }[] = []
  const request = store.transport.request.bind(store.transport)
  store.transport.request = (async (method: string, params: unknown) => { calls.push({ method, params }); return request(method as never, params as never) }) as typeof store.transport.request
  await act(async () => { set.querySelector<HTMLButtonElement>('button[aria-label^="Cancel reminder"]')!.click(); await new Promise(resolve => setTimeout(resolve, 0)) })
  expect(calls).toEqual([{ method: 'lead/reminder/cancel', params: { id: 'remind-2' } }])
  expect(reminders(box)).toEqual(['remind-3', 'remind-1'])
})

it('a reminder alone draws the card, so a reminder is never set where the person cannot see it', async () => {
  const { box, store } = await mount('empty')
  await act(async () => { store.lead.changed({ method: 'lead/work/changed', params: { version: 1, items: [], more: 0, reminders: [leadWorkFixture.reminders![0]!] } }) })
  expect(box.querySelector('section[aria-label="Work"]')).not.toBeNull()
  expect(reminders(box)).toEqual(['remind-2'])
})
