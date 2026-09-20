import assert from 'node:assert/strict'
import { test } from 'node:test'

import { goalMembers, goalOfSession, memberProjection } from '../src/goals/members.js'
import type { GoalDocument } from '../src/goals/store.js'
import { goal, seat } from './fixtures/goals.js'

const document = (): GoalDocument => ({
  version: 1, goal: goal(), board: { nextIntent: 1, messaging: true, intents: [], channel: [] },
  citations: [], receipt: null, operation: null,
})

test('membership survives a detached runtime and projects roles from Seat records', () => {
  const records = [seat('one', { role: 'reviewer' }), seat('two'), seat('gone', { closed: { at: 2, why: 'deleted' } })]
  const view = memberProjection(document(), records)
  assert.deepEqual(view.members, ['fake\u0000one', 'fake\u0000two'])
  assert.deepEqual(view.roles, { ['fake\u0000one']: 'reviewer' })
  assert.equal(goalOfSession([document()], records, { runtime: 'fake', sessionId: 'one' }), 'g1')
  assert.equal(goalOfSession([document()], records, { runtime: 'fake', sessionId: 'gone' }), null)
})

test('restored documents and staged openings acquire no live membership', () => {
  const record = seat()
  const { closed: _closed, ...opening } = record
  const pending: GoalDocument = {
    ...document(), operation: { kind: 'assignment', id: 'op', goal: 'g1', card: 1, opening, close: [] },
  }
  assert.deepEqual(goalMembers(pending, [record]), [])
  assert.deepEqual(goalMembers({ ...document(), restored: { at: 2 } }, [record]), [])
  assert.deepEqual(goalMembers(document(), [record]), [record])
})

test('two kept Goal Seats for a conversation are a repair error, never an arbitrary winner', () => {
  const pointer = { runtime: 'fake', sessionId: 'one' }
  const records = [seat('one', { session: pointer }), seat('two', { board: 'g2', session: pointer })]
  assert.throws(() => goalOfSession([document(), { ...document(), goal: goal('g2') }], records, pointer), /two Goals/)
})
