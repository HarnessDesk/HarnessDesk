import { afterEach, expect, it, vi } from 'vitest'
import { runtimeId, sessionId, sessionKey, type ConfigOption, type Session } from '@harnessdesk/protocol'
import type { TransportEvents } from '../lib/transport'
import { AppStore } from './store'

const runtime = runtimeId('example')
const id = sessionId('setting-deadline')
const key = sessionKey(runtime, id)
const message = 'The agent did not confirm this setting change in time. It may still take effect. Check the current setting before trying again.'
const option = (value: string): ConfigOption => ({ id: 'permissions', label: 'Permissions', category: '_permissions', type: 'select', currentValue: value, choices: [{ value: 'read', label: 'Read' }, { value: 'full', label: 'Full' }] })

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

it('warns about an unconfirmed setting and waits for the authoritative option event', async () => {
  vi.stubGlobal('sessionStorage', undefined)
  const store = new AppStore('ws://localhost:0/')
  await store.disableTranscriptCache()
  const session: Session = { id, runtime, cwd: '/example', status: { type: 'idle' }, createdAt: 0, updatedAt: 0, itemsLoaded: true, turns: [], options: [option('read')] }
  const handlers = (store.transport as unknown as { handlers: TransportEvents }).handlers
  handlers.onEvent(runtime, { type: 'session/started', session })
  let reject!: (error: Error) => void
  const request = vi.spyOn(store.transport, 'request').mockImplementation((async (method: string) => {
    if (method === 'session/options/set') return await new Promise((_, fail) => { reject = fail })
    return null
  }) as never)
  const pending = store.setOption('permissions', 'full', key)
  expect(request).toHaveBeenCalledWith('session/options/set', { runtime, sessionId: id, optionId: 'permissions', value: 'full' })
  expect(store.getSnapshot().sessions.get(key)?.options?.[0]?.currentValue).toBe('read')
  reject(new Error(message))
  await pending
  expect(store.getSnapshot().notices).toContainEqual(expect.objectContaining({ level: 'warning', message }))
  expect(store.getSnapshot().sessions.get(key)?.options?.[0]?.currentValue).toBe('read')
  handlers.onEvent(runtime, { type: 'session/options', sessionId: id, options: [option('full')] }, { epoch: 'epoch', generation: 'generation', revision: 1, sequence: 1 })
  expect(store.getSnapshot().sessions.get(key)?.options?.[0]?.currentValue).toBe('full')
})
