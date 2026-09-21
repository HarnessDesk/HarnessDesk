import { useEffect, useState } from 'react'
import type { AgentOrigin, InsightDimension, InsightReport } from '@harnessdesk/protocol'

import { metricWords } from '../lib/insight'
import { useStore } from '../state/context'
import { Note, Row, RowValue, Rows } from '../design'

export interface InsightUsageProps {
  readonly root: string | null
  readonly view: 'goal' | 'agent'
  readonly onGoal: (goal: string) => void
  readonly onAgent: (agent: string, origin: AgentOrigin) => void
}

export const InsightUsage = ({ root, view, onGoal, onAgent }: InsightUsageProps) => {
  const store = useStore(); const [report, setReport] = useState<InsightReport | null>(null); const [problem, setProblem] = useState<string | null>(null)
  useEffect(() => {
    if (!root) return
    let current = true; const to = Date.now(); const from = to - 30 * 86_400_000
    void store.readUsageInsight({ root, from, to }).then((next) => { if (current) setReport(next) }).catch((error: unknown) => { if (current) setProblem(error instanceof Error ? error.message : 'Recorded usage could not be read.') })
    return () => { current = false }
  }, [store, root, view])
  if (!root) return <Note>Choose a project to see its Goals.</Note>
  if (problem) return <Note tone="warn">{problem}</Note>
  if (!report) return <Note>Reading recorded usage…</Note>
  const dimension: InsightDimension = view
  const breakdown = report.breakdowns.find((entry) => entry.dimension === dimension)
  const seats = new Map(report.seats.map((seat) => [seat.id, seat]))
  if (!breakdown) return <Note>Recorded usage has no {view} attribution.</Note>
  return <Rows>
    {breakdown.rows.length === 0 ? <Row title={view === 'goal' ? 'No Goal usage was recorded' : 'No Agent usage was recorded'} desc={breakdown.reason ?? 'Unknown historical usage remains unassigned.'} /> : breakdown.rows.map((row) => {
      const historical = row.seat ? seats.get(row.seat) : null
      const click = view === 'goal' && row.goal ? () => onGoal(row.goal!) : view === 'agent' && historical?.agent ? () => onAgent(historical.agent!.id, historical.agent!.origin) : undefined
      const words = metricWords(row.amounts.usd, report.sources, Date.now())
      return <Row key={row.key} title={row.label} desc={[row.note, words.qualifier, words.coverage, words.source, words.freshness].filter(Boolean).join(' · ') || undefined} {...(click ? { onClick: click } : {})} control={<RowValue>{words.value}</RowValue>} />
    })}
    <Row title="Not attributed to a Goal" desc={breakdown.reason ?? 'No unique historical Seat could be established.'} control={<RowValue>{metricWords(breakdown.unattributed.usd, report.sources, Date.now()).value}</RowValue>} />
  </Rows>
}
