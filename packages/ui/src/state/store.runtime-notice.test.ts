import { beforeEach, expect, it, vi } from 'vitest'
import { reduceSession, runtimeId, sessionId, sessionKey, turnId, type AgentEvent, type HostMethodName } from '@harnessdesk/protocol'
import { AppStore } from './store'
import { keepRuntimeInboxEntry, mergeNoticePreferences } from '../../../server/src/runtime-notices'

let store: AppStore
let saved: Record<string, unknown>
const pushTo = (target: AppStore, event: AgentEvent) =>
  (target.transport as unknown as { handlers: { onEvent(runtime: string, event: AgentEvent): void } }).handlers.onEvent('codex', event)
const warning = (): AgentEvent => ({ type: 'notice', level: 'warning', message: 'Unknown setting', kind: 'runtime:config', detail: { summary: 'Unknown setting', settings: ['features.bogus'], file: '/Users/user/.codex/config.toml' } })
beforeEach(async () => {
  saved = {}
  store = new AppStore('ws://localhost:0/')
  vi.spyOn(store.transport, 'request').mockImplementation((async (method: HostMethodName, params: unknown) => {
    if (method === 'app/state/get') return saved
    if (method === 'app/state/set') {
      const { patch, noticeBase } = params as { patch: Record<string, unknown>; noticeBase?: Record<string, unknown> }
      Object.assign(saved, mergeNoticePreferences(saved, patch, noticeBase))
      return structuredClone(saved)
    }
    if (method === 'app/inbox/keepInfo') {
      const patch = keepRuntimeInboxEntry(saved, (params as { entry: Parameters<typeof keepRuntimeInboxEntry>[1] }).entry)
      if (patch) Object.assign(saved, patch)
      return structuredClone(saved)
    }
    return null
  }) as never)
  await store.loadPreferences()
})
it('keeps runtime information quietly once, counts repeats without making read content unread again', () => {
  pushTo(store, warning())
  expect(store.getSnapshot().notices).toHaveLength(0)
  expect(store.getSnapshot().inbox).toHaveLength(1)
  const id = store.getSnapshot().inbox[0]!.id
  store.markInboxRead(id)
  pushTo(store, warning())
  expect(store.getSnapshot().inbox[0]).toMatchObject({ read: true, count: 2, file: '/Users/user/.codex/config.toml' })
  store.clearInbox()
  pushTo(store, warning())
  expect(store.getSnapshot().inbox).toHaveLength(0)
})
it('waits for persisted mutes before keeping an early warning', async () => {
  const early = new AppStore('ws://localhost:0/')
  let resolve!: (value: unknown) => void
  vi.spyOn(early.transport, 'request').mockImplementation((async (method: HostMethodName) => method === 'app/state/get' ? new Promise(r => { resolve = r }) : null) as never)
  const loading = early.loadPreferences()
  pushTo(early, warning())
  expect(early.getSnapshot().inbox).toHaveLength(0)
  resolve({ noticePolicy: { muted: ['runtime:config'] } })
  await loading
  expect(early.getSnapshot().inbox).toHaveLength(0)
  expect(early.getSnapshot().notices).toHaveLength(0)
})
it('conversation information and errors never toast or enter the Inbox', () => {
  const id = sessionId('s1')
  pushTo(store, { type: 'session/started', session: { id, runtime: runtimeId('codex'), cwd: '/repo', status: { type: 'idle' }, createdAt: 0, updatedAt: 0, turns: [], itemsLoaded: true } })
  pushTo(store, { type: 'notice', sessionId: id, kind: 'conversation:compacted', level: 'info', message: 'Context was compacted' })
  expect(store.getSnapshot().sessions.get(sessionKey(runtimeId('codex'), id))?.turns.flatMap(t => t.items)).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'notice', text: 'Context was compacted' })]))
  pushTo(store, { type: 'error', sessionId: id, error: { message: 'Turn failed' } } as AgentEvent)
  expect(store.getSnapshot().notices).toHaveLength(0)
  expect(store.getSnapshot().inbox).toHaveLength(0)
  expect(store.getSnapshot().sessions.get(sessionKey(runtimeId('codex'), id))?.status.type).toBe('error')
})

for (const noticeFirst of [true, false]) it(`an empty store keeps conversation notices with registration ${noticeFirst ? 'last' : 'first'}`, () => {
  const id = sessionId('review')
  const notice: AgentEvent = { type: 'notice', sessionId: id, class: 'conversation', level: 'warning', message: 'No tools declared', id: 'tools-1' }
  const repeated: AgentEvent = { ...notice, id: 'tools-2' }
  const opened: AgentEvent = { type: 'session/started', session: { id, runtime: runtimeId('codex'), cwd: '/repo', status: { type: 'idle' }, createdAt: 0, updatedAt: 0, turns: [], itemsLoaded: true } }
  for (const event of noticeFirst ? [notice, repeated, repeated, opened] : [opened, notice, repeated, repeated]) pushTo(store, event)
  const registered = store.getSnapshot().sessions.get(sessionKey(runtimeId('codex'), id))!
  expect(registered.turns.flatMap(turn => turn.items).filter(item => item.type === 'notice').map(item => [item.text, item.count])).toEqual([['No tools declared', 2]])
  pushTo(store, { ...opened, session: registered })
  pushTo(store, { type: 'turn/started', sessionId: id, turn: { id: turnId('review-turn'), status: 'inProgress', items: [] } })
  pushTo(store, repeated)
  const held = store.getSnapshot().sessions.get(sessionKey(runtimeId('codex'), id))!
  expect(held.turns.flatMap(turn => turn.items).filter(item => item.type === 'notice').map(item => [item.text, item.count])).toEqual([['No tools declared', 2]])
  expect(held.turns.some(turn => String(turn.id).startsWith('notice:'))).toBe(false)
  expect(store.getSnapshot().inbox).toEqual([])
  expect(store.getSnapshot().notices).toEqual([])
})

for (const sync of [false, true]) it(`host ${sync ? 'hydration' : 'registration'} does not recount buffered conversation notices`, () => {
  const id = sessionId('review')
  const opened: Extract<AgentEvent, { type: 'session/started' }> = { type: 'session/started', session: { id, runtime: runtimeId('codex'), cwd: '/repo', status: { type: 'idle' }, createdAt: 0, updatedAt: 0, turns: [], itemsLoaded: true } }
  let held = opened.session
  for (const eventId of ['tools-1', 'tools-2', 'tools-3']) {
    const notice: AgentEvent = { type: 'notice', sessionId: id, class: 'conversation', level: 'warning', message: 'No tools declared', id: eventId }
    pushTo(store, notice)
    held = reduceSession(held, notice)
  }
  if (sync) {
    const handlers = (store.transport as unknown as { handlers: { onNotification(notification: unknown): void } }).handlers
    handlers.onNotification({ method: 'sync', params: { sessions: [held] } })
  } else pushTo(store, { ...opened, session: held })
  expect(store.getSnapshot().sessions.get(sessionKey(runtimeId('codex'), id))).toEqual(held)
  const cold = new AppStore('ws://localhost:0/')
  const handlers = (cold.transport as unknown as { handlers: { onNotification(notification: unknown): void } }).handlers
  handlers.onNotification({ method: 'sync', params: { sessions: [held] } })
  expect(cold.getSnapshot().sessions.get(sessionKey(runtimeId('codex'), id))).toEqual(held)
})

it('removing an unregistered conversation discards its pending notices', () => {
  const id = sessionId('review')
  pushTo(store, { type: 'notice', sessionId: id, level: 'warning', message: 'No tools declared', id: 'tools-1' })
  const handlers = (store.transport as unknown as { handlers: { onNotification(notification: unknown): void } }).handlers
  handlers.onNotification({ method: 'session/removed', params: { runtime: runtimeId('codex'), sessionId: id, deleted: true } })
  pushTo(store, { type: 'session/started', session: { id, runtime: runtimeId('codex'), cwd: '/repo', status: { type: 'idle' }, createdAt: 0, updatedAt: 0, turns: [], itemsLoaded: true } })
  expect(store.getSnapshot().sessions.get(sessionKey(runtimeId('codex'), id))?.turns).toEqual([])
})

it('a host read moving an early notice into a real turn leaves one row', () => {
  const id = sessionId('review')
  const opened: Extract<AgentEvent, { type: 'session/started' }> = { type: 'session/started', session: { id, runtime: runtimeId('codex'), cwd: '/repo', status: { type: 'idle' }, createdAt: 0, updatedAt: 0, turns: [], itemsLoaded: true } }
  const notice: AgentEvent = { type: 'notice', sessionId: id, level: 'warning', message: 'No tools declared', id: 'tools-1' }
  pushTo(store, opened)
  pushTo(store, notice)
  const held = reduceSession(opened.session, notice)
  const read = reduceSession(held, { type: 'turn/started', sessionId: id, turn: { id: turnId('review-turn'), status: 'inProgress', items: [] } })
  pushTo(store, { ...opened, session: read })
  expect(store.getSnapshot().sessions.get(sessionKey(runtimeId('codex'), id))).toEqual(read)
})
it('remembers cleared content through a restart, while changed content is new', async () => {
  pushTo(store, warning())
  store.clearInbox()
  const restored = new AppStore('ws://localhost:0/')
  vi.spyOn(restored.transport, 'request').mockImplementation((async (method: HostMethodName) => method === 'app/state/get' ? saved : null) as never)
  await restored.loadPreferences()
  pushTo(restored, warning())
  expect(restored.getSnapshot().inbox).toHaveLength(0)
  pushTo(restored, { ...warning(), message: 'Another setting' } as AgentEvent)
  expect(restored.getSnapshot().inbox).toHaveLength(1)
})
it('counted information stays remembered beyond the standing-notice limit', async () => {
  pushTo(store, warning())
  store.clearInbox()
  for (let n = 0; n < 50; n++) pushTo(store, { type: 'notice', level: 'info', message: `Warning ${n}` })
  await store.loadPreferences()
  pushTo(store, warning())
  expect(store.getSnapshot().inbox.some(entry => entry.title.includes('Unknown setting'))).toBe(false)
})


it('replays host information emitted before connection once, without incrementing on another read', async () => {
  saved = { runtimeNotices: [{ runtime: 'codex', event: { ...warning(), id: 'startup-1', at: 10, count: 3 } }] }
  await store.loadPreferences()
  expect(store.getSnapshot().notices).toHaveLength(0)
  expect(store.getSnapshot().inbox).toHaveLength(1)
  expect(store.getSnapshot().inbox[0]).toMatchObject({ count: 3, at: 10 })
  store.markInboxRead(store.getSnapshot().inbox[0]!.id)
  await store.loadPreferences()
  pushTo(store, { ...warning(), id: 'startup-1', at: 10, count: 3 } as AgentEvent)
  expect(store.getSnapshot().inbox[0]).toMatchObject({ count: 3, read: true })
})


it('does not overwrite persisted Inbox memory when its first preference read fails', async () => {
  const early = new AppStore('ws://localhost:0/')
  const request = vi.spyOn(early.transport, 'request').mockRejectedValue(new Error('Read unavailable'))
  pushTo(early, warning())
  await early.loadPreferences()
  expect(early.getSnapshot().inbox).toHaveLength(0)
  expect(request.mock.calls.some(([method]) => method === 'app/state/set')).toBe(false)
  request.mockImplementation((async (method: HostMethodName) => method === 'app/state/get' ? { noticePolicy: { muted: ['runtime:config'] } } : null) as never)
  await early.loadPreferences()
  expect(early.getSnapshot().inbox).toHaveLength(0)
})

it('does not recount older queued events after startup history supplies their latest occurrence', async () => {
  const early = new AppStore('ws://localhost:0/')
  let resolve!: (value: unknown) => void
  vi.spyOn(early.transport, 'request').mockImplementation((async (method: HostMethodName) => method === 'app/state/get' ? new Promise(r => { resolve = r }) : null) as never)
  const loading = early.loadPreferences()
  for (let n = 1; n <= 3; n++) pushTo(early, { ...warning(), id: `early-${n}`, at: n, count: n } as AgentEvent)
  resolve({ runtimeNotices: [{ runtime: 'codex', event: { ...warning(), id: 'early-3', at: 3, count: 3 } }] })
  await loading
  expect(early.getSnapshot().inbox[0]).toMatchObject({ count: 3, at: 3, lastEvent: 'early-3' })
})

it('keeps an unscoped runtime failure quietly where it can still be read', () => {
  pushTo(store, { type: 'error', error: { message: 'Runtime failed' } } as AgentEvent)
  expect(store.getSnapshot().inbox.map(entry => entry.title)).toEqual(['Runtime failed'])
  expect(store.getSnapshot().notices).toEqual([])
})

it('keeps a startup failure quietly after preferences become available', async () => {
  const early = new AppStore('ws://localhost:0/')
  vi.spyOn(early.transport, 'request').mockImplementation((async (method: HostMethodName) => method === 'app/state/get' ? {} : null) as never)
  early.backgroundFailure('Connection failed')
  expect(early.getSnapshot().notices).toEqual([])
  await early.loadPreferences()
  expect(early.getSnapshot().inbox.map(entry => entry.title)).toEqual(['Connection failed'])
})


it('retains the native summary alongside configuration guidance in expanded detail', () => {
  pushTo(store, { ...warning(), detail: { summary: 'Native guidance that explains why the settings were ignored', settings: ['features.bogus'], details: 'Additional guidance.' } } as AgentEvent)
  expect(store.getSnapshot().inbox[0]?.body).toContain('Native guidance that explains why the settings were ignored')
})

it('a stale window receiving runtime information cannot reverse another window read, clear or mute', async () => {
  const second = new AppStore('ws://localhost:0/')
  vi.spyOn(second.transport, 'request').mockImplementation((async (method: HostMethodName, params: unknown) => {
    if (method === 'app/state/get') return saved
    if (method === 'app/state/set') {
      const { patch, noticeBase } = params as { patch: Record<string, unknown>; noticeBase?: Record<string, unknown> }
      Object.assign(saved, mergeNoticePreferences(saved, patch, noticeBase))
      return structuredClone(saved)
    }
    if (method === 'app/inbox/keepInfo') {
      const patch = keepRuntimeInboxEntry(saved, (params as { entry: Parameters<typeof keepRuntimeInboxEntry>[1] }).entry)
      if (patch) Object.assign(saved, patch)
      return structuredClone(saved)
    }
    return null
  }) as never)
  await second.loadPreferences()
  pushTo(store, { ...warning(), id: 'first', at: 1, count: 1 } as AgentEvent)
  pushTo(second, { ...warning(), id: 'first', at: 1, count: 1 } as AgentEvent)
  const id = store.getSnapshot().inbox[0]!.id
  store.markInboxRead(id)
  const readState = structuredClone(saved)
  pushTo(second, { ...warning(), id: 'second', at: 2, count: 2 } as AgentEvent)
  await vi.waitFor(() => expect(second.getSnapshot().inbox[0]?.read).toBe(true))
  expect((saved.inbox as { read: boolean }[])[0]?.read).toBe(true)
  store.clearInbox()
  store.setNoticeMuted('runtime:config', true)
  const clearedState = structuredClone(saved)
  pushTo(second, { ...warning(), id: 'third', at: 3, count: 3 } as AgentEvent)
  await vi.waitFor(() => expect(second.getSnapshot().inbox).toEqual([]))
  expect(second.getSnapshot().noticePolicy.muted).toContain('runtime:config')
  second.markInboxRead(id)
  expect(saved.noticePolicy).toEqual(clearedState.noticePolicy)
  expect(saved.inbox).toEqual([])
  expect(readState).not.toEqual(clearedState)
})


it('an older runtime answer cannot undo a subsequent read or clear in the same window', async () => {
  let answer!: (value: unknown) => void
  vi.spyOn(store.transport, 'request').mockImplementation((async (method: HostMethodName) => method === 'app/inbox/keepInfo' ? new Promise(resolve => { answer = resolve }) : null) as never)
  pushTo(store, warning())
  const old = structuredClone({ inbox: store.getSnapshot().inbox, noticePolicy: store.getSnapshot().noticePolicy })
  store.clearInbox()
  answer(old)
  await Promise.resolve()
  expect(store.getSnapshot().inbox).toEqual([])
})


it('older retained occurrences synchronize the window without advancing the host count or time', async () => {
  pushTo(store, { ...warning(), id: 'latest', at: 5, count: 5 } as AgentEvent)
  await vi.waitFor(() => expect(store.getSnapshot().inbox[0]?.count).toBe(5))
  pushTo(store, { ...warning(), id: 'older', at: 3, count: 3 } as AgentEvent)
  await Promise.resolve()
  expect(store.getSnapshot().inbox[0]).toMatchObject({ count: 5, at: 5, lastEvent: 'latest' })
  expect((saved.inbox as { count: number; at: number }[])[0]).toMatchObject({ count: 5, at: 5, lastEvent: 'latest' })
})


it('even a cached replay receives authoritative clear and mute memory', async () => {
  const occurrence = { ...warning(), id: 'same-event', at: 1, count: 1 } as AgentEvent
  pushTo(store, occurrence)
  await Promise.resolve()
  saved = { ...saved, inbox: [], noticePolicy: { ...(saved.noticePolicy as object), muted: ['runtime:config'] } }
  pushTo(store, occurrence)
  await vi.waitFor(() => expect(store.getSnapshot().inbox).toEqual([]))
  expect(store.getSnapshot().noticePolicy.muted).toContain('runtime:config')
})
