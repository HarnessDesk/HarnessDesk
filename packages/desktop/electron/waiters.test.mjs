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
