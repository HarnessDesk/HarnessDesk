import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { CodexRuntime } from '../src/index.js'
import { mapAccountActivity } from '../src/mapping/account-usage.js'

const FAKE = fileURLToPath(new URL('./fixtures/fake-codex.mjs', import.meta.url))

test('account usage mapper converts bigint values and drops malformed dates at local midnight', () => {
  const activity = mapAccountActivity({
    summary: {
      lifetimeTokens: 9007199254740993n,
      peakDailyTokens: null,
      longestRunningTurnSec: null,
      currentStreakDays: null,
      longestStreakDays: null,
    },
    dailyUsageBuckets: [
      { startDate: '2026-09-29', tokens: 12n },
      { startDate: '2026-02-30', tokens: 15n },
    ],
  })

  assert.equal(activity?.days.length, 1)
  assert.equal(activity?.days[0]?.day, new Date(2026, 8, 29).getTime())
  assert.equal(activity?.days[0]?.tokens, 12)
  assert.equal(activity?.lifetimeTokens, Number(9007199254740993n))
  assert.equal(activity?.peakDailyTokens, null)
  assert.equal(activity?.currentStreakDays, null)
  assert.equal(activity?.longestStreakDays, null)
})

test('account usage mapper rejects a malformed response', () => {
  assert.equal(
    mapAccountActivity({ summary: null, dailyUsageBuckets: [] } as unknown as Parameters<typeof mapAccountActivity>[0]),
    null,
  )
})

test('account usage mapper treats an all-null summary with no buckets as unavailable', () => {
  assert.equal(mapAccountActivity({
    summary: {
      lifetimeTokens: null,
      peakDailyTokens: null,
      longestRunningTurnSec: null,
      currentStreakDays: null,
      longestStreakDays: null,
    },
    dailyUsageBuckets: [],
  }), null)
})

test('Codex adapter reads account activity from the fake app-server', async (t) => {
  const runtime = new CodexRuntime({ binaryPath: FAKE, clientName: 'harnessdesk-test' })
  t.after(async () => runtime.dispose())
  await runtime.start()

  const activity = await runtime.getAccountActivity()
  assert.ok(activity)
  assert.ok(activity.days.length > 0)
  assert.equal(typeof activity.lifetimeTokens, 'number')
})

test('Codex adapter treats an unsupported account usage method as unavailable', async (t) => {
  const runtime = new CodexRuntime({
    binaryPath: FAKE,
    clientName: 'harnessdesk-test',
    env: { FAKE_CODEX_USAGE_METHOD_NOT_FOUND: '1' },
  })
  t.after(async () => runtime.dispose())
  await runtime.start()

  assert.equal(await runtime.getAccountActivity(), null)
})
