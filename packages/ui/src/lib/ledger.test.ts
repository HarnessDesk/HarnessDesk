import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { runtimeId, type LedgerReport, type RuntimeId } from '@harnessdesk/protocol'

import {
  alignGhost,
  axisTicks,
  foldOther,
  niceCeiling,
  periodTotals,
  previousByRuntime,
  previousPeriod,
  shareOf,
  stackDaily,
} from './ledger'

const DAY = 86_400_000
const NOON = new Date('2026-08-22T12:00:00').getTime()
const TODAY = new Date('2026-08-22T00:00:00').getTime()

const CODEX = runtimeId('codex')
const CLAUDE = runtimeId('claude')

const report = (
  days: number,
  daily: { day: number; runtime: RuntimeId; cost: number; tokens?: number }[],
  earliestDay?: number | null,
): LedgerReport =>
  ({
    days,
    currency: 'USD',
    totalCost: daily.reduce((sum, entry) => sum + entry.cost, 0),
    totalTokens: null,
    provenance: 'listPrice',
    coverage: {
      priced: 0,
      unpriced: 0,
      unmetered: 0,
      estimated: 0,
      daysCovered: days,
      daysRequested: days,
      ...(earliestDay !== undefined ? { earliestDay } : {}),
    },
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

describe('stackDaily marking "no record yet"', () => {
  it('marks every day before coverage.earliestDay as unknown, never as a priced zero', () => {
    const earliest = TODAY - 2 * DAY
    const series = stackDaily(
      report(5, [{ day: TODAY, runtime: CODEX, cost: 4 }], earliest),
      NOON,
    )
    expect(series.days.map((day) => day.unknown)).toEqual([true, true, false, false, false])
  })

  it('treats a ledger with no rows anywhere as unknown throughout', () => {
    const series = stackDaily(report(3, [], null), NOON)
    expect(series.days.map((day) => day.unknown)).toEqual([true, true, true])
  })

  it('is never unknown once coverage.earliestDay is absent, for an old report', () => {
    // An old report shape predates the field entirely — validated as absent,
    // not null, and treated the same honest way a ledger with real history
    // going all the way back would be.
    const series = stackDaily(report(2, [{ day: TODAY, runtime: CODEX, cost: 1 }]), NOON)
    expect(series.days.map((day) => day.unknown)).toEqual([false, false])
  })

  it('never hatches a day that actually carries spend', () => {
    // A day with a bucket is never "no record yet", whatever earliestDay
    // says — the ledger's own rows are the strongest evidence there is.
    const earliest = TODAY
    const series = stackDaily(
      report(2, [{ day: TODAY - DAY, runtime: CODEX, cost: 1 }], earliest),
      NOON,
    )
    expect(series.days.map((day) => day.unknown)).toEqual([false, false])
  })
})

describe('previousPeriod', () => {
  const daily = (start: number, count: number, costOf: (index: number) => number) =>
    Array.from({ length: count }, (_, index) => ({
      day: TODAY - (count - 1 - index) * DAY - start,
      runtime: CODEX,
      cost: costOf(index),
    }))

  it('sums the older half of a doubled window', () => {
    // 14 days: the newest 7 are "current" (10 each), the oldest 7 are
    // "previous" (5 each) — previousPeriod is handed only the older half's
    // series, the same shape the current-period fetch already is.
    const wide = stackDaily(report(14, daily(0, 14, (index) => (index < 7 ? 5 : 10))), NOON)
    const previous = previousPeriod(wide, 7, 70)
    expect(previous.total).toBe(35)
    expect(previous.complete).toBe(true)
    expect(previous.change).toBeCloseTo(((70 - 35) / 35) * 100, 5)
  })

  it('offers no change when the older half is not wholly loaded', () => {
    const wide = stackDaily(report(10, daily(0, 10, () => 5)), NOON)
    const previous = previousPeriod(wide, 7, 35)
    expect(previous.complete).toBe(false)
    expect(previous.change).toBeNull()
  })

  it('offers no change when the older half was zero', () => {
    const wide = stackDaily(report(14, daily(0, 14, (index) => (index < 7 ? 0 : 10))), NOON)
    const previous = previousPeriod(wide, 7, 70)
    expect(previous.total).toBe(0)
    expect(previous.change).toBeNull()
  })

  it('is not complete when the older half starts before coverage.earliestDay', () => {
    // Only the seven most recent days are covered — the older half wide()
    // asks for has no rows at all, and every one of its days is "no record
    // yet" rather than an honest, comparable zero.
    const wide = stackDaily(
      report(14, daily(0, 7, () => 10), TODAY - 6 * DAY),
      NOON,
    )
    const previous = previousPeriod(wide, 7, 70)
    expect(previous.daily.every((day) => day.unknown)).toBe(true)
    expect(previous.complete).toBe(false)
    // No header delta for a period the chart itself calls "no record yet".
    expect(previous.change).toBeNull()
  })
})

describe('previousPeriod across a daylight-saving transition', () => {
  const ZONE = 'America/New_York'
  const previousTz = process.env.TZ

  beforeAll(() => {
    process.env.TZ = ZONE
  })
  afterAll(() => {
    if (previousTz === undefined) delete process.env.TZ
    else process.env.TZ = previousTz
  })

  it('still divides the window into two equal, calendar-correct halves', () => {
    const now = new Date('2026-11-05T12:00:00').getTime()
    const localMidnight = (back: number): number => {
      const date = new Date(now)
      date.setHours(0, 0, 0, 0)
      date.setDate(date.getDate() - back)
      return date.getTime()
    }
    // Four days, and the changeover (2026-11-01) falls inside the older half.
    const daily = [0, 1, 2, 3].map((back) => ({
      day: localMidnight(back),
      runtime: CODEX,
      cost: back < 2 ? 10 : 3,
    }))
    const wide = stackDaily(report(4, daily), now)
    // stackDaily itself is what has to survive the transition (see the
    // describe block above) — this only checks the split does not lose a
    // day doing the arithmetic a second time over the same series.
    const previous = previousPeriod(wide, 2, 20)
    expect(previous.daily).toHaveLength(2)
    expect(previous.total).toBe(6)
    expect(previous.complete).toBe(true)
  })
})

describe('previousByRuntime', () => {
  it('keys the older half by the same series order as the current one', () => {
    const daily14 = [
      ...Array.from({ length: 7 }, (_, index) => ({
        day: TODAY - (13 - index) * DAY,
        runtime: CLAUDE,
        cost: 2,
      })),
      ...Array.from({ length: 7 }, (_, index) => ({
        day: TODAY - (6 - index) * DAY,
        runtime: CODEX,
        cost: 9,
      })),
    ]
    const wide = stackDaily(report(14, daily14), NOON)
    const previous = previousByRuntime(wide, 7)
    expect(previous.complete).toBe(true)
    expect(previous.totals.get(CLAUDE)).toBe(14)
    expect(previous.totals.get(CODEX)).toBe(0)
  })

  it('is not complete when the older half starts before coverage.earliestDay', () => {
    // Same shape as the previousPeriod case above: a young account whose
    // covered history does not reach into the older half at all. The chip
    // this feeds must not read a real total off "no record yet" days.
    const daily14 = Array.from({ length: 7 }, (_, index) => ({
      day: TODAY - (6 - index) * DAY,
      runtime: CODEX,
      cost: 9,
    }))
    const wide = stackDaily(report(14, daily14, TODAY - 6 * DAY), NOON)
    const previous = previousByRuntime(wide, 7)
    expect(previous.complete).toBe(false)
  })
})

describe('alignGhost', () => {
  it('lines up "today" with the previous period\'s own last day', () => {
    const previousDays = [1, 2, 3, 4, 5].map((cost, index) => ({
      day: TODAY - (4 - index) * DAY,
      total: cost,
      tokens: 0,
      parts: [cost],
      unknown: false,
    }))
    expect(alignGhost(5, previousDays)).toEqual([1, 2, 3, 4, 5])
  })

  it('leaves a gap rather than a plunge when the previous period runs short', () => {
    const previousDays = [1, 2].map((cost, index) => ({
      day: TODAY - (1 - index) * DAY,
      total: cost,
      tokens: 0,
      parts: [cost],
      unknown: false,
    }))
    // Five current days, only two previous ones: the two most recent align,
    // the earlier three have nothing to compare against.
    expect(alignGhost(5, previousDays)).toEqual([null, null, null, 1, 2])
  })

  it('draws a gap, not a real value, for a previous day before coverage', () => {
    // A day the ledger calls "no record yet" is not an honest zero — the
    // ghost line has to break there the same way the value line does.
    const previousDays = [1, 2, 3, 4, 5].map((cost, index) => ({
      day: TODAY - (4 - index) * DAY,
      total: cost,
      tokens: 0,
      parts: [cost],
      unknown: index < 2,
    }))
    expect(alignGhost(5, previousDays)).toEqual([null, null, 3, 4, 5])
  })
})

describe('niceCeiling and axisTicks', () => {
  it('rounds up to 1, 2, 5 or 10 times a power of ten', () => {
    expect(niceCeiling(0)).toBe(0)
    expect(niceCeiling(63)).toBe(100)
    expect(niceCeiling(42)).toBe(50)
    expect(niceCeiling(21)).toBe(50)
    expect(niceCeiling(120)).toBe(200)
  })

  it('gives an axis 0, a midpoint and a round ceiling', () => {
    expect(axisTicks(63)).toEqual([0, 50, 100])
  })

  it('never lets an exactly round peak be the axis top', () => {
    // A bar allowed to touch the frame reads as clipped — every rung of the
    // ladder needs its own headroom, not just the one at $1/$10/$100.
    expect(niceCeiling(1)).toBe(2)
    expect(niceCeiling(100)).toBe(200)
    expect(niceCeiling(200)).toBe(500)
    expect(niceCeiling(500)).toBe(1000)
  })

  it('floors a sub-cent peak at a sensible ceiling instead of $0.01 / $0.00', () => {
    expect(niceCeiling(0.004)).toBe(0.02)
    expect(axisTicks(0.004)).toEqual([0, 0.01, 0.02])
  })
})

describe('foldOther', () => {
  const row = (key: string, cost: number | null, hasUnpriced = false, tokens: number | null = 10) => ({
    key,
    label: key,
    runtime: null,
    tokens,
    cost,
    hasUnpriced,
  })

  it('leaves a short list alone', () => {
    const rows = [row('a', 1), row('b', 2)]
    expect(foldOther(rows, 6)).toEqual({ shown: rows, other: null })
  })

  it('folds the tail into one row, summing its cost', () => {
    const rows = [row('a', 5), row('b', 4), row('c', 3), row('d', 1), row('e', 1)]
    const { shown, other } = foldOther(rows, 3)
    expect(shown).toEqual(rows.slice(0, 3))
    expect(other?.label).toBe('Other · 2')
    expect(other?.cost).toBe(2)
  })

  it('keeps a folded row unpriced rather than $0 when nothing in it has a price', () => {
    const rows = [row('a', 5), row('b', 4), row('c', 3), row('d', null), row('e', null)]
    const { other } = foldOther(rows, 3)
    expect(other?.cost).toBeNull()
  })

  it('sums only the folded rows that do have a price, alongside the unpriced ones', () => {
    const rows = [row('a', 5), row('b', 4), row('c', 3), row('d', 2), row('e', null, true)]
    const { other } = foldOther(rows, 3)
    expect(other?.cost).toBe(2)
    expect(other?.hasUnpriced).toBe(true)
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
