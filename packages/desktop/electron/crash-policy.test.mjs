import assert from 'node:assert/strict'
import { test } from 'node:test'

import { RELAUNCH_LOOP_MS, crashDecision, respondToCrash } from './crash-policy.mjs'

test('a pipe that went away under a write is somebody else’s exit; the shell carries on', () => {
  for (const code of ['EPIPE', 'ERR_STREAM_DESTROYED', 'ERR_STREAM_WRITE_AFTER_END']) {
    assert.equal(crashDecision(Object.assign(new Error('write ' + code), { code })), 'continue')
  }
})

test('an error that merely resembles one — a reset socket, a device — is not excused', () => {
  // These say nothing about a child's stdin: a reset connection is any socket
  // in the process and an I/O error is any device. Excusing them survived
  // failures the rule never meant to cover.
  for (const code of ['ECONNRESET', 'ECONNABORTED', 'EIO', 'ENOSPC', 'EACCES']) {
    assert.equal(
      crashDecision(Object.assign(new Error(code), { code })),
      'relaunch',
      `${code} must not be treated as a helper pipe`,
    )
  }
})

test('an unknown uncaught exception relaunches the shell rather than continuing on a state nobody can vouch for', () => {
  assert.equal(crashDecision(new TypeError('x is not a function')), 'relaunch')
  assert.equal(crashDecision('a string thrown'), 'relaunch')
  assert.equal(crashDecision(null), 'relaunch')
})

test('a relaunch that would only loop becomes an exit', () => {
  const now = 1_000_000
  assert.equal(crashDecision(new Error('boom'), { lastRelaunchAt: now - RELAUNCH_LOOP_MS / 2, now }), 'exit')
  assert.equal(crashDecision(new Error('boom'), { lastRelaunchAt: now - RELAUNCH_LOOP_MS * 2, now }), 'relaunch')
})

test('a relaunch is not mistaken for one that just happened when the clock went backwards', () => {
  // NTP steps the clock back after the marker is written: the difference is
  // negative, which is "less than the window" and used to answer `exit`.
  const now = 1_000_000
  assert.equal(crashDecision(new Error('boom'), { lastRelaunchAt: now + 5_000, now }), 'relaunch')
})

/**
 * The lifecycle, watched rather than the shell: what was recorded, what was
 * logged, whether the marker was written, and what happened to the process.
 */
const watch = ({ marker = '', now = 1_000_000 } = {}) => {
  const seen = { recorded: [], logged: [], wrote: null, relaunched: 0, exited: [] }
  const hooks = {
    record: (kind, error) => seen.recorded.push([kind, error]),
    log: (kind, _error, decision) => seen.logged.push([kind, decision]),
    readMarker: () => marker,
    writeMarker: (at) => {
      seen.wrote = at
    },
    relaunch: () => {
      seen.relaunched += 1
    },
    exit: (code) => seen.exited.push(code),
    now,
  }
  return { seen, hooks }
}

test('an unknown rejected promise is not survived: it is recorded and the shell relaunches', () => {
  const { seen, hooks } = watch()
  const reason = new TypeError('undefined is not a function')
  assert.equal(respondToCrash('unhandledRejection', reason, hooks), 'relaunch')
  assert.deepEqual(seen.recorded, [['unhandledRejection', reason]])
  assert.deepEqual(seen.logged, [['unhandledRejection', 'relaunch']])
  assert.equal(seen.wrote, 1_000_000)
  assert.equal(seen.relaunched, 1)
  assert.deepEqual(seen.exited, [1])
})

test('a rejection about a pipe that went away is logged and survived', () => {
  const { seen, hooks } = watch()
  const reason = Object.assign(new Error('write EPIPE'), { code: 'EPIPE' })
  assert.equal(respondToCrash('unhandledRejection', reason, hooks), 'continue')
  assert.deepEqual(seen.logged, [['unhandledRejection', 'continue']])
  assert.equal(seen.wrote, null, 'nothing is marked when nothing relaunches')
  assert.equal(seen.relaunched, 0)
  assert.deepEqual(seen.exited, [], 'the desk keeps working')
})

test('a rejection moments after a relaunch exits rather than looping', () => {
  const now = 1_000_000
  const { seen, hooks } = watch({ marker: String(now - 10_000), now })
  assert.equal(respondToCrash('unhandledRejection', new Error('boom'), hooks), 'exit')
  assert.equal(seen.relaunched, 0)
  assert.deepEqual(seen.exited, [1])
})

test('an uncaught exception takes exactly the same road', () => {
  const { seen, hooks } = watch()
  assert.equal(respondToCrash('uncaughtException', new Error('boom'), hooks), 'relaunch')
  assert.deepEqual(seen.logged, [['uncaughtException', 'relaunch']])
  assert.equal(seen.relaunched, 1)
})

test('a marker nobody can read is not a reason to fail', () => {
  const { seen, hooks } = watch()
  hooks.readMarker = () => {
    throw new Error('no such file')
  }
  assert.equal(respondToCrash('uncaughtException', new Error('boom'), hooks), 'relaunch')
  assert.equal(seen.relaunched, 1)
})

