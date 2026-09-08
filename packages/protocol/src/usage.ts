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
