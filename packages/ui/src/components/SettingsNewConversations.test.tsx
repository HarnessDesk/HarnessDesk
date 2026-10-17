import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { runtimeId, NO_CAPABILITIES } from '@harnessdesk/protocol'
import { AppStore, emptySnapshot } from '../state/store'
import { StoreProvider } from '../state/context'
import { SettingsTestPage } from '../test-support/settings-page'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const host = document.createElement('div')
document.body.append(host)
const root = createRoot(host)
afterEach(() => { act(() => root.render(null)); vi.restoreAllMocks() })

it('General exposes persisted runtime, permission and recommended model choices', async () => {
  const store = new AppStore('ws://localhost:0/')
  const runtime = runtimeId('demo')
  Object.assign(store.getSnapshot(), emptySnapshot(), { activeRuntime: runtime, runtimes: [{ id: runtime, presentation: { name: 'Demo runtime' }, capabilities: NO_CAPABILITIES }] })
  const options = [{ id: 'access', label: 'Access', category: '_permissions', type: 'select', currentValue: 'workspace', recommendedValue: 'workspace', choices: [{ value: 'workspace', label: 'Workspace write' }, { value: 'full', label: 'Full access' }] },
    { id: 'model', label: 'Model', category: 'model', type: 'select', currentValue: 'small', recommendedValue: 'small', choices: [{ value: 'small', label: 'Small' }, { value: 'large', label: 'Large' }] }]
  vi.spyOn(store.transport, 'request').mockResolvedValue([] as never)
  vi.spyOn(store, 'newSessionDefaultsFor').mockResolvedValue(options as never)
  const select = vi.spyOn(store, 'setNewSessionDefault').mockResolvedValue(options as never)
  await act(async () => root.render(<StoreProvider store={store}><SettingsTestPage section="general" onSignIn={() => {}} /></StoreProvider>))
  expect(host.textContent).toContain('New conversations')
  const control = host.querySelector<HTMLButtonElement>('button[title="Default permission level"]')
  expect(control).toBeTruthy()
  await act(async () => control!.click())
  const full = [...document.querySelectorAll<HTMLElement>('[role^="menuitem"]')].find(node => node.textContent?.includes('Full access'))
  expect(full).toBeTruthy()
  await act(async () => full!.click())
  expect(select).toHaveBeenCalledWith(runtime, 'access', 'full')
  expect(host.textContent).toContain('Your data')
  expect(host.textContent).toContain('Backup')
})


it('keeps explicit choices reachable after a recommendation is refused, and starts with the recovered pick', async () => {
  const store = new AppStore('ws://localhost:0/')
  const runtime = runtimeId('demo')
  Object.assign(store.getSnapshot(), emptySnapshot(), { activeRuntime: runtime, runtimes: [{ id: runtime, presentation: { name: 'Demo runtime' }, capabilities: NO_CAPABILITIES }] })
  const request = vi.spyOn(store.transport, 'request').mockImplementation((async (method: string) => {
    if (method === 'runtime/sessionDefaults') return [{ id: 'access', label: 'Access', category: '_permissions', type: 'select',
      currentValue: 'full', recommendedValue: 'workspace', choices: [{ value: 'workspace', label: 'Workspace write' }, { value: 'full', label: 'Full access' }] }]
    if (method === 'session/create') return { runtime, id: 'recovered', cwd: '/workspace', status: { type: 'idle' }, turns: [], createdAt: 0, updatedAt: 0 }
    return {}
  }) as never)
  await act(async () => root.render(<StoreProvider store={store}><SettingsTestPage section="general" onSignIn={() => {}} /></StoreProvider>))
  const control = host.querySelector<HTMLButtonElement>('button[title="Default permission level"]')
  expect(control).toBeTruthy()
  expect(host.textContent).toContain('The runtime did not accept its recommended Access.')
  await act(async () => store.newSession({ runtime, cwd: '/workspace' }))
  expect(request.mock.calls.some(([method]) => method === 'session/create')).toBe(false)
  await act(async () => control!.click())
  const workspace = [...document.querySelectorAll<HTMLElement>('[role^="menuitem"]')].find(node => node.textContent?.includes('Workspace write'))
  await act(async () => workspace!.click())
  expect(host.textContent).toContain('The runtime did not accept its recommended Access.')
  await act(async () => control!.click())
  const full = [...document.querySelectorAll<HTMLElement>('[role^="menuitem"]')].find(node => node.textContent?.includes('Full access'))
  await act(async () => full!.click())
  expect(control!.textContent).toContain('Full access')
  await act(async () => store.newSession({ runtime, cwd: '/workspace' }))
  expect(request.mock.calls.find(([method]) => method === 'session/create')?.[1]).toMatchObject({ options: { options: { access: 'full' } } })
})

/* General drew the default agent's sign-in refusal as a warning too (#1775). */
const refusal = 'Authentication required — No authentication method selected. Either call the `authenticate` method, or set `auth.type` in settings.json.'
const drawRefused = async (accounts: readonly { kind: 'oauth'; label: string }[]): Promise<string> => {
  const store = new AppStore('ws://localhost:0/')
  const runtime = runtimeId('demo')
  Object.assign(store.getSnapshot(), emptySnapshot(), { activeRuntime: runtime,
    runtimes: [{ id: runtime, presentation: { name: 'Demo runtime' }, capabilities: NO_CAPABILITIES }],
    accountsByRuntime: { [runtime]: { accounts, signInMethods: [] } } })
  vi.spyOn(store.transport, 'request').mockResolvedValue([] as never)
  vi.spyOn(store, 'newSessionDefaultsFor').mockRejectedValue(new Error(refusal))
  vi.spyOn(store, 'newSessionDefaultChoicesFor').mockResolvedValue([])
  await act(async () => root.render(<StoreProvider store={store}><SettingsTestPage section="general" onSignIn={() => {}} /></StoreProvider>))
  return host.textContent ?? ''
}

it('draws no warning for a signed-out default agent\'s sign-in refusal', async () => {
  const text = await drawRefused([])
  expect(text).toContain('New conversations')
  expect(text).not.toContain('Authentication required')
})

it('still warns about a sign-in refusal from a default agent shown signed in', async () => {
  expect(await drawRefused([{ kind: 'oauth', label: 'dev@example.com' }])).toContain('Authentication required')
})
