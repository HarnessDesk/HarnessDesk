import type { InsightReport, MessageCharge, SessionPointer } from '@harnessdesk/protocol'

import { metricWords } from '../lib/insight'
import { Button, Chip, Note, Row, RowValue, Rows, SectionHead } from '../design'

export interface InsightCostProps {
  readonly report: InsightReport | null
  readonly loading: boolean
  readonly problem: string | null
  readonly onRefresh: () => void
  readonly onSeat: (seat: string) => void
  readonly onSession: (session: SessionPointer) => void
  readonly onMessage: (message: MessageCharge) => void
}

/** Shared, deliberately textual accounting presentation: unknown is never formatted as free. */
export const InsightCost = ({ report, loading, problem, onRefresh }: InsightCostProps) => {
  if (loading) return <Note>Reading recorded usage…</Note>
  if (problem) return <Note tone="warn">Recorded usage could not be read. {problem} <Button size="sm" variant="outline" onClick={onRefresh}>Retry</Button></Note>
  if (!report) return null
  const words = metricWords(report.totals.usd, report.sources, Date.now())
  return (
    <section aria-label="Cost">
      <SectionHead name="Cost" />
      <Rows>
        <Row title="Recorded usage" desc={[words.qualifier, words.coverage, words.source, words.freshness].filter(Boolean).join(' · ')} control={<RowValue>{words.value}</RowValue>} />
        {report.breakdowns.flatMap((breakdown) => breakdown.rows).map((row) => (
          <Row key={row.key} title={row.label} desc={row.note ?? undefined} control={<RowValue>{metricWords(row.amounts.usd, report.sources, Date.now()).value}</RowValue>} />
        ))}
        {report.breakdowns.map((breakdown) => (
          <Row key={`unattributed-${breakdown.dimension}`} title="Unattributed" desc={breakdown.reason ?? 'No unique historical Seat could be established.'} control={<RowValue>{metricWords(breakdown.unattributed.usd, report.sources, Date.now()).value}</RowValue>} />
        ))}
      </Rows>
      {report.gaps.map((gap) => <Note key={gap} tone="warn">{gap}</Note>)}
      {report.sources.map((source) => <Chip key={source.id} tone={source.problem ? 'warning' : 'neutral'} title={source.label}>{source.stale ? 'Stale source' : source.label}</Chip>)}
    </section>
  )
}
