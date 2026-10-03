import { useEffect, useMemo, useState, type ComponentProps } from 'react'
import type { InsightReport, SessionKey, TeamSignal } from '@harnessdesk/protocol'
import { useSnapshot, useStore } from '../state/context'
import { teamSeats } from '../lib/team-seats'
import { teamOverview } from '../lib/team-overview'
import { RunWorkspace } from './RunWorkspace'
import { RunView } from './RunView'
import type { RunTimelineInput } from '../lib/run-timeline'

/** Reads only while the Run is mounted; the pane's rail owns conversation navigation. */
export const TeamRunView = ({ execution, origin, onOpenSeat, ...view }: ComponentProps<typeof RunView> & {
  execution: RunTimelineInput['execution']
  origin: string | null
  onOpenSeat: (key: SessionKey) => void
}) => {
  const store = useStore()
  const snapshot = useSnapshot()
  const goal = snapshot.goals.get(execution.goal)
  const team = snapshot.teams.get(execution.goal)
  const cards = goal?.board.intents ?? team?.intents ?? []
  const seats = useMemo(() => teamSeats(goal, team, execution), [goal, team, execution])
  const [report, setReport] = useState<InsightReport | null>(null)
  const [readProblem, setReadProblem] = useState<string | null>(null)
  const finished = cards.filter(card => card.state === 'done').map(card => card.id).join(',')
  useEffect(() => {
    let active = true
    setReport(null)
    setReadProblem(null)
    const read = () => {
      if (typeof store.readGoalInsight === 'function') void store.readGoalInsight(execution.goal).then(value => { if (active) setReport(value) }, () => { if (active) setReport(null) })
      if (execution.findings && typeof store.loadFindingRun === 'function') void store.loadFindingRun(execution.goal, execution.id).catch(() => { if (active) setReadProblem('Review details could not be read.') })
    }
    read()
    const timer = execution.state === 'running' ? window.setInterval(read, 60_000) : null
    return () => { active = false; if (timer !== null) window.clearInterval(timer) }
  }, [store, execution.goal, execution.id, execution.state, Boolean(execution.findings), finished])
  const costs = teamOverview({ team: execution.goal, cards, report: report?.goal === execution.goal ? report : null,
    seats: seats.map(seat => ({ record: seat.record, name: seat.name, runtime: snapshot.runtimes.find(runtime => runtime.id === seat.record.session.runtime) ?? null, session: null, unreadSince: null, approvals: [] })),
    run: { execution, startedAt: execution.startedAt ?? null },
  })
  const selected = view.model.rows.find(row => row.id === view.selectedRow)
  return <RunWorkspace {...view} problem={view.problem ?? readProblem} inspector={{
    input: { execution, cards, origin,
      signals: (goal?.board.channel ?? team?.channel ?? []).filter((entry): entry is TeamSignal => entry.kind === 'signal'),
      evidence: snapshot.boardEvidence.get(execution.goal),
      findings: snapshot.findings.get(execution.goal)?.filter === 'all' ? snapshot.findings.get(execution.goal)?.rows : [],
    },
    publication: snapshot.findingRuns.get(execution.id)?.rounds.find(round => round.round === selected?.round),
    seats: seats.map(seat => ({ id: seat.record.id, name: seat.name,
      override: goal?.members.find(record => record.id === seat.record.id)?.seatLabel,
      cost: costs.seats.find(row => row.seat === seat.record.id)?.cost,
      onOpen: () => onOpenSeat(seat.key),
    })),
  }} />
}
