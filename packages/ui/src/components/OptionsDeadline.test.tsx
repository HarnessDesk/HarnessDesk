import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { runtimeId, sessionId, sessionKey, type ConfigOption, type RuntimeInfo, type Session } from '@harnessdesk/protocol'
import type { TransportEvents } from '../lib/transport'
import { PaneProvider, StoreProvider } from '../state/context'
import { AppStore } from '../state/store'
import { PermissionControl } from './ComposerControls'
import { Notices } from './Notices'

const showToast = vi.hoisted(() => vi.fn())
vi.mock('../design', async original => ({ ...(await original<typeof import('../design')>()), Dialog: () => null, showToast }))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const runtime = runtimeId('example'), id = sessionId('one'), key = sessionKey(runtime, id)
const message = 'The agent did not confirm this setting change in time. It may still take effect. Check the current setting before trying again.'
const option = (value: string): ConfigOption => ({ id: 'permissions', label: 'Permissions', category: '_permissions', type: 'select', currentValue: value, choices: [{ value: 'read', label: 'Read' }, { value: 'full', label: 'Full' }] })
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); showToast.mockReset() })

it('keeps the current radio and shows a persistent warning until the real event changes the selection', async () => {
  vi.stubGlobal('sessionStorage', undefined)
  const store = new AppStore('ws://localhost:0/')
  await store.disableTranscriptCache()
  const session: Session = { id, runtime, cwd: '/example', status: { type: 'idle' }, createdAt: 0, updatedAt: 0, itemsLoaded: true, turns: [], options: [option('read')] }
  const handlers = (store.transport as unknown as { handlers: TransportEvents }).handlers
  handlers.onEvent(runtime, { type: 'session/started', session })
  Object.assign(store.getSnapshot(), { activeSessionKey: key, activeRuntime: runtime, runtimes: [{ id: runtime, presentation: { name: 'Agent' }, capabilities: {} } as RuntimeInfo] })
  vi.spyOn(store.transport, 'request').mockImplementation((async (method: string) => { if (method === 'session/options/set') throw new Error(message); return null }) as never)
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  try {
    act(() => root.render(<StoreProvider store={store}><PaneProvider scope={{ paneId: 'one', view: { kind: 'conversation', session: key }, sessionKey: key }}><PermissionControl /></PaneProvider><Notices /></StoreProvider>))
    const trigger = () => container.querySelector<HTMLButtonElement>('[data-composer-track="permissions"] button')!
    expect(trigger().textContent).toContain('Read')
    act(() => trigger().click())
    const radio = (text: string) => [...document.querySelectorAll<HTMLElement>('[role="menuitemradio"]')].find(row => row.textContent?.trim() === text)!
    expect(radio('Read').getAttribute('aria-checked')).toBe('true')
    await act(async () => store.setOption('permissions', 'full', key))
    expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ tone: 'warning', title: message }), { persist: true })
    expect(trigger().textContent).toContain('Read')
    await act(async () => {
      handlers.onEvent(runtime, { type: 'session/options', sessionId: id, options: [option('full')] }, { epoch: 'epoch', generation: 'generation', revision: 1, sequence: 1 })
      await new Promise<void>(resolve => requestAnimationFrame(() => resolve()))
    })
    expect(store.getSnapshot().sessions.get(key)?.options?.[0]?.currentValue).toBe('full')
    expect(trigger().textContent).toContain('Full')
    expect(radio('Full').getAttribute('aria-checked')).toBe('true')
  } finally { act(() => root.unmount()); container.remove() }
})
