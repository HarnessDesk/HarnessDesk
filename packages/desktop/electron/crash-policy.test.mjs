import assert from 'node:assert/strict'
import { test } from 'node:test'

import { RELAUNCH_LOOP_MS, STORM_LIMIT, STORM_MS, crashDecision, crashStorm, forgetCrashes, respondToCrash } from './crash-policy.mjs'

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


test('a hook that throws cannot re-enter the handler — the crash-write loop', () => {
  // Measured 2026-09-13. The shell is started detached; its parent exits; the
  // pipe behind stdout breaks. The next `logger.error` raises EPIPE — and the
  // one place that logs unconditionally is this handler, so the throw was
  // delivered straight back to `uncaughtException`, which logged again. The
  // live run wrote 267,665 crash files and 1.0 GB of disk in six minutes and
  // then the process died.
  forgetCrashes()
  let records = 0
  const decision = respondToCrash('uncaughtException', Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }), {
    record: () => { records += 1 },
    log: () => { throw Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }) },
    readMarker: () => '0',
    writeMarker: () => {},
    relaunch: () => {},
    exit: () => {},
  })
  // Nothing escapes, so Node has nothing to redeliver: one crash, one record.
  assert.equal(records, 1)
  assert.equal(decision, 'continue')
})

test('and if it re-enters by some other road, the storm guard ends it', () => {
  // A hook that calls back into the handler rather than throwing is not what
  // the live failure did, but it is the same loop and nothing above catches
  // it. The window is the backstop: past the limit the handler stops
  // answering and exits.
  forgetCrashes()
  let records = 0
  let exits = 0
  let depth = 0
  const hooks = {
    record: () => { records += 1 },
    log: () => {
      depth += 1
      if (depth > 500) throw new Error('gave up: the handler re-entered 500 times')
      respondToCrash('uncaughtException', Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }), hooks)
    },
    readMarker: () => '0',
    writeMarker: () => {},
    relaunch: () => {},
    exit: () => { exits += 1 },
  }
  respondToCrash('uncaughtException', Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }), hooks)
  assert.ok(records <= STORM_LIMIT + 1, `the handler wrote ${records} crash records for one broken pipe`)
  assert.equal(exits, 1, 'the storm exits once, and does not log its way back in')
})

test('every hook is wrapped: one that throws does not take the others with it', () => {
  forgetCrashes()
  const done = []
  const decision = respondToCrash('uncaughtException', new TypeError('boom'), {
    record: () => { throw new Error('the crash reporter is broken too') },
    log: () => { done.push('log'); throw new Error('and so is the logger') },
    readMarker: () => '0',
    writeMarker: () => done.push('marker'),
    relaunch: () => done.push('relaunch'),
    exit: (code) => done.push(`exit ${code}`),
  })
  assert.equal(decision, 'relaunch')
  assert.deepEqual(done, ['log', 'marker', 'relaunch', 'exit 1'])
})

test('a marker that throws is not a reason to answer a different question', () => {
  // `readMarker` used to be the only guarded hook. It stays guarded: an
  // unreadable marker means "no relaunch on record", not "exit".
  forgetCrashes()
  let decided = null
  respondToCrash('uncaughtException', new TypeError('boom'), {
    record: () => {},
    log: (_kind, _error, decision) => { decided = decision },
    readMarker: () => { throw new Error('no such file') },
    writeMarker: () => {},
    relaunch: () => {},
    exit: () => {},
  })
  assert.equal(decided, 'relaunch')
})

test('a storm of crashes inside the window stops being answered, and the window slides', () => {
  forgetCrashes()
  const now = 5_000_000
  for (let i = 0; i < STORM_LIMIT; i += 1) {
    assert.equal(crashStorm(now + i), false, `crash ${i + 1} of ${STORM_LIMIT} is not yet a storm`)
  }
  assert.equal(crashStorm(now + STORM_LIMIT), true)
  // Quiet for longer than the window and it is calm again — a program that
  // crashes once a minute must never trip this.
  assert.equal(crashStorm(now + STORM_LIMIT + STORM_MS + 1), false)
})
