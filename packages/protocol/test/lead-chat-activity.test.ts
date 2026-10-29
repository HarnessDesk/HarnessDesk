import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as protocol from '../src/index.js'

test('chat activity validates bounded identity, project and three states', () => {
  const parse = (protocol as unknown as Record<string, (raw: unknown) => unknown>)['parseLeadChatChangedParams']
  assert.equal(typeof parse, 'function')
  const value = { id: 'demo:session-1', project: '/tmp/demo', state: 'idle' }
  for (const state of ['running', 'waiting', 'idle']) assert.deepEqual(parse!({ ...value, state }), { ...value, state })
  for (const patch of [{ id: '' }, { id: 'x'.repeat(301) }, { project: '' }, { project: 'x'.repeat(4097) }, { state: 'complete' }, { state: null }])
    assert.throws(() => parse!({ ...value, ...patch }), protocol.ValidationError)
  assert.deepEqual(protocol.parseClientMessage({ id: 1, method: 'client/subscribe', params: { topics: ['chats'], scope: { project: value.project } } }).params,
    { topics: ['chats'], scope: { project: value.project, team: undefined, run: undefined } })
})
