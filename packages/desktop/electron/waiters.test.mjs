import assert from 'node:assert/strict'
import { test } from 'node:test'

import { createWaiters } from './waiters.mjs'

test('a waiter that runs out of time leaves the queue, and the next settle skips it', async () => {
  // #49: the timeout filtered for `resolve`, and what had been queued was a wrapper around it.
  const waiters = createWaiters()
  await assert.rejects(waiters.wait(5, 'too slow'), /too slow/)
  assert.equal(waiters.pending, 0)
  const next = waiters.wait(1000, 'too slow')
  assert.equal(waiters.pending, 1)
  waiters.settle('guest')
  assert.equal(await next, 'guest')
  assert.equal(waiters.pending, 0)
})

test('several waiters: one runs out of time and another is settled, and a settle with nobody waiting is nothing', async () => {
  // Round 1 of #165.
  const waiters = createWaiters()
  waiters.settle('nobody')
  const early = waiters.wait(5, 'too slow')
  const late = waiters.wait(1000, 'too slow')
  await assert.rejects(early, /too slow/)
  assert.equal(waiters.pending, 1)
  waiters.settle('guest')
  assert.equal(await late, 'guest')
  const both = [waiters.wait(1000, 'x'), waiters.wait(1000, 'x')]
  waiters.settle('pane')
  assert.deepEqual(await Promise.all(both), ['pane', 'pane'])
  assert.equal(waiters.pending, 0)
})
