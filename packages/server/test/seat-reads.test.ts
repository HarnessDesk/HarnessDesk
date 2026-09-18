import assert from 'node:assert/strict'
import { test } from 'node:test'

import { SEAT_READ_DEADLINE_MS, within } from '../src/seat-reads.js'

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

test('a read that never answers is let go at the deadline', async () => {
  const started = Date.now()
  assert.deepEqual(await within(() => new Promise<never>(() => {}), 25), { settled: 'late' })
  const took = Date.now() - started
  assert.ok(took >= 20 && took < 1_000, `let go after ${took} ms`)
})

test('the deadline a seating uses is ten seconds', () => {
  assert.equal(SEAT_READ_DEADLINE_MS, 10_000)
})
