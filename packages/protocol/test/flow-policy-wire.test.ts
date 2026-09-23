import assert from 'node:assert/strict'
import { test } from 'node:test'

import { parseClientMessage, ValidationError } from '../src/index.js'

/*
 * The v2 flow wire refuses forged authority before any handler runs: a
 * caller-supplied `compiled`, ceiling, evidence or origin is not a
 * parameter this table declares at all, so `goalShape`'s "unexpected field"
 * check is what stands between a renderer and a wire method that would
 * otherwise trust it.
 */

const request = (method: string, params: unknown) => parseClientMessage({ id: 1, method, params })

test('flow/preview and flow/start-goal reject a caller-supplied authority field outright', () => {
  const forgedFields = ['compiled', 'ceiling', 'evidence', 'seats', 'commands', 'origin', 'authorization']
  for (const field of forgedFields) {
    assert.throws(
      () => request('flow/preview', { root: '/work/repo', source: 'version: 2', [field]: {} }),
      ValidationError,
      `flow/preview should reject an extra "${field}" field`,
    )
    assert.throws(
      () => request('flow/start-goal', { root: '/work/repo', source: 'version: 2', token: 't1', sentence: 'Go', [field]: {} }),
      ValidationError,
      `flow/start-goal should reject an extra "${field}" field`,
    )
  }
  // The declared shape alone is accepted.
  assert.doesNotThrow(() => request('flow/preview', { root: '/work/repo', source: 'version: 2' }))
  assert.doesNotThrow(() => request('flow/start-goal', { root: '/work/repo', source: 'version: 2', token: 't1', sentence: 'Go' }))
})

test('flow/check/retry rejects unknown fields, and its ids and card are bounded', () => {
  assert.throws(() => request('flow/check/retry', { run: 'flow-1', card: 1, token: 't1', origin: 'user' }), ValidationError)
  for (const card of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => request('flow/check/retry', { run: 'flow-1', card, token: 't1' }), ValidationError, `card ${card} should be refused`)
  }
  assert.throws(() => request('flow/check/retry', { run: '', card: 1, token: 't1' }), ValidationError, 'an empty run id is refused')
  assert.throws(() => request('flow/check/retry', { run: 'flow-1', card: 1, token: '' }), ValidationError, 'an empty token is refused')
  assert.doesNotThrow(() => request('flow/check/retry', { run: 'flow-1', card: 1, token: 't1' }))
})

test('a token field never accepts anything but a filled string — no object, number or cross-type value stands in for it', () => {
  for (const token of [{ run: 'flow-1' }, 42, null, undefined, ['t1']]) {
    assert.throws(() => request('flow/start-goal', { root: '/r', source: 'x', token, sentence: 'Go' }), ValidationError)
    assert.throws(() => request('flow/check/retry', { run: 'flow-1', card: 1, token }), ValidationError)
    assert.throws(() => request('flow/update/apply', { root: '/r', token }), ValidationError)
  }
})

test('an oversized source is refused at the wire before any parser sees it', () => {
  const huge = 'x'.repeat(256 * 1024 + 1)
  assert.throws(() => request('flow/preview', { root: '/work/repo', source: huge }), ValidationError)
  assert.throws(() => request('flow/start-goal', { root: '/work/repo', source: huge, token: 't1', sentence: 'Go' }), ValidationError)
  // Exactly at the limit is still accepted; the refusal is the boundary, not "no large flows".
  const atLimit = 'x'.repeat(256 * 1024)
  assert.doesNotThrow(() => request('flow/preview', { root: '/work/repo', source: atLimit }))
})

test('flow/catalog, flow/source and the update/customize routes hold their own ids to the same rules', () => {
  assert.throws(() => request('flow/source', { root: '/r', id: '' }), ValidationError, 'an empty id is refused')
  assert.throws(() => request('flow/source', { root: '/r', id: 'x', origin: 'evil' }), ValidationError, 'an unknown origin is refused')
  assert.doesNotThrow(() => request('flow/source', { root: '/r', id: 'x', origin: 'project' }))
  assert.throws(() => request('flow/update/preview', { root: '/r', id: '', extra: 1 }), ValidationError)
  assert.throws(() => request('flow/customize/apply', { root: '/r', id: 'x', token: 't1', forced: true }), ValidationError)
})
