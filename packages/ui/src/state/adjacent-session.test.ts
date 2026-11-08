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

it.each(['read', 'resume'] as const)('keeps a turn completed while %s is pending', async phase => {
  const store = new AppStore('ws://localhost:0/'), id = sessionId('a'), stale = body('a')
  const waiting = deferred<Session>(), started = deferred<void>()
  vi.spyOn(store.transport, 'request').mockImplementation(((method: string) => {
    if (method === `session/${phase}`) { started.resolve(); return waiting.promise }
    return Promise.resolve(stale)
  }) as never)
  const handlers = (store.transport as unknown as { handlers: { onEvent(runtime: unknown, event: unknown): void } }).handlers
  handlers.onEvent(runtime, { type: 'session/started', session: stale })
  const pending = store.openAdjacentSession(id, runtime)
  await started.promise
  const turn = { id: 'new-turn', status: 'completed', items: [{ id: 'answer', type: 'assistantMessage', text: 'Finished while waiting' }] }
  handlers.onEvent(runtime, { type: 'turn/started', sessionId: id, turn: { ...turn, status: 'inProgress', items: [] } })
  handlers.onEvent(runtime, { type: 'item/started', sessionId: id, turnId: turn.id, item: turn.items[0] })
  handlers.onEvent(runtime, { type: 'turn/completed', sessionId: id, turn })
  waiting.resolve(stale); await pending
  expect(store.getSnapshot().sessions.get(sessionKey(runtime, id))?.turns).toMatchObject([turn])
})

it.each(['read', 'resume'] as const)('keeps the held body unavailable when the runtime disappears during %s', async phase => {
  const store = new AppStore('ws://localhost:0/'), id = sessionId('a'), held = body('a')
  const waiting = deferred<Session>(), started = deferred<void>()
  const request = vi.spyOn(store.transport, 'request').mockImplementation(((method: string) => {
    if (method === `session/${phase}`) { started.resolve(); return waiting.promise }
    return Promise.resolve(held)
  }) as never)
  const handlers = (store.transport as unknown as { handlers: { onEvent(runtime: unknown, event: unknown): void; onNotification(value: unknown): void } }).handlers
  handlers.onEvent(runtime, { type: 'session/started', session: held })
  const pending = store.openAdjacentSession(id, runtime)
  await started.promise
  handlers.onNotification({ method: 'runtime/removed', params: { runtime } })
  waiting.resolve({ ...held, title: 'stale response' }); await pending
  expect(store.getSnapshot().sessions.get(sessionKey(runtime, id))?.title).toBe('a')
  expect(store.getSnapshot().adjacentSession).toMatchObject({ loading: false, error: expect.stringMatching(/unavailable/i) })
  const calls = request.mock.calls.length
  await store.openAdjacentSession(id, runtime)
  expect(request.mock.calls).toHaveLength(calls)
})

it('reconnects the current reader and rejects an earlier connection’s late read', async () => {
  const store = new AppStore('ws://localhost:0/'), id = sessionId('a'), first = deferred<Session>(), second = deferred<Session>()
  let reads = 0
  vi.spyOn(store.transport, 'request').mockImplementation(((method: string) => {
    if (method === 'session/read') return ++reads === 1 ? first.promise : second.promise
    if (method === 'session/resume') return Promise.resolve(body('a'))
    return Promise.resolve({})
  }) as never)
  const handlers = (store.transport as unknown as { handlers: { onStatus(value: string): void } }).handlers
  const pending = store.openAdjacentSession(id, runtime)
  handlers.onStatus('reconnecting')
  expect(store.getSnapshot().adjacentSession?.error).toContain('Connection lost')
  handlers.onStatus('open')
  expect(reads).toBe(2)
  second.resolve({ ...body('a'), title: 'current' })
  await vi.waitFor(() => expect(store.getSnapshot().adjacentSession?.loading).toBe(false))
  first.resolve({ ...body('a'), title: 'stale' }); await pending
  expect(store.getSnapshot().adjacentSession?.key).toBe(sessionKey(runtime, id))
  expect(store.getSnapshot().sessions.get(sessionKey(runtime, id))?.title).not.toBe('stale')
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

const missingFolderStore = async () => {
  const store = new AppStore('ws://localhost:0/')
  const session = (id: string) => ({ ...body(id), cwd: id === 'other' ? '/other' : '/project' })
  const request = vi.spyOn(store.transport, 'request').mockImplementation((async (method: string, params: { sessionId: string }) => {
    if (method === 'session/read') return session(params.sessionId)
    if (method === 'session/resume') throw Object.assign(new Error('The folder no longer exists'), { code: 'sessionFolderGone' })
    return {}
  }) as never)
  await store.openSession(sessionId('a'), { runtime })
  await store.openSession(sessionId('other'), { runtime })
  expect([...store.getSnapshot().foldersGone.keys()].sort()).toEqual(['/other', '/project'])
  return { store, request, session }
}

it('clears only the resumed folder after an adjacent conversation reopens', async () => {
  const { store, request, session } = await missingFolderStore()
  const main = store.getSnapshot().activeSessionKey, workspace = store.getSnapshot().workspace
  request.mockImplementation((async (method: string) => method === 'session/read' || method === 'session/resume' ? session('a') : {}) as never)
  await store.openAdjacentSession(sessionId('a'), runtime)
  expect(store.getSnapshot().foldersGone.has('/project')).toBe(false)
  expect(store.getSnapshot().foldersGone.has('/other')).toBe(true)
  expect(store.getSnapshot().activeSessionKey).toBe(main)
  expect(store.getSnapshot().workspace).toBe(workspace)
})

it.each(['read-refused', 'resume-refused', 'wrong-read', 'wrong-resume'] as const)('retains missing-folder facts for an adjacent %s', async failure => {
  const { store, request, session } = await missingFolderStore()
  request.mockImplementation((async (method: string) => {
    if (method === 'session/read' && failure === 'read-refused') throw new Error('read refused')
    if (method === 'session/resume' && failure === 'resume-refused') throw new Error('resume refused')
    if (method === 'session/read' && failure === 'wrong-read') return session('other')
    if (method === 'session/resume' && failure === 'wrong-resume') return session('other')
    return method === 'session/read' || method === 'session/resume' ? session('a') : {}
  }) as never)
  await store.openAdjacentSession(sessionId('a'), runtime)
  expect([...store.getSnapshot().foldersGone.keys()].sort()).toEqual(['/other', '/project'])
  expect(store.getSnapshot().adjacentSession?.error).toBeTruthy()
})

it('does not clear a missing folder for a stale adjacent resume', async () => {
  const { store, request, session } = await missingFolderStore()
  const waiting = deferred<Session>(), started = deferred<void>()
  request.mockImplementation(((method: string) => {
    if (method === 'session/read') return Promise.resolve(session('a'))
    if (method === 'session/resume') { started.resolve(); return waiting.promise }
    return Promise.resolve({})
  }) as never)
  const opening = store.openAdjacentSession(sessionId('a'), runtime)
  await started.promise
  store.closeAdjacentSession()
  waiting.resolve(session('a')); await opening
  expect([...store.getSnapshot().foldersGone.keys()].sort()).toEqual(['/other', '/project'])
})

it.each([
  { kind: 'settings' as const, route: { kind: 'section' as const, section: 'general' as const, focus: null } },
  { kind: 'library' as const, section: 'mcp' as const },
  { kind: 'dashboard' as const, view: 'overview' as const, scope: null },
])('returns to the current work when opening an adjacent reader from $kind', async destination => {
  const store = new AppStore('ws://localhost:0/'), main = sessionId('main'), side = sessionId('side')
  const request = vi.spyOn(store.transport, 'request').mockImplementation((async (method: string, params: { sessionId?: string }) =>
    method === 'session/read' || method === 'session/resume' ? body(params.sessionId ?? 'main') : {}) as never)
  await store.openSession(main, { runtime })
  const active = store.getSnapshot().activeSessionKey, workspace = store.getSnapshot().workspace
  const layout = store.getSnapshot().layout
  store.openDestination(destination)
  expect(store.getSnapshot().workbench.navigation.current.kind).toBe(destination.kind)
  await store.openAdjacentSession(side, runtime)
  expect(store.getSnapshot().workbench.navigation.current.kind).toBe('work')
  expect(store.getSnapshot().activeSessionKey).toBe(active)
  expect(store.getSnapshot().workspace).toBe(workspace)
  expect(store.getSnapshot().layout).toEqual(layout)
  expect(store.getSnapshot().adjacentSession?.key).toBe(sessionKey(runtime, side))
  expect(request.mock.calls.some(([method]) => method === 'session/close' || method === 'turn/send')).toBe(false)
})

it.each(['read', 'resume'] as const)('preserves fresh untouched fields while a different item streams during %s', async phase => {
  const store = new AppStore('ws://localhost:0/'), id = sessionId('a')
  const stale = { ...body('a'), turns: [
    { id: 'old', status: 'completed', startedAt: 1, completedAt: 2, diff: 'old diff', items: [{ id: 'old-item', type: 'assistantMessage', text: 'old cached text' }] },
    { id: 'active', status: 'inProgress', items: [{ id: 'untouched', type: 'assistantMessage', text: 'cached sibling' }, { id: 'stream', type: 'assistantMessage', text: 'start' }] },
  ] } as unknown as Session
  const fresh = { ...stale, turns: [
    { id: 'old', status: 'completed', startedAt: 10, completedAt: 20, diff: 'fresh diff', items: [{ id: 'old-item', type: 'assistantMessage', text: 'fresh historic text' }] },
    { id: 'active', status: 'inProgress', items: [{ id: 'untouched', type: 'assistantMessage', text: 'fresh sibling' }, { id: 'stream', type: 'assistantMessage', text: 'start' }] },
  ] } as unknown as Session
  const waiting = deferred<Session>(), entered = deferred<void>()
  vi.spyOn(store.transport, 'request').mockImplementation(((method: string) => {
    if (method === `session/${phase}`) { entered.resolve(); return waiting.promise }
    return Promise.resolve(fresh)
  }) as never)
  const handlers = (store.transport as unknown as { handlers: { onEvent(runtime: unknown, event: unknown): void } }).handlers
  handlers.onEvent(runtime, { type: 'session/started', session: stale })
  const opening = store.openAdjacentSession(id, runtime)
  await entered.promise
  handlers.onEvent(runtime, { type: 'item/delta', sessionId: id, turnId: 'active', itemId: 'stream', delta: { kind: 'assistantText', text: ' live' } })
  waiting.resolve(fresh); await opening
  const turns = store.getSnapshot().sessions.get(sessionKey(runtime, id))!.turns
  expect(turns.find(turn => turn.id === 'old')).toMatchObject(fresh.turns[0]!)
  expect(turns.find(turn => turn.id === 'active')?.items).toMatchObject([
    { id: 'untouched', text: 'fresh sibling' }, { id: 'stream', text: 'start live' },
  ])
})

it('does not replay a streamed delta already present in the read', async () => {
  const store = new AppStore('ws://localhost:0/'), id = sessionId('a'), read = deferred<Session>()
  const stale = { ...body('a'), turns: [{ id: 'turn', status: 'inProgress', items: [{ id: 'item', type: 'assistantMessage', text: 'start' }] }] } as unknown as Session
  const fresh = { ...stale, turns: [{ id: 'turn', status: 'inProgress', items: [{ id: 'item', type: 'assistantMessage', text: 'start live' }] }] } as unknown as Session
  vi.spyOn(store.transport, 'request').mockImplementation(((method: string) => method === 'session/read' ? read.promise : Promise.resolve(fresh)) as never)
  const handlers = (store.transport as unknown as { handlers: { onEvent(runtime: unknown, event: unknown): void } }).handlers
  handlers.onEvent(runtime, { type: 'session/started', session: stale })
  const opening = store.openAdjacentSession(id, runtime)
  handlers.onEvent(runtime, { type: 'item/delta', sessionId: id, turnId: 'turn', itemId: 'item', delta: { kind: 'assistantText', text: ' live' } })
  read.resolve(fresh); await opening
  expect(store.getSnapshot().sessions.get(sessionKey(runtime, id))?.turns[0]?.items[0]).toMatchObject({ text: 'start live' })
})

it('keeps the held body and reports an ambiguous changed field', async () => {
  const store = new AppStore('ws://localhost:0/'), id = sessionId('a'), read = deferred<Session>()
  const before = { ...body('a'), turns: [{ id: 'turn', status: 'inProgress', items: [{ id: 'item', type: 'assistantMessage', text: 'start' }] }] } as unknown as Session
  const different = { ...before, turns: [{ id: 'turn', status: 'inProgress', items: [{ id: 'item', type: 'assistantMessage', text: 'different fresh text' }] }] } as unknown as Session
  vi.spyOn(store.transport, 'request').mockImplementation(((method: string) => method === 'session/read' ? read.promise : Promise.resolve(different)) as never)
  const handlers = (store.transport as unknown as { handlers: { onEvent(runtime: unknown, event: unknown): void } }).handlers
  handlers.onEvent(runtime, { type: 'session/started', session: before })
  const opening = store.openAdjacentSession(id, runtime)
  handlers.onEvent(runtime, { type: 'item/delta', sessionId: id, turnId: 'turn', itemId: 'item', delta: { kind: 'assistantText', text: ' live' } })
  read.resolve(different); await opening
  expect(store.getSnapshot().sessions.get(sessionKey(runtime, id))?.turns[0]?.items[0]).toMatchObject({ text: 'start live' })
  expect(store.getSnapshot().adjacentSession?.error).toMatch(/changed.*Retry/i)
})

it('preserves accepted title and status events without replacing untouched fresh turns', async () => {
  const store = new AppStore('ws://localhost:0/'), id = sessionId('a'), read = deferred<Session>()
  const before = { ...body('a'), title: 'old', turns: [{ id: 'history', status: 'completed', items: [{ id: 'item', type: 'assistantMessage', text: 'old' }] }] } as unknown as Session
  const fresh = { ...before, turns: [{ id: 'history', status: 'completed', items: [{ id: 'item', type: 'assistantMessage', text: 'fresh' }] }] } as unknown as Session
  vi.spyOn(store.transport, 'request').mockImplementation(((method: string) => method === 'session/read' ? read.promise : Promise.resolve(fresh)) as never)
  const handlers = (store.transport as unknown as { handlers: { onEvent(runtime: unknown, event: unknown): void } }).handlers
  handlers.onEvent(runtime, { type: 'session/started', session: before })
  const opening = store.openAdjacentSession(id, runtime)
  handlers.onEvent(runtime, { type: 'session/title', sessionId: id, title: 'updated' })
  handlers.onEvent(runtime, { type: 'session/status', sessionId: id, status: { type: 'active' } })
  read.resolve(fresh); await opening
  expect(store.getSnapshot().sessions.get(sessionKey(runtime, id))).toMatchObject({ title: 'updated', status: { type: 'active' }, turns: [{ items: [{ text: 'fresh' }] }] })
})

it.each(['duplicate', 'gap'] as const)('handles a fenced %s event while an adjacent read waits', async variant => {
  const store = new AppStore('ws://localhost:0/'), id = sessionId('fenced'), read = deferred<Session>()
  const original = { ...body('fenced'), turns: [{ id: 'turn', status: 'completed', items: [{ id: 'item', type: 'assistantMessage', text: 'start' }] }] } as unknown as Session
  const watermark = { epoch: 'epoch', generation: 'generation', revision: 1, sequence: 1 }
  const identity = transcriptFingerprint(canonicalTranscriptBody(original.turns).canonical)
  vi.spyOn(store.transport, 'request').mockImplementation(((method: string) => {
    if (method === 'session/cache-snapshot') return Promise.resolve({ session: original, watermark, identity })
    if (method === 'session/read') return read.promise
    return Promise.resolve(original)
  }) as never)
  const handlers = (store.transport as unknown as { handlers: { onEvent(runtime: unknown, event: unknown, fence?: unknown): void } }).handlers
  handlers.onEvent(runtime, { type: 'session/started', session: original })
  expect(await store.verifyTranscriptCache(runtime, id)).toBe(true)
  const opening = store.openAdjacentSession(id, runtime)
  const event = { type: 'item/delta', sessionId: id, turnId: 'turn', itemId: 'item', delta: { kind: 'assistantText', text: ' live' } }
  const fence = { ...watermark, revision: 2, sequence: variant === 'gap' ? 3 : 2 }
  handlers.onEvent(runtime, event, fence)
  if (variant === 'duplicate') handlers.onEvent(runtime, event, fence)
  read.resolve(original); await opening
  const result = store.getSnapshot()
  expect(result.sessions.get(sessionKey(runtime, id))?.turns[0]?.items[0]).toMatchObject({ text: 'start live' })
  if (variant === 'gap') expect(result.adjacentSession?.error).toMatch(/complete event sequence/i)
  else expect(result.adjacentSession?.error).toBeNull()
})

it('reports an uncertain first read when an event arrives before any body is held', async () => {
  const store = new AppStore('ws://localhost:0/'), id = sessionId('unseen'), read = deferred<Session>()
  vi.spyOn(store.transport, 'request').mockImplementation(((method: string) => method === 'session/read' ? read.promise : Promise.resolve(body('unseen'))) as never)
  const handlers = (store.transport as unknown as { handlers: { onEvent(runtime: unknown, event: unknown): void } }).handlers
  const opening = store.openAdjacentSession(id, runtime)
  handlers.onEvent(runtime, { type: 'turn/started', sessionId: id, turn: { id: 'new', status: 'inProgress', items: [] } })
  read.resolve(body('unseen')); await opening
  expect(store.getSnapshot().adjacentSession?.error).toMatch(/covering snapshot/i)
  expect(store.getSnapshot().sessions.has(sessionKey(runtime, id))).toBe(false)
})

it('uses a covering fenced Host snapshot for a first read while a turn arrives', async () => {
  const store = new AppStore('ws://localhost:0/'), id = sessionId('unseen'), read = deferred<Session>(), snapshot = deferred<unknown>(), snapshotRequested = deferred<void>()
  const stale = body('unseen'), turn = { id: 'new', status: 'completed', items: [{ id: 'answer', type: 'assistantMessage', text: 'Synthetic completed answer' }] }
  const covered = { ...stale, turns: [turn] } as unknown as Session
  const draftKey = sessionKey(runtime, id)
  store.drafts.setLive(draftKey, { text: 'synthetic draft', attachments: [] })
  vi.spyOn(store.transport, 'request').mockImplementation(((method: string) => {
    if (method === 'session/read') return read.promise
    if (method === 'session/cache-snapshot') { snapshotRequested.resolve(); return snapshot.promise }
    if (method === 'session/resume') return Promise.resolve(covered)
    return Promise.resolve({})
  }) as never)
  const handlers = (store.transport as unknown as { handlers: { onEvent(runtime: unknown, event: unknown, fence?: unknown): void } }).handlers
  const opening = store.openAdjacentSession(id, runtime)
  handlers.onEvent(runtime, { type: 'turn/started', sessionId: id, turn: { ...turn, status: 'inProgress', items: [] } }, { epoch: 'e', generation: 'g', revision: 1, sequence: 1 })
  read.resolve(stale); await snapshotRequested.promise
  handlers.onEvent(runtime, { type: 'turn/completed', sessionId: id, turn }, { epoch: 'e', generation: 'g', revision: 2, sequence: 2 })
  snapshot.resolve({ session: covered, identity: transcriptFingerprint(canonicalTranscriptBody(covered.turns).canonical), watermark: { epoch: 'e', generation: 'g', revision: 2, sequence: 2 } })
  await opening
  expect(store.getSnapshot().adjacentSession?.error).toBeNull()
  expect(store.getSnapshot().sessions.get(draftKey)?.turns).toMatchObject([turn])
  expect(store.drafts.live(draftKey)?.text).toBe('synthetic draft')
})

it.each(['null', 'behind', 'gap', 'unsequenced', 'bad-identity', 'generation'] as const)('refuses a first-read snapshot with %s evidence', async mode => {
  const store = new AppStore('ws://localhost:0/'), id = sessionId('unseen'), read = deferred<Session>()
  const stale = body('unseen'), turn = { id: 'new', status: 'inProgress', items: [] }
  const covered = { ...stale, turns: [turn] } as unknown as Session
  const fence = { epoch: 'e', generation: 'g', revision: 1, sequence: 1 }
  const answer = mode === 'null' ? null : { session: covered,
    identity: mode === 'bad-identity' ? '0'.repeat(64) : transcriptFingerprint(canonicalTranscriptBody(covered.turns).canonical),
    watermark: { ...fence, generation: mode === 'generation' ? 'different' : 'g', sequence: mode === 'behind' ? 0 : mode === 'gap' ? 3 : 1, revision: mode === 'gap' ? 3 : 1 } }
  vi.spyOn(store.transport, 'request').mockImplementation(((method: string) => method === 'session/read' ? read.promise : method === 'session/cache-snapshot' ? Promise.resolve(answer) : Promise.resolve(covered)) as never)
  const handlers = (store.transport as unknown as { handlers: { onEvent(runtime: unknown, event: unknown, fence?: unknown): void } }).handlers
  const opening = store.openAdjacentSession(id, runtime)
  handlers.onEvent(runtime, { type: 'turn/started', sessionId: id, turn }, mode === 'unsequenced' ? undefined : fence)
  if (mode === 'gap') handlers.onEvent(runtime, { type: 'turn/diff', sessionId: id, turnId: 'new', diff: 'synthetic' }, { ...fence, revision: 3, sequence: 3 })
  read.resolve(stale); await opening
  expect(store.getSnapshot().adjacentSession?.error).toMatch(/covering snapshot/i)
  expect(store.getSnapshot().sessions.has(sessionKey(runtime, id))).toBe(false)
})

it('retains a pending local notice when a first-read Host snapshot covers the turn', async () => {
  const store = new AppStore('ws://localhost:0/'), id = sessionId('unseen'), read = deferred<Session>()
  const stale = body('unseen'), turn = { id: 'new', status: 'completed', items: [{ id: 'answer', type: 'assistantMessage', text: 'Synthetic answer' }] }
  const covered = { ...stale, turns: [turn] } as unknown as Session
  const watermark = { epoch: 'e', generation: 'g', revision: 2, sequence: 2 }
  vi.spyOn(store.transport, 'request').mockImplementation(((method: string) => method === 'session/read' ? read.promise : method === 'session/cache-snapshot'
    ? Promise.resolve({ session: covered, watermark, identity: transcriptFingerprint(canonicalTranscriptBody(covered.turns).canonical) }) : Promise.resolve(covered)) as never)
  const handlers = (store.transport as unknown as { handlers: { onEvent(runtime: unknown, event: unknown, fence?: unknown): void } }).handlers
  const opening = store.openAdjacentSession(id, runtime)
  handlers.onEvent(runtime, { type: 'notice', sessionId: id, class: 'conversation', level: 'warning', message: 'Synthetic pending notice', id: 'notice-1' }, { ...watermark, sequence: 1, revision: 1 })
  handlers.onEvent(runtime, { type: 'turn/completed', sessionId: id, turn }, watermark)
  read.resolve(stale); await opening
  const items = store.getSnapshot().sessions.get(sessionKey(runtime, id))?.turns.flatMap(one => one.items) ?? []
  expect(items.some(item => item.type === 'notice' && item.text === 'Synthetic pending notice')).toBe(true)
  expect(store.getSnapshot().adjacentSession?.error).toBeNull()
})

it('refuses to replace an independently changed local body during a first-read snapshot', async () => {
  const store = new AppStore('ws://localhost:0/'), id = sessionId('unseen'), read = deferred<Session>(), snapshot = deferred<unknown>(), requested = deferred<void>()
  const created = { ...body('unseen'), settings: { cwd: '/project', model: 'before' } } as unknown as Session
  const watermark = { epoch: 'e', generation: 'g', revision: 1, sequence: 1 }
  vi.spyOn(store.transport, 'request').mockImplementation(((method: string) => {
    if (method === 'session/read') return read.promise
    if (method === 'session/cache-snapshot') { requested.resolve(); return snapshot.promise }
    return Promise.resolve({})
  }) as never)
  const handlers = (store.transport as unknown as { handlers: { onEvent(runtime: unknown, event: unknown, fence?: unknown): void; onNotification(event: unknown): void } }).handlers
  const opening = store.openAdjacentSession(id, runtime)
  handlers.onEvent(runtime, { type: 'session/started', session: created }, watermark)
  read.resolve(created); await requested.promise
  const key = sessionKey(runtime, id)
  await store.updateSettings({ model: 'locally-changed' }, key)
  handlers.onNotification({ method: 'session/indexChanged', params: { upserted: [{ ...created, archived: false }], removed: [] } })
  snapshot.resolve({ session: created, watermark, identity: transcriptFingerprint(canonicalTranscriptBody(created.turns).canonical) })
  await opening
  expect(store.getSnapshot().sessions.get(key)?.settings?.model).toBe('locally-changed')
  expect(store.getSnapshot().adjacentSession?.error).toMatch(/covering snapshot/i)
})

it('does not install a covering snapshot after the adjacent reader closes', async () => {
  const store = new AppStore('ws://localhost:0/'), id = sessionId('unseen'), read = deferred<Session>(), snapshot = deferred<unknown>(), requested = deferred<void>()
  const stale = body('unseen'), turn = { id: 'new', status: 'inProgress', items: [] }, covered = { ...stale, turns: [turn] } as unknown as Session
  const watermark = { epoch: 'e', generation: 'g', revision: 1, sequence: 1 }
  vi.spyOn(store.transport, 'request').mockImplementation(((method: string) => {
    if (method === 'session/read') return read.promise
    if (method === 'session/cache-snapshot') { requested.resolve(); return snapshot.promise }
    return Promise.resolve(covered)
  }) as never)
  const handlers = (store.transport as unknown as { handlers: { onEvent(runtime: unknown, event: unknown, fence?: unknown): void } }).handlers
  const opening = store.openAdjacentSession(id, runtime)
  handlers.onEvent(runtime, { type: 'turn/started', sessionId: id, turn }, watermark)
  read.resolve(stale); await requested.promise
  store.closeAdjacentSession()
  snapshot.resolve({ session: covered, watermark, identity: transcriptFingerprint(canonicalTranscriptBody(covered.turns).canonical) })
  await opening
  expect(store.getSnapshot().adjacentSession).toBeNull()
  expect(store.getSnapshot().sessions.has(sessionKey(runtime, id))).toBe(false)
})

it.each(['none', 'archive', 'title'] as const)('accepts a covering first-read snapshot with index metadata: %s', async indexUpdate => {
  const store = new AppStore('ws://localhost:0/'), id = sessionId('unseen'), read = deferred<Session>()
  const started = { ...body('unseen'), title: 'Synthetic side conversation' }
  const turn = { id: 'new', status: 'completed', items: [{ id: 'answer', type: 'assistantMessage', text: 'Synthetic completed answer' }] }
  const covered = { ...started, turns: [turn] } as unknown as Session
  const watermark = { epoch: 'e', generation: 'g', revision: 3, sequence: 3 }
  vi.spyOn(store.transport, 'request').mockImplementation(((method: string) => method === 'session/read' ? read.promise : method === 'session/cache-snapshot'
    ? Promise.resolve({ session: covered, watermark, identity: transcriptFingerprint(canonicalTranscriptBody(covered.turns).canonical) }) : Promise.resolve(covered)) as never)
  const handlers = (store.transport as unknown as { handlers: { onEvent(runtime: unknown, event: unknown, fence?: unknown): void; onNotification(event: unknown): void } }).handlers
  const opening = store.openAdjacentSession(id, runtime)
  handlers.onEvent(runtime, { type: 'session/started', session: started }, { ...watermark, revision: 1, sequence: 1 })
  expect(store.getSnapshot().sessions.get(sessionKey(runtime, id))?.archived).toBeUndefined()
  if (indexUpdate !== 'none') handlers.onNotification({ method: 'session/indexChanged', params: { upserted: [{ ...started, ...(indexUpdate === 'archive' ? { archived: false } : { title: 'Synthetic indexed title' }) }], removed: [] } })
  expect(store.getSnapshot().sessions.get(sessionKey(runtime, id))?.archived).toBe(indexUpdate === 'archive' ? false : undefined)
  handlers.onEvent(runtime, { type: 'turn/started', sessionId: id, turn: { ...turn, status: 'inProgress', items: [] } }, { ...watermark, revision: 2, sequence: 2 })
  handlers.onEvent(runtime, { type: 'turn/completed', sessionId: id, turn }, watermark)
  read.resolve(started); await opening
  expect(store.getSnapshot().adjacentSession?.error).toBeNull()
  expect(store.getSnapshot().sessions.get(sessionKey(runtime, id))?.turns).toMatchObject([turn])
  expect(store.getSnapshot().sessions.get(sessionKey(runtime, id))?.archived).toBe(indexUpdate === 'archive' ? false : undefined)
  expect(store.getSnapshot().sessions.get(sessionKey(runtime, id))?.title).toBe(indexUpdate === 'title' ? 'Synthetic indexed title' : started.title)
})

it('preserves index metadata that arrives while adjacent resume is pending', async () => {
  const store = new AppStore('ws://localhost:0/'), id = sessionId('a'), resume = deferred<Session>(), entered = deferred<void>()
  const original = { ...body('a'), title: 'Before' }
  vi.spyOn(store.transport, 'request').mockImplementation(((method: string) => {
    if (method === 'session/resume') { entered.resolve(); return resume.promise }
    return Promise.resolve(original)
  }) as never)
  const handlers = (store.transport as unknown as { handlers: { onEvent(runtime: unknown, event: unknown): void; onNotification(event: unknown): void } }).handlers
  handlers.onEvent(runtime, { type: 'session/started', session: original })
  const opening = store.openAdjacentSession(id, runtime)
  await entered.promise
  handlers.onNotification({ method: 'session/indexChanged', params: { upserted: [{ ...original, title: 'Indexed during resume', archived: false }], removed: [] } })
  resume.resolve(original); await opening
  expect(store.getSnapshot().adjacentSession?.error).toBeNull()
  expect(store.getSnapshot().sessions.get(sessionKey(runtime, id))).toMatchObject({ title: 'Indexed during resume', archived: false })
})
