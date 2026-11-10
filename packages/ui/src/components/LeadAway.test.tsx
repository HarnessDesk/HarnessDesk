import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { StoreProvider } from '../state/context'
import { createLeadFixtureStore } from '../preview/frames-lead'
import { LeadPage } from './LeadPage'
import { LeadRecap, leadAsksAt, useLeadAsks, leadDigestSections, leadDigestTitle } from './LeadAway'
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

it('dismisses the digest through the host, for this device', async () => {
  const { box, calls } = await mount()
  await act(async () => { box.querySelector<HTMLButtonElement>('[data-slot="lead-away"] button[aria-label*="ismiss"]')!.click() })
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
  const dismiss = calls.find(call => call.method === 'lead/presence/dismiss')!
  expect(dismiss.params.digest).toMatch(/^away-/)
  expect(dismiss.params.device.id).toMatch(/^window:/)
  expect(box.querySelector('[data-slot="lead-away"]')).toBeNull()
})

it('an expired question offers no answer and says nothing was done; an answered one is a receipt', async () => {
  const { box } = await mount()
  const asks = [...box.querySelectorAll<HTMLElement>('[data-slot="lead-ask"]')]
  const expired = asks.find(ask => ask.getAttribute('data-status') === 'expired')!
  expect(expired.querySelectorAll('button')).toHaveLength(0)
  expect(expired.textContent).toContain('Expired · nothing was done')
  const answered = asks.find(ask => ask.getAttribute('data-status') === 'answered')!
  expect(answered.textContent).toMatch(/Answered · iPhone · \d\d:\d\d/)
  expect(answered.querySelector('[data-picked="true"]')!.textContent).toContain('Fix focus only')
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
