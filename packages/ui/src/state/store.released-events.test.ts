import { hash } from 'fast-sha256'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { approvalId, canonicalTranscriptBody, itemId, PendingTranscript, runtimeId, sessionId, sessionKey, turnId, type AgentItem, type ItemDelta, type Session } from '@harnessdesk/protocol'
import type { TransportEvents } from '../lib/transport'
import { AppStore } from './store'

const digest = (body: Session) => Array.from(hash(new TextEncoder().encode(canonicalTranscriptBody(body.turns).canonical)), byte => byte.toString(16).padStart(2, '0')).join('')
const runtime = runtimeId('example')
const first = sessionId('first'), second = sessionId('second')
const fence = { epoch: 'epoch', generation: 'generation', revision: 1, sequence: 1 }
const body = (id: typeof first): Session => ({ id, runtime, cwd: '/example', status: { type: 'idle' }, createdAt: 0, updatedAt: 0, itemsLoaded: true, turns: [] })

beforeEach(() => vi.stubGlobal('sessionStorage', undefined))
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

it('routes a fenced nested approval without invalidating an unrelated transcript', async () => {
  const store = new AppStore('ws://localhost:0/')
  await store.disableTranscriptCache()
  vi.spyOn(store.transport, 'request').mockImplementation((async (method: string, params: { sessionId: typeof first }) => {
    const session = body(params.sessionId)
    return method === 'session/cache-snapshot' ? { session, watermark: fence, identity: digest(session) } : null
  }) as never)
  const handlers = (store.transport as unknown as { handlers: TransportEvents }).handlers
  handlers.onEvent(runtime, { type: 'session/started', session: body(first) })
  handlers.onEvent(runtime, { type: 'session/started', session: body(second) })
  expect(await store.verifyTranscriptCache(runtime, second)).toBe(true)
  handlers.onEvent(runtime, { type: 'approval/requested', approval: { type: 'permission', id: approvalId('approval'), sessionId: first, requestedAt: 0, summary: 'Synthetic', options: [] } }, { ...fence, sequence: 2, revision: 2 })
  expect(store.getSnapshot().approvals).toHaveLength(1)
  expect(store.transcriptCacheVerified(runtime, second)).toBe(true)
})

it('restores a released body after a fenced title, status and turn start', async () => {
  const original = body(first), key = sessionKey(runtime, first)
  const turn = { id: turnId('new-turn'), status: 'inProgress' as const, items: [] }
  const updated: Session = { ...original, title: 'Synthetic title', status: { type: 'active' }, turns: [turn] }
  let release!: (value: unknown) => void, snapshots = 0
  const held = new Promise(resolve => { release = resolve })
  const store = new AppStore('ws://localhost:0/')
  await store.disableTranscriptCache()
  vi.spyOn(store.transport, 'request').mockImplementation((async (method: string) => {
    if (method === 'session/prepare-eviction') return { ...fence, identity: digest(original) }
    if (method === 'session/cache-snapshot') return ++snapshots === 1 ? { session: original, watermark: fence, identity: digest(original) } : held
    return null
  }) as never)
  const handlers = (store.transport as unknown as { handlers: TransportEvents }).handlers
  handlers.onEvent(runtime, { type: 'session/started', session: original })
  expect(await store.unloadTranscript(runtime, first)).toBe(true)
  handlers.onEvent(runtime, { type: 'session/title', sessionId: first, title: 'Synthetic title' }, { ...fence, sequence: 2, revision: 2 })
  handlers.onEvent(runtime, { type: 'session/status', sessionId: first, status: { type: 'active' } }, { ...fence, sequence: 3, revision: 3 })
  handlers.onEvent(runtime, { type: 'turn/started', sessionId: first, turn }, { ...fence, sequence: 4, revision: 4 })
  release({ session: updated, watermark: { ...fence, sequence: 4, revision: 4 }, identity: digest(updated) })
  await vi.waitFor(() => expect(store.getSnapshot().sessions.get(key)).toMatchObject({ itemsLoaded: true, title: 'Synthetic title', turns: [turn] }))
})

it('restores a completed assistant turn only when its full captured output is present', async () => {
  const original = body(first), key = sessionKey(runtime, first), turn = turnId('turn'), item = { id: itemId('item'), type: 'assistantMessage' as const, text: 'Synthetic output' }
  const started = { id: turn, status: 'inProgress' as const, items: [] }, completed = { id: turn, status: 'completed' as const, items: [item] }
  const updated: Session = { ...original, turns: [completed] }
  let release!: (value: unknown) => void, snapshots = 0
  const held = new Promise(resolve => { release = resolve })
  const store = new AppStore('ws://localhost:0/')
  await store.disableTranscriptCache()
  vi.spyOn(store.transport, 'request').mockImplementation((async (method: string) => {
    if (method === 'session/prepare-eviction') return { ...fence, identity: digest(original) }
    if (method === 'session/cache-snapshot') return ++snapshots === 1 ? { session: original, watermark: fence, identity: digest(original) } : held
    return null
  }) as never)
  const handlers = (store.transport as unknown as { handlers: TransportEvents }).handlers
  handlers.onEvent(runtime, { type: 'session/started', session: original })
  expect(await store.unloadTranscript(runtime, first)).toBe(true)
  handlers.onEvent(runtime, { type: 'turn/started', sessionId: first, turn: started }, { ...fence, sequence: 2, revision: 2 })
  handlers.onEvent(runtime, { type: 'item/started', sessionId: first, turnId: turn, item: { ...item, text: '' } }, { ...fence, sequence: 3, revision: 3 })
  handlers.onEvent(runtime, { type: 'item/delta', sessionId: first, turnId: turn, itemId: item.id, delta: { kind: 'assistantText', text: item.text } }, { ...fence, sequence: 4, revision: 4 })
  handlers.onEvent(runtime, { type: 'item/completed', sessionId: first, turnId: turn, item }, { ...fence, sequence: 5, revision: 5 })
  handlers.onEvent(runtime, { type: 'turn/completed', sessionId: first, turn: completed }, { ...fence, sequence: 6, revision: 6 })
  release({ session: updated, watermark: { ...fence, sequence: 6, revision: 6 }, identity: digest(updated) })
  await vi.waitFor(() => expect(store.getSnapshot().sessions.get(key)?.turns).toEqual([completed]))
})

it('reconciles a connected user and command turn from its full current snapshot', async () => {
  const original: Session = { ...body(first), turns: [{ id: turnId('old'), status: 'completed', items: [{ id: itemId('old-item'), type: 'assistantMessage', text: 'Synthetic existing history' }] }] }
  const key = sessionKey(runtime, first), turn = turnId('command-turn')
  const user = { id: itemId('user'), type: 'userMessage' as const, content: [{ type: 'text' as const, text: 'Synthetic question' }] }
  const started = { id: turn, status: 'inProgress' as const, items: [user] }
  const initialCommand = { id: itemId('command'), type: 'command' as const, command: 'synthetic', cwd: '/example', origin: 'agent' as const, status: 'inProgress' as const, actions: [], output: '' }
  const finalCommand = { ...initialCommand, status: 'completed' as const, output: 'Synthetic output', exitCode: 0 }
  const completed = { ...started, status: 'completed' as const, items: [user, finalCommand] }
  const updated: Session = { ...original, title: 'Synthetic title', turns: [...original.turns, completed] }
  let release!: (value: unknown) => void, snapshots = 0
  const held = new Promise(resolve => { release = resolve })
  const store = new AppStore('ws://localhost:0/')
  await store.disableTranscriptCache()
  vi.spyOn(store.transport, 'request').mockImplementation((async (method: string) => {
    if (method === 'session/prepare-eviction') return { ...fence, identity: digest(original) }
    if (method === 'session/cache-snapshot') return ++snapshots === 1 ? { session: original, watermark: fence, identity: digest(original) } : held
    return null
  }) as never)
  const handlers = (store.transport as unknown as { handlers: TransportEvents }).handlers
  handlers.onEvent(runtime, { type: 'session/started', session: original })
  expect(await store.unloadTranscript(runtime, first)).toBe(true)
  const emit = (event: Parameters<typeof handlers.onEvent>[1], sequence: number) => handlers.onEvent(runtime, event, { ...fence, sequence, revision: sequence })
  emit({ type: 'session/status', sessionId: first, status: { type: 'active' } }, 2)
  emit({ type: 'session/title', sessionId: first, title: 'Synthetic title' }, 3)
  emit({ type: 'turn/started', sessionId: first, turn: started }, 4)
  emit({ type: 'item/started', sessionId: first, turnId: turn, item: initialCommand }, 5)
  emit({ type: 'item/delta', sessionId: first, turnId: turn, itemId: initialCommand.id, delta: { kind: 'commandOutput', stream: 'stdout', chunk: 'Synthetic output' } }, 6)
  emit({ type: 'item/completed', sessionId: first, turnId: turn, item: finalCommand }, 7)
  emit({ type: 'turn/completed', sessionId: first, turn: completed }, 8)
  emit({ type: 'session/status', sessionId: first, status: { type: 'idle' } }, 9)
  release({ session: updated, watermark: { ...fence, sequence: 9, revision: 9 }, identity: digest(updated) })
  await vi.waitFor(() => expect(store.getSnapshot().sessions.get(key)?.turns).toEqual(updated.turns))
})

it.each(['wrong-generation', 'missing-title', 'missing-turn', 'wrong-item', 'out-of-order', 'sequence-gap', 'unsupported'] as const)(
  'keeps the released body protected when %s is observed', async failure => {
    const original = body(first), key = sessionKey(runtime, first), turn = turnId('turn')
    const item = { id: itemId('item'), type: 'assistantMessage' as const, text: 'Synthetic output' }
    const started = { id: turn, status: 'inProgress' as const, items: [item] }
    const updated: Session = { ...original, title: failure === 'missing-title' ? 'Other' : 'Synthetic title', turns: failure === 'missing-turn' ? [] : [{ ...started, items: failure === 'wrong-item' ? [{ ...item, text: 'Other' }] : [item] }] }
    let release!: (value: unknown) => void, snapshots = 0
    const held = new Promise(resolve => { release = resolve })
    const store = new AppStore('ws://localhost:0/')
    await store.disableTranscriptCache()
    vi.spyOn(store.transport, 'request').mockImplementation((async (method: string) => {
      if (method === 'session/prepare-eviction') return { ...fence, identity: digest(original) }
      if (method === 'session/cache-snapshot') return ++snapshots === 1 ? { session: original, watermark: fence, identity: digest(original) } : held
      return null
    }) as never)
    const handlers = (store.transport as unknown as { handlers: TransportEvents }).handlers
    handlers.onEvent(runtime, { type: 'session/started', session: original })
    expect(await store.unloadTranscript(runtime, first)).toBe(true)
    handlers.onEvent(runtime, { type: 'session/title', sessionId: first, title: 'Synthetic title' }, { ...fence, sequence: 2, revision: 2 })
    handlers.onEvent(runtime, { type: 'turn/started', sessionId: first, turn: started }, { ...fence, sequence: failure === 'out-of-order' ? 2 : failure === 'sequence-gap' ? 4 : 3, revision: failure === 'out-of-order' ? 2 : failure === 'sequence-gap' ? 4 : 3 })
    if (failure === 'unsupported') handlers.onEvent(runtime, { type: 'turn/diff', sessionId: first, turnId: turn, diff: 'Synthetic diff' }, { ...fence, sequence: 4, revision: 4 })
    release({ session: updated, watermark: { ...fence, generation: failure === 'wrong-generation' ? 'other' : fence.generation, sequence: 5, revision: 5 }, identity: digest(updated) })
    await Promise.resolve()
    await store.restoreTranscript(runtime, first) // settle any response started before the final event
    expect(await store.restoreTranscript(runtime, first)).toBe(false)
    expect(store.getSnapshot().sessions.get(key)).toMatchObject({ itemsLoaded: false, turns: [] })
  },
)

it('does not retire captured item order when a covering snapshot reverses it', async () => {
  const original = body(first), key = sessionKey(runtime, first)
  const firstItem = { id: itemId('first-item'), type: 'userMessage' as const, content: [{ type: 'text' as const, text: 'first' }] }
  const secondItem = { id: itemId('second-item'), type: 'userMessage' as const, content: [{ type: 'text' as const, text: 'second' }] }
  const turn = { id: turnId('turn'), status: 'inProgress' as const, items: [firstItem, secondItem] }
  const reversed: Session = { ...original, turns: [{ ...turn, items: [secondItem, firstItem] }] }
  let release!: (value: unknown) => void, snapshots = 0
  const held = new Promise(resolve => { release = resolve })
  const store = new AppStore('ws://localhost:0/')
  await store.disableTranscriptCache()
  vi.spyOn(store.transport, 'request').mockImplementation((async (method: string) => {
    if (method === 'session/prepare-eviction') return { ...fence, identity: digest(original) }
    if (method === 'session/cache-snapshot') return ++snapshots === 1 ? { session: original, watermark: fence, identity: digest(original) } : held
    return null
  }) as never)
  const handlers = (store.transport as unknown as { handlers: TransportEvents }).handlers
  handlers.onEvent(runtime, { type: 'session/started', session: original })
  expect(await store.unloadTranscript(runtime, first)).toBe(true)
  handlers.onEvent(runtime, { type: 'turn/started', sessionId: first, turn }, { ...fence, sequence: 2, revision: 2 })
  release({ session: reversed, watermark: { ...fence, sequence: 2, revision: 2 }, identity: digest(reversed) })
  expect(await store.restoreTranscript(runtime, first)).toBe(false)
  expect(store.getSnapshot().sessions.get(key)).toMatchObject({ itemsLoaded: false, turns: [] })
})

it('reconciles a full session-start replay before connected activity', async () => {
  const original: Session = { ...body(first), turns: [{ id: turnId('old'), status: 'completed', items: [{ id: itemId('old-item'), type: 'assistantMessage', text: 'Synthetic previous' }] }] }
  const key = sessionKey(runtime, first), updated: Session = { ...original, title: 'Synthetic resumed' }
  let release!: (value: unknown) => void, snapshots = 0
  const held = new Promise(resolve => { release = resolve })
  const store = new AppStore('ws://localhost:0/')
  await store.disableTranscriptCache()
  vi.spyOn(store.transport, 'request').mockImplementation((async (method: string) => {
    if (method === 'session/prepare-eviction') return { ...fence, identity: digest(original) }
    if (method === 'session/cache-snapshot') return ++snapshots === 1 ? { session: original, watermark: fence, identity: digest(original) } : held
    return null
  }) as never)
  const handlers = (store.transport as unknown as { handlers: TransportEvents }).handlers
  handlers.onEvent(runtime, { type: 'session/started', session: original })
  expect(await store.unloadTranscript(runtime, first)).toBe(true)
  handlers.onEvent(runtime, { type: 'session/started', session: original }, { ...fence, sequence: 2, revision: 2 })
  handlers.onEvent(runtime, { type: 'session/title', sessionId: first, title: 'Synthetic resumed' }, { ...fence, sequence: 3, revision: 3 })
  release({ session: updated, watermark: { ...fence, sequence: 3, revision: 3 }, identity: digest(updated) })
  await vi.waitFor(() => expect(store.getSnapshot().sessions.get(key)).toMatchObject({ itemsLoaded: true, title: 'Synthetic resumed', turns: original.turns }))
})

it('does not mistake text already in the released body for a newly observed delta', async () => {
  const original: Session = { ...body(first), turns: [{ id: turnId('turn'), status: 'completed', items: [{ id: itemId('item'), type: 'assistantMessage', text: 'Synthetic echo' }] }] }
  const key = sessionKey(runtime, first)
  let release!: (value: unknown) => void, snapshots = 0
  const held = new Promise(resolve => { release = resolve })
  const store = new AppStore('ws://localhost:0/')
  await store.disableTranscriptCache()
  vi.spyOn(store.transport, 'request').mockImplementation((async (method: string) => {
    if (method === 'session/prepare-eviction') return { ...fence, identity: digest(original) }
    if (method === 'session/cache-snapshot') return ++snapshots === 1 ? { session: original, watermark: fence, identity: digest(original) } : held
    return null
  }) as never)
  const handlers = (store.transport as unknown as { handlers: TransportEvents }).handlers
  handlers.onEvent(runtime, { type: 'session/started', session: original })
  expect(await store.unloadTranscript(runtime, first)).toBe(true)
  handlers.onEvent(runtime, { type: 'item/delta', sessionId: first, turnId: turnId('turn'), itemId: itemId('item'), delta: { kind: 'assistantText', text: 'echo' } }, { ...fence, sequence: 2, revision: 2 })
  release({ session: original, watermark: { ...fence, sequence: 2, revision: 2 }, identity: digest(original) })
  expect(await store.restoreTranscript(runtime, first)).toBe(false)
  expect(store.getSnapshot().sessions.get(key)).toMatchObject({ itemsLoaded: false, turns: [] })
})

it('does not replace the original released history with only a newly observed turn', async () => {
  const original: Session = { ...body(first), turns: [{ id: turnId('old'), status: 'completed', items: [{ id: itemId('old-item'), type: 'assistantMessage', text: 'Synthetic original' }] }] }
  const key = sessionKey(runtime, first), turn = { id: turnId('new'), status: 'inProgress' as const, items: [] }
  const truncated: Session = { ...original, turns: [turn] }
  let release!: (value: unknown) => void, snapshots = 0
  const held = new Promise(resolve => { release = resolve })
  const store = new AppStore('ws://localhost:0/')
  await store.disableTranscriptCache()
  vi.spyOn(store.transport, 'request').mockImplementation((async (method: string) => {
    if (method === 'session/prepare-eviction') return { ...fence, identity: digest(original) }
    if (method === 'session/cache-snapshot') return ++snapshots === 1 ? { session: original, watermark: fence, identity: digest(original) } : held
    return null
  }) as never)
  const handlers = (store.transport as unknown as { handlers: TransportEvents }).handlers
  handlers.onEvent(runtime, { type: 'session/started', session: original })
  expect(await store.unloadTranscript(runtime, first)).toBe(true)
  handlers.onEvent(runtime, { type: 'turn/started', sessionId: first, turn }, { ...fence, sequence: 2, revision: 2 })
  release({ session: truncated, watermark: { ...fence, sequence: 2, revision: 2 }, identity: digest(truncated) })
  expect(await store.restoreTranscript(runtime, first)).toBe(false)
  expect(store.getSnapshot().sessions.get(key)).toMatchObject({ itemsLoaded: false, turns: [] })
})

it('delivers a released session approval once while retaining its event fence', async () => {
  const original = body(first), key = sessionKey(runtime, first)
  let release!: (value: unknown) => void, snapshots = 0
  const held = new Promise(resolve => { release = resolve })
  const store = new AppStore('ws://localhost:0/')
  await store.disableTranscriptCache()
  vi.spyOn(store.transport, 'request').mockImplementation((async (method: string) => {
    if (method === 'session/prepare-eviction') return { ...fence, identity: digest(original) }
    if (method === 'session/cache-snapshot') return ++snapshots === 1 ? { session: original, watermark: fence, identity: digest(original) } : held
    return null
  }) as never)
  const handlers = (store.transport as unknown as { handlers: TransportEvents }).handlers
  handlers.onEvent(runtime, { type: 'session/started', session: original })
  expect(await store.unloadTranscript(runtime, first)).toBe(true)
  const event = { type: 'approval/requested' as const, approval: { type: 'permission' as const, id: approvalId('approval'), sessionId: first, requestedAt: 0, summary: 'Synthetic', options: [] } }
  const next = { ...fence, sequence: 2, revision: 2 }
  handlers.onEvent(runtime, event, next)
  handlers.onEvent(runtime, event, next)
  expect(store.getSnapshot().approvals).toHaveLength(1)
  release({ session: original, watermark: next, identity: digest(original) })
  await vi.waitFor(() => expect(store.getSnapshot().sessions.get(key)?.itemsLoaded).toBe(true))
  expect(store.getSnapshot().approvals).toHaveLength(1)
})

it('restores after valid Host read entry and exit invalidations surround a session replay', async () => {
  const original = body(first), key = sessionKey(runtime, first)
  let release!: (value: unknown) => void, snapshots = 0
  const held = new Promise(resolve => { release = resolve }), store = new AppStore('ws://localhost:0/')
  await store.disableTranscriptCache()
  vi.spyOn(store.transport, 'request').mockImplementation((async (method: string) => method === 'session/prepare-eviction' ? { ...fence, identity: digest(original) } : method === 'session/cache-snapshot' ? ++snapshots === 1 ? { session: original, watermark: fence, identity: digest(original) } : held : null) as never)
  const handlers = (store.transport as unknown as { handlers: TransportEvents }).handlers
  handlers.onEvent(runtime, { type: 'session/started', session: original })
  expect(await store.unloadTranscript(runtime, first)).toBe(true)
  handlers.onNotification({ method: 'session/cache-invalidated', params: { runtime, sessionId: first, watermark: { ...fence, sequence: 2, revision: 2 } } })
  handlers.onEvent(runtime, { type: 'session/started', session: original }, { ...fence, sequence: 3, revision: 3 })
  handlers.onNotification({ method: 'session/cache-invalidated', params: { runtime, sessionId: first, watermark: { ...fence, sequence: 4, revision: 4 } } })
  handlers.onEvent(runtime, { type: 'session/title', sessionId: first, title: 'Synthetic' }, { ...fence, sequence: 5, revision: 5 })
  const updated: Session = { ...original, title: 'Synthetic' }
  release({ session: updated, watermark: { ...fence, sequence: 5, revision: 5 }, identity: digest(updated) })
  await vi.waitFor(() => expect(store.getSnapshot().sessions.get(key)).toMatchObject({ itemsLoaded: true, title: 'Synthetic' }))
})

it('restores an old assistant item appended after a full session replay', async () => {
  const original: Session = { ...body(first), turns: [{ id: turnId('old'), status: 'completed', items: [{ id: itemId('item'), type: 'assistantMessage', text: 'old ' }] }] }
  const updated: Session = { ...original, turns: [{ ...original.turns[0]!, items: [{ id: itemId('item'), type: 'assistantMessage', text: 'old new' }] }] }
  const key = sessionKey(runtime, first); let release!: (value: unknown) => void, snapshots = 0
  const held = new Promise(resolve => { release = resolve }), store = new AppStore('ws://localhost:0/')
  await store.disableTranscriptCache()
  vi.spyOn(store.transport, 'request').mockImplementation((async (method: string) => method === 'session/prepare-eviction' ? { ...fence, identity: digest(original) } : method === 'session/cache-snapshot' ? ++snapshots === 1 ? { session: original, watermark: fence, identity: digest(original) } : held : null) as never)
  const handlers = (store.transport as unknown as { handlers: TransportEvents }).handlers
  handlers.onEvent(runtime, { type: 'session/started', session: original })
  expect(await store.unloadTranscript(runtime, first)).toBe(true)
  handlers.onEvent(runtime, { type: 'session/started', session: original }, { ...fence, sequence: 2, revision: 2 })
  handlers.onEvent(runtime, { type: 'item/delta', sessionId: first, turnId: turnId('old'), itemId: itemId('item'), delta: { kind: 'assistantText', text: 'new' } }, { ...fence, sequence: 3, revision: 3 })
  release({ session: updated, watermark: { ...fence, sequence: 3, revision: 3 }, identity: digest(updated) })
  await vi.waitFor(() => expect(store.getSnapshot().sessions.get(key)?.turns).toEqual(updated.turns))
})

it('covers ordinary memory and closed metadata from the complete snapshot', async () => {
  const original = body(first), updated: Session = { ...original, memory: true }, key = sessionKey(runtime, first)
  let release!: (value: unknown) => void, snapshots = 0
  const held = new Promise(resolve => { release = resolve }), store = new AppStore('ws://localhost:0/')
  await store.disableTranscriptCache()
  vi.spyOn(store.transport, 'request').mockImplementation((async (method: string) => method === 'session/prepare-eviction' ? { ...fence, identity: digest(original) } : method === 'session/cache-snapshot' ? ++snapshots === 1 ? { session: original, watermark: fence, identity: digest(original) } : held : null) as never)
  const handlers = (store.transport as unknown as { handlers: TransportEvents }).handlers
  handlers.onEvent(runtime, { type: 'session/started', session: original });expect(await store.unloadTranscript(runtime, first)).toBe(true)
  handlers.onEvent(runtime, { type: 'session/memory', sessionId: first, enabled: true }, { ...fence, sequence: 2, revision: 2 })
  handlers.onEvent(runtime, { type: 'session/closed', sessionId: first }, { ...fence, sequence: 3, revision: 3 })
  release({ session: updated, watermark: { ...fence, sequence: 3, revision: 3 }, identity: digest(updated) })
  await vi.waitFor(() => expect(store.getSnapshot().sessions.get(key)).toMatchObject({ itemsLoaded: true, memory: true }))
})

it('covers a complete reasoning item with exact snapshot fields', async () => {
  const original = body(first), key = sessionKey(runtime, first), tid = turnId('reason')
  const initial = { id: itemId('reason'), type: 'reasoning' as const, summary: [] as string[], content: [] as string[] }
  const complete = { ...initial, summary: ['Synthetic reasoning'], content: ['Synthetic detail'] }
  const updated: Session = { ...original, turns: [{ id: tid, status: 'completed', items: [complete] }] }
  let release!: (value: unknown) => void, snapshots = 0
  const held = new Promise(resolve => { release = resolve }), store = new AppStore('ws://localhost:0/')
  await store.disableTranscriptCache()
  vi.spyOn(store.transport, 'request').mockImplementation((async (method: string) => method === 'session/prepare-eviction' ? { ...fence, identity: digest(original) } : method === 'session/cache-snapshot' ? ++snapshots === 1 ? { session: original, watermark: fence, identity: digest(original) } : held : null) as never)
  const handlers = (store.transport as unknown as { handlers: TransportEvents }).handlers
  handlers.onEvent(runtime, { type: 'session/started', session: original });expect(await store.unloadTranscript(runtime, first)).toBe(true)
  handlers.onEvent(runtime, { type: 'turn/started', sessionId: first, turn: { id: tid, status: 'inProgress', items: [] } }, { ...fence, sequence: 2, revision: 2 })
  handlers.onEvent(runtime, { type: 'item/started', sessionId: first, turnId: tid, item: initial }, { ...fence, sequence: 3, revision: 3 })
  handlers.onEvent(runtime, { type: 'item/completed', sessionId: first, turnId: tid, item: complete }, { ...fence, sequence: 4, revision: 4 })
  handlers.onEvent(runtime, { type: 'turn/completed', sessionId: first, turn: updated.turns[0]! }, { ...fence, sequence: 5, revision: 5 })
  release({ session: updated, watermark: { ...fence, sequence: 5, revision: 5 }, identity: digest(updated) })
  await vi.waitFor(() => expect(store.getSnapshot().sessions.get(key)?.turns).toEqual(updated.turns))
})

it.each(['key-order', 'array-order'] as const)('uses canonical wire equality for %s', async kind => {
  const one = { type: 'text' as const, text: 'first' }, two = { type: 'text' as const, text: 'second' }
  const reordered = { text: 'first', type: 'text' as const }
  const original: Session = { ...body(first), turns: [{ id: turnId('turn'), status: 'completed', items: [{ id: itemId('item'), type: 'userMessage', content: [one, two] }] }] }
  const observed: Session = { ...original, turns: [{ ...original.turns[0]!, items: [{ id: itemId('item'), type: 'userMessage', content: [reordered, two] }] }] }
  const snapshot: Session = kind === 'key-order' ? original : { ...original, turns: [{ ...original.turns[0]!, items: [{ id: itemId('item'), type: 'userMessage', content: [two, one] }] }] }
  const key = sessionKey(runtime, first); let release!: (value: unknown) => void, snapshots = 0
  const held = new Promise(resolve => { release = resolve }), store = new AppStore('ws://localhost:0/')
  await store.disableTranscriptCache()
  vi.spyOn(store.transport, 'request').mockImplementation((async (method: string) => method === 'session/prepare-eviction' ? { ...fence, identity: digest(original) } : method === 'session/cache-snapshot' ? ++snapshots === 1 ? { session: original, watermark: fence, identity: digest(original) } : held : null) as never)
  const handlers = (store.transport as unknown as { handlers: TransportEvents }).handlers
  handlers.onEvent(runtime, { type: 'session/started', session: original });expect(await store.unloadTranscript(runtime, first)).toBe(true)
  handlers.onEvent(runtime, { type: 'session/started', session: observed }, { ...fence, sequence: 2, revision: 2 })
  release({ session: snapshot, watermark: { ...fence, sequence: 2, revision: 2 }, identity: digest(snapshot) })
  expect(await store.restoreTranscript(runtime, first)).toBe(kind === 'key-order')
  expect(store.getSnapshot().sessions.get(key)?.itemsLoaded).toBe(kind === 'key-order')
})

it.each(['stale', 'wrong-generation', 'gap'] as const)('keeps captured data protected after a %s exit invalidation', async failure => {
  const original = body(first), key = sessionKey(runtime, first); let release!: (value: unknown) => void, snapshots = 0
  const held = new Promise(resolve => { release = resolve }), store = new AppStore('ws://localhost:0/')
  await store.disableTranscriptCache()
  vi.spyOn(store.transport, 'request').mockImplementation((async (method: string) => method === 'session/prepare-eviction' ? { ...fence, identity: digest(original) } : method === 'session/cache-snapshot' ? ++snapshots === 1 ? { session: original, watermark: fence, identity: digest(original) } : held : null) as never)
  const handlers = (store.transport as unknown as { handlers: TransportEvents }).handlers
  handlers.onEvent(runtime, { type: 'session/started', session: original }); expect(await store.unloadTranscript(runtime, first)).toBe(true)
  handlers.onEvent(runtime, { type: 'session/started', session: original }, { ...fence, sequence: 2, revision: 2 })
  handlers.onNotification({ method: 'session/cache-invalidated', params: { runtime, sessionId: first, watermark: { ...fence, generation: failure === 'wrong-generation' ? 'other' : fence.generation, sequence: failure === 'stale' ? 2 : failure === 'gap' ? 4 : 3, revision: 3 } } })
  release({ session: original, watermark: { ...fence, sequence: 5, revision: 5 }, identity: digest(original) })
  await store.restoreTranscript(runtime, first) // settle the earlier in-flight read
  expect(await store.restoreTranscript(runtime, first)).toBe(false)
  expect(store.getSnapshot().sessions.get(key)).toMatchObject({ itemsLoaded: false, turns: [] })
})

it('covers usage, settings, options, memory and goal only when all snapshot fields agree', async () => {
  const original = body(first), key = sessionKey(runtime, first)
  const tokens = { totalTokens: 3, inputTokens: 1, cachedInputTokens: 0, outputTokens: 2, reasoningOutputTokens: 0 }
  const usage = { total: tokens, last: tokens }, settings = { cwd: '/example', model: 'synthetic' }, goal = { objective: 'Synthetic', status: 'active' as const, tokensUsed: 0, timeUsedSeconds: 0 }
  const updated: Session = { ...original, usage, settings, options: [], memory: true, goal }
  let release!: (value: unknown) => void, snapshots = 0
  const held = new Promise(resolve => { release = resolve }), store = new AppStore('ws://localhost:0/')
  await store.disableTranscriptCache()
  vi.spyOn(store.transport, 'request').mockImplementation((async (method: string) => method === 'session/prepare-eviction' ? { ...fence, identity: digest(original) } : method === 'session/cache-snapshot' ? ++snapshots === 1 ? { session: original, watermark: fence, identity: digest(original) } : held : null) as never)
  const handlers = (store.transport as unknown as { handlers: TransportEvents }).handlers
  handlers.onEvent(runtime, { type: 'session/started', session: original }); expect(await store.unloadTranscript(runtime, first)).toBe(true)
  handlers.onEvent(runtime, { type: 'usage/updated', sessionId: first, usage }, { ...fence, sequence: 2, revision: 2 })
  handlers.onEvent(runtime, { type: 'session/settings', sessionId: first, settings }, { ...fence, sequence: 3, revision: 3 })
  handlers.onEvent(runtime, { type: 'session/options', sessionId: first, options: [] }, { ...fence, sequence: 4, revision: 4 })
  handlers.onEvent(runtime, { type: 'session/memory', sessionId: first, enabled: true }, { ...fence, sequence: 5, revision: 5 })
  handlers.onEvent(runtime, { type: 'session/goal', sessionId: first, goal }, { ...fence, sequence: 6, revision: 6 })
  release({ session: updated, watermark: { ...fence, sequence: 6, revision: 6 }, identity: digest(updated) })
  await vi.waitFor(() => expect(store.getSnapshot().sessions.get(key)).toMatchObject({ itemsLoaded: true, usage, settings, options: [], memory: true, goal }))
})

it('keeps a reasoning turn protected when the final turn status is unobserved', async () => {
  const original = body(first), key = sessionKey(runtime, first), tid = turnId('turn'), iid = itemId('reason')
  const item = { id: iid, type: 'reasoning' as const, summary: ['Synthetic'], content: [] as string[] }
  const updated: Session = { ...original, turns: [{ id: tid, status: 'completed', items: [item] }] }
  let release!: (value: unknown) => void, snapshots = 0
  const held = new Promise(resolve => { release = resolve }), store = new AppStore('ws://localhost:0/')
  await store.disableTranscriptCache()
  vi.spyOn(store.transport, 'request').mockImplementation((async (method: string) => method === 'session/prepare-eviction' ? { ...fence, identity: digest(original) } : method === 'session/cache-snapshot' ? ++snapshots === 1 ? { session: original, watermark: fence, identity: digest(original) } : held : null) as never)
  const handlers = (store.transport as unknown as { handlers: TransportEvents }).handlers
  handlers.onEvent(runtime, { type: 'session/started', session: original }); expect(await store.unloadTranscript(runtime, first)).toBe(true)
  handlers.onEvent(runtime, { type: 'turn/started', sessionId: first, turn: { id: tid, status: 'inProgress', items: [] } }, { ...fence, sequence: 2, revision: 2 })
  handlers.onEvent(runtime, { type: 'item/delta', sessionId: first, turnId: tid, itemId: iid, delta: { kind: 'reasoningSummary', index: 0, text: 'Synthetic' } }, { ...fence, sequence: 3, revision: 3 })
  handlers.onEvent(runtime, { type: 'item/completed', sessionId: first, turnId: tid, item }, { ...fence, sequence: 4, revision: 4 })
  release({ session: updated, watermark: { ...fence, sequence: 4, revision: 4 }, identity: digest(updated) })
  await store.restoreTranscript(runtime, first) // settle the earlier in-flight read
  expect(await store.restoreTranscript(runtime, first)).toBe(false)
  expect(store.getSnapshot().sessions.get(key)).toMatchObject({ itemsLoaded: false, turns: [] })
})

it('keeps unhandled item families protected even when a snapshot contains the item', async () => {
  const original = body(first), key = sessionKey(runtime, first), tid = turnId('turn')
  const item = { id: itemId('tool'), type: 'subagent' as const, action: 'synthetic', status: 'completed' as const, members: [] }
  const updated: Session = { ...original, turns: [{ id: tid, status: 'completed', items: [item] }] }
  let release!: (value: unknown) => void, snapshots = 0
  const held = new Promise(resolve => { release = resolve }), store = new AppStore('ws://localhost:0/')
  await store.disableTranscriptCache()
  vi.spyOn(store.transport, 'request').mockImplementation((async (method: string) => method === 'session/prepare-eviction' ? { ...fence, identity: digest(original) } : method === 'session/cache-snapshot' ? ++snapshots === 1 ? { session: original, watermark: fence, identity: digest(original) } : held : null) as never)
  const handlers = (store.transport as unknown as { handlers: TransportEvents }).handlers
  handlers.onEvent(runtime, { type: 'session/started', session: original }); expect(await store.unloadTranscript(runtime, first)).toBe(true)
  handlers.onEvent(runtime, { type: 'turn/started', sessionId: first, turn: { id: tid, status: 'inProgress', items: [] } }, { ...fence, sequence: 2, revision: 2 })
  handlers.onEvent(runtime, { type: 'item/completed', sessionId: first, turnId: tid, item }, { ...fence, sequence: 3, revision: 3 })
  handlers.onEvent(runtime, { type: 'turn/completed', sessionId: first, turn: updated.turns[0]! }, { ...fence, sequence: 4, revision: 4 })
  release({ session: updated, watermark: { ...fence, sequence: 4, revision: 4 }, identity: digest(updated) })
  await store.restoreTranscript(runtime, first) // settle the snapshot started before the later events
  expect(await store.restoreTranscript(runtime, first)).toBe(false)
  expect(store.getSnapshot().sessions.get(key)).toMatchObject({ itemsLoaded: false, turns: [] })
})

it.each([
  { name: 'reasoning summary', initial: { type: 'reasoning', summary: [], content: [] }, delta: { kind: 'reasoningSummary', index: 0, text: 'old' }, final: { type: 'reasoning', summary: ['full'], content: [] } },
  { name: 'reasoning summary part', initial: { type: 'reasoning', summary: [], content: [] }, delta: { kind: 'reasoningSummaryPart', index: 0 }, final: { type: 'reasoning', summary: ['full'], content: [] } },
  { name: 'reasoning detail', initial: { type: 'reasoning', summary: [], content: [] }, delta: { kind: 'reasoningText', index: 0, text: 'old' }, final: { type: 'reasoning', summary: [], content: ['full'] } },
  { name: 'plan text', initial: { type: 'plan', text: '' }, delta: { kind: 'planText', text: 'old' }, final: { type: 'plan', text: 'full' } },
  { name: 'file change', initial: { type: 'fileChange', changes: [], status: 'inProgress' }, delta: { kind: 'fileChangePatch', changes: [{ path: '/example/a', kind: { type: 'add' }, diff: 'old' }] }, final: { type: 'fileChange', changes: [{ path: '/example/a', kind: { type: 'add' }, diff: 'full' }], status: 'completed' } },
  { name: 'tool progress', initial: { type: 'toolCall', tool: 'synthetic', source: { kind: 'builtin' }, status: 'inProgress', args: {} }, delta: { kind: 'toolProgress', message: 'old' }, final: { type: 'toolCall', tool: 'synthetic', source: { kind: 'builtin' }, status: 'completed', args: {} } },
])('waits for matching full item completion for $name', async fixture => {
  const original = body(first), key = sessionKey(runtime, first), tid = turnId('turn'), iid = itemId('item')
  const initial = { id: iid, ...fixture.initial } as AgentItem, completed = { id: iid, ...fixture.final } as AgentItem
  const updated: Session = { ...original, turns: [{ id: tid, status: 'inProgress', items: [completed] }] }
  let snapshots = 0; const store = new AppStore('ws://localhost:0/')
  await store.disableTranscriptCache()
  vi.spyOn(store.transport, 'request').mockImplementation((async (method: string) => method === 'session/prepare-eviction' ? { ...fence, identity: digest(original) } : method === 'session/cache-snapshot' ? ++snapshots === 1 ? { session: original, watermark: fence, identity: digest(original) } : { session: updated, watermark: { ...fence, sequence: 5, revision: 5 }, identity: digest(updated) } : null) as never)
  const handlers = (store.transport as unknown as { handlers: TransportEvents }).handlers
  handlers.onEvent(runtime, { type: 'session/started', session: original }); expect(await store.unloadTranscript(runtime, first)).toBe(true)
  handlers.onEvent(runtime, { type: 'turn/started', sessionId: first, turn: { id: tid, status: 'inProgress', items: [] } }, { ...fence, sequence: 2, revision: 2 })
  handlers.onEvent(runtime, { type: 'item/started', sessionId: first, turnId: tid, item: initial }, { ...fence, sequence: 3, revision: 3 })
  handlers.onEvent(runtime, { type: 'item/delta', sessionId: first, turnId: tid, itemId: iid, delta: fixture.delta as ItemDelta }, { ...fence, sequence: 4, revision: 4 })
  await store.restoreTranscript(runtime, first)
  expect(await store.restoreTranscript(runtime, first)).toBe(false)
  expect(store.getSnapshot().sessions.get(key)?.itemsLoaded).toBe(false)
  handlers.onEvent(runtime, { type: 'item/completed', sessionId: first, turnId: tid, item: completed }, { ...fence, sequence: 5, revision: 5 })
  await vi.waitFor(() => expect(store.getSnapshot().sessions.get(key)?.turns).toEqual(updated.turns))
})

it('keeps a mismatched item completion and preceding reasoning delta protected', async () => {
  const original = body(first), key = sessionKey(runtime, first), tid = turnId('turn'), iid = itemId('item')
  const item: AgentItem = { id: iid, type: 'command', command: 'synthetic', cwd: '/example', origin: 'agent', status: 'completed', actions: [] }
  const updated: Session = { ...original, turns: [{ id: tid, status: 'inProgress', items: [item] }] }
  let snapshots = 0; const store = new AppStore('ws://localhost:0/')
  await store.disableTranscriptCache()
  vi.spyOn(store.transport, 'request').mockImplementation((async (method: string) => method === 'session/prepare-eviction' ? { ...fence, identity: digest(original) } : method === 'session/cache-snapshot' ? ++snapshots === 1 ? { session: original, watermark: fence, identity: digest(original) } : { session: updated, watermark: { ...fence, sequence: 4, revision: 4 }, identity: digest(updated) } : null) as never)
  const handlers = (store.transport as unknown as { handlers: TransportEvents }).handlers
  handlers.onEvent(runtime, { type: 'session/started', session: original }); expect(await store.unloadTranscript(runtime, first)).toBe(true)
  handlers.onEvent(runtime, { type: 'turn/started', sessionId: first, turn: { id: tid, status: 'inProgress', items: [] } }, { ...fence, sequence: 2, revision: 2 })
  handlers.onEvent(runtime, { type: 'item/delta', sessionId: first, turnId: tid, itemId: iid, delta: { kind: 'reasoningSummary', index: 0, text: 'Synthetic' } }, { ...fence, sequence: 3, revision: 3 })
  handlers.onEvent(runtime, { type: 'item/completed', sessionId: first, turnId: tid, item }, { ...fence, sequence: 4, revision: 4 })
  await store.restoreTranscript(runtime, first); expect(await store.restoreTranscript(runtime, first)).toBe(false)
  expect(store.getSnapshot().sessions.get(key)).toMatchObject({ itemsLoaded: false, turns: [] })
})

it('restores observed turn diff and plan only when the snapshot contains them', async () => {
  const original = body(first), key = sessionKey(runtime, first), tid = turnId('turn')
  const steps = [{ step: 'Synthetic step', status: 'inProgress' as const }]
  const updated: Session = { ...original, turns: [{ id: tid, status: 'inProgress', items: [], diff: 'Synthetic diff', plan: steps }] }
  let snapshots = 0; const store = new AppStore('ws://localhost:0/')
  await store.disableTranscriptCache()
  vi.spyOn(store.transport, 'request').mockImplementation((async (method: string) => method === 'session/prepare-eviction' ? { ...fence, identity: digest(original) } : method === 'session/cache-snapshot' ? ++snapshots === 1 ? { session: original, watermark: fence, identity: digest(original) } : { session: updated, watermark: { ...fence, sequence: 4, revision: 4 }, identity: digest(updated) } : null) as never)
  const handlers = (store.transport as unknown as { handlers: TransportEvents }).handlers
  handlers.onEvent(runtime, { type: 'session/started', session: original }); expect(await store.unloadTranscript(runtime, first)).toBe(true)
  handlers.onEvent(runtime, { type: 'turn/started', sessionId: first, turn: { id: tid, status: 'inProgress', items: [], diff: 'Old diff', plan: [{ step: 'Old step', status: 'pending' }] } }, { ...fence, sequence: 2, revision: 2 })
  handlers.onEvent(runtime, { type: 'turn/diff', sessionId: first, turnId: tid, diff: 'Synthetic diff' }, { ...fence, sequence: 3, revision: 3 })
  handlers.onEvent(runtime, { type: 'turn/plan', sessionId: first, turnId: tid, steps }, { ...fence, sequence: 4, revision: 4 })
  await vi.waitFor(() => expect(store.getSnapshot().sessions.get(key)?.turns).toEqual(updated.turns))
})

it('notifies publication listeners once for a released duplicate event', async () => {
  const original = body(first), key = sessionKey(runtime, first), tid = turnId('turn'), listener = vi.fn()
  const publication = { id: itemId('publication'), type: 'publication', reference: { kind: 'branch', repo: 'example/project', url: 'https://example.com', title: null, state: null, author: null, additions: null, deletions: null, files: null, excerpt: null, via: 'gh', signature: null, ref: 'synthetic', sha: 'abc', previousSha: null } } as AgentItem
  const updated: Session = { ...original, turns: [{ id: tid, status: 'inProgress', items: [publication] }] }
  let snapshots = 0; const store = new AppStore('ws://localhost:0/')
  await store.disableTranscriptCache(); store.onGitRecordChange(listener)
  vi.spyOn(store.transport, 'request').mockImplementation((async (method: string) => method === 'session/prepare-eviction' ? { ...fence, identity: digest(original) } : method === 'session/cache-snapshot' ? ++snapshots === 1 ? { session: original, watermark: fence, identity: digest(original) } : { session: updated, watermark: { ...fence, sequence: 3, revision: 3 }, identity: digest(updated) } : null) as never)
  const handlers = (store.transport as unknown as { handlers: TransportEvents }).handlers
  handlers.onEvent(runtime, { type: 'session/started', session: original }); expect(await store.unloadTranscript(runtime, first)).toBe(true)
  handlers.onEvent(runtime, { type: 'turn/started', sessionId: first, turn: { id: tid, status: 'inProgress', items: [] } }, { ...fence, sequence: 2, revision: 2 })
  const event = { type: 'item/completed' as const, sessionId: first, turnId: tid, item: publication }, next = { ...fence, sequence: 3, revision: 3 }
  handlers.onEvent(runtime, event, next); handlers.onEvent(runtime, event, next)
  expect(listener).toHaveBeenCalledTimes(1)
  await vi.waitFor(() => expect(store.getSnapshot().sessions.get(key)?.turns).toEqual(updated.turns))
})

it('does not treat turn completion as a rich item completion barrier', async () => {
  const original = body(first), key = sessionKey(runtime, first), tid = turnId('turn'), iid = itemId('reason')
  const item: AgentItem = { id: iid, type: 'reasoning', summary: ['full'], content: [] }
  const updated: Session = { ...original, turns: [{ id: tid, status: 'completed', items: [item] }] }
  let snapshots = 0; const store = new AppStore('ws://localhost:0/')
  await store.disableTranscriptCache()
  vi.spyOn(store.transport, 'request').mockImplementation((async (method: string) => method === 'session/prepare-eviction' ? { ...fence, identity: digest(original) } : method === 'session/cache-snapshot' ? ++snapshots === 1 ? { session: original, watermark: fence, identity: digest(original) } : { session: updated, watermark: { ...fence, sequence: 4, revision: 4 }, identity: digest(updated) } : null) as never)
  const handlers = (store.transport as unknown as { handlers: TransportEvents }).handlers
  handlers.onEvent(runtime, { type: 'session/started', session: original }); expect(await store.unloadTranscript(runtime, first)).toBe(true)
  handlers.onEvent(runtime, { type: 'turn/started', sessionId: first, turn: { id: tid, status: 'inProgress', items: [] } }, { ...fence, sequence: 2, revision: 2 })
  handlers.onEvent(runtime, { type: 'item/delta', sessionId: first, turnId: tid, itemId: iid, delta: { kind: 'reasoningSummary', index: 0, text: 'old' } }, { ...fence, sequence: 3, revision: 3 })
  handlers.onEvent(runtime, { type: 'turn/completed', sessionId: first, turn: updated.turns[0]! }, { ...fence, sequence: 4, revision: 4 })
  await store.restoreTranscript(runtime, first); expect(await store.restoreTranscript(runtime, first)).toBe(false)
  expect(store.getSnapshot().sessions.get(key)?.itemsLoaded).toBe(false)
})

it('protects an old replay item when the later delta has a different family', async () => {
  const tid = turnId('old'), iid = itemId('item')
  const original: Session = { ...body(first), turns: [{ id: tid, status: 'completed', items: [{ id: iid, type: 'assistantMessage', text: 'Synthetic original' }] }] }
  const key = sessionKey(runtime, first); let snapshots = 0; const store = new AppStore('ws://localhost:0/')
  await store.disableTranscriptCache()
  vi.spyOn(store.transport, 'request').mockImplementation((async (method: string) => method === 'session/prepare-eviction' ? { ...fence, identity: digest(original) } : method === 'session/cache-snapshot' ? ++snapshots === 1 ? { session: original, watermark: fence, identity: digest(original) } : { session: original, watermark: { ...fence, sequence: 4, revision: 4 }, identity: digest(original) } : null) as never)
  const handlers = (store.transport as unknown as { handlers: TransportEvents }).handlers
  handlers.onEvent(runtime, { type: 'session/started', session: original }); expect(await store.unloadTranscript(runtime, first)).toBe(true)
  handlers.onEvent(runtime, { type: 'session/started', session: original }, { ...fence, sequence: 2, revision: 2 })
  handlers.onEvent(runtime, { type: 'item/delta', sessionId: first, turnId: tid, itemId: iid, delta: { kind: 'reasoningSummary', index: 0, text: 'Synthetic conflict' } }, { ...fence, sequence: 3, revision: 3 })
  handlers.onEvent(runtime, { type: 'item/completed', sessionId: first, turnId: tid, item: { id: iid, type: 'reasoning', summary: ['Synthetic conflict'], content: [] } }, { ...fence, sequence: 4, revision: 4 })
  await store.restoreTranscript(runtime, first); expect(await store.restoreTranscript(runtime, first)).toBe(false)
  expect(store.getSnapshot().sessions.get(key)?.itemsLoaded).toBe(false)
})

it('notifies only once for an exact duplicate quarantined publication completion', async () => {
  const original = body(first), tid = turnId('turn'), iid = itemId('publication'), listener = vi.fn()
  const publication = { id: iid, type: 'publication', reference: { kind: 'branch', repo: 'example/project', url: 'https://example.com', title: null, state: null, author: null, additions: null, deletions: null, files: null, excerpt: null, via: 'gh', signature: null, ref: 'synthetic', sha: 'abc', previousSha: null } } as AgentItem
  const store = new AppStore('ws://localhost:0/'); await store.disableTranscriptCache(); store.onGitRecordChange(listener)
  vi.spyOn(store.transport, 'request').mockImplementation((async (method: string) => method === 'session/prepare-eviction' ? { ...fence, identity: digest(original) } : method === 'session/cache-snapshot' ? { session: original, watermark: fence, identity: digest(original) } : null) as never)
  const handlers = (store.transport as unknown as { handlers: TransportEvents }).handlers
  handlers.onEvent(runtime, { type: 'session/started', session: original }); expect(await store.unloadTranscript(runtime, first)).toBe(true)
  handlers.onEvent(runtime, { type: 'turn/started', sessionId: first, turn: { id: tid, status: 'inProgress', items: [] } }, { ...fence, sequence: 2, revision: 2 })
  handlers.onEvent(runtime, { type: 'item/delta', sessionId: first, turnId: tid, itemId: iid, delta: { kind: 'reasoningSummary', index: 0, text: 'Synthetic' } }, { ...fence, sequence: 3, revision: 3 })
  const event = { type: 'item/completed' as const, sessionId: first, turnId: tid, item: publication }, next = { ...fence, sequence: 4, revision: 4 }
  handlers.onEvent(runtime, event, next); handlers.onEvent(runtime, event, next)
  expect(listener).toHaveBeenCalledTimes(1)
})

it.each(['item-start', 'item-complete', 'turn-complete', 'session-replay'] as const)('protects a known item family against a conflicting %s before any delta', async kind => {
  const original = body(first), key = sessionKey(runtime, first), tid = turnId('turn'), iid = itemId('item')
  const user: AgentItem = { id: iid, type: 'userMessage', content: [{ type: 'text', text: 'Synthetic user' }] }
  const command: AgentItem = { id: iid, type: 'command', command: 'synthetic', cwd: '/example', origin: 'agent', status: 'completed', actions: [] }
  const initial = { id: tid, status: 'inProgress' as const, items: [user] }
  const final = { id: tid, status: kind === 'turn-complete' ? 'completed' as const : 'inProgress' as const, items: [command] }
  const updated: Session = { ...original, turns: [final] }; let snapshots = 0
  const quarantine = vi.spyOn(PendingTranscript.prototype, 'quarantine')
  const store = new AppStore('ws://localhost:0/'); await store.disableTranscriptCache()
  vi.spyOn(store.transport, 'request').mockImplementation((async (method: string) => method === 'session/prepare-eviction' ? { ...fence, identity: digest(original) } : method === 'session/cache-snapshot' ? ++snapshots === 1 ? { session: original, watermark: fence, identity: digest(original) } : { session: updated, watermark: { ...fence, sequence: 3, revision: 3 }, identity: digest(updated) } : null) as never)
  const handlers = (store.transport as unknown as { handlers: TransportEvents }).handlers
  handlers.onEvent(runtime, { type: 'session/started', session: original }); expect(await store.unloadTranscript(runtime, first)).toBe(true)
  handlers.onEvent(runtime, { type: 'turn/started', sessionId: first, turn: initial }, { ...fence, sequence: 2, revision: 2 })
  if (kind === 'item-start' || kind === 'item-complete') handlers.onEvent(runtime, { type: kind === 'item-start' ? 'item/started' : 'item/completed', sessionId: first, turnId: tid, item: command }, { ...fence, sequence: 3, revision: 3 })
  else if (kind === 'turn-complete') handlers.onEvent(runtime, { type: 'turn/completed', sessionId: first, turn: final }, { ...fence, sequence: 3, revision: 3 })
  else handlers.onEvent(runtime, { type: 'session/started', session: updated }, { ...fence, sequence: 3, revision: 3 })
  expect(quarantine).toHaveBeenCalledOnce()
  await store.restoreTranscript(runtime, first); expect(await store.restoreTranscript(runtime, first)).toBe(false)
  expect(store.getSnapshot().sessions.get(key)?.itemsLoaded).toBe(false)
})
