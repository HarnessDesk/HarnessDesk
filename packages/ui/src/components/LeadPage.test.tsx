import { act, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { LEAD_CONTROL_REFUSALS, type LeadWindowProjection } from '@harnessdesk/protocol'
import { AppStore } from '../state/store'
import { StoreProvider } from '../state/context'
import { previewStore } from '../preview/harness'
import { leadPlan, leadProjection } from '../preview/lead-fixture'
import { DestinationPageScope } from '../panels/destination-page'
import { LeadSettingsSection } from './LeadSettings'
import { TopBarOutlet, TopBarProvider } from '../panels/top-bar'
import { formatLeadConsentTime } from './lead-consent-time'
import leadSettingsSource from './LeadSettings.tsx?raw'
const decisionHandlers = vi.hoisted(() => [] as { onApprove?: () => void; onDecline?: () => void }[])
vi.mock('./LeadDecision', async importOriginal => {
  const actual = await importOriginal<typeof import('./LeadDecision')>()
  return { ...actual, LeadDecision: (props: React.ComponentProps<typeof actual.LeadDecision>) => { decisionHandlers.push(props); return <actual.LeadDecision {...props} /> } }
})
const modules = import.meta.glob('./LeadPage.tsx', { eager: true }) as Record<string, { LeadPage: React.ComponentType<any> }>
const LeadPage = modules['./LeadPage.tsx']?.LeadPage ?? (() => null)
const clean: (() => void)[] = []
afterEach(() => { clean.splice(0).forEach(fn => fn()); vi.restoreAllMocks(); decisionHandlers.length = 0 })
const mount = async (projection = leadProjection(), loading = false) => {
  const store = new AppStore('ws://localhost:0/'), box = document.createElement('div'); document.body.append(box)
  Object.assign(store.getSnapshot(), previewStore({ leadAvailable: true }).getSnapshot())
  if (!loading) store.lead.changed({ method: 'lead/changed', params: projection })
  const request = vi.spyOn(store.transport, 'request').mockImplementation(async () => loading ? new Promise<never>(() => {}) : projection as never)
  const root = createRoot(box)
  let navigate: (settings: boolean) => void = () => {}
  vi.spyOn(store, 'openDestination').mockImplementation(destination => navigate(destination.kind === 'settings'))
  const Surface = () => {
    const [settings, setSettings] = useState(false); navigate = setSettings
    return <TopBarProvider><TopBarOutlet owner="lead" fallback={{ place: null, more: () => null }} /><DestinationPageScope owner="lead" active>{settings ? <><button onClick={() => setSettings(false)}>Back</button><LeadSettingsSection /></> : <LeadPage />}</DestinationPageScope></TopBarProvider>
  }
  await act(async () => root.render(<StoreProvider store={store}><Surface /></StoreProvider>))
  clean.push(() => { act(() => root.unmount()); box.remove() })
  const update = async (over: Partial<LeadWindowProjection>) => { projection = { ...projection, ...over, revision: projection.revision + 1 }; await act(async () => store.lead.changed({ method: 'lead/changed', params: projection })) }
  return { store, box, request, update }
}
const button = (name: string) => [...document.querySelectorAll<HTMLButtonElement>('button')].find(node => (node.getAttribute('aria-label') ?? node.textContent) === (name === 'Settings' ? 'Lead settings' : name))!
const input = async (node: HTMLInputElement | HTMLTextAreaElement, value: string) => act(async () => {
  expect(node, 'the composer or credential input must exist').not.toBeNull()
  Object.getOwnPropertyDescriptor(node instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, 'value')!.set!.call(node, value)
  node.dispatchEvent(new Event('input', { bubbles: true })); node.dispatchEvent(new Event('change', { bubbles: true }))
})
it('keeps banners and decision controls in the shared composer notice stack', async () => {
  const base = leadProjection(), { box } = await mount({ ...base, wayOut: 'decide-plan', thread: { ...base.thread, cards: [leadPlan] } })
  const notices = box.querySelector('[data-slot="composer-notices"]')
  expect(notices).not.toBeNull()
  expect(button('Review plan').closest('[data-slot="composer-notices"]')).toBe(notices)
  expect(box.querySelector('[data-lead-decision]')?.closest('[data-slot="composer-notices"]')).toBe(notices)
  expect(box.querySelector('[data-slot="reading-measure"] > [data-slot="form-stack"]')).toBeNull()
})
it('has no empty reading measure and form stack above an idle composer', async () => {
  const { box } = await mount()
  expect(box.querySelector('[data-slot="reading-measure"] > [data-slot="form-stack"]')).toBeNull()
})
it('greets without a name until settings have loaded', async () => {
  const { box } = await mount(leadProjection(), true)
  expect(box.textContent).toContain('Hi, tell me what you want done.')
  expect(box.textContent).not.toContain("I'm Lead")
  expect(box.querySelector('textarea')?.placeholder).toBe('Message Lead…')
})
it.each([null, 'resume', 'decide-plan'] as const)('shows Resume only for wayOut=%s', async wayOut => {
  const base = leadProjection(), { box } = await mount({ ...base, wayOut, waitReason: 'lead-request-failed', thread: { ...base.thread, cards: wayOut === 'decide-plan' ? [leadPlan] : [] } })
  expect(Boolean(button('Resume'))).toBe(wayOut === 'resume')
  if (wayOut === 'resume') expect(box.textContent).toContain('Sending a message also continues')
  if (wayOut === 'decide-plan') { expect(button('Review plan')).toBeDefined(); await act(async () => button('Review plan').click()); expect(document.activeElement?.closest('[data-lead-decision]')?.getAttribute('data-lead-decision')).toBe('plan') }
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
it('explains that widening asks for approval and renders the returned request', async () => {
  const { store } = await mount()
  await act(async () => button('Settings').click())
  const select = document.querySelector<HTMLSelectElement>('[aria-label="Permission mode"]')!
  expect(select).not.toBeNull()
  await act(async () => { select.value = 'manage'; select.dispatchEvent(new Event('change', { bubbles: true })) })
  expect(document.body.textContent).toContain('Asks for your approval in the conversation')
  const state = store.lead.state, policy = state.settings!.policy
  vi.spyOn(store.lead, 'updateSettings').mockImplementation(async () => {
    const projection = leadProjection({ revision: 11, thread: { ...state.thread!, cards: [{ version: 1, id: 'policy', revision: 1, type: 'permission-change', contractDigest: null, previous: policy, proposed: { ...policy, revision: 2, mode: 'manage' } }] } })
    store.lead.changed({ method: 'lead/changed', params: projection }); return projection
  })
  await act(async () => button('Save permissions').click())
  expect(document.body.textContent).toContain('Waiting for your approval in the conversation'); expect(button('Open')).toBeDefined()
})

it('keeps settings refusals visible inside Settings › Lead', async () => {
  const { store } = await mount()
  await act(async () => button('Settings').click())
  vi.spyOn(store.lead, 'updateSettings').mockRejectedValue(Object.assign(new Error('unsafe detail'), { code: 'lead-secret-refused' }))
  await act(async () => button('Replace…').click())
  const secret = document.querySelector<HTMLInputElement>('input[type="password"]')!
  await input(secret, 'synthetic-key')
  await act(async () => button('Save').click())
  expect(document.querySelector('[role="alert"]')).not.toBeNull()
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
  expect(document.querySelector('[role="alertdialog"]')).toBeNull(); expect(document.querySelector('[role="alert"]')).not.toBeNull()
})
it('sorts cards by journal positions among messages', async () => {
  const base = leadProjection(); const { box } = await mount({ ...base, thread: { ...base.thread, cards: [{ ...leadPlan, revision: 30 }], cardPositions: { plan: 3 }, messages: [
    { version: 1, id: 'message-2', revision: 2, role: 'user', text: 'Before plan' }, { version: 1, id: 'message-4', revision: 4, role: 'assistant', text: 'After plan' }] } })
  const text = box.querySelector('[aria-label="Dex thread"]')!.textContent!
  expect(text.indexOf('Before plan')).toBeLessThan(text.indexOf("Here\'s my plan:")); expect(text.indexOf("Here\'s my plan:")).toBeLessThan(text.indexOf('After plan'))
})
it('Review plan focuses and scrolls the newest pending plan and tolerates no DOM card', async () => {
  const base = leadProjection(), scroll = vi.fn(), originalScroll = HTMLElement.prototype.scrollIntoView; HTMLElement.prototype.scrollIntoView = scroll
  clean.push(() => { HTMLElement.prototype.scrollIntoView = originalScroll })
  const { box, update } = await mount({ ...base, wayOut: 'decide-plan', thread: { ...base.thread, cards: [leadPlan, { ...leadPlan, id: 'newest', revision: 2, contract: { ...leadPlan.contract, revision: 2 } }], cardPositions: { plan: 2, newest: 3 } } })
  await act(async () => button('Review plan').click()); expect(document.activeElement?.closest('[data-lead-decision]')?.getAttribute('data-lead-decision')).toBe('newest'); expect(scroll).toHaveBeenCalled()
  await update({ thread: { ...base.thread, cards: [] } }); await act(async () => button('Review plan').click()); expect(box.querySelector('[data-lead-card]')).toBeNull()
})
it('locks decisions across all cards and keeps refused decision focus on its card', async () => {
  const base = leadProjection(); const { store, box } = await mount({ ...base, thread: { ...base.thread, cards: [leadPlan, { ...leadPlan, id: 'other' }] } })
  let refuse!: () => void; const decide = vi.spyOn(store.lead, 'decide').mockImplementation(() => new Promise((_, reject) => { refuse = () => reject({ code: 'lead-card-stale' }) }))
  await act(async () => button('Approve').click())
  expect([...box.querySelectorAll<HTMLButtonElement>('[data-slot="approval-card"] button')].every(node => node.disabled)).toBe(true)
  await act(async () => refuse()); expect(decide).toHaveBeenCalledTimes(1); expect(document.activeElement?.closest('[data-lead-decision]')?.getAttribute('data-lead-decision')).toBe('other')
})
it('uses transcript roles and shared composer action row without a live log', async () => {
  const base = leadProjection(); const { box } = await mount({ ...base, thread: { ...base.thread, messages: [{ version: 1, id: 'message-1', revision: 1, role: 'user', text: 'A goal' }] } })
  expect(box.querySelector('[data-slot="message"][data-align="end"]')).not.toBeNull()
  expect(box.querySelector('[data-slot="composer-tools"] button')).not.toBeNull()
  expect(box.querySelector('[role="log"]')).toBeNull()
})

it('pins new entries unless the person scrolled up', async () => {
  const { box, update, store } = await mount(); const thread = box.querySelector<HTMLElement>('[aria-label="Dex thread"]')!
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

it('refreshes settings drafts when the projection changes underneath them and clears section refusals on leaving', async () => {
  const { store, box, update } = await mount(); await act(async () => button('Settings').click())
  const select = document.querySelector<HTMLSelectElement>('[aria-label="Permission mode"]')!
  await act(async () => { select.value = 'manage'; select.dispatchEvent(new Event('change', { bubbles: true })) })
  await update({ settings: { ...store.lead.state.settings!, policy: { ...store.lead.state.settings!.policy, revision: 2, mode: 'plan' } } })
  expect(select.value).toBe('plan'); expect(button('Save permissions').disabled).toBe(true)
  vi.spyOn(store.lead, 'updateSettings').mockRejectedValue({ code: 'lead-operation-refused' })
  await act(async () => button('Replace…').click()); await input(document.querySelector<HTMLInputElement>('input[type="password"]')!, 'synthetic-key')
  await act(async () => button('Save').click()); expect(document.querySelectorAll('[role="alert"]')).toHaveLength(1)
  await act(async () => button('Back').click()); expect(box.querySelector('[role="alert"]')).toBeNull()
})
it.each([100, Date.now() + 3600000])('names expired approval once in the banner even when the client clock lags: %s', async expiry => {
  const base = leadProjection(); const { box } = await mount({ ...base, planConsentExpiresAt: expiry, wayOut: 'decide-plan', thread: { ...base.thread, contract: leadPlan.contract, cards: [{ ...leadPlan, revision: 2 }] } })
  expect(box.textContent).toContain('Approve again to continue.')
  expect(box.textContent?.match(/earlier approval expired at/g)).toHaveLength(1)
  expect(box.querySelector('[data-lead-prose]')?.textContent).not.toContain('expired at')
})

it('a decide-plan update scrolls without taking focus or text from the composer', async () => {
  const base = leadProjection(), { box, update } = await mount(base)
  const area = box.querySelector('textarea')!; area.focus(); await input(area, 'Half a sentence')
  await update({ wayOut: 'decide-plan', thread: { ...base.thread, cards: [leadPlan], cardPositions: { plan: 2 } } })
  expect(document.activeElement).toBe(area); expect(area.value).toBe('Half a sentence')
  await input(area, 'Half a sentence finished'); expect(area.value).toBe('Half a sentence finished')
  await act(async () => button('Review plan').click()); expect(document.activeElement?.closest('[data-lead-decision]')?.getAttribute('data-lead-decision')).toBe('plan')
})
it('closes the key editor only after a successful save', async () => {
  const { store } = await mount(); await act(async () => button('Settings').click()); await act(async () => button('Replace…').click())
  vi.spyOn(store.lead, 'updateSettings').mockResolvedValue(leadProjection())
  await input(document.querySelector<HTMLInputElement>('input[type="password"]')!, 'synthetic-key')
  await act(async () => button('Save').click()); expect(document.querySelector('input[type="password"]')).toBeNull()
})
it('locks retained callbacks across a replaced dock before pending state renders', async () => {
  const base = leadProjection(), { store, update } = await mount({ ...base, thread: { ...base.thread, cards: [leadPlan] } })
  let done!: () => void
  const decide = vi.spyOn(store.lead, 'decide').mockImplementation(() => new Promise<LeadWindowProjection>(resolve => { done = () => resolve(base) }))
  const first = decisionHandlers.at(-1)!.onApprove!
  const retained = decisionHandlers.at(-1)!.onDecline!
  await act(async () => { first(); retained() })
  await update({ thread: { ...base.thread, cards: [{ ...leadPlan, id: 'other' }] } })
  const second = decisionHandlers.at(-1)!.onApprove!
  await act(async () => second()); expect(decide).toHaveBeenCalledTimes(1)
  await act(async () => done())
})
it('caps expiry backoff at 30 seconds, reads once at the cap and waits for changed', async () => {
  vi.useFakeTimers()
  try {
    const now = Date.now(), { store, update } = await mount({ ...leadProjection(), planConsentExpiresAt: now + 100 })
    const read = vi.spyOn(store.lead, 'readThread').mockResolvedValue(leadProjection().thread)
    await act(async () => vi.advanceTimersByTimeAsync(40000)); expect(read).toHaveBeenCalledTimes(6)
    await act(async () => vi.advanceTimersByTimeAsync(21150)); expect(read).toHaveBeenCalledTimes(7)
    await act(async () => vi.advanceTimersByTimeAsync(300000)); expect(read).toHaveBeenCalledTimes(7)
    await update({ wayOut: 'decide-plan' }); expect(button('Review plan')).toBeDefined()
  } finally { vi.useRealTimers() }
})
it('formats renewal notices and settings expiry with the Lead date-aware minute formatter', async () => {
  const expiry = 1792328434567, base = leadProjection()
  const { box } = await mount({ ...base, planConsentExpiresAt: expiry, wayOut: 'decide-plan', thread: { ...base.thread, contract: leadPlan.contract, cards: [leadPlan] } })
  expect(box.textContent?.split(formatLeadConsentTime(expiry)!).length).toBe(2)
  await act(async () => button('Settings').click()); expect(document.body.textContent).toContain(formatLeadConsentTime(expiry))
})
it('explains a blocked renewal even without a Resume way out', async () => {
  const { box } = await mount({ ...leadProjection(), wayOut: null, waitReason: 'lead-renewal-blocked' })
  expect(box.textContent).toContain('The plan could not be renewed because the pending request limit was reached.')
  expect(button('Resume')).toBeUndefined()
})
it('names the key row once and puts the allowance note on its dollar row', async () => {
  await mount(); await act(async () => button('Settings').click())
  const rows = [...document.querySelectorAll('[data-slot="row"]')]
  expect(rows.some(row => row.textContent?.startsWith('Key'))).toBe(true)
  expect(rows.some(row => row.textContent?.startsWith('Reported spend'))).toBe(false)
  expect(rows.find(row => row.textContent?.startsWith('Dollar allowance'))?.textContent).toContain('Stops when reported spend reaches the cap.')
})

it('uses unconstrained Lead settings groups and trailing Save rows', async () => {
  await mount(); await act(async () => button('Settings').click())
  const groups = [...document.querySelectorAll('[data-slot="rows"]')]
  expect(groups).toHaveLength(4)
  for (const group of groups) {
    expect(group.parentElement?.getAttribute('data-slot')).toBe('section')
    expect(group.parentElement?.hasAttribute('data-sizing')).toBe(false)
    expect(group.parentElement?.hasAttribute('style')).toBe(false)
    expect(group.hasAttribute('style')).toBe(false)
  }
  expect(leadSettingsSource).not.toMatch(/\b(?:sizing|height|minHeight|maxHeight)\s*[:=]/)
  for (const name of ['Save permissions', 'Save allowances']) expect(button(name).closest('[data-slot="row"]')).not.toBeNull()
})

it.each(['2', 'Escape'])('guards typed-through %s after Review plan takes focus', async key => {
  vi.useFakeTimers()
  try {
    const base = leadProjection(), { store } = await mount({ ...base, wayOut: 'decide-plan', thread: { ...base.thread, cards: [leadPlan] } })
    const decide = vi.spyOn(store.lead, 'decide').mockResolvedValue(base)
    await act(async () => button('Review plan').click())
    const surface = document.activeElement!
    await act(async () => surface.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true })))
    expect(decide).not.toHaveBeenCalled()
    await act(async () => vi.advanceTimersByTimeAsync(501))
    await act(async () => surface.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true })))
    expect(decide).toHaveBeenCalledOnce()
    expect(decide).toHaveBeenCalledWith(expect.objectContaining({ choice: key === '2' ? 'approve' : 'decline' }))
  } finally { vi.useRealTimers() }
})
