import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { runtimeId, type LedgerReport, type RuntimeId } from '@harnessdesk/protocol'

import { periodTotals, shareOf, stackDaily } from './ledger'

const DAY = 86_400_000
const NOON = new Date('2026-08-22T12:00:00').getTime()
const TODAY = new Date('2026-08-22T00:00:00').getTime()

const CODEX = runtimeId('codex')
const CLAUDE = runtimeId('claude')

const report = (
  days: number,
  daily: { day: number; runtime: RuntimeId; cost: number; tokens?: number }[],
): LedgerReport =>
  ({
    days,
    currency: 'USD',
    totalCost: daily.reduce((sum, entry) => sum + entry.cost, 0),
    totalTokens: null,
    provenance: 'listPrice',
    coverage: { priced: 0, unpriced: 0, unmetered: 0, estimated: 0, daysCovered: days, daysRequested: days },
    rows: [],
    daily: daily.map((entry) => ({ ...entry, tokens: entry.tokens ?? 0 })),
    scannedAt: NOON,
  }) as LedgerReport

describe('stackDaily', () => {
  it('gives every day in the window a bucket, including the quiet ones', () => {
    const series = stackDaily(report(5, [{ day: TODAY - 2 * DAY, runtime: CODEX, cost: 4 }]), NOON)
    expect(series.days).toHaveLength(5)
    expect(series.days.map((day) => day.total)).toEqual([0, 0, 4, 0, 0])
    // Oldest first, ending on today.
    expect(series.days[4]?.day).toBe(TODAY)
    expect(series.days[0]?.day).toBe(TODAY - 4 * DAY)
  })

  it('splits a day by agent and keeps the biggest spender first', () => {
    const series = stackDaily(
      report(2, [
        { day: TODAY, runtime: CODEX, cost: 1 },
        { day: TODAY, runtime: CLAUDE, cost: 9 },
        { day: TODAY - DAY, runtime: CODEX, cost: 2 },
      ]),
      NOON,
    )
    expect(series.keys).toEqual([CLAUDE, CODEX])
    expect(series.days[1]?.parts).toEqual([9, 1])
    expect(series.days[1]?.total).toBe(10)
    expect(series.peak).toBe(10)
    expect(series.total).toBe(12)
  })

  it('adds up several entries for one agent on one day', () => {
    const series = stackDaily(
      report(1, [
        { day: TODAY, runtime: CODEX, cost: 2 },
        { day: TODAY, runtime: CODEX, cost: 3 },
      ]),
      NOON,
    )
    expect(series.days[0]?.parts).toEqual([5])
  })

  it('drops a day the window does not reach', () => {
    // A ledger whose rows run older than the window it was asked for.
    const series = stackDaily(report(2, [{ day: TODAY - 30 * DAY, runtime: CODEX, cost: 99 }]), NOON)
    expect(series.days.map((day) => day.total)).toEqual([0, 0])
    expect(series.total).toBe(0)
    // The agent is still a series: it spent something inside the report.
    expect(series.keys).toEqual([CODEX])
  })

  it('answers with nothing for no ledger at all', () => {
    expect(stackDaily(null, NOON)).toEqual({ days: [], keys: [], peak: 0, total: 0 })
  })
})


/**
 * The one day of the year the arithmetic used to be wrong on.
 *
 * The host buckets by *local* midnight (`ledger/scan.ts` uses
 * `setHours(0, 0, 0, 0)`), and local midnights are 23 or 25 hours apart across
 * a daylight-saving transition. A chart that steps back by a fixed 86,400,000
 * ms therefore generates keys an hour off and misses every bucket at or before
 * the changeover — silently, and completely, for the whole of the rest of the
 * window.
 *
 * The zone is pinned rather than assumed: on a UTC build machine this test
 * would pass against the broken arithmetic too, which is the shape of a test
 * that looks like proof and is not.
 */
describe('stackDaily across a daylight-saving transition', () => {
  const ZONE = 'America/New_York'
  const previous = process.env.TZ

  beforeAll(() => {
    process.env.TZ = ZONE
  })
  afterAll(() => {
    if (previous === undefined) delete process.env.TZ
    else process.env.TZ = previous
  })

  /** Local midnight `back` days before `from`, the way the host would write it. */
  const localMidnight = (from: Date, back: number): number => {
    const date = new Date(from)
    date.setHours(0, 0, 0, 0)
    date.setDate(date.getDate() - back)
    return date.getTime()
  }

  it('is stepping the calendar, not the clock', () => {
    // The US changeover is 2026-11-01, so 2026-11-01 is a 25-hour day.
    const now = new Date('2026-11-03T12:00:00').getTime()
    const from = new Date(now)
    expect(from.toString()).toContain('Eastern')

    const wanted = localMidnight(from, 2)
    // The bug, stated as arithmetic: an hour out, and so a different map key.
    const naive = localMidnight(from, 0) - 2 * 86_400_000
    expect(naive - wanted).toBe(3_600_000)
  })

  it('finds every bucket the host wrote on the far side of the changeover', () => {
    const now = new Date('2026-11-03T12:00:00').getTime()
    const from = new Date(now)
    const daily = [0, 1, 2, 3, 4].map((back) => ({
      day: localMidnight(from, back),
      runtime: CODEX,
      cost: 10 + back,
    }))

    const series = stackDaily(report(5, daily), now)
    // Oldest first, so today's 10 is last and the pre-transition days are first.
    expect(series.days.map((day) => day.total)).toEqual([14, 13, 12, 11, 10])
    expect(series.total).toBe(60)
  })

  it('does not lose the spring transition either', () => {
    // 2026-03-08 is a 23-hour day, so the error runs the other way.
    const now = new Date('2026-03-10T12:00:00').getTime()
    const from = new Date(now)
    const daily = [0, 1, 2, 3].map((back) => ({
      day: localMidnight(from, back),
      runtime: CODEX,
      cost: 5,
    }))
    expect(stackDaily(report(4, daily), now).total).toBe(20)
  })
})

describe('periodTotals', () => {
  const thirty = stackDaily(
    report(
      30,
      Array.from({ length: 30 }, (_, index) => ({
        day: TODAY - index * DAY,
        runtime: CODEX,
        // Today spends 30, yesterday 29, and so on back.
        cost: 30 - index,
      })),
    ),
    NOON,
  )

  it('gives today a tile of its own, with no percentage on it', () => {
    const today = periodTotals(thirty, [1])[0]
    expect(today?.label).toBe('Today')
    expect(today?.cost).toBe(30)
    expect(today?.partial).toBe(true)
    // A day still running against a whole one falls every morning and recovers
    // by evening, which says nothing about the spending.
    expect(today?.change).toBeNull()
  })

  it('measures a multi-day window over complete days only', () => {
    const week = periodTotals(thirty, [7])[0]
    expect(week?.partial).toBe(false)
    // The seven complete days are 29 down to 23 — today's 30 is excluded.
    expect(week?.cost).toBe(182)
  })

  it('compares a period against the one of the same length before it', () => {
    const week = periodTotals(thirty, [7])[0]
    // 29…23 against 22…16, both complete.
    expect(week?.change).toBeCloseTo(((182 - 133) / 133) * 100, 5)
  })

  it('offers no comparison when the earlier period is not wholly loaded', () => {
    const twenty = periodTotals(thirty, [20])[0]
    expect(twenty?.cost).toBeGreaterThan(0)
    expect(twenty?.change).toBeNull()
  })

  it('will not offer a period longer than the complete days it holds', () => {
    // Thirty loaded days are twenty-nine complete ones, so a 30-day
    // comparison window cannot be filled.
    expect(periodTotals(thirty, [7, 30, 90]).map((total) => total.days)).toEqual([7])
  })

  it('has no percentage for a rise from nothing', () => {
    const quiet = stackDaily(
      report(6, [
        { day: TODAY - DAY, runtime: CODEX, cost: 5 },
        { day: TODAY - 2 * DAY, runtime: CODEX, cost: 5 },
      ]),
      NOON,
    )
    // Two complete days of spend, and two empty ones before them.
    expect(periodTotals(quiet, [2])[0]?.cost).toBe(10)
    expect(periodTotals(quiet, [2])[0]?.change).toBeNull()
  })

  it('answers with nothing for an empty window', () => {
    expect(periodTotals(stackDaily(null, NOON), [1, 7])).toEqual([])
  })
})

describe('shareOf', () => {
  it('is a percentage of the total', () => {
    expect(shareOf(25, 200)).toBe(12.5)
  })

  it('refuses to divide by a total that is not there', () => {
    expect(shareOf(25, 0)).toBeNull()
    expect(shareOf(25, null)).toBeNull()
    expect(shareOf(null, 200)).toBeNull()
  })
})
