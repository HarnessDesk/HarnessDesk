import { act, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { LEAD_CONTROL_REFUSALS, type LeadWindowProjection } from '@harnessdesk/protocol'
import { AppStore } from '../state/store'
import { StoreProvider } from '../state/context'
import { previewStore } from '../preview/harness'
import { leadBudget, leadPlan, leadProjection } from '../preview/lead-fixture'
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

it('shows one plain runtime reason and cannot retry an unavailable Lead', async () => {
  const base = leadProjection()
  const reason = "this app's runtime (Node 24.19.0) rejected the Lead flags (exit 9)"
  const { store, box, request } = await mount({ ...base, settings: { ...base.settings, unavailable: 'runtime', unavailableReason: reason } } as any)
  const send = vi.spyOn(store.lead, 'send')
  expect(box.textContent?.match(/Lead can't start here/g)).toHaveLength(1)
  expect(box.textContent?.match(/rejected the Lead flags \(exit 9\)/g)).toHaveLength(1)
  expect(box.textContent).toContain('Unavailable')
  expect(box.querySelector('[role="alert"]')).toBeNull()
  expect(box.querySelector('textarea')?.disabled).toBe(true)
  expect(button('Send').disabled).toBe(true)
  expect(button('Resume')).toBeUndefined()
  expect(send).not.toHaveBeenCalled()
  expect(request.mock.calls.filter(([method]) => method === 'lead/thread/read')).toHaveLength(1)
})
const mount = async (projection = leadProjection(), loading = false) => {
  const store = new AppStore('ws://localhost:0/'), box = document.createElement('div'); document.body.append(box)
  Object.assign(store.getSnapshot(), previewStore({ leadAvailable: true }).getSnapshot())
  if (!loading) store.lead.changed({ method: 'lead/changed', params: projection })
  const request = vi.spyOn(store.transport, 'request').mockImplementation(async () => loading ? new Promise<never>(() => {}) : projection as never)
  const root = createRoot(box)
  let navigate: (settings: boolean) => void = () => {}
  let setFocus: (id: string | null) => void = () => {}
  vi.spyOn(store, 'openDestination').mockImplementation(destination => navigate(destination.kind === 'settings'))
  const Surface = () => {
    const [settings, setSettings] = useState(false), [focus, focusDecision] = useState<string | null>(null); navigate = setSettings; setFocus = focusDecision
    return <TopBarProvider><TopBarOutlet owner="lead" fallback={{ place: null, more: () => null }} /><DestinationPageScope owner="lead" active>{settings ? <><button onClick={() => setSettings(false)}>Back</button><LeadSettingsSection /></> : <LeadPage focus={focus} />}</DestinationPageScope></TopBarProvider>
  }
  await act(async () => root.render(<StoreProvider store={store}><Surface /></StoreProvider>))
  clean.push(() => { act(() => root.unmount()); box.remove() })
  const update = async (over: Partial<LeadWindowProjection>) => { projection = { ...projection, ...over, revision: projection.revision + 1 }; await act(async () => store.lead.changed({ method: 'lead/changed', params: projection })) }
  return { store, box, request, update, focusDecision: async (id: string) => { await act(async () => setFocus(id)) } }
}
const liveLine = (box: Element) => box.querySelector('[data-slot="lead-live-line"]')
const goalMessage = { version: 1 as const, id: 'goal', revision: 1, role: 'user' as const, text: 'Repair the failing check' }
const button = (name: string) => [...document.querySelectorAll<HTMLButtonElement>('button')].find(node => (node.getAttribute('aria-label') ?? node.textContent) === (name === 'Settings' ? 'Lead settings' : name))!
const input = async (node: HTMLInputElement | HTMLTextAreaElement, value: string) => act(async () => {
  expect(node, 'the composer or credential input must exist').not.toBeNull()
  Object.getOwnPropertyDescriptor(node instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, 'value')!.set!.call(node, value)
  node.dispatchEvent(new Event('input', { bubbles: true })); node.dispatchEvent(new Event('change', { bubbles: true }))
})
it('keeps decision controls in the shared composer notice stack without a duplicate plan banner', async () => {
  const base = leadProjection(), { box } = await mount({ ...base, wayOut: 'decide-plan', thread: { ...base.thread, cards: [leadPlan] } })
  const notices = box.querySelector('[data-slot="composer-notices"]')
  expect(notices).not.toBeNull()
  expect(button('Review plan')).toBeUndefined()
  expect(box.textContent).not.toContain('The plan needs your decision')
  expect(box.querySelector('[data-lead-decision]')?.closest('[data-slot="composer-notices"]')).toBe(notices)
  expect(box.querySelector('[data-slot="reading-measure"] > [data-slot="form-stack"]')).toBeNull()
})
it('has no empty reading measure and form stack above an idle composer', async () => {
  const { box } = await mount()
  expect(box.querySelector('[data-slot="reading-measure"] > [data-slot="form-stack"]')).toBeNull()
})
it('greets without a name until settings have loaded', async () => {
  const { box } = await mount(leadProjection(), true)
  expect(box.textContent).toContain('Hi, what can I help you with?')
  expect(box.textContent).not.toContain("I'm Lead")
  expect(box.querySelector('textarea')?.placeholder).toBe('Message Lead…')
})
it.each([null, 'resume', 'decide-plan'] as const)('shows Resume only for wayOut=%s', async wayOut => {
  const base = leadProjection(), { box, focusDecision } = await mount({ ...base, wayOut, waitReason: 'lead-request-failed', thread: { ...base.thread, cards: wayOut === 'decide-plan' ? [leadPlan] : [] } })
  expect(Boolean(button('Resume'))).toBe(wayOut === 'resume')
  if (wayOut === 'resume') expect(box.textContent).toContain('Sending a message also continues')
  if (wayOut === 'decide-plan') { expect(button('Review plan')).toBeUndefined(); await focusDecision('plan'); expect(document.activeElement?.closest('[data-lead-decision]')?.getAttribute('data-lead-decision')).toBe('plan') }
})
it('shows initial allowances and disables Send during requestInFlight', async () => {
  const { box, update } = await mount()
  expect(box.textContent).toContain('$5'); expect(box.textContent).toContain('4 rounds')
  await input(box.querySelector('textarea')!, 'Inspect the empty state')
  expect(button('Send').disabled).toBe(false)
  await update({ requestInFlight: true })
  expect(button('Send')).toBeUndefined()
  expect(button('Stop reply').disabled).toBe(false)
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
it('explicit navigation focuses and scrolls the newest pending plan and tolerates no DOM decision', async () => {
  const base = leadProjection(), scroll = vi.fn(), originalScroll = HTMLElement.prototype.scrollIntoView; HTMLElement.prototype.scrollIntoView = scroll
  clean.push(() => { HTMLElement.prototype.scrollIntoView = originalScroll })
  const { box, update, focusDecision } = await mount({ ...base, wayOut: 'decide-plan', thread: { ...base.thread, cards: [leadPlan, { ...leadPlan, id: 'newest', revision: 2, contract: { ...leadPlan.contract, revision: 2 } }], cardPositions: { plan: 2, newest: 3 } } })
  scroll.mockClear()
  await focusDecision('newest'); expect(document.activeElement?.closest('[data-lead-decision]')?.getAttribute('data-lead-decision')).toBe('newest'); expect(scroll).toHaveBeenCalledTimes(1); expect(scroll.mock.instances[0]).toBe(box.querySelector('[data-lead-card="newest"]'))
  await update({ thread: { ...base.thread, cards: [] } }); await focusDecision('missing'); expect(box.querySelector('[data-lead-card]')).toBeNull()
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

it('puts a declined widening back to what holds, rather than leaving it as the draft', async () => {
  const { store, update } = await mount()
  await act(async () => button('Settings').click())
  const select = document.querySelector<HTMLSelectElement>('[aria-label="Permission mode"]')!, dollars = document.querySelector<HTMLInputElement>('[aria-label="Dollar allowance"]')!
  const before = select.value, cap = dollars.value, state = store.lead.state, policy = state.settings!.policy, caps = state.settings!.caps
  await act(async () => { select.value = 'manage'; select.dispatchEvent(new Event('change', { bubbles: true })) })
  await input(dollars, String(Number(cap) + 5))
  await update({ thread: { ...state.thread!, cards: [{ version: 1, id: 'policy', revision: 1, type: 'permission-change', contractDigest: null, previous: policy, proposed: { ...policy, revision: 2, mode: 'manage' } },
    { version: 1, id: 'caps', revision: 1, type: 'budget-change', contractDigest: null, logicalGoalId: 'goal', previous: { revision: 1, caps }, proposed: { ...caps, usdMicros: caps.usdMicros + 5_000_000 } }] } })
  expect(select.value).toBe('manage')
  await update({ thread: { ...state.thread!, cards: [] } })
  expect(select.value).toBe(before); expect(dollars.value).toBe(cap)
  expect(button('Save permissions').disabled).toBe(true); expect(button('Save allowances').disabled).toBe(true)
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
  const base = leadProjection(), { box, update, focusDecision } = await mount(base)
  const area = box.querySelector('textarea')!; area.focus(); await input(area, 'Half a sentence')
  await update({ wayOut: 'decide-plan', thread: { ...base.thread, cards: [leadPlan], cardPositions: { plan: 2 } } })
  expect(document.activeElement).toBe(area); expect(area.value).toBe('Half a sentence')
  await input(area, 'Half a sentence finished'); expect(area.value).toBe('Half a sentence finished')
  await focusDecision('plan'); expect(document.activeElement?.closest('[data-lead-decision]')?.getAttribute('data-lead-decision')).toBe('plan')
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
    await update({ wayOut: 'decide-plan' }); expect(button('Review plan')).toBeUndefined(); expect(document.body.textContent).toContain('The plan needs your decision before work continues.')
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
it('says an approved goal has not started, and offers Resume, when the Lead ended its turn with nothing begun', async () => {
  const base = leadProjection(), { box } = await mount({ ...base, wayOut: 'resume', waitReason: 'lead-run-not-started',
    thread: { ...base.thread, state: 'waiting-for-user', contract: leadPlan.contract, cards: [] } })
  expect(box.textContent).toContain('The plan is approved, but no work has started. Sending a message also continues.')
  expect(button('Resume')).toBeDefined()
  expect(box.textContent).not.toContain('The Lead is waiting for you to continue.')
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

it.each(['2', 'Escape'])('guards typed-through %s after explicit decision navigation takes focus', async key => {
  vi.useFakeTimers()
  try {
    const base = leadProjection(), { store, focusDecision } = await mount({ ...base, wayOut: 'decide-plan', thread: { ...base.thread, cards: [leadPlan] } })
    const decide = vi.spyOn(store.lead, 'decide').mockResolvedValue(base)
    await focusDecision('plan')
    const surface = document.activeElement!
    await act(async () => surface.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true })))
    expect(decide).not.toHaveBeenCalled()
    await act(async () => vi.advanceTimersByTimeAsync(501))
    await act(async () => surface.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true })))
    expect(decide).toHaveBeenCalledOnce()
    expect(decide).toHaveBeenCalledWith(expect.objectContaining({ choice: key === '2' ? 'approve' : 'decline' }))
  } finally { vi.useRealTimers() }
})


it.each(['running', 'waiting-for-user'] as const)('confirms Stop goal from %s and leaves files and worktrees in place', async phase => {
  const base = leadProjection(), { box, request } = await mount({ ...base,
    waitReason: phase === 'waiting-for-user' ? 'lead-predecessor-unavailable' : null,
    thread: { ...base.thread, state: phase, contract: leadPlan.contract } })
  const stopLabel = 'Stop goal'
  expect(button(stopLabel)).toBeDefined()
  expect(box.querySelector('[data-slot="top-bar"]')?.textContent).not.toContain('Stop goal')
  if (phase === 'running') expect(box.querySelector('[data-slot="lead-run-strip"] button')?.textContent).toBe('Stop goal')
  await act(async () => button(stopLabel).click())
  expect(document.querySelector('[role="alertdialog"]')?.textContent).toContain('Files and worktrees are left as they are.')
  expect(request.mock.calls.filter(([method]) => method === 'lead/stop')).toHaveLength(0)
  await act(async () => button('Keep working').click())
  expect(document.querySelector('[role="alertdialog"]')).toBeNull()
  await act(async () => button(stopLabel).click())
  const confirm = [...document.querySelectorAll<HTMLButtonElement>('[role="alertdialog"] button')].find(node => node.textContent === 'Stop goal')!
  let release!: () => void
  request.mockImplementation(async method => {
    if (method === 'lead/stop') await new Promise<void>(resolve => { release = resolve })
    return { ...base, revision: base.revision + 1, thread: { ...base.thread, state: 'stopped' } } as never
  })
  await act(async () => { confirm.click(); confirm.click() })
  expect(request.mock.calls.filter(([method]) => method === 'lead/stop')).toEqual([['lead/stop', { expectedRevision: base.revision }]])
  await act(async () => release())
  expect(document.querySelector('[role="alertdialog"]')).toBeNull()
  expect(button(stopLabel)).toBeUndefined()
  expect(box.querySelector('textarea')).not.toBeNull()
  expect(liveLine(box)?.textContent).toBe('This goal was stopped.')
})

it('says the Lead is thinking while its request runs, and goes quiet when it waits for the person', async () => {
  const base = leadProjection(), { box, update } = await mount({ ...base, requestInFlight: true, thread: { ...base.thread, state: 'planning', messages: [goalMessage] } })
  expect(liveLine(box)?.textContent).toBe('Thinking…')
  expect(liveLine(box)?.getAttribute('role')).toBe('status')
  await update({ requestInFlight: false })
  expect(liveLine(box)).toBeNull()
  // The first send, before the Lead's process has begun.
  await update({ requestInFlight: true, thread: { ...base.thread, state: 'draft', messages: [goalMessage] } })
  expect(liveLine(box)?.textContent).toBe('Thinking…')
  // A plan on the table is not planning; the line would only flash under it.
  await update({ wayOut: 'decide-plan', thread: { ...base.thread, state: 'awaiting-plan', messages: [goalMessage], cards: [leadPlan], cardPositions: { plan: 2 } } })
  expect(liveLine(box)).toBeNull()
})

it('says which step a running goal is on and how many runs it has started', async () => {
  const base = leadProjection(), step = leadPlan.contract.steps[0]!
  const contract = { ...leadPlan.contract, steps: [{ ...step, id: 'one', title: 'Repair the parser' }, { ...step, id: 'two', title: 'Check the result' }] }
  const running = { ...base.thread, state: 'running' as const, messages: [goalMessage], contract }
  const { box, update } = await mount({ ...base, progress: { step: 1, steps: 2, runs: 0 }, thread: running })
  expect(liveLine(box)?.textContent).toBe('Step 1 of 2 · Repair the parser · no runs yet')
  await update({ progress: { step: 1, steps: 2, runs: 1 } })
  expect(liveLine(box)?.textContent).toBe('Step 1 of 2 · Repair the parser · 1 run')
  await update({ progress: { step: 2, steps: 2, runs: 2 } })
  expect(liveLine(box)?.textContent).toBe('Step 2 of 2 · Check the result · 2 runs')
  expect(liveLine(box)?.hasAttribute('data-settled')).toBe(false)
  // Without a reading from the host there is nothing to say; a goal that waits on the person is not running.
  await update({ progress: undefined })
  expect(liveLine(box)).toBeNull()
  await update({ progress: { step: 2, steps: 2, runs: 2 }, thread: { ...running, state: 'waiting-for-user' } })
  expect(liveLine(box)).toBeNull()
})

it('keeps the live line off a window that cannot trust its projection', async () => {
  const base = leadProjection(), { box, store } = await mount({ ...base, requestInFlight: true, progress: { step: 1, steps: 1, runs: 1 }, thread: { ...base.thread, state: 'running', messages: [goalMessage], contract: leadPlan.contract } })
  expect(liveLine(box)).not.toBeNull()
  await act(async () => store.lead.changed({ method: 'lead/changed', params: { version: 1, revision: base.revision + 1, error: 'lead-projection-failed' } }))
  expect(box.querySelector('[role="alert"]')).not.toBeNull()
  expect(liveLine(box)).toBeNull()
})

it('says the goal was stopped when nothing else in the thread does', async () => {
  const base = leadProjection(), stopped = { ...base.thread, state: 'stopped' as const, messages: [goalMessage], contract: leadPlan.contract }
  const { box, update } = await mount({ ...base, thread: stopped })
  expect(liveLine(box)?.textContent).toBe('This goal was stopped.')
  expect(liveLine(box)?.hasAttribute('data-settled')).toBe(true)
  // A card that says it stopped already speaks for itself.
  await update({ thread: { ...stopped, cards: [{ version: 1, id: 'stopped', revision: 1, type: 'stopped', contractDigest: leadPlan.contract.digest, reason: 'budget', summary: 'Reported spend reached the cap', budget: leadBudget }], cardPositions: { stopped: 2 } } })
  expect(box.textContent).toContain('The Lead stopped. Inspect its allowance and run.')
  expect(liveLine(box)).toBeNull()
  // A goal the person accepted or declined ended by their decision, not by a stop.
  for (const state of ['accepted', 'declined'] as const) { await update({ thread: { ...stopped, state } }); expect(liveLine(box), state).toBeNull() }
  // Nothing else in the thread is no reason to say nothing.
  await update({ thread: { ...stopped, messages: [] } })
  expect(liveLine(box)?.textContent).toBe('This goal was stopped.')
  expect(box.textContent).not.toContain("Hi, I'm")
})

it('names why a goal stopped when the stop was not the person\'s', async () => {
  const base = leadProjection(), stopped = { ...base.thread, state: 'stopped' as const, messages: [goalMessage], contract: leadPlan.contract }
  const { box, update } = await mount({ ...base, thread: { ...stopped, budget: { ...leadBudget, stop: { reason: 'unknown-spend', revision: leadBudget.revision } } } })
  expect(liveLine(box)?.textContent).toBe("This goal was stopped because HarnessDesk couldn't confirm what the workers spent.")
  await update({ thread: { ...stopped, budget: { ...leadBudget, stop: { reason: 'rounds', revision: leadBudget.revision } } } })
  expect(liveLine(box)?.textContent).toBe('This goal was stopped at its round allowance.')
})

it('shows what the Lead said first before the plan it proposed, in the order it was said', async () => {
  const base = leadProjection(), intro = 'I will repair the failing check in two steps.'
  const { box } = await mount({ ...base, wayOut: 'decide-plan', thread: { ...base.thread, state: 'awaiting-plan', cards: [{ ...leadPlan, revision: 1 }], cardPositions: { plan: 3 },
    messages: [goalMessage, { version: 1, id: 'intro', revision: 2, role: 'assistant', text: intro }] } })
  const text = box.querySelector('[aria-label="Dex thread"]')!.textContent!
  expect(text.indexOf(goalMessage.text)).toBeGreaterThanOrEqual(0)
  expect(text.indexOf(goalMessage.text)).toBeLessThan(text.indexOf(intro))
  expect(text.indexOf(intro)).toBeLessThan(text.indexOf("Here's my plan:"))
})

it('runs the host-projected required check as the person after showing its whole command', async () => {
  const base = leadProjection(), running = { ...base.thread, state: 'running' as const, messages: [goalMessage], contract: leadPlan.contract }
  const action = { kind: 'check' as const, id: 'check-1', runId: 'run-1', name: 'verify', command: 'node -e "process.exit(0)"' }
  const { box, request } = await mount({ ...base, thread: running, personActions: [action] })
  request.mockImplementation((async (method: string) => method === 'lead/action/perform' ? { ...base, revision: base.revision + 1, thread: running, personActions: [] } : base) as never)
  expect(box.textContent).toContain(action.command)
  await act(async () => button('Run check verify').click())
  expect(request).toHaveBeenCalledWith('lead/action/perform', { id: action.id, contractDigest: leadPlan.contract.digest, choice: 'run' })
  expect(box.textContent).not.toContain('Run check verify')
})
it('says nothing about a check while the goal is not running or the plan asks for none', async () => {
  const base = leadProjection(), room = 'team-1'
  const { box } = await mount({ ...base, team: room, thread: { ...base.thread, state: 'waiting-for-user' as const, messages: [goalMessage], contract: leadPlan.contract } })
  expect(box.textContent).not.toContain('project check')
})

it('puts a steer where it was said, not after everything that followed', async () => {
  const base = leadProjection(), later = { version: 1 as const, id: 'later', revision: 5, role: 'assistant' as const, text: 'Step two is done.' }
  const { box } = await mount({ ...base, thread: { ...base.thread, state: 'running', messages: [goalMessage, later] },
    steers: [{ id: 'steer-1', text: 'Keep the public API unchanged.', at: 1, state: 'acknowledged', after: 2 }] })
  const text = box.textContent ?? ''
  expect(text.indexOf('Keep the public API unchanged.')).toBeGreaterThan(text.indexOf('Repair the failing check'))
  expect(text.indexOf('Keep the public API unchanged.')).toBeLessThan(text.indexOf('Step two is done.'))
})

it('explains a foreign PR head while the goal needs the person', async () => {
  const base = leadProjection(), { box } = await mount({ ...base, wayOut: 'resume', waitReason: 'lead-pr-head-changed',
    thread: { ...base.thread, state: 'waiting-for-user', cards: [] } })
  expect(box.textContent).toContain('The pull request head changed outside this goal. Inspect the pull request before continuing.')
})

it('shows checks and reviews on the observed head while the person owns the branch', async () => {
  const base = leadProjection(), head = 'b'.repeat(40)
  const { box } = await mount({ ...base, thread: { ...base.thread!, state: 'following', pr: { repository: 'acme/widgets', number: 7,
    branch: 'worker', head: 'a'.repeat(40), observedHead: head, branchOwner: 'person', state: 'open',
    check: { head, state: 'passed', total: 1 }, review: { id: 1, head, state: 'approved' }, at: 100 } } })
  expect(box.textContent).toContain('Checks passed')
  expect(box.textContent).toContain('Review approved')
  expect(box.textContent).toContain('Your branch')
  expect(box.querySelector('[data-slot="lead-pr-status"] button')?.getAttribute('title')).toBe(head)
})

it('renders a scheduled origin as a short time without its internal id or timestamp', async () => {
  const base = leadProjection(), slot = new Date(2026, 9, 26, 9).getTime()
  const { box } = await mount({ ...base, thread: { ...base.thread, cards: [leadPlan], origin: { source: 'schedule', event: 'schedule-repeat-internal-id', subject: String(slot), url: null } } })
  const text = [...box.querySelectorAll('[data-role="meta"]')].find(node => node.textContent?.startsWith('From:'))!.textContent!
  expect(text).toContain('From: scheduled run, Mon, Oct 26')
  expect(text).toContain('9:00 AM')
  expect(text).not.toContain('internal-id')
  expect(text).not.toContain(String(slot))
})

it.each(['accepted', 'declined'] as const)('keeps informational history read-only after a goal is %s and another begins', async outcome => {
  const base = leadProjection(), warning = { version: 1 as const, id: 'warning-old', revision: 1, type: 'allowance-warning' as const, contractDigest: null,
    logicalGoalId: 'goal-old', usdMicros: 4000000, caps: { usdMicros: 5000000, rounds: 4 } }
  const look = { version: 1 as const, id: 'look-old', revision: 1, type: 'second-look' as const, contractDigest: null,
    logicalGoalId: 'goal-old', runId: 'run-old', stopKey: 'stop-old', said: 'Blocked on #231', found: '#231 merged', did: 'Restarted' }
  const { box, update } = await mount({ ...base, thread: { ...base.thread, state: outcome, budget: { ...leadBudget, logicalGoalId: 'goal-old' }, cards: [warning, look] } })
  expect(box.textContent).toContain('At 80%')
  expect(box.textContent).not.toContain('Raise limit…')
  await update({ thread: { ...base.thread, state: 'running', budget: { ...leadBudget, logicalGoalId: 'goal-new', caps: { usdMicros: 15000000, rounds: 4 } },
    cards: [], decisions: [{ card: warning, position: 1 }, { card: look, position: 2 }] } })
  expect(box.textContent).toContain('Second look')
  expect(box.textContent).toContain('$4.00 of $5.00')
  expect(box.textContent).not.toContain('Raise limit…')
})

it('keeps Raise limit available on the current stopped goal', async () => {
  const base = leadProjection(), warning = { version: 1 as const, id: 'warning-stopped', revision: 1, type: 'allowance-warning' as const, contractDigest: null,
    logicalGoalId: 'goal-stopped', usdMicros: 4000000, caps: { usdMicros: 5000000, rounds: 4 } }
  const { box } = await mount({ ...base, thread: { ...base.thread, state: 'stopped', budget: { ...leadBudget, logicalGoalId: 'goal-stopped', stop: { reason: 'cancelled', revision: 3 } }, cards: [warning] } })
  expect(box.textContent).toContain('Raise limit…')
})

it('links the followed PR with check, review and ownership chips and limits working text to the active repair', async () => {
  const base = leadProjection(), pr = { repository: 'acme/widgets', number: 12, branch: 'repair', head: 'a'.repeat(40), branchOwner: 'person' as const, state: 'open' as const, check: null, review: null, at: 1 }
  const { box, update } = await mount({ ...base, thread: { ...base.thread, state: 'following', pr, origin: { source: 'pull-request', event: 'checks-failed', subject: 'acme/widgets#12', url: 'https://github.com/acme/widgets/pull/12' } } })
  const row = box.querySelector('[data-slot="lead-pr-status"]')!
  expect(row.textContent).toContain('#12'); expect(row.textContent).toContain('Checks not confirmed'); expect(row.textContent).toContain('Review not confirmed')
  expect(row.querySelector('[data-slot="chip"]')?.textContent).toBe('Your branch')
  expect(row.querySelector('button,a')).not.toBeNull()
  expect(box.textContent).toContain('From: checks failed on acme/widgets#12')
  expect(box.querySelector('[data-slot="lead-run-strip"]')?.textContent).toContain('Following #12')
  const handback = { key: 'repair', event: 'checks-failed', kind: 'checks' as const, head: pr.head, runId: 'run', teamId: 'team', round: 2, at: 1, stage: 'running' as const, publishedHead: null }
  await update({ thread: { ...base.thread, state: 'running', pr: { ...pr, branchOwner: 'lead' }, handback } })
  expect(liveLine(box)?.textContent).toBe('Repairing checks · round 2')
  await update({ thread: { ...base.thread, state: 'following', pr, handback: { ...handback, stage: 'completed' } } })
  expect(box.textContent).not.toContain('Repairing checks')
})

it.each([
  ['lead-plan-not-independent', 'reviewer'],
  ['lead-plan-unseatable', 'permissions'],
  ['lead-plan-refused', 'plan'],
  ['lead-card-too-large', 'large'],
  ['lead-start-binding-failed', 'linked'],
  ['lead-result-revisions-exhausted', 'revision limit'],
] as const)('keeps %s actionable without a Resume loop', async (waitReason, text) => {
  const base = leadProjection()
  const { box } = await mount({ ...base, thread: { ...base.thread, state: 'waiting-for-user', cards: [] }, wayOut: null, waitReason })
  expect(box.textContent).toContain(text)
  expect(button('Resume')).toBeUndefined()
  expect(box.querySelector('textarea')?.disabled).toBe(false)
})

it('does not leave a planning goal banner after an ordinary chat reply', async () => {
  const base = leadProjection()
  const { box } = await mount({ ...base, requestInFlight: false, thread: { ...base.thread, state: 'planning', contract: null,
    cards: [], messages: [goalMessage, { version: 1, id: 'answer', revision: 8, role: 'assistant', text: 'Here is what I found.' }] } })
  expect(box.querySelector('[data-slot="lead-run-strip"]')).toBeNull()
  expect(button('Stop goal')).toBeUndefined()
  expect(box.querySelector('textarea')?.disabled).toBe(false)
})

it('can stop an ordinary reply without requiring a goal topic', async () => {
  const base = leadProjection()
  const { request } = await mount({ ...base, requestInFlight: true, thread: { ...base.thread, state: 'planning', contract: null,
    cards: [], messages: [goalMessage] } })
  const stop = button('Stop reply')
  expect(stop).toBeDefined()
  await act(async () => stop!.click())
  expect(request.mock.calls.some(([method]) => method === 'lead/stop')).toBe(true)
})

it.each([
  ['lead-repair-failed', 'Checks failed on the repaired branch.'],
  ['lead-repair-withdrawn', 'The repair was withdrawn when following was turned off.'],
  ['lead-repair-abandoned', 'The repair ended after the branch changed.'],
  ['lead-repair-unverified', 'CI passed, but the current branch has no matching reviewed result.'],
] as const)('explains the durable %s wait', async (waitReason, text) => {
  const base = leadProjection()
  const { box } = await mount({ ...base, thread: { ...base.thread!, state: 'waiting-for-user', cards: [] }, wayOut: 'resume', waitReason })
  expect(box.textContent).toContain(text)
  expect(box.querySelector('[data-lead-decision]')).toBeNull()
})

it('uses one hand-back limit sentence in the thread and dock', async () => {
  const base = leadProjection(), { box } = await mount({ ...base, waitReason: 'lead-handback-limit', wayOut: 'resume', thread: { ...base.thread, state: 'waiting-for-user', messages: [goalMessage], cards: [] } })
  expect(box.querySelector('[data-lead-card="handback-limit"]')).not.toBeNull()
  const sentence = 'Automatic repairs reached their limit. Inspect the pull request before continuing.'
  expect(box.textContent?.match(/Automatic repairs reached their limit\./g)).toHaveLength(2)
  expect(box.textContent?.split(sentence)).toHaveLength(3)
})
it('explains a repair recovery refusal separately from publication', async () => {
  const base = leadProjection(), { box } = await mount({ ...base, waitReason: 'lead-repair-recovery-failed' as any, wayOut: 'resume', thread: { ...base.thread, state: 'waiting-for-user', messages: [goalMessage], cards: [] } })
  expect(box.textContent).toContain('The repair could not be recovered.')
  expect(box.textContent).not.toContain('could not be published')
})

it("starting an opening job preserves the person's unfinished composer draft", async () => {
  const { store, box } = await mount()
  Object.assign(store.getSnapshot(), { goals: new Map([['team-1', { goal: { id: 'team-1', root: '/workspace/demo', state: 'open', sentence: 'Keyboard focus' } }]]),
    flowExecutions: new Map([['run-1', { id: 'run-1', goal: 'team-1', state: 'stalled', rounds: [] }]]) })
  await input(box.querySelector('textarea')!, 'Keep this unfinished goal')
  const start = box.querySelector<HTMLButtonElement>('button[aria-label="Start Unblock Keyboard focus"]')!
  expect(start).not.toBeNull()
  await act(async () => start.click())
  expect(box.querySelector('textarea')!.value).toBe('Keep this unfinished goal')
})


it('uncertain chat notice acknowledges with Stop only and preserves the draft', async () => {
  const base = leadProjection(), { store, box, update } = await mount({ ...base, waitReason: 'lead-chat-effect-uncertain',
    wayOut: 'resume', thread: { ...base.thread, state: 'waiting-for-user', cards: [] } })
  const stop = vi.spyOn(store.lead, 'stop').mockImplementation(async () => {
    const stopped: LeadWindowProjection = { ...base, wayOut: null, waitReason: null, thread: { ...base.thread, state: 'stopped', cards: [] } }
    await update(stopped)
    return stopped
  })
  const send = vi.spyOn(store.lead, 'send').mockRejectedValue({ code: 'lead-chat-effect-uncertain' })
  const resume = vi.spyOn(store.lead, 'resume')
  const composer = box.querySelector('textarea')!
  await input(composer, 'My separate next request')
  expect(button('Resume')).toBeUndefined()
  expect(box.textContent).toContain('may have started')
  await act(async () => button('Send').click())
  expect(composer.value).toBe('My separate next request')
  expect(box.textContent).toContain('Start new request')
  const action = button('Start new request')
  expect(action.closest('[data-slot="composer-notices"]')).not.toBeNull()
  await act(async () => action.click())
  expect(stop).toHaveBeenCalledTimes(1)
  expect(send).toHaveBeenCalledTimes(1)
  expect(resume).not.toHaveBeenCalled()
  expect(composer.value).toBe('My separate next request')
})

it('renders saved approvals as a plain list with quiet row actions sharing the dock busy state', async () => {
  const base = leadProjection(), action = { kind: 'worker-approval', id: 'worker', runId: 'run', role: 'worker', request: 'change demo.ts', choices: ['yes-once', 'yes-goal', 'no'] } as any
  const { box, request } = await mount({ ...base, thread: { ...base.thread, state: 'running', contract: leadPlan.contract }, personActions: [action], savedApprovals: [{ id: 'saved', target: '/workspace/demo/demo.ts', count: 1 }] })
  expect(box.querySelector('[data-lead-card="saved-approvals"]')).toBeNull()
  const revoke = [...box.querySelectorAll('button')].find(button => button.textContent === 'Revoke')!
  expect(revoke.dataset.variant).toBe('secondary')
  let settle!: () => void
  request.mockImplementation(async () => new Promise<any>(resolve => { settle = () => resolve(base) }))
  await act(async () => revoke.click())
  expect([...box.querySelectorAll('button')].find(button => button.textContent === 'Yes for this goal')!.disabled).toBe(true)
  await act(async () => settle())
})

it('shows host approval notices separately and opens the exact allowed diff', async () => {
  const base = leadProjection(), diff = '+export const demo = 2'
  const notice: any = { version: 1, id: 'message-2', revision: 2, role: 'notice', text: 'Allowed under your rule for this goal: /workspace/demo/demo.ts', approval: { ruleId: 'saved', target: '/workspace/demo/demo.ts', diff } }
  const { box } = await mount({ ...base, thread: { ...base.thread, messages: [notice] } })
  expect(box.querySelector('article[aria-label="Desk"]')).not.toBeNull()
  const open = [...box.querySelectorAll('button')].find(button => button.textContent === 'View allowed diff')!
  await act(async () => open.click())
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain(diff)
})

it('updates one rule notice in place and reads newest diffs from its saved row', async () => {
  const base = leadProjection(), saved = { id: 'saved', target: '/workspace/demo/panel.tsx', count: 20, entries: [{ id: 'audit-20', number: 20, diff: '+newest whole diff' }, { id: 'audit-19', number: 19, diff: '+previous whole diff' }] }
  const { box, update } = await mount({ ...base, thread: { ...base.thread, messages: [goalMessage] }, savedApprovals: [saved] } as any)
  const line = box.querySelector('article[aria-label="Desk"]')!
  expect(line?.textContent).toContain('20 times')
  expect(box.querySelectorAll('article[aria-label="Desk"]')).toHaveLength(1)
  await update({ savedApprovals: [{ ...saved, count: 21 }] } as any)
  expect(box.querySelector('article[aria-label="Desk"]')).toBe(line)
  expect(line.textContent).toContain('21 times')
  const list = box.querySelector('section[aria-label="Saved approvals for this goal"]')!
  const open = [...list.querySelectorAll('button')].find(button => button.textContent === 'View allowed diffs')!
  await act(async () => open.click())
  const dialog = document.querySelector('[role="dialog"]')!
  expect(dialog.textContent).toContain('+newest whole diff')
  expect(dialog.textContent!.indexOf('+newest')).toBeLessThan(dialog.textContent!.indexOf('+previous'))
})

it('sanitizes host notice text, target and retained diff text', async () => {
  const base = leadProjection(), escape = '\x1b[31m', diff = escape + '+whole diff'
  const notice: any = { version: 1, id: 'host', revision: 1, role: 'notice', text: escape + 'Host fact', approval: { ruleId: 'old', target: escape + '/workspace/demo/demo.ts', diff } }
  const { box } = await mount({ ...base, thread: { ...base.thread, messages: [notice] } })
  expect(box.textContent).not.toContain(escape)
  await act(async () => button('View allowed diff').click())
  expect(document.querySelector('[role="dialog"]')?.textContent).not.toContain(escape)
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain('+whole diff')
})
