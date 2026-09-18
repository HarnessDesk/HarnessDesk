import assert from 'node:assert/strict'
import { chmodSync, writeFileSync } from 'node:fs'
import { devNull } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import type { RunResult } from '../../src/installs/run.js'
import { AgyMeter, agyLanes } from '../../src/usage/agy.js'
import { tempDir } from '../scratch.js'

/**
 * Antigravity's meter, against what `agy --print /usage --output-format json`
 * actually printed on agy 1.2.6, 2026-09-17 — the Gemini group spent for the
 * week, the Claude and GPT group untouched.
 */

const PRINTED = {
  conversation_id: '',
  status: 'SUCCESS',
  response:
    'Gemini Models\tWeekly Limit Remaining\t0%\t2026-09-24T00:02:21Z\nClaude and GPT models\tWeekly Limit Remaining\t100%\t2026-09-25T05:22:58Z\n',
  duration_seconds: 0,
  num_turns: 0,
  usage: { input_tokens: 0, output_tokens: 0, thinking_tokens: 0, cache_read_tokens: 0, total_tokens: 0 },
  command: {
    name: 'usage',
    data: {
      description:
        'Within each group, models share a weekly limit. Quota is consumed proportionally to the cost of the tokens.',
      groups: [
        {
          name: 'Gemini Models',
          description: 'Models within this group: Gemini Flash, Gemini Pro',
          buckets: [
            {
              id: 'gemini-weekly',
              name: 'Weekly Limit Remaining',
              description: 'You have hit your weekly limit, it refreshes in 5 days, 18 hours.',
              window: 'weekly',
              remaining_fraction: 0,
              reset_time: '2026-09-24T00:02:21Z',
            },
          ],
        },
        {
          name: 'Claude and GPT models',
          description: 'Models within this group: Claude Opus, Claude Sonnet, GPT-OSS',
          buckets: [
            {
              id: '3p-weekly',
              name: 'Weekly Limit Remaining',
              window: 'weekly',
              remaining_fraction: 1,
              reset_time: '2026-09-25T05:22:58Z',
            },
          ],
        },
      ],
    },
  },
}

const WEEK = 7 * 24 * 60
const NOW = Date.parse('2026-09-18T05:22:58Z')

const answered = (stdout: string, overrides: Partial<RunResult> = {}): RunResult => ({
  ok: true,
  code: 0,
  stdout,
  stderr: '',
  timedOut: false,
  ...overrides,
})

/** A `run` that records what it was asked and answers from a queue. */
const scripted = (...answers: RunResult[]) => {
  const calls: { command: string; args: readonly string[] }[] = []
  const run = async (command: string, args: readonly string[]): Promise<RunResult> => {
    calls.push({ command, args })
    const next = answers.shift()
    assert.ok(next, 'agy was run more often than the test expected')
    return next
  }
  return { calls, run }
}

test('each group is a lane scoped to its models, and a spent one is what was reached', () => {
  const lanes = agyLanes(PRINTED.command.data)
  assert.deepEqual(
    lanes.map((lane) => [lane.id, lane.label, lane.scope, lane.usedPercent, lane.windowMinutes]),
    [
      ['gemini-weekly', 'Weekly', 'Gemini Models', 100, WEEK],
      ['3p-weekly', 'Weekly', 'Claude and GPT models', 0, WEEK],
    ],
  )
  assert.equal(lanes[0]?.resetsAt, Date.parse('2026-09-24T00:02:21Z'))
  // Untouched, its "reset" was now-plus-a-week and moved on every read.
  assert.equal(lanes[1]?.resetsAt, null)
  assert.ok(lanes.every((lane) => lane.usageKnown === true))
})

test('a bucket outside any group is the account’s, and ones that say nothing drawable are marked so', () => {
  const lanes = agyLanes({
    buckets: [{ id: 'daily', window: 'daily', remaining_fraction: 0.25, reset_time: '2026-09-18T00:00:00Z' }],
    groups: [
      {
        name: 'Gemini Models',
        buckets: [
          { id: 'off', window: 'weekly', remaining_fraction: 0.5, disabled: true },
          { window: 'weekly', remaining_amount: 40 },
          { window: 'fortnightly', remaining_fraction: 0.75 },
        ],
      },
    ],
  })
  assert.deepEqual(
    lanes.map((lane) => [lane.id, lane.scope, lane.usedPercent, lane.usageKnown, lane.windowMinutes]),
    [
      ['daily', null, 75, true, 24 * 60],
      // A count with no total beside it is not a share of anything.
      ['gemini-models:weekly', 'Gemini Models', 0, false, WEEK],
      // A window the desk has no length for keeps its name and no length.
      ['gemini-models:fortnightly', 'Gemini Models', 25, true, null],
    ],
  )
  assert.equal(lanes[2]?.label, 'Fortnightly')
})

test('the reading is agy’s own /usage, run so that it changes nothing', async () => {
  const { calls, run } = scripted(answered(JSON.stringify(PRINTED)))
  const meter = new AgyMeter({ command: '/opt/agy', run, now: () => NOW })
  const reading = await meter.read()
  assert.ok(reading)
  assert.equal(reading.reached, 'gemini-weekly')
  assert.equal(reading.account, null)
  assert.equal(reading.fetchedAt, NOW)
  assert.deepEqual(calls, [
    {
      command: '/opt/agy',
      // Its log goes nowhere: one ~20 KB file per read in agy's own folder
      // would pile up by the hundred.
      args: ['--print', '/usage', '--output-format', 'json', '--log-file', devNull],
    },
  ])
})

test('a reading younger than a minute is answered again, with its own time', async () => {
  let now = NOW
  const { calls, run } = scripted(answered(JSON.stringify(PRINTED)), answered(JSON.stringify(PRINTED)))
  const meter = new AgyMeter({ command: '/opt/agy', run, now: () => now })
  const first = await meter.read()
  now += 30_000
  const again = await meter.read()
  assert.equal(calls.length, 1, 'a turn finishing every few seconds does not start agy every few seconds')
  assert.equal(again?.fetchedAt, first?.fetchedAt)
  now += 31_000
  await meter.read()
  assert.equal(calls.length, 2)
})

test('signed out is silence, and anything else agy refuses is an error worth logging', async () => {
  const signedOut = new AgyMeter({
    command: '/opt/agy',
    run: scripted(
      answered(JSON.stringify({ status: 'ERROR', error: 'transcription requires CLI authentication' }), { ok: false, code: 1 }),
    ).run,
  })
  assert.equal(await signedOut.read(), null)

  const plainText = new AgyMeter({
    command: '/opt/agy',
    run: scripted(answered('', { ok: false, code: 1, stderr: 'Please log in with /login to continue.\n' })).run,
  })
  assert.equal(await plainText.read(), null)

  const refused = new AgyMeter({
    command: '/opt/agy',
    run: scripted(answered(JSON.stringify({ status: 'ERROR', error: 'retrieving quota summary: HTTP 500' }), { ok: false, code: 1 })).run,
  })
  await assert.rejects(refused.read(), /agy \/usage failed: retrieving quota summary: HTTP 500/)

  const hung = new AgyMeter({
    command: '/opt/agy',
    run: scripted(answered('', { ok: false, code: null, timedOut: true })).run,
  })
  await assert.rejects(hung.read(), /did not answer/)

  const empty = new AgyMeter({
    command: '/opt/agy',
    run: scripted(answered(JSON.stringify({ status: 'SUCCESS', command: { name: 'usage', data: { groups: [] } } }))).run,
  })
  assert.equal(await empty.read(), null, 'no buckets is nothing to say, not a card')
})

test('a signed-out answer forgets the last reading instead of repeating it', async () => {
  let now = NOW
  const { run } = scripted(
    answered(JSON.stringify(PRINTED)),
    answered(JSON.stringify({ status: 'ERROR', error: 'not authenticated' }), { ok: false, code: 1 }),
    answered(JSON.stringify(PRINTED)),
  )
  const meter = new AgyMeter({ command: '/opt/agy', run, now: () => now })
  assert.ok(await meter.read())
  now += 61_000
  assert.equal(await meter.read(), null)
  // And the next read asks again rather than answering from the forgotten one.
  now += 1_000
  assert.ok(await meter.read())
})

test('the real run turns agy’s self-update off, and survives a banner before the JSON', { skip: process.platform === 'win32' }, async () => {
  const dir = tempDir('hd-agy-')
  const agy = join(dir, 'agy')
  // Answers with the switch it was handed, so the test reads what agy would.
  writeFileSync(
    agy,
    [
      '#!/bin/sh',
      'echo "A new version is available"',
      `printf '%s' '{"status":"SUCCESS","command":{"name":"usage","data":{"groups":[{"name":"G","buckets":[{"id":"'"$AGY_CLI_DISABLE_AUTO_UPDATE"'-'"$6"'","window":"weekly","remaining_fraction":0.5}]}]}}}'`,
      '',
    ].join('\n'),
  )
  chmodSync(agy, 0o755)
  const reading = await new AgyMeter({ command: agy }).read()
  // `true`, not `1`: agy 1.2.6 ignores the digit and updates itself anyway.
  assert.equal(reading?.lanes[0]?.id, `true-${devNull}`)
  assert.equal(reading?.lanes[0]?.usedPercent, 50)
})
