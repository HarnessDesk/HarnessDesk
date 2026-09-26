import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { runtimeId, type LedgerReport, type RuntimeId } from '@harnessdesk/protocol'

import {
  addDays,
  buildDayRange,
  buildYearGrid,
  earliestScannedDay,
  localMidnight,
  quartileLevels,
  streaksFor,
  busiestWeekday,
} from './heat'

const DAY = 86_400_000
const CODEX = runtimeId('codex')

const report = (daily: { day: number; runtime: RuntimeId; cost: number; tokens: number }[]): LedgerReport =>
  ({
    days: daily.length,
    currency: 'USD',
    totalCost: daily.reduce((sum, entry) => sum + entry.cost, 0),
    totalTokens: daily.reduce((sum, entry) => sum + entry.tokens, 0),
    provenance: 'listPrice',
    coverage: { priced: 0, unpriced: 0, unmetered: 0, estimated: 0, daysCovered: daily.length, daysRequested: daily.length },
    rows: [],
    daily,
    scannedAt: Date.now(),
  }) as LedgerReport

describe('addDays across a daylight-saving change', () => {
  const ZONE = 'Europe/London'
  const previous = process.env.TZ

  beforeAll(() => {
    process.env.TZ = ZONE
  })
  afterAll(() => {
    if (previous === undefined) delete process.env.TZ
    else process.env.TZ = previous
  })

  it('steps the calendar across the March change (clocks forward)', () => {
    // The UK's 2026 spring-forward is 2026-03-29: that local day is 23 hours.
    const before = new Date('2026-03-28T00:00:00').getTime()
    const wanted = addDays(before, 2)
    expect(new Date(wanted).toString()).toContain('2026')
    expect(new Date(wanted).getDate()).toBe(30)
    expect(new Date(wanted).getHours()).toBe(0)
    // A fixed 86,400,000ms step is an hour short across the change.
    const naive = before + 2 * DAY
    expect(naive).not.toBe(wanted)
  })

  it('steps the calendar across the October change (clocks back)', () => {
    // The UK's 2026 fall-back is 2026-10-25: that local day is 25 hours.
    const before = new Date('2026-10-24T00:00:00').getTime()
    const wanted = addDays(before, 2)
    expect(new Date(wanted).getDate()).toBe(26)
    expect(new Date(wanted).getHours()).toBe(0)
    const naive = before + 2 * DAY
    expect(naive).not.toBe(wanted)
  })
})

describe('buildDayRange — the three kinds of nothing', () => {
  const TODAY = new Date('2026-09-20T00:00:00').getTime()

  it('marks a day before any ledger row as not scanned, not zero', () => {
    const ledger = report([{ day: TODAY, runtime: CODEX, cost: 4, tokens: 400 }])
    const cells = buildDayRange(ledger, addDays(TODAY, -3), TODAY, TODAY)
    // The earliest row is today, so every earlier day is unscanned.
    expect(cells[0]?.scanned).toBe(false)
    expect(cells[0]?.tokens).toBe(0)
    expect(cells[cells.length - 1]?.scanned).toBe(true)
  })

  it('marks a scanned day with nothing spent as a real zero', () => {
    const ledger = report([
      { day: addDays(TODAY, -2), runtime: CODEX, cost: 4, tokens: 400 },
      { day: TODAY, runtime: CODEX, cost: 4, tokens: 400 },
    ])
    const cells = buildDayRange(ledger, addDays(TODAY, -2), TODAY, TODAY)
    // The middle day (-1) is inside the scanned range (>= earliest row) but has no cost.
    const middle = cells[1]
    expect(middle?.day).toBe(addDays(TODAY, -1))
    expect(middle?.scanned).toBe(true)
    expect(middle?.tokens).toBe(0)
  })

  it('has no scanned days at all when the ledger holds no rows', () => {
    expect(earliestScannedDay(report([]))).toBeNull()
    const cells = buildDayRange(report([]), addDays(TODAY, -3), TODAY, TODAY)
    expect(cells.every((cell) => !cell.scanned)).toBe(true)
  })
})

describe('quartileLevels', () => {
  it('keeps an outlier from washing out the rest of the distribution', () => {
    const values = [1, 1, 1, 1, 1, 1, 50]
    const level = quartileLevels(values)
    // The six ordinary days still read above empty...
    expect(level(1)).toBeGreaterThan(0)
    // ...and the outlier is the top of the scale, not tied with them.
    expect(level(50)).toBe(4)
    expect(level(50)).toBeGreaterThan(level(1))
  })

  it('reads zero as level 0 and never assigns level 0 to a positive value', () => {
    const level = quartileLevels([2, 4, 6, 8])
    expect(level(0)).toBe(0)
    expect(level(2)).toBeGreaterThan(0)
  })

  it('handles an empty distribution without throwing', () => {
    const level = quartileLevels([])
    expect(level(5)).toBe(0)
  })

  it('reads every active value the same as the top of the scale, not the bottom (#990 item 12)', () => {
    // A single busy day...
    expect(quartileLevels([10])(10)).toBe(4)
    // ...and a run that never varies, both read as the most active thing in
    // view rather than tied for the faintest step.
    const level = quartileLevels([5, 5, 5, 5])
    expect(level(5)).toBe(4)
    expect(level(0)).toBe(0)
  })
})

describe('streaksFor', () => {
  const TODAY = new Date('2026-09-20T00:00:00').getTime()
  const cell = (day: number, tokens: number) =>
    ({ day, tokens, cost: tokens > 0 ? 1 : 0, scanned: true, parts: [], future: false })

  it('finds the current run ending at the last cell, and the best run anywhere', () => {
    const cells = [
      cell(addDays(TODAY, -6), 10),
      cell(addDays(TODAY, -5), 10),
      cell(addDays(TODAY, -4), 0),
      cell(addDays(TODAY, -3), 10),
      cell(addDays(TODAY, -2), 10),
      cell(addDays(TODAY, -1), 10),
      cell(TODAY, 10),
    ]
    const { current, best } = streaksFor(cells, 'tokens')
    expect(current).toBe(4)
    expect(best).toBe(4)
  })

  it('counts the run through yesterday when today is empty, rather than reading zero (#990 item 11)', () => {
    const cells = [cell(addDays(TODAY, -1), 10), cell(TODAY, 0)]
    expect(streaksFor(cells, 'tokens').current).toBe(1)
  })

  it('still reads zero when yesterday was empty too', () => {
    const cells = [cell(addDays(TODAY, -2), 10), cell(addDays(TODAY, -1), 0), cell(TODAY, 0)]
    expect(streaksFor(cells, 'tokens').current).toBe(0)
  })
})

describe('busiestWeekday', () => {
  it('names the weekday with the most, in view', () => {
    // 2026-09-15 is a Tuesday.
    const tuesday = new Date('2026-09-15T00:00:00').getTime()
    const cells = [
      { day: tuesday, tokens: 100, cost: 1, scanned: true, parts: [], future: false },
      { day: addDays(tuesday, 1), tokens: 5, cost: 1, scanned: true, parts: [], future: false },
    ]
    expect(busiestWeekday(cells, 'tokens')).toBe(1) // 0 = Monday, so Tuesday is 1
  })

  it('is null when nothing was spent', () => {
    expect(busiestWeekday([], 'tokens')).toBeNull()
  })
})

describe('buildYearGrid across DST-at-midnight zones (#990 item 5)', () => {
  const previous = process.env.TZ
  afterAll(() => {
    if (previous === undefined) delete process.env.TZ
    else process.env.TZ = previous
  })

  // Each of these zones springs its clocks forward *at* local midnight on
  // some day of the year, so local 00:00 does not exist that day — the
  // exact case `addDays`'s trailing `setHours` exists for.
  const zones = ['America/Havana', 'America/Santiago', 'Asia/Beirut', 'Africa/Cairo'] as const

  for (const zone of zones) {
    it(`gives 371 cells, every one at local midnight, Monday first (${zone})`, () => {
      process.env.TZ = zone
      const now = new Date('2026-09-25T12:00:00').getTime()
      const grid = buildYearGrid(report([]), now)
      expect(grid.weeks).toHaveLength(53)
      for (const week of grid.weeks) expect(week, `${zone}: a short week`).toHaveLength(7)
      for (const week of grid.weeks) {
        const monday = week[0]
        if (monday) expect(new Date(monday.day).getDay(), zone).toBe(1)
      }
      // "Local midnight" on the one day of the year these zones skip it
      // outright is whatever `localMidnight` itself normalises that instant
      // to — not literally hour zero, which cannot exist that day. What
      // matters is that every stepped cell agrees with that same
      // normalisation, so it still lines up with the host's own day keys
      // (built the identical way) instead of drifting a step off them.
      for (const week of grid.weeks) {
        for (const cell of week) {
          if (!cell) continue
          expect(localMidnight(cell.day), `${zone}: ${new Date(cell.day).toString()}`).toBe(cell.day)
        }
      }
    })
  }

  it('holds through a leap year (2024)', () => {
    process.env.TZ = 'America/Havana'
    const now = new Date('2024-09-25T12:00:00').getTime()
    const grid = buildYearGrid(report([]), now)
    expect(grid.weeks).toHaveLength(53)
    for (const week of grid.weeks) expect(week).toHaveLength(7)
  })

  it('holds through a leap year (2028)', () => {
    process.env.TZ = 'America/Havana'
    const now = new Date('2028-09-24T12:00:00').getTime()
    const grid = buildYearGrid(report([]), now)
    expect(grid.weeks).toHaveLength(53)
    for (const week of grid.weeks) expect(week).toHaveLength(7)
  })
})

describe('buildYearGrid', () => {
  it('is 53 weeks of 7 days, Monday first', () => {
    const now = new Date('2026-09-20T12:00:00').getTime() // a Sunday
    const grid = buildYearGrid(report([]), now)
    expect(grid.weeks).toHaveLength(53)
    for (const week of grid.weeks) expect(week).toHaveLength(7)
    // Every present cell in row 0 is a Monday.
    for (const week of grid.weeks) {
      const monday = week[0]
      if (monday) expect(new Date(monday.day).getDay()).toBe(1)
    }
  })

  it('never renders a day after now', () => {
    const now = new Date('2026-09-16T12:00:00').getTime() // a Wednesday
    const grid = buildYearGrid(report([]), now)
    const lastWeek = grid.weeks[grid.weeks.length - 1] as (typeof grid.weeks)[number]
    // Thursday .. Sunday of the current week are in the future.
    expect(lastWeek[3]).toBeNull()
    expect(lastWeek[6]).toBeNull()
    expect(lastWeek[2]).not.toBeNull()
  })
})
