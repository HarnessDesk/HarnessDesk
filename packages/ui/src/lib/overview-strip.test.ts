import { describe, expect, it } from 'vitest'

import { runtimeId } from '@harnessdesk/protocol'

import {
  agentCoverage,
  cacheHitRate,
  paidPerTurn,
  paidRatio,
  percentChange,
  perDay,
  tokenSplitCaption,
} from './overview-strip'

const CODEX = runtimeId('codex')
const CLAUDE = runtimeId('claude')
const CURSOR = runtimeId('cursor')

describe('percentChange', () => {
  it('is positive when the current figure rose', () => {
    expect(percentChange(120, 100)).toBeCloseTo(20, 6)
  })

  it('is negative when the current figure fell', () => {
    expect(percentChange(80, 100)).toBeCloseTo(-20, 6)
  })

  it('is null against a zero previous figure', () => {
    expect(percentChange(10, 0)).toBeNull()
  })

  it('is null when either side is not finite', () => {
    expect(percentChange(Number.NaN, 10)).toBeNull()
  })
})

describe('cacheHitRate', () => {
  it('divides cache reads by the input side, not the whole token count', () => {
    // 25 fresh input, 75 cache reads, plus output that must not dilute this.
    expect(cacheHitRate({ input: 25, cacheRead: 75 })).toBeCloseTo(75, 6)
  })

  it('is 100% when input is zero and something was still read from cache', () => {
    expect(cacheHitRate({ input: 0, cacheRead: 40 })).toBe(100)
  })

  it('is null, not NaN, when both sides are zero', () => {
    expect(cacheHitRate({ input: 0, cacheRead: 0 })).toBeNull()
  })

  it('is null when there is no split to read at all', () => {
    expect(cacheHitRate(undefined)).toBeNull()
  })
})

describe('tokenSplitCaption', () => {
  it('reads as a rounded input/output split', () => {
    expect(tokenSplitCaption({ input: 30, output: 70 })).toBe('30% input · 70% output')
  })

  it('is null with nothing to split', () => {
    expect(tokenSplitCaption({ input: 0, output: 0 })).toBeNull()
    expect(tokenSplitCaption(undefined)).toBeNull()
  })
})

describe('agentCoverage', () => {
  it('is not partial when every runtime in scope is turn-known', () => {
    const coverage = agentCoverage({ turnsKnownFor: [CODEX, CLAUDE] } as never, [CODEX, CLAUDE])
    expect(coverage).toEqual({ known: 2, total: 2, partial: false })
  })

  it('is partial when some runtimes are missing from turnsKnownFor', () => {
    const coverage = agentCoverage({ turnsKnownFor: [CODEX] } as never, [CODEX, CLAUDE, CURSOR])
    expect(coverage).toEqual({ known: 1, total: 3, partial: true })
  })

  it('counts a runtime once even if it appears in several rows', () => {
    const coverage = agentCoverage({ turnsKnownFor: [CODEX] } as never, [CODEX, CODEX, CLAUDE])
    expect(coverage.total).toBe(2)
  })

  it('is not partial with nothing in scope', () => {
    expect(agentCoverage(null, []).partial).toBe(false)
  })
})

describe('paidRatio / perDay / paidPerTurn', () => {
  it('divides value by paid when paid is known and positive', () => {
    expect(paidRatio(200, 100)).toBe(2)
  })

  it('is null when paid is not known or is zero', () => {
    expect(paidRatio(200, null)).toBeNull()
    expect(paidRatio(200, 0)).toBeNull()
  })

  it('averages value over the window’s days', () => {
    expect(perDay(300, 30)).toBe(10)
  })

  it('prices Paid against the turn count', () => {
    expect(paidPerTurn(100, 25)).toBe(4)
  })

  it('is null without a real turn count', () => {
    expect(paidPerTurn(100, undefined)).toBeNull()
    expect(paidPerTurn(100, 0)).toBeNull()
    expect(paidPerTurn(null, 25)).toBeNull()
  })
})
