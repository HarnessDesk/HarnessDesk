import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseClientMessage, ValidationError } from '../src/index.js'
import { sessionIndexCursorOf, sessionIndexCompare } from '../src/session-index-cursor.js'
import { runtimeId, sessionId } from '../src/ids.js'

const request = (params: unknown) => parseClientMessage({ id: 1, method: 'session/index', params })

test('the sidebar index needs no runtime and accepts bounded page requests', () => {
  assert.equal(request({}).method, 'session/index')
  assert.deepEqual(request({ cursor: 'page', pageSize: 50, archived: 'only', runtimes: undefined }).params,
    { cursor: 'page', pageSize: 50, archived: 'only', runtimes: undefined })
  for (const pageSize of [0, -1, 1.5, 501, Infinity]) assert.throws(() => request({ pageSize }), ValidationError)
  assert.throws(() => request({ archived: 'both' }), ValidationError)
  assert.throws(() => request({ cursor: 3 }), ValidationError)
})

test('a retained row names the next boundary without losing Unicode identities', () => {
  const row = { runtime: runtimeId('agent'), id: sessionId('会話'), updatedAt: 42 }
  const cursor = sessionIndexCursorOf(row)
  assert.deepEqual(JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')), [42, 'agent', '会話', 0])
  assert.deepEqual(JSON.parse(Buffer.from(sessionIndexCursorOf(row, 'only'), 'base64url').toString('utf8')), [42, 'agent', '会話', 1])
})

test('row ties follow SQLite byte ordering, including supplementary Unicode', () => {
  const rows = ['😀', '\uffff', 'a'].map(id => ({ runtime: runtimeId('agent'), id: sessionId(id), updatedAt: 42 }))
  assert.deepEqual(rows.sort(sessionIndexCompare).map(row => row.id), ['a', '\uffff', '😀'])
})

test('index runtime filters carry account identities and validate their shape', () => {
  assert.deepEqual((request({ runtimes: ['agent', 'account'] }).params as { runtimes: unknown }).runtimes, ['agent', 'account'])
  assert.deepEqual((request({ runtimes: [] }).params as { runtimes: unknown }).runtimes, [])
  assert.throws(() => request({ runtimes: 'agent' }), ValidationError)
  assert.throws(() => request({ runtimes: [3] }), ValidationError)
})
