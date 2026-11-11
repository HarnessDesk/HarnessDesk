import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { StoreProvider } from '../state/context'
import { createLeadFixtureStore } from '../preview/frames-lead'
import { LeadPage } from './LeadPage'
import { LeadRecap, leadAsksAt, useLeadAsks, leadDigestLine, leadDigestNote, leadDigestSections, leadDigestTitle } from './LeadAway'
import { openExternal } from '../lib/desktop'
import { leadDigestTarget } from './LeadRefs'
import { leadDigestMore } from '@harnessdesk/protocol'

vi.mock('../lib/desktop', async original => ({ ...(await original<typeof import('../lib/desktop')>()), openExternal: vi.fn() }))
import { leadPresenceFixture } from '../preview/lead-fixture'
import { DestinationPageScope } from '../panels/destination-page'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const clean: (() => void)[] = []
afterEach(() => { clean.splice(0).forEach(fn => fn()); localStorage.clear() })
const mount = async () => {
  const store = createLeadFixtureStore('presence'), box = document.createElement('div'); document.body.append(box)
  const calls: { method: string; params: any }[] = []
  const request = store.transport.request.bind(store.transport)
  store.transport.request = (async (method: string, params: unknown) => { calls.push({ method, params }); return request(method as never, params as never) }) as typeof store.transport.request
  const root = createRoot(box)
  await act(async () => root.render(<StoreProvider store={store}><DestinationPageScope owner="lead" active><LeadPage focus={null} /></DestinationPageScope></StoreProvider>))
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)) })
  clean.push(() => { act(() => root.unmount()); box.remove() })
  return { box, store, calls }
}

it('orders a digest by what the person acts on: Needs you, then Stopped or stuck, then Done', () => {
  const digest = leadPresenceFixture(1_000_000_000_000).digest!
  expect(leadDigestSections(digest).map(section => section.label)).toEqual(['Needs you', 'Stopped or stuck', 'Done'])
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
  await act(async () => { [...box.querySelectorAll('button')].find(one => one.textContent === 'What happened?')!.click() })
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
