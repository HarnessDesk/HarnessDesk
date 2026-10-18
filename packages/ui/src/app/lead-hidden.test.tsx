import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { AppStore } from '../state/store'
import { StoreProvider } from '../state/context'
import { MAIN_PAGE_ENTRIES } from './main-page-entries'
import { MainPages } from './MainPages'
import { Sidebar } from '../components/Sidebar'
import { emptyWorkbench, readWorkbench } from '../state/workbench'
import { frameDestinationStore } from '../preview/frame-destination-store'
import { previewStore } from '../preview/harness'
import type { TransportEvents } from '../lib/transport'

vi.mock('../components/Settings', () => ({ Settings: () => <section aria-label="Settings specimen">Settings</section> }))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const mounted: (() => void)[] = []
afterEach(() => { for (const cleanup of mounted.splice(0)) cleanup(); vi.restoreAllMocks() })
const mount = async (store: AppStore, sidebar = false) => {
  const box = document.createElement('div'); document.body.append(box)
  const root = createRoot(box)
  mounted.push(() => { act(() => root.unmount()); box.remove() })
  await act(async () => root.render(<StoreProvider store={store}>{sidebar ? <Sidebar onOpenSettings={() => {}} onOpenPlugins={() => {}} onOpenTeams={() => {}} onOpenAgents={() => {}} onOpenUsage={() => {}} onBrowseFolders={() => {}} onSignIn={() => {}} onSearch={() => {}} /> : null}<MainPages onSignIn={() => {}} onNewTeam={() => {}} libraryImportIntent={0} /></StoreProvider>))
  return box
}

it('keeps the pre-Lead disabled main-page structure', async () => {
  const store = new AppStore('ws://localhost:0/')
  store.openDestination({ kind: 'settings', route: { kind: 'section', section: 'general', focus: null } })
  const box = await mount(store)
  expect(box.innerHTML).toMatchSnapshot()
})

const lead = { kind: 'lead' } as const
const seed = (store: AppStore, available: boolean) => Object.assign(store.getSnapshot(), { leadAvailable: available })

it('starts disabled and refuses programmatic Lead navigation without a host capability', async () => {
  const store = new AppStore('ws://localhost:0/')
  expect(store.getSnapshot().leadAvailable).toBe(false)
  const before = store.getSnapshot().workbench.navigation
  store.openDestination(lead); store.replaceDestination(lead)
  expect(store.getSnapshot().workbench.navigation).toEqual(before)
  expect((await mount(store)).querySelector('[data-page-destination="lead"]')).toBeNull()
})

it('removes restored Lead destinations from current, Back and Forward before mounting', async () => {
  const raw = { ...emptyWorkbench(), navigation: { current: lead, back: [lead], forward: [lead] } }
  const restored = readWorkbench(raw)!
  expect(restored.navigation).toEqual(emptyWorkbench().navigation)
  const store = new AppStore('ws://localhost:0/')
  Object.assign(store.getSnapshot(), { workbench: restored })
  await store.navigateBack(); await store.navigateForward()
  expect(store.getSnapshot().workbench.navigation).toEqual(emptyWorkbench().navigation)
  expect((await mount(store)).innerHTML).toBe('')
})

it('registers the enabled destination and mounts only its empty design-system shell', async () => {
  expect(MAIN_PAGE_ENTRIES.lead).toBeTypeOf('function')
  const store = new AppStore('ws://localhost:0/')
  seed(store, true); store.openDestination(lead)
  const box = await mount(store)
  expect(box.querySelector('[data-page-destination="lead"] [data-slot="page"]')).not.toBeNull()
  expect(box.textContent).toBe('Lead')
  expect(box.querySelectorAll('button,input,textarea')).toHaveLength(0)
  await act(async () => { store.returnToWork(); await store.navigateBack() })
  expect(store.getSnapshot().workbench.navigation.current).toEqual(lead)
})

it('unmounts a retained Lead body and purges its visits when capability is withdrawn', async () => {
  const previous = MAIN_PAGE_ENTRIES.lead
  MAIN_PAGE_ENTRIES.lead = () => <output data-lead-specimen>Lead specimen</output>
  mounted.push(() => { if (previous) MAIN_PAGE_ENTRIES.lead = previous; else delete MAIN_PAGE_ENTRIES.lead })
  const store = new AppStore('ws://localhost:0/')
  seed(store, true); store.openDestination(lead)
  const box = await mount(store)
  expect(box.querySelector('[data-lead-specimen]')).not.toBeNull()
  await act(async () => { store.returnToWork() })
  expect(box.querySelector('[data-lead-specimen]')).not.toBeNull()
  await act(async () => { seed(store, false); store.setWindowSize(1000, 800); await new Promise<void>(resolve => requestAnimationFrame(() => resolve())) })
  expect(box.querySelector('[data-page-destination="lead"]')).toBeNull()
  await store.navigateBack(); await store.navigateForward()
  expect(JSON.stringify(store.getSnapshot().workbench.navigation)).not.toContain('lead')
})

it('gates generic previews and allows only explicit synthetic Lead fixtures', async () => {
  for (const enabled of [false, true]) {
    const store = frameDestinationStore(previewStore({ leadAvailable: enabled }))
    store.openDestination(lead)
    const box = await mount(store)
    expect(Boolean(box.querySelector('[data-page-destination="lead"]'))).toBe(enabled)
  }
})

it('exposes a disabled facade whose every action refuses before transport', async () => {
  const store = new AppStore('ws://localhost:0/'), request = vi.spyOn(store.transport, 'request')
  expect(store.lead).toBeDefined()
  const decision = { version: 1, cardId: 'plan', cardType: 'plan', expectedRevision: 1, contractDigest: 'a'.repeat(64), choice: 'approve' } as const
  for (const action of [() => store.lead.readThread(), () => store.lead.readSettings(), () => store.lead.send('Inspect', 'send-1'),
    () => store.lead.decide(decision), () => store.lead.updateSettings({ credential: { provider: 'anthropic', key: null } }), () => store.lead.resume()]) {
    await expect(action()).rejects.toMatchObject({ code: 'lead-unavailable' })
  }
  expect(request).not.toHaveBeenCalled()
})

it.each([undefined, {}, { lead: false }, { lead: '1' }, { lead: true }])('trusts only the exact host capability %j', async capabilities => {
  const store = new AppStore('ws://localhost:0/')
  const handlers = (store.transport as unknown as { handlers: TransportEvents }).handlers
  vi.spyOn(store.transport, 'connect').mockImplementation(() => handlers.onStatus('open'))
  vi.spyOn(store.transport, 'request').mockImplementation((async (method: string) => method === 'host/hello'
    ? { runtimes: [], home: '/home/user', stateDir: '/desk', credentialProtection: '', goalMigrationPending: false, capabilities } : {}) as never)
  for (const method of ['loadHistory', 'loadPreferences', 'refreshRuntime', 'loadWorkspaces', 'loadPlugins', 'loadAccounts', 'loadGoals', 'loadUsage'] as const)
    vi.spyOn(store, method).mockResolvedValue(undefined as never)
  await store.connect()
  expect(store.getSnapshot().leadAvailable).toBe(capabilities?.lead === true)
  store.openDestination(lead)
  expect(store.getSnapshot().workbench.navigation.current.kind === 'lead').toBe(capabilities?.lead === true)
  handlers.onStatus('reconnecting')
  expect(store.getSnapshot().leadAvailable).toBe(false)
  expect(JSON.stringify(store.getSnapshot().workbench.navigation)).not.toContain('lead')
})

it('the enabled sidebar click opens the Lead destination', async () => {
  const store = new AppStore('ws://localhost:0/')
  seed(store, true)
  const box = await mount(store, true)
  const door = [...box.querySelectorAll('button')].find(button => button.textContent === 'Lead')!
  expect(door).toBeDefined()
  await act(async () => { door.click(); await new Promise<void>(resolve => requestAnimationFrame(() => resolve())) })
  expect(store.getSnapshot().workbench.navigation.current).toEqual(lead)
  expect(box.querySelector('[data-page-destination="lead"] h1')?.textContent).toBe('Lead')
})

it('rechecks the host capability when a transport reconnects', async () => {
  const store = new AppStore('ws://localhost:0/')
  const handlers = (store.transport as unknown as { handlers: TransportEvents }).handlers
  seed(store, true)
  vi.spyOn(store.transport, 'request').mockResolvedValue({ capabilities: { lead: true } } as never)
  handlers.onStatus('reconnecting')
  expect(store.getSnapshot().leadAvailable).toBe(false)
  handlers.onStatus('open')
  await vi.waitFor(() => expect(store.getSnapshot().leadAvailable).toBe(true))
})
