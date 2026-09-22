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
  /** Runtime that owns this source when it is known; absent records stay unscoped for compatibility. */
  readonly runtime?: string
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
  /** Optional Dashboard account scope; omitted means all recorded runtimes. */
  readonly runtime?: string
}

import type { AgentOrigin } from './agent.js'
import type { SessionPointer, SeatRecord } from './evidence.js'
import type { FlowSeat } from './flow.js'
import type { Goal } from './goal.js'
import type { LibraryReach } from './library.js'
import type { SessionUsage } from './session.js'

export interface MessageCharge {
  readonly goal: string
  readonly entry: string
  readonly sender: SessionPointer
  readonly receiver: SessionPointer
}

export interface LoadedExposure {
  readonly kind: 'skill' | 'mcp'
  readonly name: string
  readonly reach: LibraryReach['state']
  readonly basis: LibraryReach['basis']
  readonly catalogueTokens: number | null
  readonly observedAt: number
  readonly sourceId: string
}

export interface TurnInsightContext {
  readonly turn: string
  readonly startedAt: number | null
  readonly endedAt: number | null
  readonly seat: string | null
  readonly cause: { readonly kind: 'person' }
    | { readonly kind: 'message'; readonly message: MessageCharge }
    | { readonly kind: 'unknown' }
  readonly parent: { readonly session: SessionPointer; readonly turn: string | null } | null
  readonly loaded: readonly LoadedExposure[] | null
  readonly before: SessionUsage | null
  readonly after: SessionUsage | null
  readonly generation: string
  readonly observedAt: number
}

/** The historical partitions currently derived from the recorded usage corpus. */
export const INSIGHT_DIMENSIONS = ['seat', 'goal', 'agent'] as const

export type InsightDimension = (typeof INSIGHT_DIMENSIONS)[number]

export interface InsightRow {
  readonly key: string
  readonly label: string
  readonly amounts: InsightAmounts
  readonly seat: string | null
  readonly goal: string | null
  readonly session: SessionPointer | null
  readonly message: MessageCharge | null
  readonly note: string | null
  readonly elapsedMs: InsightMetric
}

export interface InsightBreakdown {
  readonly dimension: InsightDimension
  readonly rows: readonly InsightRow[]
  readonly unattributed: InsightAmounts
  readonly reason: string | null
}

export interface InsightReport {
  readonly id: string
  readonly generatedAt: number
  readonly query: { readonly root: string | null; readonly from: number; readonly to: number }
  readonly goals: readonly Goal[]
  readonly seats: readonly SeatRecord[]
  readonly goal: string | null
  readonly receipt: string | null
  readonly totals: InsightAmounts
  readonly elapsedMs: InsightMetric
  readonly breakdowns: readonly InsightBreakdown[]
  readonly sources: readonly InsightSource[]
  readonly recordedSpend: readonly { readonly evidence: string; readonly usd: InsightMetric; readonly turns: InsightMetric }[]
  readonly provenance: { readonly state: 'available' | 'unavailable' | 'degraded'; readonly note: string }
  readonly gaps: readonly string[]
}

export interface InsightSelector {
  readonly agent: string
  readonly origin: AgentOrigin
  readonly briefDigest: string | null
  readonly seat: FlowSeat | null
}

export interface InsightCompareQuery extends InsightQuery {
  readonly goals: readonly string[]
  readonly left: InsightSelector
  readonly right: InsightSelector
}

export interface InsightComparison {
  readonly query: InsightCompareQuery
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

export interface InsightOrderQuery extends InsightCompareQuery {
  readonly agent: string
  readonly origin: AgentOrigin
  /** The Agent's effective default when this machine has not overridden it. */
  readonly current?: readonly FlowSeat[]
}

export interface InsightOrderPreview {
  readonly stamp: string | null
  readonly expiresAt: number | null
  readonly current: readonly FlowSeat[]
  readonly proposed: readonly FlowSeat[]
  readonly labels: readonly string[]
  readonly report: InsightComparison
  readonly reason: string | null
}
