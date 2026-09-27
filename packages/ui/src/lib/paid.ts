import type { UsageLane } from '@harnessdesk/protocol'

/**
 * Paid: the cash that actually left, for the Overview strip's first cell.
 *
 * Design: `docs/usage-dashboard.md`, "The Overview strip". Every account's
 * `billing.fee` is a recurring charge for a whole billing period (a month or
 * a year), never for the strip's own 7/30/90-day window, so it has to be
 * prorated onto whatever window is on screen — split by calendar day, so a
 * window that crosses a month boundary (or a leap-year February) charges
 * each day its own month's fair share rather than the window's average
 * across two different month lengths.
 *
 * `billing.overage.spent` is a cumulative cycle-to-date figure with no daily
 * breakdown of its own — it is spent between the *cycle's own start* and now,
 * and now is always inside the window this strip draws. When that cycle
 * start is on or after the window's own start, the whole of what the figure
 * counts happened inside the window, so it is added to Paid exactly. When
 * the cycle began earlier — most 7-day windows, most 30-day windows on the
 * month's later days — the figure counts money spent partly outside the
 * window too, which Paid cannot honestly fold in; it is shown *beside* the
 * figure instead (`overageAside`), never dropped, so a real cost never
 * vanishes from the screen. The cycle start comes from the report itself —
 * `cycleStartFromLanes`, below — never assumed to be the calendar 1st the
 * way a fee's own `period` would imply: a monthly fee's billing cycle does
 * not generally start on the 1st, and overage is usually metered monthly
 * even on a yearly plan.
 *
 * An account with no fee set is never counted as $0 — it is left out of the
 * sum and counted separately (`missingFeeCount`), so the caption can say
 * "fee not set for N" instead of understating the total. Currencies are
 * never mixed: `paidSummary` sums only the accounts sharing the main
 * currency (the ledger's own, when a known account shares it, else whichever
 * currency's sum is largest) and flags the rest as `otherCurrencies`, naming
 * their own total so it is not simply hidden.
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

/**
 * The current billing cycle's own start, read off the report rather than
 * assumed from `fee.period` — a monthly fee is not generally billed from the
 * calendar 1st, and overage is usually metered monthly even under a yearly
 * fee. A lane's `resetsAt` marks the *end* of its window, so subtracting its
 * own `windowMinutes` gives the start of the cycle that lane is counting —
 * the overage lane's own, when the report has one (the same cycle
 * `billing.overage.spent` is counted from), else any lane that carries both
 * fields at all. `null` — unknown — when nothing in the report can answer
 * this, which is honest: an unknown cycle start is exactly the case that
 * shows overage beside Paid rather than folded in.
 */
export const cycleStartFromLanes = (lanes: readonly UsageLane[] | undefined): number | null => {
  if (!lanes) return null
  const dated = lanes.filter(
    (lane): lane is UsageLane & { resetsAt: number; windowMinutes: number } =>
      lane.resetsAt !== null && lane.windowMinutes !== null && lane.windowMinutes > 0,
  )
  const lane = dated.find((candidate) => candidate.layer === 'overage') ?? dated[0]
  if (!lane) return null
  return lane.resetsAt - lane.windowMinutes * 60_000
}

/**
 * Whether `overage.spent` — a cumulative cycle-to-date figure with no daily
 * breakdown of its own — can be honestly folded into Paid: only when the
 * cycle it is measured from *started* at or after the window opened, so the
 * whole of what it counts happened inside the window. A cycle that began
 * before the window opened, or one whose start this report cannot say at
 * all (`cycleStart === null`), spent some of that money this figure cannot
 * separate out — see `overageAside` on `AccountPaid`, which is where it goes
 * instead of being dropped.
 */
export const overageAppliesToPeriod = (cycleStart: number | null, periodStart: number, periodEnd: number): boolean =>
  cycleStart !== null && cycleStart >= periodStart && cycleStart <= periodEnd

export interface AccountPaid {
  readonly amount: number | null
  readonly currency: string | null
  /**
   * Overage that is real and unpaid-for-elsewhere but cannot be honestly
   * folded into `amount` — the cycle it covers is not wholly inside the
   * window, or the report does not say where the cycle starts. Never
   * dropped: a caller shows this beside the figure ("+ $50 overage this
   * cycle") rather than silently losing it. `null` when there is nothing to
   * show beside it — no overage, or it was already added into `amount`.
   */
  readonly overageAside: number | null
}

/**
 * One account's Paid figure for the window — `null` when it has no fee set.
 *
 * `cycleStart` is this account's own billing cycle start, from
 * `cycleStartFromLanes` — `null` when the report does not say.
 */
export const paidForAccount = (
  billing: AccountBilling | undefined,
  periodStart: number,
  periodEnd: number,
  cycleStart: number | null,
): AccountPaid => {
  const fee = billing?.fee
  if (!fee) return { amount: null, currency: null, overageAside: null }
  const amount = proratedFee(fee, periodStart, periodEnd)
  const overage = billing?.overage
  if (overage?.enabled && overage.spent !== null && overage.currency === fee.currency) {
    if (overageAppliesToPeriod(cycleStart, periodStart, periodEnd)) {
      return { amount: amount + overage.spent, currency: fee.currency, overageAside: null }
    }
    return { amount, currency: fee.currency, overageAside: overage.spent }
  }
  return { amount, currency: fee.currency, overageAside: null }
}

export interface PaidSummary {
  /** The sum of every known-fee account sharing `currency`. `null` when none is known. */
  readonly amount: number | null
  /** The currency `amount` is in — the ledger's own when a known account shares it, else the largest sum's. */
  readonly currency: string | null
  /** Accounts in scope with no fee set at all. */
  readonly missingFeeCount: number
  readonly knownCount: number
  /** A known-fee account billed in a currency other than `currency`. */
  readonly otherCurrencies: boolean
  /** Each other currency's own total, so the caption can name it rather than just flag it. */
  readonly otherCurrencyTotals: readonly { readonly currency: string; readonly amount: number }[]
  /** Overage real and spent but not folded into `amount` — see `AccountPaid.overageAside`. Summed across the main-currency accounts; `null` when none of them has any. */
  readonly overageAside: number | null
}

export const paidSummary = (
  accounts: readonly { readonly billing?: AccountBilling; readonly cycleStart?: number | null }[],
  periodStart: number,
  periodEnd: number,
  preferredCurrency?: string | null,
): PaidSummary => {
  const perAccount = accounts.map((account) =>
    paidForAccount(account.billing, periodStart, periodEnd, account.cycleStart ?? null),
  )
  const known = perAccount.filter(
    (paid): paid is { readonly amount: number; readonly currency: string; readonly overageAside: number | null } =>
      paid.amount !== null && paid.currency !== null,
  )
  const missingFeeCount = perAccount.length - known.length
  if (known.length === 0) {
    return {
      amount: null,
      currency: null,
      missingFeeCount,
      knownCount: 0,
      otherCurrencies: false,
      otherCurrencyTotals: [],
      overageAside: null,
    }
  }
  const sumsByCurrency = new Map<string, number>()
  for (const paid of known) sumsByCurrency.set(paid.currency, (sumsByCurrency.get(paid.currency) ?? 0) + paid.amount)
  const mainCurrency =
    preferredCurrency && sumsByCurrency.has(preferredCurrency)
      ? preferredCurrency
      : ([...sumsByCurrency.entries()].sort((a, b) => b[1] - a[1])[0] as [string, number])[0]

  const amount = sumsByCurrency.get(mainCurrency) ?? 0
  const otherCurrencyTotals = [...sumsByCurrency.entries()]
    .filter(([currency]) => currency !== mainCurrency)
    .map(([currency, total]) => ({ currency, amount: total }))
  const overageAsideAmounts = known
    .filter((paid) => paid.currency === mainCurrency && paid.overageAside !== null)
    .map((paid) => paid.overageAside as number)
  return {
    amount,
    currency: mainCurrency,
    missingFeeCount,
    knownCount: known.length,
    otherCurrencies: otherCurrencyTotals.length > 0,
    otherCurrencyTotals,
    overageAside: overageAsideAmounts.length > 0 ? overageAsideAmounts.reduce((sum, value) => sum + value, 0) : null,
  }
}
