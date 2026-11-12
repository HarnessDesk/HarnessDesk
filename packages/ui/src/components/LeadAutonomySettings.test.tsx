import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it } from 'vitest'
import { createLeadFixtureStore } from '../preview/frames-lead'
import { StoreProvider } from '../state/context'
import { LeadAutonomySection } from './LeadAutonomySettings'
import { LeadRulesSection } from './LeadRulesSettings'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const clean: (() => void)[] = []
afterEach(() => clean.splice(0).forEach(fn => fn()))
const settle = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
const mount = async (node: React.ReactNode, scene: Parameters<typeof createLeadFixtureStore>[0] = 'settings-autonomy') => {
  const store = createLeadFixtureStore(scene), box = document.createElement('div'); document.body.append(box)
  const calls: { method: string; params: any }[] = []
  const request = store.transport.request.bind(store.transport)
  store.transport.request = (async (method: string, params: unknown) => { calls.push({ method, params }); return request(method as never, params as never) }) as typeof store.transport.request
  const root = createRoot(box)
  if (scene === 'waiting') await store.lead.readThread()
  await act(async () => root.render(<StoreProvider store={store}>{node}</StoreProvider>))
  await settle()
  clean.push(() => { act(() => root.unmount()); box.remove() })
  return { box, calls }
}

it('lists the five kinds with their mode, and says what Observe does once', async () => {
  const { box } = await mount(<LeadAutonomySection />)
  for (const title of ['Desk-change reports', 'Stuck nudges', 'Repeat runs', 'Mention triggers', 'Morning brief']) expect(box.textContent).toContain(title)
  expect(box.querySelectorAll('select').length).toBe(5)
  expect(box.textContent).toContain('Observe writes what the Lead would have done')
  expect(box.textContent).toContain('Would have said a run had gone quiet.')
})

it('choosing a mode is saved through the host and shown', async () => {
  const { box, calls } = await mount(<LeadAutonomySection />)
  const select = box.querySelector<HTMLSelectElement>('select[aria-label="Repeat runs"]')!
  await act(async () => { select.value = 'off'; select.dispatchEvent(new Event('change', { bubbles: true })) })
  await settle()
  expect(calls.filter(call => call.method === 'lead/autonomy/set').map(call => call.params)).toEqual([{ kind: 'repeat', mode: 'off' }])
  expect(select.value).toBe('off')
})

it('rules: three sections; an edit is saved against its version and appears in the history, and Reset returns the default', async () => {
  const { box, calls } = await mount(<LeadRulesSection />)
  for (const title of ['How to talk to me', 'What to delegate and to whom', 'What counts as done']) expect(box.textContent).toContain(title)
  expect(box.textContent).toContain('Edited')
  const edit = [...box.querySelectorAll<HTMLElement>('button')].filter(one => one.textContent === 'Edit')[2]!
  await act(async () => { edit.click() })
  const area = document.body.querySelector<HTMLTextAreaElement>('textarea[aria-label="What counts as done"]')!
  expect(document.body.textContent).toContain("Takes effect at the Lead's next epoch")
  await act(async () => {
    const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
    set.call(area, 'Tests pass and I looked.'); area.dispatchEvent(new Event('input', { bubbles: true }))
  })
  const save = [...document.body.querySelectorAll<HTMLElement>('button')].find(one => one.textContent === 'Save')!
  await act(async () => { save.click() })
  await settle()
  expect(calls.find(call => call.method === 'lead/rules/update')!.params).toEqual({ section: 'done', action: 'edit', text: 'Tests pass and I looked.', expectedVersion: 0 })
  expect(document.body.textContent).toContain('Version 1')
  const reset = [...document.body.querySelectorAll<HTMLElement>('button')].find(one => one.textContent === 'Reset to default')!
  await act(async () => { reset.click() })
  await settle()
  expect(calls.filter(call => call.method === 'lead/rules/update').at(-1)!.params).toEqual({ section: 'done', action: 'reset', expectedVersion: 1 })
})

it('rules: View full prompt shows exactly what the next epoch will carry', async () => {
  const { box } = await mount(<LeadRulesSection />)
  await act(async () => { [...box.querySelectorAll<HTMLElement>('button')].find(one => one.textContent === 'Edit')!.click() })
  await act(async () => { [...document.body.querySelectorAll<HTMLElement>('button')].find(one => one.textContent === 'View full prompt')!.click() })
  expect(document.body.textContent).toContain('How to talk to me: Plain words. One question at a time.')
})

it('a goal in hand can be given a deadline, and None clears it', async () => {
  const { box, calls } = await mount(<LeadAutonomySection />, 'waiting')
  const select = box.querySelector<HTMLSelectElement>('select[aria-label="Goal deadline"]')
  expect(select, 'the row shows only while a goal is open').not.toBeNull()
  await act(async () => {
    select!.value = '4'; select!.dispatchEvent(new Event('change', { bubbles: true }))
  })
  await settle()
  const call = calls.find(one => one.method === 'lead/deadline/set')!
  expect(call.params.logicalGoalId).toBeTruthy()
  expect(call.params.deadlineAt).toBeGreaterThan(Date.now())
})

it('rules: a default updated after the edit shows the real difference, and Keep mine or Use new settles it', async () => {
  const { box, calls } = await mount(<LeadRulesSection />)
  expect(box.textContent).toContain('Default updated')
  const edit = [...box.querySelectorAll<HTMLElement>('button')].filter(one => one.textContent === 'Edit')[1]!
  await act(async () => { edit.click() })
  const diff = document.body.querySelector('[aria-label="What changed in the default"]')!
  expect(diff.textContent).toContain('- Old line the shipped words no longer carry.')
  expect(diff.textContent).toMatch(/\+ /)
  const use = [...document.body.querySelectorAll<HTMLElement>('button')].find(one => one.textContent === 'Use new')!
  await act(async () => { use.click() }); await settle()
  expect(calls.filter(call => call.method === 'lead/rules/update').map(call => call.params.action)).toEqual(['reset'])
  expect(document.body.querySelector('[aria-label="What changed in the default"]')).toBeNull()
})

it('lists the changes the person made, newest first, with who made them and when; a new choice joins the top', async () => {
  const { box } = await mount(<LeadAutonomySection />)
  const changes = () => [...box.querySelectorAll('[aria-label="Autonomy changes"] [data-slot="row-title"]')].map(one => one.textContent)
  expect(changes()).toEqual(['Stuck nudges: Act → Observe', 'How to talk to me: version 1 saved'])
  expect(box.textContent).toContain('Only you change these; the Lead cannot.')
  const select = box.querySelector<HTMLSelectElement>('select[aria-label="Repeat runs"]')!
  await act(async () => { select.value = 'off'; select.dispatchEvent(new Event('change', { bubbles: true })) })
  await settle()
  expect(changes()[0]).toBe('Repeat runs: Act → Off')
})

it('rules: each edited section shows its version and when it changed, on its own row', async () => {
  const { box } = await mount(<LeadRulesSection />)
  const row = [...box.querySelectorAll<HTMLElement>('[data-slot="row-title"]')].find(one => one.textContent?.startsWith('How to talk to me'))!.closest<HTMLElement>('[data-slot="row"]') ?? box
  expect(row.textContent).toMatch(/Version 1 · Nov 2/)
  const untouched = [...box.querySelectorAll<HTMLElement>('[data-slot="row-title"]')].find(one => one.textContent?.startsWith('What counts as done'))!.closest<HTMLElement>('[data-slot="row"]') ?? box
  expect(untouched.textContent).not.toContain('Version')
})

it('a first rule change can be restored to the shipped words from its history, and every save shows in Recent changes (#2152)', async () => {
  const { box, calls } = await mount(<><LeadRulesSection /><LeadAutonomySection /></>)
  const ledger = () => box.querySelector('[aria-label="Autonomy changes"]')!.textContent
  const edit = [...box.querySelectorAll<HTMLElement>('button')].filter(one => one.textContent === 'Edit')[0]!
  await act(async () => { edit.click() })
  const dialog = () => document.body.querySelector<HTMLElement>('[role="dialog"]')!
  const history = [...dialog().querySelectorAll('[data-slot="row"]')].map(row => row.textContent ?? '')
  expect(history.find(row => row.startsWith('Version 1')), 'the version in force has nothing to restore').not.toContain('Restore')
  const shipped = [...dialog().querySelectorAll<HTMLElement>('[data-slot="row"]')].find(row => row.textContent?.startsWith('Shipped words'))
  expect(shipped, 'the words before the first change are in the history').toBeTruthy()
  await act(async () => { [...shipped!.querySelectorAll<HTMLElement>('button')].find(one => one.textContent === 'Restore')!.click() })
  await settle()
  expect(calls.filter(call => call.method === 'lead/rules/update').map(call => call.params)).toEqual([{ section: 'talk', action: 'reset', expectedVersion: 1 }])
  expect(ledger(), 'the restore that saved version 2 is in the ledger without reopening the page').toContain('How to talk to me: reset to default')
  await act(async () => { [...dialog().querySelectorAll<HTMLElement>('[data-slot="row"]')].find(row => row.textContent?.startsWith('Version 1'))!.querySelector<HTMLElement>('button')!.click() })
  await settle()
  expect(calls.filter(call => call.method === 'lead/rules/update').at(-1)!.params).toEqual({ section: 'talk', action: 'rollback', to: 1, expectedVersion: 2 })
  expect(ledger()).toContain('How to talk to me: version 3 restored')
})
