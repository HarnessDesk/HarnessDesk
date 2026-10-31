import assert from 'node:assert/strict'
import test from 'node:test'

import { leadDisplayName } from '../src/lead.js'
import { parseClientMessage } from '../src/wire-validators.js'

test('the Lead display name is the one the person picked', () => {
  assert.equal(leadDisplayName('dex'), 'Dex')
  assert.equal(leadDisplayName('lex'), 'Lex')
})

test('take over and hand back take one bounded chat id and nothing else', () => {
  for (const method of ['lead/chat/takeOver', 'lead/chat/handBack'] as const) {
    const validate = (params: unknown) => parseClientMessage({ id: 1, method, params }).params
    assert.deepEqual(validate({ id: 'codex:s1' }), { id: 'codex:s1' })
    assert.throws(() => validate({ id: 'x'.repeat(301) }))
    assert.throws(() => validate({ id: 'codex:s1', extra: true }))
    assert.throws(() => validate({}))
  }
  assert.deepEqual(parseClientMessage({ id: 1, method: 'lead/chats/control', params: {} }).params, {})
})

test('reset control is an explicit empty window action', () => {
  assert.deepEqual(parseClientMessage({ id: 1, method: 'lead/chats/resetControl', params: {} }).params, {})
  assert.throws(() => parseClientMessage({ id: 1, method: 'lead/chats/resetControl', params: { id: 'fixture:s1' } }))
})
