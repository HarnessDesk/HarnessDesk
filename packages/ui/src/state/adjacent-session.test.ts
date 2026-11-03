import { expect, it, vi } from 'vitest'
import { canonicalTranscriptBody, runtimeId, sessionId, sessionKey, type Session } from '@harnessdesk/protocol'
import { AppStore } from './store'
import { transcriptFingerprint } from './transcript-fingerprint'

const runtime = runtimeId('agent')
const body = (name: string, owner = runtime) => ({ runtime: owner, id: sessionId(name), title: name, cwd: '/project', turns: [], itemsLoaded: true, status: { type: 'idle' }, createdAt: 1, updatedAt: 1 }) as unknown as Session
const deferred = <T,>() => { let resolve!: (value: T) => void; let reject!: (error: Error) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }

it('ignores replaced and closed reads, preserving main subject and never closing a shared session', async () => {
  const store = new AppStore('ws://localhost:0/'), a = deferred<Session>(), b = deferred<Session>()
  const request = vi.spyOn(store.transport, 'request').mockImplementation(((method: string, params: { sessionId: string }) => {
    if (method === 'session/read') return params.sessionId === 'a' ? a.promise : b.promise
    if (method === 'session/resume') return Promise.resolve(body(params.sessionId))
    return Promise.resolve({})
  }) as never)
  const before = store.getSnapshot().activeSessionKey, workspace = store.getSnapshot().workspace
  const first = store.openAdjacentSession(sessionId('a'), runtime)
  const second = store.openAdjacentSession(sessionId('b'), runtime)
  a.resolve(body('a')); await first
  expect(store.getSnapshot().adjacentSession?.key).toBe(sessionKey(runtime, sessionId('b')))
  store.closeAdjacentSession(); b.resolve(body('b')); await second
  expect(store.getSnapshot().adjacentSession).toBeNull()
  expect(store.getSnapshot().sessions.has(sessionKey(runtime, sessionId('b')))).toBe(false)
  expect(store.getSnapshot().activeSessionKey).toBe(before)
  expect(store.getSnapshot().workspace).toBe(workspace)
  expect(request.mock.calls.some(([method]) => method === 'session/close' || method === 'turn/send')).toBe(false)
})

it('keeps a successful read when resume refuses and supports retry', async () => {
  const store = new AppStore('ws://localhost:0/'), id = sessionId('a')
  let fail = true
  vi.spyOn(store.transport, 'request').mockImplementation((async (method: string) => {
    if (method === 'session/resume' && fail) throw new Error('unavailable')
    return body('a')
  }) as never)
  await store.openAdjacentSession(id, runtime)
  expect(store.getSnapshot().sessions.get(sessionKey(runtime, id))?.title).toBe('a')
  expect(store.getSnapshot().adjacentSession?.error).toContain('Could not resume')
  fail = false; await store.openAdjacentSession(id, runtime)
  expect(store.getSnapshot().adjacentSession?.error).toBeNull()
})

it('does not revive a removed conversation after its read completes', async () => {
  const store = new AppStore('ws://localhost:0/'), read = deferred<Session>(), id = sessionId('a')
  vi.spyOn(store.transport, 'request').mockImplementation((() => read.promise) as never)
  const pending = store.openAdjacentSession(id, runtime)
  const handlers = (store.transport as unknown as { handlers: { onNotification(value: unknown): void } }).handlers
  handlers.onNotification({ method: 'session/removed', params: { runtime, sessionId: id, deleted: true } })
  read.resolve(body('a')); await pending
  expect(store.getSnapshot().adjacentSession).toBeNull()
  expect(store.getSnapshot().sessions.has(sessionKey(runtime, id))).toBe(false)
})

it('distinguishes equal IDs across runtimes and ignores an older same-key read', async () => {
  const store = new AppStore('ws://localhost:0/'), first = deferred<Session>(), second = deferred<Session>(), other = runtimeId('other'), id = sessionId('a')
  let count = 0
  vi.spyOn(store.transport, 'request').mockImplementation(((method: string, params: { runtime: typeof runtime }) => {
    if (method === 'session/read') { count++; return count === 1 ? first.promise : count === 2 ? second.promise : Promise.resolve(body('a', params.runtime)) }
    return Promise.resolve(body('a', params.runtime))
  }) as never)
  const older = store.openAdjacentSession(id, runtime), newer = store.openAdjacentSession(id, runtime)
  second.resolve(body('a')); await newer
  first.resolve({ ...body('a'), title: 'stale' }); await older
  expect(store.getSnapshot().sessions.get(sessionKey(runtime, id))?.title).toBe('a')
  const next = store.openAdjacentSession(id, other)
  await next
  expect(store.getSnapshot().adjacentSession?.key).toBe(sessionKey(other, id))
  expect(store.getSnapshot().sessions.has(sessionKey(runtime, id))).toBe(true)
})

it('merges a live event received while the read is pending', async () => {
  const store = new AppStore('ws://localhost:0/'), read = deferred<Session>(), id = sessionId('a')
  const original = { ...body('a'), turns: [{ id: 'turn', status: 'inProgress', items: [{ id: 'item', type: 'assistantMessage', text: 'start' }] }] } as unknown as Session
  vi.spyOn(store.transport, 'request').mockImplementation(((method: string) => method === 'session/read' ? read.promise : Promise.resolve(original)) as never)
  const handlers = (store.transport as unknown as { handlers: { onEvent(runtime: unknown, event: unknown): void } }).handlers
  handlers.onEvent(runtime, { type: 'session/started', session: original })
  const pending = store.openAdjacentSession(id, runtime)
  handlers.onEvent(runtime, { type: 'item/delta', sessionId: id, turnId: 'turn', itemId: 'item', delta: { kind: 'assistantText', text: ' live' } })
  read.resolve(original); await pending
  expect(store.getSnapshot().sessions.get(sessionKey(runtime, id))?.turns[0]?.items[0]).toMatchObject({ text: 'start live' })
})

it('protects a visible body and a closed reader with overlapping reads from eviction', async () => {
  const store = new AppStore('ws://localhost:0/'), id = sessionId('a'), first = deferred<Session>(), second = deferred<Session>()
  const current = body('a'), watermark = { epoch: 'epoch', generation: 'generation', revision: 1, sequence: 1 }
  const identity = transcriptFingerprint(canonicalTranscriptBody(current.turns).canonical)
  let reads = 0
  vi.spyOn(store.transport, 'request').mockImplementation(((method: string) => {
    if (method === 'session/read') return ++reads === 1 ? first.promise : second.promise
    if (method === 'session/cache-snapshot') return Promise.resolve({ session: current, watermark, identity })
    if (method === 'session/prepare-eviction') return Promise.resolve({ ...watermark, identity })
    return Promise.resolve(current)
  }) as never)
  const handlers = (store.transport as unknown as { handlers: { onEvent(runtime: unknown, event: unknown): void } }).handlers
  handlers.onEvent(runtime, { type: 'session/started', session: current })
  const one = store.openAdjacentSession(id, runtime), two = store.openAdjacentSession(id, runtime)
  expect(await store.prepareTranscriptEviction(runtime, id)).toBe(false)
  store.closeAdjacentSession(); first.resolve(current); await one
  expect(await store.prepareTranscriptEviction(runtime, id)).toBe(false)
  second.resolve(current); await two
  expect(await store.prepareTranscriptEviction(runtime, id)).toBe(true)
})
