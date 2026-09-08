import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

import { tempDir } from './scratch.js'

import { ClaudeFileMeter } from '../src/usage/claude-file.js'

/**
 * The file-backed meter, against the shape the agent actually writes.
 *
 * The fixtures are trimmed copies of a real cache: what matters is that a
 * model-scoped lane keeps its scope and its severity, that an older file with
 * only the two named windows still reports, and that an absent or unusable
 * file is silence rather than an error.
 */

const scratch = (): string => tempDir('hd-meter-')

const RESET = '2026-08-26T01:00:00.000Z'

const file = (body: unknown): string => {
  const dir = scratch()
  const path = join(dir, '.claude.json')
  writeFileSync(path, JSON.stringify(body))
  return path
}

test('reads every lane the agent cached, with its scope and its severity', async () => {
  const path = file({
    cachedUsageUtilization: {
      fetchedAtMs: 1_787_525_595_363,
      utilization: {
        limits: [
          { kind: 'session', group: 'session', percent: 29, severity: 'normal', resets_at: RESET },
          { kind: 'weekly_all', group: 'weekly', percent: 72, severity: 'normal', resets_at: RESET },
          {
            kind: 'weekly_scoped',
            group: 'weekly',
            percent: 100,
            severity: 'critical',
            resets_at: RESET,
            scope: { model: { id: null, display_name: 'Fable' } },
          },
        ],
      },
    },
    oauthAccount: { emailAddress: 'someone@example.com', organizationRateLimitTier: 'default_claude_max_20x' },
  })

  const reading = await new ClaudeFileMeter(path).read()
  assert.ok(reading)
  assert.equal(reading.account, 'someone@example.com')
  assert.equal(reading.plan, 'Max 20x', 'a tier id is not something to show a person')
  assert.equal(reading.fetchedAt, 1_787_525_595_363, 'the cache says when it was fetched, and we say so too')
  assert.equal(reading.lanes.length, 3)

  const scoped = reading.lanes.find((lane) => lane.scope === 'Fable')
  assert.equal(scoped?.id, 'weekly_scoped:fable', 'the scope is part of the id, not just the label')
  assert.equal(scoped?.label, 'Weekly')
  assert.equal(scoped?.severity, 'critical')
  assert.equal(scoped?.windowMinutes, 10_080)
  assert.equal(reading.reached, 'weekly_scoped:fable', 'a spent lane the source calls critical is reached')

  const session = reading.lanes.find((lane) => lane.id === 'session')
  assert.equal(session?.windowMinutes, 300)
  assert.equal(session?.resetsAt, Date.parse(RESET))
})

test('falls back to the two named windows, and never reports a lane twice', async () => {
  const path = file({
    cachedUsageUtilization: {
      fetchedAtMs: 1,
      utilization: {
        five_hour: { utilization: 12, resets_at: RESET },
        seven_day: { utilization: 40, resets_at: RESET },
      },
    },
  })
  const reading = await new ClaudeFileMeter(path).read()
  assert.deepEqual(
    reading?.lanes.map((lane) => [lane.id, lane.usedPercent]),
    [
      ['session', 12],
      ['weekly', 40],
    ],
  )
  assert.equal(reading?.reached, null)
})

test('extra usage earns a lane only once it is turned on', async () => {
  const off = await new ClaudeFileMeter(
    file({
      cachedUsageUtilization: {
        utilization: {
          limits: [{ kind: 'session', group: 'session', percent: 5, resets_at: RESET }],
          extra_usage: { is_enabled: false, utilization: 0, user_disabled: true },
        },
      },
    }),
  ).read()
  assert.equal(off?.lanes.length, 1)

  const on = await new ClaudeFileMeter(
    file({
      cachedUsageUtilization: {
        utilization: {
          limits: [{ kind: 'session', group: 'session', percent: 5, resets_at: RESET }],
          extra_usage: { is_enabled: true, utilization: 60, monthly_limit: 50, used_credits: 30, currency: 'USD' },
        },
      },
    }),
  ).read()
  assert.equal(on?.lanes.length, 2)
  assert.equal(on?.lanes[1]?.id, 'extra-usage')
  assert.deepEqual(on?.credits, { remaining: 20, unit: 'USD' })
})

test('an absent, unparseable, or empty file is silence, not an error', async () => {
  assert.equal(await new ClaudeFileMeter(join(scratch(), 'nothing.json')).read(), null)

  const broken = join(scratch(), '.claude.json')
  writeFileSync(broken, '{ not json')
  assert.equal(await new ClaudeFileMeter(broken).read(), null)

  assert.equal(await new ClaudeFileMeter(file({ oauthAccount: { emailAddress: 'a@b.c' } })).read(), null)
  assert.equal(
    await new ClaudeFileMeter(file({ cachedUsageUtilization: { utilization: { limits: [] } } })).read(),
    null,
    'a cache with no lanes has nothing to say',
  )
})

test('a lane with no percentage is skipped rather than reported as zero', async () => {
  const path = file({
    cachedUsageUtilization: {
      utilization: {
        limits: [
          { kind: 'session', group: 'session', percent: 10, resets_at: RESET },
          { kind: 'weekly_scoped', group: 'weekly', resets_at: RESET, scope: { model: { display_name: 'Later' } } },
        ],
      },
    },
  })
  const reading = await new ClaudeFileMeter(path).read()
  assert.equal(reading?.lanes.length, 1)
})
