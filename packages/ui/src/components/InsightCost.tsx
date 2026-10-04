import { useState } from 'react'
import type { InsightBreakdown, InsightDimension, InsightReport, MessageCharge, SessionPointer } from '@harnessdesk/protocol'

import { metricWords, receiptMetricWords, type MetricWords } from '../lib/insight'
import { Button, Chip, Dialog, Note, Row, RowValue, Rows, SectionHead, Tabs, TabsList, TabsTrigger } from '../design'

export interface InsightCostProps {
  readonly report: InsightReport | null
  readonly loading: boolean
  readonly problem: string | null
  /** Receipt presents the total in its Record card. */
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
  const fields = ['qualifier', 'coverage', 'source', 'freshness'] as const
  const parts = selected ? [...selected.rows.map(row => describe(row.amounts.usd, report.sources, now)), describe(selected.unattributed.usd, report.sources, now)] : []
  const shared = fields.filter(field => parts.length > 0 && parts.every(part => part[field] === parts[0]![field]))
  // Shared facts are already beside the total when equal to it; otherwise
  // they belong to this group. A row only carries the facts that vary.
  const groupFacts = shared.map(field => parts[0]![field] === words[field] ? null : parts[0]![field]).filter(Boolean)
  const rowFacts = (part: MetricWords) => fields.filter(field => !shared.includes(field) && part[field] !== words[field]).map(field => part[field]).filter(Boolean)
  return (
    <section aria-label="Cost">
      <SectionHead name={detailOnly ? "Cost detail" : "Cost"} description={[detailOnly ? 'Recorded usage is read separately from the wrap. Refresh reads it again.' : null, ...groupFacts].filter(Boolean).join(' · ') || undefined} action={<Button size="sm" variant="outline" onClick={onRefresh}>Refresh</Button>} />
      {!detailOnly && <Rows>
        <Row title="Recorded usage" desc={[words.qualifier, words.coverage, words.source, words.freshness].filter(Boolean).join(' · ')} control={<RowValue numeric>{words.value}</RowValue>} />
      </Rows>}
      {(selected || report.breakdowns.length > 1) && <Rows>
      {report.breakdowns.length > 1 && <Row title={
        <Tabs value={selected?.dimension ?? ''} onValueChange={(next) => setDimension(next as InsightDimension)}>
          <TabsList aria-label="Cost breakdown">
            {report.breakdowns.map((breakdown) => <TabsTrigger key={breakdown.dimension} value={breakdown.dimension}>{labelFor(breakdown.dimension)}</TabsTrigger>)}
          </TabsList>
        </Tabs>
      } />}
      {selected && <>
        {selected.rows.map((row) => {
          const rowWords = describe(row.amounts.usd, report.sources, now)
          const { seat, message, session } = row
          const action = seat !== null && onSeat ? () => onSeat(seat) : message !== null && onMessage ? () => onMessage(message) : session !== null && onSession ? () => onSession(session) : undefined
          return <Row key={row.key} title={row.label} {...(action ? { onClick: action } : {})} desc={[row.note, ...rowFacts(rowWords)].filter(Boolean).join(' · ') || undefined} control={<RowValue numeric>{rowWords.value}</RowValue>} />
        })}
        <Row title="Unattributed" desc={[selected.reason ?? 'No unique historical Seat could be established.', ...rowFacts(describe(selected.unattributed.usd, report.sources, now))].filter(Boolean).join(' · ')} control={<RowValue numeric>{describe(selected.unattributed.usd, report.sources, now).value}</RowValue>} />
      </>}
      </Rows>}
      {report.gaps.map((gap) => <Note key={gap} tone="warn">{gap}</Note>)}
      <Button size="sm" variant="outline" onClick={() => setShowSources(true)}>Sources</Button>
      {showSources && <Dialog title="Recorded usage sources" onClose={() => setShowSources(false)} footer={<Button variant="default" onClick={() => setShowSources(false)}>Close</Button>}>
        <Rows>{report.sources.map((source) => <Row key={source.id} title={source.stale ? 'Stale source' : source.label} desc={sourceWords(source)} control={<Chip tone={source.problem ? 'warning' : 'neutral'}>{source.problem ? 'Problem' : 'Recorded'}</Chip>} />)}</Rows>
      </Dialog>}
    </section>
  )
}
