import assert from 'node:assert/strict'
import { test } from 'node:test'

import { parseSessionRemovedParams } from '../src/wire-validators.js'
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
