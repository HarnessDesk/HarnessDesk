import type { LedgerReport, RuntimeId } from '@harnessdesk/protocol'

/**
 * Arithmetic behind the Overview strip's Value, Turns and Tokens cells.
 *
 * Design: `docs/usage-dashboard.md`, "The Overview strip". Paid's own
 * arithmetic — proration, overage, currency — lives in `lib/paid.ts`; this is
 * everything else: the delta each cell's chip reads, the cache-hit rate on
 * the Tokens figure, and the captions ("known for N of M agents",
 * "68% input · 32% output · N% cache") that read off `LedgerReport.totals`,
 * `SpendCoverage.turnsKnownFor` and `LedgerReport.rows`.
 *
 * Turns coverage and Tokens coverage are two different questions answered
 * from two different sources, on purpose (they do not "travel together" —
 * see `tokenCoverage`'s own comment): Turns asks `SpendCoverage.turnsKnownFor`,
 * which of the runtimes this window covers has a readable turn boundary at
 * all; Tokens asks the ledger's own rows whether any of them actually
 * carries a null token count.
 */

/** Which day-series the strip's chart toggle is showing. `'value'` plots cost. */
export type StripMetric = 'value' | 'turns' | 'tokens'

/**
 * A signed percentage change, or `null` when there is nothing honest to
 * divide by — the same rule `lib/ledger.ts`'s `periodTotals` keeps for a
 * comparison window that was itself zero.
 */
export const percentChange = (current: number, previous: number): number | null => {
  if (!Number.isFinite(current) || !Number.isFinite(previous) || previous === 0) return null
  return ((current - previous) / previous) * 100
}

/**
 * The share of the *input* side that came from cache, `0..100` —
 * `cacheRead / (input + cacheRead)`, never `cacheRead / tokens`, which would
 * dilute it with output that was never a cache candidate at all (every
 * scanner in `ledger/scan.ts` already excludes the cache from `input`; see
 * `docs/usage-dashboard.md`'s "The five shapes"). `null` when there is no
 * input side to speak of — an all-cache-write window, or one with nothing
 * read yet — rather than a division by zero.
 */
export const cacheHitRate = (
  totals: { readonly input: number; readonly cacheRead: number } | undefined,
): number | null => {
  if (!totals) return null
  const denominator = totals.input + totals.cacheRead
  if (denominator <= 0) return null
  return (totals.cacheRead / denominator) * 100
}

/**
 * "68% input · 27% output · 5% cache" — the Tokens cell's split caption,
 * covering the same `tokens` total the figure shows: `input + output +
 * cacheRead + cacheWrite`. Cache is folded in explicitly — as its own
 * share, not silently absorbed into "input" or left out of the percentages —
 * because `tokens` already includes it (`LedgerRow.tokens`'s own doc
 * comment): a caption that only splits input and output describes a smaller
 * number than the one beside it. Reasoning stays folded into output, the
 * same rule keeps.
 */
export const tokenSplitCaption = (
  totals:
    | { readonly input: number; readonly output: number; readonly cacheRead?: number; readonly cacheWrite?: number }
    | undefined,
): string | null => {
  if (!totals) return null
  const cache = (totals.cacheRead ?? 0) + (totals.cacheWrite ?? 0)
  const whole = totals.input + totals.output + cache
  if (whole <= 0) return null
  const inputPct = Math.round((totals.input / whole) * 100)
  const outputPct = Math.round((totals.output / whole) * 100)
  const cachePct = 100 - inputPct - outputPct
  return cache > 0
    ? `${inputPct}% input · ${outputPct}% output · ${cachePct}% cache`
    : `${inputPct}% input · ${100 - inputPct}% output`
}

export interface AgentCoverage {
  readonly known: number
  readonly total: number
  readonly partial: boolean
}

/**
 * Every distinct runtime the ledger actually has a row for — the Turns
 * denominator, and the pool `tokenCoverage` groups by. Not `reports.map(r =>
 * r.runtime)`: an account in scope with no rows in this window is a runtime
 * this window says nothing about, not a runtime it can call known or
 * unknown either way. A folded/project row with no single runtime
 * attribution (`LedgerRow.runtime === null`) names none and is skipped.
 */
export const ledgerRuntimeIds = (ledger: LedgerReport | null | undefined): readonly RuntimeId[] => {
  if (!ledger) return []
  const seen = new Set<RuntimeId>()
  for (const row of ledger.rows) if (row.runtime !== null) seen.add(row.runtime)
  return [...seen]
}

/**
 * "Known for N of M agents" — how many of the distinct runtimes actually in
 * scope are ones `SpendCoverage.turnsKnownFor` names. `runtimes` should be
 * `ledgerRuntimeIds(ledger)` — the runtimes this window has rows for — not
 * every account in scope, so an account with nothing recorded this window
 * is neither known nor unknown; it just is not counted.
 */
export const agentCoverage = (
  coverage: LedgerReport['coverage'] | null | undefined,
  runtimes: readonly RuntimeId[],
): AgentCoverage => {
  const distinct = [...new Set(runtimes)]
  const knownSet = new Set(coverage?.turnsKnownFor ?? [])
  const known = distinct.filter((runtime) => knownSet.has(runtime)).length
  return { known, total: distinct.length, partial: distinct.length > 0 && known < distinct.length }
}

/**
 * The Tokens cell's own coverage — deliberately not `agentCoverage` again.
 * Every scanner reports *some* token figure for every row it writes, but not
 * always a real one: a runtime can log a call with `tokens: null` when it
 * has no readable count for it (`LedgerRow.tokens`), and that is a fact
 * `SpendCoverage.turnsKnownFor` — a *turn*-boundary signal — cannot answer.
 * A runtime counts as tokens-known here only when *none* of its rows in this
 * window carries a null token count; one null row is enough to call the
 * whole runtime unknown for tokens, the same "any gap taints it" rule
 * `LedgerRow.turns` keeps for a row that mixes a turn-known runtime with one
 * that is not.
 */
export const tokenCoverage = (ledger: LedgerReport | null | undefined): AgentCoverage => {
  if (!ledger) return { known: 0, total: 0, partial: false }
  const hasNullRow = new Map<RuntimeId, boolean>()
  for (const row of ledger.rows) {
    if (row.runtime === null) continue
    hasNullRow.set(row.runtime, (hasNullRow.get(row.runtime) ?? false) || row.tokens === null)
  }
  const total = hasNullRow.size
  const known = [...hasNullRow.values()].filter((tainted) => !tainted).length
  return { known, total, partial: total > 0 && known < total }
}

/**
 * Whether Value's ratio against Paid ("{ratio}× paid") and Turns' price
 * against Paid ("{amount} paid a turn") mean what they claim: both divide a
 * figure covering *every* account and runtime in scope by one covering only
 * the accounts with a fee set, in one currency. Dividing anyway when scope
 * does not match inflates the ratio with fee-less accounts' Value and
 * understates the per-turn price the same way — the fix is never showing
 * either at all until every account in scope has a fee, in the same
 * currency the ledger itself is in.
 */
export const paidScopeMatchesLedger = (
  paid: { readonly missingFeeCount: number; readonly otherCurrencies: boolean; readonly currency: string | null },
  ledgerCurrency: string | null | undefined,
): boolean =>
  paid.missingFeeCount === 0 &&
  !paid.otherCurrencies &&
  paid.currency !== null &&
  ledgerCurrency !== null &&
  ledgerCurrency !== undefined &&
  paid.currency === ledgerCurrency

/** Value ÷ Paid, rounded to one decimal — `null` when Paid is not known or is zero. */
export const paidRatio = (value: number | null, paid: number | null): number | null => {
  if (value === null || paid === null || paid <= 0) return null
  return value / paid
}

/** The shared label for Value divided by Paid in the Overview and Plans rows. */
export const paidRatioCaption = (ratio: number): string => `${ratio >= 10 ? Math.round(ratio) : ratio.toFixed(1)}× paid`

/** Value's own window average, for the "a day" caption when Paid is not known. */
export const perDay = (value: number | null, days: number): number | null => {
  if (value === null || days <= 0) return null
  return value / days
}

/** Paid ÷ turns — "$x paid a turn" — `null` unless both sides are real. */
export const paidPerTurn = (paid: number | null, turns: number | null | undefined): number | null => {
  if (paid === null || turns === null || turns === undefined || turns <= 0) return null
  return paid / turns
}
