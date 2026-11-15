import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { AcpRuntime } from '@harnessdesk/adapter-acp'
import { scratch } from './scratch.js'

const make = (payload: unknown, extra: Record<string, string> = {}, fetchedAt = Date.now()) => {
  const log = join(scratch('usage-log-'), 'calls.log')
  const config = scratch('usage-config-')
  writeFileSync(join(config, '.claude.json'), JSON.stringify({
    oauthAccount: { accountUuid: 'fixture-account', emailAddress: 'dev@example.com' },
    cachedUsageUtilization: { accountUuid: 'fixture-account', fetchedAtMs: fetchedAt,
      utilization: (payload as typeof response).rate_limits },
  }))
  const runtime = new AcpRuntime({
    id: 'usage-agent', name: 'Usage agent', command: process.execPath,
    args: [fileURLToPath(new URL('../src/main.js', import.meta.url))],
    env: { HOME: scratch('usage-home-'), CLAUDE_CONFIG_DIR: config,
      CLAUDE_ACP_STATE_DIR: scratch('usage-state-'), CLAUDECODE: '',
      CLAUDE_CODE_EXECUTABLE: fileURLToPath(new URL('./fixtures/fake-claude.mjs', import.meta.url)),
      FAKE_CLAUDE_LOG: log, FAKE_CLAUDE_USAGE: JSON.stringify(payload),
      FAKE_CLAUDE_ACCOUNT: JSON.stringify({ email: 'dev@example.com', subscriptionType: 'max', apiProvider: 'firstParty' }), ...extra },
  })
  return { runtime, calls: () => readFileSync(log, 'utf8').split('\n').filter(line => line.startsWith('usage-skip-behaviors')) }
}

const response = {
  subscription_type: 'max', rate_limits_available: true,
  rate_limits: { five_hour: { utilization: 25, resets_at: '2026-12-01T00:00:00Z' },
    seven_day: { utilization: 99, resets_at: '2026-12-04T00:00:00Z' },
    model_scoped: [{ display_name: 'Fable', utilization: 90, resets_at: '2026-12-04T00:00:00Z' }] },
}

test('a successful control reply served from an old CLI cache retains its original age', async t => {
  const { runtime } = make(response, {}, 123_000)
  t.after(() => runtime.dispose())
  await runtime.start()
  await runtime.createSession({ cwd: scratch('usage-cwd-') })
  assert.equal((await runtime.getRateLimits())?.fetchedAt, 123_000)
})

test('reads current subscription usage through the existing process without a prompt or transcript scan', async t => {
  const { runtime, calls } = make(response)
  t.after(() => runtime.dispose())
  await runtime.start()
  assert.equal(await runtime.getRateLimits(), null, 'reading quota does not create a session')
  await runtime.createSession({ cwd: scratch('usage-cwd-') })
  assert.equal(runtime.info.capabilities.metered, true)
  const readings = await Promise.all(Array.from({ length: 5 }, () => runtime.getRateLimits()))
  assert.equal(readings[0]?.lanes?.find(lane => lane.id === 'weekly')?.usedPercent, 99)
  assert.equal(readings[0]?.lanes?.find(lane => lane.scope === 'Fable')?.usedPercent, 90)
  assert.equal(calls().length, 1, 'concurrent requests share one upstream read')
  assert.equal(calls()[0], 'usage-skip-behaviors true')
  await runtime.getRateLimits()
  assert.equal(calls().length, 1, 'repeated menu/turn reads respect the cooldown')
})

test('an account without subscription limits has no invented percentage', async t => {
  const { runtime } = make({ rate_limits_available: false, rate_limits: null })
  t.after(() => runtime.dispose())
  await runtime.start()
  await runtime.createSession({ cwd: scratch('usage-cwd-') })
  assert.equal((await runtime.getRateLimits())?.planLimitsUnavailable, true)
})

test('an upstream usage failure is a failed refresh rather than a fresh empty allowance', async t => {
  const { runtime, calls } = make(response, { FAKE_CLAUDE_USAGE_ERROR: 'usage unavailable' })
  t.after(() => runtime.dispose())
  await runtime.start()
  await runtime.createSession({ cwd: scratch('usage-cwd-') })
  await assert.rejects(runtime.getRateLimits(), /usage/i)
  await assert.rejects(runtime.getRateLimits(), /usage/i)
  assert.equal(calls().length, 1, 'failure is backed off, even across explicit refreshes')
})
