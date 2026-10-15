import assert from 'node:assert/strict'
import { test } from 'node:test'
import { runtimeId, type HostParams, type HostResult } from '@harnessdesk/protocol'
import { historyClient } from '../src/index.js'

type HistoryMethod = 'history/import' | 'history/cancel' | 'history/status' | 'history/list' | 'history/removeImported' | 'history/clearCached' | 'session/list'
test('the History client forwards every typed host operation and preserves results and failures', async () => {
  const calls: { method: HistoryMethod; params: unknown }[] = []
  const results = { 'history/import': null, 'history/cancel': null, 'history/status': null,
    'history/list': { data: [], nextCursor: null }, 'history/removeImported': { removed: 3 }, 'history/clearCached': { count: 2, bytes: 100 }, 'session/list': { data: [], nextCursor: null } }
  const api = historyClient(async <M extends HistoryMethod>(method: M, params: HostParams<M>): Promise<HostResult<M>> => {
    calls.push({ method, params })
    return results[method] as HostResult<M>
  })
  const runtime = runtimeId('synthetic')
  assert.equal(await api.import(runtime), null)
  assert.equal(await api.cancel(runtime), null)
  assert.equal(await api.status(runtime), null)
  assert.deepEqual(await api.list({ query: '%_', runtimes: [runtime], includeHidden: true }), results['history/list'])
  assert.deepEqual(await api.removeImported(runtime), { removed: 3 })
  assert.deepEqual(await api.clearCached(), { count: 2, bytes: 100 })
  assert.deepEqual(await api.nativeList({ runtime, archived: 'only', pageSize: 20 }), results['session/list'])
  assert.deepEqual(calls, [
    { method: 'history/import', params: { runtime } }, { method: 'history/cancel', params: { runtime } },
    { method: 'history/status', params: { runtime } }, { method: 'history/list', params: { query: '%_', runtimes: [runtime], includeHidden: true } },
    { method: 'history/removeImported', params: { runtime } }, { method: 'history/clearCached', params: {} },
    { method: 'session/list', params: { runtime, archived: 'only', pageSize: 20 } },
  ])
  const failure = new Error('Synthetic refusal')
  const refused = historyClient(async () => { throw failure })
  await assert.rejects(refused.import(runtime), error => error === failure)
})
