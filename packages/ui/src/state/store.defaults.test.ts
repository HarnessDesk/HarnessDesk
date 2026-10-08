import { expect, it, vi } from 'vitest'
import { runtimeId, sessionId, type ConfigOption, type HostMethodName } from '@harnessdesk/protocol'
import { AppStore } from './store'
import type { TransportEvents } from '../lib/transport'

const runtime = runtimeId('test-agent')
const declared: ConfigOption[] = [
  { id: 'model', label: 'Model', category: 'model', type: 'select', currentValue: 'old', choices: [
    { value: 'old', label: 'Old model' }, { value: 'current', label: 'Current model' },
  ] },
  { id: 'mode', label: 'Mode', category: 'mode', type: 'select', currentValue: 'plan', choices: [{ value: 'plan', label: 'Plan' }] },
]

it('retains a rejected saved pick with its original value while accepted defaults still send', async () => {
  const store = new AppStore('ws://localhost:0/')
  let options = declared
  const writes: Record<string, unknown>[] = []
  const request = vi.spyOn(store.transport, 'request').mockImplementation((async (method: HostMethodName, params: Record<string, unknown>) => {
    if (method === 'runtime/sessionDefaults') return options
    if (method === 'app/state/set') { writes.push(params); return {} }
    if (method === 'session/create') return { runtime, id: sessionId('new'), cwd: '/workspace', status: { type: 'idle' }, turns: [], createdAt: 0, updatedAt: 0 }
    return null
  }) as never)
  await store.setNewSessionDefault(runtime, 'model', 'old')
  await store.setNewSessionDefault(runtime, 'mode', 'plan')
  options = [{ ...declared[0]!, currentValue: 'current', choices: [{ value: 'current', label: 'Current model' }] } as ConfigOption, declared[1]!]
  await store.newSessionDefaultsFor(runtime)
  expect(store.getSnapshot().staleDraftDefaults?.[runtime]).toMatchObject([{ id: 'model', value: 'old', valueLabel: 'Old model', category: 'model' }])
  await store.newSession({ runtime, cwd: '/workspace' })
  const create = request.mock.calls.find(([method]) => method === 'session/create')
  expect(create?.[1]).toMatchObject({ options: { options: { mode: 'plan' } } })
  expect(writes.at(-1)).toMatchObject({ patch: { staleDraftDefaults: { [runtime]: [{ id: 'model', value: 'old' }] } } })
})

it('persists rejected picks across reload and clears both the warning and preference in one action', async () => {
  let preferences: Record<string, unknown> = {}
  let options = declared
  const setup = () => {
    const store = new AppStore('ws://localhost:0/')
    const request = vi.spyOn(store.transport, 'request').mockImplementation((async (method: HostMethodName, params: Record<string, unknown>) => {
      if (method === 'runtime/sessionDefaults') return options
      if (method === 'app/state/get') return preferences
      if (method === 'app/state/set') { preferences = { ...preferences, ...(params.patch as Record<string, unknown>) }; return {} }
      return null
    }) as never)
    return { store, request }
  }
  const first = setup()
  await first.store.setNewSessionDefault(runtime, 'model', 'old')
  await first.store.setNewSessionDefault(runtime, 'mode', 'plan')
  options = [declared[1]!]
  await first.store.newSessionDefaultsFor(runtime)
  expect(first.store.getSnapshot().staleDraftDefaults[runtime]).toMatchObject([{ id: 'model', value: 'old', reason: 'This setting is no longer offered.' }])
  const reloaded = setup()
  await reloaded.store.loadPreferences()
  await reloaded.store.newSessionDefaultsFor(runtime)
  expect(reloaded.store.getSnapshot().staleDraftDefaults[runtime]).toEqual(first.store.getSnapshot().staleDraftDefaults[runtime])
  expect(reloaded.request.mock.calls.filter(([method]) => method === 'runtime/sessionDefaults').map(([, params]) => params)).toEqual([{ runtime }, { runtime, values: { mode: 'plan' } }])
  await reloaded.store.clearNewSessionDefault(runtime, 'model')
  expect(reloaded.store.getSnapshot().staleDraftDefaults[runtime]).toEqual([])
  expect(preferences).toMatchObject({ draftValues: { [runtime]: { mode: 'plan' } }, staleDraftDefaults: { [runtime]: [] } })
  const afterClear = setup()
  await afterClear.store.loadPreferences()
  expect(afterClear.store.getSnapshot().staleDraftDefaults[runtime]).toEqual([])
})

it('retains a refused setter value and does not send it in the next defaults request', async () => {
  const store = new AppStore('ws://localhost:0/')
  const request = vi.spyOn(store.transport, 'request').mockImplementation((async (method: HostMethodName, params: { values?: Record<string, unknown> }) => {
    if (method !== 'runtime/sessionDefaults') return {}
    if (params.values?.model === 'rejected') throw new Error('The agent refused this model.')
    return declared
  }) as never)
  await store.setNewSessionDefault(runtime, 'model', 'rejected')
  expect(store.getSnapshot().staleDraftDefaults[runtime]).toMatchObject([{ id: 'model', value: 'rejected' }])
  await store.newSessionDefaultsFor(runtime)
  const last = request.mock.calls.filter(([method]) => method === 'runtime/sessionDefaults').at(-1)
  expect(last?.[1]).toEqual({ runtime })
})

it('flags an offered pick when the agent answers with another value', async () => {
  const store = new AppStore('ws://localhost:0/')
  vi.spyOn(store.transport, 'request').mockImplementation((async (method: HostMethodName) => method === 'runtime/sessionDefaults' ? declared : {}) as never)
  await store.setNewSessionDefault(runtime, 'model', 'current')
  expect(store.getSnapshot().staleDraftDefaults[runtime]).toMatchObject([{ id: 'model', value: 'current', reason: 'The agent returned a different value.' }])
})

it('treats a known list replaced by no controls as stale, while first discovery stays unknown', async () => {
  const store = new AppStore('ws://localhost:0/')
  let options: readonly ConfigOption[] = declared
  const request = vi.spyOn(store.transport, 'request').mockImplementation((async (method: HostMethodName) => method === 'runtime/sessionDefaults' ? options : {}) as never)
  await store.setNewSessionDefault(runtime, 'model', 'old')
  options = []
  await store.newSessionDefaultsFor(runtime)
  expect(store.getSnapshot().staleDraftDefaults[runtime]).toMatchObject([{ id: 'model', value: 'old' }])
  await store.newSessionDefaultsFor(runtime)
  expect(request.mock.calls.filter(([method]) => method === 'runtime/sessionDefaults').at(-1)?.[1]).toEqual({ runtime })
})

it('does not restore a cleared pick when an older defaults refresh answers later', async () => {
  const store = new AppStore('ws://localhost:0/')
  let release!: (value: readonly ConfigOption[]) => void
  let read = 0
  vi.spyOn(store.transport, 'request').mockImplementation((async (method: HostMethodName) => {
    if (method !== 'runtime/sessionDefaults') return {}
    if (++read === 2) return new Promise((resolve) => { release = resolve })
    return declared
  }) as never)
  await store.setNewSessionDefault(runtime, 'model', 'old')
  const pending = store.newSessionDefaultsFor(runtime)
  await store.clearNewSessionDefault(runtime, 'model')
  release([declared[1]!])
  await pending
  expect(store.getSnapshot().staleDraftDefaults[runtime]).toEqual([])
})

it('orders preference writes so an older pending save cannot overwrite clearing', async () => {
  const store = new AppStore('ws://localhost:0/')
  let preferences: Record<string, unknown> = {}
  let release!: () => void
  let writes = 0
  vi.spyOn(store.transport, 'request').mockImplementation((async (method: HostMethodName, params: { patch?: Record<string, unknown> }) => {
    if (method === 'runtime/sessionDefaults') return declared
    if (method === 'app/state/set') {
      if (++writes === 1) await new Promise<void>((resolve) => { release = resolve })
      preferences = { ...preferences, ...params.patch }
    }
    return {}
  }) as never)
  const picked = store.setNewSessionDefault(runtime, 'model', 'current')
  await vi.waitFor(() => expect(release).toBeTypeOf('function'))
  const cleared = store.clearNewSessionDefault(runtime, 'model')
  release()
  await Promise.all([picked, cleared])
  await Promise.resolve()
  expect(preferences).toMatchObject({ staleDraftDefaults: { [runtime]: [] } })
})

it('remembers the affected slot and original label when a saved option disappears after reload', async () => {
  let preferences: Record<string, unknown> = {}
  let options: readonly ConfigOption[] = declared
  const setup = () => {
    const store = new AppStore('ws://localhost:0/')
    vi.spyOn(store.transport, 'request').mockImplementation((async (method: HostMethodName, params: { patch?: Record<string, unknown> }) => {
      if (method === 'runtime/sessionDefaults') return options
      if (method === 'app/state/get') return preferences
      if (method === 'app/state/set') preferences = { ...preferences, ...params.patch }
      return {}
    }) as never)
    return store
  }
  await setup().setNewSessionDefault(runtime, 'model', 'old')
  options = [declared[1]!]
  const reloaded = setup()
  await reloaded.loadPreferences()
  await reloaded.newSessionDefaultsFor(runtime)
  expect(reloaded.getSnapshot().staleDraftDefaults[runtime]).toMatchObject([{ id: 'model', label: 'Model', category: 'model', value: 'old', valueLabel: 'Old model' }])
})

it('flags saved picks from a live whole-list replacement without changing the current selection', async () => {
  const store = new AppStore('ws://localhost:0/')
  let options = declared
  const id = sessionId('live')
  const session = { runtime, id, cwd: '/workspace', status: { type: 'idle' }, turns: [], createdAt: 0, updatedAt: 0, options }
  const request = vi.spyOn(store.transport, 'request').mockImplementation((async (method: HostMethodName) => {
    if (method === 'runtime/sessionDefaults') return options
    if (method === 'session/read' || method === 'session/resume') return session
    return {}
  }) as never)
  await store.setNewSessionDefault(runtime, 'model', 'old')
  await store.openSession(id, { runtime })
  options = [{ ...declared[0]!, currentValue: 'old', choices: [{ value: 'current', label: 'Current model' }] } as ConfigOption, declared[1]!]
  const transport = store.transport as unknown as { handlers: TransportEvents }
  transport.handlers.onEvent(runtime, { type: 'session/options', sessionId: id, options })
  await vi.waitFor(() => expect(store.getSnapshot().staleDraftDefaults[runtime]).toMatchObject([{ id: 'model', value: 'old' }]))
  expect(request.mock.calls.some(([method]) => method === 'session/options/set')).toBe(false)
})

it('does not submit a saved value that the refreshed declarations no longer offer', async () => {
  const store = new AppStore('ws://localhost:0/')
  let options = declared
  const request = vi.spyOn(store.transport, 'request').mockImplementation((async (method: HostMethodName) => method === 'runtime/sessionDefaults' ? options : {}) as never)
  await store.setNewSessionDefault(runtime, 'model', 'old')
  request.mockClear()
  options = [declared[1]!]
  await store.newSessionDefaultsFor(runtime)
  expect(request.mock.calls.filter(([method]) => method === 'runtime/sessionDefaults').map(([, params]) => params)).toEqual([{ runtime }])
})

it('keeps an option-only live update local when no saved picks need validation', async () => {
  const store = new AppStore('ws://localhost:0/')
  const id = sessionId('live-no-defaults')
  const session = { runtime, id, cwd: '/workspace', status: { type: 'idle' }, turns: [], createdAt: 0, updatedAt: 0, options: declared }
  const request = vi.spyOn(store.transport, 'request').mockImplementation((async (method: HostMethodName) =>
    method === 'session/read' || method === 'session/resume' ? session : []) as never)
  await store.openSession(id, { runtime })
  request.mockClear()
  ;(store.transport as unknown as { handlers: TransportEvents }).handlers.onEvent(runtime, { type: 'session/options', sessionId: id, options: [declared[1]!] })
  expect(request.mock.calls).toEqual([])
})

it('validates saved picks again at session creation before sending any start options', async () => {
  const store = new AppStore('ws://localhost:0/')
  let options = declared
  const request = vi.spyOn(store.transport, 'request').mockImplementation((async (method: HostMethodName) => {
    if (method === 'runtime/sessionDefaults') return options
    if (method === 'session/create') return { runtime, id: sessionId('fresh'), cwd: '/workspace', status: { type: 'idle' }, turns: [], createdAt: 0, updatedAt: 0 }
    return []
  }) as never)
  await store.setNewSessionDefault(runtime, 'model', 'old')
  options = [declared[1]!]
  await store.newSession({ runtime, cwd: '/workspace' })
  const create = request.mock.calls.find(([method]) => method === 'session/create')
  expect(create?.[1]).toEqual({ runtime, options: { cwd: '/workspace' } })
  expect(request.mock.calls.filter(([method]) => method === 'runtime/sessionDefaults').at(-1)?.[1]).toEqual({ runtime, cwd: '/workspace' })
  expect(store.getSnapshot().staleDraftDefaults[runtime]).toMatchObject([{ id: 'model', value: 'old' }])
})
