import { hash } from 'fast-sha256'
import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import { canonicalTranscriptBody, itemId, runtimeId, sessionId, sessionKey, turnId, type Session } from '@harnessdesk/protocol'
import type { TransportEvents } from '../lib/transport'
import { AppStore } from './store'

beforeEach(() => vi.stubGlobal('sessionStorage', undefined))
afterEach(() => vi.unstubAllGlobals())

const runtime = runtimeId('example'), id = sessionId('one'), key = sessionKey(runtime, id)
const body: Session = { id, runtime, cwd: '/example', status: { type: 'idle' }, createdAt: 0, updatedAt: 0, itemsLoaded: true,
  turns: [{ id: turnId('turn'), status: 'completed', items: [{ id: itemId('item'), type: 'assistantMessage', text: 'Synthetic saved output' }] }] }
const identity = Array.from(hash(new TextEncoder().encode(canonicalTranscriptBody(body.turns).canonical)), byte => byte.toString(16).padStart(2, '0')).join('')
const first = { epoch: 'epoch', generation: 'generation', revision: 1, sequence: 1 }
const newer = { ...first, revision: 3, sequence: 3 }

it('re-proves a loaded unchanged body after valid read invalidations', async () => {
  const store = new AppStore('ws://localhost:0/')
  await store.disableTranscriptCache()
  let watermark = first
  const request = vi.spyOn(store.transport, 'request').mockImplementation((async (method: string) => method === 'session/cache-snapshot' ? { session: body, watermark, identity } : method === 'session/prepare-eviction' ? { ...watermark, identity } : null) as never)
  const handlers = (store.transport as unknown as { handlers: TransportEvents }).handlers
  handlers.onEvent(runtime, { type: 'session/started', session: body })
  expect(await store.prepareTranscriptEviction(runtime, id)).toBe(true)
  handlers.onNotification({ method: 'session/cache-invalidated', params: { runtime, sessionId: id, watermark: { ...first, sequence: 2, revision: 2 } } })
  handlers.onNotification({ method: 'session/cache-invalidated', params: { runtime, sessionId: id, watermark: newer } })
  watermark = newer
  expect(await store.prepareTranscriptEviction(runtime, id)).toBe(true)
  expect(store.getSnapshot().sessions.get(key)).toEqual(body)
  expect(request.mock.calls.filter(([method]) => method === 'session/prepare-eviction')).toHaveLength(2)
})

it.each(['partial', 'different-body', 'different-metadata', 'old-watermark', 'other-generation', 'unknown-event', 'pending-gap', 'cross-owner', 'later-invalidation'] as const)(
  '%s cannot clear blocked loaded-body authority', async failure => {
    const store = new AppStore('ws://localhost:0/')
    await store.disableTranscriptCache()
    let finish!: (value: unknown) => void, calls = 0
    const held = new Promise(resolve => { finish = resolve })
    const request = vi.spyOn(store.transport, 'request').mockImplementation((async (method: string) => {
      if (method === 'session/cache-snapshot') return ++calls === 1 ? { session: body, watermark: first, identity } : held
      if (method === 'session/prepare-eviction') return { ...first, identity }
      return null
    }) as never)
    const handlers = (store.transport as unknown as { handlers: TransportEvents }).handlers
    handlers.onEvent(runtime, { type: 'session/started', session: body })
    expect(await store.prepareTranscriptEviction(runtime, id)).toBe(true)
    handlers.onNotification({ method: 'session/cache-invalidated', params: { runtime, sessionId: id, watermark: newer } })
    if (failure === 'unknown-event') handlers.onEvent(runtime, { type: 'session/title', sessionId: id, title: 'Synthetic' })
    if (failure === 'pending-gap') handlers.onEvent(runtime, { type: 'item/delta', sessionId: id, turnId: turnId('turn'), itemId: itemId('item'), delta: { kind: 'assistantText', text: ' synthetic new' } }, { ...newer, sequence: 5, revision: 5 })
    const task = store.prepareTranscriptEviction(runtime, id)
    if (failure !== 'unknown-event' && failure !== 'pending-gap') {
      await vi.waitFor(() => expect(request.mock.calls.filter(([method]) => method === 'session/cache-snapshot')).toHaveLength(2))
      if (failure === 'cross-owner') { const release = store.retainTranscript(runtime, id); release() }
      if (failure === 'later-invalidation') handlers.onNotification({ method: 'session/cache-invalidated', params: { runtime, sessionId: id, watermark: { ...newer, sequence: 4, revision: 4 } } })
    }
    const snapshotBody = failure === 'partial' ? { ...body, partialHistory: true } : failure === 'different-body' ? { ...body, turns: [] } : failure === 'different-metadata' ? { ...body, title: 'Different' } : body
    const watermark = failure === 'old-watermark' ? first : failure === 'other-generation' ? { ...newer, generation: 'other' } : newer
    finish({ session: snapshotBody, watermark, identity })
    expect(await task).toBe(false)
    expect(store.transcriptCacheVerified(runtime, id)).toBe(false)
    expect(store.getSnapshot().sessions.get(key)?.itemsLoaded).toBe(true)
  },
)

it('never re-proves over an existing unresolved gap capture', async () => {
  const store = new AppStore('ws://localhost:0/')
  await store.disableTranscriptCache()
  const request = vi.spyOn(store.transport, 'request').mockImplementation((async (method: string) => method === 'session/cache-snapshot' ? { session: body, watermark: first, identity } : method === 'session/prepare-eviction' ? { ...first, identity } : null) as never)
  const handlers = (store.transport as unknown as { handlers: TransportEvents }).handlers
  handlers.onEvent(runtime, { type: 'session/started', session: body })
  expect(await store.prepareTranscriptEviction(runtime, id)).toBe(true)
  handlers.onEvent(runtime, { type: 'item/delta', sessionId: id, turnId: turnId('turn'), itemId: itemId('item'), delta: { kind: 'assistantText', text: ' synthetic gap' } }, { ...first, sequence: 3, revision: 3 })
  expect(store.transcriptCacheStats().trackedRecoveryRecords).toBeGreaterThan(0)
  handlers.onNotification({ method: 'session/cache-invalidated', params: { runtime, sessionId: id, watermark: { ...first, sequence: 4, revision: 4 } } })
  expect(await store.prepareTranscriptEviction(runtime, id)).toBe(false)
  expect(request.mock.calls.filter(([method]) => method === 'session/cache-snapshot')).toHaveLength(1)
  expect(store.transcriptCacheStats().trackedRecoveryRecords).toBeGreaterThan(0)
})

it('re-proves after a real Transport-backed public summary read', async () => {
  class MockWebSocket {
    static OPEN = 1
    static instance: MockWebSocket
    readyState = 0
    listeners = new Map<string, (event: any) => void>()
    sent: { id: number; method: string }[] = []
    constructor(_url: string) { MockWebSocket.instance = this }
    addEventListener(type: string, callback: (event: any) => void) { this.listeners.set(type, callback) }
    send(frame: string) { this.sent.push(JSON.parse(frame)) }
    close() { this.readyState = 3 }
    open() { this.readyState = 1; this.listeners.get('open')?.({}) }
    message(value: unknown) { this.listeners.get('message')?.({ data: JSON.stringify(value) }) }
  }
  vi.stubGlobal('WebSocket', MockWebSocket)
  const store = new AppStore('ws://example.test/')
  await store.disableTranscriptCache()
  store.transport.connect(); const socket = MockWebSocket.instance; socket.open()
  socket.message({ method: 'event', params: { runtime, event: { type: 'session/started', session: body } } })
  const initial = store.prepareTranscriptEviction(runtime, id)
  let snapshot = socket.sent.filter(frame => frame.method === 'session/cache-snapshot').at(-1)!
  socket.message({ id: snapshot.id, ok: true, result: { session: body, watermark: first, identity } })
  await vi.waitFor(() => expect(socket.sent.some(frame => frame.method === 'session/prepare-eviction')).toBe(true))
  let receipt = socket.sent.filter(frame => frame.method === 'session/prepare-eviction').at(-1)!
  socket.message({ id: receipt.id, ok: true, result: { ...first, identity } })
  expect(await initial).toBe(true)
  const summary = store.summariseSession(id, runtime)
  const read = socket.sent.filter(frame => frame.method === 'session/read').at(-1)!
  expect(read).toBeDefined()
  socket.message({ method: 'session/cache-invalidated', params: { runtime, sessionId: id, watermark: { ...first, revision: 2, sequence: 2 } } })
  socket.message({ method: 'session/cache-invalidated', params: { runtime, sessionId: id, watermark: newer } })
  socket.message({ id: read.id, ok: true, result: body })
  expect(await summary).toContain('Synthetic saved output')
  const again = store.prepareTranscriptEviction(runtime, id)
  expect(socket.sent.filter(frame => frame.method === 'session/cache-snapshot')).toHaveLength(2)
  snapshot = socket.sent.filter(frame => frame.method === 'session/cache-snapshot').at(-1)!
  expect(snapshot.id).not.toBe(read.id)
  socket.message({ id: snapshot.id, ok: true, result: { session: body, watermark: newer, identity } })
  await vi.waitFor(() => expect(socket.sent.filter(frame => frame.method === 'session/prepare-eviction')).toHaveLength(2))
  receipt = socket.sent.filter(frame => frame.method === 'session/prepare-eviction').at(-1)!
  socket.message({ id: receipt.id, ok: true, result: { ...newer, identity } })
  expect(await again).toBe(true)
  store.transport.close()
})

it('automatically re-proves an invalidated loaded body under real pressure', async () => {
  const store = new AppStore('ws://localhost:0/')
  await store.disableTranscriptCache()
  const bodies = new Map(Array.from({ length: 132 }, (_, i) => { const sid = sessionId(`pressure-${i}`); return [sid, { ...body, id: sid }] as const }))
  let targetWatermark = first
  vi.spyOn(store.transport, 'request').mockImplementation((async (method: string, params: { sessionId: typeof id }) => {
    const watermark = params.sessionId === id ? targetWatermark : first
    if (method === 'session/cache-snapshot') return { session: params.sessionId === id ? body : bodies.get(params.sessionId), watermark, identity }
    if (method === 'session/prepare-eviction') return { ...watermark, identity }
    return null
  }) as never)
  const handlers = (store.transport as unknown as { handlers: TransportEvents }).handlers
  handlers.onEvent(runtime, { type: 'session/started', session: body })
  for (const entry of bodies.values()) handlers.onEvent(runtime, { type: 'session/started', session: entry })
  expect(await store.prepareTranscriptEviction(runtime, id)).toBe(true)
  handlers.onNotification({ method: 'session/cache-invalidated', params: { runtime, sessionId: id, watermark: newer } }); targetWatermark = newer
  store.enableTranscriptCache()
  await vi.waitFor(() => expect(store.transcriptCacheStats()).toMatchObject({ pressureRunning: false, pressureDirty: false }))
  expect(store.transcriptCacheStats().loadedFullBodies).toBe(128)
  expect(store.transcriptCacheStats().releasedBodies).toBe(5)
  await store.disableTranscriptCache()
})

it.each(['in-place-between-invalidations', 'in-place-before-release', 'new-owner', 'draft-aba', 'malformed-invalidation'] as const)(
  '%s cannot advance a held read reproof chain', async failure => {
    const local = structuredClone(body), store = new AppStore('ws://localhost:0/')
    await store.disableTranscriptCache()
    const request = vi.spyOn(store.transport, 'request').mockImplementation((async (method: string) => method === 'session/cache-snapshot' ? { session: local, watermark: first, identity } : method === 'session/prepare-eviction' ? { ...first, identity } : null) as never)
    const handlers = (store.transport as unknown as { handlers: TransportEvents }).handlers
    handlers.onEvent(runtime, { type: 'session/started', session: local })
    expect(await store.prepareTranscriptEviction(runtime, id)).toBe(true)
    const release = store.retainTranscript(runtime, id)
    handlers.onNotification({ method: 'session/cache-invalidated', params: { runtime, sessionId: id, watermark: { ...first, sequence: 2, revision: 2 } } })
    if (failure === 'in-place-between-invalidations') (local as { title?: string }).title = 'Synthetic changed'
    if (failure === 'new-owner') { const later = store.retainTranscript(runtime, id); later() }
    if (failure === 'draft-aba') { store.drafts.setLive(key, { text: 'Synthetic', attachments: [] }); store.drafts.setLive(key, { text: '', attachments: [] }) }
    handlers.onNotification({ method: 'session/cache-invalidated', params: { runtime, sessionId: id, watermark: failure === 'malformed-invalidation' ? { ...newer, generation: 'other' } : newer } })
    if (failure === 'in-place-before-release') (local as { title?: string }).title = 'Synthetic changed'
    release()
    expect(await store.prepareTranscriptEviction(runtime, id)).toBe(false)
    expect(request.mock.calls.filter(([method]) => method === 'session/cache-snapshot')).toHaveLength(1)
    expect(store.getSnapshot().sessions.get(key)?.itemsLoaded).toBe(true)
  },
)

it('holds a non-owning reproof reference and refuses a replaced or removed session', async () => {
  const weakRefs: WeakRef<object>[] = [], NativeWeakRef = WeakRef
  class ObservedWeakRef<T extends object> extends NativeWeakRef<T> {
    constructor(target: T) { super(target); weakRefs.push(this) }
  }
  vi.stubGlobal('WeakRef', ObservedWeakRef)
  const original = structuredClone(body), replacement = { ...structuredClone(body), title: 'Synthetic replacement' }
  const store = new AppStore('ws://localhost:0/')
  await store.disableTranscriptCache()
  const request = vi.spyOn(store.transport, 'request').mockImplementation((async (method: string) => method === 'session/cache-snapshot' ? { session: original, watermark: first, identity } : method === 'session/prepare-eviction' ? { ...first, identity } : null) as never)
  const handlers = (store.transport as unknown as { handlers: TransportEvents }).handlers
  handlers.onEvent(runtime, { type: 'session/started', session: original })
  expect(await store.prepareTranscriptEviction(runtime, id)).toBe(true)
  handlers.onNotification({ method: 'session/cache-invalidated', params: { runtime, sessionId: id, watermark: newer } })
  expect(weakRefs.some(ref => ref.deref() === store.getSnapshot().sessions.get(key))).toBe(true)
  handlers.onEvent(runtime, { type: 'session/started', session: replacement })
  expect(store.getSnapshot().sessions.get(key)).toEqual(replacement)
  expect(await store.prepareTranscriptEviction(runtime, id)).toBe(false)
  handlers.onNotification({ method: 'session/removed', params: { runtime, sessionId: id, deleted: true } })
  expect(store.getSnapshot().sessions.has(key)).toBe(false)
  expect(request.mock.calls.filter(([method]) => method === 'session/cache-snapshot')).toHaveLength(1)
})
