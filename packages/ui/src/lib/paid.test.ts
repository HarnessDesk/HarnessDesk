import { describe, expect, it } from 'vitest'

import {
  cycleStartFor,
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

describe('cycleStartFor / overageAppliesToPeriod', () => {
  it('starts a monthly cycle on the 1st of the current month', () => {
    expect(cycleStartFor('month', day('2026-09-17T15:00:00'))).toBe(day('2026-09-01'))
  })

  it('starts a yearly cycle on January 1st', () => {
    expect(cycleStartFor('year', day('2026-09-17T15:00:00'))).toBe(day('2026-01-01'))
  })

  it('includes overage when the whole cycle sits inside the window', () => {
    const now = day('2026-09-17')
    // A 30-day window ending today reaches back to Aug 19 — well before Sep 1.
    const { start, end } = periodBounds(30, now)
    expect(overageAppliesToPeriod('month', start, end, now)).toBe(true)
  })

  it('excludes overage when the cycle started before the window opened', () => {
    const now = day('2026-09-17')
    // A 7-day window only reaches back to Sep 11 — the cycle began Sep 1, outside it.
    const { start, end } = periodBounds(7, now)
    expect(overageAppliesToPeriod('month', start, end, now)).toBe(false)
  })
})

describe('paidForAccount', () => {
  const now = day('2026-09-17')
  const { start, end } = periodBounds(30, now)

  it('is null, never $0, for an account with no fee set', () => {
    expect(paidForAccount(undefined, start, end, now)).toEqual({ amount: null, currency: null })
    expect(paidForAccount({ fee: null }, start, end, now)).toEqual({ amount: null, currency: null })
  })

  it('adds overage spent when its cycle is inside the window', () => {
    const fee: Fee = { amount: 30, currency: 'USD', period: 'month' }
    const withOverage = paidForAccount(
      { fee, overage: { enabled: true, spent: 12.5, currency: 'USD' } },
      start,
      end,
      now,
    )
    const withoutOverage = paidForAccount({ fee, overage: null }, start, end, now)
    expect(withOverage.amount).not.toBeNull()
    expect(withOverage.amount).toBeCloseTo((withoutOverage.amount ?? 0) + 12.5, 6)
  })

  it('leaves overage out when its currency does not match the fee', () => {
    const fee: Fee = { amount: 30, currency: 'USD', period: 'month' }
    const mismatched = paidForAccount(
      { fee, overage: { enabled: true, spent: 12.5, currency: 'EUR' } },
      start,
      end,
      now,
    )
    const plain = paidForAccount({ fee, overage: null }, start, end, now)
    expect(mismatched.amount).toBeCloseTo(plain.amount ?? 0, 6)
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
      now,
    )
    expect(summary.missingFeeCount).toBe(1)
    expect(summary.knownCount).toBe(2)
    expect(summary.currency).toBe('USD')
    expect(summary.amount).not.toBeNull()
    expect(summary.otherCurrencies).toBe(false)
  })

  it('is entirely null when nothing has a fee', () => {
    const summary = paidSummary([{ billing: {} }, { billing: {} }], start, end, now)
    expect(summary.amount).toBeNull()
    expect(summary.currency).toBeNull()
    expect(summary.missingFeeCount).toBe(2)
  })

  it('flags accounts billed in another currency and excludes them from the sum', () => {
    const summary = paidSummary(
      [
        { billing: { fee: { amount: 30, currency: 'USD', period: 'month' } } },
        { billing: { fee: { amount: 25, currency: 'EUR', period: 'month' } } },
      ],
      start,
      end,
      now,
    )
    expect(summary.currency).toBe('USD')
    expect(summary.otherCurrencies).toBe(true)
    expect(summary.amount).toBeCloseTo(proratedFee({ amount: 30, currency: 'USD', period: 'month' }, start, end), 6)
  })
})
