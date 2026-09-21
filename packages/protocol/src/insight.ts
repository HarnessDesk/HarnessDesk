/**
 * Source-qualified observations used by the read-only Insight surfaces.
 * Values deliberately distinguish an observed zero from an unavailable value.
 */
export interface Measure {
  readonly value: number | null
  readonly quality: 'exact' | 'floor' | 'estimate' | 'unknown'
}

export interface InsightSource {
  readonly id: string
  readonly kind: 'corpus' | 'transcript' | 'evidence' | 'receipt' | 'library' | 'provenance'
  readonly label: string
  readonly observedAt: number | null
  readonly checkedAt: number
  readonly stale: boolean
  readonly problem: string | null
}

export interface InsightMetric extends Measure {
  readonly unit: 'usd' | 'tokens' | 'milliseconds' | 'count' | 'ratio'
  readonly basis: 'listPrice' | 'vendorMetered' | 'mixed' | 'observed' | 'catalogue' | 'unknown'
  readonly sourceIds: readonly string[]
  readonly coverage: 'complete' | 'partial' | 'none'
  readonly missing: readonly string[]
}

export interface InsightAmounts {
  readonly usd: InsightMetric
  readonly tokens: InsightMetric
  readonly activeMs: InsightMetric
  readonly turns: InsightMetric
}

export interface InsightQuery {
  readonly root: string
  readonly from: number
  readonly to: number
}

export type InsightDimension = 'goal' | 'agent' | 'seat' | 'message' | 'delegation' | 'loaded'

export interface InsightComparison {
  readonly included: readonly string[]
  readonly excluded: readonly { readonly goal: string; readonly reason: string }[]
  readonly left: InsightAmounts
  readonly right: InsightAmounts
  readonly leftPerGoalUsd: InsightMetric
  readonly rightPerGoalUsd: InsightMetric
  readonly differenceUsd: InsightMetric
  readonly ratio: InsightMetric
  readonly sources: readonly InsightSource[]
  readonly generatedAt: number
  readonly reason: string | null
}
