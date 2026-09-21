import { useState } from 'react'
import type { InsightBreakdown, InsightDimension, InsightReport, MessageCharge, SessionPointer } from '@harnessdesk/protocol'

import { metricWords } from '../lib/insight'
import { Button, Chip, Dialog, Note, Row, RowValue, Rows, SectionHead, Tabs, TabsList, TabsTrigger } from '../design'

export interface InsightCostProps {
  readonly report: InsightReport | null
  readonly loading: boolean
  readonly problem: string | null
  readonly onRefresh: () => void
  readonly onSeat?: (seat: string) => void
  readonly onSession?: (session: SessionPointer) => void
  readonly onMessage?: (message: MessageCharge) => void
}

/** Shared, deliberately textual accounting presentation: unknown is never formatted as free. */
const labelFor = (dimension: InsightDimension): string => ({
  goal: 'By Goal', agent: 'By Agent', seat: 'By Seat', message: 'By Message', delegation: 'By Delegation', loaded: 'Loaded',
})[dimension]

const sourceWords = (source: InsightReport['sources'][number]): string => {
  if (source.observedAt === null) return `${source.label} · Observation time unknown`
  const observed = new Date(source.observedAt).toLocaleString()
  const checked = new Date(source.checkedAt).toLocaleString()
  return `${source.label} · Observed ${observed} · Read ${checked}${source.stale ? ' · Stale' : ''}${source.problem ? ` · ${source.problem}` : ''}`
}

/** Shared, deliberately textual accounting presentation: unknown is never formatted as free. */
export const InsightCost = ({ report, loading, problem, onRefresh, onSeat, onSession, onMessage }: InsightCostProps) => {
  const [dimension, setDimension] = useState<InsightDimension | null>(null)
  const [showSources, setShowSources] = useState(false)
  if (loading) return <Note>Reading recorded usage…</Note>
  if (problem) return <Note tone="warn">Recorded usage could not be read. {problem} <Button size="sm" variant="outline" onClick={onRefresh}>Retry</Button></Note>
  if (!report) return null
  const selected: InsightBreakdown | null = dimension === null
    ? (report.breakdowns.find((one) => one.dimension === 'seat') ?? report.breakdowns[0] ?? null)
    : (report.breakdowns.find((one) => one.dimension === dimension) ?? null)
  const words = metricWords(report.totals.usd, report.sources, Date.now())
  return (
    <section aria-label="Cost">
      <SectionHead name="Cost" />
      <Rows>
        <Row title="Recorded usage" desc={[words.qualifier, words.coverage, words.source, words.freshness].filter(Boolean).join(' · ')} control={<RowValue>{words.value}</RowValue>} />
      </Rows>
      {report.breakdowns.length > 1 && (
        <Tabs value={selected?.dimension ?? ''} onValueChange={(next) => setDimension(next as InsightDimension)}>
          <TabsList aria-label="Cost breakdown">
            {report.breakdowns.map((breakdown) => <TabsTrigger key={breakdown.dimension} value={breakdown.dimension}>{labelFor(breakdown.dimension)}</TabsTrigger>)}
          </TabsList>
        </Tabs>
      )}
      {selected && <Rows>
        {selected.rows.map((row) => {
          const rowWords = metricWords(row.amounts.usd, report.sources, Date.now())
          const { seat, message, session } = row
          const action = seat !== null && onSeat ? () => onSeat(seat) : message !== null && onMessage ? () => onMessage(message) : session !== null && onSession ? () => onSession(session) : undefined
          return <Row key={row.key} title={row.label} {...(action ? { onClick: action } : {})} desc={[row.note, rowWords.qualifier, rowWords.coverage, rowWords.source, rowWords.freshness].filter(Boolean).join(' · ') || undefined} control={<RowValue>{rowWords.value}</RowValue>} />
        })}
        <Row title="Unattributed" desc={selected.reason ?? 'No unique historical Seat could be established.'} control={<RowValue>{metricWords(selected.unattributed.usd, report.sources, Date.now()).value}</RowValue>} />
      </Rows>}
      {report.gaps.map((gap) => <Note key={gap} tone="warn">{gap}</Note>)}
      <Button size="sm" variant="outline" onClick={() => setShowSources(true)}>Sources</Button>
      {showSources && <Dialog title="Recorded usage sources" onClose={() => setShowSources(false)} footer={<Button variant="outline" onClick={() => setShowSources(false)}>Close</Button>}>
        <Rows>{report.sources.map((source) => <Row key={source.id} title={source.stale ? 'Stale source' : source.label} desc={sourceWords(source)} control={<Chip tone={source.problem ? 'warning' : 'neutral'}>{source.problem ? 'Problem' : 'Recorded'}</Chip>} />)}</Rows>
      </Dialog>}
    </section>
  )
}
