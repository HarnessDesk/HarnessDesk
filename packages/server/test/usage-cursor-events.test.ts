import assert from 'node:assert/strict'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'

import { tempDir } from './scratch.js'

import {
  CursorEventsSource,
  aggregateCursorEvents,
  fetchCursorEvents,
  stepLocalDay,
  type CursorEvent,
} from '../src/usage/cursor-events.js'
import { Ledger } from '../src/ledger/index.js'
import type { RemoteEventsSource } from '../src/ledger/remote.js'
import { LedgerStore, type UsageRow } from '../src/ledger/store.js'

/**
 * Cursor's own per-request usage events, folded into the ledger.
 *
 * Every timestamp and identifier below is invented for this test — never a
 * value read off the real endpoint (rule 13). The shapes match what was
 * confirmed there: `POST get-filtered-usage-events`, paged at 1000, an empty
 * query answering `{}`, a terminal page short of a full one omitting the
 * events array, and one event in several hundred with no `tokenUsage` at all.
 */

const scratch = (): string => tempDir('hd-cursor-events-')

const HOUR = 3_600_000
const DAY = 86_400_000

const jwt = (claims: Record<string, unknown>): string =>
  `x.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.y`

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

const liveToken = (): string => jwt({ sub: 'auth0|acct', exp: Math.floor((Date.now() + HOUR) / 1000) })

/** One event as the endpoint sends it, with sane defaults. */
const event = (
  overrides: Partial<{
    timestamp: string
    model: string
    kind: string
    requestsCosts: number
    tokenUsage: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; totalCents?: number } | null
  }> = {},
): Record<string, unknown> => {
  const usage =
    overrides.tokenUsage === null
      ? undefined
      : {
          inputTokens: 100,
          outputTokens: 50,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          totalCents: 12,
          ...overrides.tokenUsage,
        }
  return {
    timestamp: overrides.timestamp ?? '1735689600000',
    model: overrides.model ?? 'claude-sonnet-4-5',
    kind: overrides.kind ?? 'USAGE_EVENT_KIND_USAGE_BASED',
    requestsCosts: overrides.requestsCosts ?? 1,
    isTokenBasedCall: true,
    isChargeable: true,
    isHeadless: false,
    chargedCents: 10,
    tokenUsage: usage,
  }
}

/** A fetch stub that answers a fixed sequence of bodies, one per call, regardless of the request. */
const sequence = (bodies: readonly (unknown | { status: number })[]): typeof globalThis.fetch => {
  let call = 0
  return (async () => {
    const body = bodies[Math.min(call, bodies.length - 1)]
    call += 1
    const status = typeof body === 'object' && body !== null && 'status' in body ? (body as { status: number }).status : 200
    const payload = typeof body === 'object' && body !== null && 'status' in body ? {} : body
    return new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } })
  }) as unknown as typeof globalThis.fetch
}

test('an empty query answers {} and is read as no events at all', async () => {
  const events = await fetchCursorEvents({ cookie: 'c', since: 0, until: DAY, fetch: sequence([{}]) })
  assert.deepEqual(events, [])
})

test('a terminal page short of a full page ends the fetch, events array or not', async () => {
  const page1 = { totalUsageEventsCount: 1, usageEventsDisplay: [event()] }
  const events = await fetchCursorEvents({ cookie: 'c', since: 0, until: DAY, pageSize: 1000, fetch: sequence([page1]) })
  assert.equal(events?.length, 1)

  // A terminal page can omit the array entirely while keeping the count.
  const onlyCount = { totalUsageEventsCount: 1 }
  const withOmittedTail = await fetchCursorEvents({
    cookie: 'c',
    since: 0,
    until: DAY,
    pageSize: 1,
    fetch: sequence([{ totalUsageEventsCount: 1, usageEventsDisplay: [event()] }, onlyCount]),
  })
  assert.equal(withOmittedTail?.length, 1)
})

test('paging removes an exact duplicate row at the page boundary', async () => {
  const shared = event({ timestamp: '1735689600000' })
  const first = event({ timestamp: '1735689700000' })
  const second = event({ timestamp: '1735689800000' })
  // Two full pages of size 2, but the account only has 3 distinct events: the
  // boundary row is repeated because the account's own event list moved
  // between the two page reads.
  const page1 = { totalUsageEventsCount: 3, usageEventsDisplay: [first, shared] }
  const page2 = { totalUsageEventsCount: 3, usageEventsDisplay: [shared, second] }
  const page3 = { totalUsageEventsCount: 3, usageEventsDisplay: [] }
  const events = await fetchCursorEvents({
    cookie: 'c',
    since: 0,
    until: DAY,
    pageSize: 2,
    fetch: sequence([page1, page2, page3]),
  })
  assert.equal(events?.length, 3, 'the repeated boundary row counts once')
})

test('fails closed on a short read: fewer rows arrive than the account says exist', async () => {
  const page1 = { totalUsageEventsCount: 5, usageEventsDisplay: [event()] }
  const events = await fetchCursorEvents({ cookie: 'c', since: 0, until: DAY, pageSize: 10, fetch: sequence([page1]) })
  assert.equal(events, null)
})

test('fails closed at the page cap, never publishing a partial window as complete', async () => {
  const fullPage = { totalUsageEventsCount: 999_999, usageEventsDisplay: [event(), event()] }
  const events = await fetchCursorEvents({
    cookie: 'c',
    since: 0,
    until: DAY,
    pageSize: 2,
    maxPages: 3,
    fetch: sequence([fullPage]),
  })
  assert.equal(events, null, 'three full pages never proved completion, so nothing is published')
})

test('fails closed on an envelope it cannot make sense of', async () => {
  assert.equal(
    await fetchCursorEvents({ cookie: 'c', since: 0, until: DAY, fetch: sequence([{ usageEventsDisplay: 'not-an-array' }]) }),
    null,
  )
  assert.equal(
    await fetchCursorEvents({ cookie: 'c', since: 0, until: DAY, fetch: sequence([{ totalUsageEventsCount: -1 }]) }),
    null,
  )
  assert.equal(
    await fetchCursorEvents({ cookie: 'c', since: 0, until: DAY, fetch: sequence([{ status: 500 }]) }),
    null,
  )
  assert.equal(
    await fetchCursorEvents({ cookie: 'c', since: 0, until: DAY, fetch: sequence([{ status: 401 }]) }),
    null,
    'signed out mid-read is also a fail-closed silence, not a thrown error',
  )
})

test('an aborted, never-charged event is skipped entirely — no tokens, no request, no cost', async () => {
  const events = await fetchCursorEvents({
    cookie: 'c',
    since: 0,
    until: DAY,
    fetch: sequence([
      {
        totalUsageEventsCount: 1,
        usageEventsDisplay: [{ timestamp: '1735689600000', model: 'gpt-5', kind: 'USAGE_EVENT_KIND_ABORTED_NOT_CHARGED', chargedCents: 0, isChargeable: false, isHeadless: false, isTokenBasedCall: false }],
      },
    ]),
  })
  assert.deepEqual(events, [])
})

test('per-day, per-model aggregation buckets by the local calendar, including across a DST day', () => {
  // Two events well inside the same daylight hours land on one row however
  // the runner's zone reads them.
  const before: CursorEvent = { at: Date.parse('2026-11-01T19:00:00Z'), model: 'gpt-5', input: 10, output: 5, cacheRead: 0, cacheWrite: 0, requests: 1, cents: 5 }
  const after: CursorEvent = { at: Date.parse('2026-11-01T22:00:00Z'), model: 'gpt-5', input: 20, output: 8, cacheRead: 0, cacheWrite: 0, requests: 1, cents: 7 }
  const rows = aggregateCursorEvents([before, after], 'cursor', 'cursor-events:abc')
  assert.equal(rows.length, 1, 'both fall on the same local day')
  assert.equal(rows[0]?.input, 30)
  assert.equal(rows[0]?.requests, 2)
  assert.ok(Math.abs((rows[0]?.vendorCost ?? 0) - 0.12) < 1e-9)

  // Calendar stepping, never a fixed 86,400,000ms step: the US fell back on
  // this date, so the local day this bucket falls on can be a genuine 25
  // hours, and `stepLocalDay` must follow the calendar rather than the clock.
  const nextDay = stepLocalDay(rows[0]!.day, 1)
  const span = nextDay - rows[0]!.day
  assert.ok(span === 23 * HOUR || span === 24 * HOUR || span === 25 * HOUR, `a local day is 23, 24 or 25 hours, got ${span}`)
})

test('unpriced events stay unpriced, never $0, and never share a row with priced ones', () => {
  const priced: CursorEvent = { at: 1_000, model: 'gpt-5', input: 10, output: 5, cacheRead: 0, cacheWrite: 0, requests: 1, cents: 20 }
  const unpriced: CursorEvent = { at: 1_000, model: 'gpt-5', input: 10, output: 5, cacheRead: 0, cacheWrite: 0, requests: 1, cents: null }
  const rows = aggregateCursorEvents([priced, unpriced], 'cursor', 'cursor-events:abc')
  assert.equal(rows.length, 2, 'a priced request and an unpriced one never share a row')
  const withCost = rows.find((row) => row.vendorCost !== null)
  const withoutCost = rows.find((row) => row.vendorCost === null)
  assert.equal(withCost?.vendorCost, 0.2)
  assert.equal(withoutCost?.requests, 1)
})

test('max-mode requests can cost several units, and the row sums them as reported', () => {
  const cheap: CursorEvent = { at: 1_000, model: 'gpt-5', input: 1, output: 1, cacheRead: 0, cacheWrite: 0, requests: 0.1, cents: 1 }
  const maxMode: CursorEvent = { at: 1_000, model: 'gpt-5', input: 1, output: 1, cacheRead: 0, cacheWrite: 0, requests: 12, cents: 900 }
  const rows = aggregateCursorEvents([cheap, maxMode], 'cursor', 'cursor-events:abc')
  assert.equal(rows.length, 1)
  assert.equal(rows[0]?.requests, 12.1, 'a max-mode call is many requests, not one')
})

test('signed out resolves no file, and the source is never asked to sync', async () => {
  const source = new CursorEventsSource('cursor', { databasePath: cursorDatabase(null) })
  assert.equal(await source.resolveFile(), null)
  assert.equal(await source.sync({ from: 0, to: DAY }), null)

  const missing = new CursorEventsSource('cursor', { databasePath: join(scratch(), 'nothing.vscdb') })
  assert.equal(await missing.resolveFile(), null)
})

test('a live session resolves a stable, anonymous file key and fetches its window', async () => {
  const source = new CursorEventsSource('cursor', {
    databasePath: cursorDatabase(liveToken()),
    fetch: sequence([{ totalUsageEventsCount: 1, usageEventsDisplay: [event()] }]),
  })
  const file = await source.resolveFile()
  assert.ok(file?.startsWith('cursor-events:'))
  assert.equal(file, await source.resolveFile(), 'the same account resolves the same key every time')
  const result = await source.sync({ from: 0, to: DAY })
  assert.equal(result?.rows.length, 1)
  assert.equal(result?.rows[0]?.file, file)
  assert.equal(result?.rows[0]?.runtime, 'cursor')
})

/** A fake remote source the Ledger tests below drive directly. */
class FakeRemote implements RemoteEventsSource {
  readonly runtime = 'cursor'
  calls = 0
  file: string | null
  rows: readonly UsageRow[]
  constructor(file: string | null, rows: readonly UsageRow[]) {
    this.file = file
    this.rows = rows
  }
  async resolveFile(): Promise<string | null> {
    return this.file
  }
  async sync(): Promise<{ rows: readonly UsageRow[] } | null> {
    this.calls += 1
    return this.file === null ? null : { rows: this.rows }
  }
}

const row = (day: number, requests: number, vendorCost: number | null): UsageRow => ({
  file: 'cursor-events:abc',
  day,
  runtime: 'cursor',
  model: 'gpt-5',
  project: '',
  input: 100,
  output: 50,
  cacheRead: 0,
  cacheWrite: 0,
  reasoning: 0,
  requests,
  vendorCost,
})

test('a re-sync replaces the days it covers, and a day the remote no longer reports disappears', async () => {
  let now = Date.parse('2026-09-20T12:00:00Z')
  const stateDir = scratch()
  const day1 = new Date(now).setHours(0, 0, 0, 0)
  const remote = new FakeRemote('cursor-events:abc', [row(day1, 1, 0.1)])
  const ledger = new Ledger({ stateDir, corpora: [], remoteSources: [remote], now: () => now })
  await ledger.scan()

  let report = ledger.query({ days: 30, groupBy: 'model' })
  assert.equal(report.totals?.requests, 1)

  // A later sync reports a different set of rows for the same window — the
  // remote account's own history changed (an event was deleted upstream).
  remote.rows = [row(day1, 3, 0.3)]
  now += 2 * HOUR
  await ledger.scan()
  report = ledger.query({ days: 30, groupBy: 'model' })
  assert.equal(report.totals?.requests, 3, 'replaced, not added to the earlier 1')
  ledger.close()
})

test('a remote source is asked for at most once an hour', async () => {
  let now = Date.parse('2026-09-20T12:00:00Z')
  const stateDir = scratch()
  const day1 = new Date(now).setHours(0, 0, 0, 0)
  const remote = new FakeRemote('cursor-events:abc', [row(day1, 1, 0.1)])
  const ledger = new Ledger({ stateDir, corpora: [], remoteSources: [remote], now: () => now })
  await ledger.scan()
  assert.equal(remote.calls, 1)

  now += 10 * 60_000 // ten minutes later
  await ledger.scan({ full: true })
  assert.equal(remote.calls, 1, 'too soon; the last sync stands')

  now += HOUR
  await ledger.scan({ full: true })
  assert.equal(remote.calls, 2, 'an hour on, it is asked again')
  ledger.close()
})

test('signed out is a no-op: nothing is synced, and rows already stored stand', async () => {
  const stateDir = scratch()
  const now = Date.parse('2026-09-20T12:00:00Z')
  const day1 = new Date(now).setHours(0, 0, 0, 0)
  const store = new LedgerStore(join(stateDir, 'usage.sqlite'))
  store.commit({ path: 'cursor-events:abc', size: 0, mtime: 0, offset: 0, tail: [] }, [row(day1, 1, 0.1)], now, false)
  store.close()

  const remote = new FakeRemote(null, [])
  const ledger = new Ledger({ stateDir, corpora: [], remoteSources: [remote], now: () => now })
  await ledger.scan()
  assert.equal(remote.calls, 0, 'signed out: never even asked to sync')
  const report = ledger.query({ days: 30, groupBy: 'model' })
  assert.equal(report.totals?.requests, 1, 'and the rows from before stand untouched')
  ledger.close()
})
