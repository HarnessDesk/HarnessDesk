import type { InsightQuery, InsightSource, Measure } from '@harnessdesk/protocol'

export interface UsageSample {
  readonly key: string
  readonly source: InsightSource
  readonly runtime: string
  readonly sessionId: string | null
  readonly turnId: string | null
  readonly requestId: string | null
  readonly project: string | null
  readonly model: string | null
  readonly from: number | null
  readonly to: number | null
  readonly scope: 'call' | 'session'
  readonly includesChildren: boolean | null
  readonly input: Measure
  readonly output: Measure
  readonly cacheRead: Measure
  readonly cacheWrite: Measure
  readonly usd: Measure
  readonly moneyBasis: 'listPrice' | 'vendorMetered' | 'unknown'
}

export interface UsageDetail {
  readonly samples: readonly UsageSample[]
  readonly sources: readonly InsightSource[]
  readonly gaps: readonly string[]
  readonly complete: boolean
}

/** Optional source detail emitted by scanners; never changes aggregate rows. */
export interface InsightScanOptions {
  readonly emit: (sample: UsageSample) => void
  readonly signal?: AbortSignal
  readonly byteLimit: number
}

/** The fixed source-data ceiling one Insight read may spend, across every source together. */
export const INSIGHT_BYTE_LIMIT = 64 * 1024 * 1024

/** The one sentence a request sees whichever source spent the remaining budget — discovered already too large, or grown large enough to spend what was left while it was being read. */
export const INSIGHT_BYTE_LIMIT_MESSAGE = 'Insight stopped at 64 MiB of source data. Choose a narrower range.'

/**
 * Thrown the instant a scanner would spend more of the remaining
 * `InsightScanOptions.byteLimit` than is left — one more line about to be
 * read, or a whole file found already too large the moment it was opened.
 *
 * Caught beside every other scanner failure and reported with the fixed
 * message above, never the file's real size or path, so a source that grows
 * between discovery and this read is exactly as honest as one that was
 * already large when `listTargets` found it — never a silently complete
 * result that quietly read past what the request promised.
 */
export class InsightBudgetExceededError extends Error {
  constructor() {
    super(INSIGHT_BYTE_LIMIT_MESSAGE)
    this.name = 'InsightBudgetExceededError'
  }
}

export const unknownMeasure = (): Measure => ({ value: null, quality: 'unknown' })
export const exactMeasure = (value: number): Measure => ({ value, quality: 'exact' })
export type { InsightQuery }
