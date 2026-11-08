import { hash } from 'fast-sha256'
import { expect, it, vi } from 'vitest'
import { canonicalTranscriptBody, itemId, runtimeId, sessionId, sessionKey, turnId, type Session } from '@harnessdesk/protocol'
import type { TransportEvents } from '../lib/transport'
import { AppStore } from './store'

const runtime = runtimeId('example'), id = sessionId('one'), key = sessionKey(runtime, id)
const body: Session = { id, runtime, cwd: '/example', status: { type: 'idle' }, createdAt: 0, updatedAt: 0, itemsLoaded: true, turns: [] }
const watermark = { epoch: 'epoch', generation: 'generation', revision: 1, sequence: 1 }
const identity = Array.from(hash(new TextEncoder().encode(canonicalTranscriptBody(body.turns).canonical)), byte => byte.toString(16).padStart(2, '0')).join('')
const snapshot = { session: body, watermark, identity }

it('discards each confirmed deleted release and fences its late restore', async () => {
  const store = new AppStore('ws://localhost:0/')
  await store.disableTranscriptCache()
  let release!: (value: unknown) => void, hold = false
  const delayed = new Promise(resolve => { release = resolve })
  vi.spyOn(store.transport, 'request').mockImplementation((async (method: string) => method === 'session/cache-snapshot' ? (hold ? delayed : snapshot) : method === 'session/prepare-eviction' ? { ...watermark, identity } : null) as never)
  const handlers = (store.transport as unknown as { handlers: TransportEvents }).handlers
  for (let i = 0; i < 3; i++) {
    handlers.onEvent(runtime, { type: 'session/started', session: body })
    expect(await store.unloadTranscript(runtime, id)).toBe(true)
    hold = true
    const restoring = store.restoreTranscript(runtime, id)
    handlers.onNotification({ method: 'session/removed', params: { runtime, sessionId: id, deleted: true } })
    expect(store.transcriptCacheStats().trackedRecoveryRecords).toBe(0)
    release(snapshot)
    expect(await restoring).toBe(false)
    expect(store.getSnapshot().sessions.has(key)).toBe(false)
    hold = false
  }
})

it('discards only the matching confirmed pending recovery and fences its response', async () => {
  const store = new AppStore('ws://localhost:0/')
  await store.disableTranscriptCache()
  let release!: (value: unknown) => void, calls = 0
  const delayed = new Promise(resolve => { release = resolve })
  vi.spyOn(store.transport, 'request').mockImplementation((async (method: string) => method === 'session/cache-snapshot' ? (++calls === 1 ? snapshot : delayed) : null) as never)
  const handlers = (store.transport as unknown as { handlers: TransportEvents }).handlers
  handlers.onEvent(runtime, { type: 'session/started', session: body })
  expect(await store.verifyTranscriptCache(runtime, id)).toBe(true)
  handlers.onEvent(runtime, { type: 'item/delta', sessionId: id, turnId: turnId('turn'), itemId: itemId('item'), delta: { kind: 'assistantText', text: 'Synthetic pending' } }, { ...watermark, sequence: 3, revision: 3 })
  expect(store.transcriptCacheStats().trackedRecoveryRecords).toBe(1)
  handlers.onNotification({ method: 'session/removed', params: { runtime: runtimeId('other'), sessionId: id, deleted: true } })
  expect(store.transcriptCacheStats().trackedRecoveryRecords).toBe(1)
  handlers.onNotification({ method: 'session/removed', params: { runtime, sessionId: sessionId('other'), deleted: true } })
  expect(store.transcriptCacheStats().trackedRecoveryRecords).toBe(1)
  handlers.onNotification({ method: 'session/removed', params: { runtime, sessionId: id, deleted: true } })
  expect(store.transcriptCacheStats().trackedRecoveryRecords).toBe(0)
  release(snapshot); await Promise.resolve(); await Promise.resolve()
  expect(store.getSnapshot().sessions.has(key)).toBe(false)
})

it.each(['unconfirmed', 'old-connection'] as const)('preserves an ambiguous released owner after %s removal', async kind => {
  const store = new AppStore('ws://localhost:0/')
  await store.disableTranscriptCache()
  vi.spyOn(store.transport, 'request').mockImplementation((async (method: string) => method === 'session/cache-snapshot' ? snapshot : method === 'session/prepare-eviction' ? { ...watermark, identity } : null) as never)
  const handlers = (store.transport as unknown as { handlers: TransportEvents }).handlers
  handlers.onEvent(runtime, { type: 'session/started', session: body })
  expect(await store.unloadTranscript(runtime, id)).toBe(true)
  if (kind === 'old-connection') handlers.onStatus('reconnecting')
  handlers.onNotification({ method: 'session/removed', params: { runtime, sessionId: id, deleted: kind !== 'unconfirmed' } })
  expect(store.transcriptCacheStats().trackedRecoveryRecords).toBe(1)
  handlers.onNotification({ method: 'session/removed', params: { runtime, sessionId: id, deleted: true } })
  expect(store.transcriptCacheStats().trackedRecoveryRecords).toBe(1)
})

it('preserves a released capture that observed a different generation before deletion', async () => {
  const store = new AppStore('ws://localhost:0/')
  await store.disableTranscriptCache()
  vi.spyOn(store.transport, 'request').mockImplementation((async (method: string) => method === 'session/cache-snapshot' ? snapshot : method === 'session/prepare-eviction' ? { ...watermark, identity } : null) as never)
  const handlers = (store.transport as unknown as { handlers: TransportEvents }).handlers
  handlers.onEvent(runtime, { type: 'session/started', session: body })
  expect(await store.unloadTranscript(runtime, id)).toBe(true)
  handlers.onEvent(runtime, { type: 'session/title', sessionId: id, title: 'New generation material' }, { ...watermark, generation: 'new', sequence: 2, revision: 2 })
  handlers.onNotification({ method: 'session/removed', params: { runtime, sessionId: id, deleted: true } })
  expect(store.transcriptCacheStats().trackedRecoveryRecords).toBe(1)
})

it('preserves pending material from a different generation on deletion', async () => {
  const store = new AppStore('ws://localhost:0/')
  await store.disableTranscriptCache()
  vi.spyOn(store.transport, 'request').mockImplementation((async (method: string) => method === 'session/cache-snapshot' ? snapshot : null) as never)
  const handlers = (store.transport as unknown as { handlers: TransportEvents }).handlers
  handlers.onEvent(runtime, { type: 'session/started', session: body })
  expect(await store.verifyTranscriptCache(runtime, id)).toBe(true)
  handlers.onEvent(runtime, { type: 'session/title', sessionId: id, title: 'New generation material' }, { ...watermark, generation: 'new', sequence: 2, revision: 2 })
  expect(store.transcriptCacheStats().trackedRecoveryRecords).toBe(1)
  handlers.onNotification({ method: 'session/removed', params: { runtime, sessionId: id, deleted: true } })
  expect(store.transcriptCacheStats().trackedRecoveryRecords).toBe(1)
})
