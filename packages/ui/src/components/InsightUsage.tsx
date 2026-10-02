import { useEffect, useState } from 'react'
import type { InsightDimension, InsightReport, RuntimeId } from '@harnessdesk/protocol'

import { metricWords } from '../lib/insight'
import { useStore } from '../state/context'
import { Chip, Note, Row, RowButton, RowValue, Rows } from '../design'

export interface InsightUsageProps {
  readonly root: string | null
  readonly runtime: RuntimeId | null
  readonly view: 'goal' | 'agent'
  readonly onGoal: (goal: string) => void
  /**
   * Supplied once by `Usage.tsx`, which owns this fetch — keyed on scope and
   * root, not on `view` — so switching views on the Dashboard does not
   * refetch it (review of #1057, item 4). Omitted (never passed) falls back
   * to this component's own fetch, which is what keeps a bare mount (a
   * test) working.
   */
  readonly report?: InsightReport | null
  readonly problem?: string | null
}

export const InsightUsage = ({ root, runtime, view, onGoal, report: suppliedReport, problem: suppliedProblem }: InsightUsageProps) => {
  const store = useStore(); const [ownReport, setOwnReport] = useState<InsightReport | null>(null); const [ownProblem, setOwnProblem] = useState<string | null>(null)
  const owned = suppliedReport === undefined
  useEffect(() => {
    if (!owned) return
    setOwnReport(null); setOwnProblem(null)
    if (!root) return
    let current = true; const to = Date.now(); const from = to - 30 * 86_400_000
    void store.readUsageInsight({ root, from, to, ...(runtime ? { runtime } : {}) }).then((next) => { if (current) setOwnReport(next) }).catch((error: unknown) => { if (current) setOwnProblem(error instanceof Error ? error.message : 'Recorded usage could not be read.') })
    return () => { current = false }
  }, [store, root, runtime, view, owned])
  const report = owned ? ownReport : (suppliedReport ?? null)
  const problem = owned ? ownProblem : (suppliedProblem ?? null)
  if (!root) return <Note>Choose a project to see its Goals.</Note>
  if (problem) return <Note tone="warn">{problem}</Note>
  if (!report) return <Note>Reading recorded usage…</Note>
  const dimension: InsightDimension = view
  const breakdown = report.breakdowns.find((entry) => entry.dimension === dimension)
  const failedSources = report.sources.filter((source) => source.problem !== null)
  return <>
    {report.scan === 'partial' ? <Note><Chip tone="warning" title="Source scan reached its limit">Partial</Chip></Note> : null}
    <Rows>
      {!breakdown ? <Row title={`Recorded usage has no ${view} attribution.`} /> : breakdown.rows.length === 0 ? <Row title={view === 'goal' ? 'No Goal usage was recorded' : 'No Agent usage was recorded'} desc={breakdown.reason ?? 'Unknown historical usage remains unassigned.'} /> : breakdown.rows.map((row) => {
        const click = view === 'goal' && row.goal ? () => onGoal(row.goal!) : null
        const words = metricWords(row.amounts.usd, report.sources, Date.now())
        const props = { title: row.label, desc: [row.note, words.qualifier, words.coverage, words.source, words.freshness].filter(Boolean).join(' · ') || undefined, control: <RowValue numeric>{words.value}</RowValue> }
        return click ? <RowButton key={row.key} {...props} onClick={click} /> : <Row key={row.key} {...props} />
      })}
      {breakdown ? <Row title={view === 'goal' ? 'Not attributed to a Goal' : 'Not attributed to an Agent'} desc={breakdown.reason ?? `No unique historical ${view === 'goal' ? 'Seat' : 'Agent Seat'} could be established.`} control={<RowValue numeric>{metricWords(breakdown.unattributed.usd, report.sources, Date.now()).value}</RowValue>} /> : null}
      {failedSources.map((source) => <Row key={source.id} title={source.label} desc={source.problem ?? undefined} control={<Chip tone="warning">Unavailable</Chip>} />)}
    </Rows>
    {/* A gap belongs to the whole read, not to one row, and Note carries no
        card padding of its own — inside Rows its text sat flush against the
        card's edge. Outside it, Note's own margin is the spacing. */}
    {report.gaps.filter((gap) => report.scan !== 'partial' || !gap.startsWith('Insight stopped')).map((gap) => <Note key={gap} tone="warn">{gap}</Note>)}
  </>
}
