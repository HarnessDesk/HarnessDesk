import { describe, expect, it } from 'vitest'

import type { TokenUsage } from '@harnessdesk/protocol'

import { cacheHealthOf } from './cache-health'

/**
 * The point of this module is a distinction, so the tests are about the
 * distinction: a runtime that reports cache misses gets a verdict, and one
 * that reports only hits must not be given one.
 */

const tokens = (over: Partial<TokenUsage>): TokenUsage => ({
  totalTokens: 0,
  inputTokens: 0,
  cachedInputTokens: 0,
  outputTokens: 0,
  reasoningOutputTokens: 0,
  ...over,
})

describe('cacheHealthOf', () => {
  it('says nothing at all when the runtime does not report misses', () => {
    // Today's shape for every agent that has not been taught to report
    // writes. This case is the whole reason the module exists: a confident
    // "warm" here would be invented, and a zero would be a lie.
    const health = cacheHealthOf(tokens({ inputTokens: 100_000, cachedInputTokens: 90_000 }))
    expect(health?.state).toBe('unknown')
    expect(health?.written).toBeNull()
    expect(health?.hitPercent).toBeNull()
    expect(health?.label).toBe('90% cached')
    expect(health?.title).toContain('does not report')
  })

  it('reads a cold start as cold rather than as nothing to report', () => {
    // The bug this replaces: 0 hits over 180K input rendered "0% cached",
    // the same chip a turn with a tiny prompt gets — while this one paid a
    // premium on every one of those tokens.
    const health = cacheHealthOf(
      tokens({ inputTokens: 180_000, cachedInputTokens: 0, cacheWriteTokens: 180_000 }),
    )
    expect(health?.state).toBe('cold')
    expect(health?.label).toBe('cold cache')
    expect(health?.hitPercent).toBe(0)
    expect(health?.title).toContain('billed above ordinary input')
  })

  it('reads a warm turn as warm', () => {
    const health = cacheHealthOf(
      tokens({ inputTokens: 100_000, cachedInputTokens: 98_000, cacheWriteTokens: 2_000 }),
    )
    expect(health?.state).toBe('warm')
    expect(health?.label).toBe('98% cached')
  })

  it('reads a growing conversation as partial', () => {
    const health = cacheHealthOf(
      tokens({ inputTokens: 100_000, cachedInputTokens: 70_000, cacheWriteTokens: 30_000 }),
    )
    expect(health?.state).toBe('partial')
    expect(health?.hitPercent).toBe(70)
  })

  it('divides by the cacheable input, not by the whole input', () => {
    // 40K of this input was never a cache candidate. Counting it as a miss
    // would make an entirely warm turn read as barely half cached.
    const health = cacheHealthOf(
      tokens({ inputTokens: 100_000, cachedInputTokens: 58_000, cacheWriteTokens: 2_000 }),
    )
    expect(health?.hitPercent).toBe(97)
    expect(health?.state).toBe('warm')
  })

  it('has no claim to make about a turn that never called a model', () => {
    expect(cacheHealthOf(null)).toBeNull()
    expect(cacheHealthOf(undefined)).toBeNull()
    expect(cacheHealthOf(tokens({ inputTokens: 0, cacheWriteTokens: 0 }))).toBeNull()
    // Reports both halves, and both are zero: nothing was cacheable.
    expect(cacheHealthOf(tokens({ inputTokens: 900, cachedInputTokens: 0, cacheWriteTokens: 0 }))).toBeNull()
    // Reports only hits, and there were none: a ratio of zero is not a fact
    // worth a chip when the misses are unknown.
    expect(cacheHealthOf(tokens({ inputTokens: 900, cachedInputTokens: 0 }))).toBeNull()
  })
})
