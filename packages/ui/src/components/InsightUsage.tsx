import { useEffect, useState } from 'react'
import type { AgentOrigin, InsightReport } from '@harnessdesk/protocol'

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
  return <Rows>{view === 'goal' ? report.goals.map((goal) => <Row key={goal.id} title={goal.sentence} desc={goal.state === 'wrapped' ? 'Wrapped Goal' : 'So far'} control={<RowValue>{metricWords(report.totals.usd, report.sources, Date.now()).value}</RowValue>} onClick={() => onGoal(goal.id)} />) : report.seats.map((seat) => <Row key={seat.id} title={seat.agent?.name ?? 'Unassigned Seat'} desc={seat.seatLabel} control={<RowValue>{metricWords(report.totals.usd, report.sources, Date.now()).value}</RowValue>} onClick={() => seat.agent && onAgent(seat.agent.id, seat.agent.origin)} />)}</Rows>
}
