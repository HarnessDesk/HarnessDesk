import assert from 'node:assert/strict'
import { test } from 'node:test'

import { laneEnvironmentOf } from '../src/index.js'

const env = (start: number) => ({
  HARNESSDESK_GOAL_ID: 'g1',
  HARNESSDESK_LANE_ID: `lane-${start}`,
  HARNESSDESK_PORT_START: String(start),
  HARNESSDESK_PORT_END: String(start + 19),
  HARNESSDESK_PORT_COUNT: '20',
  PORT: String(start),
})

test('validation returns an independent frozen map of exactly six values', () => {
  const input = env(30_000)
  const read = laneEnvironmentOf(input)
  input.PORT = '40000'
  assert.equal(read.PORT, '30000')
  assert.equal(Object.isFrozen(read), true)
  assert.equal(Object.keys(read).length, 6)
  assert.equal(
    laneEnvironmentOf({ ...env(30_000), HARNESSDESK_GOAL_ID: `/${'a'.repeat(300)}` })
      .HARNESSDESK_GOAL_ID?.length,
    301,
  )
})

test('unknown keys, control characters, missing values and invalid blocks refuse', () => {
  for (const value of [
    null,
    [],
    {},
    { ...env(30_000), HOME: '/work/wrong' },
    { ...env(30_000), HARNESSDESK_LANE_ID: 'a\u0000b' },
    { ...env(30_000), HARNESSDESK_GOAL_ID: '' },
    { ...env(30_000), HARNESSDESK_PORT_START: '030000' },
    { ...env(30_000), HARNESSDESK_PORT_END: '3e4' },
    { ...env(30_000), HARNESSDESK_PORT_COUNT: '21' },
    { ...env(30_000), PORT: '30001' },
    { ...env(65_520) },
  ]) {
    assert.throws(() => laneEnvironmentOf(value), /lane environment|lane port block/)
  }
})
