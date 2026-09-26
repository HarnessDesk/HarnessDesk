import type { LedgerReport, RuntimeId } from '@harnessdesk/protocol'

/**
 * The arithmetic behind "When it ran" — the calendar heatmap band on the
 * Dashboard. Everything here is a pure function of a ledger and a clock, the
 * rule the rest of this screen keeps (`lib/ledger.ts`, `lib/usage.ts`): what
 * is true is decided here, tested without a browser, and the component only
 * draws it.
 *
 * **Days are stepped by the calendar, never by 86,400,000 ms.** `lib/ledger.ts`
 * already documents the DST bug that constant produces — a fixed step lands
 * an hour off across a daylight-saving change, and an exact-equality lookup
 * against the host's local-midnight keys misses every bucket at or after it.
 * `addDays` below steps with `Date#setDate`, the same fix `daysBefore` uses.
 */

export type HeatMetric = 'tokens' | 'cost'
export type HeatLevel = 0 | 1 | 2 | 3 | 4

/** One agent's share of one day. */
export interface HeatPart {
  readonly runtime: RuntimeId
  readonly tokens: number
  readonly cost: number
}

/** One calendar day, in local time, whatever the ledger says about it. */
export interface HeatCell {
  readonly day: number
  readonly tokens: number
  readonly cost: number
  /**
   * False for a day before the ledger holds any data at all — see
   * `earliestScannedDay`. A scanned day with nothing spent is a *zero*, drawn
   * as an empty cell; an unscanned one is drawn hatched, because a blank cell
   * cannot tell a reader which of those two it is looking at.
   */
  readonly scanned: boolean
  /** Every agent that spent something this day, most first. */
  readonly parts: readonly HeatPart[]
  /** Past "now" — the current week's tail in the year grid. Never rendered. */
  readonly future: boolean
}

const DAY_MS = 86_400_000

/** Local midnight for a given instant. */
export const localMidnight = (at: number): number => {
  const date = new Date(at)
  date.setHours(0, 0, 0, 0)
  return date.getTime()
}

/** The local midnight `delta` calendar days from `day` — never `day + delta * DAY_MS`. */
export const addDays = (day: number, delta: number): number => {
  const date = new Date(day)
  date.setDate(date.getDate() + delta)
  return date.getTime()
}

/** Monday of the week `day` falls in (`getDay()` is 0 = Sunday). */
export const mondayOnOrBefore = (day: number): number => {
  const dow = new Date(day).getDay()
  const sinceMonday = (dow + 6) % 7
  return addDays(day, -sinceMonday)
}

/** The earliest day the ledger has any row for, or null when it has none. */
export const earliestScannedDay = (ledger: LedgerReport | null): number | null => {
  if (!ledger || ledger.daily.length === 0) return null
  return ledger.daily.reduce((min, entry) => Math.min(min, entry.day), Number.POSITIVE_INFINITY)
}

const metricValue = (cell: Pick<HeatCell, 'tokens' | 'cost'>, metric: HeatMetric): number =>
  metric === 'tokens' ? cell.tokens : cell.cost

/**
 * A day whose tokens were spent but whose cost reads as nothing — not because
 * nothing was spent, but because nothing in the window has a public price.
 * `LedgerDay` carries no per-day price flag, so this is the same honest
 * approximation the band's note documents: real usage with no cost attached
 * is a model the ledger cannot price, not a free day.
 */
export const isUnpricedCost = (cell: HeatCell): boolean => cell.scanned && cell.tokens > 0 && cell.cost <= 0

/** Every calendar day from `startDay` to `endDay` inclusive, aggregated from the ledger. */
export const buildDayRange = (
  ledger: LedgerReport | null,
  startDay: number,
  endDay: number,
  now: number,
): readonly HeatCell[] => {
  const today = localMidnight(now)
  const earliest = earliestScannedDay(ledger)
  const byDay = new Map<number, Map<string, HeatPart>>()
  for (const entry of ledger?.daily ?? []) {
    const bucket = byDay.get(entry.day) ?? new Map<string, HeatPart>()
    const key = String(entry.runtime)
    const existing = bucket.get(key)
    bucket.set(key, {
      runtime: entry.runtime,
      tokens: (existing?.tokens ?? 0) + entry.tokens,
      cost: (existing?.cost ?? 0) + entry.cost,
    })
    byDay.set(entry.day, bucket)
  }

  const cells: HeatCell[] = []
  for (let day = startDay; day <= endDay; day = addDays(day, 1)) {
    const bucket = byDay.get(day)
    const parts = bucket ? [...bucket.values()].sort((a, b) => b.tokens - a.tokens) : []
    cells.push({
      day,
      tokens: parts.reduce((sum, part) => sum + part.tokens, 0),
      cost: parts.reduce((sum, part) => sum + part.cost, 0),
      scanned: earliest !== null && day >= earliest,
      parts,
      future: day > today,
    })
  }
  return cells
}

/** The last `spanDays` calendar days, ending today. */
export const buildRecentDays = (ledger: LedgerReport | null, now: number, spanDays: number): readonly HeatCell[] => {
  const today = localMidnight(now)
  return buildDayRange(ledger, addDays(today, -(spanDays - 1)), today, now)
}

export interface YearGrid {
  /** 53 columns, Monday first, 7 rows each. A cell outside the range is null. */
  readonly weeks: readonly (readonly (HeatCell | null)[])[]
  /** Where a month's label sits, keyed by the week (column) index. */
  readonly monthLabels: readonly { readonly week: number; readonly label: string }[]
}

const WEEKS_IN_YEAR_GRID = 53

/**
 * The year view's grid: 53 weeks by 7 days, Monday first, ending on the
 * Sunday of the week that holds `now`. Days after `now` in that last week are
 * real slots — the grid stays a rectangle — but come back `null`, the one
 * state the primitive draws as nothing at all.
 */
export const buildYearGrid = (ledger: LedgerReport | null, now: number): YearGrid => {
  const today = localMidnight(now)
  const endMonday = mondayOnOrBefore(today)
  const endSunday = addDays(endMonday, 6)
  const startMonday = addDays(endMonday, -(7 * (WEEKS_IN_YEAR_GRID - 1)))
  const cells = buildDayRange(ledger, startMonday, endSunday, now)

  const weeks: (HeatCell | null)[][] = []
  for (let week = 0; week < WEEKS_IN_YEAR_GRID; week += 1) {
    const slice = cells.slice(week * 7, week * 7 + 7)
    weeks.push(slice.map((cell) => (cell.future ? null : cell)))
  }

  const monthLabels: { week: number; label: string }[] = []
  let lastMonth = -1
  weeks.forEach((week, index) => {
    const first = week.find((cell): cell is HeatCell => cell !== null)
    if (!first) return
    const month = new Date(first.day).getMonth()
    if (month !== lastMonth) {
      monthLabels.push({ week: index, label: new Date(first.day).toLocaleDateString(undefined, { month: 'short' }) })
      lastMonth = month
    }
  })

  return { weeks, monthLabels }
}

export interface AgentRow {
  readonly runtime: RuntimeId
  readonly total: number
  readonly cells: readonly HeatCell[]
}

/** One row per agent over `cells`, most-total first, by whichever metric leads. */
export const buildAgentRows = (cells: readonly HeatCell[], metric: HeatMetric): readonly AgentRow[] => {
  const totals = new Map<string, { runtime: RuntimeId; total: number }>()
  for (const cell of cells) {
    for (const part of cell.parts) {
      const key = String(part.runtime)
      const entry = totals.get(key) ?? { runtime: part.runtime, total: 0 }
      entry.total += metricValue(part, metric)
      totals.set(key, entry)
    }
  }
  return [...totals.values()]
    .sort((a, b) => b.total - a.total)
    .map(({ runtime, total }) => ({
      runtime,
      total,
      cells: cells.map((cell) => {
        const part = cell.parts.find((entry) => entry.runtime === runtime)
        return {
          ...cell,
          tokens: part?.tokens ?? 0,
          cost: part?.cost ?? 0,
          parts: part ? [part] : [],
        }
      }),
    }))
}

/**
 * Four steps from the quartiles of the non-zero values in view, so one huge
 * day cannot wash out the rest of the year onto a flat "low". A single outlier
 * still reads as the outlier — everything else keeps whatever quartile it
 * actually falls in — because the breakpoints come from the data's own
 * distribution rather than from `max / 4`.
 */
export const quartileLevels = (values: readonly number[]): ((value: number) => HeatLevel) => {
  const nonZero = values.filter((value) => value > 0).sort((a, b) => a - b)
  if (nonZero.length === 0) return () => 0
  const quantile = (p: number): number => {
    if (nonZero.length === 1) return nonZero[0] as number
    const at = p * (nonZero.length - 1)
    const lo = Math.floor(at)
    const hi = Math.ceil(at)
    const low = nonZero[lo] as number
    if (lo === hi) return low
    const high = nonZero[hi] as number
    return low + (high - low) * (at - lo)
  }
  const q1 = quantile(0.25)
  const q2 = quantile(0.5)
  const q3 = quantile(0.75)
  return (value: number): HeatLevel => {
    if (value <= 0) return 0
    if (value <= q1) return 1
    if (value <= q2) return 2
    if (value <= q3) return 3
    return 4
  }
}

export interface Streaks {
  /** Consecutive active days ending at the last cell in view. */
  readonly current: number
  readonly best: number
}

/** Active days in a row, and the longest run — by whichever metric is on screen. */
export const streaksFor = (cells: readonly HeatCell[], metric: HeatMetric): Streaks => {
  let best = 0
  let run = 0
  for (const cell of cells) {
    if (metricValue(cell, metric) > 0) {
      run += 1
      best = Math.max(best, run)
    } else {
      run = 0
    }
  }
  let current = 0
  for (let index = cells.length - 1; index >= 0; index -= 1) {
    if (metricValue(cells[index] as HeatCell, metric) > 0) current += 1
    else break
  }
  return { current, best }
}

/** The day with the most, or null when nothing was found in view. */
export const busiestDay = (cells: readonly HeatCell[], metric: HeatMetric): HeatCell | null =>
  cells.reduce<HeatCell | null>(
    (best, cell) => (best === null || metricValue(cell, metric) > metricValue(best, metric) ? cell : best),
    null,
  )

/** 0 (Monday) .. 6 (Sunday), or null when nothing was spent in view. */
export const busiestWeekday = (cells: readonly HeatCell[], metric: HeatMetric): number | null => {
  const sums = [0, 0, 0, 0, 0, 0, 0]
  let any = false
  for (const cell of cells) {
    const value = metricValue(cell, metric)
    if (value <= 0) continue
    any = true
    const dow = (new Date(cell.day).getDay() + 6) % 7
    sums[dow] = (sums[dow] ?? 0) + value
  }
  if (!any) return null
  let best = 0
  for (let index = 1; index < 7; index += 1) if ((sums[index] ?? 0) > (sums[best] ?? 0)) best = index
  return best
}

export const WEEKDAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'] as const

/** The agent that spent the most in view, or null when nothing was spent. */
export const leadingAgent = (cells: readonly HeatCell[], metric: HeatMetric): RuntimeId | null => {
  const totals = new Map<string, number>()
  for (const cell of cells) {
    for (const part of cell.parts) {
      const key = String(part.runtime)
      totals.set(key, (totals.get(key) ?? 0) + metricValue(part, metric))
    }
  }
  let best: { runtime: RuntimeId; total: number } | null = null
  for (const cell of cells) {
    for (const part of cell.parts) {
      const total = totals.get(String(part.runtime)) ?? 0
      if (!best || total > best.total) best = { runtime: part.runtime, total }
    }
  }
  return best?.runtime ?? null
}

/** "Tue 16 Sep" — the long form a tooltip and an accessible label use. */
export const dayLabelLong = (day: number): string =>
  new Date(day).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })

export { DAY_MS }
