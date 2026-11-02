import { hash } from 'fast-sha256'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { approvalId, canonicalTranscriptBody, itemId, runtimeId, sessionId, sessionKey, turnId, type Session } from '@harnessdesk/protocol'
import type { TransportEvents } from '../lib/transport'
import { AppStore } from './store'
import { transcriptFingerprint } from './transcript-fingerprint'

// Browser-safe fixture hash; fixed SHA-256 vectors below independently pin its output.
const fixtureHash = (text: string): string => Array.from(hash(new TextEncoder().encode(text)), byte => byte.toString(16).padStart(2, '0')).join('')

beforeEach(() => vi.stubGlobal('sessionStorage', undefined))
afterEach(() => vi.unstubAllGlobals())

it('fingerprints UTF-8 with SHA-256 compatible with the Host', () => {
  for (const [input, expected] of [
    ['', 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'],
    ['abc', 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'],
    ['Synthetic 你好', '6ab4c44aff5957cf5b0f4faa8142f922c3be275b0fe14a06658f101814764285'],
  ]) {
    expect(fixtureHash(input!)).toBe(expected)
    expect(transcriptFingerprint(input!)).toBe(expected)
  }
})

it('matches browser Web Crypto for a canonical transcript fixture', async () => {
  const canonical = canonicalTranscriptBody([{ id: turnId('turn'), status: 'completed', items: [{ id: itemId('item'), type: 'assistantMessage', text: 'Synthetic 你好' }] }]).canonical
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical))
  const reference = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')
  expect(fixtureHash(canonical)).toBe(reference)
  expect(transcriptFingerprint(canonical)).toBe(reference)
})

it('plans oldest eligible full bodies using canonical UTF-8 bytes without unloading them', async () => {
  const runtime = runtimeId('example'), first = sessionId('one'), second = sessionId('two')
  const session = (id: typeof first, text: string): Session => ({ id, runtime, cwd: '/example', status: { type: 'idle' }, createdAt: 0, updatedAt: 0, itemsLoaded: true,
    turns: [{ id: turnId('turn'), status: 'completed', items: [{ id: itemId('item'), type: 'assistantMessage', text }] }] })
  const firstBody = session(first, 'é'), secondBody = session(second, 'Synthetic')
  const watermark = { epoch: 'epoch', generation: 'generation', revision: 1, sequence: 1 }
  const store = new AppStore('ws://localhost:0/')
  vi.spyOn(store.transport, 'request').mockImplementation((async (method: string, params: { sessionId: typeof first }) => {
    const body = params.sessionId === first ? firstBody : secondBody
    const identity = fixtureHash(canonicalTranscriptBody(body.turns).canonical)
    if (method === 'session/cache-snapshot') return { session: body, watermark, identity }
    if (method === 'session/prepare-eviction') return { ...watermark, identity }
    return null
  }) as never)
  const handlers = (store.transport as unknown as { handlers: TransportEvents }).handlers
  handlers.onEvent(runtime, { type: 'session/started', session: firstBody })
  handlers.onEvent(runtime, { type: 'session/started', session: secondBody })
  expect(await store.verifyTranscriptCache(runtime, first)).toBe(true)
  expect(await store.verifyTranscriptCache(runtime, second)).toBe(true)
  const cache = store as unknown as { planTranscriptEvictions(limits: { count: number; bytes: number }): readonly string[] }
  expect(cache.planTranscriptEvictions({ count: 1, bytes: Number.MAX_SAFE_INTEGER })).toEqual([])
  expect(await store.prepareTranscriptEviction(runtime, first)).toBe(true)
  expect(await store.prepareTranscriptEviction(runtime, second)).toBe(true)
  expect(cache.planTranscriptEvictions({ count: 1, bytes: Number.MAX_SAFE_INTEGER })).toEqual([sessionKey(runtime, first)])
  const total = canonicalTranscriptBody(firstBody.turns).bytes + canonicalTranscriptBody(secondBody.turns).bytes
  expect(cache.planTranscriptEvictions({ count: 128, bytes: total - 1 })).toEqual([sessionKey(runtime, first)])
  expect(store.getSnapshot().sessions.get(sessionKey(runtime, first))?.turns).toEqual(firstBody.turns)
  const release = store.retainTranscript(runtime, first)
  expect(cache.planTranscriptEvictions({ count: 1, bytes: Number.MAX_SAFE_INTEGER })).toEqual([])
  release()
  expect(await store.prepareTranscriptEviction(runtime, first)).toBe(true)
  // Owner changes fence all outstanding receipts conservatively; re-prove the other body too.
  expect(await store.prepareTranscriptEviction(runtime, second)).toBe(true)
  expect(cache.planTranscriptEvictions({ count: 1, bytes: Number.MAX_SAFE_INTEGER })).toEqual([sessionKey(runtime, second)])
})

it('prepares storage receipts serially before planning pressure', async () => {
  const runtime = runtimeId('example'), first = sessionId('one'), second = sessionId('two')
  const session = (id: typeof first): Session => ({ id, runtime, cwd: '/example', status: { type: 'idle' }, createdAt: 0, updatedAt: 0, itemsLoaded: true, turns: [] })
  const firstBody = session(first), secondBody = session(second)
  const watermark = { epoch: 'epoch', generation: 'generation', revision: 1, sequence: 1 }
  const identity = fixtureHash(canonicalTranscriptBody([]).canonical)
  let finish!: (value: unknown) => void
  const receipt = new Promise(resolve => { finish = resolve })
  const store = new AppStore('ws://localhost:0/')
  const request = vi.spyOn(store.transport, 'request').mockImplementation((async (method: string, params: { sessionId: typeof first }) => {
    if (method === 'session/cache-snapshot') return { session: params.sessionId === first ? firstBody : secondBody, watermark, identity }
    if (method === 'session/prepare-eviction') return params.sessionId === first ? receipt : { ...watermark, identity }
    return null
  }) as never)
  const handlers = (store.transport as unknown as { handlers: TransportEvents }).handlers
  handlers.onEvent(runtime, { type: 'session/started', session: firstBody })
  handlers.onEvent(runtime, { type: 'session/started', session: secondBody })
  const cache = store as unknown as { prepareTranscriptPressure(limits: { count: number; bytes: number }): Promise<readonly string[]> }
  const preparing = cache.prepareTranscriptPressure({ count: 1, bytes: Number.MAX_SAFE_INTEGER })
  const concurrent = cache.prepareTranscriptPressure({ count: 1, bytes: Number.MAX_SAFE_INTEGER })
  await vi.waitFor(() => expect(request).toHaveBeenCalledWith('session/prepare-eviction', { runtime, sessionId: first, identity }))
  expect(request).not.toHaveBeenCalledWith('session/cache-snapshot', { runtime, sessionId: second })
  expect(request.mock.calls.filter(([method]) => method === 'session/cache-snapshot')).toHaveLength(1)
  finish({ ...watermark, identity })
  expect(await preparing).toEqual([sessionKey(runtime, first)])
  expect(await concurrent).toEqual([sessionKey(runtime, first)])
  expect(store.getSnapshot().sessions.get(sessionKey(runtime, first))?.itemsLoaded).toBe(true)
})

it('a refused receipt never counts as released pressure', async () => {
  const runtime = runtimeId('example'), ids = [sessionId('one'), sessionId('two')]
  const body = (id: typeof ids[number]): Session => ({ id, runtime, cwd: '/example', status: { type: 'idle' }, createdAt: 0, updatedAt: 0, itemsLoaded: true, turns: [] })
  const watermark = { epoch: 'epoch', generation: 'generation', revision: 1, sequence: 1 }
  const identity = fixtureHash(canonicalTranscriptBody([]).canonical)
  const store = new AppStore('ws://localhost:0/')
  vi.spyOn(store.transport, 'request').mockImplementation((async (method: string, params: { sessionId: typeof ids[number] }) => {
    if (method === 'session/cache-snapshot') return { session: body(params.sessionId), watermark, identity }
    if (method === 'session/prepare-eviction') return params.sessionId === ids[0] ? null : { ...watermark, identity }
    return null
  }) as never)
  const handlers = (store.transport as unknown as { handlers: TransportEvents }).handlers
  for (const id of ids) handlers.onEvent(runtime, { type: 'session/started', session: body(id) })
  expect(await store.prepareTranscriptPressure({ count: 1, bytes: Number.MAX_SAFE_INTEGER })).toEqual([])
  for (const id of ids) expect(store.getSnapshot().sessions.get(sessionKey(runtime, id))?.itemsLoaded).toBe(true)
})

it('the default body-count target plans the oldest of 129 verified quiet bodies', async () => {
  const runtime = runtimeId('example')
  const watermark = { epoch: 'epoch', generation: 'generation', revision: 1, sequence: 1 }
  const identity = fixtureHash(canonicalTranscriptBody([]).canonical)
  const body = (id: ReturnType<typeof sessionId>): Session => ({ id, runtime, cwd: '/example', status: { type: 'idle' }, createdAt: 0, updatedAt: 0, itemsLoaded: true, turns: [] })
  const store = new AppStore('ws://localhost:0/')
  vi.spyOn(store.transport, 'request').mockImplementation((async (method: string, params: { sessionId: ReturnType<typeof sessionId> }) => {
    if (method === 'session/cache-snapshot') return { session: body(params.sessionId), watermark, identity }
    if (method === 'session/prepare-eviction') return { ...watermark, identity }
    return null
  }) as never)
  const handlers = (store.transport as unknown as { handlers: TransportEvents }).handlers
  for (let index = 0; index < 129; index++) handlers.onEvent(runtime, { type: 'session/started', session: body(sessionId(`s-${index}`)) })
  expect(await store.prepareTranscriptPressure()).toEqual([sessionKey(runtime, 's-0')])
  expect(store.getSnapshot().sessions.size).toBe(129)
})

it('the default byte target uses canonical UTF-8 rather than character count', async () => {
  const runtime = runtimeId('example'), id = sessionId('large')
  const body: Session = { id, runtime, cwd: '/example', status: { type: 'idle' }, createdAt: 0, updatedAt: 0, itemsLoaded: true,
    turns: [{ id: turnId('turn'), status: 'completed', items: [{ id: itemId('item'), type: 'assistantMessage', text: '界'.repeat(Math.ceil((8 * 1024 * 1024) / 3)) }] }] }
  const watermark = { epoch: 'epoch', generation: 'generation', revision: 1, sequence: 1 }
  const identity = fixtureHash(canonicalTranscriptBody(body.turns).canonical)
  const store = new AppStore('ws://localhost:0/')
  vi.spyOn(store.transport, 'request').mockImplementation((async (method: string) => method === 'session/cache-snapshot' ? { session: body, watermark, identity } : method === 'session/prepare-eviction' ? { ...watermark, identity } : null) as never)
  ;(store.transport as unknown as { handlers: TransportEvents }).handlers.onEvent(runtime, { type: 'session/started', session: body })
  expect(await store.prepareTranscriptPressure()).toEqual([sessionKey(runtime, id)])
  expect(store.getSnapshot().sessions.get(sessionKey(runtime, id))?.itemsLoaded).toBe(true)
})

it('a fenced snapshot makes a repeated sequenced delta apply only once', async () => {
  const runtime = runtimeId('example'), id = sessionId('one'), key = sessionKey(runtime, id)
  const body: Session = { id, runtime, cwd: '/example', status: { type: 'idle' }, createdAt: 0, updatedAt: 0, itemsLoaded: true,
    turns: [{ id: turnId('turn'), status: 'completed', items: [{ id: itemId('item'), type: 'assistantMessage', text: 'start' }] }] }
  const watermark = { epoch: 'epoch', generation: 'generation', revision: 1, sequence: 1 }
  const identity = fixtureHash(canonicalTranscriptBody(body.turns).canonical)
  const store = new AppStore('ws://localhost:0/')
  vi.spyOn(store.transport, 'request').mockImplementation((async (method: string) => method === 'session/cache-snapshot' ? { session: body, watermark, identity } : null) as never)
  const handlers = (store.transport as unknown as { handlers: TransportEvents }).handlers
  handlers.onEvent(runtime, { type: 'session/started', session: body })
  const cache = store as unknown as { verifyTranscriptCache(r: typeof runtime, s: typeof id): Promise<boolean> }
  expect(await cache.verifyTranscriptCache(runtime, id)).toBe(true)
  const event = { type: 'item/delta', sessionId: id, turnId: turnId('turn'), itemId: itemId('item'), delta: { kind: 'assistantText', text: '!' } } as const
  const fence = { ...watermark, revision: 2, sequence: 2 }
  handlers.onEvent(runtime, event, fence)
  handlers.onEvent(runtime, event, fence)
  expect(store.getSnapshot().sessions.get(key)?.turns[0]?.items[0]).toMatchObject({ text: 'start!' })
})

it.each([false, true])('a receipt %s a complete sequence is the only positive storage proof', async hasSequence => {
  const runtime = runtimeId('example'), id = sessionId('one'), key = sessionKey(runtime, id)
  const body: Session = { id, runtime, cwd: '/example', status: { type: 'idle' }, createdAt: 0, updatedAt: 0, itemsLoaded: true, turns: [] }
  const watermark = { epoch: 'epoch', generation: 'generation', revision: 1, sequence: 1 }
  const identity = fixtureHash(canonicalTranscriptBody(body.turns).canonical)
  const store = new AppStore('ws://localhost:0/')
  vi.spyOn(store.transport, 'request').mockImplementation((async (method: string) => method === 'session/cache-snapshot' ? { session: body, watermark, identity } : method === 'session/prepare-eviction' ? { ...watermark, sequence: hasSequence ? 1 : undefined, identity } : null) as never)
  ;(store.transport as unknown as { handlers: TransportEvents }).handlers.onEvent(runtime, { type: 'session/started', session: body })
  const cache = store as unknown as { prepareTranscriptEviction(r: typeof runtime, s: typeof id): Promise<boolean> }
  expect(await cache.prepareTranscriptEviction(runtime, id)).toBe(hasSequence)
  expect(store.getSnapshot().sessions.get(key)?.turns).toEqual(body.turns)
})

it.each(['epoch', 'generation', 'revision', 'sequence', 'identity'] as const)(
  'a receipt with a different %s cannot authorize storage', async field => {
    const runtime = runtimeId('example'), id = sessionId('one')
    const body: Session = { id, runtime, cwd: '/example', status: { type: 'idle' }, createdAt: 0, updatedAt: 0, itemsLoaded: true, turns: [] }
    const watermark = { epoch: 'epoch', generation: 'generation', revision: 1, sequence: 1 }
    const identity = fixtureHash(canonicalTranscriptBody(body.turns).canonical)
    const receipt = { ...watermark, identity, [field]: field === 'revision' || field === 'sequence' ? 2 : field === 'identity' ? '0'.repeat(64) : 'different' }
    const store = new AppStore('ws://localhost:0/')
    vi.spyOn(store.transport, 'request').mockImplementation((async (method: string) => method === 'session/cache-snapshot' ? { session: body, watermark, identity } : method === 'session/prepare-eviction' ? receipt : null) as never)
    ;(store.transport as unknown as { handlers: TransportEvents }).handlers.onEvent(runtime, { type: 'session/started', session: body })
    expect(await store.prepareTranscriptEviction(runtime, id)).toBe(false)
  },
)

it.each(['owner', 'event', 'draft', 'pin-aba', 'remove', 'in-place'] as const)(
  'a receipt overtaken by %s cannot authorize the old body', async kind => {
    const runtime = runtimeId('example'), id = sessionId('one'), key = sessionKey(runtime, id)
    const body: Session = { id, runtime, cwd: '/example', status: { type: 'idle' }, createdAt: 0, updatedAt: 0, itemsLoaded: true, turns: [] }
    const watermark = { epoch: 'epoch', generation: 'generation', revision: 1, sequence: 1 }
    const identity = fixtureHash(canonicalTranscriptBody(body.turns).canonical)
    let finish!: (value: unknown) => void
    const held = new Promise(resolve => { finish = resolve })
    const store = new AppStore('ws://localhost:0/')
    vi.spyOn(store.transport, 'request').mockImplementation((async (method: string) => method === 'session/cache-snapshot' ? { session: body, watermark, identity } : method === 'session/prepare-eviction' ? held : null) as never)
    const handlers = (store.transport as unknown as { handlers: TransportEvents }).handlers
    handlers.onEvent(runtime, { type: 'session/started', session: body })
    const preparing = store.prepareTranscriptEviction(runtime, id)
    await vi.waitFor(() => expect(store.transport.request).toHaveBeenCalledWith('session/prepare-eviction', { runtime, sessionId: id, identity }))
    let release: (() => void) | undefined
    if (kind === 'owner') release = store.retainTranscript(runtime, id)
    else if (kind === 'event') handlers.onEvent(runtime, { type: 'session/title', sessionId: id, title: 'new' }, { ...watermark, revision: 2, sequence: 2 })
    else if (kind === 'draft') store.drafts.setLive(key, { text: 'Synthetic', attachments: [] })
    else if (kind === 'pin-aba') { store.setListPrefs({ pinnedSessions: [key] }); store.setListPrefs({ pinnedSessions: [] }) }
    else if (kind === 'remove') handlers.onNotification({ method: 'session/removed', params: { runtime, sessionId: id, deleted: false } })
    else (body as { title?: string }).title = 'Synthetic changed in place'
    finish({ ...watermark, identity })
    expect(await preparing).toBe(false)
    if (kind !== 'remove') expect(store.getSnapshot().sessions.has(key)).toBe(true)
    release?.()
  },
)

it.each(['null', 'missing-sequence', 'wrong-key', 'wrong-identity', 'different-body', 'partial-host', 'active-host', 'richer-local-metadata'] as const)(
  '%s snapshot cannot authorize a transcript', async kind => {
    const runtime = runtimeId('example'), id = sessionId('one'), key = sessionKey(runtime, id)
    const body: Session = { id, runtime, cwd: '/example', status: { type: 'idle' }, createdAt: 0, updatedAt: 0, itemsLoaded: true, turns: [], ...(kind === 'richer-local-metadata' ? { title: 'Synthetic local title' } : {}) }
    const watermark = { epoch: 'epoch', generation: 'generation', revision: 1, sequence: 1 }
    const identity = fixtureHash(canonicalTranscriptBody(body.turns).canonical)
    const other = { ...body, turns: [{ id: turnId('other'), status: 'completed' as const, items: [] }] }
    const response = kind === 'null' ? null : { session: kind === 'wrong-key' ? { ...body, id: sessionId('other') } : kind === 'different-body' ? other : kind === 'partial-host' ? { ...body, partialHistory: true } : kind === 'active-host' ? { ...body, status: { type: 'active' } } : kind === 'richer-local-metadata' ? { ...body, title: undefined } : body,
      watermark: kind === 'missing-sequence' ? { epoch: 'epoch', generation: 'generation', revision: 1 } : watermark,
      identity: kind === 'wrong-identity' ? '0'.repeat(64) : identity }
    const store = new AppStore('ws://localhost:0/')
    vi.spyOn(store.transport, 'request').mockImplementation((async () => response) as never)
    ;(store.transport as unknown as { handlers: TransportEvents }).handlers.onEvent(runtime, { type: 'session/started', session: body })
    expect(await store.verifyTranscriptCache(runtime, id)).toBe(false)
    expect(store.getSnapshot().sessions.get(key)?.turns).toEqual(body.turns)
  },
)

it('a different event at the same cursor invalidates authority and preserves the body', async () => {
  const runtime = runtimeId('example'), id = sessionId('one'), key = sessionKey(runtime, id)
  const body: Session = { id, runtime, cwd: '/example', status: { type: 'idle' }, createdAt: 0, updatedAt: 0, itemsLoaded: true,
    turns: [{ id: turnId('turn'), status: 'completed', items: [{ id: itemId('item'), type: 'assistantMessage', text: 'start' }] }] }
  const watermark = { epoch: 'epoch', generation: 'generation', revision: 1, sequence: 1 }
  const identity = fixtureHash(canonicalTranscriptBody(body.turns).canonical)
  const store = new AppStore('ws://localhost:0/')
  vi.spyOn(store.transport, 'request').mockImplementation((async (method: string) => method === 'session/cache-snapshot' ? { session: body, watermark, identity } : null) as never)
  const handlers = (store.transport as unknown as { handlers: TransportEvents }).handlers
  handlers.onEvent(runtime, { type: 'session/started', session: body })
  const cache = store as unknown as { verifyTranscriptCache(r: typeof runtime, s: typeof id): Promise<boolean>; transcriptCacheVerified(r: typeof runtime, s: typeof id): boolean }
  expect(await cache.verifyTranscriptCache(runtime, id)).toBe(true)
  const event = { type: 'item/delta', sessionId: id, turnId: turnId('turn'), itemId: itemId('item'), delta: { kind: 'assistantText', text: '!' } } as const
  const fence = { ...watermark, revision: 2, sequence: 2 }
  handlers.onEvent(runtime, event, fence)
  handlers.onEvent(runtime, { ...event, delta: { kind: 'assistantText', text: 'conflict' } }, fence)
  expect(store.getSnapshot().sessions.get(key)?.turns[0]?.items[0]).toMatchObject({ text: 'start!' })
  expect(cache.transcriptCacheVerified(runtime, id)).toBe(false)
})

it('a snapshot returned after a newer event cannot establish authority over it', async () => {
  const runtime = runtimeId('example'), id = sessionId('one'), key = sessionKey(runtime, id)
  const body: Session = { id, runtime, cwd: '/example', status: { type: 'idle' }, createdAt: 0, updatedAt: 0, itemsLoaded: true,
    turns: [{ id: turnId('turn'), status: 'completed', items: [{ id: itemId('item'), type: 'assistantMessage', text: 'start' }] }] }
  const watermark = { epoch: 'epoch', generation: 'generation', revision: 1, sequence: 1 }
  const identity = fixtureHash(canonicalTranscriptBody(body.turns).canonical)
  let answer!: (value: unknown) => void
  const pending = new Promise(resolve => { answer = resolve })
  const store = new AppStore('ws://localhost:0/')
  vi.spyOn(store.transport, 'request').mockImplementation((async (method: string) => method === 'session/cache-snapshot' ? pending : null) as never)
  const handlers = (store.transport as unknown as { handlers: TransportEvents }).handlers
  handlers.onEvent(runtime, { type: 'session/started', session: body })
  const cache = store as unknown as { verifyTranscriptCache(r: typeof runtime, s: typeof id): Promise<boolean> }
  const verifying = cache.verifyTranscriptCache(runtime, id)
  handlers.onEvent(runtime, { type: 'item/delta', sessionId: id, turnId: turnId('turn'), itemId: itemId('item'), delta: { kind: 'assistantText', text: '!' } }, { ...watermark, revision: 2, sequence: 2 })
  answer({ session: body, watermark, identity })
  expect(await verifying).toBe(false)
  expect(store.getSnapshot().sessions.get(key)?.turns[0]?.items[0]).toMatchObject({ text: 'start!' })
})

it('a snapshot cannot authorize an in-place mutation during its request', async () => {
  const runtime = runtimeId('example'), id = sessionId('one')
  const body: Session = { id, runtime, cwd: '/example', status: { type: 'idle' }, createdAt: 0, updatedAt: 0, itemsLoaded: true, turns: [] }
  const watermark = { epoch: 'epoch', generation: 'generation', revision: 1, sequence: 1 }
  const identity = fixtureHash(canonicalTranscriptBody(body.turns).canonical)
  let finish!: (value: unknown) => void
  const held = new Promise(resolve => { finish = resolve })
  const store = new AppStore('ws://localhost:0/')
  vi.spyOn(store.transport, 'request').mockImplementation((async () => held) as never)
  ;(store.transport as unknown as { handlers: TransportEvents }).handlers.onEvent(runtime, { type: 'session/started', session: body })
  const verifying = store.verifyTranscriptCache(runtime, id)
  ;(body as { title?: string }).title = 'Synthetic changed in place'
  finish({ session: body, watermark, identity })
  expect(await verifying).toBe(false)
})

it('an older concurrent snapshot cannot replace the newer cursor', async () => {
  const runtime = runtimeId('example'), id = sessionId('one')
  const body: Session = { id, runtime, cwd: '/example', status: { type: 'idle' }, createdAt: 0, updatedAt: 0, itemsLoaded: true, turns: [] }
  const watermark = { epoch: 'epoch', generation: 'generation', revision: 1, sequence: 1 }
  const identity = fixtureHash(canonicalTranscriptBody(body.turns).canonical)
  let older!: (value: unknown) => void
  const held = new Promise(resolve => { older = resolve })
  let calls = 0
  const store = new AppStore('ws://localhost:0/')
  vi.spyOn(store.transport, 'request').mockImplementation((async (method: string) => method === 'session/cache-snapshot' ? ++calls === 1 ? held : { session: body, watermark: { ...watermark, revision: 2, sequence: 2 }, identity } : null) as never)
  const handlers = (store.transport as unknown as { handlers: TransportEvents }).handlers
  handlers.onEvent(runtime, { type: 'session/started', session: body })
  const first = store.verifyTranscriptCache(runtime, id)
  expect(await store.verifyTranscriptCache(runtime, id)).toBe(true)
  older({ session: body, watermark, identity })
  expect(await first).toBe(false)
})

it('a later response with an older cursor cannot replace current authority', async () => {
  const runtime = runtimeId('example'), id = sessionId('one')
  const body: Session = { id, runtime, cwd: '/example', status: { type: 'idle' }, createdAt: 0, updatedAt: 0, itemsLoaded: true, turns: [] }
  const watermark = { epoch: 'epoch', generation: 'generation', revision: 2, sequence: 2 }
  const identity = fixtureHash(canonicalTranscriptBody(body.turns).canonical)
  let calls = 0
  const store = new AppStore('ws://localhost:0/')
  vi.spyOn(store.transport, 'request').mockImplementation((async () => ({ session: body, watermark: ++calls === 1 ? watermark : { ...watermark, revision: 1, sequence: 1 }, identity })) as never)
  ;(store.transport as unknown as { handlers: TransportEvents }).handlers.onEvent(runtime, { type: 'session/started', session: body })
  expect(await store.verifyTranscriptCache(runtime, id)).toBe(true)
  expect(await store.verifyTranscriptCache(runtime, id)).toBe(false)
})

it.each(['epoch', 'generation'] as const)('a snapshot with a changed %s cannot silently replace current authority', async field => {
  const runtime = runtimeId('example'), id = sessionId('one')
  const body: Session = { id, runtime, cwd: '/example', status: { type: 'idle' }, createdAt: 0, updatedAt: 0, itemsLoaded: true, turns: [] }
  const watermark = { epoch: 'epoch', generation: 'generation', revision: 1, sequence: 1 }
  const identity = fixtureHash(canonicalTranscriptBody(body.turns).canonical)
  let calls = 0
  const store = new AppStore('ws://localhost:0/')
  vi.spyOn(store.transport, 'request').mockImplementation((async () => ({ session: body, watermark: ++calls === 1 ? watermark : { ...watermark, [field]: 'changed' }, identity })) as never)
  ;(store.transport as unknown as { handlers: TransportEvents }).handlers.onEvent(runtime, { type: 'session/started', session: body })
  expect(await store.verifyTranscriptCache(runtime, id)).toBe(true)
  expect(await store.verifyTranscriptCache(runtime, id)).toBe(false)
  expect(store.transcriptCacheVerified(runtime, id)).toBe(false)
})

it('independent owners acquired during a snapshot invalidate its result', async () => {
  const runtime = runtimeId('example'), id = sessionId('one')
  const body: Session = { id, runtime, cwd: '/example', status: { type: 'idle' }, createdAt: 0, updatedAt: 0, itemsLoaded: true, turns: [] }
  const watermark = { epoch: 'epoch', generation: 'generation', revision: 1, sequence: 1 }
  const identity = fixtureHash(canonicalTranscriptBody(body.turns).canonical)
  let answer!: (value: unknown) => void
  const pending = new Promise(resolve => { answer = resolve })
  const store = new AppStore('ws://localhost:0/')
  vi.spyOn(store.transport, 'request').mockImplementation((async (method: string) => method === 'session/cache-snapshot' ? pending : null) as never)
  const handlers = (store.transport as unknown as { handlers: TransportEvents }).handlers
  handlers.onEvent(runtime, { type: 'session/started', session: body })
  const cache = store as unknown as { verifyTranscriptCache(r: typeof runtime, s: typeof id): Promise<boolean>; retainTranscript(r: typeof runtime, s: typeof id): () => void }
  const verifying = cache.verifyTranscriptCache(runtime, id)
  const first = cache.retainTranscript(runtime, id), second = cache.retainTranscript(runtime, id)
  first(); first()
  expect(await cache.verifyTranscriptCache(runtime, id)).toBe(false)
  answer({ session: body, watermark, identity })
  expect(await verifying).toBe(false)
  second()
  expect(await cache.verifyTranscriptCache(runtime, id)).toBe(true)
})

it('an in-flight real openSession read protects its transcript', async () => {
  const runtime = runtimeId('example'), id = sessionId('one')
  const body: Session = { id, runtime, cwd: '/example', status: { type: 'idle' }, createdAt: 0, updatedAt: 0, itemsLoaded: true, turns: [] }
  const watermark = { epoch: 'epoch', generation: 'generation', revision: 1, sequence: 1 }
  const identity = fixtureHash(canonicalTranscriptBody(body.turns).canonical)
  let finish!: (value: Session) => void
  const read = new Promise<Session>(resolve => { finish = resolve })
  const store = new AppStore('ws://localhost:0/')
  vi.spyOn(store.transport, 'request').mockImplementation((async (method: string) => method === 'session/read' ? read : method === 'session/cache-snapshot' ? { session: body, watermark, identity } : body) as never)
  const handlers = (store.transport as unknown as { handlers: TransportEvents }).handlers
  handlers.onEvent(runtime, { type: 'session/started', session: body })
  const opening = store.openSession(id, { runtime, reveal: false })
  await vi.waitFor(() => expect(store.transport.request).toHaveBeenCalledWith('session/read', { runtime, sessionId: id }))
  expect(await store.verifyTranscriptCache(runtime, id)).toBe(false)
  finish(body)
  await opening
})

it('two overlapping opens retain independent read and resume owners', async () => {
  const runtime = runtimeId('example'), id = sessionId('one')
  const body: Session = { id, runtime, cwd: '/example', status: { type: 'idle' }, createdAt: 0, updatedAt: 0, itemsLoaded: true, turns: [], archived: false }
  const watermark = { epoch: 'epoch', generation: 'generation', revision: 1, sequence: 1 }
  const identity = fixtureHash(canonicalTranscriptBody(body.turns).canonical)
  const finishes: ((value: Session) => void)[] = []
  const store = new AppStore('ws://localhost:0/')
  vi.spyOn(store.transport, 'request').mockImplementation((async (method: string) => {
    if (method === 'session/read') return new Promise<Session>(resolve => finishes.push(resolve))
    if (method === 'session/cache-snapshot') return { session: body, watermark, identity }
    return body
  }) as never)
  ;(store.transport as unknown as { handlers: TransportEvents }).handlers.onEvent(runtime, { type: 'session/started', session: body })
  const first = store.openSession(id, { runtime, reveal: false }), second = store.openSession(id, { runtime, reveal: false })
  await vi.waitFor(() => expect(finishes).toHaveLength(2))
  finishes[0]!(body); await first
  expect(await store.verifyTranscriptCache(runtime, id)).toBe(false)
  finishes[1]!(body); await second
  expect(store.getSnapshot().loadingSessions.size).toBe(0)
  expect(store.getSnapshot().sessions.get(sessionKey(runtime, id))).toEqual(body)
  expect(await store.verifyTranscriptCache(runtime, id)).toBe(true)
})

it('an in-flight handoff read protects its source transcript', async () => {
  const runtime = runtimeId('example'), id = sessionId('one')
  const body: Session = { id, runtime, cwd: '/example', status: { type: 'idle' }, createdAt: 0, updatedAt: 0, itemsLoaded: true, turns: [] }
  const watermark = { epoch: 'epoch', generation: 'generation', revision: 1, sequence: 1 }
  const identity = fixtureHash(canonicalTranscriptBody(body.turns).canonical)
  let finish!: (value: Session) => void
  const read = new Promise<Session>(resolve => { finish = resolve })
  const store = new AppStore('ws://localhost:0/')
  vi.spyOn(store.transport, 'request').mockImplementation((async (method: string) => method === 'session/read' ? read : method === 'session/cache-snapshot' ? { session: body, watermark, identity } : null) as never)
  ;(store.transport as unknown as { handlers: TransportEvents }).handlers.onEvent(runtime, { type: 'session/started', session: body })
  const handoff = store.handoffPacket({ runtime, sessionId: id, carry: 'summary', agentName: 'Example', title: 'Example', cwd: '/example' })
  await vi.waitFor(() => expect(store.transport.request).toHaveBeenCalledWith('session/read', { runtime, sessionId: id }))
  expect(await store.verifyTranscriptCache(runtime, id)).toBe(false)
  finish(body)
  await handoff
})

it('a pending composer queue request protects its session before a queue event arrives', async () => {
  const runtime = runtimeId('example'), id = sessionId('one'), key = sessionKey(runtime, id)
  const body: Session = { id, runtime, cwd: '/example', status: { type: 'idle' }, createdAt: 0, updatedAt: 0, itemsLoaded: true, turns: [] }
  const watermark = { epoch: 'epoch', generation: 'generation', revision: 1, sequence: 1 }
  const identity = fixtureHash(canonicalTranscriptBody(body.turns).canonical)
  let finish!: () => void
  const held = new Promise<void>(resolve => { finish = resolve })
  const store = new AppStore('ws://localhost:0/')
  vi.spyOn(store.transport, 'request').mockImplementation((async (method: string) => method === 'turn/queue' ? held : method === 'session/cache-snapshot' ? { session: body, watermark, identity } : null) as never)
  ;(store.transport as unknown as { handlers: TransportEvents }).handlers.onEvent(runtime, { type: 'session/started', session: body })
  const sending = store.queue([{ type: 'text', text: 'Synthetic' }], key)
  expect(await store.verifyTranscriptCache(runtime, id)).toBe(false)
  finish()
  await sending
})

it('real Transport owns addressed operations but does not self-own cache proof requests', async () => {
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
  const original = globalThis.WebSocket
  globalThis.WebSocket = MockWebSocket as unknown as typeof WebSocket
  try {
    const runtime = runtimeId('example'), id = sessionId('one')
    const body: Session = { id, runtime, cwd: '/example', status: { type: 'idle' }, createdAt: 0, updatedAt: 0, itemsLoaded: true, turns: [] }
    const watermark = { epoch: 'epoch', generation: 'generation', revision: 1, sequence: 1 }
    const identity = fixtureHash(canonicalTranscriptBody(body.turns).canonical)
    const store = new AppStore('ws://example.test/')
    store.transport.connect(); const socket = MockWebSocket.instance; socket.open()
    socket.message({ method: 'event', params: { runtime, event: { type: 'session/started', session: body } } })
    const operation = store.transport.request('session/rollback', { runtime, sessionId: id, turns: 1 })
    expect(await store.verifyTranscriptCache(runtime, id)).toBe(false)
    expect(socket.sent.some(frame => frame.method === 'session/cache-snapshot')).toBe(false)
    const op = socket.sent.find(frame => frame.method === 'session/rollback')!
    socket.message({ id: op.id, ok: true, result: null }); await operation
    const verifying = store.verifyTranscriptCache(runtime, id)
    const snapshot = socket.sent.find(frame => frame.method === 'session/cache-snapshot')!
    socket.message({ id: snapshot.id, ok: true, result: { session: body, watermark, identity } })
    expect(await verifying).toBe(true)
    const preparing = store.prepareTranscriptEviction(runtime, id)
    const secondSnapshot = socket.sent.filter(frame => frame.method === 'session/cache-snapshot').at(-1)!
    expect(secondSnapshot.id).not.toBe(snapshot.id)
    socket.message({ id: secondSnapshot.id, ok: true, result: { session: body, watermark, identity } })
    await vi.waitFor(() => expect(socket.sent.some(frame => frame.method === 'session/prepare-eviction')).toBe(true))
    const receipt = socket.sent.find(frame => frame.method === 'session/prepare-eviction')!
    socket.message({ id: receipt.id, ok: true, result: { ...watermark, identity } })
    expect(await preparing).toBe(true)
    store.transport.close()
  } finally { globalThis.WebSocket = original }
})

it.each(['settings', 'title'] as const)('an in-flight session %s mutation protects its existing body', async kind => {
  const runtime = runtimeId('example'), id = sessionId('one'), key = sessionKey(runtime, id)
  const body: Session = { id, runtime, cwd: '/example', status: { type: 'idle' }, createdAt: 0, updatedAt: 0, itemsLoaded: true, turns: [] }
  const watermark = { epoch: 'epoch', generation: 'generation', revision: 1, sequence: 1 }
  const identity = fixtureHash(canonicalTranscriptBody(body.turns).canonical)
  let finish!: () => void
  const held = new Promise<void>(resolve => { finish = resolve })
  const store = new AppStore('ws://localhost:0/')
  vi.spyOn(store.transport, 'request').mockImplementation((async (method: string) => method === 'session/settings' || method === 'session/setTitle' ? held : method === 'session/cache-snapshot' ? { session: body, watermark, identity } : null) as never)
  ;(store.transport as unknown as { handlers: TransportEvents }).handlers.onEvent(runtime, { type: 'session/started', session: body })
  const updating = kind === 'settings' ? store.updateSettings({ model: 'synthetic' }, key) : store.renameSession('Synthetic title', key)
  expect(await store.verifyTranscriptCache(runtime, id)).toBe(false)
  finish()
  await updating
})

it('a real visible conversation remains protected after its read and resume finish', async () => {
  const runtime = runtimeId('example'), id = sessionId('one')
  const body: Session = { id, runtime, cwd: '/example', status: { type: 'idle' }, createdAt: 0, updatedAt: 0, itemsLoaded: true, turns: [] }
  const watermark = { epoch: 'epoch', generation: 'generation', revision: 1, sequence: 1 }
  const identity = fixtureHash(canonicalTranscriptBody(body.turns).canonical)
  const store = new AppStore('ws://localhost:0/')
  vi.spyOn(store.transport, 'request').mockImplementation((async (method: string) => method === 'session/cache-snapshot' ? { session: body, watermark, identity } : body) as never)
  expect(await store.openSession(id, { runtime })).toBe(true)
  expect(await store.verifyTranscriptCache(runtime, id)).toBe(false)
})

it('a pending close keeps the just-hidden transcript protected', async () => {
  const runtime = runtimeId('example'), id = sessionId('one')
  const body: Session = { id, runtime, cwd: '/example', status: { type: 'idle' }, createdAt: 0, updatedAt: 0, itemsLoaded: true, turns: [] }
  const watermark = { epoch: 'epoch', generation: 'generation', revision: 1, sequence: 1 }
  const identity = fixtureHash(canonicalTranscriptBody(body.turns).canonical)
  let finish!: () => void
  const close = new Promise<void>(resolve => { finish = resolve })
  const store = new AppStore('ws://localhost:0/')
  vi.spyOn(store.transport, 'request').mockImplementation((async (method: string) => method === 'session/close' ? close : method === 'session/cache-snapshot' ? { session: body, watermark, identity } : body) as never)
  expect(await store.openSession(id, { runtime })).toBe(true)
  store.closePane(store.getSnapshot().layout.focused)
  await vi.waitFor(() => expect(store.transport.request).toHaveBeenCalledWith('session/close', { runtime, sessionId: id }))
  expect(await store.verifyTranscriptCache(runtime, id)).toBe(false)
  finish()
})

it('an optimistically hidden approval stays protected while its response is pending', async () => {
  const runtime = runtimeId('example'), id = sessionId('one'), key = sessionKey(runtime, id)
  const body: Session = { id, runtime, cwd: '/example', status: { type: 'idle' }, createdAt: 0, updatedAt: 0, itemsLoaded: true, turns: [] }
  const watermark = { epoch: 'epoch', generation: 'generation', revision: 1, sequence: 1 }
  const identity = fixtureHash(canonicalTranscriptBody(body.turns).canonical)
  const approval = { id: approvalId('approval'), sessionId: id, requestedAt: 1, type: 'command' as const, command: 'echo synthetic', cwd: '/example', actions: [], options: [{ id: 'yes', label: 'Allow', intent: 'approve' as const }] }
  let finish!: () => void
  const held = new Promise<void>(resolve => { finish = resolve })
  const store = new AppStore('ws://localhost:0/')
  vi.spyOn(store.transport, 'request').mockImplementation((async (method: string) => method === 'approval/respond' ? held : method === 'session/cache-snapshot' ? { session: body, watermark, identity } : null) as never)
  const handlers = (store.transport as unknown as { handlers: TransportEvents }).handlers
  handlers.onEvent(runtime, { type: 'session/started', session: body })
  handlers.onEvent(runtime, { type: 'approval/requested', approval })
  const responding = store.respondToApproval(key, approval.id, { type: 'option', optionId: 'yes' })
  expect(await store.verifyTranscriptCache(runtime, id)).toBe(false)
  finish()
  await responding
})

it('an unsent draft protects a hidden conversation', async () => {
  const runtime = runtimeId('example'), id = sessionId('one'), key = sessionKey(runtime, id)
  const body: Session = { id, runtime, cwd: '/example', status: { type: 'idle' }, createdAt: 0, updatedAt: 0, itemsLoaded: true, turns: [] }
  const watermark = { epoch: 'epoch', generation: 'generation', revision: 1, sequence: 1 }
  const identity = fixtureHash(canonicalTranscriptBody(body.turns).canonical)
  const store = new AppStore('ws://localhost:0/')
  vi.spyOn(store.transport, 'request').mockImplementation((async (method: string) => method === 'session/cache-snapshot' ? { session: body, watermark, identity } : null) as never)
  ;(store.transport as unknown as { handlers: TransportEvents }).handlers.onEvent(runtime, { type: 'session/started', session: body })
  store.drafts.setLive(key, { text: 'Synthetic unsent draft', attachments: [] })
  expect(await store.verifyTranscriptCache(runtime, id)).toBe(false)
})

it.each(['queue', 'task', 'pinned', 'recoverable'] as const)(
  'a hidden conversation with %s work remains protected', async kind => {
    const runtime = runtimeId('example'), id = sessionId('one'), key = sessionKey(runtime, id)
    const body: Session = { id, runtime, cwd: '/example', status: { type: 'idle' }, createdAt: 0, updatedAt: 0, itemsLoaded: true, turns: [] }
    const watermark = { epoch: 'epoch', generation: 'generation', revision: 1, sequence: 1 }
    const identity = fixtureHash(canonicalTranscriptBody(body.turns).canonical)
    const store = new AppStore('ws://localhost:0/')
    vi.spyOn(store.transport, 'request').mockImplementation((async (method: string) => method === 'session/cache-snapshot' ? { session: body, watermark, identity } : null) as never)
    const handlers = (store.transport as unknown as { handlers: TransportEvents }).handlers
    handlers.onEvent(runtime, { type: 'session/started', session: body })
    expect(await store.verifyTranscriptCache(runtime, id)).toBe(true)
    if (kind === 'queue') handlers.onEvent(runtime, { type: 'session/queue', sessionId: id, queue: { status: 'waiting', messages: [{ id: 'q', input: [{ type: 'text', text: 'Synthetic' }], queuedAt: 1, state: 'queued' }] } })
    else if (kind === 'task') handlers.onEvent(runtime, { type: 'session/tasks', sessionId: id, tasks: [{ id: 'task', label: 'Synthetic', kind: 'other', state: 'running', stoppable: false }] })
    else if (kind === 'pinned') store.setListPrefs({ pinnedSessions: [key] })
    else store.drafts.addRecoverable(key, { text: 'Synthetic', attachments: [], detail: 'Saved' })
    expect(await store.verifyTranscriptCache(runtime, id)).toBe(false)
  },
)

it('a draft created and cleared while a snapshot is pending invalidates the snapshot', async () => {
  const runtime = runtimeId('example'), id = sessionId('one'), key = sessionKey(runtime, id)
  const body: Session = { id, runtime, cwd: '/example', status: { type: 'idle' }, createdAt: 0, updatedAt: 0, itemsLoaded: true, turns: [] }
  const watermark = { epoch: 'epoch', generation: 'generation', revision: 1, sequence: 1 }
  const identity = fixtureHash(canonicalTranscriptBody(body.turns).canonical)
  let finish!: (value: unknown) => void
  const held = new Promise(resolve => { finish = resolve })
  const store = new AppStore('ws://localhost:0/')
  vi.spyOn(store.transport, 'request').mockImplementation((async () => held) as never)
  ;(store.transport as unknown as { handlers: TransportEvents }).handlers.onEvent(runtime, { type: 'session/started', session: body })
  const verifying = store.verifyTranscriptCache(runtime, id)
  store.drafts.setLive(key, { text: 'Synthetic draft', attachments: [] })
  store.drafts.setLive(key, { text: '', attachments: [] })
  finish({ session: body, watermark, identity })
  expect(await verifying).toBe(false)
})

it('a mounted Team protects each member even without opening its transcript pane', async () => {
  const runtime = runtimeId('example'), id = sessionId('one'), key = sessionKey(runtime, id)
  const body: Session = { id, runtime, cwd: '/example', status: { type: 'idle' }, createdAt: 0, updatedAt: 0, itemsLoaded: true, turns: [] }
  const watermark = { epoch: 'epoch', generation: 'generation', revision: 1, sequence: 1 }
  const identity = fixtureHash(canonicalTranscriptBody(body.turns).canonical)
  const store = new AppStore('ws://localhost:0/')
  vi.spyOn(store.transport, 'request').mockImplementation((async (method: string) => method === 'session/cache-snapshot' ? { session: body, watermark, identity } : null) as never)
  const handlers = (store.transport as unknown as { handlers: TransportEvents }).handlers
  handlers.onEvent(runtime, { type: 'session/started', session: body })
  expect(await store.verifyTranscriptCache(runtime, id)).toBe(true)
  handlers.onNotification({ method: 'team/changed', params: { state: { id: 'team', name: 'Team', root: '/example', updatedAt: 0, members: [key], nicknames: {}, messaging: true, intents: [], channel: [] } } })
  store.openTeamRoom('team')
  expect(await store.verifyTranscriptCache(runtime, id)).toBe(false)
})

it('a direct remove response retires the old transcript cursor', async () => {
  const runtime = runtimeId('example'), id = sessionId('one')
  const body: Session = { id, runtime, cwd: '/example', status: { type: 'idle' }, createdAt: 0, updatedAt: 0, itemsLoaded: true, turns: [] }
  const watermark = { epoch: 'epoch', generation: 'generation', revision: 1, sequence: 1 }
  const identity = fixtureHash(canonicalTranscriptBody(body.turns).canonical)
  const store = new AppStore('ws://localhost:0/')
  vi.spyOn(store.transport, 'request').mockImplementation((async (method: string) => method === 'session/cache-snapshot' ? { session: body, watermark, identity } : method === 'session/remove' ? { undoUntil: null } : null) as never)
  const handlers = (store.transport as unknown as { handlers: TransportEvents }).handlers
  handlers.onEvent(runtime, { type: 'session/started', session: body })
  expect(await store.verifyTranscriptCache(runtime, id)).toBe(true)
  await store.removeSession(id, runtime)
  expect(store.transcriptCacheVerified(runtime, id)).toBe(false)
})

it('a refused remove during a held snapshot invalidates its earlier admission', async () => {
  const runtime = runtimeId('example'), id = sessionId('one')
  const body: Session = { id, runtime, cwd: '/example', status: { type: 'idle' }, createdAt: 0, updatedAt: 0, itemsLoaded: true, turns: [] }
  const watermark = { epoch: 'epoch', generation: 'generation', revision: 1, sequence: 1 }
  const identity = fixtureHash(canonicalTranscriptBody(body.turns).canonical)
  let finish!: (value: unknown) => void
  const held = new Promise(resolve => { finish = resolve })
  const store = new AppStore('ws://localhost:0/')
  vi.spyOn(store.transport, 'request').mockImplementation((async (method: string) => {
    if (method === 'session/cache-snapshot') return held
    if (method === 'session/remove') throw new Error('Synthetic refusal')
    return null
  }) as never)
  ;(store.transport as unknown as { handlers: TransportEvents }).handlers.onEvent(runtime, { type: 'session/started', session: body })
  const verifying = store.verifyTranscriptCache(runtime, id)
  await store.removeSession(id, runtime)
  finish({ session: body, watermark, identity })
  expect(await verifying).toBe(false)
})

it('a held snapshot cannot authorize a removed and recreated session with the same key', async () => {
  const runtime = runtimeId('example'), id = sessionId('one')
  const body: Session = { id, runtime, cwd: '/example', status: { type: 'idle' }, createdAt: 0, updatedAt: 0, itemsLoaded: true, turns: [] }
  const watermark = { epoch: 'epoch', generation: 'old', revision: 1, sequence: 1 }
  const identity = fixtureHash(canonicalTranscriptBody(body.turns).canonical)
  let answer!: (value: unknown) => void
  const pending = new Promise(resolve => { answer = resolve })
  const store = new AppStore('ws://localhost:0/')
  vi.spyOn(store.transport, 'request').mockImplementation((async (method: string) => method === 'session/cache-snapshot' ? pending : null) as never)
  const handlers = (store.transport as unknown as { handlers: TransportEvents }).handlers
  handlers.onEvent(runtime, { type: 'session/started', session: body })
  const verifying = store.verifyTranscriptCache(runtime, id)
  handlers.onNotification({ method: 'session/removed', params: { runtime, sessionId: id, deleted: false } })
  handlers.onEvent(runtime, { type: 'session/started', session: body })
  answer({ session: body, watermark, identity })
  expect(await verifying).toBe(false)
  expect(store.transcriptCacheVerified(runtime, id)).toBe(false)
})

it('a gap followed by a delta for an unseen turn recovers the complete Host snapshot', async () => {
  const runtime = runtimeId('example'), id = sessionId('one'), key = sessionKey(runtime, id)
  const body: Session = { id, runtime, cwd: '/example', status: { type: 'idle' }, createdAt: 0, updatedAt: 0, itemsLoaded: true, turns: [] }
  const next: Session = { ...body, turns: [{ id: turnId('turn'), status: 'completed', items: [{ id: itemId('item'), type: 'assistantMessage', text: 'Synthetic new text' }] }] }
  const watermark = { epoch: 'epoch', generation: 'generation', revision: 1, sequence: 1 }
  const digest = (session: Session) => fixtureHash(canonicalTranscriptBody(session.turns).canonical)
  let calls = 0
  const store = new AppStore('ws://localhost:0/')
  vi.spyOn(store.transport, 'request').mockImplementation((async (method: string) => method === 'session/cache-snapshot' ? ++calls === 1 ? { session: body, watermark, identity: digest(body) } : { session: next, watermark: { ...watermark, sequence: 3, revision: 3 }, identity: digest(next) } : null) as never)
  const handlers = (store.transport as unknown as { handlers: TransportEvents }).handlers
  handlers.onEvent(runtime, { type: 'session/started', session: body })
  expect(await store.verifyTranscriptCache(runtime, id)).toBe(true)
  handlers.onEvent(runtime, { type: 'item/delta', sessionId: id, turnId: turnId('turn'), itemId: itemId('item'), delta: { kind: 'assistantText', text: 'Synthetic new text' } }, { ...watermark, sequence: 3, revision: 3 })
  await vi.waitFor(() => expect(store.getSnapshot().sessions.get(key)?.turns).toEqual(next.turns))
})

it.each(['gap', 'missing', 'epoch', 'generation', 'regression', 'reconnect', 'invalidation'] as const)(
  '%s clears snapshot authority without discarding the loaded body', async (kind) => {
    const runtime = runtimeId('example'), id = sessionId('one'), key = sessionKey(runtime, id)
    const body: Session = { id, runtime, cwd: '/example', status: { type: 'idle' }, createdAt: 0, updatedAt: 0, itemsLoaded: true,
      turns: [{ id: turnId('turn'), status: 'completed', items: [{ id: itemId('item'), type: 'assistantMessage', text: 'start' }] }] }
    const watermark = { epoch: 'epoch', generation: 'generation', revision: 1, sequence: 1 }
    const identity = fixtureHash(canonicalTranscriptBody(body.turns).canonical)
    const store = new AppStore('ws://localhost:0/')
    vi.spyOn(store.transport, 'request').mockImplementation((async (method: string) => method === 'session/cache-snapshot' ? { session: body, watermark, identity } : null) as never)
    const handlers = (store.transport as unknown as { handlers: TransportEvents }).handlers
    handlers.onEvent(runtime, { type: 'session/started', session: body })
    expect(await store.verifyTranscriptCache(runtime, id)).toBe(true)
    if (kind === 'gap' || kind === 'missing' || kind === 'epoch' || kind === 'generation' || kind === 'regression') {
      const fence = kind === 'missing' ? undefined : { ...watermark, sequence: kind === 'gap' ? 3 : 2,
        revision: kind === 'regression' ? 0 : 2, epoch: kind === 'epoch' ? 'other' : watermark.epoch,
        generation: kind === 'generation' ? 'other' : watermark.generation }
      handlers.onEvent(runtime, { type: 'session/title', sessionId: id, title: 'Updated' }, fence)
    } else if (kind === 'reconnect') handlers.onStatus('reconnecting')
    else handlers.onNotification({ method: 'session/cache-invalidated', params: { runtime, sessionId: id, watermark: { ...watermark, sequence: 2, revision: 2 } } })
    expect(store.transcriptCacheVerified(runtime, id)).toBe(false)
    expect(store.getSnapshot().sessions.get(key)?.turns).toEqual(body.turns)
  },
)

it('a later snapshot alone cannot erase an unresolved event gap', async () => {
  const runtime = runtimeId('example'), id = sessionId('one')
  const body: Session = { id, runtime, cwd: '/example', status: { type: 'idle' }, createdAt: 0, updatedAt: 0, itemsLoaded: true, turns: [] }
  const watermark = { epoch: 'epoch', generation: 'generation', revision: 1, sequence: 1 }
  const identity = fixtureHash(canonicalTranscriptBody(body.turns).canonical)
  let latest = body, stamp = watermark
  const store = new AppStore('ws://localhost:0/')
  vi.spyOn(store.transport, 'request').mockImplementation((async () => ({ session: latest, watermark: stamp, identity })) as never)
  const handlers = (store.transport as unknown as { handlers: TransportEvents }).handlers
  handlers.onEvent(runtime, { type: 'session/started', session: body })
  expect(await store.verifyTranscriptCache(runtime, id)).toBe(true)
  handlers.onEvent(runtime, { type: 'session/title', sessionId: id, title: 'Updated' }, { ...watermark, sequence: 3, revision: 3 })
  latest = { ...body, title: 'Updated' }; stamp = { ...watermark, sequence: 3, revision: 3 }
  expect(await store.verifyTranscriptCache(runtime, id)).toBe(false)
})

it.each(['null', 'error'] as const)('keeps an unseen delta protected through a %s snapshot until a covering snapshot arrives', async (failure) => {
  const runtime = runtimeId('example'), id = sessionId('one'), key = sessionKey(runtime, id)
  const body: Session = { id, runtime, cwd: '/example', status: { type: 'idle' }, createdAt: 0, updatedAt: 0, itemsLoaded: true, turns: [] }
  const recovered: Session = { ...body, turns: [{ id: turnId('turn'), status: 'completed', items: [{ id: itemId('item'), type: 'assistantMessage', text: 'Synthetic new text' }] }] }
  const watermark = { epoch: 'epoch', generation: 'generation', revision: 1, sequence: 1 }
  const digest = (session: Session) => fixtureHash(canonicalTranscriptBody(session.turns).canonical)
  let calls = 0
  const store = new AppStore('ws://localhost:0/')
  vi.spyOn(store.transport, 'request').mockImplementation((async (method: string) => {
    if (method !== 'session/cache-snapshot') return null
    calls++
    if (calls === 1) return { session: body, watermark, identity: digest(body) }
    if (calls === 2) { if (failure === 'error') throw new Error('Synthetic unavailable snapshot'); return null }
    return { session: recovered, watermark: { ...watermark, sequence: 4, revision: 4 }, identity: digest(recovered) }
  }) as never)
  const handlers = (store.transport as unknown as { handlers: TransportEvents }).handlers
  handlers.onEvent(runtime, { type: 'session/started', session: body })
  expect(await store.verifyTranscriptCache(runtime, id)).toBe(true)
  handlers.onEvent(runtime, { type: 'item/delta', sessionId: id, turnId: turnId('turn'), itemId: itemId('item'), delta: { kind: 'assistantText', text: 'Synthetic new text' } }, { ...watermark, sequence: 3, revision: 3 })
  await vi.waitFor(() => expect(calls).toBe(2))
  expect(store.getSnapshot().sessions.get(key)?.turns).toEqual([])
  expect(store.transcriptCacheVerified(runtime, id)).toBe(false)
  handlers.onEvent(runtime, { type: 'session/status', sessionId: id, status: { type: 'idle' } }, { ...watermark, sequence: 4, revision: 4 })
  await vi.waitFor(() => expect(store.getSnapshot().sessions.get(key)?.turns).toEqual(recovered.turns))
  expect(store.getSnapshot().sessions.get(key)?.turns[0]?.items).toHaveLength(1)
})

it('does not adopt a gap snapshot overtaken by another event while its response is pending', async () => {
  const runtime = runtimeId('example'), id = sessionId('one'), key = sessionKey(runtime, id)
  const body: Session = { id, runtime, cwd: '/example', status: { type: 'idle' }, createdAt: 0, updatedAt: 0, itemsLoaded: true, turns: [] }
  const complete: Session = { ...body, turns: [{ id: turnId('turn'), status: 'completed', items: [{ id: itemId('item'), type: 'assistantMessage', text: 'Synthetic first and second' }] }] }
  const old: Session = { ...body, turns: [{ id: turnId('turn'), status: 'completed', items: [{ id: itemId('item'), type: 'assistantMessage', text: 'Synthetic first' }] }] }
  const watermark = { epoch: 'epoch', generation: 'generation', revision: 1, sequence: 1 }
  const response = (session: Session, sequence: number) => ({ session, watermark: { ...watermark, sequence, revision: sequence }, identity: fixtureHash(canonicalTranscriptBody(session.turns).canonical) })
  let release!: (value: unknown) => void
  const held = new Promise(resolve => { release = resolve })
  let calls = 0
  const store = new AppStore('ws://localhost:0/')
  vi.spyOn(store.transport, 'request').mockImplementation((async (method: string) => {
    if (method !== 'session/cache-snapshot') return null
    calls++
    return calls === 1 ? response(body, 1) : calls === 2 ? held : response(complete, 4)
  }) as never)
  const handlers = (store.transport as unknown as { handlers: TransportEvents }).handlers
  handlers.onEvent(runtime, { type: 'session/started', session: body })
  expect(await store.verifyTranscriptCache(runtime, id)).toBe(true)
  const emit = (text: string, sequence: number) => handlers.onEvent(runtime, { type: 'item/delta', sessionId: id, turnId: turnId('turn'), itemId: itemId('item'), delta: { kind: 'assistantText', text } }, { ...watermark, sequence, revision: sequence })
  emit('Synthetic first', 3)
  await vi.waitFor(() => expect(calls).toBe(2))
  emit(' and second', 4)
  release(response(old, 3))
  await vi.waitFor(() => expect(store.getSnapshot().sessions.get(key)?.turns).toEqual(complete.turns))
  expect(calls).toBe(3)
})

it('keeps the managed cursor when a contiguous event makes the session active before a later gap', async () => {
  const runtime = runtimeId('example'), id = sessionId('one'), key = sessionKey(runtime, id)
  const body: Session = { id, runtime, cwd: '/example', status: { type: 'idle' }, createdAt: 0, updatedAt: 0, itemsLoaded: true, turns: [] }
  const active: Session = { ...body, status: { type: 'active' } }
  const recovered: Session = { ...active, turns: [{ id: turnId('turn'), status: 'inProgress', items: [{ id: itemId('item'), type: 'assistantMessage', text: 'Synthetic active text' }] }] }
  const watermark = { epoch: 'epoch', generation: 'generation', revision: 1, sequence: 1 }
  const digest = (session: Session) => fixtureHash(canonicalTranscriptBody(session.turns).canonical)
  let calls = 0
  const store = new AppStore('ws://localhost:0/')
  vi.spyOn(store.transport, 'request').mockImplementation((async (method: string) => {
    if (method !== 'session/cache-snapshot') return null
    calls++
    return calls === 1 ? { session: body, watermark, identity: digest(body) } : { session: recovered, watermark: { ...watermark, sequence: 4, revision: 4 }, identity: digest(recovered) }
  }) as never)
  const handlers = (store.transport as unknown as { handlers: TransportEvents }).handlers
  handlers.onEvent(runtime, { type: 'session/started', session: body })
  expect(await store.verifyTranscriptCache(runtime, id)).toBe(true)
  handlers.onEvent(runtime, { type: 'session/status', sessionId: id, status: { type: 'active' } }, { ...watermark, sequence: 2, revision: 2 })
  handlers.onEvent(runtime, { type: 'item/delta', sessionId: id, turnId: turnId('turn'), itemId: itemId('item'), delta: { kind: 'assistantText', text: 'Synthetic active text' } }, { ...watermark, sequence: 4, revision: 4 })
  await vi.waitFor(() => expect(store.getSnapshot().sessions.get(key)?.turns).toEqual(recovered.turns))
})

it.each(['old', 'wrong-key', 'wrong-identity'] as const)('keeps unseen data protected when the recovery snapshot has %s', async (failure) => {
  const runtime = runtimeId('example'), id = sessionId('one'), key = sessionKey(runtime, id)
  const body: Session = { id, runtime, cwd: '/example', status: { type: 'idle' }, createdAt: 0, updatedAt: 0, itemsLoaded: true, turns: [] }
  const recovered: Session = { ...body, turns: [{ id: turnId('turn'), status: 'completed', items: [{ id: itemId('item'), type: 'assistantMessage', text: 'Synthetic pending text' }] }] }
  const watermark = { epoch: 'epoch', generation: 'generation', revision: 1, sequence: 1 }
  const digest = (session: Session) => fixtureHash(canonicalTranscriptBody(session.turns).canonical)
  let calls = 0
  const store = new AppStore('ws://localhost:0/')
  vi.spyOn(store.transport, 'request').mockImplementation((async (method: string) => {
    if (method !== 'session/cache-snapshot') return null
    if (++calls === 1) return { session: body, watermark, identity: digest(body) }
    return { session: failure === 'wrong-key' ? { ...recovered, id: sessionId('other') } : recovered,
      watermark: { ...watermark, sequence: failure === 'old' ? 2 : 3, revision: failure === 'old' ? 2 : 3 },
      identity: failure === 'wrong-identity' ? '0'.repeat(64) : digest(recovered) }
  }) as never)
  const handlers = (store.transport as unknown as { handlers: TransportEvents }).handlers
  handlers.onEvent(runtime, { type: 'session/started', session: body })
  expect(await store.verifyTranscriptCache(runtime, id)).toBe(true)
  handlers.onEvent(runtime, { type: 'item/delta', sessionId: id, turnId: turnId('turn'), itemId: itemId('item'), delta: { kind: 'assistantText', text: 'Synthetic pending text' } }, { ...watermark, sequence: 3, revision: 3 })
  await vi.waitFor(() => expect(calls).toBe(2))
  await Promise.resolve()
  expect(store.getSnapshot().sessions.get(key)?.turns).toEqual([])
  expect(store.transcriptCacheVerified(runtime, id)).toBe(false)
})

it('does not fold a duplicate or conflicting pending cursor twice after a gap', async () => {
  const runtime = runtimeId('example'), id = sessionId('one'), key = sessionKey(runtime, id)
  const body: Session = { id, runtime, cwd: '/example', status: { type: 'idle' }, createdAt: 0, updatedAt: 0, itemsLoaded: true,
    turns: [{ id: turnId('turn'), status: 'completed', items: [{ id: itemId('item'), type: 'assistantMessage', text: 'base' }] }] }
  const watermark = { epoch: 'epoch', generation: 'generation', revision: 1, sequence: 1 }
  const identity = fixtureHash(canonicalTranscriptBody(body.turns).canonical)
  const store = new AppStore('ws://localhost:0/')
  vi.spyOn(store.transport, 'request').mockImplementation((async () => ({ session: body, watermark, identity })) as never)
  const handlers = (store.transport as unknown as { handlers: TransportEvents }).handlers
  handlers.onEvent(runtime, { type: 'session/started', session: body })
  expect(await store.verifyTranscriptCache(runtime, id)).toBe(true)
  const fence = { ...watermark, sequence: 3, revision: 3 }
  const event = { type: 'item/delta' as const, sessionId: id, turnId: turnId('turn'), itemId: itemId('item'), delta: { kind: 'assistantText' as const, text: ' one' } }
  handlers.onEvent(runtime, event, fence)
  handlers.onEvent(runtime, event, fence)
  handlers.onEvent(runtime, { ...event, delta: { kind: 'assistantText', text: ' conflict' } }, fence)
  expect(store.getSnapshot().sessions.get(key)?.turns[0]?.items[0]).toMatchObject({ text: 'base one' })
  expect(store.transcriptCacheVerified(runtime, id)).toBe(false)
})

it('keeps the held transcript visible when sync replaces a session with unresolved pending data', async () => {
  const runtime = runtimeId('example'), id = sessionId('one'), key = sessionKey(runtime, id)
  const body: Session = { id, runtime, cwd: '/example', status: { type: 'idle' }, createdAt: 0, updatedAt: 0, itemsLoaded: true,
    turns: [{ id: turnId('turn'), status: 'completed', items: [{ id: itemId('item'), type: 'assistantMessage', text: 'Synthetic held text' }] }] }
  const watermark = { epoch: 'epoch', generation: 'generation', revision: 1, sequence: 1 }
  const identity = fixtureHash(canonicalTranscriptBody(body.turns).canonical)
  const store = new AppStore('ws://localhost:0/')
  vi.spyOn(store.transport, 'request').mockImplementation((async () => ({ session: body, watermark, identity })) as never)
  const handlers = (store.transport as unknown as { handlers: TransportEvents }).handlers
  handlers.onEvent(runtime, { type: 'session/started', session: body })
  expect(await store.verifyTranscriptCache(runtime, id)).toBe(true)
  handlers.onEvent(runtime, { type: 'item/delta', sessionId: id, turnId: turnId('turn'), itemId: itemId('item'), delta: { kind: 'assistantText', text: ' plus pending' } }, { ...watermark, sequence: 3, revision: 3 })
  handlers.onNotification({ method: 'sync', params: { sessions: [{ ...body, turns: [] }], runtimes: [] } } as never)
  expect(store.getSnapshot().sessions.get(key)?.turns[0]?.items[0]).toMatchObject({ text: 'Synthetic held text plus pending' })
  expect(store.transcriptCacheVerified(runtime, id)).toBe(false)
})

it('does not apply an old recovery response to a removed and recreated session', async () => {
  const runtime = runtimeId('example'), id = sessionId('one'), key = sessionKey(runtime, id)
  const body: Session = { id, runtime, cwd: '/example', status: { type: 'idle' }, createdAt: 0, updatedAt: 0, itemsLoaded: true, turns: [] }
  const old: Session = { ...body, turns: [{ id: turnId('turn'), status: 'completed', items: [{ id: itemId('item'), type: 'assistantMessage', text: 'Synthetic old owner' }] }] }
  const replacement: Session = { ...body }
  const watermark = { epoch: 'epoch', generation: 'generation', revision: 1, sequence: 1 }
  const response = (session: Session, sequence: number) => ({ session, watermark: { ...watermark, sequence, revision: sequence }, identity: fixtureHash(canonicalTranscriptBody(session.turns).canonical) })
  let release!: (value: unknown) => void
  const held = new Promise(resolve => { release = resolve })
  let calls = 0
  const store = new AppStore('ws://localhost:0/')
  vi.spyOn(store.transport, 'request').mockImplementation((async () => ++calls === 1 ? response(body, 1) : held) as never)
  const handlers = (store.transport as unknown as { handlers: TransportEvents }).handlers
  handlers.onEvent(runtime, { type: 'session/started', session: body })
  expect(await store.verifyTranscriptCache(runtime, id)).toBe(true)
  handlers.onEvent(runtime, { type: 'item/delta', sessionId: id, turnId: turnId('turn'), itemId: itemId('item'), delta: { kind: 'assistantText', text: 'Synthetic old owner' } }, { ...watermark, sequence: 3, revision: 3 })
  await vi.waitFor(() => expect(calls).toBe(2))
  handlers.onNotification({ method: 'session/removed', params: { runtime, sessionId: id, deleted: false } })
  handlers.onEvent(runtime, { type: 'session/started', session: replacement })
  release(response(old, 3))
  await Promise.resolve(); await Promise.resolve()
  expect(store.getSnapshot().sessions.get(key)?.id).toBe(id)
  expect(store.getSnapshot().sessions.get(key)?.turns).toEqual([])
})

it('does not adopt a recovery snapshot after a transcript owner enters and leaves while it is pending', async () => {
  const runtime = runtimeId('example'), id = sessionId('one'), key = sessionKey(runtime, id)
  const body: Session = { id, runtime, cwd: '/example', status: { type: 'idle' }, createdAt: 0, updatedAt: 0, itemsLoaded: true, turns: [] }
  const recovered: Session = { ...body, turns: [{ id: turnId('turn'), status: 'completed', items: [{ id: itemId('item'), type: 'assistantMessage', text: 'Synthetic pending' }] }] }
  const watermark = { epoch: 'epoch', generation: 'generation', revision: 1, sequence: 1 }
  const response = (session: Session, sequence: number) => ({ session, watermark: { ...watermark, sequence, revision: sequence }, identity: fixtureHash(canonicalTranscriptBody(session.turns).canonical) })
  let release!: (value: unknown) => void
  const held = new Promise(resolve => { release = resolve })
  let calls = 0
  const store = new AppStore('ws://localhost:0/')
  vi.spyOn(store.transport, 'request').mockImplementation((async () => ++calls === 1 ? response(body, 1) : held) as never)
  const handlers = (store.transport as unknown as { handlers: TransportEvents }).handlers
  handlers.onEvent(runtime, { type: 'session/started', session: body })
  expect(await store.verifyTranscriptCache(runtime, id)).toBe(true)
  handlers.onEvent(runtime, { type: 'item/delta', sessionId: id, turnId: turnId('turn'), itemId: itemId('item'), delta: { kind: 'assistantText', text: 'Synthetic pending' } }, { ...watermark, sequence: 3, revision: 3 })
  await vi.waitFor(() => expect(calls).toBe(2))
  const leave = store.retainTranscript(runtime, id); leave()
  release(response(recovered, 3))
  await Promise.resolve(); await Promise.resolve()
  expect(store.getSnapshot().sessions.get(key)?.turns).toEqual([])
  expect(store.transcriptCacheVerified(runtime, id)).toBe(false)
})

it('explicitly unloads only after a closed receipt and restores the exact body by cache snapshot', async () => {
  const runtime = runtimeId('example'), id = sessionId('one'), key = sessionKey(runtime, id)
  const body: Session = { id, runtime, cwd: '/example', title: 'Synthetic title', status: { type: 'idle' }, createdAt: 0, updatedAt: 0, itemsLoaded: true,
    turns: [{ id: turnId('turn'), status: 'completed', items: [{ id: itemId('item'), type: 'assistantMessage', text: 'Synthetic saved text' }] }] }
  const watermark = { epoch: 'epoch', generation: 'generation', revision: 1, sequence: 1 }
  const identity = fixtureHash(canonicalTranscriptBody(body.turns).canonical)
  const store = new AppStore('ws://localhost:0/')
  const request = vi.spyOn(store.transport, 'request').mockImplementation((async (method: string) => method === 'session/cache-snapshot' ? { session: body, watermark, identity } : method === 'session/prepare-eviction' ? { ...watermark, identity } : null) as never)
  const handlers = (store.transport as unknown as { handlers: TransportEvents }).handlers
  handlers.onEvent(runtime, { type: 'session/started', session: body })
  const cache = store as unknown as { unloadTranscript(r: typeof runtime, i: typeof id): Promise<boolean>; restoreTranscript(r: typeof runtime, i: typeof id): Promise<boolean> }
  expect(await cache.unloadTranscript(runtime, id)).toBe(true)
  expect(store.getSnapshot().sessions.get(key)).toMatchObject({ title: 'Synthetic title', itemsLoaded: false, turns: [] })
  expect(await cache.restoreTranscript(runtime, id)).toBe(true)
  expect(store.getSnapshot().sessions.get(key)?.turns).toEqual(body.turns)
  expect(request.mock.calls.some(([method]) => method === 'session/read' || method === 'session/resume')).toBe(false)
})

it('never unloads when the Host receipt has no sequence even if the session is idle', async () => {
  const runtime = runtimeId('example'), id = sessionId('one'), key = sessionKey(runtime, id)
  const body: Session = { id, runtime, cwd: '/example', status: { type: 'idle' }, createdAt: 0, updatedAt: 0, itemsLoaded: true,
    turns: [{ id: turnId('turn'), status: 'completed', items: [{ id: itemId('item'), type: 'assistantMessage', text: 'Synthetic saved text' }] }] }
  const watermark = { epoch: 'epoch', generation: 'generation', revision: 1, sequence: 1 }
  const identity = fixtureHash(canonicalTranscriptBody(body.turns).canonical)
  const store = new AppStore('ws://localhost:0/')
  vi.spyOn(store.transport, 'request').mockImplementation((async (method: string) => method === 'session/cache-snapshot' ? { session: body, watermark, identity } : method === 'session/prepare-eviction' ? { epoch: watermark.epoch, generation: watermark.generation, revision: watermark.revision, identity } : null) as never)
  ;(store.transport as unknown as { handlers: TransportEvents }).handlers.onEvent(runtime, { type: 'session/started', session: body })
  const cache = store as unknown as { unloadTranscript(r: typeof runtime, i: typeof id): Promise<boolean> }
  expect(await cache.unloadTranscript(runtime, id)).toBe(false)
  expect(store.getSnapshot().sessions.get(key)?.turns).toEqual(body.turns)
})

it('does not read or resume an unloaded session when its cache snapshot is unavailable', async () => {
  const runtime = runtimeId('example'), id = sessionId('one'), key = sessionKey(runtime, id)
  const body: Session = { id, runtime, cwd: '/example', status: { type: 'idle' }, createdAt: 0, updatedAt: 0, itemsLoaded: true,
    turns: [{ id: turnId('turn'), status: 'completed', items: [{ id: itemId('item'), type: 'assistantMessage', text: 'Synthetic saved text' }] }] }
  const watermark = { epoch: 'epoch', generation: 'generation', revision: 1, sequence: 1 }
  const identity = fixtureHash(canonicalTranscriptBody(body.turns).canonical)
  let snapshots = 0
  const store = new AppStore('ws://localhost:0/')
  const request = vi.spyOn(store.transport, 'request').mockImplementation((async (method: string) => method === 'session/cache-snapshot' ? ++snapshots === 1 ? { session: body, watermark, identity } : null : method === 'session/prepare-eviction' ? { ...watermark, identity } : null) as never)
  ;(store.transport as unknown as { handlers: TransportEvents }).handlers.onEvent(runtime, { type: 'session/started', session: body })
  const cache = store as unknown as { unloadTranscript(r: typeof runtime, i: typeof id): Promise<boolean> }
  expect(await cache.unloadTranscript(runtime, id)).toBe(true)
  expect(await store.openSession(id, { runtime, reveal: false })).toBe(false)
  expect(request.mock.calls.some(([method]) => method === 'session/read' || method === 'session/resume')).toBe(false)
  expect(store.getSnapshot().sessions.get(key)).toMatchObject({ itemsLoaded: false, turns: [] })
})

it('does not fold a late event into an unloaded body or adopt an overtaken restore response', async () => {
  const runtime = runtimeId('example'), id = sessionId('one'), key = sessionKey(runtime, id)
  const body: Session = { id, runtime, cwd: '/example', status: { type: 'idle' }, createdAt: 0, updatedAt: 0, itemsLoaded: true,
    turns: [{ id: turnId('turn'), status: 'completed', items: [{ id: itemId('item'), type: 'assistantMessage', text: 'Synthetic saved text' }] }] }
  const watermark = { epoch: 'epoch', generation: 'generation', revision: 1, sequence: 1 }
  const identity = fixtureHash(canonicalTranscriptBody(body.turns).canonical)
  let snapshots = 0, release!: (value: unknown) => void
  const held = new Promise(resolve => { release = resolve })
  const store = new AppStore('ws://localhost:0/')
  vi.spyOn(store.transport, 'request').mockImplementation((async (method: string) => method === 'session/cache-snapshot' ? ++snapshots === 1 ? { session: body, watermark, identity } : held : method === 'session/prepare-eviction' ? { ...watermark, identity } : null) as never)
  const handlers = (store.transport as unknown as { handlers: TransportEvents }).handlers
  handlers.onEvent(runtime, { type: 'session/started', session: body })
  const cache = store as unknown as { unloadTranscript(r: typeof runtime, i: typeof id): Promise<boolean>; restoreTranscript(r: typeof runtime, i: typeof id): Promise<boolean> }
  expect(await cache.unloadTranscript(runtime, id)).toBe(true)
  const restoring = cache.restoreTranscript(runtime, id)
  handlers.onEvent(runtime, { type: 'item/delta', sessionId: id, turnId: turnId('turn'), itemId: itemId('item'), delta: { kind: 'assistantText', text: ' and late text' } }, { ...watermark, revision: 2, sequence: 2 })
  release({ session: body, watermark, identity })
  expect(await restoring).toBe(false)
  expect(store.getSnapshot().sessions.get(key)).toMatchObject({ itemsLoaded: false, turns: [] })
})

it('restores a released body from a newer covering snapshot after a sequenced assistant event', async () => {
  const runtime = runtimeId('example'), id = sessionId('one'), key = sessionKey(runtime, id)
  const body: Session = { id, runtime, cwd: '/example', status: { type: 'idle' }, createdAt: 0, updatedAt: 0, itemsLoaded: true,
    turns: [{ id: turnId('turn'), status: 'completed', items: [{ id: itemId('item'), type: 'assistantMessage', text: 'Synthetic saved text' }] }] }
  const newer: Session = { ...body, updatedAt: 2, status: { type: 'active' }, turns: [{ ...body.turns[0]!, items: [{ id: itemId('item'), type: 'assistantMessage', text: 'Synthetic saved text and late text' }] }] }
  const watermark = { epoch: 'epoch', generation: 'generation', revision: 1, sequence: 1 }
  const digest = (session: Session) => fixtureHash(canonicalTranscriptBody(session.turns).canonical)
  let snapshots = 0
  const store = new AppStore('ws://localhost:0/')
  vi.spyOn(store.transport, 'request').mockImplementation((async (method: string) => method === 'session/cache-snapshot' ? ++snapshots === 1 ? { session: body, watermark, identity: digest(body) } : { session: newer, watermark: { ...watermark, revision: 2, sequence: 2 }, identity: digest(newer) } : method === 'session/prepare-eviction' ? { ...watermark, identity: digest(body) } : null) as never)
  const handlers = (store.transport as unknown as { handlers: TransportEvents }).handlers
  handlers.onEvent(runtime, { type: 'session/started', session: body })
  const cache = store as unknown as { unloadTranscript(r: typeof runtime, i: typeof id): Promise<boolean> }
  expect(await cache.unloadTranscript(runtime, id)).toBe(true)
  handlers.onEvent(runtime, { type: 'item/delta', sessionId: id, turnId: turnId('turn'), itemId: itemId('item'), delta: { kind: 'assistantText', text: ' and late text' } }, { ...watermark, revision: 2, sequence: 2 })
  await vi.waitFor(() => expect(store.getSnapshot().sessions.get(key)?.turns).toEqual(newer.turns))
  expect(store.getSnapshot().sessions.get(key)).toMatchObject({ updatedAt: 2, status: { type: 'active' } })
  expect(snapshots).toBe(2)
})

it.each(['null', 'old', 'wrong-identity', 'missing-delta', 'other-generation'] as const)('keeps a released body protected when a late-event snapshot is %s', async (failure) => {
  const runtime = runtimeId('example'), id = sessionId('one'), key = sessionKey(runtime, id)
  const body: Session = { id, runtime, cwd: '/example', status: { type: 'idle' }, createdAt: 0, updatedAt: 0, itemsLoaded: true,
    turns: [{ id: turnId('turn'), status: 'completed', items: [{ id: itemId('item'), type: 'assistantMessage', text: 'Synthetic saved text' }] }] }
  const newer: Session = { ...body, turns: [{ ...body.turns[0]!, items: [{ id: itemId('item'), type: 'assistantMessage', text: 'Synthetic saved text and late text' }] }] }
  const watermark = { epoch: 'epoch', generation: 'generation', revision: 1, sequence: 1 }
  const digest = (session: Session) => fixtureHash(canonicalTranscriptBody(session.turns).canonical)
  let snapshots = 0
  const store = new AppStore('ws://localhost:0/')
  vi.spyOn(store.transport, 'request').mockImplementation((async (method: string) => {
    if (method === 'session/prepare-eviction') return { ...watermark, identity: digest(body) }
    if (method !== 'session/cache-snapshot') return null
    if (++snapshots === 1) return { session: body, watermark, identity: digest(body) }
    if (failure === 'null') return null
    const session = failure === 'missing-delta' ? body : newer
    return { session, watermark: { ...watermark, generation: failure === 'other-generation' ? 'other' : watermark.generation, sequence: failure === 'old' ? 1 : 2, revision: failure === 'old' ? 1 : 2 }, identity: failure === 'wrong-identity' ? '0'.repeat(64) : digest(session) }
  }) as never)
  const handlers = (store.transport as unknown as { handlers: TransportEvents }).handlers
  handlers.onEvent(runtime, { type: 'session/started', session: body })
  const cache = store as unknown as { unloadTranscript(r: typeof runtime, i: typeof id): Promise<boolean> }
  expect(await cache.unloadTranscript(runtime, id)).toBe(true)
  handlers.onEvent(runtime, { type: 'item/delta', sessionId: id, turnId: turnId('turn'), itemId: itemId('item'), delta: { kind: 'assistantText', text: ' and late text' } }, { ...watermark, revision: 2, sequence: 2 })
  await vi.waitFor(() => expect(snapshots).toBe(2))
  await Promise.resolve()
  expect(store.getSnapshot().sessions.get(key)).toMatchObject({ itemsLoaded: false, turns: [] })
  expect(store.transcriptCacheVerified(runtime, id)).toBe(false)
})

it.each(['missing-fence', 'conflict', 'reconnect'] as const)('keeps an unloaded body protected after %s', async (kind) => {
  const runtime = runtimeId('example'), id = sessionId('one'), key = sessionKey(runtime, id)
  const body: Session = { id, runtime, cwd: '/example', status: { type: 'idle' }, createdAt: 0, updatedAt: 0, itemsLoaded: true,
    turns: [{ id: turnId('turn'), status: 'completed', items: [{ id: itemId('item'), type: 'assistantMessage', text: 'Synthetic saved' }] }] }
  const newer: Session = { ...body, turns: [{ ...body.turns[0]!, items: [{ id: itemId('item'), type: 'assistantMessage', text: 'Synthetic saved late' }] }] }
  const watermark = { epoch: 'epoch', generation: 'generation', revision: 1, sequence: 1 }
  const digest = (session: Session) => fixtureHash(canonicalTranscriptBody(session.turns).canonical)
  let snapshots = 0, release!: (value: unknown) => void
  const held = new Promise(resolve => { release = resolve })
  const store = new AppStore('ws://localhost:0/')
  vi.spyOn(store.transport, 'request').mockImplementation((async (method: string) => method === 'session/cache-snapshot' ? ++snapshots === 1 ? { session: body, watermark, identity: digest(body) } : held : method === 'session/prepare-eviction' ? { ...watermark, identity: digest(body) } : null) as never)
  const handlers = (store.transport as unknown as { handlers: TransportEvents }).handlers
  handlers.onEvent(runtime, { type: 'session/started', session: body })
  const cache = store as unknown as { unloadTranscript(r: typeof runtime, i: typeof id): Promise<boolean> }
  expect(await cache.unloadTranscript(runtime, id)).toBe(true)
  const event = { type: 'item/delta' as const, sessionId: id, turnId: turnId('turn'), itemId: itemId('item'), delta: { kind: 'assistantText' as const, text: ' late' } }
  const fence = { ...watermark, sequence: 2, revision: 2 }
  handlers.onEvent(runtime, event, kind === 'missing-fence' ? undefined : fence)
  if (kind === 'conflict') handlers.onEvent(runtime, { ...event, delta: { kind: 'assistantText', text: ' conflict' } }, fence)
  if (kind === 'reconnect') handlers.onStatus('reconnecting')
  release({ session: newer, watermark: fence, identity: digest(newer) })
  await Promise.resolve(); await Promise.resolve()
  expect(store.getSnapshot().sessions.get(key)).toMatchObject({ itemsLoaded: false, turns: [] })
  expect(store.transcriptCacheVerified(runtime, id)).toBe(false)
})

it('runs default pressure after a real pane close and unloads the oldest confirmed closed body', async () => {
  const runtime = runtimeId('example'), watermark = { epoch: 'epoch', generation: 'generation', revision: 1, sequence: 1 }
  const body = (id: ReturnType<typeof sessionId>): Session => ({ id, runtime, cwd: '/example', status: { type: 'idle' }, createdAt: 0, updatedAt: 0, itemsLoaded: true, turns: [] })
  const identity = fixtureHash(canonicalTranscriptBody([]).canonical)
  const store = new AppStore('ws://localhost:0/')
  let closed = false
  const request = vi.spyOn(store.transport, 'request').mockImplementation((async (method: string, params: { sessionId: ReturnType<typeof sessionId> }) => {
    if (method === 'session/read' || method === 'session/resume') return body(params.sessionId)
    if (method === 'session/cache-snapshot') return { session: store.getSnapshot().sessions.get(sessionKey(runtime, params.sessionId)), watermark, identity }
    if (method === 'session/close') { closed = true; return null }
    if (method === 'session/prepare-eviction') return params.sessionId === sessionId('pressure-128') && !closed ? null : { ...watermark, identity }
    return null
  }) as never)
  const handlers = (store.transport as unknown as { handlers: TransportEvents }).handlers
  for (let i = 0; i < 129; i++) handlers.onEvent(runtime, { type: 'session/started', session: body(sessionId(`pressure-${i}`)) })
  const opened = sessionId('pressure-128')
  expect(await store.openSession(opened, { runtime })).toBe(true)
  expect(store.transcriptCacheStats().enabled).toBe(true)
  store.closePane(store.getSnapshot().layout.focused)
  await vi.waitFor(() => { const unloaded = [...store.getSnapshot().sessions.values()].filter(session => !session.itemsLoaded).length; const snapshots = request.mock.calls.filter(([method]) => method === 'session/cache-snapshot').length; const receipts = request.mock.calls.filter(([method]) => method === 'session/prepare-eviction').length; expect({ unloaded, snapshots, receipts }).toMatchObject({ unloaded: 1 }) }, { timeout: 3000 })
  expect(request.mock.calls.some(([method]) => method === 'session/close')).toBe(true)
  expect([...store.getSnapshot().sessions.values()].filter(session => !session.itemsLoaded)).toHaveLength(1)
})

it('restores an unloaded session before a queued person operation', async () => {
  const runtime = runtimeId('example'), id = sessionId('one'), key = sessionKey(runtime, id)
  const body: Session = { id, runtime, cwd: '/example', status: { type: 'idle' }, createdAt: 0, updatedAt: 0, itemsLoaded: true,
    turns: [{ id: turnId('turn'), status: 'completed', items: [{ id: itemId('item'), type: 'assistantMessage', text: 'Synthetic saved' }] }] }
  const watermark = { epoch: 'epoch', generation: 'generation', revision: 1, sequence: 1 }
  const identity = fixtureHash(canonicalTranscriptBody(body.turns).canonical)
  const store = new AppStore('ws://localhost:0/')
  const request = vi.spyOn(store.transport, 'request').mockImplementation((async (method: string) => method === 'session/cache-snapshot' ? { session: body, watermark, identity } : method === 'session/prepare-eviction' ? { ...watermark, identity } : null) as never)
  ;(store.transport as unknown as { handlers: TransportEvents }).handlers.onEvent(runtime, { type: 'session/started', session: body })
  expect(await store.unloadTranscript(runtime, id)).toBe(true)
  await store.send([{ type: 'text', text: 'Synthetic question' }], key)
  expect(store.getSnapshot().sessions.get(key)?.turns).toEqual(body.turns)
  expect(request.mock.calls.findIndex(([method]) => method === 'turn/send')).toBeGreaterThan(request.mock.calls.map(([method]) => method).lastIndexOf('session/cache-snapshot'))
})

it('restores a released conversation exposed through the workbench without a direct openSession call', async () => {
  const runtime = runtimeId('example'), id = sessionId('one'), key = sessionKey(runtime, id)
  const body: Session = { id, runtime, cwd: '/example', status: { type: 'idle' }, createdAt: 0, updatedAt: 0, itemsLoaded: true,
    turns: [{ id: turnId('turn'), status: 'completed', items: [{ id: itemId('item'), type: 'assistantMessage', text: 'Synthetic saved' }] }] }
  const watermark = { epoch: 'epoch', generation: 'generation', revision: 1, sequence: 1 }
  const identity = fixtureHash(canonicalTranscriptBody(body.turns).canonical)
  const store = new AppStore('ws://localhost:0/')
  const request = vi.spyOn(store.transport, 'request').mockImplementation((async (method: string) => method === 'session/cache-snapshot' ? { session: body, watermark, identity } : method === 'session/prepare-eviction' ? { ...watermark, identity } : null) as never)
  ;(store.transport as unknown as { handlers: TransportEvents }).handlers.onEvent(runtime, { type: 'session/started', session: body })
  expect(await store.unloadTranscript(runtime, id)).toBe(true)
  expect(store.selectWork({ kind: 'conversation', session: key })).toBe(true)
  expect(store.getSnapshot().activeSessionKey).toBe(key)
  await vi.waitFor(() => expect(store.getSnapshot().sessions.get(key)?.turns).toEqual(body.turns))
  expect(request.mock.calls.some(([method]) => method === 'session/read' || method === 'session/resume')).toBe(false)
})

it('opens a released conversation without competing visibility and read restorations', async () => {
  const runtime = runtimeId('example'), id = sessionId('one'), key = sessionKey(runtime, id)
  const body: Session = { id, runtime, cwd: '/example', status: { type: 'idle' }, createdAt: 0, updatedAt: 0, itemsLoaded: true,
    turns: [{ id: turnId('turn'), status: 'completed', items: [{ id: itemId('item'), type: 'assistantMessage', text: 'Synthetic saved' }] }] }
  const watermark = { epoch: 'epoch', generation: 'generation', revision: 1, sequence: 1 }
  const identity = fixtureHash(canonicalTranscriptBody(body.turns).canonical)
  const store = new AppStore('ws://localhost:0/')
  const request = vi.spyOn(store.transport, 'request').mockImplementation((async (method: string) => method === 'session/cache-snapshot' ? { session: body, watermark, identity } : method === 'session/prepare-eviction' ? { ...watermark, identity } : method === 'session/read' || method === 'session/resume' ? body : null) as never)
  ;(store.transport as unknown as { handlers: TransportEvents }).handlers.onEvent(runtime, { type: 'session/started', session: body })
  expect(await store.unloadTranscript(runtime, id)).toBe(true)
  expect(await store.openSession(id, { runtime })).toBe(true)
  expect(store.getSnapshot().sessions.get(key)?.turns).toEqual(body.turns)
  expect(request.mock.calls.filter(([method]) => method === 'session/cache-snapshot')).toHaveLength(2)
})

it('exposes only scalar body counts while leaving eligibility and bytes unknown', async () => {
  const runtime = runtimeId('example'), id = sessionId('one')
  const body: Session = { id, runtime, cwd: '/example', status: { type: 'idle' }, createdAt: 0, updatedAt: 0, itemsLoaded: true,
    turns: [{ id: turnId('turn'), status: 'completed', items: [{ id: itemId('item'), type: 'assistantMessage', text: 'Synthetic saved' }] }] }
  const watermark = { epoch: 'epoch', generation: 'generation', revision: 1, sequence: 1 }
  const identity = fixtureHash(canonicalTranscriptBody(body.turns).canonical)
  const store = new AppStore('ws://localhost:0/')
  vi.spyOn(store.transport, 'request').mockImplementation((async (method: string) => method === 'session/cache-snapshot' ? { session: body, watermark, identity } : method === 'session/prepare-eviction' ? { ...watermark, identity } : null) as never)
  await store.disableTranscriptCache()
  ;(store.transport as unknown as { handlers: TransportEvents }).handlers.onEvent(runtime, { type: 'session/started', session: body })
  expect(store.transcriptCacheStats()).toEqual({ loadedFullBodies: 1, releasedBodies: 0, trackedRecoveryRecords: 0, enabled: false, pressureRunning: false, pressureDirty: false, eligibleBodies: null, eligibleBytes: null })
  expect(await store.unloadTranscript(runtime, id)).toBe(true)
  expect(store.transcriptCacheStats()).toEqual({ loadedFullBodies: 0, releasedBodies: 1, trackedRecoveryRecords: 0, enabled: false, pressureRunning: false, pressureDirty: false, eligibleBodies: null, eligibleBytes: null })
})

it('restores an unchanged released body with a fresh exact snapshot after reconnect', async () => {
  const runtime = runtimeId('example'), id = sessionId('one'), key = sessionKey(runtime, id)
  const body: Session = { id, runtime, cwd: '/example', status: { type: 'idle' }, createdAt: 0, updatedAt: 0, itemsLoaded: true,
    turns: [{ id: turnId('turn'), status: 'completed', items: [{ id: itemId('item'), type: 'assistantMessage', text: 'Synthetic saved' }] }] }
  const watermark = { epoch: 'epoch', generation: 'generation', revision: 1, sequence: 1 }
  const identity = fixtureHash(canonicalTranscriptBody(body.turns).canonical)
  const store = new AppStore('ws://localhost:0/')
  let snapshotWatermark = watermark
  vi.spyOn(store.transport, 'request').mockImplementation((async (method: string) => method === 'session/cache-snapshot' ? { session: body, watermark: snapshotWatermark, identity } : method === 'session/prepare-eviction' ? { ...watermark, identity } : null) as never)
  const handlers = (store.transport as unknown as { handlers: TransportEvents }).handlers
  handlers.onEvent(runtime, { type: 'session/started', session: body })
  expect(await store.unloadTranscript(runtime, id)).toBe(true)
  handlers.onStatus('reconnecting')
  handlers.onStatus('open')
  snapshotWatermark = { epoch: 'new-epoch', generation: 'new-generation', revision: 1, sequence: 1 }
  expect(await store.restoreTranscript(runtime, id)).toBe(true)
  expect(store.getSnapshot().sessions.get(key)?.turns).toEqual(body.turns)
})

it('rejects a pre-reconnect restore response before allowing a fresh retry', async () => {
  const runtime = runtimeId('example'), id = sessionId('one'), key = sessionKey(runtime, id)
  const body: Session = { id, runtime, cwd: '/example', status: { type: 'idle' }, createdAt: 0, updatedAt: 0, itemsLoaded: true,
    turns: [{ id: turnId('turn'), status: 'completed', items: [{ id: itemId('item'), type: 'assistantMessage', text: 'Synthetic saved' }] }] }
  const watermark = { epoch: 'epoch', generation: 'generation', revision: 1, sequence: 1 }
  const identity = fixtureHash(canonicalTranscriptBody(body.turns).canonical)
  let release!: (value: unknown) => void, calls = 0
  const held = new Promise(resolve => { release = resolve })
  const store = new AppStore('ws://localhost:0/')
  vi.spyOn(store.transport, 'request').mockImplementation((async (method: string) => {
    if (method === 'session/prepare-eviction') return { ...watermark, identity }
    if (method !== 'session/cache-snapshot') return null
    return ++calls === 2 ? held : { session: body, watermark, identity }
  }) as never)
  const handlers = (store.transport as unknown as { handlers: TransportEvents }).handlers
  handlers.onEvent(runtime, { type: 'session/started', session: body })
  expect(await store.unloadTranscript(runtime, id)).toBe(true)
  const old = store.restoreTranscript(runtime, id)
  handlers.onStatus('reconnecting'); handlers.onStatus('open')
  release({ session: body, watermark, identity })
  expect(await old).toBe(false)
  expect(store.getSnapshot().sessions.get(key)?.itemsLoaded).toBe(false)
  expect(await store.restoreTranscript(runtime, id)).toBe(true)
  expect(store.getSnapshot().sessions.get(key)?.turns).toEqual(body.turns)
})

it('serially re-proves each candidate when pressure requires multiple unloads', async () => {
  const runtime = runtimeId('example'), watermark = { epoch: 'epoch', generation: 'generation', revision: 1, sequence: 1 }
  const body = (id: ReturnType<typeof sessionId>): Session => ({ id, runtime, cwd: '/example', status: { type: 'idle' }, createdAt: 0, updatedAt: 0, itemsLoaded: true, turns: [] })
  const identity = fixtureHash(canonicalTranscriptBody([]).canonical)
  const store = new AppStore('ws://localhost:0/')
  let inFlight = 0, maxInFlight = 0
  const receipts = new Map<string, number>()
  vi.spyOn(store.transport, 'request').mockImplementation((async (method: string, params: { sessionId: ReturnType<typeof sessionId> }) => {
    if (method === 'session/cache-snapshot') return { session: body(params.sessionId), watermark, identity }
    if (method === 'session/prepare-eviction') {
      inFlight++; maxInFlight = Math.max(maxInFlight, inFlight)
      receipts.set(params.sessionId, (receipts.get(params.sessionId) ?? 0) + 1)
      await Promise.resolve(); inFlight--
      return { ...watermark, identity }
    }
    return null
  }) as never)
  const handlers = (store.transport as unknown as { handlers: TransportEvents }).handlers
  for (let i = 0; i < 130; i++) handlers.onEvent(runtime, { type: 'session/started', session: body(sessionId(`multi-${i}`)) })
  store.enableTranscriptCache(); store.enableTranscriptCache()
  await vi.waitFor(() => expect(store.transcriptCacheStats().releasedBodies).toBe(2))
  expect(maxInFlight).toBe(1)
  expect(receipts.get('multi-0')).toBeGreaterThanOrEqual(2)
  expect(receipts.get('multi-1')).toBeGreaterThanOrEqual(2)
})

it('does not treat a failed close as evidence of an eligible body or spin on refusal', async () => {
  const runtime = runtimeId('example'), watermark = { epoch: 'epoch', generation: 'generation', revision: 1, sequence: 1 }
  const body = (id: ReturnType<typeof sessionId>): Session => ({ id, runtime, cwd: '/example', status: { type: 'idle' }, createdAt: 0, updatedAt: 0, itemsLoaded: true, turns: [] })
  const identity = fixtureHash(canonicalTranscriptBody([]).canonical)
  const store = new AppStore('ws://localhost:0/')
  const request = vi.spyOn(store.transport, 'request').mockImplementation((async (method: string, params: { sessionId: ReturnType<typeof sessionId> }) => {
    if (method === 'session/read' || method === 'session/resume') return body(params.sessionId)
    if (method === 'session/close') throw new Error('Synthetic close refusal')
    if (method === 'session/cache-snapshot') return { session: store.getSnapshot().sessions.get(sessionKey(runtime, params.sessionId)), watermark, identity }
    if (method === 'session/prepare-eviction') return params.sessionId === sessionId('refusal-128') ? null : { ...watermark, identity }
    return null
  }) as never)
  const handlers = (store.transport as unknown as { handlers: TransportEvents }).handlers
  for (let i = 0; i < 129; i++) handlers.onEvent(runtime, { type: 'session/started', session: body(sessionId(`refusal-${i}`)) })
  expect(await store.openSession(sessionId('refusal-128'), { runtime })).toBe(true)
  store.enableTranscriptCache(); store.closePane(store.getSnapshot().layout.focused)
  await vi.waitFor(() => expect(request.mock.calls.some(([method]) => method === 'session/prepare-eviction')).toBe(true))
  await vi.waitFor(() => expect(store.transcriptCacheStats().pressureRunning).toBe(false))
  expect(store.transcriptCacheStats().releasedBodies).toBe(0)
  expect(store.transcriptCacheStats().loadedFullBodies).toBe(129)
})

it.each([[undefined, false], [false, undefined]] as const)('accepts archive defaults on local %s and Host %s through unload and restore', async (localArchive, hostArchive) => {
  const runtime = runtimeId('example'), id = sessionId('one'), key = sessionKey(runtime, id)
  const base: Session = { id, runtime, cwd: '/example', status: { type: 'idle' }, createdAt: 0, updatedAt: 0, itemsLoaded: true,
    turns: [{ id: turnId('turn'), status: 'completed', items: [{ id: itemId('item'), type: 'assistantMessage', text: 'Synthetic saved' }] }] }
  const local = localArchive === undefined ? base : { ...base, archived: localArchive }
  const remote = hostArchive === undefined ? base : { ...base, archived: hostArchive }
  const watermark = { epoch: 'epoch', generation: 'generation', revision: 1, sequence: 1 }
  const identity = fixtureHash(canonicalTranscriptBody(base.turns).canonical)
  const store = new AppStore('ws://localhost:0/')
  vi.spyOn(store.transport, 'request').mockImplementation((async (method: string) => method === 'session/cache-snapshot' ? { session: remote, watermark, identity } : method === 'session/prepare-eviction' ? { ...watermark, identity } : null) as never)
  ;(store.transport as unknown as { handlers: TransportEvents }).handlers.onEvent(runtime, { type: 'session/started', session: local })
  expect(await store.unloadTranscript(runtime, id)).toBe(true)
  expect(await store.restoreTranscript(runtime, id)).toBe(true)
  expect(store.getSnapshot().sessions.get(key)?.turns).toEqual(base.turns)
})

it('does not treat a truly archived Host body as the local unarchived default', async () => {
  const runtime = runtimeId('example'), id = sessionId('one'), key = sessionKey(runtime, id)
  const body: Session = { id, runtime, cwd: '/example', status: { type: 'idle' }, createdAt: 0, updatedAt: 0, itemsLoaded: true, turns: [] }
  const watermark = { epoch: 'epoch', generation: 'generation', revision: 1, sequence: 1 }
  const identity = fixtureHash(canonicalTranscriptBody(body.turns).canonical)
  const store = new AppStore('ws://localhost:0/')
  vi.spyOn(store.transport, 'request').mockImplementation((async (method: string) => method === 'session/cache-snapshot' ? { session: { ...body, archived: true }, watermark, identity } : method === 'session/prepare-eviction' ? { ...watermark, identity } : null) as never)
  ;(store.transport as unknown as { handlers: TransportEvents }).handlers.onEvent(runtime, { type: 'session/started', session: body })
  expect(await store.unloadTranscript(runtime, id)).toBe(false)
  expect(store.getSnapshot().sessions.get(key)?.itemsLoaded).toBe(true)
})

it('rejects an in-place local archive change while a Host snapshot is pending', async () => {
  const runtime = runtimeId('example'), id = sessionId('one'), key = sessionKey(runtime, id)
  const body: Session = { id, runtime, cwd: '/example', status: { type: 'idle' }, createdAt: 0, updatedAt: 0, itemsLoaded: true, turns: [] }
  const watermark = { epoch: 'epoch', generation: 'generation', revision: 1, sequence: 1 }
  const identity = fixtureHash(canonicalTranscriptBody(body.turns).canonical)
  let finish!: (value: unknown) => void
  const pending = new Promise(resolve => { finish = resolve })
  const store = new AppStore('ws://localhost:0/')
  vi.spyOn(store.transport, 'request').mockImplementation((async (method: string) => method === 'session/cache-snapshot' ? pending : method === 'session/prepare-eviction' ? { ...watermark, identity } : null) as never)
  ;(store.transport as unknown as { handlers: TransportEvents }).handlers.onEvent(runtime, { type: 'session/started', session: body })
  const task = store.unloadTranscript(runtime, id)
  const held = store.getSnapshot().sessions.get(key)!
  ;(held as { archived?: boolean }).archived = false
  finish({ session: body, watermark, identity })
  expect(await task).toBe(false)
  expect(store.getSnapshot().sessions.get(key)?.itemsLoaded).toBe(true)
})

it('keeps the descriptor when an unchanged-body restore changes archive from false to true', async () => {
  const runtime = runtimeId('example'), id = sessionId('one'), key = sessionKey(runtime, id)
  const body: Session = { id, runtime, cwd: '/example', archived: false, status: { type: 'idle' }, createdAt: 0, updatedAt: 0, itemsLoaded: true, turns: [] }
  const watermark = { epoch: 'epoch', generation: 'generation', revision: 1, sequence: 1 }
  const identity = fixtureHash(canonicalTranscriptBody(body.turns).canonical)
  let reads = 0
  const store = new AppStore('ws://localhost:0/')
  vi.spyOn(store.transport, 'request').mockImplementation((async (method: string) => method === 'session/cache-snapshot' ? { session: ++reads === 1 ? body : { ...body, archived: true }, watermark, identity } : method === 'session/prepare-eviction' ? { ...watermark, identity } : null) as never)
  ;(store.transport as unknown as { handlers: TransportEvents }).handlers.onEvent(runtime, { type: 'session/started', session: body })
  expect(await store.unloadTranscript(runtime, id)).toBe(true)
  expect(await store.restoreTranscript(runtime, id)).toBe(false)
  expect(store.getSnapshot().sessions.get(key)).toMatchObject({ archived: false, itemsLoaded: false })
})

it('starts the transcript pressure scheduler enabled by default', () => {
  const store = new AppStore('ws://localhost:0/')
  expect(store.transcriptCacheStats().enabled).toBe(true)
})

it('an explicitly disabled scheduler leaves 129 closed bodies loaded', async () => {
  const runtime = runtimeId('example'), watermark = { epoch: 'epoch', generation: 'generation', revision: 1, sequence: 1 }
  const body = (id: ReturnType<typeof sessionId>): Session => ({ id, runtime, cwd: '/example', status: { type: 'idle' }, createdAt: 0, updatedAt: 0, itemsLoaded: true, turns: [] })
  const identity = fixtureHash(canonicalTranscriptBody([]).canonical)
  const store = new AppStore('ws://localhost:0/')
  const request = vi.spyOn(store.transport, 'request').mockImplementation((async (method: string, params: { sessionId: ReturnType<typeof sessionId> }) => {
    if (method === 'session/read' || method === 'session/resume') return body(params.sessionId)
    if (method === 'session/cache-snapshot') return { session: body(params.sessionId), watermark, identity }
    if (method === 'session/prepare-eviction') return { ...watermark, identity }
    return null
  }) as never)
  await store.disableTranscriptCache()
  const handlers = (store.transport as unknown as { handlers: TransportEvents }).handlers
  for (let i = 0; i < 129; i++) handlers.onEvent(runtime, { type: 'session/started', session: body(sessionId(`disabled-${i}`)) })
  expect(await store.openSession(sessionId('disabled-128'), { runtime })).toBe(true)
  store.closePane(store.getSnapshot().layout.focused)
  await Promise.resolve(); await Promise.resolve(); await store.disableTranscriptCache()
  expect(store.transcriptCacheStats()).toMatchObject({ enabled: false, pressureRunning: false, releasedBodies: 0, loadedFullBodies: 129 })
  expect(request.mock.calls.some(([method]) => method === 'session/prepare-eviction')).toBe(false)
})

it('disable waits for a held receipt, starts no unload, and re-enable performs a serial pass', async () => {
  const runtime = runtimeId('example'), watermark = { epoch: 'epoch', generation: 'generation', revision: 1, sequence: 1 }
  const body = (id: ReturnType<typeof sessionId>): Session => ({ id, runtime, cwd: '/example', status: { type: 'idle' }, createdAt: 0, updatedAt: 0, itemsLoaded: true, turns: [] })
  const identity = fixtureHash(canonicalTranscriptBody([]).canonical)
  let release!: (value: unknown) => void, heldOnce = false, resolved = false, firstReceipts = 0
  const held = new Promise(resolve => { release = resolve })
  const store = new AppStore('ws://localhost:0/')
  vi.spyOn(store.transport, 'request').mockImplementation((async (method: string, params: { sessionId: ReturnType<typeof sessionId> }) => {
    if (method === 'session/cache-snapshot') return { session: body(params.sessionId), watermark, identity }
    if (method === 'session/prepare-eviction') { if (params.sessionId === sessionId('held-0') && ++firstReceipts === 2) { heldOnce = true; return held }; return { ...watermark, identity } }
    return null
  }) as never)
  const handlers = (store.transport as unknown as { handlers: TransportEvents }).handlers
  for (let i = 0; i < 129; i++) handlers.onEvent(runtime, { type: 'session/started', session: body(sessionId(`held-${i}`)) })
  store.enableTranscriptCache()
  await vi.waitFor(() => expect(heldOnce).toBe(true))
  const disabling = store.disableTranscriptCache().then(() => { resolved = true })
  await Promise.resolve()
  expect(resolved).toBe(false)
  release({ ...watermark, identity })
  await disabling
  expect(store.transcriptCacheStats()).toMatchObject({ enabled: false, pressureRunning: false, releasedBodies: 0 })
  store.enableTranscriptCache()
  await vi.waitFor(() => expect(store.transcriptCacheStats().releasedBodies).toBe(1))
})

it('serializes re-enable behind an older held disable drain', async () => {
  const runtime = runtimeId('example'), watermark = { epoch: 'epoch', generation: 'generation', revision: 1, sequence: 1 }
  const body = (id: ReturnType<typeof sessionId>): Session => ({ id, runtime, cwd: '/example', status: { type: 'idle' }, createdAt: 0, updatedAt: 0, itemsLoaded: true, turns: [] })
  const identity = fixtureHash(canonicalTranscriptBody([]).canonical)
  let release!: (value: unknown) => void, firstReceipt = false, pending = 0, maximum = 0
  const held = new Promise(resolve => { release = resolve })
  const store = new AppStore('ws://localhost:0/')
  vi.spyOn(store.transport, 'request').mockImplementation((async (method: string, params: { sessionId: ReturnType<typeof sessionId> }) => {
    if (method === 'session/cache-snapshot') return { session: body(params.sessionId), watermark, identity }
    if (method === 'session/prepare-eviction') {
      pending++; maximum = Math.max(maximum, pending)
      try { if (!firstReceipt) { firstReceipt = true; return await held }; return { ...watermark, identity } }
      finally { pending-- }
    }
    return null
  }) as never)
  const handlers = (store.transport as unknown as { handlers: TransportEvents }).handlers
  for (let i = 0; i < 129; i++) handlers.onEvent(runtime, { type: 'session/started', session: body(sessionId(`reenable-${i}`)) })
  await vi.waitFor(() => expect(firstReceipt).toBe(true))
  const disabling = store.disableTranscriptCache()
  store.enableTranscriptCache()
  await Promise.resolve()
  expect(pending).toBe(1)
  release({ ...watermark, identity })
  await disabling
  await vi.waitFor(() => expect(store.transcriptCacheStats().releasedBodies).toBe(1))
  expect(maximum).toBe(1)
})
