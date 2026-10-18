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
const button = (name: string) => [...document.querySelectorAll<HTMLButtonElement>('button')].find(node => (node.getAttribute('aria-label') ?? node.textContent) === name)!
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
it.each([false, true])('clears the key before submit and never resends it, refusal=%s', async refuse => {
  const { store, box, request } = await mount(); await act(async () => button('Settings').click())
  await act(async () => button('Replace…').click())
  const secret = document.querySelector<HTMLInputElement>('input[type="password"]')!
  await input(secret, '  sk-synthetic-only-1234  ')
  let release!: () => void
  request.mockImplementation(async method => {
    if (method === 'lead/settings/update') { await new Promise<void>(resolve => { release = resolve }); if (refuse) throw { code: 'lead-secret-refused' } }
    return leadProjection() as never
  })
  await act(async () => button('Save').click())
  expect(secret.value).toBe('')
  const writes = request.mock.calls.filter(([method]) => method === 'lead/settings/update')
  expect(writes).toHaveLength(1); expect(writes[0]![1]).toMatchObject({ credential: { key: 'sk-synthetic-only-1234' } })
  expect(document.body.innerHTML).not.toContain('sk-synthetic-only-1234'); expect(document.body.textContent).not.toContain('sk-synthetic-only-1234'); expect(JSON.stringify(store.lead.state)).not.toContain('sk-synthetic-only-1234')
  await act(async () => release())
  await store.lead.readSettings()
  expect(JSON.stringify(request.mock.calls.slice(request.mock.calls.indexOf(writes[0]!) + 1))).not.toContain('sk-synthetic-only-1234')
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
  await act(async () => button('Save permissions').click())
  expect(document.querySelector('[data-lead-card="policy"]')).not.toBeNull()
})

it('keeps settings refusals visible inside the open dialog', async () => {
  const { store } = await mount()
  await act(async () => button('Settings').click())
  vi.spyOn(store.lead, 'updateSettings').mockRejectedValue(Object.assign(new Error('unsafe detail'), { code: 'lead-secret-refused' }))
  await act(async () => button('Replace…').click())
  const secret = document.querySelector<HTMLInputElement>('input[type="password"]')!
  await input(secret, 'synthetic-key')
  await act(async () => button('Save').click())
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

it.each(['unexpected-code', '__proto__', 'constructor'])('unknown refusal %s is a generic sentence', async code => {
  const { store, box } = await mount(); vi.spyOn(store.lead, 'send').mockRejectedValue({ code })
  await input(box.querySelector('textarea')!, 'Inspect'); await act(async () => button('Send').click())
  expect(box.querySelector('[role="alert"]')?.textContent).toBe('The Lead could not complete that action.')
})
it('unchanged settings groups cannot be saved', async () => {
  await mount(); await act(async () => button('Settings').click())
  expect(button('Save permissions').disabled).toBe(true); expect(button('Save allowances').disabled).toBe(true)
})
it('requires confirmation before removing a key and shows removal errors in front', async () => {
  const { store } = await mount(); const update = vi.spyOn(store.lead, 'updateSettings').mockRejectedValue({ code: 'lead-operation-refused' })
  await act(async () => button('Settings').click()); await act(async () => button('Remove').click())
  expect(update).not.toHaveBeenCalled(); expect(document.querySelector('[role="alertdialog"]')).not.toBeNull()
  const confirm = [...document.querySelectorAll<HTMLButtonElement>('[role="alertdialog"] button')].find(node => node.textContent === 'Remove key')!
  await act(async () => confirm.click()); expect(update).toHaveBeenCalledTimes(1)
  expect(document.querySelector('[role="alertdialog"]')).toBeNull(); expect(document.querySelector('[role="dialog"] [role="alert"]')).not.toBeNull()
})
it('sorts cards by journal positions among messages', async () => {
  const base = leadProjection(); const { box } = await mount({ ...base, thread: { ...base.thread, cards: [{ ...leadPlan, revision: 30 }], cardPositions: { plan: 3 }, messages: [
    { version: 1, id: 'message-2', revision: 2, role: 'user', text: 'Before plan' }, { version: 1, id: 'message-4', revision: 4, role: 'assistant', text: 'After plan' }] } })
  const text = box.querySelector('[aria-label="Lead thread"]')!.textContent!
  expect(text.indexOf('Before plan')).toBeLessThan(text.indexOf('Plan')); expect(text.indexOf('Plan')).toBeLessThan(text.indexOf('After plan'))
})
it('Review plan focuses and scrolls the newest pending plan and tolerates no DOM card', async () => {
  const base = leadProjection(), scroll = vi.fn(), originalScroll = HTMLElement.prototype.scrollIntoView; HTMLElement.prototype.scrollIntoView = scroll
  clean.push(() => { HTMLElement.prototype.scrollIntoView = originalScroll })
  const { box, update } = await mount({ ...base, wayOut: 'decide-plan', thread: { ...base.thread, cards: [leadPlan, { ...leadPlan, id: 'newest', revision: 2, contract: { ...leadPlan.contract, revision: 2 } }], cardPositions: { plan: 2, newest: 3 } } })
  await act(async () => button('Review plan').click()); expect(document.activeElement?.getAttribute('data-lead-card')).toBe('newest'); expect(scroll).toHaveBeenCalled()
  await update({ thread: { ...base.thread, cards: [] } }); await act(async () => button('Review plan').click()); expect(box.querySelector('[data-lead-card]')).toBeNull()
})
it('locks decisions across all cards and keeps refused decision focus on its card', async () => {
  const base = leadProjection(); const { store, box } = await mount({ ...base, thread: { ...base.thread, cards: [leadPlan, { ...leadPlan, id: 'other' }] } })
  let refuse!: () => void; const decide = vi.spyOn(store.lead, 'decide').mockImplementation(() => new Promise((_, reject) => { refuse = () => reject({ code: 'lead-card-stale' }) }))
  await act(async () => button('Approve').click())
  expect([...box.querySelectorAll<HTMLButtonElement>('[data-lead-card] button')].every(node => node.disabled)).toBe(true)
  await act(async () => refuse()); expect(decide).toHaveBeenCalledTimes(1); expect(document.activeElement?.getAttribute('data-lead-card')).toBe('plan')
})
it('uses transcript roles and shared composer action row without a live log', async () => {
  const base = leadProjection(); const { box } = await mount({ ...base, thread: { ...base.thread, messages: [{ version: 1, id: 'message-1', revision: 1, role: 'user', text: 'A goal' }] } })
  expect(box.querySelector('[data-slot="message"][data-align="end"]')).not.toBeNull()
  expect(box.querySelector('[data-slot="composer-tools"] button')).not.toBeNull()
  expect(box.querySelector('[role="log"]')).toBeNull()
})

it('pins new entries unless the person scrolled up', async () => {
  const { box, update, store } = await mount(); const thread = box.querySelector<HTMLElement>('[aria-label="Lead thread"]')!
  Object.defineProperties(thread, { clientHeight: { value: 100, configurable: true }, scrollHeight: { value: 500, configurable: true } })
  await update({ thread: { ...store.lead.state.thread!, messages: [{ version: 1, id: 'message-1', revision: 1, role: 'assistant', text: 'First' }] } })
  expect(thread.scrollTop).toBe(500)
  thread.scrollTop = 20; thread.dispatchEvent(new Event('scroll', { bubbles: true }))
  await update({ thread: { ...store.lead.state.thread!, messages: [...store.lead.state.thread!.messages, { version: 1, id: 'message-2', revision: 2, role: 'assistant', text: 'Next' }] } })
  expect(thread.scrollTop).toBe(20)
})
it('retries expiry reads with bounded backoff until the host reflects expiry', async () => {
  vi.useFakeTimers()
  try {
    const now = Date.now(), { store } = await mount({ ...leadProjection(), planConsentExpiresAt: now + 100 })
    const read = vi.spyOn(store.lead, 'readThread').mockResolvedValue(leadProjection().thread)
    await act(async () => vi.advanceTimersByTimeAsync(1200)); expect(read).toHaveBeenCalledTimes(2)
    await act(async () => vi.advanceTimersByTimeAsync(2000)); expect(read).toHaveBeenCalledTimes(3)
    await act(async () => store.lead.changed({ method: 'lead/changed', params: leadProjection({ revision: 11, planConsentExpiresAt: now + 100, wayOut: 'decide-plan' }) }))
    await act(async () => vi.advanceTimersByTimeAsync(60000)); expect(read).toHaveBeenCalledTimes(3)
  } finally { vi.useRealTimers() }
})

it('refreshes settings drafts when the projection changes underneath them and clears dialog refusals on close', async () => {
  const { store, box, update } = await mount(); await act(async () => button('Settings').click())
  const select = document.querySelector<HTMLSelectElement>('[aria-label="Permission mode"]')!
  await act(async () => { select.value = 'manage'; select.dispatchEvent(new Event('change', { bubbles: true })) })
  await update({ settings: { ...store.lead.state.settings!, policy: { ...store.lead.state.settings!.policy, revision: 2, mode: 'plan' } } })
  expect(select.value).toBe('plan'); expect(button('Save permissions').disabled).toBe(true)
  vi.spyOn(store.lead, 'updateSettings').mockRejectedValue({ code: 'lead-operation-refused' })
  await act(async () => button('Replace…').click()); await input(document.querySelector<HTMLInputElement>('input[type="password"]')!, 'synthetic-key')
  await act(async () => button('Save').click()); expect(document.querySelectorAll('[role="alert"]')).toHaveLength(1)
  await act(async () => button('Done').click()); expect(box.querySelector('[role="alert"]')).toBeNull()
})
it.each([100, Date.now() + 3600000])('names expired approval in the banner and renewal card even when the client clock lags: %s', async expiry => {
  const base = leadProjection(); const { box } = await mount({ ...base, planConsentExpiresAt: expiry, wayOut: 'decide-plan', thread: { ...base.thread, contract: leadPlan.contract, cards: [{ ...leadPlan, revision: 2 }] } })
  expect(box.querySelector('[data-lead-state]')?.textContent).toBe('Renewal')
  expect(box.textContent?.match(/earlier approval expired at/g)).toHaveLength(2)
})
