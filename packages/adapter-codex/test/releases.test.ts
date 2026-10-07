import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { CodexProtocol } from '@harnessdesk/codex'
import { isClosingRefusal, ThreadReleases } from '../src/releases.js'

const closed = (threadId: string) => ({ method: 'thread/closed', params: { threadId } }) as CodexProtocol.ServerNotification
const unloaded = (threadId: string) =>
  ({ method: 'thread/status/changed', params: { threadId, status: { type: 'notLoaded' } } }) as CodexProtocol.ServerNotification
const idle = (threadId: string) =>
  ({ method: 'thread/status/changed', params: { threadId, status: { type: 'idle' } } }) as CodexProtocol.ServerNotification
const settled = async (promise: Promise<void> | undefined): Promise<boolean> =>
  promise ? Promise.race([promise.then(() => true), new Promise<boolean>((resolve) => setImmediate(() => resolve(false)))]) : false

test('the close Codex was owed is consumed, and settles whoever waits for it', async () => {
  const releases = new ThreadReleases()
  releases.expect('a')
  const waiting = releases.closed('a')
  assert.equal(await settled(waiting), false, 'nothing yet')
  assert.equal(releases.ends(unloaded('a')), true, 'the status that precedes it is not news either')
  assert.equal(await settled(waiting), false, 'but only `thread/closed` ends the wait')
  assert.equal(releases.ends(closed('a')), true)
  assert.equal(await settled(waiting), true)
  assert.equal(releases.closed('a'), undefined)
  assert.equal(releases.ends(closed('a')), false, 'a second close of the same thread is news')
})

test('notices about a thread no close was owed for are left alone', () => {
  const releases = new ThreadReleases()
  releases.expect('a')
  assert.equal(releases.ends(closed('b')), false)
  assert.equal(releases.ends(unloaded('b')), false)
  assert.equal(releases.ends(idle('a')), false, 'a status that is not the thread leaving')
  assert.equal(releases.ends({ method: 'thread/archived', params: { threadId: 'a' } } as CodexProtocol.ServerNotification), false)
  assert.equal(releases.ends(unloaded('a')), true)
})

test('a thread subscribed again, or a process that is gone, owes nothing and releases its waiters', async () => {
  const releases = new ThreadReleases()
  releases.expect('a')
  releases.expect('b')
  const a = releases.closed('a')
  const b = releases.closed('b')
  releases.cancel('a')
  assert.equal(await settled(a), true)
  assert.equal(releases.ends(closed('a')), false, 'nothing is owed for it any more')
  releases.clear()
  assert.equal(await settled(b), true)
  assert.equal(releases.ends(closed('b')), false)
})

test('a handle closed twice waits for one close, not two', async () => {
  const releases = new ThreadReleases()
  releases.expect('a')
  const first = releases.closed('a')
  releases.expect('a')
  assert.equal(await settled(first), true, 'the earlier wait is released rather than stranded')
  assert.equal(releases.ends(closed('a')), true)
  assert.equal(releases.ends(closed('a')), false)
})

test('threads Codex never closes do not pile up without bound', async () => {
  const releases = new ThreadReleases()
  releases.expect('first')
  const oldest = releases.closed('first')
  for (let n = 0; n < 1_024; n++) releases.expect(`later-${n}`)
  assert.equal(await settled(oldest), true, 'the oldest is forgotten and its waiter released')
  assert.equal(releases.closed('first'), undefined)
  assert.notEqual(releases.closed('later-1023'), undefined, 'the newest are kept')
})

test('only Codex’s own words for a thread it is closing are a reason to ask again', () => {
  assert.equal(isClosingRefusal(new Error('thread 01a is closing; retry thread/resume after the thread is closed')), true)
  assert.equal(isClosingRefusal(new Error('thread 01a not found')), false)
  assert.equal(isClosingRefusal(new Error('thread 01a already has an active writer')), false)
  assert.equal(isClosingRefusal('is closing; retry thread/resume'), false, 'not an error')
})
