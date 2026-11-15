import { hash } from 'fast-sha256'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { canonicalTranscriptBody, runtimeId, sessionId, sessionKey, type Session } from '@harnessdesk/protocol'
import type { TransportEvents } from '../lib/transport'
import { AppStore } from './store'

beforeEach(() => vi.stubGlobal('sessionStorage', undefined))
afterEach(() => vi.unstubAllGlobals())

it('starts an eviction after 129 valid proofs without waiting for a later stalled proof', async () => {
  const runtime = runtimeId('example')
  const watermark = { epoch: 'epoch', generation: 'generation', revision: 1, sequence: 1 }
  const id = (i: number) => sessionId(`pressure-${String(i).padStart(3, '0')}`)
  const body = (id: ReturnType<typeof sessionId>): Session => ({ id, runtime, cwd: '/example', status: { type: 'idle' }, createdAt: 0, updatedAt: 0, itemsLoaded: true, turns: [] })
  const identity = Array.from(hash(new TextEncoder().encode(canonicalTranscriptBody([]).canonical)), byte => byte.toString(16).padStart(2, '0')).join('')
  let releaseLate!: () => void, markLate!: () => void, markEarly!: () => void
  const gate = new Promise<void>(resolve => { releaseLate = resolve })
  const late = new Promise<'late'>(resolve => { markLate = () => resolve('late') })
  const early = new Promise<'early'>(resolve => { markEarly = () => resolve('early') })
  const snapshots = new Map<string, number>(), proofs = new Set<string>()
  const store = new AppStore('ws://localhost:0/')
  vi.spyOn(store.transport, 'request').mockImplementation((async (method: string, params: { sessionId: ReturnType<typeof sessionId> }) => {
    if (method === 'session/cache-snapshot') {
      const count = (snapshots.get(params.sessionId) ?? 0) + 1
      snapshots.set(params.sessionId, count)
      if (params.sessionId === id(0) && count === 2) markEarly()
      if (params.sessionId === id(129)) { markLate(); await gate }
      return { session: body(params.sessionId), watermark, identity }
    }
    if (method === 'session/prepare-eviction') { proofs.add(params.sessionId); return { ...watermark, identity } }
    return null
  }) as never)
  const handlers = (store.transport as unknown as { handlers: TransportEvents }).handlers
  for (let i = 0; i < 130; i++) handlers.onEvent(runtime, { type: 'session/started', session: body(id(i)) })
  try {
    store.enableTranscriptCache()
    const first = await Promise.race([late, early])
    if (first === 'late') {
      expect(proofs.size).toBe(129)
      expect(store.getSnapshot().sessions.get(sessionKey(runtime, id(0)))?.itemsLoaded).toBe(true)
      expect(store.transcriptCacheStats()).toMatchObject({ loadedFullBodies: 130, releasedBodies: 0, pressureRunning: true })
    }
    expect(first).toBe('early')
  } finally {
    releaseLate()
    await store.disableTranscriptCache()
  }
})

it('continues automatic eviction once the later proof resolves', async () => {
  const runtime = runtimeId('example')
  const watermark = { epoch: 'epoch', generation: 'generation', revision: 1, sequence: 1 }
  const id = (i: number) => sessionId(`control-${String(i).padStart(3, '0')}`)
  const body = (id: ReturnType<typeof sessionId>): Session => ({ id, runtime, cwd: '/example', status: { type: 'idle' }, createdAt: 0, updatedAt: 0, itemsLoaded: true, turns: [] })
  const identity = Array.from(hash(new TextEncoder().encode(canonicalTranscriptBody([]).canonical)), byte => byte.toString(16).padStart(2, '0')).join('')
  let releaseLate!: () => void, markLate!: () => void
  const gate = new Promise<void>(resolve => { releaseLate = resolve })
  const late = new Promise<void>(resolve => { markLate = resolve })
  const proofs = new Set<string>()
  const store = new AppStore('ws://localhost:0/')
  vi.spyOn(store.transport, 'request').mockImplementation((async (method: string, params: { sessionId: ReturnType<typeof sessionId> }) => {
    if (method === 'session/cache-snapshot') {
      if (params.sessionId === id(128)) { markLate(); await gate }
      return { session: body(params.sessionId), watermark, identity }
    }
    if (method === 'session/prepare-eviction') { proofs.add(params.sessionId); return { ...watermark, identity } }
    return null
  }) as never)
  const handlers = (store.transport as unknown as { handlers: TransportEvents }).handlers
  for (let i = 0; i < 130; i++) handlers.onEvent(runtime, { type: 'session/started', session: body(id(i)) })
  try {
    store.enableTranscriptCache()
    await late
    expect(proofs.size).toBe(128)
    expect(store.transcriptCacheStats()).toMatchObject({ loadedFullBodies: 130, releasedBodies: 0, pressureRunning: true })
    const released = new Promise<void>(resolve => {
      const off = store.subscribe(() => { if (store.transcriptCacheStats().releasedBodies > 0) { off(); resolve() } })
    })
    releaseLate()
    await released
    expect(store.getSnapshot().sessions.get(sessionKey(runtime, id(0)))?.itemsLoaded).toBe(false)
  } finally {
    releaseLate()
    await store.disableTranscriptCache()
  }
})

it('converges after a later proof resolves following an early eviction', async () => {
  const runtime = runtimeId('example')
  const watermark = { epoch: 'epoch', generation: 'generation', revision: 1, sequence: 1 }
  const id = (i: number) => sessionId(`control-${String(i).padStart(3, '0')}`)
  const body = (id: ReturnType<typeof sessionId>): Session => ({ id, runtime, cwd: '/example', status: { type: 'idle' }, createdAt: 0, updatedAt: 0, itemsLoaded: true, turns: [] })
  const identity = Array.from(hash(new TextEncoder().encode(canonicalTranscriptBody([]).canonical)), byte => byte.toString(16).padStart(2, '0')).join('')
  let releaseLate!: () => void, markLate!: () => void
  const gate = new Promise<void>(resolve => { releaseLate = resolve })
  const late = new Promise<void>(resolve => { markLate = resolve })
  const proofs = new Set<string>()
  const store = new AppStore('ws://localhost:0/')
  vi.spyOn(store.transport, 'request').mockImplementation((async (method: string, params: { sessionId: ReturnType<typeof sessionId> }) => {
    if (method === 'session/cache-snapshot') {
      if (params.sessionId === id(129)) { markLate(); await gate }
      return { session: body(params.sessionId), watermark, identity }
    }
    if (method === 'session/prepare-eviction') { proofs.add(params.sessionId); return { ...watermark, identity } }
    return null
  }) as never)
  const handlers = (store.transport as unknown as { handlers: TransportEvents }).handlers
  for (let i = 0; i < 130; i++) handlers.onEvent(runtime, { type: 'session/started', session: body(id(i)) })
  try {
    store.enableTranscriptCache()
    await late
    expect(proofs.size).toBe(129)
    expect(store.transcriptCacheStats()).toMatchObject({ loadedFullBodies: 129, releasedBodies: 1, pressureRunning: true })
    const released = new Promise<void>(resolve => {
      const off = store.subscribe(() => { if (store.transcriptCacheStats().releasedBodies === 2) { off(); resolve() } })
    })
    releaseLate()
    await released
    expect(store.transcriptCacheStats()).toMatchObject({ loadedFullBodies: 128, releasedBodies: 2 })
  } finally {
    releaseLate()
    await store.disableTranscriptCache()
  }
})

it('keeps the oldest body loaded until its fresh unload proof completes', async () => {
  const runtime = runtimeId('example')
  const watermark = { epoch: 'epoch', generation: 'generation', revision: 1, sequence: 1 }
  const id = (i: number) => sessionId(`fresh-${String(i).padStart(3, '0')}`)
  const body = (id: ReturnType<typeof sessionId>): Session => ({ id, runtime, cwd: '/example', status: { type: 'idle' }, createdAt: 0, updatedAt: 0, itemsLoaded: true, turns: [] })
  const identity = Array.from(hash(new TextEncoder().encode(canonicalTranscriptBody([]).canonical)), byte => byte.toString(16).padStart(2, '0')).join('')
  let releaseFresh!: () => void, markFresh!: () => void
  const gate = new Promise<void>(resolve => { releaseFresh = resolve })
  const fresh = new Promise<void>(resolve => { markFresh = resolve })
  const snapshots = new Map<string, number>()
  const store = new AppStore('ws://localhost:0/')
  vi.spyOn(store.transport, 'request').mockImplementation((async (method: string, params: { sessionId: ReturnType<typeof sessionId> }) => {
    if (method === 'session/cache-snapshot') {
      const count = (snapshots.get(params.sessionId) ?? 0) + 1
      snapshots.set(params.sessionId, count)
      if (params.sessionId === id(0) && count === 2) { markFresh(); await gate }
      return { session: body(params.sessionId), watermark, identity }
    }
    if (method === 'session/prepare-eviction') return { ...watermark, identity }
    return null
  }) as never)
  const handlers = (store.transport as unknown as { handlers: TransportEvents }).handlers
  for (let i = 0; i < 129; i++) handlers.onEvent(runtime, { type: 'session/started', session: body(id(i)) })
  try {
    store.enableTranscriptCache()
    await fresh
    expect(store.getSnapshot().sessions.get(sessionKey(runtime, id(0)))?.itemsLoaded).toBe(true)
    expect(store.transcriptCacheStats()).toMatchObject({ loadedFullBodies: 129, releasedBodies: 0, pressureRunning: true })
    const released = new Promise<void>(resolve => {
      const off = store.subscribe(() => { if (store.transcriptCacheStats().releasedBodies > 0) { off(); resolve() } })
    })
    releaseFresh()
    await released
    expect(store.getSnapshot().sessions.get(sessionKey(runtime, id(0)))?.itemsLoaded).toBe(false)
  } finally {
    releaseFresh()
    await store.disableTranscriptCache()
  }
})

it.each(['count', 'bytes'] as const)('uses cached %s pressure proofs before requesting a later body', async kind => {
  const runtime = runtimeId('example')
  const watermark = { epoch: 'epoch', generation: 'generation', revision: 1, sequence: 1 }
  const id = (i: number) => sessionId(`cached-${i}`)
  const body = (id: ReturnType<typeof sessionId>): Session => ({ id, runtime, cwd: '/example', status: { type: 'idle' }, createdAt: 0, updatedAt: 0, itemsLoaded: true, turns: [] })
  const canonical = canonicalTranscriptBody([])
  const identity = Array.from(hash(new TextEncoder().encode(canonical.canonical)), byte => byte.toString(16).padStart(2, '0')).join('')
  let releaseLate!: () => void, markLate!: () => void
  const gate = new Promise<void>(resolve => { releaseLate = resolve })
  const late = new Promise<'late'>(resolve => { markLate = () => resolve('late') })
  const store = new AppStore('ws://localhost:0/')
  await store.disableTranscriptCache()
  const request = vi.spyOn(store.transport, 'request').mockImplementation((async (method: string, params: { sessionId: ReturnType<typeof sessionId> }) => {
    if (method === 'session/cache-snapshot') {
      if (params.sessionId === id(2)) { markLate(); await gate }
      return { session: body(params.sessionId), watermark, identity }
    }
    if (method === 'session/prepare-eviction') return { ...watermark, identity }
    return null
  }) as never)
  const handlers = (store.transport as unknown as { handlers: TransportEvents }).handlers
  for (let i = 0; i < 3; i++) handlers.onEvent(runtime, { type: 'session/started', session: body(id(i)) })
  const limits = kind === 'count' ? { count: 1, bytes: Number.MAX_SAFE_INTEGER } : { count: 99, bytes: canonical.bytes }
  try {
    const first = store.prepareTranscriptPressure(limits)
    expect(await Promise.race([first.then(() => 'planned' as const), late])).toBe('planned')
    expect(await first).toEqual([sessionKey(runtime, id(0))])
    const calls = request.mock.calls.length
    expect(await store.prepareTranscriptPressure(limits)).toEqual([sessionKey(runtime, id(0))])
    expect(request.mock.calls).toHaveLength(calls)
  } finally {
    releaseLate()
  }
})

it('rechecks an earlier in-place body change after a later proof awaits', async () => {
  const runtime = runtimeId('example'), first = sessionId('earlier'), second = sessionId('later')
  const watermark = { epoch: 'epoch', generation: 'generation', revision: 1, sequence: 1 }
  const body = (id: typeof first): Session => ({ id, runtime, cwd: '/example', status: { type: 'idle' }, createdAt: 0, updatedAt: 0, itemsLoaded: true, turns: [] })
  const identity = Array.from(hash(new TextEncoder().encode(canonicalTranscriptBody([]).canonical)), byte => byte.toString(16).padStart(2, '0')).join('')
  let release!: () => void, mark!: () => void
  const gate = new Promise<void>(resolve => { release = resolve }), reached = new Promise<void>(resolve => { mark = resolve })
  const store = new AppStore('ws://localhost:0/'); await store.disableTranscriptCache()
  vi.spyOn(store.transport, 'request').mockImplementation((async (method: string, params: { sessionId: typeof first }) => {
    if (method === 'session/cache-snapshot') { if (params.sessionId === second) { mark(); await gate }; return { session: body(params.sessionId), watermark, identity } }
    if (method === 'session/prepare-eviction') return { ...watermark, identity }
    return null
  }) as never)
  const handlers = (store.transport as unknown as { handlers: TransportEvents }).handlers
  for (const id of [first, second]) handlers.onEvent(runtime, { type: 'session/started', session: body(id) })
  expect(await store.prepareTranscriptEviction(runtime, first)).toBe(true)
  try {
    const planning = store.prepareTranscriptPressure({ count: 1, bytes: Number.MAX_SAFE_INTEGER })
    await reached
    const held = store.getSnapshot().sessions.get(sessionKey(runtime, first))!
    ;(held as { title?: string }).title = 'Synthetic mutation during later proof'
    release()
    expect(await planning).toEqual([])
    expect(store.getSnapshot().sessions.get(sessionKey(runtime, first))?.itemsLoaded).toBe(true)
  } finally { release() }
})
