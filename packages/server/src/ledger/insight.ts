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

export const unknownMeasure = (): Measure => ({ value: null, quality: 'unknown' })
export const exactMeasure = (value: number): Measure => ({ value, quality: 'exact' })
export type { InsightQuery }
