import assert from 'node:assert/strict'
import { test } from 'node:test'

import { formatCountdown, formatCountdownShort, formatResetCountdown, formatResetIn } from '../src/index.js'

const MINUTE = 60_000, HOUR = 60 * MINUTE, DAY = 24 * HOUR

test('a reset countdown reads the same on the Dashboard and in what the Lead is told (#2174)', () => {
  assert.equal(formatResetIn(21.14 * DAY), '21 d 3 h')
  assert.equal(formatResetCountdown(21.14 * DAY), 'in 21 d 3 h')
  assert.equal(formatResetIn(0), null, 'a reset that is due or past has no countdown')
  assert.equal(formatResetCountdown(-HOUR), '—')
  assert.equal(formatResetCountdown(null), '—')
  assert.equal(formatCountdown(2 * HOUR + 30 * MINUTE), '2h 30m')
  assert.equal(formatResetIn(59.5 * MINUTE), '1 h')
  assert.equal(formatCountdownShort(36 * HOUR), '2d')
})
