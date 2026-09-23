import assert from 'node:assert/strict'
import test from 'node:test'

import { InsightContexts } from '../src/insight/context.js'

test('a turn keeps its original message charge and completion observation', () => {
  const contexts = new InsightContexts()
  const message = { goal: 'goal-1', entry: 'entry-1', sender: { runtime: 'a', sessionId: 'one' }, receiver: { runtime: 'b', sessionId: 'two' } }
  contexts.start({ runtime: 'b', session: 'two', turn: 'turn-1', at: 1, seat: 'seat-1', before: null, message })
  // Duplicate start events do not replace the immutable cause.
  contexts.start({ runtime: 'b', session: 'two', turn: 'turn-1', at: 2, seat: null, before: null })
  contexts.complete('b', 'two', 'turn-1', 3, null)
  const [context] = contexts.forSession('b', 'two')
  assert.deepEqual(context?.cause, { kind: 'message', message })
  assert.equal(context?.endedAt, 3)
  assert.equal(context?.seat, 'seat-1')
})

test('unobserved history is not converted into a person-caused turn', () => {
  assert.deepEqual(new InsightContexts().forSession('runtime', 'missing'), [])
})
