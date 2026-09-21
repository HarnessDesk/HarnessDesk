import { useEffect, useState } from 'react'
import type { AgentEntry, InsightReport } from '@harnessdesk/protocol'

import { metricWords } from '../lib/insight'
import { useStore } from '../state/context'
import { Button, Note, Row, RowValue, Rows, SectionHead } from '../design'

/** Historical accounting beside, never in place of, manual machine-seat controls. */
export const AgentSeatCosts = ({ entry }: { readonly entry: AgentEntry }) => {
  const store = useStore()
  const [report, setReport] = useState<InsightReport | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  useEffect(() => {
    if (!('readAgentInsight' in store) || typeof store.readAgentInsight !== 'function') return
    let live = true
    void store.readAgentInsight(undefined, entry.id, entry.origin).then((next) => { if (live) setReport(next) }).catch((error: unknown) => { if (live) setProblem(error instanceof Error ? error.message : 'Historical costs could not be read.') })
    return () => { live = false }
  }, [store, entry.id, entry.origin])
  return (
    <section aria-label="Historical seat costs">
      <SectionHead name="Historical seat costs" />
      {problem ? <Note tone="warn">{problem}</Note> : !report ? <Note>Reading recorded usage…</Note> : (
        <Rows>
          {report.seats.length === 0 ? <Row title="No historical Seats were recorded" desc="Unknown historical usage stays unassigned." /> : report.seats.map((seat) => (
            <Row key={seat.id} title={seat.seatLabel} desc={seat.briefDigest ? 'Recorded brief cohort' : 'Brief cohort unavailable'} control={<RowValue>{metricWords(report.totals.usd, report.sources, Date.now()).value}</RowValue>} />
          ))}
        </Rows>
      )}
      <Note>This history is read-only. Ordering seats remains an explicit local action.</Note>
      <Button size="sm" variant="outline" disabled title="Choose comparable completed Goals in Usage before reviewing a local order.">Order by cost</Button>
    </section>
  )
}
