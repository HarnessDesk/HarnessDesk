import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { mentionPriceSchedule, priceMentionUsage, quoteMentionHold } from '../src/lead/mention-observer-pricing.js'

const schedule = mentionPriceSchedule('claude-haiku-5-5')!

test('uses the published low and high prompt tiers including all cache tokens', () => {
  assert.equal(mentionPriceSchedule('unknown'), null)
  assert.ok(Object.isFrozen(schedule) && Object.isFrozen(schedule.low) && Object.isFrozen(schedule.high))
  assert.equal(priceMentionUsage(schedule, { inputTokens: 90_000, outputTokens: 1_000, cacheReadTokens: 10_000, cacheWriteTokens: 0 }), 9_600)
  assert.equal(priceMentionUsage(schedule, { inputTokens: 90_000, outputTokens: 1_000, cacheReadTokens: 10_001, cacheWriteTokens: 0 }), 48_001)
  assert.equal(priceMentionUsage(schedule, { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 100_000, cacheWrite5mTokens: 40_000, cacheWrite1hTokens: 60_000 }), 17_000)
})

test('holds the worst supported input and output rates and rounds up', () => {
  assert.equal(quoteMentionHold(schedule, 100_000, 1_000), 102_500)
  assert.equal(quoteMentionHold(schedule, 1, 1), 4)
  assert.equal(priceMentionUsage(schedule, { inputTokens: 1, outputTokens: 1, cacheReadTokens: 1, cacheWriteTokens: 0 }), 1)
  assert.equal(quoteMentionHold({ ...schedule, high: { ...schedule.high, input: -1 } }, 1, 1), null)
})

test('does not guess cache write TTL or accept inconsistent counters', () => {
  const base = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 1 }
  assert.equal(priceMentionUsage(schedule, base), null)
  assert.equal(priceMentionUsage(schedule, { ...base, cacheWrite5mTokens: 1 }), null)
  assert.equal(priceMentionUsage(schedule, { ...base, cacheWrite5mTokens: 1, cacheWrite1hTokens: 1 }), null)
  assert.equal(priceMentionUsage(schedule, { ...base, cacheWrite5mTokens: 1, cacheWrite1hTokens: 0 }), 1)
})

test('rejects invalid and overflowing values without undercharging', () => {
  for (const value of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal(quoteMentionHold(schedule, value, 1), null)
    assert.equal(priceMentionUsage(schedule, { inputTokens: value, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }), null)
  }
  assert.equal(quoteMentionHold(schedule, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER), null)
  assert.equal(priceMentionUsage(schedule, { inputTokens: Number.MAX_SAFE_INTEGER, outputTokens: 0, cacheReadTokens: 1, cacheWriteTokens: 0 }), null)
})
