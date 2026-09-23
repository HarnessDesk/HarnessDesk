import assert from 'node:assert/strict'
import { test } from 'node:test'

import { parseClientMessage, ValidationError } from '../src/index.js'

const request = (method: string, params: unknown) => parseClientMessage({ id: 1, method, params })

test('attachment/agent and attachment/notes take a plain id/origin, never a path, a digest or a loaded state', () => {
  assert.doesNotThrow(() => request('attachment/agent', { id: 'reviewer', origin: 'user' }))
  assert.doesNotThrow(() => request('attachment/notes', { id: 'reviewer', origin: 'builtin' }))
  for (const forged of ['path', 'digest', 'agentDigest', 'declarations', 'support', 'text', 'writable']) {
    assert.throws(() => request('attachment/agent', { id: 'reviewer', origin: 'user', [forged]: 'x' }), ValidationError)
    assert.throws(() => request('attachment/notes', { id: 'reviewer', origin: 'user', [forged]: 'x' }), ValidationError)
  }
  assert.throws(() => request('attachment/agent', { id: 'reviewer', origin: 'invented' }), ValidationError)
})

test('attachment/edit/preview and .../write reject a forged digest, ceiling or ambient approval', () => {
  const base = { id: 'reviewer', origin: 'user', skills: ['review-checklist'], mcp: [] }
  assert.doesNotThrow(() => request('attachment/edit/preview', base))
  assert.doesNotThrow(() => request('attachment/edit/write', { ...base, digest: 'd'.repeat(64) }))
  for (const forged of ['ceiling', 'approved', 'loaded', 'agentDigest', 'path']) {
    assert.throws(() => request('attachment/edit/preview', { ...base, [forged]: 'x' }), ValidationError)
    assert.throws(() => request('attachment/edit/write', { ...base, digest: 'd'.repeat(64), [forged]: 'x' }), ValidationError)
  }
  // builtin can never be a write target, at the wire, before any handler runs.
  assert.throws(() => request('attachment/edit/preview', { ...base, origin: 'builtin' }), ValidationError)
  assert.throws(() => request('attachment/edit/write', { ...base, origin: 'builtin', digest: 'd'.repeat(64) }), ValidationError)
})

test('attachment/notes/clear takes only user or project, and its digest is never optional', () => {
  assert.doesNotThrow(() => request('attachment/notes/clear', { id: 'reviewer', origin: 'user', digest: 'd'.repeat(64) }))
  assert.throws(() => request('attachment/notes/clear', { id: 'reviewer', origin: 'builtin', digest: 'd'.repeat(64) }), ValidationError)
  assert.throws(() => request('attachment/notes/clear', { id: 'reviewer', origin: 'user' }), ValidationError)
  assert.throws(() => request('attachment/notes/clear', { id: 'reviewer', origin: 'user', digest: 'd'.repeat(64), text: 'forged' }), ValidationError)
})

test('attachment/review requires an explicit root — trust is bound to where a Seat would actually open, never inferred', () => {
  assert.doesNotThrow(() => request('attachment/review', { id: 'reviewer', origin: 'user', root: '/work/repo', runtime: 'claude-code' }))
  assert.throws(() => request('attachment/review', { id: 'reviewer', origin: 'user', runtime: 'claude-code' }), ValidationError)
  for (const forged of ['ceiling', 'incarnation', 'build', 'token', 'consequence', 'effectiveCeiling']) {
    assert.throws(() => request('attachment/review', { id: 'reviewer', origin: 'user', root: '/work/repo', runtime: 'claude-code', [forged]: 'x' }), ValidationError)
  }
})

test('attachment/approve takes only a bounded opaque token, and attachment/seat only a seat id', () => {
  assert.doesNotThrow(() => request('attachment/approve', { token: 'a-real-token' }))
  assert.throws(() => request('attachment/approve', { token: 'x'.repeat(201) }), ValidationError)
  assert.throws(() => request('attachment/approve', { token: 'a-real-token', loaded: true }), ValidationError)
  assert.doesNotThrow(() => request('attachment/seat', { seat: 'seat-1' }))
  assert.throws(() => request('attachment/seat', {}), ValidationError)
  assert.throws(() => request('attachment/seat', { seat: 'seat-1', results: [] }), ValidationError)
})
