import type { LedgerReport, RuntimeId } from '@harnessdesk/protocol'

/**
 * Arithmetic behind the Overview strip's Value, Turns and Tokens cells.
 *
 * Design: `docs/usage-dashboard.md`, "The Overview strip". Paid's own
 * arithmetic — proration, overage, currency — lives in `lib/paid.ts`; this is
 * everything else: the delta each cell's chip reads, the cache-hit rate on
 * the Tokens figure, and the two captions ("known for N of M agents",
 * "68% input · 32% output") that read off `LedgerReport.totals` and
 * `SpendCoverage.turnsKnownFor`.
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
 * "68% input · 32% output" — the Tokens cell's caption when every agent in
 * scope is turns-known (see `turnsCoverage`, whose "known" list this reuses:
 * the two counts travel together in this ledger, since a scanner that can
 * read a turn boundary is the same one that reads the fuller token split).
 * Reasoning stays folded into output, the same rule `LedgerRow.input`'s doc
 * comment keeps — this is a split of `tokens`, not a third bucket next to it.
 */
export const tokenSplitCaption = (
  totals: { readonly input: number; readonly output: number } | undefined,
): string | null => {
  if (!totals) return null
  const whole = totals.input + totals.output
  if (whole <= 0) return null
  const inputPct = Math.round((totals.input / whole) * 100)
  return `${inputPct}% input · ${100 - inputPct}% output`
}

export interface AgentCoverage {
  readonly known: number
  readonly total: number
  readonly partial: boolean
}

/**
 * "Known for N of M agents" — how many of the distinct runtimes actually in
 * scope are ones `SpendCoverage.turnsKnownFor` names. Reused for the Tokens
 * cell's own partial caption: this ledger has no separate coverage field for
 * "does this agent report the fuller token split", and in practice the two
 * travel together (every scanner that reads a turn boundary reads the same
 * transcript's token split), so the turns list is the one honest source
 * either caption has to point to.
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

/** Value ÷ Paid, rounded to one decimal — `null` when Paid is not known or is zero. */
export const paidRatio = (value: number | null, paid: number | null): number | null => {
  if (value === null || paid === null || paid <= 0) return null
  return value / paid
}

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
