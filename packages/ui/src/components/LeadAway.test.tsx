import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it } from 'vitest'
import { StoreProvider } from '../state/context'
import { createLeadFixtureStore } from '../preview/frames-lead'
import { LeadPage } from './LeadPage'
import { LeadRecap, leadDigestSections, leadDigestTitle } from './LeadAway'
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
