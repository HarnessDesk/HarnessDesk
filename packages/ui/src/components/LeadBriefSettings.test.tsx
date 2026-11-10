import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it } from 'vitest'
import { createLeadFixtureStore } from '../preview/frames-lead'
import { StoreProvider } from '../state/context'
import { LeadBriefSettingsSection } from './LeadBriefSettings'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const clean: (() => void)[] = []
afterEach(() => clean.splice(0).forEach(fn => fn()))
const mount = async () => {
  const store = createLeadFixtureStore('presence'), box = document.createElement('div'); document.body.append(box)
  const calls: { method: string; params: any }[] = []
  const request = store.transport.request.bind(store.transport)
  store.transport.request = (async (method: string, params: unknown) => { calls.push({ method, params }); return request(method as never, params as never) }) as typeof store.transport.request
  const root = createRoot(box)
  await act(async () => root.render(<StoreProvider store={store}><LeadBriefSettingsSection label="Dex" /></StoreProvider>))
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
  clean.push(() => { act(() => root.unmount()); box.remove() })
  return { box, calls }
}

it('is off by default, with the time hidden until it is turned on', async () => {
  const { box } = await mount()
  expect(box.querySelector('section')!.textContent).toContain('Morning brief')
  expect(box.querySelector<HTMLElement>('[role="switch"][aria-label="Morning brief"]')!.getAttribute('aria-checked')).toBe('false')
  expect(box.querySelector('input[type="time"]')).toBeNull()
})

it('turning it on and choosing a time are saved through the host', async () => {
  const { box, calls } = await mount()
  await act(async () => { box.querySelector<HTMLElement>('[role="switch"][aria-label="Morning brief"]')!.click() })
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
  expect(calls.filter(call => call.method === 'lead/brief/update').map(call => call.params)).toEqual([{ enabled: true }])
  expect(box.querySelector<HTMLInputElement>('input[aria-label="Morning brief time"]')!.value).toBe('07:30')
  expect(box.textContent).toContain('quiet hours')
})
