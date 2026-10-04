import { useEffect, useMemo, useState, type ComponentProps } from 'react'
import type { InsightReport, SessionKey, TeamSignal } from '@harnessdesk/protocol'
import { useSnapshot, useStore } from '../state/context'
import { hasConversation, teamSeats } from '../lib/team-seats'
import { teamSeatCost } from '../lib/team-overview'
import { answerStep } from '../state/needs-you'
import type { FindingsListState } from '../lib/findings'
import { RunWorkspace } from './RunWorkspace'
import { RunView } from './RunView'
import type { RunTimelineInput } from '../lib/run-timeline'

/**
 * What the inspector may say of the Goal's findings when none is on show: that they are still `reading`,
 * that the read `failed` or the ledger could not be read whole, or (unset) that every one has been read.
 */
const findingsRead = (list: FindingsListState | undefined): 'reading' | 'failed' | undefined => {
  if (!list) return 'reading'
  if (list.error !== null || list.problem !== null) return 'failed'
  if (list.loadingMore || list.next !== null) return 'reading'
  // A reload keeps what an earlier read found, as the store does for its rows; only a first page still to come knows nothing.
  return list.loading && list.totals === null && list.rows.length === 0 ? 'reading' : undefined
}

/** Reads only while the Run is mounted; the pane's rail owns conversation navigation. */
export const TeamRunView = ({ execution, origin, onOpenSeat, onOpenBoard, ...view }: ComponentProps<typeof RunView> & {
  execution: RunTimelineInput['execution']
  origin: string | null
  onOpenSeat: (key: SessionKey) => void
  /** Where a review step's attempt is chosen; without it a person's step reads as text. */
  onOpenBoard?: () => void
}) => {
  const store = useStore()
  const snapshot = useSnapshot()
  const goal = snapshot.goals.get(execution.goal)
  const team = snapshot.teams.get(execution.goal)
  // The Team's, as the timeline beside this reads them; the Goal's own board only while the Team has not been heard from.
  const cards = team?.intents ?? goal?.board.intents ?? []
  // The room asks for all of the findings; the Findings tab may be holding another filter's list, which is not them.
  const listed = snapshot.findings.get(execution.goal)
  const findingsList = listed?.filter === 'all' ? listed : undefined
  const seats = useMemo(() => teamSeats(goal, team, execution, 'seat'), [goal, team, execution])
  const [report, setReport] = useState<InsightReport | null>(null)
  const [readAgain, setReadAgain] = useState(0)
  const [readProblem, setReadProblem] = useState<string | null>(null)
  const finished = cards.filter(card => card.state === 'done').map(card => card.id).join(',')
  useEffect(() => {
    let active = true
    setReadProblem(null)
    const read = () => {
      // The last report stays on screen while the next is read, and when that read fails: a cost is "Not recorded"
      // only when none was ever read. A report of another Goal is never shown (below), so none is cleared here.
      if (typeof store.readGoalInsight === 'function') void store.readGoalInsight(execution.goal).then(value => { if (active) setReport(value) }, () => {})
      if (execution.findings && typeof store.loadFindingRun === 'function') void store.loadFindingRun(execution.goal, execution.id).then(() => { if (active) setReadProblem(null) }, () => { if (active) setReadProblem('Review details could not be read.') })
    }
    read()
    const timer = execution.state === 'running' ? window.setInterval(read, 60_000) : null
    return () => { active = false; if (timer !== null) window.clearInterval(timer) }
  }, [store, execution.goal, execution.id, execution.state, Boolean(execution.findings), finished, readAgain])
  const usage = report?.goal === execution.goal ? report : null
  const costs = new Map(seats.map(seat => {
    // Usage may know a Seat's runtime even when an older receipt kept no session pointer. It does not grant Open.
    const runtimeId = seat.record.session?.runtime ?? usage?.breakdowns.find(one => one.dimension === 'seat')?.rows
      .find(row => row.goal === execution.goal && row.seat === seat.record.id)?.session?.runtime ??
      usage?.seats.find(record => record.id === seat.record.id)?.session.runtime
    const metered = snapshot.runtimes.find(runtime => runtime.id === runtimeId)?.capabilities.metered
    return [seat.record.id, teamSeatCost({ team: execution.goal, report: usage }, seat.record.id, metered)]
  }))
  const selected = view.model.rows.find(row => row.id === view.selectedRow)
  return <RunWorkspace {...view} onRetry={() => { setReadAgain(was => was + 1); view.onRetry?.() }} problem={view.problem ?? readProblem} inspector={{
    input: { execution, cards, origin,
      signals: (team?.channel ?? goal?.board.channel ?? []).filter((entry): entry is TeamSignal => entry.kind === 'signal'),
      evidence: snapshot.boardEvidence.get(execution.goal),
      findings: findingsList?.rows,
    },
    findingsRead: findingsRead(findingsList),
    // The same requests the board makes, so a card answered or abandoned here is one thing to the host.
    onAbandon: card => store.teamIntent(execution.goal, card, 'abandon'),
    onStop: view.onStop,
    onAnswer: (card, outcome, note) => answerStep(store, execution.goal, card, outcome, note),
    ...(onOpenBoard ? { onOpenBoard } : {}),
    publication: snapshot.findingRuns.get(execution.id)?.rounds.find(round => round.round === selected?.round),
    seats: seats.map(seat => ({ id: seat.record.id, name: seat.name,
      override: goal?.receipt?.members?.find(member => member.seat === seat.record.id)?.seatLabel ?? goal?.members.find(record => record.id === seat.record.id)?.seatLabel,
      cost: costs.get(seat.record.id),
      onOpen: hasConversation(seat) ? () => onOpenSeat(seat.key) : undefined,
    })),
  }} />
}
