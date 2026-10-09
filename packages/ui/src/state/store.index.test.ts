import { beforeEach, expect, it, vi } from 'vitest'
import {
  runtimeId, sessionId, sessionKey, sessionIndexCursorOf,
  type AgentEvent, type HostMethodName, type Session, type SessionSummary, type WireNotification,
} from '@harnessdesk/protocol'
import { AppStore } from './store'
import type { TransportEvents } from '../lib/transport'

const runtime = runtimeId('agent')
const row = (id: string, patch: Partial<SessionSummary> = {}): SessionSummary => ({
  runtime, id: sessionId(id), title: id, cwd: '/repo', preview: null,
  status: { type: 'notLoaded' }, createdAt: 1, updatedAt: 2, ...patch,
})
const session = (id: string): Session => ({
  ...row(id), status: { type: 'idle' }, turns: [], itemsLoaded: true,
})
const deferred = <T,>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((yes) => { resolve = yes })
  return { promise, resolve }
}
let store: AppStore
let request: ReturnType<typeof vi.spyOn>
const handlers = () => (store.transport as unknown as { handlers: TransportEvents }).handlers
const change = (upserted: readonly SessionSummary[] = [], removed: readonly { runtime: typeof runtime; id: ReturnType<typeof sessionId> }[] = [], firstPageCursor?: string | null) =>
  handlers().onNotification({ method: 'session/indexChanged', params: { upserted, removed, ...(firstPageCursor === undefined ? {} : { firstPageCursor }) } } as WireNotification)
const ids = () => store.getSnapshot().history.map((entry) => entry.id)
const lists = () => request.mock.calls.filter(([method]: readonly unknown[]) => method === 'session/index' || method === 'session/list')

beforeEach(() => {
  store = new AppStore('ws://localhost:0/')
  request = vi.spyOn(store.transport, 'request').mockImplementation((async (method: HostMethodName) =>
    method === 'session/index' ? { data: [], nextCursor: null } : null) as never)
})

it('loads one 50-row index page before any runtime is selected', async () => {
  request.mockResolvedValue({ data: [row('first')], nextCursor: 'next' })
  await store.loadHistory({ reset: true })
  expect(lists()).toEqual([['session/index', { pageSize: 50 }]])
  expect(ids()).toEqual(['first'])
  expect(store.getSnapshot().historyCursor).toBe('next')
})

it('patches and removes indexed rows without a list request', () => {
  change([row('one'), row('two')])
  change([row('one', { title: 'Renamed', updatedAt: 3 })], [{ runtime, id: sessionId('two') }])
  expect(ids()).toEqual(['one'])
  expect(store.getSnapshot().historyIdentity[0]?.title).toBe('Renamed')
  change([row('one', { archived: true })])
  expect(ids()).toEqual([])
  change([row('one', { archived: false })])
  expect(ids()).toEqual(['one'])
  expect(lists()).toHaveLength(0)
})

it('replays newer row changes over a stale pending page', async () => {
  const page = deferred<{ data: readonly SessionSummary[]; nextCursor: string | null }>()
  request.mockImplementation((() => page.promise) as never)
  const loading = store.loadHistory({ reset: true })
  change([row('renamed', { title: 'New title', updatedAt: 9 }), row('archived', { archived: true }), row('new')],
    [{ runtime, id: sessionId('deleted') }])
  page.resolve({ data: [row('renamed'), row('archived'), row('deleted')], nextCursor: 'next' })
  await loading
  expect(ids()).toEqual(['renamed', 'new'])
  expect(store.getSnapshot().history[0]?.title).toBe('New title')
})

it('continues the index cursor and deduplicates overlapping pages', async () => {
  request.mockResolvedValueOnce({ data: [row('one')], nextCursor: 'next' })
    .mockResolvedValueOnce({ data: [row('one'), row('two')], nextCursor: null })
  await store.loadHistory({ reset: true })
  await store.loadHistory()
  expect(lists()).toEqual([['session/index', { pageSize: 50 }], ['session/index', { pageSize: 50, cursor: 'next' }]])
  expect(ids()).toEqual(['one', 'two'])
})

it('restores loaded identity and its cursor locally when search is cleared', async () => {
  request.mockResolvedValueOnce({ data: [row('desk')], nextCursor: 'next' })
  await store.loadHistory({ reset: true })
  await store.selectRuntime(runtime)
  request.mockClear()
  const searching = deferred<{ data: readonly SessionSummary[]; nextCursor: null }>()
  request.mockImplementation(((method: HostMethodName) => method === 'session/search' ? searching.promise : Promise.resolve(null)) as never)
  handlers().onNotification({ method: 'runtime/added', params: { info: {
    id: runtime, name: 'Agent', capabilities: { searchHistory: true }, presentation: { name: 'Agent' },
  } } } as unknown as WireNotification)
  const pending = store.searchHistory('needle')
  change([row('later')])
  await store.searchHistory('')
  searching.resolve({ data: [row('stale-search')], nextCursor: null })
  await pending
  expect(ids()).toEqual(['desk', 'later'])
  expect(store.getSnapshot().historyCursor).toBe('next')
  expect(lists()).toHaveLength(0)
})

it('refreshes runtime metadata without reloading the sidebar', async () => {
  await store.selectRuntime(runtime)
  request.mockClear()
  request.mockImplementation((async (method: HostMethodName) => method === 'runtime/health' ? { state: 'ready' } : []) as never)
  await store.refreshRuntime()
  expect(lists()).toHaveLength(0)
})

it('creates and forks with returned rows without a list request', async () => {
  await store.selectRuntime(runtime)
  request.mockClear()
  request.mockImplementation((async (method: HostMethodName) => {
    if (method === 'session/create') return session('new')
    if (method === 'session/fork') return session('fork')
    return null
  }) as never)
  await store.newSession({ cwd: '/repo', runtime })
  await store.forkSession(sessionKey(runtime, sessionId('new')))
  expect(ids()).toEqual(['fork', 'new'])
  expect(lists()).toHaveLength(0)
})

it('archives a project with one request per row and no reload', async () => {
  const rows = [row('one'), row('two')]
  change(rows)
  request.mockClear()
  await store.archiveSessions(rows)
  expect(ids()).toEqual([])
  expect(request.mock.calls.map(([method]: readonly unknown[]) => method)).toEqual(['session/archive', 'session/archive'])
})

it('archives, unarchives, renames and deletes with only their action request', async () => {
  change([row('one')])
  await store.renameSession('New title', sessionKey(runtime, sessionId('one')))
  expect(store.getSnapshot().history[0]?.title).toBe('New title')
  await store.archiveSession(sessionId('one'), runtime)
  expect(ids()).toEqual([])
  request.mockImplementation((async (method: HostMethodName) => {
    if (method === 'session/archive') change([row('one', { archived: false })])
    return { disposition: 'removed', removed: 1 }
  }) as never)
  await store.unarchiveSession(sessionId('one'), runtime)
  expect(ids()).toEqual(['one'])
  await store.deleteSession(sessionId('one'), runtime)
  expect(ids()).toEqual([])
  expect(request.mock.calls.map(([method]: readonly unknown[]) => method)).toEqual(['session/setTitle', 'session/archive', 'session/archive', 'session/delete'])
})

it('does not schedule list reloads from title or turn events', async () => {
  vi.useFakeTimers()
  try {
    handlers().onEvent(runtime, { type: 'session/started', session: session('one') })
    handlers().onEvent(runtime, { type: 'session/title', sessionId: sessionId('one'), title: 'Title' } as AgentEvent)
    await vi.advanceTimersByTimeAsync(700)
    expect(lists()).toHaveLength(0)
  } finally {
    vi.useRealTimers()
  }
})

it('keeps a pending index page when a search starts and is cleared', async () => {
  const page = deferred<{ data: readonly SessionSummary[]; nextCursor: string | null }>()
  request.mockImplementation(((method: HostMethodName) => method === 'session/index' ? page.promise : Promise.resolve(null)) as never)
  const loading = store.loadHistory({ reset: true })
  await store.searchHistory('needle')
  await store.searchHistory('')
  page.resolve({ data: [row('first')], nextCursor: 'next' })
  await loading
  expect(ids()).toEqual(['first'])
  expect(store.getSnapshot().historyCursor).toBe('next')
})

it('shows the first indexed rows while runtime startup is still pending', async () => {
  const slow = deferred<unknown>()
  vi.spyOn(store.transport, 'connect').mockImplementation(() => {})
  vi.spyOn(store.transport, 'status', 'get').mockReturnValue('open')
  request.mockImplementation((async (method: HostMethodName) => {
    if (method === 'host/hello') return { runtimes: [{ id: runtime }], home: '/fixture', stateDir: '/fixture' }
    if (method === 'session/index') return { data: [row('first')], nextCursor: null }
    if (method === 'runtime/models') return slow.promise
    return null
  }) as never)
  const connecting = store.connect()
  await vi.waitFor(() => expect(ids()).toEqual(['first']))
  expect(lists()).toHaveLength(1)
  slow.resolve([])
  await connecting
})

it('mirrors archive state to a held conversation so it cannot become a loose live row', () => {
  const held = session('one')
  handlers().onEvent(runtime, { type: 'session/started', session: held })
  change([row('one', { archived: true })])
  expect(store.getSnapshot().sessions.get(sessionKey(runtime, held.id))?.archived).toBe(true)
  change([row('one', { archived: false })])
  expect(store.getSnapshot().sessions.get(sessionKey(runtime, held.id))?.archived).toBe(false)
})

it('does not revive an excluded Team row from an action response', async () => {
  await store.selectRuntime(runtime)
  request.mockImplementation((async (method: HostMethodName) => {
    if (method !== 'session/create') return null
    change([], [{ runtime, id: sessionId('team-seat') }])
    return session('team-seat')
  }) as never)
  await store.newSession({ cwd: '/repo', runtime })
  expect(ids()).toEqual([])
})

it('keeps other agents’ pending index rows when one agent is removed', async () => {
  const page = deferred<{ data: readonly SessionSummary[]; nextCursor: string | null }>()
  request.mockImplementation((() => page.promise) as never)
  const loading = store.loadHistory({ reset: true })
  handlers().onNotification({ method: 'runtime/removed', params: { runtime } })
  page.resolve({ data: [row('gone'), row('kept', { runtime: runtimeId('other') })], nextCursor: 'next' })
  await loading
  expect(ids()).toEqual(['kept'])
  expect(store.getSnapshot().historyCursor).toBe('next')
})

it('keeps an upgrade batch to fifty rows and continues from its pushed cursor', async () => {
  await store.loadHistory({ reset: true })
  const seeded = Array.from({ length: 65 }, (_, index) => row(`seed-${index}`, { updatedAt: 100 - index }))
  const cursor = sessionIndexCursorOf(seeded[49]!)
  change(seeded, [], cursor)
  expect(store.getSnapshot().history).toHaveLength(50)
  expect(store.getSnapshot().historyIdentity).toHaveLength(50)
  expect(store.getSnapshot().historyCursor).toBe(cursor)
  request.mockResolvedValueOnce({ data: seeded.slice(50), nextCursor: null })
  await store.loadHistory()
  expect(lists().at(-1)).toEqual(['session/index', { pageSize: 50, cursor }])
  expect(store.getSnapshot().history).toHaveLength(65)
  expect(new Set(ids()).size).toBe(65)
})

it('replays a pushed first-page cursor over the empty page that preceded it', async () => {
  const page = deferred<{ data: readonly SessionSummary[]; nextCursor: string | null }>()
  request.mockImplementation((() => page.promise) as never)
  const loading = store.loadHistory({ reset: true })
  const seeded = Array.from({ length: 65 }, (_, index) => row(`seed-${index}`, { updatedAt: 100 - index }))
  const cursor = sessionIndexCursorOf(seeded[49]!)
  change(seeded, [], cursor)
  page.resolve({ data: [], nextCursor: null })
  await loading
  expect(store.getSnapshot().history).toHaveLength(50)
  expect(store.getSnapshot().historyCursor).toBe(cursor)
})

it('keeps row-change bursts within the number of pages already loaded', async () => {
  request.mockResolvedValueOnce({ data: Array.from({ length: 50 }, (_, index) => row(`first-${index}`, { updatedAt: 500 - index })), nextCursor: 'next' })
    .mockResolvedValueOnce({ data: Array.from({ length: 50 }, (_, index) => row(`second-${index}`, { updatedAt: 400 - index })), nextCursor: 'third' })
  await store.loadHistory({ reset: true })
  await store.loadHistory()
  change(Array.from({ length: 75 }, (_, index) => row(`new-${index}`, { updatedAt: 1000 - index })), [], 'new-first-page')
  expect(store.getSnapshot().history).toHaveLength(100)
  const last = store.getSnapshot().history.at(-1)!
  expect(store.getSnapshot().historyCursor).toBe(sessionIndexCursorOf(last))
  request.mockResolvedValueOnce({ data: [], nextCursor: null })
  await store.loadHistory()
  expect(lists().at(-1)).toEqual(['session/index', { pageSize: 50, cursor: sessionIndexCursorOf(last) }])
})

it('continues from the loaded boundary when a removal exposes an unseen first-page replacement', async () => {
  const seeded = Array.from({ length: 51 }, (_, index) => row(`seed-${index}`, { updatedAt: 100 - index }))
  const oldCursor = sessionIndexCursorOf(seeded[49]!)
  request.mockResolvedValueOnce({ data: seeded.slice(0, 50), nextCursor: oldCursor })
  await store.loadHistory({ reset: true })
  // There are now exactly 50 host rows, but this window only knows 49 of them.
  change([{ ...seeded[0]!, archived: true }], [], null)
  expect(store.getSnapshot().history).toHaveLength(49)
  expect(store.getSnapshot().historyCursor).toBe(oldCursor)
  // A delayed repo answer carries the host's current first-page cursor too.
  change([{ ...seeded[1]!, repo: { root: '/repo', worktree: false, origin: 'example.com/acme/repo' } }], [], null)
  expect(store.getSnapshot().history[0]?.repo?.root).toBe('/repo')
  expect(store.getSnapshot().historyCursor).toBe(oldCursor)
  request.mockResolvedValueOnce({ data: [seeded[50]], nextCursor: null })
  await store.loadHistory()
  expect(store.getSnapshot().history).toHaveLength(50)
  expect(ids()).toContain('seed-50')
})

it('keeps an unseen replacement fetchable when removal precedes the first page response', async () => {
  const seeded = Array.from({ length: 51 }, (_, index) => row(`pending-${index}`, { updatedAt: 100 - index }))
  const page = deferred<{ data: readonly SessionSummary[]; nextCursor: string | null }>()
  request.mockImplementation((() => page.promise) as never)
  const loading = store.loadHistory({ reset: true })
  change([{ ...seeded[0]!, archived: true }], [], null)
  page.resolve({ data: seeded.slice(0, 50), nextCursor: sessionIndexCursorOf(seeded[49]!) })
  await loading
  expect(store.getSnapshot().history).toHaveLength(49)
  expect(store.getSnapshot().historyCursor).toBe(sessionIndexCursorOf(seeded[49]!))
})


it('reconciles missed index changes on sync while keeping the loaded page capacity', async () => {
  const first = Array.from({ length: 50 }, (_, i) => row(`first-${i}`, { updatedAt: 200-i }))
  const second = Array.from({ length: 50 }, (_, i) => row(`second-${i}`, { updatedAt: 100-i }))
  request.mockResolvedValueOnce({ data: first, nextCursor: 'next' })
    .mockResolvedValueOnce({ data: second, nextCursor: 'third' })
  await store.loadHistory({ reset: true })
  await store.loadHistory()
  const current = [row('created-offline', { updatedAt: 500 }), ...first.slice(1), ...second]
  request.mockImplementation((async (method: HostMethodName) => method === 'session/index'
    ? { data: current, nextCursor: 'current-next' } : []) as never)
  handlers().onNotification({ method: 'sync', params: { runtimes: [], sessions: [] } } as unknown as WireNotification)
  await vi.waitFor(() => expect(ids()).toContain('created-offline'))
  expect(ids()).not.toContain('first-0')
  expect(ids()).toHaveLength(100)
  expect(lists().at(-1)).toEqual(['session/index', { pageSize: 100 }])
  expect(store.getSnapshot().historyCursor).toBe('current-next')
})

it.each(['success', 'failure'] as const)('keeps a settled search settled during index reconciliation (%s)', async (outcome) => {
  handlers().onNotification({ method: 'runtime/added', params: { info: {
    id: runtime, capabilities: { searchHistory: true }, presentation: { name: 'Demo agent' },
  } } } as unknown as WireNotification)
  await store.selectRuntime(runtime)
  request.mockResolvedValueOnce({ data: [row('match')], nextCursor: null })
  await store.searchHistory('needle')
  expect(store.getSnapshot().historyLoading).toBe(false)
  const page = deferred<{ data: readonly SessionSummary[]; nextCursor: null }>()
  request.mockImplementation((() => outcome === 'success' ? page.promise : page.promise.then(() => { throw new Error('Synthetic listing failed') })) as never)
  const loading = store.loadHistory({ reset: true, reconcile: true })
  expect(store.getSnapshot().historyLoading).toBe(false)
  page.resolve({ data: [row('indexed')], nextCursor: null })
  await loading
  expect(store.getSnapshot().historyLoading).toBe(false)
  expect(ids()).toEqual(['match'])
})

it('keeps a pending search loading when index reconciliation completes', async () => {
  handlers().onNotification({ method: 'runtime/added', params: { info: {
    id: runtime, capabilities: { searchHistory: true }, presentation: { name: 'Demo agent' },
  } } } as unknown as WireNotification)
  await store.selectRuntime(runtime)
  const search = deferred<{ data: readonly SessionSummary[]; nextCursor: null }>()
  request.mockImplementation(((method: HostMethodName) => method === 'session/search'
    ? search.promise : Promise.resolve({ data: [row('indexed')], nextCursor: null })) as never)
  const searching = store.searchHistory('needle')
  await store.loadHistory({ reset: true, reconcile: true })
  expect(store.getSnapshot().historyLoading).toBe(true)
  search.resolve({ data: [row('match')], nextCursor: null })
  await searching
  expect(store.getSnapshot().historyLoading).toBe(false)
  expect(ids()).toEqual(['match'])
})

it('settles a pending search when its runtime is removed during index reconciliation', async () => {
  handlers().onNotification({ method: 'runtime/added', params: { info: {
    id: runtime, capabilities: { searchHistory: true }, presentation: { name: 'Demo agent' },
  } } } as unknown as WireNotification)
  await store.selectRuntime(runtime)
  const search = deferred<{ data: readonly SessionSummary[]; nextCursor: null }>()
  const page = deferred<{ data: readonly SessionSummary[]; nextCursor: null }>()
  request.mockImplementation(((method: HostMethodName) => method === 'session/search'
    ? search.promise : method === 'session/index' ? page.promise : Promise.resolve(null)) as never)

  const searching = store.searchHistory('needle')
  const reconciling = store.loadHistory({ reset: true, reconcile: true })
  handlers().onNotification({ method: 'runtime/removed', params: { runtime } })
  page.resolve({ data: [], nextCursor: null })
  await reconciling
  search.resolve({ data: [row('removed-match')], nextCursor: null })
  await searching

  expect(store.getSnapshot().historyLoading).toBe(false)
  expect(ids()).toEqual([])
})

it('keeps removed agents out of later pages and index events', async () => {
  change([row('gone')])
  handlers().onNotification({ method: 'runtime/removed', params: { runtime } })
  request.mockResolvedValueOnce({ data: [row('gone'), row('kept', { runtime: runtimeId('other') })], nextCursor: null })
  await store.loadHistory()
  change([row('late-gone')])
  expect(ids()).toEqual(['kept'])
})

it('queries all accounts of the filtered agent independently of the global page', async () => {
  const account = runtimeId('agent-account')
  for (const id of [runtime, account, runtimeId('other')]) handlers().onNotification({ method: 'runtime/added', params: { info: {
    id, slot: { agent: id === account ? runtime : id }, capabilities: {}, presentation: { name: 'Demo agent' },
  } } } as unknown as WireNotification)
  request.mockResolvedValueOnce({ data: [row('global', { runtime: runtimeId('other') })], nextCursor: 'global-next' })
  await store.loadHistory({ reset: true })
  request.mockImplementation((async (method: HostMethodName) => method === 'session/index'
    ? { data: [row('filtered', { runtime: account })], nextCursor: 'filtered-next' } : null) as never)
  store.setListPrefs({ agent: runtime })
  await vi.waitFor(() => expect(ids()).toEqual(['filtered']))
  expect(lists().at(-1)).toEqual(['session/index', { pageSize: 50, runtimes: [runtime, account] }])
  expect(store.getSnapshot().historyIdentity.map(one => one.id)).toContain('global')
  change([row('wrong-agent', { runtime: runtimeId('other') })], [], 'global-cursor')
  expect(ids()).toEqual(['filtered'])
  expect(store.getSnapshot().historyCursor).toBe('filtered-next')
})
