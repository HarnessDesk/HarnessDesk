import { describe, expect, it } from 'vitest'

import { runtimeId } from '@harnessdesk/protocol'

import type { LedgerReport, LedgerRow } from '@harnessdesk/protocol'

import {
  agentCoverage,
  cacheHitRate,
  ledgerRuntimeIds,
  paidPerTurn,
  paidRatio,
  paidRatioCaption,
  paidScopeMatchesLedger,
  percentChange,
  perDay,
  tokenCoverage,
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
  it('reads as a rounded input/output split when there is no cache at all', () => {
    expect(tokenSplitCaption({ input: 30, output: 70 })).toBe('30% input · 70% output')
  })

  it('adds cache as its own share, so the split still adds up to the figure', () => {
    // 20 input, 20 output, 60 cache (read + write) — tokens = 100.
    expect(tokenSplitCaption({ input: 20, output: 20, cacheRead: 50, cacheWrite: 10 })).toBe(
      '20% input · 20% output · 60% cache',
    )
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

const row = (key: string, runtime: LedgerRow['runtime'], tokens: number | null): LedgerRow => ({
  key,
  label: key,
  runtime,
  tokens,
  cost: null,
  hasUnpriced: false,
})

describe('ledgerRuntimeIds', () => {
  it('is empty with no ledger', () => {
    expect(ledgerRuntimeIds(null)).toEqual([])
  })

  it('names every distinct runtime the ledger has a row for, and skips a folded row with none', () => {
    const ledger = { rows: [row('a', CODEX, 10), row('b', CLAUDE, 20), row('c', null, 5)] } as unknown as LedgerReport
    expect(ledgerRuntimeIds(ledger)).toEqual([CODEX, CLAUDE])
  })

  it('counts a runtime once even split across several rows (a model or project pivot)', () => {
    const ledger = { rows: [row('a', CODEX, 10), row('b', CODEX, 20)] } as unknown as LedgerReport
    expect(ledgerRuntimeIds(ledger)).toEqual([CODEX])
  })
})

describe('tokenCoverage', () => {
  it('is empty with no ledger', () => {
    expect(tokenCoverage(null)).toEqual({ known: 0, total: 0, partial: false })
  })

  it('is fully known when no row carries a null token count', () => {
    const ledger = { rows: [row('a', CODEX, 10), row('b', CLAUDE, 20)] } as unknown as LedgerReport
    expect(tokenCoverage(ledger)).toEqual({ known: 2, total: 2, partial: false })
  })

  it('is partial when one runtime has any row with a null token count, even if it has other rows too', () => {
    const ledger = {
      rows: [row('a', CODEX, 10), row('b', CLAUDE, null), row('c', CLAUDE, 20)],
    } as unknown as LedgerReport
    expect(tokenCoverage(ledger)).toEqual({ known: 1, total: 2, partial: true })
  })

  it('reads token coverage off the ledger’s own rows, independent of turn coverage', () => {
    // A runtime can be turn-unknown yet still fully tokens-known — the two
    // are different questions, so `tokenCoverage` never reads `turnsKnownFor`.
    const ledger = { rows: [row('a', CURSOR, 10)] } as unknown as LedgerReport
    expect(tokenCoverage(ledger)).toEqual({ known: 1, total: 1, partial: false })
  })
})

describe('paidScopeMatchesLedger', () => {
  const paid = { missingFeeCount: 0, otherCurrencies: false, currency: 'USD' }

  it('matches when every account has a fee, one currency, shared with the ledger', () => {
    expect(paidScopeMatchesLedger(paid, 'USD')).toBe(true)
  })

  it('does not match when an account in scope has no fee set', () => {
    expect(paidScopeMatchesLedger({ ...paid, missingFeeCount: 1 }, 'USD')).toBe(false)
  })

  it('does not match when scope spans more than one currency', () => {
    expect(paidScopeMatchesLedger({ ...paid, otherCurrencies: true }, 'USD')).toBe(false)
  })

  it('does not match when the ledger’s currency differs from Paid’s', () => {
    expect(paidScopeMatchesLedger(paid, 'EUR')).toBe(false)
  })

  it('does not match when either currency is unknown', () => {
    expect(paidScopeMatchesLedger({ ...paid, currency: null }, 'USD')).toBe(false)
    expect(paidScopeMatchesLedger(paid, undefined)).toBe(false)
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

describe('paidRatioCaption', () => {
  it('uses one decimal below ten times and a whole number at ten or more', () => {
    expect(paidRatioCaption(9.4)).toBe('9.4× paid')
    expect(paidRatioCaption(10.4)).toBe('10× paid')
    expect(paidRatioCaption(0.55)).toBe('0.6× paid')
  })
})
