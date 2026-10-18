import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { LEAD_CONTROL_REFUSALS, type LeadWindowProjection } from '@harnessdesk/protocol'
import { AppStore } from '../state/store'
import { StoreProvider } from '../state/context'
import { previewStore } from '../preview/harness'
import { leadPlan, leadProjection } from '../preview/lead-fixture'
import { DestinationPageScope } from '../panels/destination-page'
import { TopBarProvider } from '../panels/top-bar'
const modules = import.meta.glob('./LeadPage.tsx', { eager: true }) as Record<string, { LeadPage: React.ComponentType<any> }>
const LeadPage = modules['./LeadPage.tsx']?.LeadPage ?? (() => null)
const clean: (() => void)[] = []
afterEach(() => { clean.splice(0).forEach(fn => fn()); vi.restoreAllMocks() })
const mount = async (projection = leadProjection()) => {
  const store = new AppStore('ws://localhost:0/'), box = document.createElement('div'); document.body.append(box)
  Object.assign(store.getSnapshot(), previewStore({ leadAvailable: true }).getSnapshot())
  store.lead.changed({ method: 'lead/changed', params: projection })
  const request = vi.spyOn(store.transport, 'request').mockImplementation(async () => projection as never)
  const root = createRoot(box)
  await act(async () => root.render(<StoreProvider store={store}><TopBarProvider><DestinationPageScope owner="lead" active><LeadPage /></DestinationPageScope></TopBarProvider></StoreProvider>))
  clean.push(() => { act(() => root.unmount()); box.remove() })
  const update = async (over: Partial<LeadWindowProjection>) => { projection = { ...projection, ...over, revision: projection.revision + 1 }; await act(async () => store.lead.changed({ method: 'lead/changed', params: projection })) }
  return { store, box, request, update }
}
const button = (name: string) => [...document.querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent === name)!
const input = async (node: HTMLInputElement | HTMLTextAreaElement, value: string) => act(async () => {
  expect(node, 'the composer or credential input must exist').not.toBeNull()
  Object.getOwnPropertyDescriptor(node instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, 'value')!.set!.call(node, value)
  node.dispatchEvent(new Event('input', { bubbles: true })); node.dispatchEvent(new Event('change', { bubbles: true }))
})
it.each([null, 'resume', 'decide-plan'] as const)('shows Resume only for wayOut=%s', async wayOut => {
  const base = leadProjection(), { box } = await mount({ ...base, wayOut, waitReason: 'lead-request-failed', thread: { ...base.thread, cards: wayOut === 'decide-plan' ? [leadPlan] : [] } })
  expect(Boolean(button('Resume'))).toBe(wayOut === 'resume')
  if (wayOut === 'resume') expect(box.textContent).toContain('Sending a message also continues')
  if (wayOut === 'decide-plan') { expect(button('Review plan')).toBeDefined(); await act(async () => button('Review plan').click()); expect(document.activeElement?.getAttribute('data-lead-card')).toBe('plan') }
})
it('shows initial allowances and disables Send during requestInFlight', async () => {
  const { box, update } = await mount()
  expect(box.textContent).toContain('$5'); expect(box.textContent).toContain('4 rounds')
  await input(box.querySelector('textarea')!, 'Inspect the empty state')
  expect(button('Send').disabled).toBe(false)
  await update({ requestInFlight: true })
  expect(button('Sending…').disabled).toBe(true)
})
it.each(LEAD_CONTROL_REFUSALS)('maps %s to a sentence without raw codes', async code => {
  const { store, box } = await mount()
  vi.spyOn(store.lead, 'send').mockRejectedValue(Object.assign(new Error(code), { code }))
  await input(box.querySelector('textarea')!, 'Inspect')
  await act(async () => button('Send').click())
  expect(box.querySelector('[role="alert"]')).not.toBeNull()
  expect(box.textContent).not.toContain(code)
})
it('uses a write-only password input, clears it before awaiting submit, and never resends it', async () => {
  const { store, box, request } = await mount()
  await act(async () => button('Settings').click())
  const secret = document.querySelector<HTMLInputElement>('input[type="password"]')!
  expect(secret).not.toBeNull()
  await input(secret, 'sk-synthetic-only-1234')
  const updates: unknown[] = []
  vi.spyOn(store.lead, 'updateSettings').mockImplementation(async value => { updates.push(structuredClone(value)); expect(secret.value).toBe(''); return leadProjection() })
  await act(async () => button('Replace key').click())
  expect(updates).toEqual([{ credential: { provider: 'anthropic', key: 'sk-synthetic-only-1234' } }])
  expect(document.body.innerHTML).not.toContain('sk-synthetic-only-1234')
  expect(JSON.stringify(store.lead.state)).not.toContain('sk-synthetic-only-1234')
  expect(JSON.stringify(request.mock.calls)).not.toContain('sk-synthetic-only-1234')
  await act(async () => button('Save caps').click())
  expect(JSON.stringify(updates.slice(1))).not.toContain('sk-synthetic-only-1234')
  expect(box.textContent).not.toContain('sk-synthetic-only-1234')
})
it('explains that widening creates an approval card and renders the returned card', async () => {
  const { store } = await mount()
  await act(async () => button('Settings').click())
  const select = document.querySelector<HTMLSelectElement>('[aria-label="Permission mode"]')!
  expect(select).not.toBeNull()
  await act(async () => { select.value = 'manage'; select.dispatchEvent(new Event('change', { bubbles: true })) })
  expect(document.body.textContent).toContain('Creates a card for your approval')
  const state = store.lead.state, policy = state.settings!.policy
  vi.spyOn(store.lead, 'updateSettings').mockImplementation(async () => {
    const projection = leadProjection({ revision: 11, thread: { ...state.thread!, cards: [{ version: 1, id: 'policy', revision: 1, type: 'permission-change', contractDigest: null, previous: policy, proposed: { ...policy, revision: 2, mode: 'manage' } }] } })
    store.lead.changed({ method: 'lead/changed', params: projection }); return projection
  })
  await act(async () => button('Save policy').click())
  expect(document.querySelector('[data-lead-card="policy"]')).not.toBeNull()
})

it('keeps settings refusals visible inside the open dialog', async () => {
  const { store } = await mount()
  await act(async () => button('Settings').click())
  vi.spyOn(store.lead, 'updateSettings').mockRejectedValue(Object.assign(new Error('unsafe detail'), { code: 'lead-secret-refused' }))
  const secret = document.querySelector<HTMLInputElement>('input[type="password"]')!
  await input(secret, 'synthetic-key')
  await act(async () => button('Replace key').click())
  expect(document.querySelector('[role="dialog"] [role="alert"]')).not.toBeNull()
  expect(document.body.textContent).not.toContain('unsafe detail')
})
it('opens worker approvals even when the run has not been loaded by the window', async () => {
  const base = leadProjection(), { store } = await mount({ ...base, thread: { ...base.thread, cards: [{ version: 1, id: 'approval', revision: 1, type: 'waiting', kind: 'worker-approval', runId: 'run-demo', personCardId: null, summary: 'Worker permission requested', assertions: [], contractDigest: 'a'.repeat(64) }] } })
  const read = vi.spyOn(store, 'readFlowExecution').mockResolvedValue({ goal: 'team-demo' } as never)
  const open = vi.spyOn(store, 'openGoal').mockImplementation(() => {})
  await act(async () => button('Open approvals').click())
  expect(read).toHaveBeenCalledWith('run-demo'); expect(open).toHaveBeenCalledWith('team-demo')
})
