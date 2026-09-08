import type { TokenUsage } from '@harnessdesk/protocol'

import { formatTokens } from './context-usage'

/**
 * Whether the prompt cache was warm, and what that was worth.
 *
 * A cached input token is billed at a fraction of an ordinary one; a token
 * written *into* cache is billed above one. Between a warm turn and a cold
 * turn of the same size there is a real bill, which is why Claude Code
 * 2.1.251 made per-session cache health a first-class `/cost` reading — hit
 * ratio, misses, re-cached tokens, warm or cold.
 *
 * This desk showed a "% cached" chip long before that, computed as hits over
 * input. That number cannot be read as cache health, because it has no
 * knowledge of misses:
 *
 * | | reads | writes | shown | actually |
 * | --- | --- | --- | --- | --- |
 * | small first turn | 0 | 2K | `0% cached` | fine — nothing to cache yet |
 * | cold restart | 0 | 180K | `0% cached` | 180K re-cached at a premium |
 *
 * Two very different bills, one chip. So the rule here is that **the absence
 * of a write count is a state of its own**. A runtime that reports only hits
 * gets `unknown` and a chip that says what it knows; a runtime that reports
 * both gets a verdict. Nothing is inferred from a missing field, and no
 * missing field becomes a zero.
 */

export type CacheState =
  /** Reads dominate the cacheable input: the turn rode a warm cache. */
  | 'warm'
  /** Writes dominate: the cache was cold, and this turn paid to fill it. */
  | 'cold'
  /** Both are substantial — a growing conversation, or a partial invalidation. */
  | 'partial'
  /** The runtime reports hits but not misses. A ratio, not a verdict. */
  | 'unknown'

export interface CacheHealth {
  readonly state: CacheState
  /** Tokens served from cache. */
  readonly read: number
  /** Tokens written into cache. Null when the runtime does not report them. */
  readonly written: number | null
  /**
   * Hits over the cacheable input — reads plus writes — as 0–100.
   *
   * The denominator is deliberately *not* `inputTokens`: uncached input that
   * was never a cache candidate is not a miss, and counting it as one makes
   * every turn look colder than it was. Null when writes are unknown, because
   * the honest denominator is then unknown too.
   */
  readonly hitPercent: number | null
  /** The chip's own words. Short enough for the turn tail. */
  readonly label: string
  /** The line under the pointer: the counts, and what they mean. */
  readonly title: string
}

/**
 * Warm above this share of the cacheable input; cold below the other.
 *
 * Set where the bill turns rather than at a tidy half: a turn that re-reads
 * most of its context is warm in the way that matters, and a turn writing
 * more than a third of its cacheable input is paying enough for someone to
 * want to know.
 */
const WARM_AT = 0.9
const COLD_AT = 0.4

/**
 * Cache health for one turn's usage, or null when there is nothing to say.
 *
 * Null — not a zeroed reading — when the turn had no input at all. A chip is
 * a claim, and a turn that never called a model has no claim to make.
 */
export const cacheHealthOf = (usage: TokenUsage | null | undefined): CacheHealth | null => {
  if (!usage || usage.inputTokens <= 0) return null
  const read = Math.max(0, usage.cachedInputTokens)
  const written = typeof usage.cacheWriteTokens === 'number' ? Math.max(0, usage.cacheWriteTokens) : null

  if (written === null) {
    // What this runtime *can* say: a share of the whole input, named as such.
    // Not called a hit rate, because without the misses it is not one.
    if (read === 0) return null
    const share = Math.round((read / usage.inputTokens) * 100)
    return {
      state: 'unknown',
      read,
      written: null,
      hitPercent: null,
      label: `${share}% cached`,
      title: [
        `${formatTokens(read)} of ${formatTokens(usage.inputTokens)} input tokens came from cache.`,
        'This agent does not report how much was written into cache, so whether the cache was warm or cold cannot be said from here.',
      ].join('\n'),
    }
  }

  const cacheable = read + written
  if (cacheable === 0) return null
  const ratio = read / cacheable
  const state: CacheState = ratio >= WARM_AT ? 'warm' : ratio <= COLD_AT ? 'cold' : 'partial'
  const hitPercent = Math.round(ratio * 100)
  return {
    state,
    read,
    written,
    hitPercent,
    label: state === 'cold' ? 'cold cache' : `${hitPercent}% cached`,
    title: [
      `${formatTokens(read)} read from cache, ${formatTokens(written)} written to it.`,
      state === 'warm'
        ? 'The cache was warm: almost all of the cacheable input was already there.'
        : state === 'cold'
          ? 'The cache was cold. Written tokens are billed above ordinary input, so this turn paid to fill it.'
          : 'Part of the context was already cached and part had to be written — an ordinary growing conversation, or a partial invalidation.',
    ].join('\n'),
  }
}
