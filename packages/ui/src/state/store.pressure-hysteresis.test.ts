import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { canonicalTranscriptBody, itemId, runtimeId, sessionId, sessionKey, turnId, type Session } from '@harnessdesk/protocol'
import type { TransportEvents } from '../lib/transport'
import { AppStore } from './store'
import { transcriptFingerprint } from './transcript-fingerprint'

beforeEach(() => vi.stubGlobal('sessionStorage', undefined))
afterEach(() => vi.unstubAllGlobals())

const runtime = runtimeId('synthetic'), watermark = { epoch: 'epoch', generation: 'generation', revision: 1, sequence: 1 }
const id = (index: number) => sessionId(`hysteresis-${String(index).padStart(3, '0')}`)
const body = (index: number, text = ''): Session => ({
  id: id(index), runtime, cwd: '/synthetic', status: { type: 'idle' }, createdAt: 0, updatedAt: 0, itemsLoaded: true,
  turns: text ? [{ id: turnId('turn'), status: 'completed', items: [{ id: itemId('item'), type: 'assistantMessage', text }] }] : [],
})
const quiet = async (store: AppStore) => vi.waitFor(() => {
  const state = store.transcriptCacheStats()
  expect(state.pressureRunning).toBe(false); expect(state.pressureDirty).toBe(false)
}, { timeout: 15_000, interval: 10 })

const setup = async () => {
  const store = new AppStore('ws://localhost:0/')
  await store.disableTranscriptCache()
  const bodies = new Map<string, Session>(), snapshots = new Map<string, number>(), receipts = new Map<string, number>()
  let releaseQueue!: () => void, queueStarted = false
  const queueGate = new Promise<void>(resolve => { releaseQueue = resolve })
  vi.spyOn(store.transport, 'request').mockImplementation((async (method: string, params: { sessionId: string }) => {
    if (method === 'turn/queue') { queueStarted = true; await queueGate; return null }
    const session = bodies.get(params.sessionId)
    if (!session) return null
    const identity = transcriptFingerprint(canonicalTranscriptBody(session.turns).canonical)
    if (method === 'session/cache-snapshot') { snapshots.set(params.sessionId, (snapshots.get(params.sessionId) ?? 0) + 1); return { session, watermark, identity } }
    if (method === 'session/prepare-eviction') { receipts.set(params.sessionId, (receipts.get(params.sessionId) ?? 0) + 1); return { ...watermark, identity } }
    return null
  }) as never)
  const handlers = (store.transport as unknown as { handlers: TransportEvents }).handlers
  const add = (index: number, text = '') => { const session = body(index, text); bodies.set(session.id, session); handlers.onEvent(runtime, { type: 'session/started', session }) }
  return { store, add, snapshots, receipts, releaseQueue, queueStarted: () => queueStarted }
}

it('keeps the high water for refill and reclaims to the low water for each fresh burst', async () => {
  const { store, add, snapshots, receipts, releaseQueue, queueStarted } = await setup()
  for (let i = 0; i < 132; i++) add(i)
  const owner = store.retainTranscript(runtime, id(129))
  store.drafts.setLive(sessionKey(runtime, id(130)), { text: 'Synthetic unsent draft', attachments: [] })
  const pending = store.queue([{ type: 'text', text: 'Synthetic pending' }], sessionKey(runtime, id(131)))
  await Promise.resolve(); expect(queueStarted()).toBe(true)
  try {
    // Only 128 of the 132 are eligible until the final eligible body arrives.
    const held = store.retainTranscript(runtime, id(128))
    store.enableTranscriptCache(); await quiet(store)
    expect(store.transcriptCacheStats()).toMatchObject({ loadedFullBodies: 132, releasedBodies: 0 })
    held(); await quiet(store)
    expect(store.transcriptCacheStats()).toMatchObject({ loadedFullBodies: 35, releasedBodies: 97 })
    for (let i = 0; i < 97; i++) {
      expect(store.getSnapshot().sessions.get(sessionKey(runtime, id(i)))?.itemsLoaded).toBe(false)
      expect(snapshots.get(id(i))).toBeGreaterThanOrEqual(2)
      expect(receipts.get(id(i))).toBeGreaterThanOrEqual(2)
    }
    for (const index of [129, 130, 131]) expect(store.getSnapshot().sessions.get(sessionKey(runtime, id(index)))?.itemsLoaded).toBe(true)
    for (let i = 0; i < 96; i++) expect(await store.restoreTranscript(runtime, id(i))).toBe(true)
    await quiet(store)
    expect(store.transcriptCacheStats()).toMatchObject({ loadedFullBodies: 131, releasedBodies: 1 })
    add(132)
    const closeNew = store.retainTranscript(runtime, id(132)); closeNew(); await quiet(store)
    expect(store.transcriptCacheStats()).toMatchObject({ loadedFullBodies: 35, releasedBodies: 98 })
    for (const index of [129, 130, 131]) expect(store.getSnapshot().sessions.get(sessionKey(runtime, id(index)))?.itemsLoaded).toBe(true)
  } finally { releaseQueue(); await pending; owner(); await store.disableTranscriptCache() }
}, 30_000)

it('continues to the count low water after byte-only pressure begins', async () => {
  const { store, add } = await setup()
  for (let i = 0; i < 40; i++) add(i, 'x'.repeat(225 * 1024))
  const bytes = canonicalTranscriptBody(body(0, 'x'.repeat(225 * 1024)).turns).bytes
  expect(bytes * 40).toBeGreaterThan(8 * 1024 * 1024)
  expect(bytes * 33).toBeLessThan(8 * 1024 * 1024)
  try {
    store.enableTranscriptCache(); await quiet(store)
    expect(store.transcriptCacheStats()).toMatchObject({ loadedFullBodies: 32, releasedBodies: 8 })
  } finally { await store.disableTranscriptCache() }
}, 30_000)

it('keeps reclaiming below the low count while the byte ceiling is exceeded', async () => {
  const { store, add } = await setup()
  const text = 'x'.repeat(1024 * 1024)
  const bytes = canonicalTranscriptBody(body(0, text).turns).bytes
  for (let i = 0; i < 10; i++) add(i, text)
  const retained = Math.floor((8 * 1024 * 1024) / bytes)
  expect(retained).toBeLessThan(32)
  try {
    store.enableTranscriptCache(); await quiet(store)
    expect(store.transcriptCacheStats()).toMatchObject({ loadedFullBodies: retained, releasedBodies: 10 - retained })
  } finally { await store.disableTranscriptCache() }
}, 30_000)
