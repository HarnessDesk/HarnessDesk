import assert from 'node:assert/strict'
import { test } from 'node:test'

import { acknowledgeEnvironment, environmentMeta } from '../src/lane-environment.js'

const env = (start: number) => ({
  HARNESSDESK_GOAL_ID: 'g1',
  HARNESSDESK_LANE_ID: `lane-${start}`,
  HARNESSDESK_PORT_START: String(start),
  HARNESSDESK_PORT_END: String(start + 19),
  HARNESSDESK_PORT_COUNT: '20',
  PORT: String(start),
})

test('ACP refuses unsupported environments and preserves metadata', () => {
  const meta = {
    harnessdesk: { instructions: 'Read carefully.', options: { mode: 'safe' } },
    vendor: { flag: true },
  }
  assert.throws(() => environmentMeta(meta, env(30_000), false), /cannot pass a lane environment/)
  assert.deepEqual(environmentMeta(meta, env(30_000), true), {
    ...meta,
    harnessdesk: { ...meta.harnessdesk, environment: env(30_000) },
  })
  assert.equal(Object.hasOwn(meta.harnessdesk, 'environment'), false)
})

test('an exact acknowledgement is required independent of key order', () => {
  assert.throws(() => acknowledgeEnvironment({}, env(30_000)), /did not acknowledge/)
  assert.throws(
    () => acknowledgeEnvironment({ harnessdesk: { environment: env(30_020) } }, env(30_000)),
    /did not acknowledge/,
  )
  assert.doesNotThrow(() =>
    acknowledgeEnvironment(
      { harnessdesk: { environment: Object.fromEntries(Object.entries(env(30_000)).reverse()) } },
      env(30_000),
    ),
  )
})
