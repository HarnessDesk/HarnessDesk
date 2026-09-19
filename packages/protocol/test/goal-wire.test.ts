import assert from 'node:assert/strict'
import { test } from 'node:test'

import { parseClientMessage, ValidationError } from '../src/index.js'

const request = (method: string, params: unknown) => parseClientMessage({ id: 1, method, params })

test('Goal public writes reject host-owned data and unknown keys', () => {
  for (const field of ['origin', 'members', 'env', 'partition', 'ceiling', 'receipt']) {
    assert.throws(() => request('goal/create', { root: '/work/repo', sentence: 'Finish', [field]: {} }), ValidationError)
    assert.throws(() => request('goal/seat', { goal: 'g1', agent: 'reviewer', [field]: {} }), ValidationError)
    assert.throws(() => request('goal/update', { goal: 'g1', revision: 0, [field]: {} }), ValidationError)
  }
})

test('assignment and update accept only safe bounded ids and numbers', () => {
  const session = { runtime: 'fake', sessionId: 'one' }
  for (const card of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => request('goal/assign', { goal: 'g1', card, session }), ValidationError)
  }
  for (const revision of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => request('goal/update', { goal: 'g1', revision }), ValidationError)
  }
  assert.throws(() => request('goal/assign', { goal: '', card: 1, session }), ValidationError)
  assert.throws(() => request('goal/assign', { goal: 'g1', card: 1, session: { ...session, sessionId: 'x'.repeat(201) } }), ValidationError)
  assert.doesNotThrow(() => request('goal/assign', { goal: '/work/legacy', card: 1, session }))
})

test('both grant generations validate without accepting an effective ceiling from a client', () => {
  assert.doesNotThrow(() => request('goal/seat', { goal: 'g1', agent: 'reviewer', grant: { kind: 'permission', permission: 'read' } }))
  assert.doesNotThrow(() => request('goal/seat', { goal: 'g1', agent: 'reviewer', grant: { kind: 'ceiling', level: 'edit' } }))
  assert.throws(() => request('goal/seat', { goal: 'g1', agent: 'reviewer', grant: { kind: 'permission', permission: 'edit' } }), ValidationError)
  assert.throws(() => request('goal/seat', { goal: 'g1', agent: 'reviewer', grant: { kind: 'ceiling', level: 'edit', hold: 'held' } }), ValidationError)
})

test('sentences and dependency lists obey their public limits', () => {
  assert.throws(() => request('goal/create', { root: '/work/repo', sentence: '   ' }), ValidationError)
  assert.throws(() => request('goal/create', { root: '/work/repo', sentence: 'x'.repeat(2001) }), ValidationError)
  assert.throws(() => request('goal/create', { root: '/work/repo', sentence: 'Finish', dependsOn: Array(129).fill('g1') }), ValidationError)
  assert.doesNotThrow(() => request('goal/create', { root: '/work/repo', sentence: 'Finish', dependsOn: [] }))
})
