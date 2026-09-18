import type { RuntimeId } from './ids.js'

/**
 * What every plan has left, and what it cost.
 *
 * Design: `docs/usage-dashboard.md`. Four facts travel here and they must never
 * be collapsed into one another: the plan's rolling `lanes`, a prepaid
 * `credits` balance, the `reached` signal (the only one that means turns will
 * fail), and `spend`. A plan user who never bought credits has no balance and
 * is perfectly able to work.
 *
 * `RateLimits` on the session stays what it is — one runtime answering for
 * itself, live. This is the wider surface: several sources, several accounts,
 * money, and the freshness of each.
 */

/** One rolling allowance, as some source reported it. */
export interface UsageLane {
  /**
   * Stable across refreshes so a client can follow one lane over time:
   * `session`, `weekly`, `weekly:fable`. Not a display string.
   */
  readonly id: string
  /** The source's own wording for the window. Never invented here. */
  readonly label: string
  /**
   * Raw, and deliberately not clamped: an over-quota figure carries meaning
   * for pace. Clamp at the point of drawing, not here.
   */
  readonly usedPercent: number
  readonly windowMinutes: number | null
  /** Epoch milliseconds. */
  readonly resetsAt: number | null
  /** Some sources give words rather than a date ("tomorrow, 12:28 PM"). */
  readonly resetText?: string | null
  /** What this lane limits, when it is narrower than the plan: a model family, a surface. */
  readonly scope?: string | null
  /** The source's own severity, when it has an opinion. Overrides the one derived from what is left. */
  readonly severity?: 'normal' | 'warning' | 'critical' | null
  /**
   * False when the source gave reset metadata but no usage figure.
   *
   * Absent this flag a client draws 0% used, which reads as "plenty" — the
   * opposite of "we do not know". Defaults to true, so a source that says
   * nothing about it is taken at its word.
   */
  readonly usageKnown?: boolean
  /**
   * True when this lane was synthesized to stand in for one the source did not
   * actually report — a zeroed session window for an account with no live
   * session. A real lane freshly reset to zero is not a placeholder.
   */
  readonly placeholder?: boolean
}

/** A prepaid balance. Separate from lanes: it does not refill on a clock. */
export interface UsageCredits {
  readonly remaining: number | null
  /**
   * How much of the same budget is already gone, when the source says.
   *
   * A balance answers "can I keep going"; this answers "what has this cost me
   * so far", which for an account with no local transcripts to price is the
   * only place that question gets an answer at all.
   */
  readonly used?: number | null
  /** "USD", or a vendor's own unit ("credits"). */
  readonly unit: string
  readonly unlimited?: boolean
}

/** How a cost figure was produced. Display-time accounting, never a bill. */
export type SpendProvenance =
  /** Token counts priced at public API rates. */
  | 'listPrice'
  /** The vendor reported the spend itself. */
  | 'vendorMetered'
  /** The window mixes both. */
  | 'mixed'
  | 'unknown'

/**
 * How much of a window we can actually account for.
 *
 * Kept as independent counts so a missing category reads as zero rather than
 * silently folding into another. An unpriced model is unpriced — never $0.
 */
export interface SpendCoverage {
  readonly priced: number
  readonly unpriced: number
  readonly unmetered: number
  readonly estimated: number
  /** Days in the requested window that the scan actually covered. */
  readonly daysCovered: number
  readonly daysRequested: number
}

export interface SpendSummary {
  readonly currency: string
  readonly todayCost: number | null
  readonly windowCost: number | null
  readonly windowDays: number
  readonly todayTokens: number | null
  readonly windowTokens: number | null
  readonly provenance: SpendProvenance
  readonly coverage: SpendCoverage | null
  /** Daily totals for the window, oldest first, for a sparkline. */
  readonly daily?: readonly SpendDay[]
}

export interface SpendDay {
  /** Local midnight of the bucket, epoch milliseconds, in the pinned zone. */
  readonly day: number
  readonly cost: number | null
  readonly tokens: number | null
}

/** Where a report came from, in words a person can act on. */
export interface UsageSource {
  readonly kind: 'runtime' | 'file' | 'api' | 'ledger'
  /** "from its own cache", "from its API" — shown in the card footer. */
  readonly label: string
}

export interface UsageError {
  readonly message: string
  /** True when signing in would fix it, so the card can offer that instead of a retry. */
  readonly needsSignIn?: boolean
}

/**
 * One account's standing with one agent.
 *
 * An agent with two signed-in accounts produces two reports; the interface
 * shows two cards rather than merging figures that belong to different plans.
 */
export interface UsageReport {
  readonly runtime: RuntimeId
  /** Which account this is, when the agent has more than one. */
  readonly account: string | null
  readonly plan: string | null
  readonly lanes: readonly UsageLane[]
  readonly credits: UsageCredits | null
  readonly spend: SpendSummary | null
  /** Set when a limit has actually been hit, naming which. */
  readonly reached: string | null
  readonly source: UsageSource
  readonly fetchedAt: number
  readonly staleAfterMs: number
  /** Stays on this report; one failing source never blanks the others. */
  readonly error: UsageError | null
}

/** How the ledger should slice its history. */
export interface LedgerQuery {
  readonly days: number
  /** One agent, or every agent when absent. */
  readonly runtime?: RuntimeId
  readonly groupBy: 'runtime' | 'model' | 'project'
}

export interface LedgerRow {
  /** Stable key for the group: a runtime id, a model id, a project path. */
  readonly key: string
  readonly label: string
  /** Which agent this row belongs to, for a model or project row. */
  readonly runtime: RuntimeId | null
  readonly tokens: number | null
  readonly cost: number | null
  /** True when the group contains models we have no price for. */
  readonly hasUnpriced: boolean
}

/** One agent's contribution to one day, for the stacked chart. */
export interface LedgerDay {
  readonly day: number
  readonly runtime: RuntimeId
  readonly cost: number
  readonly tokens: number
}

export interface LedgerReport {
  readonly days: number
  readonly currency: string
  readonly totalCost: number | null
  readonly totalTokens: number | null
  readonly provenance: SpendProvenance
  readonly coverage: SpendCoverage
  readonly rows: readonly LedgerRow[]
  readonly daily: readonly LedgerDay[]
  /** When the scan behind these figures last completed. */
  readonly scannedAt: number | null
}

/** Progress of a ledger scan, so a three-gigabyte corpus is not a silent wait. */
export interface ScanProgress {
  readonly running: boolean
  readonly filesDone: number
  readonly filesTotal: number
  readonly bytesDone: number
  readonly bytesTotal: number
  readonly startedAt: number | null
  readonly finishedAt: number | null
  readonly error: string | null
}

// ---------------------------------------------------- whether an account can work

/*
 * The one rule for whether an account can take a turn, shared by every reader
 * of a report. It was the renderer's alone, which was right while only the
 * renderer asked; the host now asks it too, before it seats an Agent, and two
 * copies of this rule are two answers to "is this account spent" that will
 * disagree the first time one of them learns about a scoped lane. So it lives
 * here, beside the report it reads, and `lib/usage.ts` re-exports it.
 */

/** The account-local choice that changes which usage lane leads a summary. */
export interface UsagePreference {
  readonly pinLaneId?: string
}

const clamp = (value: number, low: number, high: number): number =>
  value < low ? low : value > high ? high : value

/** Whether the source reported a usage figure for this lane — see `UsageLane.usageKnown`. */
export const isLaneKnown = (lane: UsageLane): boolean => lane.usageKnown !== false

/** What a lane has left, or null when the source never said. */
export const remainingOf = (lane: UsageLane): number | null =>
  isLaneKnown(lane) ? 100 - clamp(lane.usedPercent, 0, 100) : null

/**
 * The binding lane: the least left wins, and ties keep the source's own order.
 *
 * A lane whose usage the source never reported can only be the headline when
 * nothing measurable exists, because "unknown" is not evidence of trouble.
 * Placeholders — lanes synthesized to stand in for one that was not reported —
 * are never candidates at all.
 *
 * **A lane scoped to one model is not the account's headline.** Claude Code
 * reports a weekly limit for the account and a second one for Fable alone;
 * with Fable spent and the account at 21%, "0% left" is false about the
 * account and true only about a model you can stop using. The account-wide
 * lanes decide the headline, and a scoped lane is considered only when there
 * is nothing else to go on. It still appears in the list, still turns red,
 * and still says when it comes back.
 */
export const bindingLane = (
  lanes: readonly UsageLane[],
  preference: UsagePreference = {},
): UsageLane | null => {
  const real = lanes.filter((lane) => lane.placeholder !== true)
  if (real.length === 0) return null
  const wide = real.filter((lane) => !lane.scope)
  const candidates = wide.length > 0 ? wide : real
  // A spent account-wide limit is a hard block. It wins over a shorter live
  // window and over a pin because the shorter window cannot bypass it. When
  // several are spent, the longest one is the most useful explanation of the
  // hold; ties keep the provider's order.
  const spent = candidates.filter((lane) => {
    const remaining = remainingOf(lane)
    return remaining !== null && remaining <= 0
  })
  if (spent.length > 0) {
    return spent.reduce((best, lane) => {
      const bestMinutes = best.windowMinutes ?? -1
      const laneMinutes = lane.windowMinutes ?? -1
      return laneMinutes > bestMinutes ? lane : best
    })
  }

  const pinned = preference.pinLaneId
    ? candidates.find((lane) => lane.id === preference.pinLaneId && isLaneKnown(lane))
    : undefined
  if (pinned) return pinned

  const measurable = candidates.filter((lane) => remainingOf(lane) !== null)
  const ranked = measurable.length > 0 ? measurable : candidates
  return ranked.reduce((best, lane) => {
    const bestMinutes = best.windowMinutes ?? Number.POSITIVE_INFINITY
    const laneMinutes = lane.windowMinutes ?? Number.POSITIVE_INFINITY
    return laneMinutes < bestMinutes ? lane : best
  }, ranked[0] as UsageLane)
}

/**
 * The lane a report's `reached` names, when it names one we can find.
 *
 * A source reports the id of the limit it hit, and that limit may be scoped to
 * a single model. Resolving it is how every surface avoids saying "out of
 * quota" about an account that has plenty left on every other model.
 */
export const reachedLaneOf = (report: UsageReport): UsageLane | null =>
  report.reached === null ? null : (report.lanes.find((lane) => lane.id === report.reached) ?? null)

/**
 * Whether this account cannot be worked with at all.
 *
 * True when the lane that decides — the account-wide binding lane — is spent,
 * or when the limit the source says it hit is an account-wide one. A spent
 * model-scoped lane is deliberately *not* blocking: switch models and the
 * work continues.
 *
 * The one shape where a scoped lane can block is an account that reports no
 * account-wide lane at all, because `bindingLane` then has only scoped ones to
 * choose from and the least left of those is the whole of what we know. No
 * source we read has that shape — Codex, Claude Code and Cursor all report an
 * account-wide window — so it is a contract on the reading rather than a case
 * in the wild; the renderer's `describeReport` pins it, so a source that
 * arrives with only scoped lanes fails a test rather than quietly blocking an
 * account.
 */
export const isBlocked = (report: UsageReport): boolean => {
  const reached = reachedLaneOf(report)
  if (reached && !reached.scope) return true
  // A `reached` we cannot resolve is trusted as the source meant it.
  if (report.reached !== null && reached === null) return true
  const lane = bindingLane(report.lanes)
  const remaining = lane ? remainingOf(lane) : null
  return remaining !== null && remaining <= 0
}
