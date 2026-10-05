import { useEffect, useState } from 'react'
import type { InsightDimension, InsightReport, RuntimeId } from '@harnessdesk/protocol'

import { metricWords } from '../lib/insight'
import { useSnapshot, useStore } from '../state/context'
import { Banner, Button, Chip, EmptyState, IconTile, Note, Row, Rows, Table, TableBody, TableCell, TableFooter, TableHead, TableHeader, TableRow, Text } from '../design'
import { GoalIcon, ArrowRightIcon } from './Icons'

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
  readonly onShorterRange?: () => void
}

export const InsightUsage = ({ root, runtime, view, onGoal, report: suppliedReport, problem: suppliedProblem, onShorterRange }: InsightUsageProps) => {
  const snapshot = useSnapshot()
  const [days, setDays] = useState(30)
  const store = useStore(); const [ownReport, setOwnReport] = useState<InsightReport | null>(null); const [ownProblem, setOwnProblem] = useState<string | null>(null)
  const owned = suppliedReport === undefined
  useEffect(() => {
    if (!owned) return
    setOwnReport(null); setOwnProblem(null)
    if (!root) return
    let current = true; const to = Date.now(); const from = to - days * 86_400_000
    void store.readUsageInsight({ root, from, to, ...(runtime ? { runtime } : {}) }).then((next) => { if (current) setOwnReport(next) }).catch((error: unknown) => { if (current) setOwnProblem(error instanceof Error ? error.message : 'Recorded usage could not be read.') })
    return () => { current = false }
  }, [store, root, runtime, owned, days])
  const report = owned ? ownReport : (suppliedReport ?? null)
  const problem = owned ? ownProblem : (suppliedProblem ?? null)
  const [readTeams, setReadTeams] = useState<ReadonlySet<string>>(new Set())
  useEffect(() => {
    if (!report || !root) return
    let current = true
    setReadTeams(new Set())
    void (async () => {
      try {
        if (!store.loadGoals || !store.loadTeamRuns) return
        await store.loadGoals(root)
        const ids = [...new Set([...report.seats.flatMap(seat => seat.board ? [seat.board] : []), ...report.breakdowns.flatMap(b => b.rows.flatMap(row => row.goal ? [row.goal] : []))])]
        const loaded = new Set<string>()
        for (const id of ids) { await store.loadTeamRuns(id); loaded.add(id) }
        if (current) setReadTeams(loaded)
      } catch { /* Names already read remain usable; unread counts stay a dash. */ }
    })()
    return () => { current = false }
  }, [store, report, root])
  if (!root) return <Note>Choose a project to see its Goals.</Note>
  if (problem) return <Note tone="warn">{problem}</Note>
  if (!report) return <Note>Reading recorded usage…</Note>
  const dimension: InsightDimension = view
  const breakdown = report.breakdowns.find((entry) => entry.dimension === dimension)
  const failedSources = report.sources.filter((source) => source.problem !== null)
  const hasAmounts = report.totals.usd.value !== null || (breakdown?.rows.some(row => row.amounts.usd.value !== null) ?? false) || breakdown?.unattributed.usd.value != null
  const unknown = !hasAmounts || report.scan === 'partial'
  const scanGap = report.gaps.find(gap => gap.startsWith('Insight stopped'))
  const reason = scanGap?.replace(/^Insight stopped/, 'Reading stopped').replace(/\. Choose a narrower range\.$/, '') ?? report.totals.usd.missing[0] ?? failedSources[0]?.problem ?? 'The sources do not report amounts for this range.'
  const shorter = () => { if (onShorterRange) onShorterRange(); else if (owned) setDays(1) }
  const cost = (value: InsightReport['totals']['usd']) => {
    const words = metricWords(value, report.sources, Date.now())
    return <Text as="div" role="value" align="end" numeric title={[words.qualifier, words.coverage, words.source, words.freshness].filter(Boolean).join(' · ')}>{value.value === null ? <Text role="meta">—</Text> : <>{words.value}{words.qualifier && <Text as="div" role="meta">{words.qualifier}</Text>}</>}</Text>
  }
  return <>
    {unknown ? <Banner tone="warning" title="Amounts are unknown for this range" actions={(owned || onShorterRange) && <Button variant="outline" size="sm" onClick={shorter}>Last 24 hours</Button>}>{reason}</Banner> : null}
    {!breakdown || breakdown.rows.length === 0 ? <Rows><EmptyState variant="row" title={!breakdown ? `Recorded usage has no ${view} attribution.` : view === 'goal' ? 'No Goal usage was recorded' : 'No Agent usage was recorded'} description={breakdown?.reason ?? 'Unknown historical usage remains unassigned.'} /></Rows> : null}
    {breakdown && <Table variant="framed" className="table-fixed">
      <TableHeader><TableRow>
        <TableHead className="w-1/2">{view === 'goal' ? 'Goal' : 'Agent'}</TableHead>
        <TableHead numeric>Runs</TableHead><TableHead numeric>Seats</TableHead>
        {hasAmounts && <TableHead numeric>Cost</TableHead>}
        {view === 'goal' && <TableHead className="w-12"><span className="sr-only">Open</span></TableHead>}
      </TableRow></TableHeader>
      <TableBody>{breakdown.rows.map(row => {
        const goal = row.goal ? snapshot.goals.get(row.goal) : undefined
        const seats = report.seats.filter(seat => view === 'goal' ? seat.board === row.goal : seat.agent !== null && row.key === `agent:${seat.agent.origin}:${seat.agent.id}`)
        const teams = new Set(view === 'goal' && row.goal ? [row.goal] : seats.flatMap(seat => seat.board ? [seat.board] : []))
        const executions = [...snapshot.flowExecutions.values()].filter(run => teams.has(run.goal))
        const latest = executions.sort((a,b) => (b.startedAt ?? 0) - (a.startedAt ?? 0))[0]
        const name = view === 'goal' ? goal?.board.name ?? `Goal ${row.goal ?? row.key}` : row.label
        const branch = row.goal ? snapshot.lanes.find(lane => lane.goal === row.goal)?.branch ?? latest?.base?.branch : null
        const facts = view === 'goal' && goal ? [`Team ${goal.board.name}`, latest ? `${latest.document.flow.name} flow` : null, branch ? `branch ${branch}` : null].filter(Boolean).join(' · ') : null
        const runs = teams.size > 0 && [...teams].every(team => readTeams.has(team)) && executions.every(run => run.startedAt !== undefined) ? executions.filter(run => run.startedAt! >= report.query.from && run.startedAt! <= report.query.to && (view === 'goal' || run.rounds.some(round => round.seats.some(id => seats.some(seat => seat.id === id))))).length : null
        const open = view === 'goal' && row.goal ? () => onGoal(row.goal!) : null
        return <TableRow key={row.key} interactive={open !== null} onClick={open ?? undefined}>
          <TableCell lead={view === 'goal' ? <IconTile shape="face" tone="neutral"><GoalIcon /></IconTile> : undefined}>
            <div className="min-w-0 flex-1"><Text as="div" role="subject" truncate>{name}</Text>
            {facts && <Text as="div" role="meta" truncate title={facts}>{facts}</Text>}</div>
          </TableCell>
          <TableCell numeric><Text role="muted" numeric>{runs ?? '—'}</Text></TableCell>
          <TableCell numeric><Text role="muted" numeric>{seats.length}</Text></TableCell>
          {hasAmounts && <TableCell numeric>{cost(row.amounts.usd)}</TableCell>}
          {view === 'goal' && <TableCell align="end">{open && <Button variant="ghost" size="icon-sm" aria-label={`Open ${name}`} onClick={event => { event.stopPropagation(); open() }}><ArrowRightIcon size={14} /></Button>}</TableCell>}
        </TableRow>
      })}</TableBody>
      <TableFooter variant="plain"><TableRow>
        <TableCell colSpan={3} title={breakdown.reason ?? 'No unique historical Seat could be established.'}><Text role="muted">{view === 'goal' ? 'Not attributed to a Goal' : 'Not attributed to an Agent'}</Text></TableCell>
        {hasAmounts && <TableCell numeric>{cost(breakdown.unattributed.usd)}</TableCell>}
        {view === 'goal' && <TableCell />}
      </TableRow></TableFooter>
    </Table>}
    {failedSources.length > 0 && <Rows>{failedSources.map(source => <Row key={source.id} title={source.label} desc={source.problem ?? undefined} control={<Chip tone="warning">Unavailable</Chip>} />)}</Rows>}
    {report.gaps.filter(gap => gap !== scanGap).map(gap => <Note key={gap} tone="warn">{gap}</Note>)}
  </>
}
