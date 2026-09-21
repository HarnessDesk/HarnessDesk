import type { InsightMetric, InsightSource } from '@harnessdesk/protocol'

export interface MetricWords {
  readonly value: string
  readonly qualifier: string | null
  readonly coverage: string | null
  readonly source: string
  readonly freshness: string
}

const number = (value: number, unit: InsightMetric['unit']): string => {
  if (unit === 'usd') return new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD' }).format(value)
  if (unit === 'milliseconds') return `${Math.round(value / 1000)}s`
  if (unit === 'ratio') return `${value.toFixed(2)}×`
  return new Intl.NumberFormat().format(value)
}

/** Human words retain source age and qualification; a new read never freshens an old observation. */
export function metricWords(metric: InsightMetric, sources: readonly InsightSource[], now: number): MetricWords {
  const matched = sources.filter((source) => metric.sourceIds.includes(source.id))
  const source = matched.length === 0 ? 'No measured source' : matched.map((one) => one.label).join(', ')
  const oldest = matched.map((one) => one.observedAt).filter((at): at is number => at !== null).sort((a, b) => a - b)[0] ?? null
  const freshness = oldest === null
    ? 'Observation time unavailable'
    : `${Math.max(0, Math.round((now - oldest) / 60_000))} minutes since observation`
  if (metric.value === null) return { value: 'Unknown', qualifier: null, coverage: metric.missing[0] ?? 'No complete measurement', source, freshness }
  const basis = metric.basis === 'vendorMetered' ? 'Vendor-metered cost' : null
  const quality = metric.quality === 'floor' ? 'At least' : metric.quality === 'estimate' ? 'Estimate' : null
  const qualifier = [basis, quality].filter((word): word is string => word !== null).join(' · ') || null
  const coverage = metric.coverage === 'partial' ? 'Estimated known subtotal' : metric.coverage === 'none' ? 'No coverage' : null
  return { value: number(metric.value, metric.unit), qualifier, coverage, source, freshness }
}
