import type { LedgerReport, RuntimeId } from '@harnessdesk/protocol'

import type { HeatGridCell, HeatGridTooltip } from '../design'
import { formatTokens } from './context-usage'
import { formatMoney } from './usage'

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

/**
 * The local midnight `delta` calendar days from `day` — never
 * `day + delta * DAY_MS`.
 *
 * The trailing `setHours` matters on its own, not only the `setDate`: in a
 * zone where daylight saving starts *at* midnight (America/Havana,
 * America/Santiago, Asia/Beirut, Africa/Cairo), local midnight does not
 * exist on the change day, and `setDate` alone can leave the result an hour
 * off local midnight — which then compounds every later step, since
 * `buildDayRange` chains this call once per day. Re-stamping the hour after
 * the date move is what keeps every step exactly equal to `localMidnight` of
 * the same day, the same normalisation the host's own day keys use, so a
 * grid built across one of these zones still lines up with the ledger's
 * rows instead of drifting a cell short (review #990, item 5).
 */
export const addDays = (day: number, delta: number): number => {
  const date = new Date(day)
  date.setDate(date.getDate() + delta)
  date.setHours(0, 0, 0, 0)
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
  // Every active value the same — a single busy day, or a stretch that never
  // varies — leaves nothing for a quartile to split, and every one of the
  // four quantile checks below lands on the same number. That reads every
  // active cell as "level 1", the faintest step there is, which is backwards
  // for the only (or the most even) work in view: it should read as the top
  // of the scale, not the bottom (review #990, item 12).
  if (nonZero[0] === nonZero.at(-1)) return (value) => (value > 0 ? 4 : 0)
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

/** Level breakpoints for the year view: the combined per-day totals in view. */
export const yearLevels = (cells: readonly HeatCell[], metric: HeatMetric): ((value: number) => HeatLevel) =>
  quartileLevels(cells.map((cell) => metricValue(cell, metric)))

/**
 * Level breakpoints for the by-agent view: every agent's own per-day values,
 * not the day's combined total. Levelling agent rows off the combined
 * totals put nearly every cell in the lowest band, because a lighter
 * agent's busiest day rarely clears even the first quartile of everyone's
 * spend together — the bug the catalogue board's own `heatAgentRows` never
 * had, because it always split its levels from the agent rows themselves
 * rather than the day's combined figure (review #990, item 4).
 */
export const agentLevels = (rows: readonly AgentRow[], metric: HeatMetric): ((value: number) => HeatLevel) =>
  quartileLevels(rows.flatMap((row) => row.cells.map((cell) => metricValue(cell, metric))))

export interface Streaks {
  /** Consecutive active days ending at the last cell in view. */
  readonly current: number
  readonly best: number
}

/**
 * Active days in a row, and the longest run — by whichever metric is on
 * screen.
 *
 * `cells` always ends today (`buildRecentDays`/`buildYearGrid`'s last
 * non-null cell is `now`'s own day), and today reading zero does not mean
 * the streak broke — the day may simply not be over. Walking back from
 * *yesterday* instead when the last cell is empty is what keeps a real run
 * that is still in progress from reading as zero every morning before the
 * first turn (review #990, item 11).
 */
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
  let start = cells.length - 1
  if (start >= 0 && metricValue(cells[start] as HeatCell, metric) <= 0) start -= 1
  for (let index = start; index >= 0; index -= 1) {
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

/**
 * "Tue 16 Sep 2026" — the long form a tooltip and an accessible label use.
 * The year is not optional: on a 53-week grid the same "Mon, Sep 22" names a
 * day in each of two different years, and a reader has no other way to
 * tell them apart (review #990, item 15).
 */
export const dayLabelLong = (day: number): string =>
  new Date(day).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })

/**
 * The day's accessible description — one cell's whole story in a sentence,
 * shared by the grid's own `aria-label` list and its tooltip.
 *
 * "Unpriced" is spelled out rather than left to fall through to
 * `formatMoney` on its own: `formatMoney(0, …)` reads `$0.00`, a real
 * currency value, not the absence of one, so a day the ledger cannot price
 * needs its own check ahead of it or it reads as a free day (review #990,
 * item 6).
 */
export const cellLabel = (cell: HeatCell, metric: HeatMetric, currency = 'USD'): string => {
  if (!cell.scanned) return `${dayLabelLong(cell.day)}: no record yet`
  const unpriced = isUnpricedCost(cell)
  if (metric === 'cost' && unpriced) return `${dayLabelLong(cell.day)}: usage recorded, unpriced`
  const value = metricValue(cell, metric)
  if (value <= 0) return `${dayLabelLong(cell.day)}: nothing`
  const costPart = unpriced ? 'unpriced' : (formatMoney(cell.cost, currency) ?? 'unpriced')
  return `${dayLabelLong(cell.day)}: ${formatTokens(cell.tokens)} tokens, ${costPart}`
}

export interface ToGridCellOptions {
  readonly currency?: string
  /**
   * Disambiguates a cell's key across rows: the year view has one row per
   * weekday and each day appears in exactly one of them, but By agent
   * repeats every day once per agent row, and two agents' cells for the
   * same day would otherwise collide in the grid's sr-only list.
   */
  readonly rowKey?: string
  /** Today's own local-midnight key, so the grid can ring today's cell. */
  readonly today?: number
  /**
   * Present only where the caller can name a runtime — turns on the
   * tooltip's per-agent breakdown. The catalogue board has no names to give
   * and gets a cell with no tooltip at all, exactly as it always did.
   */
  readonly nameOf?: (id: RuntimeId) => string
}

/**
 * One `HeatCell` reduced to what `HeatGrid` draws: level, state, label and
 * (optionally) a tooltip. The Dashboard band and the catalogue board both
 * call this now instead of keeping their own copies, so a fix to any of
 * those lands in one place rather than two quietly disagreeing (review
 * #990, item 4 — the same review that found the board's own `heatAgentRows`
 * was already right and the band was not).
 */
export const toGridCell = (
  cell: HeatCell,
  metric: HeatMetric,
  levelOf: (value: number) => HeatLevel,
  options: ToGridCellOptions = {},
): HeatGridCell => {
  const { currency = 'USD', rowKey = '', today, nameOf } = options
  const value = metricValue(cell, metric)
  const unpriced = isUnpricedCost(cell)
  const notScanned = !cell.scanned || (metric === 'cost' && unpriced)
  const label = cellLabel(cell, metric, currency)

  let tooltip: HeatGridTooltip | undefined
  if (nameOf && cell.scanned && !notScanned && value > 0) {
    const parts = [...cell.parts].sort((a, b) => (metric === 'tokens' ? b.tokens - a.tokens : b.cost - a.cost))
    const top = parts.slice(0, 3)
    const rest = parts.length - top.length
    tooltip = {
      title: dayLabelLong(cell.day),
      rows: top.map((part) => ({
        key: String(part.runtime),
        label: nameOf(part.runtime),
        value: metric === 'tokens' ? formatTokens(part.tokens) : (formatMoney(part.cost, currency) ?? 'unpriced'),
      })),
      more: rest > 0 ? rest : undefined,
      footer: {
        label: 'Total',
        value: `${formatTokens(cell.tokens)} tokens · ${unpriced ? 'unpriced' : (formatMoney(cell.cost, currency) ?? '—')}`,
      },
    }
  } else if (notScanned) {
    tooltip = { title: dayLabelLong(cell.day), note: label.split(': ')[1] ?? label }
  }

  return {
    key: rowKey ? `${rowKey}:${cell.day}` : String(cell.day),
    level: notScanned ? 0 : levelOf(value),
    state: notScanned ? 'not-scanned' : value > 0 ? 'filled' : 'empty',
    today: today !== undefined && cell.day === today,
    ariaLabel: label,
    tooltip,
  }
}

export { DAY_MS }
