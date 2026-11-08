import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as protocol from '../src/index.js'

test('chat activity validates bounded identity, project and three states', () => {
  const parse = (protocol as unknown as Record<string, (raw: unknown) => unknown>)['parseLeadChatChangedParams']
  assert.equal(typeof parse, 'function')
  const value = { id: 'demo:session-1', project: '/tmp/demo', state: 'idle', stage: 'idle' }
  for (const state of ['running', 'waiting', 'idle']) assert.deepEqual(parse!({ ...value, state }), { ...value, state })
  for (const patch of [{ id: '' }, { id: 'x'.repeat(301) }, { project: '' }, { project: 'x'.repeat(4097) }, { state: 'complete' }, { state: null }, { stage: 'needs-you' }])
    assert.throws(() => parse!({ ...value, ...patch }), protocol.ValidationError)
  assert.deepEqual(protocol.parseClientMessage({ id: 1, method: 'client/subscribe', params: { topics: ['chats'], scope: { project: value.project } } }).params,
    { topics: ['chats'], scope: { project: value.project, team: undefined, run: undefined } })
})

test('an older host chat event without stage remains readable', () => {
  const old = { id: 'fixture:chat', project: '/workspace/demo', state: 'waiting' }
  assert.deepEqual(protocol.parseLeadChatChangedParams(old), { ...old, stage: undefined })
})

test('chat dispatch accepts a bounded effect id without making it model text', () => {
  for (const method of ['lead/chat/start', 'lead/chat/send', 'lead/chat/stop']) {
    const params = { ...(method === 'lead/chat/start' ? {} : { id: 'fixture:chat' }), ...(method === 'lead/chat/stop' ? {} : { text: 'Continue' }), effectId: 'effect-2' }
    assert.equal((protocol.parseClientMessage({ id: 1, method, params }).params as { effectId?: string }).effectId, 'effect-2')
    assert.throws(() => protocol.parseClientMessage({ id: 1, method, params: { ...params, effectId: 'x'.repeat(257) } }), protocol.ValidationError)
  }
})
