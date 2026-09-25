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
  // agy signs in on its own, so these are its figures and are said to be.
  assert.equal(reading.unverified, 'agy CLI sign-in')
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

/**
 * What agy 1.2.6 printed with its ADC route forced and no credentials: the
 * JSON alone cannot tell a sign-out from a timeout; stderr can.
 */
const SIGNED_OUT = answered(
  JSON.stringify({ conversation_id: '', status: 'ERROR', response: '', error: 'authentication failed or timed out' }),
  {
    ok: false,
    code: 1,
    stderr: "Error: authentication required. Run 'agy' to log in.\nerror: authentication failed or timed out\n",
  },
)

const refusing = (error: string, stderr = ''): RunResult =>
  answered(JSON.stringify({ status: 'ERROR', error }), { ok: false, code: 1, stderr })

test('signed out is silence, in agy’s own words and no others', async () => {
  assert.equal(await new AgyMeter({ command: '/opt/agy', run: scripted(SIGNED_OUT).run }).read(), null)
  const lapsed = refusing('stored credentials are expired or revoked: oauth2: "invalid_grant"')
  assert.equal(await new AgyMeter({ command: '/opt/agy', run: scripted(lapsed).run }).read(), null)
})

test('a failure that only mentions authentication is an error, not a sign-out', async () => {
  // Each of these used to match a pattern as broad as "auth…", and was taken
  // for a sign-out: the reading was forgotten and nothing was logged.
  for (const [error, stderr] of [
    ['authentication service unavailable: HTTP 503', ''],
    ['retrieving quota summary: Proxy Authentication Required', ''],
    // The JSON on its own, without agy's sentence on stderr: a timeout says this too.
    ['authentication failed or timed out', 'error: authentication failed or timed out\n'],
  ] as const) {
    const meter = new AgyMeter({ command: '/opt/agy', run: scripted(refusing(error, stderr)).run })
    await assert.rejects(meter.read(), (cause: Error) => cause.message === `agy /usage failed: ${error}`)
  }
  // Words of our own about logging in are not agy's either.
  const invented = answered('', { ok: false, code: 1, stderr: 'Please log in with /login to continue.\n' })
  await assert.rejects(new AgyMeter({ command: '/opt/agy', run: scripted(invented).run }).read(), /not its JSON/)
})

test('agy that refuses in other ways, or says nothing, is reported rather than guessed at', async () => {
  const refused = new AgyMeter({ command: '/opt/agy', run: scripted(refusing('retrieving quota summary: HTTP 500')).run })
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
  const { calls, run } = scripted(answered(JSON.stringify(PRINTED)), SIGNED_OUT, answered(JSON.stringify(PRINTED)))
  const meter = new AgyMeter({ command: '/opt/agy', run, now: () => now })
  assert.ok(await meter.read())
  now += 61_000
  assert.equal(await meter.read(), null)
  // Inside the minute it is the silence that is held, never the forgotten figures.
  now += 1_000
  assert.equal(await meter.read(), null)
  assert.equal(calls.length, 2)
  // And after it, agy is asked again.
  now += 60_000
  assert.ok(await meter.read())
  assert.equal(calls.length, 3)
})

test('silence and failure are held for the minute too, not only figures', async () => {
  // The host refreshes after every finished turn. Holding only a reading meant
  // a signed-out agy — or one that answered nothing drawable, or failed — was
  // started again after each of them (#769, review round 2 of the landing).
  let now = NOW
  const silent = scripted(SIGNED_OUT, answered(JSON.stringify(PRINTED)))
  const quiet = new AgyMeter({ command: '/opt/agy', run: silent.run, now: () => now })
  assert.equal(await quiet.read(), null)
  now += 30_000
  assert.equal(await quiet.read(), null)
  assert.equal(silent.calls.length, 1, 'a signed-out agy is not started again inside the minute')
  now += 31_000
  assert.ok(await quiet.read())
  assert.equal(silent.calls.length, 2)

  now = NOW
  const empty = scripted(answered(JSON.stringify({ status: 'SUCCESS', command: { name: 'usage', data: { groups: [] } } })))
  const blank = new AgyMeter({ command: '/opt/agy', run: empty.run, now: () => now })
  assert.equal(await blank.read(), null)
  now += 59_000
  assert.equal(await blank.read(), null)
  assert.equal(empty.calls.length, 1, 'nor is one with nothing to draw')

  now = NOW
  const failing = scripted(refusing('retrieving quota summary: HTTP 500'), answered(JSON.stringify(PRINTED)))
  const broken = new AgyMeter({ command: '/opt/agy', run: failing.run, now: () => now })
  await assert.rejects(broken.read(), /HTTP 500/)
  now += 30_000
  // The same failure, so the card keeps its last figures with it beside them.
  await assert.rejects(broken.read(), /agy \/usage failed: retrieving quota summary: HTTP 500/)
  assert.equal(failing.calls.length, 1, 'nor is one that failed')
  now += 31_000
  assert.ok(await broken.read())
  assert.equal(failing.calls.length, 2)
})

test('an agy that is not installed is looked for again on the next read', { skip: process.platform === 'win32' }, async () => {
  // Nothing was started, so nothing is held: installing it is seen at once,
  // not a minute later.
  const dir = tempDir('hd-agy-path-')
  const { calls, run } = scripted(answered(JSON.stringify(PRINTED)))
  const meter = new AgyMeter({ run, now: () => NOW })
  const path = process.env['PATH']
  const home = process.env['HOME']
  process.env['HOME'] = join(dir, 'no-home')
  try {
    process.env['PATH'] = join(dir, 'empty')
    assert.equal(await meter.read(), null)
    assert.equal(calls.length, 0)
    // Installed now, inside the same minute.
    writeFileSync(join(dir, 'agy'), '#!/bin/sh\n')
    chmodSync(join(dir, 'agy'), 0o755)
    process.env['PATH'] = dir
    assert.ok(await meter.read())
    assert.deepEqual(calls.map((call) => call.command), [join(dir, 'agy')])
  } finally {
    process.env['PATH'] = path
    process.env['HOME'] = home
  }
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
