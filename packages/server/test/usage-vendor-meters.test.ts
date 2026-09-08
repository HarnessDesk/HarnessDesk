import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'

import { tempDir } from './scratch.js'

import { CopilotMeter, copilotToken, isPlaceholderQuota } from '../src/usage/copilot.js'
import { CursorMeter, cursorCookie, cursorPercentUsed } from '../src/usage/cursor.js'
import { GeminiMeter, geminiLanes } from '../src/usage/gemini.js'

/**
 * The vendor meters, against the payloads they actually send.
 *
 * The Cursor fixture is a real `/api/usage-summary` body with the identifiers
 * removed. It is the interesting one: the cents say 99.95% and the vendor's own
 * dashboard says 6%, and a desk that disagreed with the dashboard would be
 * wrong however defensible its arithmetic.
 */

const scratch = (): string => tempDir('hd-vendor-')

const jwt = (claims: Record<string, unknown>): string =>
  `x.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.y`

const HOUR = 3_600_000

const answering = (status: number, body: unknown): typeof globalThis.fetch =>
  (async () =>
    new Response(typeof body === 'string' ? body : JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    })) as unknown as typeof globalThis.fetch

const cursorDatabase = (token: string | null): string => {
  const path = join(scratch(), 'state.vscdb')
  const database = new DatabaseSync(path)
  database.exec('CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value BLOB)')
  if (token !== null) {
    database.prepare('INSERT INTO ItemTable (key, value) VALUES (?, ?)').run('cursorAuth/accessToken', token)
  }
  database.close()
  return path
}

const SUMMARY = {
  billingCycleStart: '2026-08-03T18:26:30.000Z',
  billingCycleEnd: '2026-09-03T18:26:30.000Z',
  membershipType: 'pro',
  isUnlimited: false,
  individualUsage: {
    plan: {
      enabled: true,
      used: 1999,
      limit: 2000,
      remaining: 1,
      autoPercentUsed: 0,
      apiPercentUsed: 44.42,
      totalPercentUsed: 5.794,
    },
    onDemand: { enabled: true, used: 1392, limit: 5000, remaining: 3608 },
  },
  teamUsage: {},
}

test('Cursor reports the figure its own dashboard reports, not the cents', () => {
  assert.equal(Math.round(cursorPercentUsed(SUMMARY) ?? -1), 6, 'totalPercentUsed wins')

  const withoutTotal = {
    individualUsage: { plan: { autoPercentUsed: 10, apiPercentUsed: 30 } },
  }
  assert.equal(cursorPercentUsed(withoutTotal), 20, 'then the two lanes averaged')

  const centsOnly = { individualUsage: { plan: { used: 1500, limit: 2000 } } }
  assert.equal(cursorPercentUsed(centsOnly), 75, 'then the cents')

  const pooled = { teamUsage: { pooled: { used: 1, limit: 4 } } }
  assert.equal(cursorPercentUsed(pooled), 25, 'and a team pool is better than nothing')

  assert.equal(cursorPercentUsed({}), null, 'an account with no figures reports none')
})

test('a Cursor session is read from its own store, and an expired one is not used', () => {
  const live = jwt({ sub: 'user|abc123', exp: Math.floor((Date.now() + HOUR) / 1000) })
  const cookie = cursorCookie(live)
  assert.ok(cookie?.startsWith('WorkosCursorSessionToken=abc123%3A%3A'), 'the id is the tail of the subject')

  const dead = jwt({ sub: 'user|abc123', exp: Math.floor((Date.now() - HOUR) / 1000) })
  assert.equal(cursorCookie(dead), null, 'an expired token is not sent anywhere')
  assert.equal(cursorCookie('not-a-jwt'), null)
  assert.equal(cursorCookie(jwt({ sub: 'user|../../etc' })), null, 'and a subject that is not an id is refused')
})

test('Cursor turns one plan into one lane, with its billing cycle and its balance', async () => {
  const meter = new CursorMeter({
    databasePath: cursorDatabase(jwt({ sub: 'auth0|abc', exp: Math.floor((Date.now() + HOUR) / 1000) })),
    fetch: answering(200, SUMMARY),
    now: () => 1_000,
  })
  const reading = await meter.read()
  assert.ok(reading)
  assert.equal(reading.plan, 'Pro')
  assert.equal(reading.lanes.length, 1)
  assert.equal(Math.round(reading.lanes[0]?.usedPercent ?? -1), 6)
  assert.equal(reading.lanes[0]?.resetsAt, Date.parse('2026-09-03T18:26:30.000Z'))
  assert.deepEqual(
    reading.credits,
    { remaining: 36.08, used: 13.92, unit: 'USD', unlimited: false },
    'used and remaining come from the one object in this payload whose cents add up',
  )
  assert.equal(reading.reached, null)
  assert.deepEqual(meter.watchPaths(), [], 'the editor rewrites its store constantly; watching it would be a poll')
})

test('Cursor is silent when it is signed out, and when there is no store at all', async () => {
  const signedOut = new CursorMeter({
    databasePath: cursorDatabase(jwt({ sub: 'auth0|abc', exp: Math.floor((Date.now() + HOUR) / 1000) })),
    fetch: answering(401, {}),
  })
  assert.equal(await signedOut.read(), null)

  const empty = new CursorMeter({ databasePath: cursorDatabase(null), fetch: answering(200, SUMMARY) })
  assert.equal(await empty.read(), null)

  const missing = new CursorMeter({ databasePath: join(scratch(), 'nothing.vscdb') })
  assert.equal(await missing.read(), null)
})

test('Copilot counts a quota it reports, and skips the slot it left empty', async () => {
  assert.equal(isPlaceholderQuota({ entitlement: 0, remaining: 0 }), true)
  assert.equal(isPlaceholderQuota({ entitlement: 0, remaining: 0, unlimited: true }), false)
  assert.equal(isPlaceholderQuota({ entitlement: 300, remaining: 120, percent_remaining: 40 }), false)

  const path = join(scratch(), 'apps.json')
  writeFileSync(path, JSON.stringify({ 'github.com:Iv1.abc': { oauth_token: 'gho_test', user: 'someone' } }))
  const meter = new CopilotMeter({
    configPaths: [path],
    now: () => 2_000,
    fetch: answering(200, {
      copilot_plan: 'business',
      quota_reset_date: '2026-09-01',
      quota_snapshots: {
        premium_interactions: { entitlement: 300, remaining: 45, percent_remaining: 15, unlimited: false },
        chat: { entitlement: 0, remaining: 0, unlimited: true },
      },
    }),
  })
  const reading = await meter.read()
  assert.ok(reading)
  assert.equal(reading.plan, 'Business')
  assert.deepEqual(
    reading.lanes.map((entry) => [entry.id, entry.usedPercent]),
    [['premium', 85]],
    'an unlimited quota is not a lane at 0%',
  )
  assert.equal(reading.lanes[0]?.resetsAt, Date.parse('2026-09-01T00:00:00Z'))
})

test('a Copilot token is found wherever the plugin filed it', () => {
  assert.equal(copilotToken(JSON.stringify({ 'github.com': { oauth_token: 'gho_1' } })), 'gho_1')
  assert.equal(copilotToken(JSON.stringify({ 'github.com': {} })), null)
  assert.equal(copilotToken('{ not json'), null)
})

test('Gemini keeps the tightest bucket per model, and stays quiet without a licence', async () => {
  const lanes = geminiLanes([
    { modelId: 'gemini-3-pro', tokenType: 'input', remainingFraction: 0.8, resetTime: '2026-08-24T00:00:00Z' },
    { modelId: 'gemini-3-pro', tokenType: 'output', remainingFraction: 0.25, resetTime: '2026-08-24T00:00:00Z' },
    { modelId: 'gemini-3-flash', tokenType: 'input', remainingFraction: 1 },
    { tokenType: 'input', remainingFraction: 0.5 },
  ])
  assert.deepEqual(
    lanes.map((entry) => [entry.scope, entry.usedPercent]),
    [
      ['gemini-3-flash', 0],
      ['gemini-3-pro', 75],
    ],
    'input and output for one model are one allowance to a person',
  )

  const path = join(scratch(), 'oauth_creds.json')
  writeFileSync(path, JSON.stringify({ access_token: 'ya29.test', expiry_date: 9_000 }))

  const unlicensed = new GeminiMeter({
    credentialsPath: path,
    now: () => 1_000,
    fetch: answering(403, { error: { status: 'PERMISSION_DENIED', message: 'SUBSCRIPTION_REQUIRED' } }),
  })
  assert.equal(await unlicensed.read(), null, 'no licence is a fact about the account, not an error')

  const stale = new GeminiMeter({ credentialsPath: path, now: () => 10_000, fetch: answering(200, {}) })
  assert.equal(await stale.read(), null, 'an expired token is left for the CLI to refresh')
})
