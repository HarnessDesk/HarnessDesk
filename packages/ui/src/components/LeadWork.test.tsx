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
  expect(groups(box)).toEqual(['needs-you', 'working', 'in-review', 'done'])
  expect(items(box, 'needs-you')).toEqual(['work-4'])
  expect(items(box, 'working')).toEqual(['work-3', 'work-5'])
  expect(card.textContent).toContain('Needs you · 1')
  expect(box.querySelector('[data-work-item="work-4"]')!.textContent).toContain('An approval waits for you')
  expect(box.querySelector('[data-work-item="work-3"]')!.textContent).not.toContain('A Team is working')
  expect(card.textContent).toContain('4')
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
  expect(groups(box)).toEqual(['working', 'in-review', 'done'])
  expect(items(box, 'done')).toEqual(['work-4', 'work-1'])
})

it('a live board from the host replaces the card, and no tracked work draws no card', async () => {
  const { box, store } = await mount('empty')
  expect(box.querySelector('section[aria-label="Work"]')).toBeNull()
  await act(async () => { store.lead.changed({ method: 'lead/work/changed', params: leadWorkFixture }) })
  expect(groups(box)).toEqual(['needs-you', 'working', 'in-review', 'done'])
})
