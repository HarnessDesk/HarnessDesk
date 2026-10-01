import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { balanceSeries } from './balance-series'

describe('balanceSeries', () => {
  it('uses the last reading of each day and carries it forward', () => {
    const now = new Date(2026, 8, 26, 12).getTime()
    const history = {
      unit: 'USD',
      points: [
        { at: new Date(2026, 8, 24, 8).getTime(), remaining: 20 },
        { at: new Date(2026, 8, 24, 17).getTime(), remaining: 18 },
        { at: new Date(2026, 8, 26, 9).getTime(), remaining: 15 },
      ],
    }

    expect(balanceSeries(history, now, 4)).toEqual([
      { day: new Date(2026, 8, 23).getTime(), remaining: 0, unknown: true },
      { day: new Date(2026, 8, 24).getTime(), remaining: 18, unknown: false },
      { day: new Date(2026, 8, 25).getTime(), remaining: 18, unknown: false },
      { day: new Date(2026, 8, 26).getTime(), remaining: 15, unknown: false },
    ])
  })

  it('keeps days before the first reading unknown', () => {
    const now = new Date(2026, 8, 26, 12).getTime()
    const series = balanceSeries(
      { unit: 'tokens', points: [{ at: new Date(2026, 8, 25, 3).getTime(), remaining: 7 }] },
      now,
      3,
    )
    expect(series.map(({ unknown }) => unknown)).toEqual([true, false, false])
    expect(series.map(({ remaining }) => remaining)).toEqual([0, 7, 7])
  })

  it('uses local calendar midnights across daylight saving changes', () => {
    const now = new Date(2026, 2, 10, 12).getTime()
    const series = balanceSeries(
      {
        unit: 'USD',
        points: [
          { at: new Date(2026, 2, 8, 23).getTime(), remaining: 9 },
          { at: new Date(2026, 2, 9, 0).getTime(), remaining: 8 },
        ],
      },
      now,
      4,
    )

    expect(series.map(({ day }) => day)).toEqual([
      new Date(2026, 2, 7).getTime(),
      new Date(2026, 2, 8).getTime(),
      new Date(2026, 2, 9).getTime(),
      new Date(2026, 2, 10).getTime(),
    ])
    expect(series.map(({ remaining, unknown }) => [remaining, unknown])).toEqual([
      [0, true],
      [9, false],
      [8, false],
      [8, false],
    ])
  })
})

const previousTimezone = process.env.TZ
beforeAll(() => {
  process.env.TZ = 'America/New_York'
})
afterAll(() => {
  if (previousTimezone === undefined) delete process.env.TZ
  else process.env.TZ = previousTimezone
})
