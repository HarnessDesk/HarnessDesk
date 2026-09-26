import assert from 'node:assert/strict'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'

import { tempDir } from '../scratch.js'

import { addCalendarMonth, CursorMeter, legacyRequestLanes } from '../../src/usage/cursor.js'

/**
 * A legacy, request-based Cursor plan — the account is billed against its own
 * request counter (`GET /api/usage?user=<id>`) whether or not `usage-summary`
 * resolves a percent, since that percent measures a different,
 * dollar-denominated pool. Synthesized fixtures only, on a single made-up
 * cycle anchor reused throughout: the field names are what the real endpoint
 * was confirmed to answer with (read-only, once), never a recorded response
 * or a real timestamp.
 */

const scratch = (): string => tempDir('hd-cursor-request-')

const jwt = (claims: Record<string, unknown>): string =>
  `x.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.y`

const HOUR = 3_600_000

const cursorDatabase = (token: string): string => {
  const path = join(scratch(), 'state.vscdb')
  const database = new DatabaseSync(path)
  database.exec('CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value BLOB)')
  database.prepare('INSERT INTO ItemTable (key, value) VALUES (?, ?)').run('cursorAuth/accessToken', token)
  database.close()
  return path
}

const TOKEN = jwt({ sub: 'auth0|legacy-user', exp: Math.floor((Date.now() + HOUR) / 1000) })

/** One made-up cycle, reused everywhere a "current" cycle is needed. */
const CYCLE_START = '2026-08-15T00:00:00.000Z'
const CYCLE_END = '2026-09-15T00:00:00.000Z'

/** A `usage-summary` body with nothing `cursorPercentUsed` can resolve. */
const NO_PERCENT_SUMMARY = {
  billingCycleStart: CYCLE_START,
  billingCycleEnd: CYCLE_END,
  membershipType: 'pro',
  isUnlimited: false,
  individualUsage: {},
  teamUsage: {},
}

/** A `usage-summary` body that resolves a small percent from the *other* pool. */
const SMALL_PERCENT_SUMMARY = {
  billingCycleStart: CYCLE_START,
  billingCycleEnd: CYCLE_END,
  membershipType: 'pro',
  isUnlimited: false,
  individualUsage: { plan: { enabled: true, totalPercentUsed: 6 } },
  teamUsage: {},
}

const withOnDemand = (onDemand: { enabled: boolean; used?: number; limit?: number; remaining?: number }) => ({
  ...NO_PERCENT_SUMMARY,
  individualUsage: { ...NO_PERCENT_SUMMARY.individualUsage, onDemand },
})

const LEGACY_SINGLE = {
  'gpt-4': { numRequests: 313, numRequestsTotal: 313, numTokens: 0, maxRequestUsage: 500, maxTokenUsage: null },
  startOfMonth: CYCLE_START,
}

const LEGACY_MULTI = {
  'gpt-4': { numRequests: 480, numRequestsTotal: 480, numTokens: 0, maxRequestUsage: 500, maxTokenUsage: null },
  'gpt-4-32k': { numRequests: 10, numRequestsTotal: 10, numTokens: 0, maxRequestUsage: 50, maxTokenUsage: null },
  // No usable limit: skipped rather than reported as a lane with nothing to measure.
  embeddings: { numRequests: 900, numTokens: 12, maxRequestUsage: null, maxTokenUsage: null },
  startOfMonth: CYCLE_START,
}

/** A counter at its limit, aligned to `CYCLE_START` — the live, maxed-out case. */
const LEGACY_AT_LIMIT = {
  'gpt-4': { numRequests: 500, numRequestsTotal: 500, numTokens: 0, maxRequestUsage: 500, maxTokenUsage: null },
  startOfMonth: CYCLE_START,
}

/** Answers a different body per endpoint prefix, the way the real calls need. */
const answeringByUrl = (routes: Readonly<Record<string, { status: number; body: unknown }>>): typeof globalThis.fetch =>
  (async (input: unknown) => {
    const url = typeof input === 'string' ? input : (input as { toString(): string }).toString()
    // Longest match first: `/api/usage-summary` is itself a prefix of `/api/usage`'s
    // own prefix check, so the more specific route has to win regardless of
    // the order the routes were declared in.
    const prefix = Object.keys(routes)
      .sort((a, b) => b.length - a.length)
      .find((candidate) => url.startsWith(candidate))
    if (!prefix) throw new Error(`unexpected fetch in test: ${url}`)
    const { status, body } = routes[prefix]!
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
  }) as unknown as typeof globalThis.fetch

test('a calendar month is added in UTC, clamped across a shorter month, through a DST month', () => {
  // 31 days into a 28-day February: clamps to the last day rather than
  // rolling into March, the way a billing cycle actually resets.
  assert.equal(
    addCalendarMonth(Date.parse('2026-01-31T12:00:00.000Z')),
    Date.parse('2026-02-28T12:00:00.000Z'),
    '31 → 28-day month clamps, does not roll over',
  )
  // A 31-day month into a 30-day one: no clamp needed, matches CYCLE_START/END
  // used elsewhere in this suite.
  assert.equal(addCalendarMonth(Date.parse(CYCLE_START)), Date.parse(CYCLE_END), '31 → 30-day month')
  // March 2026 crosses a US DST transition (Mar 8); UTC arithmetic throughout
  // means the clock change cannot move the answer by an hour.
  assert.equal(
    addCalendarMonth(Date.parse('2026-03-01T00:00:00.000Z')),
    Date.parse('2026-04-01T00:00:00.000Z'),
    'a DST month is exactly one calendar month wide in UTC',
  )
})

test('legacyRequestLanes turns one model into the plan lane, and several into scoped ones', () => {
  const single = legacyRequestLanes(LEGACY_SINGLE, 1_000)
  assert.deepEqual(
    single.map((lane) => [lane.id, lane.label, lane.unit, lane.used, lane.limit, lane.scope, lane.layer]),
    [['requests', 'Requests', 'requests', 313, 500, undefined, 'plan']],
  )
  assert.equal(single[0]?.usedPercent, (313 / 500) * 100, 'not clamped, and not rounded')
  assert.equal(single[0]?.resetsAt, 1_000)

  const multi = legacyRequestLanes(LEGACY_MULTI, null)
  assert.deepEqual(
    multi.map((lane) => [lane.id, lane.scope]),
    [
      ['requests:gpt-4', 'Gpt 4'],
      ['requests:gpt-4-32k', 'Gpt 4 32k'],
    ],
    'a bucket with no usable limit (embeddings) is skipped, and each remaining one is scoped',
  )

  assert.deepEqual(legacyRequestLanes({ startOfMonth: '2026-01-01T00:00:00.000Z' }, null), [], 'no model at all')
})

test('a legacy request-based plan reports a requests lane the dollar summary has nothing for', async () => {
  const meter = new CursorMeter({
    databasePath: cursorDatabase(TOKEN),
    now: () => 5_000,
    fetch: answeringByUrl({
      'https://cursor.com/api/usage-summary': { status: 200, body: NO_PERCENT_SUMMARY },
      'https://cursor.com/api/usage': { status: 200, body: LEGACY_SINGLE },
    }),
  })
  const reading = await meter.read()
  assert.ok(reading)
  assert.equal(reading.lanes.length, 1)
  assert.equal(reading.lanes[0]?.id, 'requests')
  assert.equal(reading.lanes[0]?.unit, 'requests')
  assert.equal(reading.lanes[0]?.used, 313)
  assert.equal(reading.lanes[0]?.limit, 500)
  assert.equal(reading.lanes[0]?.layer, 'plan')
  // The summary's own `billingCycleEnd` wins over a computed one (NIT 1).
  assert.equal(reading.lanes[0]?.resetsAt, Date.parse(CYCLE_END))
  assert.equal(reading.credits, null, 'the on-demand figure is a lane here, never a balance')
  assert.deepEqual(reading.billing, { kinds: ['allowance'] })
  assert.equal(reading.reached, null)
})

test('a small summary percent with an aligned counter at its limit puts the requests lane first, and reached comes from it', async () => {
  const meter = new CursorMeter({
    databasePath: cursorDatabase(TOKEN),
    fetch: answeringByUrl({
      'https://cursor.com/api/usage-summary': { status: 200, body: SMALL_PERCENT_SUMMARY },
      'https://cursor.com/api/usage': { status: 200, body: LEGACY_AT_LIMIT },
    }),
  })
  const reading = await meter.read()
  assert.ok(reading)
  assert.equal(reading.lanes.length, 2)
  assert.equal(reading.lanes[0]?.id, 'requests', 'the live requests lane is primary')
  assert.equal(reading.lanes[0]?.usedPercent, 100)
  assert.equal(reading.lanes[1]?.id, 'plan', "the summary's percent rides after it as the comparable scale")
  assert.equal(Math.round(reading.lanes[1]?.usedPercent ?? -1), 6)
  assert.equal(reading.reached, 'requests', 'reached derives from the request lane, never the small plan percent')
})

test('a counter naming a past cycle is skipped, and the summary percent is what is shown', async () => {
  const pastCycleLegacy = {
    'gpt-4': { numRequests: 500, numRequestsTotal: 500, numTokens: 0, maxRequestUsage: 500, maxTokenUsage: null },
    startOfMonth: '2020-01-01T00:00:00.000Z',
  }
  const meter = new CursorMeter({
    databasePath: cursorDatabase(TOKEN),
    fetch: answeringByUrl({
      'https://cursor.com/api/usage-summary': { status: 200, body: SMALL_PERCENT_SUMMARY },
      'https://cursor.com/api/usage': { status: 200, body: pastCycleLegacy },
    }),
  })
  const reading = await meter.read()
  assert.ok(reading)
  assert.equal(reading.lanes.length, 1)
  assert.equal(reading.lanes[0]?.id, 'plan')
  assert.equal(reading.reached, null, 'a spent-but-stale counter never sets reached')
})

test('no billingCycleStart on the summary: a startOfMonth within the last 31 days is still live', async () => {
  const now = Date.parse('2026-09-10T00:00:00.000Z')
  const recentStartOfMonth = '2026-08-20T00:00:00.000Z' // 21 days before `now`
  const noCycleStartSummary = {
    billingCycleEnd: CYCLE_END,
    membershipType: 'pro',
    isUnlimited: false,
    individualUsage: {},
    teamUsage: {},
  }
  const meter = new CursorMeter({
    databasePath: cursorDatabase(TOKEN),
    now: () => now,
    fetch: answeringByUrl({
      'https://cursor.com/api/usage-summary': { status: 200, body: noCycleStartSummary },
      'https://cursor.com/api/usage': {
        status: 200,
        body: {
          'gpt-4': { numRequests: 100, numRequestsTotal: 100, numTokens: 0, maxRequestUsage: 500, maxTokenUsage: null },
          startOfMonth: recentStartOfMonth,
        },
      },
    }),
  })
  const reading = await meter.read()
  assert.ok(reading)
  assert.equal(
    reading.lanes.some((lane) => lane.id === 'requests'),
    true,
    'live within the last 31 days even with no billingCycleStart to align against',
  )
})

test('on-demand spend on a legacy plan is its own overage lane, never folded into credits', async () => {
  const meter = new CursorMeter({
    databasePath: cursorDatabase(TOKEN),
    fetch: answeringByUrl({
      'https://cursor.com/api/usage-summary': {
        status: 200,
        body: withOnDemand({ enabled: true, used: 500, limit: 2000, remaining: 1500 }),
      },
      'https://cursor.com/api/usage': { status: 200, body: LEGACY_SINGLE },
    }),
  })
  const reading = await meter.read()
  assert.ok(reading)
  const overage = reading.lanes.find((lane) => lane.id === 'overage')
  assert.ok(overage)
  assert.equal(overage.unit, 'usd')
  assert.equal(overage.used, 5)
  assert.equal(overage.limit, 20)
  assert.equal(overage.usedPercent, 25)
  assert.equal(overage.layer, 'overage')
  assert.equal(reading.credits, null)
  assert.deepEqual(reading.billing, {
    kinds: ['allowance', 'metered'],
    overage: { enabled: true, spent: 5, currency: 'USD' },
  })
})

test('on-demand off, or a zero limit, adds no overage lane', async () => {
  const off = new CursorMeter({
    databasePath: cursorDatabase(TOKEN),
    fetch: answeringByUrl({
      'https://cursor.com/api/usage-summary': { status: 200, body: withOnDemand({ enabled: false }) },
      'https://cursor.com/api/usage': { status: 200, body: LEGACY_SINGLE },
    }),
  })
  const offReading = await off.read()
  assert.ok(offReading)
  assert.equal(
    offReading.lanes.find((lane) => lane.id === 'overage'),
    undefined,
  )

  const zeroLimit = new CursorMeter({
    databasePath: cursorDatabase(TOKEN),
    fetch: answeringByUrl({
      'https://cursor.com/api/usage-summary': {
        status: 200,
        body: withOnDemand({ enabled: true, used: 0, limit: 0, remaining: 0 }),
      },
      'https://cursor.com/api/usage': { status: 200, body: LEGACY_SINGLE },
    }),
  })
  const zeroReading = await zeroLimit.read()
  assert.ok(zeroReading)
  assert.equal(
    zeroReading.lanes.find((lane) => lane.id === 'overage'),
    undefined,
  )
})

test('a dollar-allowance account is unchanged: still one plan lane, and now its billing kind', async () => {
  const meter = new CursorMeter({
    databasePath: cursorDatabase(TOKEN),
    fetch: answeringByUrl({
      'https://cursor.com/api/usage-summary': {
        status: 200,
        body: {
          billingCycleStart: CYCLE_START,
          billingCycleEnd: CYCLE_END,
          membershipType: 'pro',
          isUnlimited: false,
          individualUsage: {
            plan: { enabled: true, used: 1999, limit: 2000, totalPercentUsed: 5.794 },
            onDemand: { enabled: true, used: 1392, limit: 5000, remaining: 3608 },
          },
          teamUsage: {},
        },
      },
      // Probed regardless (fix 1 asks unconditionally), but failing here is
      // caught silently and falls back to the summary reading (fix 2) — the
      // dollar-allowance account's own reading is unchanged either way.
      'https://cursor.com/api/usage': { status: 500, body: {} },
    }),
  })
  const reading = await meter.read()
  assert.ok(reading)
  assert.equal(reading.lanes.length, 1)
  assert.equal(reading.lanes[0]?.id, 'plan')
  assert.deepEqual(reading.credits, { remaining: 36.08, used: 13.92, unit: 'USD', unlimited: false })
  assert.deepEqual(reading.billing, {
    kinds: ['allowance', 'metered'],
    overage: { enabled: true, spent: 13.92, currency: 'USD' },
  })
})

test('the legacy endpoint failing falls back to the summary reading rather than blanking the card', async () => {
  const meter = new CursorMeter({
    databasePath: cursorDatabase(TOKEN),
    fetch: answeringByUrl({
      'https://cursor.com/api/usage-summary': { status: 200, body: SMALL_PERCENT_SUMMARY },
      'https://cursor.com/api/usage': { status: 500, body: {} },
    }),
  })
  const reading = await meter.read()
  assert.ok(reading, 'a first read still shows the card even though the legacy call threw')
  assert.equal(reading.lanes.length, 1)
  assert.equal(reading.lanes[0]?.id, 'plan')
})

test('the legacy endpoint has nothing for this account, and neither does the summary: silence, not a failure', async () => {
  const meter = new CursorMeter({
    databasePath: cursorDatabase(TOKEN),
    fetch: answeringByUrl({
      'https://cursor.com/api/usage-summary': { status: 200, body: NO_PERCENT_SUMMARY },
      'https://cursor.com/api/usage': { status: 401, body: {} },
    }),
  })
  assert.equal(await meter.read(), null)
})
