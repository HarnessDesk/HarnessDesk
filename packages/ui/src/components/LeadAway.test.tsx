import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { StoreProvider } from '../state/context'
import { createLeadFixtureStore } from '../preview/frames-lead'
import { LeadPage } from './LeadPage'
import { LeadRecap, useLeadPresence, leadAsksAt, useLeadAsks, leadDigestLine, leadDigestNote, leadDigestSections, leadDigestTitle } from './LeadAway'
import { openExternal } from '../lib/desktop'
import { leadDigestTarget } from './LeadRefs'
import { leadDigestMore } from '@harnessdesk/protocol'

vi.mock('../lib/desktop', async original => ({ ...(await original<typeof import('../lib/desktop')>()), openExternal: vi.fn() }))
import { leadPresenceFixture } from '../preview/lead-fixture'
import { DestinationPageScope } from '../panels/destination-page'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const clean: (() => void)[] = []
afterEach(() => { clean.splice(0).forEach(fn => fn()); localStorage.clear() })
// The app mounts the window's presence once, beside every page.
const Presence = () => { useLeadPresence(true); return null }
const mount = async ({ page = true }: { readonly page?: boolean } = {}) => {
  const store = createLeadFixtureStore('presence'), box = document.createElement('div'); document.body.append(box)
  const calls: { method: string; params: any }[] = []
  const request = store.transport.request.bind(store.transport)
  store.transport.request = (async (method: string, params: unknown) => { calls.push({ method, params }); return request(method as never, params as never) }) as typeof store.transport.request
  const root = createRoot(box)
  // The Lead page is unmounted while another page shows (its dock renders only when the page is active).
  const render = (shown: boolean) => root.render(<StoreProvider store={store}><Presence />{shown && <DestinationPageScope owner="lead" active><LeadPage focus={null} /></DestinationPageScope>}</StoreProvider>)
  await act(async () => render(page))
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)) })
  clean.push(() => { act(() => root.unmount()); box.remove() })
  const show = async (shown: boolean) => { await act(async () => render(shown)) }
  return { box, store, calls, show }
}

it('orders a digest by what the person acts on: Needs you, then Stopped or stuck, then Done', () => {
  const digest = leadPresenceFixture(1_000_000_000_000).digest!
  expect(leadDigestSections(digest).map(section => section.label)).toEqual(['Needs you', 'Reminders', 'Stopped or stuck', 'Done', 'Kept in memory', 'Settings applied'])
  expect(leadDigestTitle(digest)).toMatch(/^While you were away · \d\d:\d\d–\d\d:\d\d/)
  expect(leadDigestTitle({ ...digest, kind: 'brief' })).toBe('Morning brief')
})

it('shows the host digest at the top, names this window to the host, and replaces the browser-local seen path', async () => {
  const { box, calls } = await mount()
  const card = box.querySelector<HTMLElement>('[data-slot="lead-away"]')!
  expect(card).not.toBeNull()
  expect(card.querySelector('[data-digest-item="work-4"]')!.textContent).toContain('An approval waits for you')
  expect(card.textContent).toContain('$1.20 spent while away')
  const read = calls.find(call => call.method === 'lead/presence/read')!
  expect(read.params.device.id).toMatch(/^window:[0-9a-f]{24}$/)
  expect(read.params.active).toBe(true)
  expect(localStorage.getItem('hd-lead-seen-v1')).toBeNull()
  expect(localStorage.getItem('hd-lead-device-v1')).toMatch(/^[0-9a-f]{24}$/)
})

it('each item the desk can find opens it: a chat, a decision card, a pull request; one it cannot stays a reading', async () => {
  const { box, store } = await mount()
  const openSession = vi.spyOn(store, 'openSession').mockResolvedValue(undefined as never)
  const openDestination = vi.spyOn(store, 'openDestination').mockImplementation(() => {})
  const row = (id: string) => box.querySelector<HTMLElement>(`[data-slot="lead-away"] [data-digest-item="${id}"]`)!
  expect(row('work-4').tagName).toBe('BUTTON')
  expect(row('work-4').getAttribute('data-digest-opens')).toBe('chat')
  await act(async () => { row('work-4').click() })
  expect(openSession).toHaveBeenCalledWith('rename-column', { runtime: 'fixture' })
  await act(async () => { row('plan-2').click() })
  expect(openDestination).toHaveBeenCalledWith({ kind: 'lead', focus: 'plan-2' })
  await act(async () => { row('work-1').click() })
  expect(openExternal).toHaveBeenCalledWith('https://github.com/acme/widgets/pull/42')
  expect(row('work-5').tagName).toBe('DIV')
  expect(row('work-5').getAttribute('data-digest-opens')).toBeNull()
})

it('reminders fired, notes kept and settings applied are their own groups; the heading says what happened, so a row has no second line (#2147)', async () => {
  const { box } = await mount()
  const card = box.querySelector<HTMLElement>('[data-slot="lead-away"]')!
  const row = (id: string) => card.querySelector<HTMLElement>(`[data-digest-item^="${id}"]`)!
  expect(row('remind-1').textContent).toBe('Check the review on the retry list')
  expect(row('m2').textContent).toBe('Release notes go in CHANGELOG.md under Unreleased.')
  expect(row('setting:autonomy:brief:').textContent).toBe('Morning brief, Act')
  expect(card.textContent).toContain('Reminders')
  expect(card.textContent).toContain('Kept in memory')
  expect(card.textContent).toContain('Settings applied')
  expect(leadDigestLine({ kind: 'done', about: 'memory', id: 'm2', title: 'A note', fact: 'Kept in memory' }, 'Dex')).toBeUndefined()
  expect(leadDigestLine({ kind: 'done', id: 'work-1', title: 'Done', fact: 'Pull request merged' }, 'Dex')).toBe('Pull request merged')
})

it('a note kept and a setting applied open their row in Settings; a reminder on its own opens it on the Work list (#2147)', async () => {
  const { box, store } = await mount()
  const openDestination = vi.spyOn(store, 'openDestination').mockImplementation(() => {})
  const card = box.querySelector<HTMLElement>('[data-slot="lead-away"]')!
  await act(async () => { card.querySelector<HTMLElement>('[data-digest-item="m2"]')!.click() })
  expect(openDestination).toHaveBeenLastCalledWith({ kind: 'settings', route: { kind: 'section', section: 'lead', focus: 'memory:m2' } })
  await act(async () => { card.querySelector<HTMLElement>('[data-digest-item^="setting:autonomy:brief:"]')!.click() })
  expect(openDestination).toHaveBeenLastCalledWith({ kind: 'settings', route: { kind: 'section', section: 'lead', focus: 'autonomy:brief' } })
  const desk = { chats: new Set<string>(), teams: new Set<string>(), goals: new Set<string>(), work: new Set<string>() } as never
  expect(leadDigestTarget({ kind: 'reminder', id: 'remind-9' }, desk)).toEqual({ target: { kind: 'reminder', id: 'remind-9' }, title: 'Show the reminder' })
  expect(leadDigestTarget({ kind: 'setting', id: 'rules:done' }, desk)).toEqual({ target: { kind: 'settings', focus: 'rules:done' }, title: 'Show the setting' })
})

it('a pull request link never walks a path: a name of . or .. is no link', () => {
  const desk = { chats: new Set<string>(), teams: new Set<string>(), goals: new Set<string>(), work: new Set<string>() } as never
  expect(leadDigestTarget({ kind: 'pr', id: 'acme/.github#7' }, desk)?.target).toEqual({ kind: 'pr', repository: 'acme/.github', number: '7' })
  for (const id of ['../widgets#1', 'acme/..#1', 'acme/.#2', 'acme/widgets/../x#3']) expect(leadDigestTarget({ kind: 'pr', id }, desk)).toBeNull()
})

it('a stop says who made it: you, the Lead by name, or the host’s fact when nobody is known', async () => {
  const stopped = { kind: 'stopped' as const, id: 'work-6', title: 'Retry the upload test', fact: 'Stopped: its chat was stopped' }
  expect(leadDigestLine({ ...stopped, stoppedBy: 'person' }, 'Dex')).toBe('You stopped it')
  expect(leadDigestLine({ ...stopped, stoppedBy: 'lead' }, 'Dex')).toBe('Dex stopped it')
  expect(leadDigestLine(stopped, 'Dex')).toBe('Stopped: its chat was stopped')
  expect(leadDigestLine({ kind: 'done', id: 'work-1', title: 'Done', stoppedBy: 'person' }, 'Dex')).toBeUndefined()
  const { box } = await mount()
  expect(box.querySelector('[data-digest-item="work-6"]')!.textContent).toContain('You stopped it')
})

it('says that dismissing also clears the items the list had no room for, in the words every surface uses', () => {
  const digest = leadPresenceFixture(1_000_000_000_000).digest!
  expect(leadDigestNote({ ...digest, more: 3 })).toMatch(/^3 more not shown; dismissing clears them too · \$/)
  expect(leadDigestNote({ ...digest, more: 0 })).not.toMatch(/more/)
  expect(leadDigestMore(3)).toBe('3 more not shown; dismissing clears them too')
})

it('dismisses the digest through the host, which clears it for the desk', async () => {
  const { box, calls } = await mount()
  await act(async () => { box.querySelector<HTMLButtonElement>('[data-slot="lead-away"] button[aria-label*="ismiss"]')!.click() })
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
  const dismiss = calls.find(call => call.method === 'lead/presence/dismiss')!
  expect(dismiss.params.digest).toMatch(/^away-/)
  expect(dismiss.params.device.id).toMatch(/^window:/)
  expect(box.querySelector('[data-slot="lead-away"]')).toBeNull()
})

it('an expired question keeps its options as an inert control and says nothing was done; an answered one is a receipt', async () => {
  // The fixture answers an hour before now, and a receipt from an earlier day names the day instead of the time.
  // Pin the clock to midday (local time) so the answer is always today's, whenever the suite runs; timers stay real.
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date(2026, 10, 11, 12, 0))
  clean.push(() => vi.useRealTimers())
  const { box } = await mount()
  const asks = [...box.querySelectorAll<HTMLElement>('[data-slot="lead-ask"]')]
  const settled = (status: string, id: string) => asks.find(ask => ask.getAttribute('data-status') === status && ask.dataset.ask === id)!
  const expired = settled('expired', 'ask-expired')
  // #2105: the options stay a control the person can read as one, not plain text, and none of them can be pressed.
  const options = [...expired.querySelectorAll('button')]
  expect(options.map(option => option.textContent)).toEqual(['Both screens', 'This one only'])
  expect(options.every(option => option.disabled)).toBe(true)
  expect(expired.textContent).toContain('Expired · nothing was done')
  const answered = settled('answered', 'ask-answered')
  expect(answered.textContent).toMatch(/Answered by you on iPhone · \d\d:\d\d/)
  expect([...answered.querySelectorAll('button')].every(option => option.disabled)).toBe(true)
  expect(answered.querySelector('[data-picked="true"]')!.textContent).toContain('Fix focus only')
})

it('#2105: a report\'s question a newer one replaced reads replaced, and only the newest question is live', async () => {
  const { box } = await mount()
  const replaced = box.querySelector<HTMLElement>('[data-slot="lead-ask"][data-ask="ask-replaced"]')!
  expect(replaced.getAttribute('data-status')).toBe('replaced')
  expect(replaced.textContent).toContain('Replaced by a newer question · nothing was done')
  expect([...replaced.querySelectorAll('button')].every(option => option.disabled)).toBe(true)
  const live = box.querySelector<HTMLElement>('[data-slot="lead-ask"][data-ask="ask-live"]')!
  expect([...live.querySelectorAll('button')].some(option => option.disabled)).toBe(false)
})

it('sends the device with every message so the receipt can name it', async () => {
  const { store, calls } = await mount()
  await act(async () => { await store.lead.send('hello', 'key-1') })
  expect(calls.find(call => call.method === 'lead/thread/send')!.params.device.label).toBe('Desktop')
})

it('a tapped option sends the id of the question it answers', async () => {
  const { store, calls } = await mount()
  await act(async () => { await store.lead.send('Start it', 'key-2', 'message-3') })
  expect(calls.filter(call => call.method === 'lead/thread/send').at(-1)!.params.ask).toBe('message-3')
})

it('"What happened?" asks the host for a recap of the last day', async () => {
  const store = createLeadFixtureStore('presence'), box = document.createElement('div'); document.body.append(box)
  const calls: any[] = [], request = store.transport.request.bind(store.transport)
  store.transport.request = (async (method: string, params: unknown) => { calls.push({ method, params }); return request(method as never, params as never) }) as typeof store.transport.request
  const root = createRoot(box)
  await act(async () => root.render(<StoreProvider store={store}><LeadRecap /></StoreProvider>))
  clean.push(() => { act(() => root.unmount()); box.remove() })
  await act(async () => { box.querySelector<HTMLButtonElement>('button[aria-label="What happened?"]')!.click() })
  expect(calls.find(call => call.method === 'lead/presence/read').params.recap).toBe(true)
})

it('an open question reads expired the instant its time comes, without a refresh', () => {
  const asks = [{ id: 'm1', status: 'open' as const, expiresAt: 1000 }, { id: 'm2', status: 'open' as const }, { id: 'm3', status: 'answered' as const, expiresAt: 500, answer: { option: 'Yes', by: 'Desktop', at: 400 } }]
  expect(leadAsksAt(asks, 999).map(ask => ask.status)).toEqual(['open', 'open', 'answered'])
  expect(leadAsksAt(asks, 1000).map(ask => ask.status)).toEqual(['expired', 'open', 'answered'])
})

it('a morning brief has one way to be dismissed, not two', async () => {
  const store = createLeadFixtureStore('presence'), box = document.createElement('div'); document.body.append(box)
  const request = store.transport.request.bind(store.transport)
  store.transport.request = (async (method: string, params: unknown) => {
    const result = await request(method as never, params as never) as any
    return method === 'lead/presence/read' && result.digest ? { ...result, digest: { ...result.digest, kind: 'brief', id: 'brief-1' } } : result
  }) as typeof store.transport.request
  const root = createRoot(box)
  await act(async () => root.render(<StoreProvider store={store}><DestinationPageScope owner="lead" active><LeadPage focus={null} /></DestinationPageScope></StoreProvider>))
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)) })
  clean.push(() => { act(() => root.unmount()); box.remove() })
  const card = box.querySelector('[data-slot="lead-away"]')!
  expect(card.textContent).toContain('Morning brief')
  expect(card.querySelectorAll('button[aria-label*="ismiss"]')).toHaveLength(1)
  expect([...card.querySelectorAll('button')].some(button => button.textContent === 'Got it')).toBe(false)
})

it('the buttons of a question go the moment it expires, with no refresh', async () => {
  vi.useFakeTimers()
  try {
    vi.setSystemTime(1_000_000)
    const asks = [{ id: 'm1', status: 'open' as const, expiresAt: 1_000_000 + 60_000 }]
    const Probe = () => <p>{useLeadAsks(asks)[0]!.status}</p>
    const box = document.createElement('div'); document.body.append(box)
    const root = createRoot(box)
    await act(async () => root.render(<Probe />))
    expect(box.textContent).toBe('open')
    await act(async () => { vi.advanceTimersByTime(60_100) })
    expect(box.textContent).toBe('expired')
    act(() => root.unmount()); box.remove()
  } finally { vi.useRealTimers() }
})

it('#2147: "What happened?" shows it is reading until the host answers, so the first click is seen to work', async () => {
  const store = createLeadFixtureStore('presence'), box = document.createElement('div'); document.body.append(box)
  let answer: () => void = () => {}
  const request = store.transport.request.bind(store.transport)
  store.transport.request = (async (method: string, params: any) => {
    if (method === 'lead/presence/read' && params.recap) await new Promise<void>(resolve => { answer = resolve })
    return request(method as never, params as never)
  }) as typeof store.transport.request
  const root = createRoot(box)
  await act(async () => root.render(<StoreProvider store={store}><LeadRecap /></StoreProvider>))
  clean.push(() => { act(() => root.unmount()); box.remove() })
  const button = () => box.querySelector('button')!
  await act(async () => { button().click() })
  expect(button().getAttribute('aria-busy')).toBe('true')
  expect(button().disabled).toBe(true)
  expect(button().getAttribute('aria-label')).toBe('Reading…')
  expect(button().querySelector('[data-slot="spinner"]'), 'the icon turns into a spinner while it reads').not.toBeNull()
  await act(async () => { answer(); await new Promise(resolve => setTimeout(resolve, 0)) })
  expect(button().getAttribute('aria-busy')).not.toBe('true')
  expect(button().getAttribute('aria-label')).toBe('What happened?')
})

it('#2147: an open window nobody touches stops marking itself seen, and the first touch after reads as a return', async () => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] })
  clean.push(() => vi.useRealTimers())
  const { calls } = await mount()
  const reads = () => calls.filter(call => call.method === 'lead/presence/read' && !call.params.recap)
  expect(reads().at(-1)!.params.active).toBe(true)
  // Five minutes with nobody at the window: the refreshes still read, but do not say the person looked.
  await act(async () => { vi.advanceTimersByTime(5 * 60_000) })
  expect(reads().length).toBeGreaterThan(2)
  expect(reads().at(-1)!.params.active).toBe(false)
  // The person comes back: the first touch reads at once, as a look.
  const before = reads().length
  await act(async () => { window.dispatchEvent(new Event('pointerdown')) })
  expect(reads().length).toBe(before + 1)
  expect(reads().at(-1)!.params.active).toBe(true)
})

it('#2147: an hour in other pages is an hour looked at, and opening the Lead again is a look', async () => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] })
  clean.push(() => vi.useRealTimers())
  const { calls, show } = await mount()
  const reads = () => calls.filter(call => call.method === 'lead/presence/read' && !call.params.recap)
  // The person leaves the Lead for chats and Settings and works there for an hour, touching the window every minute.
  await show(false)
  const before = reads().length
  for (let minute = 0; minute < 60; minute++) {
    await act(async () => { window.dispatchEvent(new Event('pointermove')); vi.advanceTimersByTime(60_000) })
  }
  const away = reads().slice(before)
  // The window kept telling the host it was looked at, so the desk never sees an absence in that hour.
  expect(away.length).toBeGreaterThanOrEqual(59)
  expect(away.every(call => call.params.active === true)).toBe(true)
  // Five idle minutes on another page, then the click that opens the Lead: that opening is a look, before any input.
  await act(async () => { vi.advanceTimersByTime(5 * 60_000) })
  expect(reads().at(-1)!.params.active).toBe(false)
  await show(true)
  await act(async () => { await Promise.resolve() })
  expect(reads().at(-1)!.params.active).toBe(true)
})
