import { describe, expect, it } from 'vitest'

import type { TokenUsage } from '@harnessdesk/protocol'

import { describeContext, formatCost, formatTokens } from './context-usage'

const tokens = (over: Partial<TokenUsage> = {}): TokenUsage => ({
  totalTokens: 0,
  inputTokens: 0,
  cachedInputTokens: 0,
  outputTokens: 0,
  reasoningOutputTokens: 0,
  ...over,
})

describe('formatTokens', () => {
  it('keeps to the density a toolbar can afford', () => {
    expect(formatTokens(940)).toBe('940')
    expect(formatTokens(1000)).toBe('1K')
    expect(formatTokens(23012)).toBe('23K')
    expect(formatTokens(171_400)).toBe('171.4K')
    expect(formatTokens(1_000_000)).toBe('1M')
    expect(formatTokens(1_234_567)).toBe('1.2M')
  })
})

describe('describeContext', () => {
  it('is silent until the runtime has said anything', () => {
    expect(describeContext(null, 'Agent')).toBeNull()
    expect(describeContext({ total: tokens(), last: tokens() }, 'Agent')).toBeNull()
  })

  it('divides only contextUsed by contextWindow — never the session total', () => {
    const view = describeContext(
      {
        total: tokens({ totalTokens: 2_000_000, inputTokens: 1_900_000, outputTokens: 100_000 }),
        last: tokens({ totalTokens: 50_000, inputTokens: 48_000, outputTokens: 2000 }),
        contextUsed: 171_000,
        contextWindow: 258_000,
      },
      'Agent',
    )
    expect(view?.fill).toMatchObject({ used: 171_000, size: 258_000, percent: 66, tone: 'good' })
    expect(view?.title).toBe('Context window 66% full — 171K of 258K tokens')
  })

  it('warns at 70% and alarms at 90%, capped at full', () => {
    const at = (used: number) =>
      describeContext({ total: tokens({ totalTokens: 1 }), last: tokens(), contextUsed: used, contextWindow: 100 }, 'A')?.fill
    expect(at(69)?.tone).toBe('good')
    expect(at(70)?.tone).toBe('warn')
    expect(at(90)?.tone).toBe('bad')
    expect(at(140)).toMatchObject({ percent: 100, ratio: 1, tone: 'bad' })
  })

  it('has no fill without a window size, and says so in the agent\'s name', () => {
    const view = describeContext(
      { total: tokens({ totalTokens: 1280, inputTokens: 1200, outputTokens: 80 }), last: tokens({ totalTokens: 1280 }) },
      'Cursor Agent',
    )
    expect(view?.fill).toBeNull()
    expect(view?.title).toBe('1.3K tokens this session — Cursor Agent does not report its context window')
    expect(view?.total?.totalTokens).toBe(1280)
  })

  it('a fill with no turn yet still shows, as a fill alone', () => {
    const view = describeContext({ total: tokens(), last: tokens(), contextUsed: 5, contextWindow: 10 }, 'A')
    expect(view?.fill?.percent).toBe(50)
    expect(view?.last).toBeNull()
    expect(view?.total).toBeNull()
  })

  it('carries the cost through', () => {
    const view = describeContext(
      { total: tokens({ totalTokens: 1 }), last: tokens(), cost: { amount: 0.0246, currency: 'USD' } },
      'A',
    )
    expect(view?.cost).toEqual({ amount: 0.0246, currency: 'USD' })
  })
})

describe('formatCost', () => {
  it('shows small amounts with enough digits to be non-zero', () => {
    expect(formatCost({ amount: 0.0246, currency: 'USD' })).toMatch(/0\.025/)
    expect(formatCost({ amount: 12.5, currency: 'USD' })).toMatch(/12\.50/)
  })
})

describe('the context composition', () => {
  /** The live shape recorded off `@harnessdesk/dsh-acp` on 2026-08-24. */
  const dsh = {
    total: tokens({ totalTokens: 10_830 }),
    last: tokens({ totalTokens: 10_830 }),
    contextUsed: 10_842,
    contextWindow: 1_000_000,
    breakdown: {
      approximate: true,
      source: 'DeepSeek Harness token meter',
      segments: [
        { id: 'system', label: 'System prompt', tokens: 694 },
        { id: 'tools', label: 'Tool schemas', tokens: 4324, count: 15 },
        { id: 'messages', label: 'Messages', tokens: 6543 },
      ],
    },
  }

  it('shares each part against the other parts, never against the window', () => {
    const composition = describeContext(dsh, 'DeepSeek Harness')?.composition
    // 694 + 4324 + 6543 = 11,561 — more than the 10,842 the provider charged,
    // which is exactly why these are shares of the segments and not of the
    // ring. Against the window each would round to 0% or 1%.
    expect(composition?.measured).toBe(11_561)
    expect(composition?.segments.map((segment) => segment.percent)).toEqual([6, 37, 57])
  })

  it('keeps the exact count and the source the runtime sent', () => {
    const composition = describeContext(dsh, 'DeepSeek Harness')?.composition
    expect(composition?.segments.map((segment) => segment.count)).toEqual([null, 15, null])
    expect(composition?.source).toBe('DeepSeek Harness token meter')
    expect(composition?.approximate).toBe(true)
  })

  it('synthesises no free-space row, because nobody measured one', () => {
    const composition = describeContext(dsh, 'DeepSeek Harness')?.composition
    expect(composition?.segments.map((segment) => segment.id)).toEqual(['system', 'tools', 'messages'])
  })

  it('is absent for a runtime that reports no composition', () => {
    const view = describeContext({ total: tokens(), last: tokens(), contextUsed: 5, contextWindow: 10 }, 'Codex')
    expect(view?.composition).toBeNull()
    // And its absence must not take the rest of the panel with it.
    expect(view?.fill?.percent).toBe(50)
  })

  it('ignores a breakdown with nothing in it', () => {
    const view = describeContext(
      { total: tokens(), last: tokens(), contextUsed: 5, contextWindow: 10, breakdown: { segments: [], approximate: true, source: 'x' } },
      'A',
    )
    expect(view?.composition).toBeNull()
  })
})
