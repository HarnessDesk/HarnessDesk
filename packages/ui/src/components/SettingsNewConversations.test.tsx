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
