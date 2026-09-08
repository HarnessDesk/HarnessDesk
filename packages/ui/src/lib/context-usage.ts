import type { ContextBreakdown, SessionCost, SessionUsage, TokenUsage } from '@harnessdesk/protocol'

import type { Tone } from './limits'

/**
 * What a session's token usage means to the person about to send the next
 * message: how full the context is, what the last turn cost, what the
 * session has spent. Read off `SessionUsage` and nothing else — the runtime
 * did the arithmetic that depends on which runtime it is, and this module
 * only divides and formats.
 */

export interface ContextFill {
  readonly used: number
  readonly size: number
  /** 0–1, capped at 1 — a runtime can report more than the window. */
  readonly ratio: number
  /** 0–100, rounded. */
  readonly percent: number
  readonly tone: Tone
}

export interface ContextView {
  /** Null when the runtime did not say how big the window is. */
  readonly fill: ContextFill | null
  /** The tooltip on the ring: the one line that says where things stand. */
  readonly title: string
  /** The last turn's tokens, when it had any. */
  readonly last: TokenUsage | null
  /** The session's tokens, when it had any. */
  readonly total: TokenUsage | null
  readonly cost: SessionCost | null
  /**
   * Of `total`, what agents this session delegated to spent.
   *
   * A share, never an addition — see `SessionUsage.delegated`. Null for the
   * runtimes that cannot attribute it, which is most of them.
   */
  readonly delegated: TokenUsage | null
  /** What the context is made of, for the agents that report it. */
  readonly composition: ContextComposition | null
}

/** One row of the composition: a segment and its share of the segments. */
export interface ContextSegmentView {
  readonly id: string
  readonly label: string
  readonly tokens: number
  readonly count: number | null
  /** 0–100 of the *measured* segments, never of the window. See below. */
  readonly percent: number
}

export interface ContextComposition {
  readonly segments: readonly ContextSegmentView[]
  /** The segments' own sum — what was measured, not what is in the window. */
  readonly measured: number
  readonly approximate: boolean
  readonly source: string
}

/** Warn when the window is mostly spent; alarm when compaction is imminent. */
export const WARN_AT = 0.7
export const ALARM_AT = 0.9

/** 171K, 1.2M, 940 — the density the composer's toolbar can afford. */
export const formatTokens = (count: number): string => {
  // Billions are ordinary in a month of agent work, so the scale runs past M.
  if (count >= 1_000_000_000) return `${trim(count / 1_000_000_000)}B`
  if (count >= 1_000_000) return `${trim(count / 1_000_000)}M`
  if (count >= 1000) return `${trim(count / 1000)}K`
  return String(Math.round(count))
}

/**
 * A token count, softened to "at least" where the runtime said it is a floor.
 *
 * `outputExact: false` means the output half was still a streaming
 * placeholder when it was last counted — see `TokenUsage.outputExact`. A
 * count that cannot be rounded away has to look like one, or a sub-agent that
 * wrote a thousand lines reads as having produced a single token.
 */
export const formatTokensWithFloor = (usage: {
  readonly totalTokens: number
  readonly outputExact?: boolean
}): string => `${usage.outputExact === false ? '≥' : ''}${formatTokens(usage.totalTokens)}`

const trim = (value: number): string => {
  const one = value.toFixed(1)
  return one.endsWith('.0') ? one.slice(0, -2) : one
}

export const formatCost = (cost: SessionCost): string => {
  try {
    return new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency: cost.currency,
      maximumFractionDigits: cost.amount < 1 ? 3 : 2,
    }).format(cost.amount)
  } catch {
    return `${cost.amount.toFixed(2)} ${cost.currency}`
  }
}

const hasTokens = (usage: TokenUsage | null | undefined): boolean =>
  usage !== null && usage !== undefined && (usage.totalTokens > 0 || usage.inputTokens > 0 || usage.outputTokens > 0)

const toneFor = (ratio: number): Tone => (ratio >= ALARM_AT ? 'bad' : ratio >= WARN_AT ? 'warn' : 'good')

/**
 * The composition as rows, with each segment's share **of the segments**.
 *
 * Not of the window, and this is the whole care of this function. An
 * approximate breakdown is priced by the agent's estimator while `contextUsed`
 * is anchored to what the provider charged, so the two are different
 * measurements and dividing one by the other produces a percentage that means
 * nothing. Sharing the segments against each other is a question the numbers
 * can actually answer: "most of this is tool schemas" is true whichever
 * estimator priced them.
 *
 * The corollary is that no "free space" row is ever synthesised here. That row
 * would be `window − segments`, which mixes the two units and would be the
 * one number on the panel nobody measured.
 */
const compositionOf = (breakdown: ContextBreakdown | null | undefined): ContextComposition | null => {
  if (!breakdown || breakdown.segments.length === 0) return null
  const measured = breakdown.segments.reduce((sum, segment) => sum + segment.tokens, 0)
  if (measured <= 0) return null
  return {
    segments: breakdown.segments.map((segment) => ({
      id: segment.id,
      label: segment.label,
      tokens: segment.tokens,
      count: segment.count ?? null,
      percent: Math.round((segment.tokens / measured) * 100),
    })),
    measured,
    approximate: breakdown.approximate,
    source: breakdown.source,
  }
}

/**
 * Nothing to say until the runtime has said something: a session without
 * usage gets no ring rather than an empty one.
 */
export const describeContext = (usage: SessionUsage | null | undefined, agentName: string): ContextView | null => {
  if (!usage) return null
  const total = hasTokens(usage.total) ? usage.total : null
  const last = hasTokens(usage.last) ? usage.last : null
  const cost = usage.cost ?? null

  const size = usage.contextWindow ?? null
  const used = usage.contextUsed ?? null
  const fill: ContextFill | null =
    size !== null && size > 0 && used !== null
      ? (() => {
          const ratio = Math.min(1, Math.max(0, used / size))
          return { used, size, ratio, percent: Math.round(ratio * 100), tone: toneFor(ratio) }
        })()
      : null

  const composition = compositionOf(usage.breakdown)

  if (!fill && !total && !last && !composition) return null

  const title = fill
    ? `Context window ${fill.percent}% full — ${formatTokens(fill.used)} of ${formatTokens(fill.size)} tokens`
    : total
      ? `${formatTokens(total.totalTokens)} tokens this session — ${agentName} does not report its context window`
      : `${agentName} does not report its context window`

  const delegated = hasTokens(usage.delegated) ? (usage.delegated ?? null) : null

  return { fill, title, last, total, cost, delegated, composition }
}
