import assert from 'node:assert/strict'
import { test } from 'node:test'

import { SEAT_READ_DEADLINE_MS, within, type Within } from '../src/seat-reads.js'

/**
 * One read, held to a deadline. Three answers, because three different things
 * happened: it answered, it failed, or it was not waited for.
 */

test('a read that answers in time is its answer', async () => {
  assert.deepEqual(await within(async () => 7, 1_000), { settled: 'value', value: 7 })
})

test('a read that fails in time is its failure, not a late read', async () => {
  const read = await within(async () => {
    throw new Error('refused')
  }, 1_000)
  assert.equal(read.settled, 'error')
  assert.equal(read.settled === 'error' && (read.error as Error).message, 'refused')
})

test('a read that throws before it is a promise is a failure too', async () => {
  const read = await within((): Promise<number> => {
    throw new Error('at once')
  }, 1_000)
  assert.equal(read.settled, 'error')
})

test('a read that never answers is let go at the deadline', async (t) => {
  // Deterministic: a mocked clock ticked exactly to the deadline, not a real
  // 25ms timer and a wall-clock bound generous enough for CI to still miss.
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const result = within(() => new Promise<never>(() => {}), 25)
  t.mock.timers.tick(25)
  assert.deepEqual(await result, { settled: 'late' })
})

test('the deadline a seating uses is ten seconds', () => {
  assert.equal(SEAT_READ_DEADLINE_MS, 10_000)
})

/*
 * None of these calls takes a signal, so a read that misses its deadline
 * keeps running. Its eventual answer — or failure — must still be dropped
 * quietly: nothing leaks, and nothing surfaces as an unhandled rejection.
 */

test('a read that answers after its deadline is dropped, quietly', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let answerLate: ((value: number) => void) | undefined
  const result = within(() => new Promise<number>((resolve) => (answerLate = resolve)), 10)
  t.mock.timers.tick(10)
  const settled: Within<number> = await result
  assert.deepEqual(settled, { settled: 'late' })
  // The read answers only now — well after `within` already returned — and
  // that answer must go nowhere, not throw, and not hang the process.
  answerLate?.(99)
  await new Promise((resolve) => setImmediate(resolve))
})

test('a read that fails after its deadline is dropped, quietly, and never as an unhandled rejection', async (t) => {
  const unhandled: unknown[] = []
  const onUnhandledRejection = (reason: unknown) => unhandled.push(reason)
  process.on('unhandledRejection', onUnhandledRejection)
  try {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    let failLate: ((error: unknown) => void) | undefined
    const result = within(() => new Promise<number>((_resolve, reject) => (failLate = reject)), 10)
    t.mock.timers.tick(10)
    assert.deepEqual(await result, { settled: 'late' })
    failLate?.(new Error('too late to matter'))
    // Give the now-late rejection a turn to become unhandled, if it ever would.
    await new Promise((resolve) => setImmediate(resolve))
    assert.deepEqual(unhandled, [], 'a late failure must not surface as an unhandled rejection')
  } finally {
    process.off('unhandledRejection', onUnhandledRejection)
  }
})
