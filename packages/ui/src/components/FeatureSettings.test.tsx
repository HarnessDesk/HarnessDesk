import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { StoreProvider } from '../state/context'
import { previewStore } from '../preview/harness'
import { FeatureSettings } from './FeatureSettings'
import { AppearanceSection, NotificationsSection } from './SettingsYou'
import { resolveSection } from './Settings'
import { destinationAvailable, readDestination } from '../state/destinations'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let cleanup = () => {}
afterEach(() => { cleanup(); document.body.innerHTML = '' })
const mount = async (node: React.ReactNode, store = previewStore({ features: { lead: false, mobile: false } })) => {
  const box = document.createElement('div'); document.body.append(box); const root = createRoot(box)
  cleanup = () => act(() => root.unmount())
  await act(async () => root.render(<StoreProvider store={store}>{node}</StoreProvider>))
  return { box, store }
}
const click = async (label: string) => act(async () => [...document.querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent === label)!.click())
it('keeps legacy phone and disabled Lead settings routes available', () => {
  expect(resolveSection('phone')).toBe('phone')
  expect(resolveSection('lead')).toBe('lead')
  const destination = { kind: 'settings', route: { kind: 'section', section: 'lead', focus: null } } as const
  expect(destinationAvailable(destination, false)).toBe(true)
  expect(readDestination(destination, false)).toEqual(destination)
})
it('writes switches through the store and keeps failed saves inline', async () => {
  const store = previewStore({ features: { lead: false, mobile: false } })
  const save = vi.fn(async () => { throw new Error('Could not save Mobile.') })
  Object.assign(store, { setFeature: save })
  await mount(<FeatureSettings feature="mobile" />, store)
  await act(async () => document.querySelector<HTMLButtonElement>('[role="switch"]')!.click())
  expect(save).toHaveBeenCalledWith('mobile', true)
  expect(document.body.textContent).toContain('Could not save Mobile.')
  expect(document.querySelector('[role="switch"]')?.getAttribute('aria-checked')).toBe('false')
})
it('follows remote feature state and confirms repair with its full consequences', async () => {
  const store = previewStore({ features: { lead: false, mobile: false } })
  const repair = vi.fn(async () => { throw new Error('Repair failed. Try again.') })
  Object.assign(store, { repairFeatures: repair })
  await mount(<FeatureSettings feature="lead" />, store)
  act(() => store.patch({ features: { lead: true, mobile: true, problem: { kind: 'preferences', message: 'The saved settings cannot be read.' } } }))
  expect(document.querySelector('[role="switch"]')!.getAttribute('aria-disabled')).toBe('true')
  expect(document.body.textContent).toContain('The saved settings cannot be read.')
  await click('Repair feature settings')
  expect(repair).not.toHaveBeenCalled()
  expect(document.body.textContent).toContain('Both Lead and Mobile turn off. Lead work and phone connections stop. History and phone pairings are retained.')
  await act(async () => [...document.querySelectorAll<HTMLButtonElement>('[role="alertdialog"] button')].find(b => b.textContent === 'Repair feature settings')!.click())
  expect(repair).toHaveBeenCalledOnce()
  expect(document.body.textContent).toContain('Repair failed. Try again.')
})
it('keeps Interface and Palette out of ordinary Appearance without changing saved choices', async () => {
  const { store } = await mount(<AppearanceSection />)
  const labels = [...document.querySelectorAll('[data-slot="row-title"]')].map(row => row.textContent)
  expect(labels).not.toContain('Interface')
  expect(labels).not.toContain('Palette')
  expect(store.getSnapshot().look).toBe('desk')
})
it('puts macOS controls first and discloses detailed routing without hiding recovery', async () => {
  await mount(<NotificationsSection />)
  expect(document.querySelector('[data-slot="row-title"]')?.textContent).toBe('System notifications')
  expect(document.querySelector('select[aria-label^="Where"]')).toBeNull()
  expect(document.body.textContent).toContain('Muted messages')
  expect(document.body.textContent).toContain('Kept messages')
  await click('Message routing')
  expect(document.querySelector('select[aria-label^="Where"]')).not.toBeNull()
})
