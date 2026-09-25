import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  BrowserInvocations,
  BrowserScopes,
  browserPartition,
  currentBrowserIdentity,
  runBrowserInvocation,
  withBrowserIdentity,
} from '../src/browser-scopes.js'

test('concurrent calls retain distinct state across awaits and leave the default intact', async () => {
  const live = new BrowserInvocations()
  const scopes = new BrowserScopes(
    (profile) => ({ profile, events: [] as string[] }),
    (identity) => live.has(identity),
  )
  const calls = ['lane-a', 'lane-b'].map((profile) => live.begin(profile, 'browser'))
  const answers = await Promise.all(
    calls.map((identity) =>
      withBrowserIdentity(identity, async () => {
        scopes.current().events.push(identity.profile)
        await Promise.resolve()
        return scopes.current().events.slice()
      }),
    ),
  )
  assert.deepEqual(answers, [['lane-a'], ['lane-b']])
  assert.deepEqual(scopes.current(), { profile: 'default', events: [] })
  assert.equal(scopes.entries().length, 3)
  calls.forEach((identity) => live.end(identity.invocation))
})

test('forged, mismatched and expired identities fail without allocating a profile', () => {
  const live = new BrowserInvocations()
  const scopes = new BrowserScopes(
    (profile) => profile,
    (identity) => live.has(identity),
  )
  const identity = live.begin('lane-a', 'browser')
  assert.throws(
    () => withBrowserIdentity({ ...identity, profile: 'lane-b' }, () => scopes.current()),
    /live invocation/,
  )
  assert.throws(() => live.resolve(identity.invocation, 'other-plugin'), /live invocation/)
  live.end(identity.invocation)
  assert.throws(() => withBrowserIdentity(identity, () => scopes.current()), /live invocation/)
  assert.deepEqual(scopes.entries(), [])
})

test('invocation lifetime ends on resolve or reject, including inherited asynchronous work', async () => {
  let captured: ReturnType<typeof currentBrowserIdentity>
  await runBrowserInvocation({ invocation: 'call-a', profile: 'lane-a' }, async () => {
    captured = currentBrowserIdentity()
    assert.equal(captured?.profile, 'lane-a')
  })
  assert.throws(() => withBrowserIdentity(captured!, () => currentBrowserIdentity()), /live invocation/)
  await assert.rejects(
    runBrowserInvocation({ invocation: 'call-b', profile: 'lane-b' }, async () => {
      throw new Error('failed')
    }),
    /failed/,
  )
  assert.throws(
    () =>
      withBrowserIdentity({ invocation: 'call-b', profile: 'lane-b' }, () => currentBrowserIdentity()),
    /live invocation/,
  )
})

test('partition names preserve default preference, isolate lanes and refuse arbitrary paths', () => {
  assert.equal(browserPartition(null, true), 'persist:harnessdesk-browser')
  assert.equal(browserPartition(null, false), 'harnessdesk-browser-once')
  assert.equal(browserPartition('lane-a', false), 'persist:hd-lane-a')
  assert.notEqual(browserPartition('lane-a', true), browserPartition('lane-b', true))
  for (const value of ['../personal', 'persist:personal', '', 'default', 'lane-a/b', 'lane-a\n']) {
    assert.throws(() => browserPartition(value, true), /host did not name/)
  }
})

test('an operation with no identity can demand an agent invocation', () => {
  assert.equal(currentBrowserIdentity(), undefined)
  assert.throws(() => currentBrowserIdentity(true), /live invocation/)
})
