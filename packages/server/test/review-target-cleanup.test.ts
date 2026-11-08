import assert from 'node:assert/strict'
import { test } from 'node:test'
import { registerReviewTargetCleanup } from './fixtures/review-target-cleanup.js'

for (const failure of ['none', 'host', 'remove'] as const) {
  test(`review fixture cleanup owns all resources when ${failure} fails`, async () => {
    const calls: string[] = []
    const hooks: (() => void | Promise<void>)[] = []
    let release!: () => void
    const held = new Promise<void>(resolve => { release = resolve })
    registerReviewTargetCleanup(fn => hooks.push(fn), {
      release: () => { calls.push('release'); release() },
      disposeKernel: async () => { calls.push('kernel') },
      disposeHost: async () => { calls.push('host'); await held; if (failure === 'host') throw new Error('host failed') },
      drain: async () => { calls.push('drain') },
      restore: () => { calls.push('restore') },
      remove: async () => { calls.push('remove'); if (failure === 'remove') throw new Error('remove failed') },
    })
    // Node 22 stops running later after-hooks once one hook throws.
    const run = async () => { for (const hook of hooks) await hook() }
    if (failure === 'none') await run()
    else await assert.rejects(run(), new RegExp(`${failure} failed`))
    assert.deepEqual(calls, ['release', 'kernel', 'host', 'drain', 'restore', 'remove'])
  })
}

test('review fixture keeps its environment and files until outstanding work settles', async () => {
  const calls: string[] = []
  let finish!: () => void
  const work = new Promise<void>(resolve => { finish = resolve })
  let entered!: () => void
  const draining = new Promise<void>(resolve => { entered = resolve })
  let cleanup!: () => void | Promise<void>
  registerReviewTargetCleanup(fn => { cleanup = fn }, {
    release: () => calls.push('release'),
    disposeKernel: async () => { calls.push('kernel') },
    disposeHost: async () => { calls.push('host') },
    drain: async () => { calls.push('drain'); entered(); await work },
    restore: () => { calls.push('restore') },
    remove: async () => { calls.push('remove') },
  })
  const closing = cleanup()
  await Promise.race([draining, Promise.resolve(closing).then(() => { throw new Error('cleanup skipped drain') })])
  assert.deepEqual(calls, ['release', 'kernel', 'host', 'drain'])
  finish()
  await closing
  assert.deepEqual(calls, ['release', 'kernel', 'host', 'drain', 'restore', 'remove'])
})
