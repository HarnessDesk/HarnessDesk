import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { NO_CAPABILITIES, runtimeId, type RuntimeInfo, type RuntimeHealth } from '@harnessdesk/protocol'
import { StoreProvider } from '../state/context'
import { emptySnapshot, type AppStore } from '../state/store'
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
    newSessionDefaultsFor: vi.fn(async () => []), setNewSessionDefault: vi.fn(async () => []),
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
