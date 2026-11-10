import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it } from 'vitest'
import type { LeadMemoryCandidate, LeadMessage } from '@harnessdesk/protocol'
import { createLeadFixtureStore } from '../preview/frames-lead'
import { StoreProvider } from '../state/context'
import { LeadMemoryProposals, LeadMemorySection, leadCitedEntries, leadMemoryForgetAllText, leadMemoryForgetText, leadMemoryPlacement } from './LeadMemory'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const clean: (() => void)[] = []
afterEach(() => clean.splice(0).forEach(fn => fn()))
const settle = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
const mount = async (node: (store: ReturnType<typeof createLeadFixtureStore>) => React.ReactNode, scene: Parameters<typeof createLeadFixtureStore>[0] = 'settings-memory') => {
  const store = createLeadFixtureStore(scene), box = document.createElement('div'); document.body.append(box)
  const calls: { method: string; params: any }[] = []
  const request = store.transport.request.bind(store.transport)
  store.transport.request = (async (method: string, params: unknown) => { calls.push({ method, params }); return request(method as never, params as never) }) as typeof store.transport.request
  const root = createRoot(box)
  await act(async () => root.render(<StoreProvider store={store}>{node(store)}</StoreProvider>))
  await settle()
  clean.push(() => { act(() => root.unmount()); box.remove() })
  return { box, calls, store }
}
const button = (box: ParentNode, label: string) => [...box.querySelectorAll('button')].find(one => one.textContent === label)!
const changes = (calls: { method: string; params: any }[]) => calls.filter(call => call.method === 'lead/memory/change').map(call => call.params)

const message = (id: string, revision: number, role: LeadMessage['role'] = 'assistant'): LeadMessage => ({ version: 1, id, revision, role, text: id })
const candidate = (id: string, afterSeq: number): LeadMemoryCandidate => ({ id, text: id, kind: 'fact', source: { kind: 'message', id }, proposedAt: 1, afterSeq })

it('places a proposal under the first Lead reply after it, else under the latest reply, and nowhere without a reply', () => {
  const thread = [message('ask', 1, 'user'), message('first', 2), message('ask-2', 3, 'user'), message('second', 4)]
  const placed = leadMemoryPlacement(thread, [candidate('early', 1), candidate('middle', 3), candidate('late', 9)])
  expect([...placed].map(([id, list]) => [id, list.map(one => one.id)])).toEqual([['first', ['early']], ['second', ['middle', 'late']]])
  expect(leadMemoryPlacement([message('only-person', 1, 'user')], [candidate('waiting', 0)]).size).toBe(0)
})

it('reads the entries a plan cites by their ids', () => {
  expect([...leadCitedEntries([{ type: 'plan', title: 'Add the export (m2), as kept (m12)' } as never])]).toEqual(['m2', 'm12'])
  expect(leadCitedEntries([{ type: 'result', title: '(m1)' } as never]).size).toBe(0)
})

it('Keep, Edit and No under a reply each send one change to the desk', async () => {
  const proposal = candidate('Run the linter before asking for review.', 1)
  const { box, calls } = await mount(() => <LeadMemoryProposals candidates={[{ ...proposal, id: 'c9' }]} />, 'memory-proposal')
  expect(box.textContent).toContain('Run the linter before asking for review.')
  await act(async () => button(box, 'Edit').click())
  const input = box.querySelector<HTMLInputElement>('input[aria-label="Note to keep"]')!
  expect(input.maxLength).toBe(400)
  await act(async () => { const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!; set.call(input, 'Run the linter and the type check first.'); input.dispatchEvent(new Event('input', { bubbles: true })) })
  await act(async () => button(box, 'Keep').click())
  await settle()
  expect(changes(calls)).toEqual([{ action: 'keep', id: 'c9', text: 'Run the linter and the type check first.' }])
})

it('Settings lists To review, then Core with its size, then Archive and History, and the switch starts off', async () => {
  const { box } = await mount(() => <LeadMemorySection label="Dex" />)
  const text = box.textContent!
  expect([...box.querySelectorAll('[data-slot="section-name"]')].map(node => node.textContent)).toEqual(['To review', 'Core', 'Archive', 'History'])
  expect(text).toContain('1.2 of 6.0 KB')
  expect(text).toContain("Dex's note")
  expect(box.querySelector<HTMLElement>('[role="switch"]')!.getAttribute('aria-checked')).toBe('false')
})

it('Keep, Undo and the switch go through the desk, and Forget all asks first', async () => {
  const { box, calls } = await mount(() => <LeadMemorySection label="Dex" />)
  await act(async () => button(box, 'Keep').click()); await settle()
  await act(async () => box.querySelector<HTMLElement>('[role="switch"]')!.click()); await settle()
  await act(async () => button(box, 'Undo').click()); await settle()
  expect(changes(calls)).toEqual([{ action: 'keep', id: 'c9' }, { action: 'auto', on: true }, { action: 'undo', version: 7 }])
  await act(async () => button(box, 'Forget all').click())
  expect(changes(calls).length).toBe(3)
  const dialog = document.querySelector('[role="alertdialog"], [role="dialog"]')!
  expect(dialog.textContent).toContain('cannot be undone')
  await act(async () => button(dialog, 'Forget all').click()); await settle()
  expect(changes(calls).at(-1)).toEqual({ action: 'forget-all' })
})

it('Forget on one entry asks first, saying it cannot be undone, and sends nothing until confirmed', async () => {
  const { box, calls } = await mount(() => <LeadMemorySection label="Dex" />)
  await act(async () => button(box, 'Forget').click())
  expect(changes(calls)).toEqual([])
  const dialog = document.querySelector('[role="alertdialog"], [role="dialog"]')!
  expect(dialog.textContent).toContain('cannot be undone')
  await act(async () => button(dialog, 'Keep note').click()); await settle()
  expect(changes(calls)).toEqual([])
  await act(async () => button(box, 'Forget').click())
  await act(async () => button(document.querySelector('[role="alertdialog"], [role="dialog"]')!, 'Forget').click()); await settle()
  expect(changes(calls)).toEqual([{ action: 'forget', id: expect.stringMatching(/^m\d+$/) }])
})

it('says so in a banner when the Lead is not reading the list shown', async () => {
  const { box } = await mount(store => {
    const request = store.transport.request.bind(store.transport)
    store.transport.request = (async (method: string, params: unknown) => {
      const value = await request(method as never, params as never)
      return method === 'lead/memory/view' ? { ...(value as object), fault: 'journal' } : value
    }) as typeof store.transport.request
    return <LeadMemorySection label="Dex" />
  })
  const alert = box.querySelector('[role="alert"]')!
  expect(alert.textContent).toContain('Dex')
  expect(alert.textContent).toMatch(/not reading/i)
})

it('the Forget confirmations say exactly what goes and what stays, as the desk does it', async () => {
  // Pinned against packages/server/test/lead-memory.test.ts ("Forget removes the note, every version of it ...") and
  // docs/data-boundaries.md: change all three together.
  expect(leadMemoryForgetText('Dex')).toBe('Removes the note, every saved version of it and any passage of the conversation that quotes it, so search cannot find them. ' +
    "The conversation it came from stays, and so does the record in Dex's journal on this desk. This cannot be undone.")
  expect(leadMemoryForgetAllText('Dex')).toBe('Removes every note, every proposal and every saved version, and empties the copy of the conversation Dex searches. ' +
    "Dex's journal on this desk keeps its record. This cannot be undone.")
  const { box } = await mount(() => <LeadMemorySection label="Dex" />)
  await act(async () => button(box, 'Forget').click())
  expect(document.querySelector('[role="alertdialog"], [role="dialog"]')!.textContent).toContain(leadMemoryForgetText('Dex'))
})
