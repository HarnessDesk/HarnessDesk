import { describe, expect, it } from 'vitest'

import { metricWords } from './insight.js'

const source = { id: 'source', kind: 'corpus' as const, label: 'Agent transcript', observedAt: 0, checkedAt: 60_000, stale: true, problem: null }
const metric = (value: number | null, quality: 'exact' | 'floor' | 'estimate' | 'unknown', coverage: 'complete' | 'partial' | 'none' = 'complete') => ({
  value, quality, coverage, unit: 'usd' as const, basis: 'listPrice' as const, sourceIds: ['source'], missing: [],
})

describe('metricWords', () => {
  it('keeps unknown, explicit zero, floor, and estimate distinct', () => {
    expect(metricWords(metric(null, 'unknown', 'none'), [source], 60_000).value).toBe('Unknown')
    expect(metricWords(metric(0, 'exact'), [source], 60_000).value).toBe('$0.00')
    expect(metricWords(metric(2, 'floor'), [source], 60_000).qualifier).toBe('At least')
    const estimated = metricWords(metric(2, 'estimate', 'partial'), [source], 60_000)
    expect(estimated.qualifier).toBe('Estimate')
    expect(estimated.coverage).toBe('Estimated known subtotal')
  })

  it('does not freshen old observations from a read timestamp', () => {
    expect(metricWords(metric(2, 'exact'), [source], 24 * 60 * 60_000).freshness).toContain('1440 minutes since observation')
  })

  it('names mixed vendor-metered and list-price totals', () => {
    const mixed = { ...metric(2, 'estimate'), basis: 'mixed' as const }
    expect(metricWords(mixed, [source], 60_000).qualifier).toContain('Vendor-metered and list-price cost')
  })
})


it('deduplicates corpus labels and retains the oldest of four file observations', () => {
  const sources = [0, 1, 2, 3].map(n => ({ ...source, id: `file-${n}`, label: 'Recorded usage', observedAt: n * 60_000 }))
  const words = metricWords({ ...metric(4, 'exact'), sourceIds: sources.map(s => s.id) }, sources, 240_000)
  expect(words.source).toBe('Recorded usage · 4 files')
  expect(words.freshness).toBe('4 minutes since observation')
})
