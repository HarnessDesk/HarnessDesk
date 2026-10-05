import type { UsageLane, UsagePreference, UsageReport } from '@harnessdesk/protocol'
import { bindingLane } from '@harnessdesk/protocol'

import { paidForAccount, cycleStartFromLanes, periodBounds } from './paid'
import { paidRatio } from './overview-strip'
import { formatTokens } from './context-usage'
import { balanceOf, DEFAULT_RANGE, describeReport, drawnReport, formatMoney, reportNeedsAttention, type ReportView } from './usage'
import type { Tone } from './limits'

/**
 * The Plans table: one row per account, sorted by what is left, and the six
 * shapes a row can be. Design: `docs/usage-dashboard.md`, "The five shapes"
 * and the Plans-table PR. Pure and unit-tested off React — `PlansTable.tsx`
 * only draws what this module decides.
 */

/** The five shapes `UsageBilling.kinds` names, in the order a primary shape is chosen. */
export type PlanShape = 'windows' | 'allowance' | 'balance' | 'metered' | 'free'

/** A row's shape, plus the one case no `UsageBilling` value can express. */
export type RowShape = PlanShape | 'none'

const SHAPE_ORDER: readonly PlanShape[] = ['windows', 'allowance', 'balance', 'metered', 'free']

/** A card's own word for each shape — the "Key" body, the "Balance" body. */
export const SHAPE_LABEL: Readonly<Record<PlanShape, string>> = {
  windows: 'Windows',
  allowance: 'Allowance',
  balance: 'Balance',
  metered: 'Key',
  free: 'Free',
}

/** The filter chip's own word — plural where the shape's label is not already one. */
export const SHAPE_CHIP_LABEL: Readonly<Record<RowShape, string>> = {
  windows: 'Windows',
  allowance: 'Allowances',
  balance: 'Balances',
  metered: 'Keys',
  free: 'Free',
  none: 'Not reporting',
}

/**
 * An account's primary shape: the first of `billing.kinds` in the fixed order
 * windows → allowance → balance → metered → free.
 *
 * A report with no `billing` at all but real lanes or a real balance still has
 * a shape — a source that predates `billing` reported nothing else — so the
 * fallback reads the same facts `billing.kinds` would have named. Only a
 * report with none of `billing`, `lanes` or a balance is `'none'`: "not
 * reporting."
 */
export const primaryShapeOf = (report: UsageReport): RowShape => {
  const kinds = report.billing?.kinds ?? []
  for (const shape of SHAPE_ORDER) {
    if (kinds.includes(shape)) return shape
  }
  if (report.lanes.length > 0) return 'windows'
  if (balanceOf(report.credits) !== null) return 'balance'
  return 'none'
}

export interface ShapeCounts {
  readonly all: number
  readonly windows: number
  readonly allowance: number
  readonly balance: number
  readonly metered: number
  readonly free: number
  readonly none: number
}

/**
 * The filter row's own counts: one per shape, plus the total.
 *
 * Read off the rows the table itself drew (`row.shape`, one per
 * `planRows(...)` entry) — never off the raw reports a second time — so a
 * report whose *drawn* shape differs from its raw one (an unverified
 * sign-in with empty lanes, borrowed into a Windows reading) is counted the
 * same way the row itself reads (review of #1069, B3).
 *
 * `notReportingExtra` folds in agents with no report at all (`silentAgentsOf`)
 * — the "Not reporting" chip counts every agent `NotReportingList` will
 * list, not only the rows that happen to carry no shape.
 */
export const shapeCountsOf = (shapes: readonly RowShape[], notReportingExtra = 0): ShapeCounts => {
  const counts: { [K in RowShape]: number } = { windows: 0, allowance: 0, balance: 0, metered: 0, free: 0, none: 0 }
  for (const shape of shapes) counts[shape] += 1
  counts.none += notReportingExtra
  return { all: shapes.length + notReportingExtra, ...counts }
}

/** What the table's bar and percent column draw, or nothing at all. */
export interface LeftReading {
  /** 0–100, what is left. Null draws no bar and no percent — Free's rule, and Balance/Key with nothing to scale against. */
  readonly percent: number | null
}

const clamp = (value: number, low: number, high: number): number => (value < low ? low : value > high ? high : value)

/**
 * The balance shape's own scale: runway days (balance ÷ a recent daily draw)
 * against a 30-day span. `null` when there is no draw to divide by — a fresh
 * account with no spend history yet — which draws no bar rather than a false
 * "plenty" reading.
 *
 * The draw rate is the mean cost over the days the report actually covers
 * (`spend.coverage.daysCovered`, falling back to the daily series' own
 * length when a source gives no coverage), including a zero day as the
 * quiet day it was — leaving idle days out the way the first cut of this
 * did overstated the draw, which understated the runway it fed (review of
 * #1069, N5). A window with no covered days at all still has no rate to
 * divide by, which stays null rather than a false "plenty" reading.
 */
export const runwayDaysOf = (report: UsageReport): number | null => {
  const balance = balanceOf(report.credits)?.remaining ?? null
  if (balance === null) return null
  const daily = report.spend?.daily
  if (!daily || daily.length === 0) return null
  const priced = daily.filter((day) => day.cost !== null)
  if (priced.length === 0) return null
  const days = report.spend?.coverage?.daysCovered ?? daily.length
  if (days <= 0) return null
  const total = priced.reduce((sum, day) => sum + (day.cost ?? 0), 0)
  const draw = total / days
  if (draw <= 0) return null
  return balance / draw
}

/** The budget bar's own reading for a Key account, or null with no budget set or unknown spend. */
export const budgetLeftPercentOf = (report: UsageReport): number | null => {
  const budget = report.billing?.budget
  if (!budget || budget.amount <= 0) return null
  const spent = report.billing?.overage?.spent ?? report.spend?.windowCost ?? null
  if (spent === null) return null
  return clamp(((budget.amount - spent) / budget.amount) * 100, 0, 100)
}

/**
 * The table's bar/percent column, one rule per shape:
 * - windows/allowance: the binding lane's own percent left.
 * - balance: runway days against a 30-day scale.
 * - metered (Key): budget left, or no bar without one.
 * - free: never a bar.
 */
export const leftOf = (shape: RowShape, report: UsageReport, view: ReportView): LeftReading => {
  switch (shape) {
    case 'windows':
    case 'allowance':
      return { percent: view.hero?.remainingPercent ?? null }
    case 'balance': {
      // A spent balance is a real zero — the meter's own empty track in the
      // danger tone — never "nothing to report," whether or not a draw rate
      // happens to be on file yet to compute a runway from.
      const balance = balanceOf(report.credits)?.remaining ?? null
      if (balance !== null && balance <= 0) return { percent: 0 }
      const days = runwayDaysOf(report)
      return { percent: days === null ? null : clamp((days / 30) * 100, 0, 100) }
    }
    case 'metered':
      return { percent: budgetLeftPercentOf(report) }
    case 'free':
    case 'none':
      return { percent: null }
  }
}

export type RowStatus = 'ready' | 'low' | 'out' | 'overage' | 'unlimited' | 'notReporting'

export const STATUS_LABEL: Readonly<Record<RowStatus, string>> = {
  ready: 'Ready',
  low: 'Low',
  out: 'Spent',
  overage: 'Low',
  unlimited: 'Ready',
  notReporting: 'Not reporting',
}

export const STATUS_TONE: Readonly<Record<RowStatus, Tone>> = {
  ready: 'good',
  low: 'warn',
  out: 'bad',
  overage: 'warn',
  unlimited: 'good',
  notReporting: 'good',
}

/**
 * The status chip, from the one needs-attention rule (`reportNeedsAttention`,
 * `lib/usage.ts`) — never a second judgement of whether an account is in
 * trouble.
 *
 * It used to test `view.tone === 'warn'` directly, which missed everything
 * `reportNeedsAttention` was written to catch: `report.error`, `view.gated`,
 * a `severity: 'critical'` lane (a hero tone of `'bad'`, not `'warn'`), and a
 * healthy headline hiding a low account-wide lane behind it — the frames
 * showed exactly that split, a green "Max 20x" chip in the expanded body
 * beside a red "Low" row above it. `raw` is the account's own report, read on
 * its own lanes — never a borrowed sign-in's, the same rule `view` (below)
 * already keeps for `blocked`.
 */
export const statusOf = (
  raw: UsageReport,
  shape: RowShape,
  view: ReportView,
  now: number,
  preference?: UsagePreference,
): RowStatus => {
  const balance = shape === 'balance' ? (balanceOf(raw.credits)?.remaining ?? null) : null
  if (view.blocked || (balance !== null && balance <= 0)) return 'out'
  const overage = raw.billing?.overage
  if (overage?.enabled && (overage.spent ?? 0) > 0) return 'overage'
  if (shape === 'none') return 'notReporting'
  if (reportNeedsAttention(raw, now, preference)) return 'low'
  if (shape === 'free') return 'unlimited'
  if (shape === 'metered' && !raw.billing?.budget) return 'unlimited'
  return 'ready'
}

/**
 * "312 of 500 requests", "$0.88 balance" — the vendor's own unit, spelled
 * out. Never a usedPercent beside the table's own % column, which already
 * carries "29% left": the meter-direction rule (docs/usage-dashboard.md,
 * "one scale per card") holds for this column too, so a percent-shaped
 * lane's own reading here is its label alone — "Session", "5-hour",
 * "Weekly · Opus" (`hero.title`, the label plus its scope) — never a second
 * figure on the other scale.
 */
export const ownUnitOf = (shape: RowShape, report: UsageReport, view: ReportView): string => {
  switch (shape) {
    case 'windows': {
      const hero = view.hero
      return hero ? hero.title : '—'
    }
    case 'allowance': {
      const lane = bindingLane(report.lanes)
      if (lane && lane.unit && lane.used != null && lane.limit != null) {
        if (lane.unit === 'usd') return `${formatMoney(lane.used) ?? lane.used} of ${formatMoney(lane.limit) ?? lane.limit}`
        return `${lane.used.toLocaleString()} of ${lane.limit.toLocaleString()} ${lane.unit}`
      }
      const hero = view.hero
      return hero ? hero.title : '—'
    }
    case 'balance': {
      const balance = balanceOf(report.credits)?.remaining ?? null
      if (balance === null) return '—'
      const unit = report.credits?.unit ?? 'USD'
      return unit === 'USD' ? `${formatMoney(balance) ?? balance} balance` : `${balance.toLocaleString()} ${unit} balance`
    }
    case 'metered': {
      const budget = report.billing?.budget
      const spent = report.billing?.overage?.spent ?? report.spend?.windowCost ?? null
      if (budget) {
        return spent === null
          ? `— of ${formatMoney(budget.amount, budget.currency) ?? '—'} budget`
          : `${formatMoney(spent, budget.currency) ?? '—'} of ${formatMoney(budget.amount, budget.currency) ?? '—'} budget`
      }
      return spent !== null ? `${formatMoney(spent) ?? '—'} spent` : '—'
    }
    case 'free': {
      const tokens = report.spend?.windowTokens ?? null
      return tokens !== null ? `${formatTokens(tokens)} tokens` : '—'
    }
    case 'none':
      return '—'
  }
}

/**
 * Remaining units in whatever unit a turn is priced against — see
 * `approxTurnsOf`. Null whenever the unit a turn is priced in cannot be
 * matched to the unit this shape actually measures: an allowance's own
 * `unitsPerTurn` is a *requests* rate, so a `percent`- or `usd`-unit lane
 * never has a turn count to give (review of #1069, B7) — dividing a percent
 * or a dollar figure by a requests-per-turn rate would answer a question
 * nobody asked. A balance or a key's `unitsPerTurn` is priced in the report's
 * own currency, so it applies only when the balance/budget is kept in that
 * same currency.
 */
const remainingUnitsOf = (shape: RowShape, report: UsageReport): number | null => {
  if (shape === 'allowance') {
    const lane = bindingLane(report.lanes)
    if (!lane || lane.unit !== 'requests' || lane.used == null || lane.limit == null) return null
    return Math.max(0, lane.limit - lane.used)
  }
  if (shape === 'balance') {
    const currency = report.spend?.currency ?? 'USD'
    if ((report.credits?.unit ?? currency) !== currency) return null
    return balanceOf(report.credits)?.remaining ?? null
  }
  if (shape === 'metered') {
    const budget = report.billing?.budget
    if (!budget) return null
    const currency = report.spend?.currency ?? 'USD'
    if (budget.currency !== currency) return null
    const spent = report.billing?.overage?.spent ?? report.spend?.windowCost ?? 0
    return Math.max(0, budget.amount - spent)
  }
  return null
}

/**
 * "~97" — remaining units divided by `turns.unitsPerTurn`, only when that rate
 * is known. `unitsPerTurn` is null for every plain percent window (`windows`)
 * and wherever the ledger has too thin a sample, and this never approximates
 * around that: no rate means no figure, per the owner's 2026-09-26 rule that
 * `unitsPerTurn` is exact or absent, never estimated.
 */
export const approxTurnsOf = (shape: RowShape, report: UsageReport): string => {
  const turns = report.turns
  if (!turns || turns.unitsPerTurn === null || turns.unitsPerTurn <= 0) return '—'
  const remaining = remainingUnitsOf(shape, report)
  if (remaining === null) return '—'
  return `~${Math.round(remaining / turns.unitsPerTurn)}`
}

/** The binding lane's own reset, one unit, or "—". */
export const resetsOf = (view: ReportView): string => view.hero?.resetCountdown ?? '—'

export interface PlanRow {
  readonly key: string
  /**
   * What the row draws — `drawnReport(raw)`, the same substitution
   * `shared.tsx`'s `Card` already makes when an agent's own lanes are empty
   * but another sign-in's figures (`unverified`) are not. Everything the row
   * and its expanded body *show* reads this; `status` alone reads the
   * account's own report, never a borrowed one (below).
   */
  readonly report: UsageReport
  /**
   * The account's own report, undrawn. `Card` (the Windows body, reused
   * verbatim) does its own borrowing check internally — the same one that
   * produced `report` above — so it must be handed this one and never the
   * already-drawn `report`, or it would treat a borrowed sign-in's own
   * figures as if they were the agent's, and could put "Out" on an agent
   * that may be signed in as somebody else.
   */
  readonly raw: UsageReport
  readonly shape: RowShape
  readonly view: ReportView
  readonly left: LeftReading
  readonly status: RowStatus
  readonly ownUnit: string
  readonly approxTurns: string
  readonly resets: string
}

/**
 * One row of the table, everything it draws decided once.
 *
 * `status` is read from the account's own report, not a borrowed one: the
 * chip must never put "Out" on an agent that may be signed in as somebody
 * else (`docs/usage-dashboard.md`'s note on `unverified`) — the same rule
 * `Card`'s own `stateOf` keeps. Borrowed and not blocked, it reads the raw
 * report's own (empty) lanes rather than the drawn ones.
 */
export const describeRow = (report: UsageReport, now: number, preference?: UsagePreference): PlanRow => {
  const drawn = drawnReport(report)
  const borrowed = drawn !== report
  const shape = primaryShapeOf(drawn)
  const view = describeReport(drawn, { now, maxLanes: 3, preference })
  const left = leftOf(shape, drawn, view)
  const statusView = borrowed ? describeReport(report, { now, maxLanes: 0 }) : view
  return {
    key: `${report.runtime}:${report.account ?? ''}`,
    report: drawn,
    raw: report,
    shape,
    view,
    left,
    status: statusOf(report, shape, statusView, now, preference),
    ownUnit: ownUnitOf(shape, drawn, view),
    approxTurns: approxTurnsOf(shape, drawn),
    resets: resetsOf(view),
  }
}

/**
 * Least left first. `out` always leads — a spent account is not "0% left
 * among equals", it is the row you look at first regardless of shape — and a
 * row with nothing measurable (`left.percent === null`) sorts after every
 * measured one, `none` last of all.
 *
 * Equal-ranked rows keep a stable order across refreshes rather than the
 * report list's own incidental order: status severity first (an "out" row
 * before a "low" one at the same percent, then "overage", then the rest),
 * the reset soonest first, then the runtime, then the account label. This
 * module is pure and never reaches for `RuntimeInfo` (its own docstring,
 * above) — the caller's own display name is a presentation choice this
 * layer does not own — so the runtime id stands in for it: still a fixed,
 * deterministic order, which is the property the rule actually needs
 * (review of #1069, N4).
 */
export const sortRows = (rows: readonly PlanRow[]): readonly PlanRow[] =>
  [...rows].sort((a, b) => rankOf(a) - rankOf(b) || tiebreak(a, b))

const rankOf = (row: PlanRow): number => {
  if (row.status === 'out') return -1
  if (row.left.percent !== null) return row.left.percent
  return row.shape === 'none' ? 1_001 : 1_000
}

const SEVERITY_RANK: Readonly<Record<RowStatus, number>> = { out: 0, low: 1, overage: 2, ready: 3, unlimited: 4, notReporting: 5 }

const tiebreak = (a: PlanRow, b: PlanRow): number =>
  SEVERITY_RANK[a.status] - SEVERITY_RANK[b.status] ||
  (a.view.hero?.resetsAt ?? Number.POSITIVE_INFINITY) - (b.view.hero?.resetsAt ?? Number.POSITIVE_INFINITY) ||
  nameOf(a).localeCompare(nameOf(b)) ||
  (a.report.account ?? '').localeCompare(b.report.account ?? '')

const nameOf = (row: PlanRow): string => String(row.report.runtime)

/**
 * A lane's own reset cadence, in the vocabulary a fee's period shares —
 * `'month'` or `'year'` — or null for any other window length (a session, a
 * week), which no fee period could match anyway. Used only to decide whether
 * `feePerUnitOf` may draw a per-unit price at all: a yearly fee has no
 * business being divided by a monthly request limit (review of #1069, B7).
 */
const MONTH_MINUTES = 30 * 24 * 60
const YEAR_MINUTES = 365 * 24 * 60

export const cycleOf = (windowMinutes: number | null | undefined): 'month' | 'year' | null => {
  if (windowMinutes == null) return null
  if (Math.abs(windowMinutes - MONTH_MINUTES) <= 3 * 24 * 60) return 'month'
  if (Math.abs(windowMinutes - YEAR_MINUTES) <= 10 * 24 * 60) return 'year'
  return null
}

/**
 * One person's own spending cap ÷ its limit — the per-turn price a plan's
 * fee implies. Non-null only when the lane's own unit is one a fee can
 * actually be divided across (`requests` or `credits` — never `percent`,
 * `acu` or `usd`, which is dollars divided by dollars) and the fee's own
 * period matches the lane's reset cadence (`cycleOf`), so a yearly fee is
 * never divided by a monthly limit (review of #1069, B7).
 */
export const feePerUnitOf = (
  fee: { readonly amount: number; readonly period: 'month' | 'year' } | null | undefined,
  lane: { readonly unit?: UsageLane['unit']; readonly limit?: number | null; readonly windowMinutes?: number | null } | null | undefined,
): number | null => {
  if (!fee || !lane || lane.limit == null || lane.limit <= 0) return null
  if (lane.unit !== 'requests' && lane.unit !== 'credits') return null
  const cycle = cycleOf(lane.windowMinutes)
  if (cycle !== null && fee.period !== cycle) return null
  return fee.amount / lane.limit
}

export interface MoneyRow {
  /** The window's own spend — list price or the vendor's own metered figure, whichever `report.spend` already carries. Null when unknown, never drawn as $0. */
  readonly value: number | null
  /** Paid for this account over Value's window, null when no fee is set. */
  readonly paid: number | null
  /** Overage outside Value's window, retained beside Paid. */
  readonly overageAside: number | null
  /** Currency of `overageAside`; it may differ from the fee currency. */
  readonly overageAsideCurrency: string | null
  /** Value ÷ Paid, only when both are known in the same currency. */
  readonly ratio: number | null
  /** The plan's own recurring fee, when one is set — never inferred from `spend` or from overage. */
  readonly fee: { readonly amount: number; readonly currency: string; readonly period: 'month' | 'year' } | null
  /** `true` when the fee is a person's own figure ("you set this") rather than the vendor's own report. */
  readonly feeIsUser: boolean
  readonly currency: string
}

/**
 * The shape frame's money row: Paid and Value for the same window, the plan's
 * own fee, and overage outside that window shown separately. A report with
 * neither a fee nor a priced window has nothing to show, so the row is withheld.
 */
export const moneyRowOf = (report: UsageReport, now: number): MoneyRow | null => {
  const fee = report.billing?.fee ?? null
  const value = report.spend?.windowCost ?? null
  if (!fee && value === null) return null
  const { start, end } = periodBounds(report.spend?.windowDays ?? DEFAULT_RANGE, now)
  const paid = paidForAccount(report.billing, start, end, cycleStartFromLanes(report.lanes))
  const currency = report.spend?.currency ?? fee?.currency ?? 'USD'
  return {
    value,
    paid: paid.amount,
    overageAside: paid.overageAside,
    overageAsideCurrency: paid.overageAsideCurrency,
    ratio: fee && report.spend?.currency === fee.currency ? paidRatio(value, paid.amount) : null,
    fee: fee ? { amount: fee.amount, currency: fee.currency, period: fee.period } : null,
    feeIsUser: fee?.source === 'user',
    currency,
  }
}

export const planRows = (
  reports: readonly UsageReport[],
  now: number,
  preferenceFor: (report: UsageReport) => UsagePreference = () => ({}),
): readonly PlanRow[] => sortRows(reports.map((report) => describeRow(report, now, preferenceFor(report))))
