import assert from 'node:assert/strict'
import { test } from 'node:test'

import { answered } from './deadline.mjs'

/**
 * The safety net under every DevTools command the shell sends.
 *
 * The case it exists for cannot be reproduced from a unit test — it needs a
 * `<webview>` Chromium has stopped rasterising — so what is pinned here is the
 * behaviour that makes that case survivable: a promise that never settles
 * becomes an error with the command's name in it, and one that does settle is
 * passed through untouched, in both directions.
 */

test('passes a value through when the page answers', async () => {
  assert.equal(await answered('Page.navigate', Promise.resolve('ok')), 'ok')
})

test('passes a rejection through as itself, rather than as a timeout', async () => {
  await assert.rejects(
    answered('Runtime.evaluate', Promise.reject(new Error('Cannot find context'))),
    /Cannot find context/,
  )
})

test('turns a command that never answers into an error naming it', async () => {
  /*
   * Hold the event loop open for the length of the wait.
   *
   * The deadline timer is `unref`'d — deliberately, so that a command Chromium
   * never answers cannot keep the shell up for twenty seconds after a quit —
   * and an `unref`'d timer cannot keep the loop alive by itself. A pending
   * promise does not either. So this test is the one case in the file with
   * *nothing* ref'd: the loop empties, the runner decides the file is done,
   * and both this test and the one after it are reported
   * `failureType: 'cancelledByParent'` without a single assertion running.
   *
   * It passed locally on Node 25, whose test runner happens to hold a handle
   * of its own, and failed on CI's Node 22, which does not. Proved rather than
   * guessed: the same call outside the runner exits with code 0 and the
   * deadline never fires, on Node 25 too.
   */
  const keepAlive = setTimeout(() => {}, 1000)
  try {
    await assert.rejects(
      answered('Page.captureScreenshot', new Promise(() => {}), 20),
      (error) => {
        assert.match(error.message, /Page\.captureScreenshot/)
        // The sentence has to be usable by whoever reads it in a transcript:
        // it says what did not happen and offers the likely reason.
        assert.match(error.message, /not be on screen/)
        return true
      },
    )
  } finally {
    clearTimeout(keepAlive)
  }
})

test('does not hold the process open waiting for a deadline it no longer needs', async () => {
  // A settled command must clear its timer. Left pending, every screenshot
  // would keep the event loop alive for twenty seconds after the shell was
  // asked to quit.
  const before = process.getActiveResourcesInfo?.().filter((one) => one === 'Timeout').length ?? 0
  await answered('Page.enable', Promise.resolve(null))
  const after = process.getActiveResourcesInfo?.().filter((one) => one === 'Timeout').length ?? 0
  assert.equal(after, before)
})
