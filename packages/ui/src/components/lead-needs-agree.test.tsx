import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import type { LeadInbox, LeadWindowProjection } from '@harnessdesk/protocol'
import { AppStore } from '../state/store'
import { StoreProvider } from '../state/context'
import { previewStore } from '../preview/harness'
import { leadProjection } from '../preview/lead-fixture'
import { InboxPanel } from '../design'
import { LeadSidebarEntry } from './LeadSidebarEntry'
import { useInboxWaiting } from './use-inbox-waiting'

const clean: (() => void)[] = []
afterEach(() => { for (const one of clean.splice(0)) one(); vi.useRealTimers() })

/** The Lead's row and the bell, side by side, as the sidebar draws them, over one store and one desk answer. */
const Both = () => {
  const waiting = useInboxWaiting()
  return <><LeadSidebarEntry selected={false} /><InboxPanel messages={[]} waiting={waiting.rows} needs={waiting.needs} /></>
}
const mount = async (projection: LeadWindowProjection, inbox: LeadInbox) => {
  vi.useFakeTimers()
  const store = new AppStore('ws://localhost:0/'), box = document.createElement('div'); document.body.append(box)
  Object.assign(store.getSnapshot(), previewStore({ leadAvailable: true }).getSnapshot())
  store.lead.changed({ method: 'lead/changed', params: projection })
  vi.spyOn(store.transport, 'request').mockImplementation(async (method: string) => (method === 'lead/inbox/read' ? inbox : projection) as never)
  const root = createRoot(box)
  await act(async () => root.render(<StoreProvider store={store}><Both /></StoreProvider>))
  await act(async () => { vi.advanceTimersByTime(1000) })
  clean.push(() => { act(() => root.unmount()); box.remove() })
  const lead = box.querySelector('[data-slot="left-column-row"], [role="button"], a, button')?.textContent ?? ''
  const bell = box.querySelector('[data-slot="inbox-button"]')?.textContent ?? ''
  return { text: box.textContent ?? '', lead, bell }
}
const action = (id: string) => ({ id, kind: 'approve-publication', title: `Approve ${id}` })

it('three approvals: the Lead\'s row and the bell say the same number', async () => {
  const base = leadProjection()
  const projection = { ...base, stage: 'you-answer', personActions: [action('a1'), action('a2'), action('a3')] } as unknown as LeadWindowProjection
  const inbox: LeadInbox = { version: 1, needsYou: 3, items: [{ id: 'lead', kind: 'lead', title: 'Dex is waiting for you', at: 1, needsYou: true, count: 3 }] }
  const { text, bell } = await mount(projection, inbox)
  expect(text).toContain('3 need you')
  expect(bell).toBe('Inbox, 3 need you')
})

it('one Team waiting and the Lead at rest: the Lead\'s row and the bell say the same number', async () => {
  const base = leadProjection()
  const projection = { ...base, stage: 'idle', personActions: [], thread: { ...base.thread, state: 'draft', cards: [], messages: [] } } as unknown as LeadWindowProjection
  const inbox: LeadInbox = { version: 1, needsYou: 1, items: [{ id: 'team:goal-game', kind: 'team', title: 'build a game', project: 'Widgets', at: 1, needsYou: true, target: 'goal-game' }] }
  const { text, bell } = await mount(projection, inbox)
  expect(text).toContain('1 needs you')
  expect(bell).toBe('Inbox, 1 needs you')
})
