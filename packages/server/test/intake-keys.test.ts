import assert from 'node:assert/strict'
import { test } from 'node:test'

import { eventKey, scheduleSlot } from '../src/intake/keys.js'

/*
 * A firing's identity is a framed tuple: two different facts never share a
 * key because of where a delimiter fell, and a schedule never replays a slot
 * it already passed, whatever the clock does.
 */

test('framed tuple does not collide at delimiters or numeric strings', () => {
  const keys = [
    eventKey(['a:b', 'c']),
    eventKey(['a', 'b:c']),
    eventKey([1]),
    eventKey(['1']),
    eventKey(['a', 'b']),
    eventKey(['a\u0000b']),
    eventKey(['a', '']),
    eventKey(['a']),
  ]
  assert.equal(new Set(keys).size, keys.length)
  for (const key of keys) assert.match(key, /^[a-f0-9]{64}$/)
  // Stable: the same tuple is the same key on every call and every restart.
  assert.equal(eventKey(['incarnation', 'review', 'pull-request', 7, 'abc']), eventKey(['incarnation', 'review', 'pull-request', 7, 'abc']))
})

test('schedule catches one slot without replay on restart or rollback', () => {
  const minute = 60_000
  const hour = 60 * minute
  const every = 60
  // Armed at 10:20: the 10:00 slot is before the baseline and never fires.
  const armed = 10 * hour + 20 * minute
  assert.equal(scheduleSlot(armed, armed, every), null)
  assert.equal(scheduleSlot(armed + 30 * minute, armed, every), null)
  // 11:00 is due at 11:00 exactly, and at any time in that hour.
  assert.equal(scheduleSlot(11 * hour, armed, every), 11 * hour)
  assert.equal(scheduleSlot(11 * hour + 59 * minute, armed, every), 11 * hour)
  // Once the watermark holds 11:00, the same slot is not due again (a restart).
  assert.equal(scheduleSlot(11 * hour + 30 * minute, 11 * hour, every), null)
  // Five slots missed while the desk was off: only the latest one is due.
  assert.equal(scheduleSlot(16 * hour + 5 * minute, 11 * hour, every), 16 * hour)
  // The clock rolled back past the watermark: nothing fires, nothing replays.
  assert.equal(scheduleSlot(9 * hour, 16 * hour, every), null)
  assert.equal(scheduleSlot(16 * hour, 16 * hour, every), null)
  // Slots are UTC-epoch aligned, so a daily schedule does not move with a timezone.
  assert.equal(scheduleSlot(Date.UTC(2026, 8, 24, 23, 59), Date.UTC(2026, 8, 23, 12), 1440), Date.UTC(2026, 8, 24))
  // Bad clocks and intervals are refused, never read as zero.
  assert.throws(() => scheduleSlot(Number.NaN, 0, every), /clock is invalid/)
  assert.throws(() => scheduleSlot(-1, 0, every), /clock is invalid/)
  assert.throws(() => scheduleSlot(0, 0.5, every), /clock is invalid/)
  assert.throws(() => scheduleSlot(0, 0, 0), /1–10080 minutes/)
  assert.throws(() => scheduleSlot(0, 0, 10081), /1–10080 minutes/)
})
