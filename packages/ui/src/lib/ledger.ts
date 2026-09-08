import type { LedgerReport, RuntimeId } from '@harnessdesk/protocol'

/**
 * What the ledger's daily rows are worth once someone asks a question of them.
 *
 * The band above these functions used to sum `ledger.daily` into one number
 * and one row of grey columns, which threw away both facts the ledger
 * actually carries: *which agent* spent each day — every `LedgerDay` names one
 * — and *how this window compares to the last one*, which is the only way a
 * total answers "is this a lot". CodexBar's comparison-periods design made the
 * second point plainly: a figure with no earlier figure beside it cannot be
 * read, and the earlier figure is already in the array you loaded.
 *
 * Everything here is a pure function of a report and a clock, so what the
 * chart claims is testable without a browser — the rule `lib/usage.ts`
 * already keeps for the cards.
 */

/** One bucket of the day chart: a local midnight and what each agent spent. */
export interface StackedDay {
  /** Local midnight, epoch milliseconds. */
  readonly day: number
  readonly total: number
  readonly tokens: number
  /** Per-agent cost for this day, in the series order of `StackedSeries.keys`. */
  readonly parts: readonly number[]
}

export interface StackedSeries {
  readonly days: readonly StackedDay[]
  /** The agents that actually spent something, biggest total first. */
  readonly keys: readonly RuntimeId[]
  /** The tallest day, so a caller can scale without walking the array again. */
  readonly peak: number
  readonly total: number
}

/**
 * The window as a column per day, oldest first, split by agent.
 *
 * Every day in the window is present even when nothing was spent, because a
 * chart that closes ranks over its quiet days is drawing a different month
 * from the one it is labelled with. Series order is by total spend rather than
 * by roster order: the agent that dominates a stack should be the one at the
 * bottom of every column, so the columns can be compared to each other.
 */
export const stackDaily = (ledger: LedgerReport | null, now: number): StackedSeries => {
  if (!ledger) return { days: [], keys: [], peak: 0, total: 0 }

  const byRuntime = new Map<RuntimeId, number>()
  const byDay = new Map<number, Map<RuntimeId, number>>()
  const tokensByDay = new Map<number, number>()
  for (const entry of ledger.daily) {
    byRuntime.set(entry.runtime, (byRuntime.get(entry.runtime) ?? 0) + entry.cost)
    const bucket = byDay.get(entry.day) ?? new Map<RuntimeId, number>()
    bucket.set(entry.runtime, (bucket.get(entry.runtime) ?? 0) + entry.cost)
    byDay.set(entry.day, bucket)
    tokensByDay.set(entry.day, (tokensByDay.get(entry.day) ?? 0) + entry.tokens)
  }

  const keys = [...byRuntime.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([runtime]) => runtime)

  const start = midnight(now)
  const days: StackedDay[] = []
  let peak = 0
  let total = 0
  for (let index = ledger.days - 1; index >= 0; index -= 1) {
    const day = daysBefore(start, index)
    const bucket = byDay.get(day)
    const parts = keys.map((runtime) => bucket?.get(runtime) ?? 0)
    const dayTotal = parts.reduce((sum, part) => sum + part, 0)
    if (dayTotal > peak) peak = dayTotal
    total += dayTotal
    days.push({ day, total: dayTotal, tokens: tokensByDay.get(day) ?? 0, parts })
  }
  return { days, keys, peak, total }
}

export interface PeriodTotal {
  readonly days: number
  /** "Today", "Last 7 days" — what the figure covers, in the band's own words. */
  readonly label: string
  readonly cost: number
  /**
   * True when the window ends on a day that is still running, and so cannot
   * honestly be compared with a finished one.
   */
  readonly partial: boolean
  /**
   * Change against the period of the same length immediately before it, as a
   * percentage. Null on a partial window, when the earlier period is not
   * wholly in the window, or when it was zero — a rise from nothing has no
   * percentage.
   */
  readonly change: number | null
}

/**
 * Today, and the shorter comparison periods that fit inside the window.
 *
 * Derived entirely from the days already loaded: no wider scan, no second
 * request, and a period longer than the window is simply not offered rather
 * than being silently truncated into a smaller number wearing a bigger label.
 * A change is only computed where the *whole* earlier period is also loaded.
 *
 * **The comparison windows end at the last complete day, and today is its own
 * tile.** A day still running measured against a whole one falls every
 * morning and recovers by evening, which is a property of the clock rather
 * than of the spending — worst at one day, where the figure can be a tenth of
 * what it will be, and still a systematic understatement of up to a seventh
 * over a week. So the multi-day windows drop the running day from *both*
 * sides, and today keeps a tile of its own with no percentage on it, because
 * there is nothing it can honestly be compared against. The pair reads
 * correctly together on the page: the "so far" under today's figure is what
 * tells a reader the window beside it is a finished one.
 */
export const periodTotals = (
  series: StackedSeries,
  spans: readonly number[] = [1, 7, 30],
): readonly PeriodTotal[] => {
  const totals = series.days.map((day) => day.total)
  // Today is the last bucket, and it is the one still being written to.
  const complete = totals.slice(0, -1)
  const out: PeriodTotal[] = []
  for (const span of spans) {
    if (span === 1) {
      if (totals.length === 0) continue
      out.push({
        days: 1,
        label: 'Today',
        cost: totals[totals.length - 1] ?? 0,
        partial: true,
        change: null,
      })
      continue
    }
    if (span > complete.length) continue
    const recent = sum(complete.slice(complete.length - span))
    const earlier =
      span * 2 <= complete.length
        ? sum(complete.slice(complete.length - span * 2, complete.length - span))
        : null
    out.push({
      days: span,
      label: `Last ${span} days`,
      cost: recent,
      partial: false,
      change: earlier === null || earlier === 0 ? null : ((recent - earlier) / earlier) * 100,
    })
  }
  return out
}

/** What one row is worth as a share of the whole, 0..100. */
export const shareOf = (value: number | null, total: number | null): number | null => {
  if (value === null || total === null || total <= 0) return null
  return (value / total) * 100
}

/** "Aug 24" — the axis label and the tooltip's heading use the same one. */
export const dayLabel = (day: number): string =>
  new Date(day).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })

/** "Sun, Aug 24" — the tooltip has room for the weekday, and a week is read by it. */
export const dayLabelLong = (day: number): string =>
  new Date(day).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })

const midnight = (at: number): number => {
  const date = new Date(at)
  date.setHours(0, 0, 0, 0)
  return date.getTime()
}

/**
 * The local midnight `back` days before this one, stepped by the calendar.
 *
 * Not `at − back × 86_400_000`, which is the same thing for 363 days a year
 * and wrong for the other two. The host's `day` is a **local** midnight —
 * `ledger/scan.ts` buckets with `setHours(0, 0, 0, 0)` — and local midnights
 * are 23 or 25 hours apart across a daylight-saving transition, so a fixed
 * step lands an hour off and the exact-equality lookup in `stackDaily` misses
 * every bucket at or before it.
 *
 * The failure is silent and total: those columns come back as zero-spend days
 * while the legend beside them, built from the raw rows, still names every
 * agent — a month of empty chart under a full legend, twice a year, and
 * nothing in the diff that made it would look like the cause. The host gets
 * away with the same arithmetic in its range queries because there it is a
 * `from` bound, which tolerates being an hour out. A map key does not.
 */
const daysBefore = (at: number, back: number): number => {
  const date = new Date(at)
  date.setDate(date.getDate() - back)
  return date.getTime()
}

const sum = (values: readonly number[]): number => values.reduce((total, value) => total + value, 0)
