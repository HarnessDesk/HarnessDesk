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

it.each(['missing', 'different choices'] as const)('keeps saved reasoning for the saved model when discovery has %s', async (discovery) => {
  const store = new AppStore('ws://localhost:0/')
  const request = vi.spyOn(store.transport, 'request').mockImplementation((async (method: HostMethodName, params: { values?: Record<string, unknown> }) => {
    if (method === 'runtime/sessionDefaults') {
      const model = params.values?.model ?? 'old'
      const effort: ConfigOption = { id: 'effort', label: 'Reasoning', category: 'thought_level', type: 'select',
        currentValue: params.values?.effort === 'high' && model === 'current' ? 'high' : 'low',
        choices: (model === 'current' ? ['low', 'high'] : ['low']).map((value) => ({ value, label: value })) }
      return [{ ...declared[0]!, currentValue: model }, ...(model === 'current' || discovery === 'different choices' ? [effort] : [])]
    }
    if (method === 'session/create') return { runtime, id: sessionId('reasoning'), cwd: '/workspace', status: { type: 'idle' }, turns: [], createdAt: 0, updatedAt: 0 }
    return {}
  }) as never)
  await store.setNewSessionDefault(runtime, 'model', 'current')
  await store.setNewSessionDefault(runtime, 'effort', 'high')
  request.mockClear()

  await store.newSessionDefaultsFor(runtime)
  expect(store.getSnapshot().staleDraftDefaults[runtime]).toEqual([])
  await store.newSession({ runtime, cwd: '/workspace' })
  expect(request.mock.calls.find(([method]) => method === 'session/create')?.[1])
    .toMatchObject({ options: { options: { model: 'current', effort: 'high' } } })
  expect(request.mock.calls.filter(([method]) => method === 'runtime/sessionDefaults').map(([, params]) => params))
    .toContainEqual({ runtime, values: { model: 'current' } })
})

it('applies the saved model before reasoning even when reasoning was persisted first', async () => {
  const store = new AppStore('ws://localhost:0/')
  const request = vi.spyOn(store.transport, 'request').mockImplementation((async (method: HostMethodName, params: { values?: Record<string, unknown> }) => {
    if (method === 'app/state/get') return { draftValues: { [runtime]: { effort: 'high', model: 'current' } } }
    if (method === 'runtime/sessionDefaults') {
      let model = 'old'
      let effort = 'low'
      // Like an agent applying configuration entries in request order, each
      // reasoning write must be valid for the model already selected.
      for (const [id, value] of Object.entries(params.values ?? {})) {
        if (id === 'model') model = String(value)
        if (id === 'effort') {
          if (model !== 'current' && value === 'high') throw new Error('This model has no high effort.')
          effort = String(value)
        }
      }
      return [{ ...declared[0]!, currentValue: model }, { id: 'effort', label: 'Reasoning', category: 'thought_level', type: 'select',
        currentValue: effort, choices: (model === 'current' ? ['low', 'high'] : ['low']).map((value) => ({ value, label: value })) }]
    }
    if (method === 'session/create') return { runtime, id: sessionId('ordered'), cwd: '/workspace', status: { type: 'idle' }, turns: [], createdAt: 0, updatedAt: 0 }
    return []
  }) as never)
  await store.loadPreferences()
  await store.newSession({ runtime, cwd: '/workspace' })
  expect(store.getSnapshot().staleDraftDefaults[runtime]).toEqual([])
  expect(request.mock.calls.find(([method]) => method === 'session/create')?.[1])
    .toMatchObject({ options: { options: { model: 'current', effort: 'high' } } })
  const created = request.mock.calls.find(([method]) => method === 'session/create')?.[1] as { options: { options: Record<string, unknown> } }
  expect(Object.keys(created.options.options)).toEqual(['model', 'effort'])
})

it('keeps saved reasoning when a saved profile selects the model that supports it', async () => {
  const store = new AppStore('ws://localhost:0/')
  const request = vi.spyOn(store.transport, 'request').mockImplementation((async (method: HostMethodName, params: { values?: Record<string, unknown> }) => {
    if (method === 'runtime/sessionDefaults') {
      const profile = params.values?.profile ?? ''
      return [{ ...declared[0]!, currentValue: profile === 'reasoning' ? 'current' : 'old' },
        { id: 'profile', label: 'Profile', category: '_profile', type: 'select', currentValue: profile,
          choices: [{ value: '', label: 'None' }, { value: 'reasoning', label: 'Reasoning profile' }] },
        { id: 'effort', label: 'Reasoning', category: 'thought_level', type: 'select', currentValue: params.values?.effort ?? 'low',
          choices: (profile === 'reasoning' ? ['low', 'high'] : ['low']).map((value) => ({ value, label: value })) }]
    }
    if (method === 'session/create') return { runtime, id: sessionId('profile'), cwd: '/workspace', status: { type: 'idle' }, turns: [], createdAt: 0, updatedAt: 0 }
    return []
  }) as never)
  await store.setNewSessionDefault(runtime, 'profile', 'reasoning')
  await store.setNewSessionDefault(runtime, 'effort', 'high')
  await store.newSession({ runtime, cwd: '/workspace' })
  expect(store.getSnapshot().staleDraftDefaults[runtime]).toEqual([])
  expect(request.mock.calls.find(([method]) => method === 'session/create')?.[1])
    .toMatchObject({ options: { options: { profile: 'reasoning', effort: 'high' } } })
})

it('revalidates session creation when another refresh supersedes its pending validation', async () => {
  const store = new AppStore('ws://localhost:0/')
  const pending: ((options: readonly ConfigOption[]) => void)[] = []
  let reads = 0
  const request = vi.spyOn(store.transport, 'request').mockImplementation((async (method: HostMethodName) => {
    if (method === 'runtime/sessionDefaults') {
      if (++reads === 1) return declared
      if (reads <= 3) return new Promise<readonly ConfigOption[]>((resolve) => { pending.push(resolve) })
      return [declared[1]!]
    }
    if (method === 'session/create') return { runtime, id: sessionId('racing'), cwd: '/workspace', status: { type: 'idle' }, turns: [], createdAt: 0, updatedAt: 0 }
    return []
  }) as never)
  await store.setNewSessionDefault(runtime, 'model', 'old')
  const creating = store.newSession({ runtime, cwd: '/workspace' })
  await vi.waitFor(() => expect(pending).toHaveLength(1))
  const refresh = store.newSessionDefaultsFor(runtime)
  pending[0]!([declared[1]!])
  await creating
  pending[1]!([declared[1]!])
  await refresh
  expect(request.mock.calls.find(([method]) => method === 'session/create')?.[1])
    .toEqual({ runtime, options: { cwd: '/workspace' } })
  expect(store.getSnapshot().staleDraftDefaults[runtime]).toMatchObject([{ id: 'model', value: 'old' }])
})

it('serializes concurrent creations so their defaults validations do not invalidate one another', async () => {
  const store = new AppStore('ws://localhost:0/')
  let reads = 0
  let creates = 0
  vi.spyOn(store.transport, 'request').mockImplementation((async (method: HostMethodName) => {
    if (method === 'runtime/sessionDefaults') {
      // Bounded equal-latency replies reproduce competing revision retries,
      // then answer immediately so an incorrect implementation can settle.
      if (++reads <= 10) await new Promise((resolve) => setTimeout(resolve, 0))
      return declared
    }
    if (method === 'session/create') return { runtime, id: sessionId(`parallel-${++creates}`), cwd: '/workspace', status: { type: 'idle' }, turns: [], createdAt: 0, updatedAt: 0 }
    return []
  }) as never)
  await store.setNewSessionDefault(runtime, 'model', 'old')
  await Promise.all([store.newSession({ runtime, cwd: '/workspace', reveal: false }), store.newSession({ runtime, cwd: '/workspace', reveal: false })])
  expect(creates).toBe(2)
  expect(reads).toBe(5) // One saved pick, then discovery and application per creation.
})

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
