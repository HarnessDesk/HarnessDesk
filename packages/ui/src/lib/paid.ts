/**
 * Paid: the cash that actually left, for the Overview strip's first cell.
 *
 * Design: `docs/usage-dashboard.md`, "The Overview strip". Every account's
 * `billing.fee` is a recurring charge for a whole billing period (a month or
 * a year), never for the strip's own 7/30/90-day window, so it has to be
 * prorated onto whatever window is on screen — split by calendar day, so a
 * window that crosses a month boundary (or a leap-year February) charges
 * each day its own month's fair share rather than the window's average
 * across two different month lengths. `billing.overage.spent` is added on
 * top only when the *whole* of the current billing cycle sits inside the
 * window — see `overageAppliesToPeriod` — because it is a cumulative
 * cycle-to-date figure with no daily breakdown of its own, and a window that
 * only catches part of the cycle cannot honestly claim the whole number.
 *
 * An account with no fee set is never counted as $0 — it is left out of the
 * sum and counted separately (`missingFeeCount`), so the caption can say
 * "fee not set for N" instead of understating the total. Currencies are
 * never mixed: `paidSummary` sums only the accounts sharing the first known
 * currency and flags the rest as `otherCurrencies`.
 */

export interface Fee {
  readonly amount: number
  readonly currency: string
  readonly period: 'month' | 'year'
}

export interface Overage {
  readonly enabled: boolean
  readonly spent: number | null
  readonly currency: string
}

export interface AccountBilling {
  readonly fee?: Fee | null
  readonly overage?: Overage | null
}

const localMidnight = (at: number): number => {
  const date = new Date(at)
  date.setHours(0, 0, 0, 0)
  return date.getTime()
}

/** "Last N days", ending today — the same window the Spend chart draws. */
export const periodBounds = (range: number, now: number): { readonly start: number; readonly end: number } => {
  const end = localMidnight(now)
  const start = new Date(end)
  start.setDate(start.getDate() - (range - 1))
  return { start: start.getTime(), end }
}

/** Every local calendar day from `periodStart` to `periodEnd`, inclusive. */
const daysInRange = (periodStart: number, periodEnd: number): readonly number[] => {
  const days: number[] = []
  let cursor = localMidnight(periodStart)
  const end = localMidnight(periodEnd)
  while (cursor <= end) {
    days.push(cursor)
    const next = new Date(cursor)
    next.setDate(next.getDate() + 1)
    cursor = next.getTime()
  }
  return days
}

/**
 * The fee's share of the days actually inside the window, one calendar day
 * at a time: each day charges `(fee ÷ 12, for a yearly fee) ÷ the number of
 * days in that day's own month`, so a window spanning two months of
 * different lengths — or a leap-year February — prices each day against the
 * month it actually falls in rather than the window's own length. Summing
 * per day is exactly "days-in-period-that-month ÷ days-in-that-month" per
 * month, computed without walking month boundaries by hand.
 */
export const proratedFee = (fee: Fee, periodStart: number, periodEnd: number): number => {
  const monthly = fee.period === 'year' ? fee.amount / 12 : fee.amount
  let total = 0
  for (const day of daysInRange(periodStart, periodEnd)) {
    const date = new Date(day)
    const daysInMonth = new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate()
    total += monthly / daysInMonth
  }
  return total
}

/** The current billing cycle's own start — the 1st of the month, or of the year. */
export const cycleStartFor = (period: Fee['period'], now: number): number => {
  const date = new Date(now)
  return period === 'year'
    ? new Date(date.getFullYear(), 0, 1).getTime()
    : new Date(date.getFullYear(), date.getMonth(), 1).getTime()
}

/**
 * Whether `overage.spent` — a cumulative cycle-to-date figure with no daily
 * breakdown — can be honestly attributed to this window at all: only when
 * the cycle it is measured from *started* inside the window, so the whole of
 * what it counts happened there. A cycle that began before the window
 * opened has spent some of that money outside the window this figure cannot
 * separate out, so it is left out entirely rather than counted in full.
 */
export const overageAppliesToPeriod = (
  period: Fee['period'],
  periodStart: number,
  periodEnd: number,
  now: number,
): boolean => {
  const cycleStart = cycleStartFor(period, now)
  return cycleStart >= periodStart && cycleStart <= periodEnd
}

export interface AccountPaid {
  readonly amount: number | null
  readonly currency: string | null
}

/** One account's Paid figure for the window — `null` when it has no fee set. */
export const paidForAccount = (
  billing: AccountBilling | undefined,
  periodStart: number,
  periodEnd: number,
  now: number,
): AccountPaid => {
  const fee = billing?.fee
  if (!fee) return { amount: null, currency: null }
  let amount = proratedFee(fee, periodStart, periodEnd)
  const overage = billing?.overage
  if (
    overage?.enabled &&
    overage.spent !== null &&
    overage.currency === fee.currency &&
    overageAppliesToPeriod(fee.period, periodStart, periodEnd, now)
  ) {
    amount += overage.spent
  }
  return { amount, currency: fee.currency }
}

export interface PaidSummary {
  /** The sum of every known-fee account sharing `currency`. `null` when none is known. */
  readonly amount: number | null
  /** The currency `amount` is in — the first known account's own. */
  readonly currency: string | null
  /** Accounts in scope with no fee set at all. */
  readonly missingFeeCount: number
  readonly knownCount: number
  /** A known-fee account billed in a currency other than `currency`. */
  readonly otherCurrencies: boolean
}

export const paidSummary = (
  accounts: readonly { readonly billing?: AccountBilling }[],
  periodStart: number,
  periodEnd: number,
  now: number,
): PaidSummary => {
  const perAccount = accounts.map((account) => paidForAccount(account.billing, periodStart, periodEnd, now))
  const known = perAccount.filter(
    (paid): paid is { readonly amount: number; readonly currency: string } =>
      paid.amount !== null && paid.currency !== null,
  )
  const missingFeeCount = perAccount.length - known.length
  if (known.length === 0) {
    return { amount: null, currency: null, missingFeeCount, knownCount: 0, otherCurrencies: false }
  }
  const mainCurrency = (known[0] as { readonly amount: number; readonly currency: string }).currency
  const currencies = new Set(known.map((paid) => paid.currency))
  const amount = known
    .filter((paid) => paid.currency === mainCurrency)
    .reduce((sum, paid) => sum + paid.amount, 0)
  return {
    amount,
    currency: mainCurrency,
    missingFeeCount,
    knownCount: known.length,
    otherCurrencies: currencies.size > 1,
  }
}
