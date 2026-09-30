import { describe, expect, it } from 'vitest'

import {
  cycleStartFromLanes,
  overageAppliesToPeriod,
  paidForAccount,
  paidSummary,
  periodBounds,
  proratedFee,
  type Fee,
} from './paid'

// A bare "YYYY-MM-DD" is parsed as UTC by `Date`, but every function under
// test works in *local* calendar days (the same convention `lib/ledger.ts`
// keeps) — so this builds the same local day `new Date(y, m, d)` would,
// rather than letting the test's own dates drift by the runner's UTC offset.
const day = (iso: string): number => {
  const [datePart, timePart] = iso.split('T')
  const [year, month, date] = (datePart as string).split('-').map(Number) as [number, number, number]
  if (!timePart) return new Date(year, month - 1, date).getTime()
  const [hours, minutes, seconds] = timePart.split(':').map(Number)
  return new Date(year, month - 1, date, hours ?? 0, minutes ?? 0, seconds ?? 0).getTime()
}

describe('proratedFee', () => {
  it('prices a window inside one month at the plain daily rate', () => {
    const fee: Fee = { amount: 30, currency: 'USD', period: 'month' }
    // September has 30 days; a 10-day window inside it is 10/30 of the fee.
    const total = proratedFee(fee, day('2026-09-05'), day('2026-09-14'))
    expect(total).toBeCloseTo(30 * (10 / 30), 6)
  })

  it('splits a window across a month boundary by each month’s own length', () => {
    const fee: Fee = { amount: 30, currency: 'USD', period: 'month' }
    // Jan 25 .. Feb 3: 7 days of January (31), 3 days of February (28, 2026 is not a leap year).
    const total = proratedFee(fee, day('2026-01-25'), day('2026-02-03'))
    const expected = 30 * (7 / 31) + 30 * (3 / 28)
    expect(total).toBeCloseTo(expected, 6)
  })

  it('gives February its extra day in a leap year', () => {
    const fee: Fee = { amount: 29, currency: 'USD', period: 'month' }
    // 2028 is a leap year — all of February, 29 days, should be the whole fee.
    const total = proratedFee(fee, day('2028-02-01'), day('2028-02-29'))
    expect(total).toBeCloseTo(29, 6)
  })

  it('does not give a non-leap February a 29th day', () => {
    const fee: Fee = { amount: 28, currency: 'USD', period: 'month' }
    // 2026 is not a leap year — all 28 real days of February should be the whole fee.
    const total = proratedFee(fee, day('2026-02-01'), day('2026-02-28'))
    expect(total).toBeCloseTo(28, 6)
  })

  it('divides a yearly fee by 12 before prorating by day', () => {
    const fee: Fee = { amount: 1200, currency: 'USD', period: 'year' }
    // One full 30-day September at $100/month-equivalent should be $100.
    const total = proratedFee(fee, day('2026-09-01'), day('2026-09-30'))
    expect(total).toBeCloseTo(100, 6)
  })
})

describe('cycleStartFromLanes', () => {
  it('is null when the report carries no dated lane at all', () => {
    expect(cycleStartFromLanes([])).toBeNull()
    expect(cycleStartFromLanes(undefined)).toBeNull()
  })

  it('reads the cycle start off a lane missing a reset or a window', () => {
    expect(
      cycleStartFromLanes([
        { id: 'plan', label: 'Plan', usedPercent: 10, windowMinutes: null, resetsAt: null } as never,
      ]),
    ).toBeNull()
  })

  it('subtracts the window from the reset to find the cycle start', () => {
    const resetsAt = day('2026-09-25')
    const windowMinutes = 30 * 1_440 // 30 days, the monthly window `WINDOW_MINUTES.monthly` uses
    const cycleStart = cycleStartFromLanes([
      { id: 'plan', label: 'Plan', usedPercent: 40, windowMinutes, resetsAt } as never,
    ])
    expect(cycleStart).toBe(resetsAt - windowMinutes * 60_000)
  })

  it('prefers the overage lane over a plain plan lane when both are dated', () => {
    const planResetsAt = day('2026-10-01')
    const overageResetsAt = day('2026-09-25')
    const windowMinutes = 30 * 1_440
    const cycleStart = cycleStartFromLanes([
      { id: 'plan', label: 'Plan', usedPercent: 40, windowMinutes, resetsAt: planResetsAt, layer: 'plan' } as never,
      { id: 'overage', label: 'Overage', usedPercent: 10, windowMinutes, resetsAt: overageResetsAt, layer: 'overage' } as never,
    ])
    expect(cycleStart).toBe(overageResetsAt - windowMinutes * 60_000)
  })
})

describe('overageAppliesToPeriod', () => {
  it('applies when the cycle started on or after the window opened', () => {
    const now = day('2026-09-17')
    const { start, end } = periodBounds(7, now)
    // A cycle starting Sep 11 is inside a window that opens Sep 11.
    expect(overageAppliesToPeriod(day('2026-09-11'), start, end)).toBe(true)
  })

  it('does not apply when the cycle started before the window opened', () => {
    const now = day('2026-09-17')
    const { start, end } = periodBounds(7, now)
    // The cycle began Sep 1, well before this 7-day window opens (Sep 11).
    expect(overageAppliesToPeriod(day('2026-09-01'), start, end)).toBe(false)
  })

  it('does not apply when the cycle start is unknown', () => {
    const now = day('2026-09-17')
    const { start, end } = periodBounds(30, now)
    expect(overageAppliesToPeriod(null, start, end)).toBe(false)
  })
})

describe('paidForAccount', () => {
  const now = day('2026-09-17')
  const { start, end } = periodBounds(30, now)

  it('is null, never $0, for an account with no fee set', () => {
    expect(paidForAccount(undefined, start, end, null)).toEqual({ amount: null, currency: null, overageAside: null, overageAsideCurrency: null })
    expect(paidForAccount({ fee: null }, start, end, null)).toEqual({ amount: null, currency: null, overageAside: null, overageAsideCurrency: null })
  })

  it('adds overage spent into the figure when its cycle is wholly inside the window', () => {
    const fee: Fee = { amount: 30, currency: 'USD', period: 'month' }
    // A 30-day window ending today reaches back to Aug 19 — well before Sep 1.
    const cycleStart = day('2026-09-01')
    const withOverage = paidForAccount({ fee, overage: { enabled: true, spent: 12.5, currency: 'USD' } }, start, end, cycleStart)
    const withoutOverage = paidForAccount({ fee, overage: null }, start, end, cycleStart)
    expect(withOverage.amount).toBeCloseTo((withoutOverage.amount ?? 0) + 12.5, 6)
    expect(withOverage.overageAside).toBeNull()
  })

  it('shows overage beside the figure, never folded in, when the cycle started before the window opened', () => {
    const fee: Fee = { amount: 30, currency: 'USD', period: 'month' }
    // A 7-day window only reaches back a week — the cycle began well before that.
    const { start: weekStart, end: weekEnd } = periodBounds(7, now)
    const cycleStart = day('2026-09-01')
    const result = paidForAccount({ fee, overage: { enabled: true, spent: 50, currency: 'USD' } }, weekStart, weekEnd, cycleStart)
    const plain = paidForAccount({ fee, overage: null }, weekStart, weekEnd, cycleStart)
    // Never folded into the figure...
    expect(result.amount).toBeCloseTo(plain.amount ?? 0, 6)
    // ...and never dropped either.
    expect(result.overageAside).toBe(50)
  })

  it('shows overage beside the figure when the cycle start is unknown, rather than dropping or assuming it applies', () => {
    const fee: Fee = { amount: 30, currency: 'USD', period: 'month' }
    const result = paidForAccount({ fee, overage: { enabled: true, spent: 8, currency: 'USD' } }, start, end, null)
    expect(result.overageAside).toBe(8)
  })

  it('shows mismatched-currency overage beside Paid in its own currency', () => {
    const fee: Fee = { amount: 30, currency: 'USD', period: 'month' }
    const mismatched = paidForAccount({ fee, overage: { enabled: true, spent: 12.5, currency: 'EUR' } }, start, end, day('2026-09-01'))
    const plain = paidForAccount({ fee, overage: null }, start, end, day('2026-09-01'))
    expect(mismatched.amount).toBeCloseTo(plain.amount ?? 0, 6)
    expect(mismatched.overageAside).toBe(12.5)
    expect(mismatched.overageAsideCurrency).toBe('EUR')
  })
})

describe('paidSummary', () => {
  const now = day('2026-09-17')
  const { start, end } = periodBounds(30, now)

  it('sums known-fee accounts and counts the ones with no fee, never as $0', () => {
    const summary = paidSummary(
      [
        { billing: { fee: { amount: 30, currency: 'USD', period: 'month' } } },
        { billing: { fee: { amount: 20, currency: 'USD', period: 'month' } } },
        { billing: {} },
      ],
      start,
      end,
    )
    expect(summary.missingFeeCount).toBe(1)
    expect(summary.knownCount).toBe(2)
    expect(summary.currency).toBe('USD')
    expect(summary.amount).not.toBeNull()
    expect(summary.otherCurrencies).toBe(false)
  })

  it('is entirely null when nothing has a fee', () => {
    const summary = paidSummary([{ billing: {} }, { billing: {} }], start, end)
    expect(summary.amount).toBeNull()
    expect(summary.currency).toBeNull()
    expect(summary.missingFeeCount).toBe(2)
  })

  it('picks the currency with the largest sum when no preferred currency is given', () => {
    const summary = paidSummary(
      [
        { billing: { fee: { amount: 30, currency: 'USD', period: 'month' } } },
        { billing: { fee: { amount: 25, currency: 'EUR', period: 'month' } } },
      ],
      start,
      end,
    )
    expect(summary.currency).toBe('USD')
    expect(summary.otherCurrencies).toBe(true)
    expect(summary.otherCurrencyTotals).toHaveLength(1)
    expect(summary.otherCurrencyTotals[0]?.currency).toBe('EUR')
    expect(summary.amount).toBeCloseTo(proratedFee({ amount: 30, currency: 'USD', period: 'month' }, start, end), 6)
  })

  it('prefers the ledger’s own currency over the largest sum when a known account shares it', () => {
    const summary = paidSummary(
      [
        // The bigger sum is USD, but the ledger itself is EUR — that account's
        // own currency should lead, and the caption should still be able to
        // name the rest.
        { billing: { fee: { amount: 200, currency: 'USD', period: 'month' } } },
        { billing: { fee: { amount: 20, currency: 'EUR', period: 'month' } } },
      ],
      start,
      end,
      'EUR',
    )
    expect(summary.currency).toBe('EUR')
    expect(summary.otherCurrencyTotals[0]?.currency).toBe('USD')
  })

  it('never folds a per-account overage into the sum, and never drops it either', () => {
    const fee: Fee = { amount: 30, currency: 'USD', period: 'month' }
    const summary = paidSummary(
      [{ billing: { fee, overage: { enabled: true, spent: 50, currency: 'USD' } }, cycleStart: day('2026-09-01') }],
      // A 7-day window: the cycle (Sep 1) is well before it opens.
      periodBounds(7, now).start,
      periodBounds(7, now).end,
    )
    expect(summary.overageAside).toBe(50)
  })

  it('keeps foreign-currency overage separate from the main-currency aside and exposes it for the caption', () => {
    const summary = paidSummary(
      [
        { billing: { fee: { amount: 30, currency: 'USD', period: 'month' }, overage: { enabled: true, spent: 12.5, currency: 'EUR' } } },
        { billing: { fee: { amount: 20, currency: 'USD', period: 'month' }, overage: { enabled: true, spent: 7, currency: 'USD' } }, cycleStart: day('2026-08-01') },
      ],
      start,
      end,
      'USD',
    )
    expect(summary.overageAside).toBe(7)
    expect(summary.otherCurrencyOverageAsides).toEqual([{ currency: 'EUR', amount: 12.5 }])
  })
})
