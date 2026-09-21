import { useEffect, useMemo, useState } from 'react'
import type { AgentEntry, FlowSeat, InsightOrderPreview, InsightReport } from '@harnessdesk/protocol'

import { metricWords } from '../lib/insight'
import { useSnapshot, useStore } from '../state/context'
import { Button, Dialog, Note, Row, RowValue, Rows, SectionHead } from '../design'

const sameSeat = (left: FlowSeat, right: FlowSeat): boolean =>
  left.runtime === right.runtime && left.model === right.model && left.effort === right.effort && left.thinking === right.thinking

/** Historical accounting beside, never in place of, manual machine-seat controls. */
export const AgentSeatCosts = ({ entry }: { readonly entry: AgentEntry }) => {
  const store = useStore()
  const snapshot = useSnapshot()
  const root = snapshot.workspace?.repo?.root ?? snapshot.workspace?.path
  const [report, setReport] = useState<InsightReport | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const [preview, setPreview] = useState<InsightOrderPreview | null>(null)
  const [ordering, setOrdering] = useState(false)
  const [applying, setApplying] = useState(false)
  const [orderProblem, setOrderProblem] = useState<string | null>(null)
  useEffect(() => {
    // Isolated design/page renderers intentionally provide a snapshot-only
    // store.  They must not start a host read merely because this adjunct is
    // mounted beside the existing manual controls.
    if (typeof store.readAgentInsight !== 'function') return
    let live = true
    setReport(null); setProblem(null)
    void store.readAgentInsight(root, entry.id, entry.origin).then(
      (next) => { if (live) setReport(next) },
      (error: unknown) => { if (live) setProblem(error instanceof Error ? error.message : 'Historical costs could not be read.') },
    )
    return () => { live = false }
  }, [store, root, entry.id, entry.origin])

  const candidates = useMemo(() => snapshot.seating?.entries.find((one) => one.id === entry.id)?.seats ?? entry.definition?.prefer ?? [], [snapshot.seating?.entries, entry.id, entry.definition?.prefer])
  const comparable = useMemo(() => {
    if (!report || !root) return null
    const historical = report.seats.filter((seat) => seat.agent?.id === entry.id && seat.agent.origin === entry.origin && seat.board !== null)
    for (let leftIndex = 0; leftIndex < candidates.length; leftIndex += 1) for (let rightIndex = leftIndex + 1; rightIndex < candidates.length; rightIndex += 1) {
      const left = candidates[leftIndex]!; const right = candidates[rightIndex]!
      const leftSeats = historical.filter((seat) => sameSeat(seat.seat, left)); const rightSeats = historical.filter((seat) => sameSeat(seat.seat, right))
      const digest = leftSeats.find((seat) => seat.briefDigest !== null && rightSeats.some((other) => other.briefDigest === seat.briefDigest))?.briefDigest
      if (!digest) continue
      const goals = [...new Set(leftSeats.filter((seat) => seat.briefDigest === digest).map((seat) => seat.board!).filter((goal) => rightSeats.some((seat) => seat.briefDigest === digest && seat.board === goal)))]
      if (goals.length > 0) return { left, right, digest, goals }
    }
    return null
  }, [report, root, candidates, entry.id, entry.origin])
  const review = async (): Promise<void> => {
    if (!root || !comparable || ordering) return
    setOrdering(true); setOrderProblem(null)
    try { setPreview(await store.previewInsightOrder({ root, from: Date.now() - 90 * 86_400_000, to: Date.now(), goals: comparable.goals, agent: entry.id, origin: entry.origin, left: { agent: entry.id, origin: entry.origin, briefDigest: comparable.digest, seat: comparable.left }, right: { agent: entry.id, origin: entry.origin, briefDigest: comparable.digest, seat: comparable.right } })) }
    catch (error) { setOrderProblem(error instanceof Error ? error.message : 'The local order could not be reviewed.') }
    finally { setOrdering(false) }
  }
  const apply = async (): Promise<void> => {
    if (!preview?.stamp || applying) return
    setApplying(true); setOrderProblem(null)
    try { await store.applyInsightOrder(preview.stamp); setPreview(null) }
    catch (error) { setOrderProblem(error instanceof Error ? error.message : 'The local order was not saved.') }
    finally { setApplying(false) }
  }
  const historical = report?.seats.filter((seat) => seat.agent?.id === entry.id && seat.agent.origin === entry.origin) ?? []
  const seatAmounts = new Map((report?.breakdowns.find((breakdown) => breakdown.dimension === 'seat')?.rows ?? []).map((row) => [row.seat, row.amounts.usd]))
  return (
    <section aria-label="Historical seat costs">
      <SectionHead name="Historical seat costs" />
      {problem ? <Note tone="warn">{problem}</Note> : !report ? <Note>Reading recorded usage…</Note> : <Rows>{historical.length === 0 ? <Row title="No historical Seats were recorded" desc="Unknown historical usage stays unassigned." /> : historical.map((seat) => <Row key={seat.id} title={seat.seatLabel} desc={seat.briefDigest ? 'Recorded brief cohort' : 'Brief cohort unavailable'} control={<RowValue>{metricWords(seatAmounts.get(seat.id) ?? { ...report.totals.usd, value: null, quality: 'unknown', coverage: 'none' }, report.sources, Date.now()).value}</RowValue>} />)}</Rows>}
      <Note>This history is read-only. Ordering seats remains an explicit local action.</Note>
      <Button size="sm" variant="outline" disabled={!comparable || ordering} title={comparable ? 'Review a local order from comparable historical seats.' : 'Two current candidates need a shared recorded brief and completed Goal.'} onClick={() => void review()}>Order by cost</Button>
      {orderProblem && !preview ? <Note tone="warn">{orderProblem}</Note> : null}
      {preview && <Dialog title="Review local seat order" onClose={() => setPreview(null)} footer={<><Button disabled={!preview.stamp || applying} onClick={() => void apply()}>{applying ? 'Saving…' : 'Apply order'}</Button><Button variant="secondary" disabled={applying} onClick={() => setPreview(null)}>Cancel</Button></>}>
        <Note>This changes the order on this machine for this Agent ID.</Note>
        <Rows><Row title="Current order" control={<RowValue>{preview.labels.join(', ')}</RowValue>} /><Row title="Proposed order" control={<RowValue>{preview.proposed.map((seat) => seat.model ?? seat.runtime).join(', ')}</RowValue>} /><Row title="Recorded cost" desc={metricWords(preview.report.leftPerGoalUsd, preview.report.sources, Date.now()).source} control={<RowValue>{metricWords(preview.report.leftPerGoalUsd, preview.report.sources, Date.now()).value}</RowValue>} /></Rows>
        {preview.reason ? <Note tone="warn">{preview.reason}</Note> : null}{orderProblem ? <Note tone="warn">{orderProblem}</Note> : null}
      </Dialog>}
    </section>
  )
}
