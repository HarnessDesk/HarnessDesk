import { useState, type ReactNode } from 'react'
import type { InsightMetric, InsightBreakdown, InsightDimension, InsightReport, MessageCharge, SessionPointer } from '@harnessdesk/protocol'

import { metricWords, receiptMetricWords, type MetricWords } from '../lib/insight'
import { Button, Chip, Dialog, KeyValue, KeyValueRow, Note, Row, Rows, Text, SectionHead, Tabs, TabsList, TabsTrigger } from '../design'

export interface InsightCostProps {
  readonly report: InsightReport | null
  readonly loading: boolean
  readonly problem: string | null
  /** Receipt uses plain accounting words and explains that the read is separate from wrap. */
  readonly detailOnly?: boolean
  readonly onRefresh: () => void
  readonly onSeat?: (seat: string) => void
  readonly onSession?: (session: SessionPointer) => void
  readonly onMessage?: (message: MessageCharge) => void
}

/** Shared, deliberately textual accounting presentation: unknown is never formatted as free. */
const labelFor = (dimension: InsightDimension): string => ({
  goal: 'By Goal', agent: 'By Agent', seat: 'By Seat',
})[dimension]

const sourceWords = (source: InsightReport['sources'][number]): string => {
  const checked = new Date(source.checkedAt).toLocaleString()
  const status = `${source.stale ? ' · Stale' : ''}${source.problem ? ` · ${source.problem}` : ''}`
  if (source.observedAt === null) return `${source.label} · Observation time unknown · Read ${checked}${status}`
  const observed = new Date(source.observedAt).toLocaleString()
  return `${source.label} · Observed ${observed} · Read ${checked}${status}`
}

/** Shared, deliberately textual accounting presentation: unknown is never formatted as free. */
export const InsightCost = ({ report, loading, problem, onRefresh, onSeat, onSession, onMessage, detailOnly = false }: InsightCostProps) => {
  const [dimension, setDimension] = useState<InsightDimension | null>(null)
  const [showSources, setShowSources] = useState(false)
  if (loading) return <Note>Reading recorded usage…</Note>
  if (problem) return <Note tone="warn">Recorded usage could not be read. {problem} <Button size="sm" variant="outline" onClick={onRefresh}>Retry</Button></Note>
  if (!report) return null
  const selected: InsightBreakdown | null = dimension === null
    ? (report.breakdowns.find((one) => one.dimension === 'seat') ?? report.breakdowns[0] ?? null)
    : (report.breakdowns.find((one) => one.dimension === dimension) ?? null)
  const now = Date.now()
  const describe = detailOnly ? receiptMetricWords : metricWords
  const words = describe(report.totals.usd, report.sources, now)
  const facts = (part: MetricWords) => [part.qualifier, part.coverage, part.source, part.freshness].filter(Boolean).join(' · ')
  const reading = (part: MetricWords, metric: InsightMetric) => {
    const qualifier = metric.quality === 'floor' ? 'At least' : metric.quality === 'estimate' ? 'Estimate' : null
    return <div className="flex flex-col items-end">{part.value}{[qualifier, part.coverage].filter(Boolean).length > 0 && <Text as="div" role="meta">{[qualifier, part.coverage].filter(Boolean).join(' · ')}</Text>}</div>
  }
  const labelWithNote = (label: ReactNode, note: string | null) => <span className="flex min-w-0 flex-col items-start"><Text as="span" role="subject">{label}</Text>{note && <Text as="span" role="meta" className="whitespace-normal">{note}</Text>}</span>
  const totalSourceAndAge = words.source === 'Recorded usage' ? words.freshness : `${words.source} · ${words.freshness}`

  return (
    <section aria-label="Cost">
      <SectionHead name="Cost" description={detailOnly ? 'Recorded usage is read separately from the wrap. Refresh reads it again.' : undefined} action={<Button size="sm" variant="outline" onClick={onRefresh}>Refresh</Button>} />
      {report.breakdowns.length > 1 && <Tabs value={selected?.dimension ?? ''} onValueChange={next => setDimension(next as InsightDimension)}>
        <TabsList aria-label="Cost breakdown">{report.breakdowns.map(breakdown => <TabsTrigger key={breakdown.dimension} value={breakdown.dimension}>{labelFor(breakdown.dimension)}</TabsTrigger>)}</TabsList>
      </Tabs>}
      <KeyValue className="items-center gap-y-(--hd-space-3)">
        {selected?.rows.map(row => {
          const rowWords = describe(row.amounts.usd, report.sources, now)
          const { seat, message, session } = row
          const action = seat !== null && onSeat ? () => onSeat(seat) : message !== null && onMessage ? () => onMessage(message) : session !== null && onSession ? () => onSession(session) : undefined
          return <KeyValueRow key={row.key} numeric label={labelWithNote(action ? <Button variant="link" size="sm" onClick={action}>{row.label}</Button> : row.label, row.note)} title={[row.note, rowWords.qualifier, rowWords.coverage].filter(Boolean).join(' · ') || undefined}>{reading(rowWords, row.amounts.usd)}</KeyValueRow>
        })}
        {selected && <KeyValueRow numeric label={labelWithNote('Unattributed', selected.reason ?? 'No unique historical Seat could be established.')} title={selected.reason ?? 'No unique historical Seat could be established.'}>{reading(describe(selected.unattributed.usd, report.sources, now), selected.unattributed.usd)}</KeyValueRow>}
        <KeyValueRow numeric emphasis label={labelWithNote('Recorded usage', totalSourceAndAge)} title={facts(words)} footer>{reading(words, report.totals.usd)}</KeyValueRow>
      </KeyValue>
      {report.gaps.map((gap) => <Note key={gap} tone="warn">{gap}</Note>)}
      <Button size="sm" variant="outline" onClick={() => setShowSources(true)}>Sources</Button>
      {showSources && <Dialog title="Recorded usage sources" onClose={() => setShowSources(false)} footer={<Button variant="default" onClick={() => setShowSources(false)}>Close</Button>}>
        <KeyValue>{selected?.rows.map(row => <KeyValueRow key={row.key} label={row.label}>{[row.note, facts(describe(row.amounts.usd, report.sources, now))].filter(Boolean).join(' · ')}</KeyValueRow>)}{selected && <KeyValueRow label="Unattributed">{[selected.reason, facts(describe(selected.unattributed.usd, report.sources, now))].filter(Boolean).join(' · ')}</KeyValueRow>}<KeyValueRow label="Recorded usage">{facts(words)}</KeyValueRow></KeyValue>
        <Rows>{report.sources.map((source) => <Row key={source.id} title={source.stale ? 'Stale source' : source.label} desc={sourceWords(source)} control={<Chip tone={source.problem ? 'warning' : 'neutral'}>{source.problem ? 'Problem' : 'Recorded'}</Chip>} />)}</Rows>
      </Dialog>}
    </section>
  )
}
