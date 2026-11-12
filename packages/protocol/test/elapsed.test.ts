import assert from 'node:assert/strict'
import { test } from 'node:test'

import { elapsedMinutes, elapsedParts, formatElapsed } from '../src/index.js'

const MINUTE = 60_000, HOUR = 60 * MINUTE, NOW = Date.UTC(2026, 10, 11, 20, 0, 0)

test('elapsed time rounds down on every surface, so 14 hours 50 minutes is 14 hours (#2150)', () => {
  assert.equal(formatElapsed(NOW - (14 * HOUR + 50 * MINUTE), NOW), '14h ago')
  assert.deepEqual(elapsedParts(NOW - (14 * HOUR + 50 * MINUTE), NOW), { count: 14, unit: 'h' })
  assert.equal(formatElapsed(NOW - 59_999, NOW), 'just now')
  assert.equal(formatElapsed(NOW - 59 * MINUTE - 59_000, NOW), '59m ago')
  assert.equal(formatElapsed(NOW - 47 * HOUR, NOW), '1d ago')
  assert.equal(formatElapsed(NOW + HOUR, NOW), 'just now', 'a clock ahead is never a time in the future')
  assert.equal(elapsedMinutes(NOW - 2.9 * MINUTE, NOW), 2)
})
