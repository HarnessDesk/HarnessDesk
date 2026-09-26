import type { LedgerReport, LedgerRow, RuntimeId } from '@harnessdesk/protocol'

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
  /**
   * True when this day is before the ledger's own `coverage.earliestDay`, or
   * the ledger has no rows at all yet — the same "no record yet" rule
   * `lib/heat.ts` keeps for the calendar. A day like this carries no honest
   * total: `total` and `parts` are still 0, but a chart must draw it hatched
   * rather than as an empty, priced day. That distinction — a real zero
   * against a day the ledger cannot speak to — is the finding the old chart
   * missed: it drew both the same way, so a fortnight before an agent was
   * ever added read exactly like a fortnight of quiet work.
   */
  readonly unknown: boolean
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

  const earliest = ledger.coverage?.earliestDay ?? null

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
    const unknown = earliest === null || day < earliest
    days.push({ day, total: dayTotal, tokens: tokensByDay.get(day) ?? 0, parts, unknown })
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

/**
 * The window immediately before the one on screen, as a single figure and a
 * change against it.
 *
 * `wide` is a series built over twice the days on screen — the host query the
 * band asks for beside its own — and this slices the *older* half out of it
 * and sums it. `range` is the length of the window on screen, not `wide`'s
 * own day count, because a short-lived ledger can answer a `days: range * 2`
 * query with fewer days than asked, and slicing by `range` rather than by
 * `wide.days.length / 2` is what keeps the two halves the same width the
 * screen's own window is.
 *
 * `complete` is false when the older half is not wholly loaded — a ledger
 * that only reaches back `range * 1.4` days has an honest current period and
 * a previous one that is not comparable, and `change` is null in exactly that
 * case, the same rule `periodTotals` already keeps for a period longer than
 * what is loaded.
 */
export interface PreviousPeriod {
  readonly total: number
  /** The older half's own days, oldest first, for `alignGhost`. */
  readonly daily: readonly StackedDay[]
  readonly complete: boolean
  /** Against `currentTotal`. Null when incomplete, or when it was zero. */
  readonly change: number | null
}

export const previousPeriod = (
  wide: StackedSeries,
  range: number,
  currentTotal: number,
): PreviousPeriod => {
  const end = Math.max(0, wide.days.length - range)
  const start = Math.max(0, end - range)
  const daily = wide.days.slice(start, end)
  const complete = daily.length === range
  const total = sum(daily.map((day) => day.total))
  const change = !complete || total === 0 ? null : ((currentTotal - total) / total) * 100
  return { total, daily, complete, change }
}

/**
 * The previous period's per-agent totals, for the "Where it went" change chip
 * — computed off the same wide series `previousPeriod` slices, keyed by
 * `StackedSeries.keys` rather than recomputed from a second query.
 *
 * Only the *by agent* pivot can show this honestly: a model or a project can
 * gain or lose contributors between one period and the next, so "this model
 * cost 12% more" would really be saying "different work landed on it",
 * which is not what a change chip claims to measure. An agent is the one
 * pivot whose identity does not shift under it.
 */
export const previousByRuntime = (
  wide: StackedSeries,
  range: number,
): { readonly totals: ReadonlyMap<RuntimeId, number>; readonly complete: boolean } => {
  const end = Math.max(0, wide.days.length - range)
  const start = Math.max(0, end - range)
  const slice = wide.days.slice(start, end)
  const complete = slice.length === range
  const totals = new Map<RuntimeId, number>()
  wide.keys.forEach((key, index) => {
    totals.set(
      key,
      slice.reduce((total, day) => total + (day.parts[index] ?? 0), 0),
    )
  })
  return { totals, complete }
}

/**
 * The previous period's daily totals, aligned to the current period's own
 * buckets by day *index within the period* — "same day last period" — rather
 * than by calendar day, so a 30-day window's first bucket always lines up
 * with the previous period's first bucket even when one of the two ran
 * short.
 *
 * Aligned from the end: index `currentLength − 1` (today) always reads the
 * previous period's own last day, walking backward from there. A previous
 * period the ledger cannot reach that far into — a young account, or a
 * window wider than its history — leaves the corresponding entries `null`,
 * which the chart draws as a gap in the ghost line rather than a plunge to
 * zero.
 */
export const alignGhost = (
  currentLength: number,
  previousDaily: readonly StackedDay[],
): readonly (number | null)[] =>
  Array.from({ length: currentLength }, (_, index) => {
    const fromEnd = currentLength - index
    const previousIndex = previousDaily.length - fromEnd
    return previousIndex >= 0 && previousIndex < previousDaily.length
      ? (previousDaily[previousIndex]?.total ?? null)
      : null
  })

/**
 * A y-axis's three ticks — 0, the midpoint, and a round ceiling above the
 * peak — so ticks read as scale marks rather than as one more figure to
 * parse.
 *
 * "Round" is 1, 2 or 5 times a power of ten: the peak is never the axis top,
 * because a bar allowed to touch the frame reads as if it were clipped, and a
 * ceiling of `$63` reads as an arbitrary stopping point where `$70` reads as a
 * ruler.
 */
export const niceCeiling = (peak: number): number => {
  if (peak <= 0) return 0
  const exponent = Math.floor(Math.log10(peak))
  const magnitude = 10 ** exponent
  const fraction = peak / magnitude
  const step = fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 5 ? 5 : 10
  return step * magnitude
}

export const axisTicks = (peak: number): readonly [number, number, number] => {
  const top = niceCeiling(peak)
  return [0, top / 2, top]
}

/**
 * The tail beyond `limit` rows, folded into one "Other" row rather than
 * scrolling — the ranked table's own rule, applied once here so the band and
 * its tests share the arithmetic.
 *
 * The folded row's `cost` and `tokens` stay `null` when *every* folded row's
 * own figure was `null`, and sum only the ones that were not — the same
 * "unpriced is never $0" rule a single row keeps, kept for a row that stands
 * in for several. `hasUnpriced` is set when any folded row carried it, so the
 * table's own unpriced footnote still counts a row hiding inside "Other".
 */
export interface FoldedRows {
  readonly shown: readonly LedgerRow[]
  readonly other: LedgerRow | null
}

export const foldOther = (rows: readonly LedgerRow[], limit = 6): FoldedRows => {
  if (rows.length <= limit) return { shown: rows, other: null }
  const shown = rows.slice(0, limit)
  const tail = rows.slice(limit)
  const cost = tail.some((row) => row.cost !== null)
    ? tail.reduce((total, row) => total + (row.cost ?? 0), 0)
    : null
  const tokens = tail.some((row) => row.tokens !== null)
    ? tail.reduce((total, row) => total + (row.tokens ?? 0), 0)
    : null
  const other: LedgerRow = {
    key: '__other__',
    label: `Other · ${tail.length}`,
    runtime: null,
    tokens,
    cost,
    hasUnpriced: tail.some((row) => row.hasUnpriced),
  }
  return { shown, other }
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

/**
 * "Sun, Aug 24, 2026" — the money chart's own tooltip, which is the one place
 * on this band a bare month and day can name the wrong year: a 90-day range
 * crosses a January, and "Dec 28" beside "Jan 3" with no year is a tooltip
 * that has to be taken on faith.
 */
export const dayLabelWithYear = (day: number): string =>
  new Date(day).toLocaleDateString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  })

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
