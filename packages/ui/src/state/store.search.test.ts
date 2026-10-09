import { beforeEach, describe, expect, it, vi } from 'vitest'

import { runtimeId, sessionId, type HostMethodName, type SessionSummary, type WireNotification } from '@harnessdesk/protocol'
import { AppStore } from './store'

const runtimeInfo = {
  id: 'acp-cline',
  name: 'Agent',
  capabilities: { listHistory: true, searchHistory: true },
  presentation: { name: 'Agent' },
}

const summary = (id: string): SessionSummary => ({
  id: sessionId(id),
  runtime: runtimeId('acp-cline'),
  title: id,
  preview: null,
  cwd: '/repo',
  status: { type: 'notLoaded' },
  createdAt: 1,
  updatedAt: 2,
})

const push = (store: AppStore, notification: WireNotification): void => {
  const transport = store.transport as unknown as { handlers: { onNotification(value: WireNotification): void } }
  transport.handlers.onNotification(notification)
}

const deferred = <T,>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((yes) => { resolve = yes })
  return { promise, resolve }
}

describe('history search request ordering', () => {
  let store: AppStore
  let request: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    store = new AppStore('ws://localhost:0/')
    request = vi.spyOn(store.transport, 'request').mockImplementation((async () => null) as never)
    push(store, {
      method: 'sync',
      params: {
        sessions: [], queues: [], tasks: [], health: [], runtimes: [runtimeInfo], plugins: [], contributions: [],
      },
    } as unknown as WireNotification)
  })

  it('keeps the newest search when replies arrive out of order', async () => {
    const older = deferred<{ data: readonly SessionSummary[]; nextCursor: null }>()
    const newer = deferred<{ data: readonly SessionSummary[]; nextCursor: null }>()
    request.mockImplementation(((method: HostMethodName, params: { query?: string }) => {
      if (method !== 'session/search') return Promise.resolve(null)
      return params.query === 'older' ? older.promise : newer.promise
    }) as never)

    const first = store.searchHistory('older')
    const second = store.searchHistory('newer')
    newer.resolve({ data: [summary('newer-result')], nextCursor: null })
    await second
    older.resolve({ data: [summary('older-result')], nextCursor: null })
    await first

    expect(store.getSnapshot().history.map((row) => row.id)).toEqual(['newer-result'])
  })

  it('does not let a cleared query be overwritten by a slow search', async () => {
    const older = deferred<{ data: readonly SessionSummary[]; nextCursor: null }>()
    request.mockImplementation(((method: HostMethodName) => {
      if (method === 'session/search') return older.promise
      if (method === 'session/index') return Promise.resolve({ data: [summary('reset-history')], nextCursor: null })
      return Promise.resolve(null)
    }) as never)

    await store.loadHistory({ reset: true })
    const first = store.searchHistory('slow')
    const clear = store.searchHistory('')
    await clear
    older.resolve({ data: [summary('stale-result')], nextCursor: null })
    await first

    expect(store.getSnapshot().history.map((row) => row.id)).toEqual(['reset-history'])
  })

  it('drops pending rows when their runtime is removed', async () => {
    const pending = deferred<{ data: readonly SessionSummary[]; nextCursor: null }>()
    request.mockImplementation(((method: HostMethodName) =>
      method === 'session/search' ? pending.promise : Promise.resolve(null)) as never)

    const search = store.searchHistory('needle')
    push(store, { method: 'runtime/removed', params: { runtime: runtimeId('acp-cline') } } as unknown as WireNotification)
    pending.resolve({ data: [summary('removed-runtime-result')], nextCursor: null })
    await search

    expect(store.getSnapshot().history).toEqual([])
  })

  it('filters search rows against the current runtime roster', async () => {
    const pending = deferred<{ data: readonly SessionSummary[]; nextCursor: null }>()
    request.mockImplementation(((method: HostMethodName) =>
      method === 'session/search' ? pending.promise : Promise.resolve(null)) as never)

    const search = store.searchHistory('needle')
    push(store, {
      method: 'sync',
      params: { sessions: [], queues: [], tasks: [], health: [], runtimes: [], plugins: [], contributions: [] },
    } as unknown as WireNotification)
    pending.resolve({ data: [summary('orphaned-search-result')], nextCursor: null })
    await search

    expect(store.getSnapshot().history).toEqual([])
  })
})
