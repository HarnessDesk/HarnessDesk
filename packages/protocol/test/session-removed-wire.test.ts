import assert from 'node:assert/strict'
import { test } from 'node:test'

import { parseClientMessage, parseSessionRemovedParams } from '../src/wire-validators.js'
import { ValidationError } from '../src/validate.js'

test('session/removed validates the host-confirmed deletion outcome', () => {
  assert.deepEqual(parseSessionRemovedParams({ runtime: 'codex', sessionId: 's1', deleted: false }), {
    runtime: 'codex',
    sessionId: 's1',
    deleted: false,
  })
  assert.deepEqual(parseSessionRemovedParams({ runtime: 'codex', sessionId: 's1', deleted: true }).deleted, true)
  assert.throws(() => parseSessionRemovedParams({ runtime: 'codex', sessionId: 's1' }), ValidationError)
  assert.throws(() => parseSessionRemovedParams({ runtime: 'codex', sessionId: 's1', deleted: 'yes' }), ValidationError)
})

test('session/remove accepts only an explicit Remove or Undo for one runtime and session', () => {
  const request = (params: unknown) => parseClientMessage({ id: 1, method: 'session/remove', params })
  for (const removed of [true, false]) assert.deepEqual(request({ runtime: 'agent', sessionId: 's1', removed }).params, { runtime: 'agent', sessionId: 's1', removed })
  for (const params of [{ runtime: 'agent', sessionId: 's1' }, { runtime: 'agent', sessionId: 's1', removed: 'yes' }, { sessionId: 's1', removed: true }, { runtime: 'agent', removed: true }]) assert.throws(() => request(params), ValidationError)
})
