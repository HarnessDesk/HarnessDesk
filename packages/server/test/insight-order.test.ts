import assert from 'node:assert/strict'
import test from 'node:test'

import { rankKnownSlots } from '../src/insight/order.js'

test('unknown slots and ties keep order', () => {
  const costs = new Map<string, number>([['a', 9], ['b', 2], ['c', 2], ['zero', 0]])
  assert.deepEqual(rankKnownSlots(['a', 'unknown', 'b', 'c', 'zero'], costs), ['zero', 'unknown', 'b', 'c', 'a'])
})
