import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { runtimeId, type ConfigOption, type RuntimeInfo } from '@harnessdesk/protocol'
import { AppStore, emptySnapshot } from '../state/store'
import { StoreProvider } from '../state/context'
import { NewSessionDefaults } from './SettingsAgents'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const host = document.createElement('div')
document.body.append(host)
const root = createRoot(host)
afterEach(() => { act(() => root.render(null)); vi.restoreAllMocks() })
const runtime = runtimeId('demo')
const info = { id: runtime, presentation: { name: 'Demo runtime' } } as RuntimeInfo
const access: ConfigOption = { id: 'access', label: 'Permissions', category: '_permissions', type: 'select',
  currentValue: 'full', recommendedValue: 'workspace', choices: [{ value: 'workspace', label: 'Workspace write' }, { value: 'full', label: 'Full access' }] }
const reason = 'The runtime did not accept its recommended Permissions.'

const setup = () => {
  const store = new AppStore('ws://localhost:0/')
  Object.assign(store.getSnapshot(), emptySnapshot(), { activeRuntime: runtime })
  vi.spyOn(store.transport, 'request').mockImplementation((async (method: string) => method === 'runtime/sessionDefaults' ? [access] : {}) as never)
  return store
}
const mount = async (store: AppStore, permissions = false) => {
  await act(async () => root.render(<StoreProvider store={store}><NewSessionDefaults info={info}
    heading={permissions ? 'Approvals' : 'New sessions'} only={permissions ? option => option.category === '_permissions' : undefined} /></StoreProvider>))
}
const pick = async (value: string) => {
  const select = host.querySelector<HTMLSelectElement>('select[aria-label="Permissions"]')!
  expect(select).toBeTruthy()
  await act(async () => { select.value = value; select.dispatchEvent(new Event('change', { bubbles: true })) })
}

it.each([false, true])('keeps recovery declarations and the refusal until a pick validates (permissions=%s)', async permissions => {
  const store = setup()
  await mount(store, permissions)
  expect(host.textContent).toContain(permissions ? 'Approvals' : 'New sessions')
  expect(host.textContent).toContain(reason)
  await pick('workspace')
  expect(host.textContent).toContain(reason)
  await pick('full')
  expect(host.textContent).not.toContain(reason)
  expect(host.querySelector<HTMLSelectElement>('select[aria-label="Permissions"]')?.value).toBe('full')
})

it('shows a clear-default rejection and leaves choices available for recovery', async () => {
  const store = setup()
  vi.spyOn(store, 'newSessionDefaultsFor').mockResolvedValue([access])
  vi.spyOn(store, 'clearNewSessionDefault').mockRejectedValue(new Error('Recommendation unavailable.'))
  Object.assign(store.getSnapshot(), { staleDraftDefaults: { [runtime]: [{ id: 'retired', label: 'Mode', value: 'old', valueLabel: 'Old', reason: 'Removed.' }] } })
  await mount(store)
  const clear = [...host.querySelectorAll('button')].find(node => node.textContent?.includes('Use the agent’s current value'))!
  await act(async () => clear.click())
  expect(host.textContent).toContain('Recommendation unavailable.')
  expect(host.querySelector('select[aria-label="Permissions"]')).toBeTruthy()
})

it('shows a read failure even when recovery declarations are unavailable', async () => {
  const store = setup()
  vi.spyOn(store, 'newSessionDefaultsFor').mockRejectedValue(new Error('Runtime unavailable.'))
  vi.spyOn(store, 'newSessionDefaultChoicesFor').mockRejectedValue(new Error('Still unavailable.'))
  await mount(store)
  expect(host.textContent).toContain('Runtime unavailable.')
  expect(host.textContent).not.toContain('Set per conversation')
})
