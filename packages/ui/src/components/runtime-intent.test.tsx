import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { NO_CAPABILITIES, runtimeId, type RuntimeInfo, type RuntimeHealth } from '@harnessdesk/protocol'
import { StoreProvider } from '../state/context'
import { emptySnapshot, AppStore } from '../state/store'
import { AgentControl } from './ComposerControls'
import { RuntimesSection } from './SettingsAgents'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const info = (id: string): RuntimeInfo => ({ id: runtimeId(id), name: id, version: null, presentation: { name: id }, capabilities: NO_CAPABILITIES })
const mount = async (settings: boolean) => {
  const runtimes = [info('One'), info('Two')]
  let snapshot = { ...emptySnapshot(), status: 'open' as const, runtimes, activeRuntime: runtimes[0]!.id, healthByRuntime: { Two: { state: 'idle' } as RuntimeHealth } }
  const listeners = new Set<() => void>()
  const request = vi.fn(async (_method: string, _params?: unknown) => null)
  const store = {
    subscribe: (listener: () => void) => { listeners.add(listener); return () => listeners.delete(listener) }, getSnapshot: () => snapshot,
    transport: { request }, selectRuntime: vi.fn(async () => {}),
    loadAccounts: vi.fn(async () => {}), agentCatalog: vi.fn(async () => []), acpRegistry: vi.fn(async () => ({ agents: [], fetchedAt: 1 })),
    healthFor: vi.fn(async () => snapshot.healthByRuntime.Two), optionsFor: vi.fn(async () => snapshot.healthByRuntime.Two.state === 'ready' ? [{ type: 'boolean', id: 'live', label: 'Live option', currentValue: true }] : []),
    loadDraftOptions: vi.fn(async () => {}), newSessionDefaultsFor: vi.fn(async () => snapshot.healthByRuntime.Two.state === 'ready' ? [{ type: 'boolean', id: 'draft', label: 'Draft option', currentValue: true }] : []), setNewSessionDefault: vi.fn(async () => []),
    runtimeResources: vi.fn(async () => []), describeInstalls: vi.fn(async () => null),
  } as unknown as AppStore
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  await act(async () => { root.render(<StoreProvider store={store}>{settings ? <RuntimesSection focus="Two" onSignIn={() => {}} /> : <AgentControl />}</StoreProvider>) })
  return { request, ready: () => { snapshot = { ...snapshot, healthByRuntime: { Two: { state: 'ready' } } }; for (const listener of listeners) listener() }, dispose: () => { act(() => root.unmount()); container.remove() } }
}

it('warms the highlighted agent by pointer and keyboard, and when chosen', async () => {
  const { request, dispose } = await mount(false)
  try {
    act(() => document.querySelector<HTMLButtonElement>('button[title="Which agent starts this conversation"]')!.click())
    const two = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')].find(row => row.textContent?.includes('Two'))!
    request.mockClear()
    act(() => two.dispatchEvent(new MouseEvent('pointerover', { bubbles: true })))
    expect(request).toHaveBeenCalledWith('runtime/warm', { runtime: 'Two' })
    request.mockClear()
    act(() => two.focus())
    expect(request).toHaveBeenCalledWith('runtime/warm', { runtime: 'Two' })
    request.mockClear()
    act(() => two.click())
    expect(request).toHaveBeenCalledWith('runtime/warm', { runtime: 'Two' })
  } finally { dispose() }
})

it('warms an agent when its settings detail mounts', async () => {
  const { request, dispose } = await mount(true)
  try { expect(request).toHaveBeenCalledWith('runtime/warm', { runtime: 'Two' }) } finally { dispose() }
})
it('re-reads health and options when a warmed agent becomes ready', async () => {
  const { request, ready, dispose } = await mount(true)
  try {
    expect(document.body.textContent).not.toContain('Live option')
    await act(async () => ready())
    expect(document.body.textContent).toContain('Live option')
    expect(request.mock.calls.filter(call => call[0] === 'runtime/warm')).toHaveLength(1)
  } finally { dispose() }
})

it('re-reads New sessions controls when the settings warm-up reaches ready', async () => {
  const { ready, dispose } = await mount(true)
  try {
    expect(document.body.textContent).toContain('Set per conversation')
    await act(async () => ready())
    expect(document.body.textContent).toContain('Draft option')
    expect(document.body.textContent).not.toContain('Set per conversation')
  } finally { dispose() }
})

it('choosing a cheap idle agent loads its cached composer controls without a ready event', async () => {
  const store = new AppStore('ws://localhost:0/')
  const runtimes = [info('One'), info('Two')]
  const controls = [{ type: 'boolean', id: 'cached', label: 'Cached control', currentValue: true }]
  const request = vi.spyOn(store.transport, 'request').mockImplementation((async (method: string) => {
    if (method === 'runtime/health') return { state: 'idle' }
    if (method === 'runtime/account') return { accounts: [], signInMethods: [] }
    if (method === 'runtime/sessionDefaults') return controls
    return []
  }) as never)
  const transport = store.transport as unknown as { handlers: { onNotification(notification: unknown): void } }
  for (const info of runtimes) transport.handlers.onNotification({ method: 'runtime/added', params: { info } })
  transport.handlers.onNotification({ method: 'runtime/healthChanged', params: { runtime: runtimes[1]!.id, health: { state: 'idle' } } })
  await store.selectRuntime(runtimes[0]!.id)
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  try {
    await act(async () => root.render(<StoreProvider store={store}><AgentControl /></StoreProvider>))
    act(() => container.querySelector<HTMLButtonElement>('button[title="Which agent starts this conversation"]')!.click())
    const two = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')].find(row => row.textContent?.includes('Two'))!
    request.mockClear()
    await act(async () => two.click())
    expect(store.getSnapshot().activeRuntime).toBe('Two')
    expect(store.getSnapshot().health?.state).toBe('idle')
    expect(store.getSnapshot().draftOptions).toEqual(controls)
    expect(request).toHaveBeenCalledWith('runtime/sessionDefaults', { runtime: 'Two' })
  } finally { act(() => root.unmount()); container.remove(); store.transport.close() }
})
