import { useEffect, useRef, useState } from 'react'
import type { FindingRunView, FlowExecution, TriggerGoalStatus, TriggerPreferences, TriggerView } from '@harnessdesk/protocol'
import { ActionError, Button, Chip, EmptyState, PageHead, PanelFilter, PanelFooter, PanelPill, PaneColumn, Table, TableBody, TableCell, TableHead, TableHeader, TableRow, Text } from '../design'
import { elapsedSince } from '../lib/clock'
import { formatMeterUsd, originSubject, triggerGroupingWords } from '../lib/intake'
import { sanitizeHtml } from '../lib/sanitize'
import { formatAge } from '../lib/usage'
import type { FindingsListState } from '../lib/findings'
import { useSnapshot, useStore } from '../state/context'
import { ChevronIcon } from './Icons'
import { formatDuration } from './TurnTail'

const words = (value: string): string => {
  const box = document.createElement('template')
  box.innerHTML = sanitizeHtml(value)
  return box.content.textContent ?? ''
}

/** Consent and the daily cap are machine facts, separate from a Run's state. */
export const useTeamTrigger = (root: string, id: string | null) => {
  const store = useStore()
  const snapshot = useSnapshot()
  const revision = snapshot.triggerRevisions[root]
  const [read, setRead] = useState<{ root: string; id: string; view: TriggerView | null; prefs: TriggerPreferences | null } | null>(null)
  const [problem, setProblem] = useState<{ root: string; id: string; text: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const [refresh, setRefresh] = useState(0)
  useEffect(() => {
    if (!id) return
    let live = true
    const load = async () => {
      try {
        const [project, prefs] = await Promise.all([store.projectTriggers(root), store.triggerPreferences()])
        if (live) {
          setRead({ root, id, view: project.triggers.find(one => one.id === id) ?? null, prefs })
          setProblem(null)
        }
      } catch (error) {
        if (live) {
          setRead(null)
          setProblem({ root, id, text: error instanceof Error ? error.message : String(error) })
        }
      }
    }
    void load()
    const timer = window.setInterval(() => void load(), 60_000)
    return () => { live = false; window.clearInterval(timer) }
  }, [store, root, id, revision, refresh])
  const current = read?.root === root && read.id === id ? read : null
  const pushed = snapshot.triggerPreferences
  const prefs = pushed && current?.prefs && pushed.revision > current.prefs.revision ? pushed : current?.prefs ?? null
  return {
    view: current?.view ?? null, ready: current !== null, prefs, busy,
    problem: problem?.root === root && problem.id === id ? problem.text : null,
    pause: async () => {
      if (!prefs || !id || busy) return
      setBusy(true)
      try {
        await store.setTriggerPreferences(prefs.revision, !prefs.paused, prefs.dailyUsd)
        setRefresh(one => one + 1)
      } catch (error) {
        setProblem({ root, id, text: error instanceof Error ? error.message : String(error) })
      } finally { setBusy(false) }
    },
  }
}

export const teamTriggerLabel = (status: TriggerGoalStatus | null, view: TriggerView | null, compact = false): string => {
  const source = view?.definition?.on.kind ?? status?.source
  if (source === 'pull-request') return compact ? 'Every PR' : 'Every pull request'
  if (source === 'issue') return 'Every issue'
  if (source === 'schedule') {
    if (compact) return 'Schedule'
    const on = view?.definition?.on
    return on?.kind === 'schedule' ? `Every ${on.everyMinutes} minutes` : 'On a schedule'
  }
  return compact ? 'Trigger' : 'Project trigger'
}

const stateOf = (run: FlowExecution) => run.state === 'stalled' || run.end?.kind === 'budget' || run.end?.kind === 'unrouted'
  ? 'Needs you' : run.state === 'settled' ? 'Settled' : run.state === 'stopped' ? 'Stopped' : 'Running'

/** The Team's recorded Runs; opening one retains this page and its filters. */
export const TeamRuns = ({ runs, findings, ledger, origin, trigger, problem, onOpen, onEdit, onRunVisibility, active }: {
  runs: readonly FlowExecution[]
  findings: ReadonlyMap<string, FindingRunView>
  ledger: FindingsListState | undefined
  origin: TriggerGoalStatus | null
  trigger: ReturnType<typeof useTeamTrigger>
  problem: string | null
  onOpen: (run: string) => void
  onEdit: () => void
  onRunVisibility: (run: string, visible: boolean) => void
  active: boolean
}) => {
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState('All')
  const [now, setNow] = useState(Date.now)
  const viewport = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60_000)
    return () => window.clearInterval(timer)
  }, [])
  const ordered = [...runs].sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0) || b.id.localeCompare(a.id))
  const title = (run: FlowExecution) => {
    const subject = origin && originSubject(origin)
    const fallback = subject && origin?.source !== 'schedule'
      ? `${origin?.source === 'issue' ? 'Issue' : 'Pull request'} ${subject}` : run.document.flow.name
    return words(run.target?.label ?? fallback)
  }
  const detail = (run: FlowExecution) => {
    const number = runs.findIndex(one => one.id === run.id) + 1
    const pr = run.target?.pr
    const subject = pr ? `pull request #${pr}` : origin ? originSubject(origin) : null
    return `Run ${number}${subject ? ` · ${pr ? subject : origin?.source === 'issue' ? `issue ${subject}` : `pull request ${subject}`}` : ''}`
  }
  const reviewers = (run: FlowExecution) => {
    // finding/run.open belongs to the whole Goal, including its other Runs.
    // Only a complete ledger read can attribute a count to this start.
    const complete = ledger?.filter === 'all' && ledger.totals !== null && ledger.next === null
      && !ledger.loading && !ledger.loadingMore && !ledger.stale && !ledger.error && !ledger.problem
    const count = complete ? ledger.rows.filter(one => one.origin.goal === run.goal && one.origin.run === run.id).length : null
    if (count !== null && count > 0) return `${count} ${count === 1 ? 'finding' : 'findings'}`
    const view = findings.get(run.id)
    if (!view || view.goal !== run.goal || view.run !== run.id) return '—'
    if (view.reviewersFinished !== null && view.reviewersTotal !== null) return `${view.reviewersFinished} of ${view.reviewersTotal} answered`
    return '—'
  }
  const took = (run: FlowExecution) => {
    const until = run.state === 'running' ? now : run.currentEndedAt
    const elapsed = until == null ? null : elapsedSince(run.startedAt, until)
    return elapsed === null ? '—' : `${formatDuration(elapsed)}${run.state === 'running' ? ' so far' : ''}`
  }
  const started = (run: FlowExecution) => {
    const elapsed = elapsedSince(run.startedAt, now)
    return elapsed === null ? '—' : formatAge(run.startedAt!, now)
  }
  const shown = ordered.filter(run => (filter === 'All' || stateOf(run) === filter)
    && `${title(run)} ${detail(run)} ${stateOf(run)}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()))
  const shownRuns = JSON.stringify(shown.map(run => run.id))
  useEffect(() => {
    if (!active || !viewport.current || typeof IntersectionObserver === 'undefined') return
    const visible = new Set<string>()
    const observer = new IntersectionObserver(entries => {
      for (const entry of entries) {
        const run = (entry.target as HTMLElement).dataset.run
        if (!run) continue
        if (entry.isIntersecting && !visible.has(run)) {
          visible.add(run)
          onRunVisibility(run, true)
        } else if (!entry.isIntersecting && visible.delete(run)) {
          onRunVisibility(run, false)
        }
      }
    }, { root: viewport.current })
    viewport.current.querySelectorAll<HTMLElement>('[data-run]').forEach(row => observer.observe(row))
    return () => {
      observer.disconnect()
      for (const run of visible) onRunVisibility(run, false)
    }
  }, [active, onRunVisibility, shownRuns])
  const today = new Date(now).toISOString().slice(0, 10)
  const todayCount = runs.filter(run => run.startedAt != null && new Date(run.startedAt).toISOString().slice(0, 10) === today).length
  const prefs = trigger.prefs
  const daily = prefs ? `${prefs.chargedUsd === null || prefs.day !== today ? 'Unknown spend' : formatMeterUsd(prefs.chargedUsd)} of ${formatMeterUsd(prefs.dailyUsd)} daily cap` : 'Daily cap unavailable'
  const facts = `${runs.length} ${runs.length === 1 ? 'Run' : 'Runs'} · ${todayCount} today (UTC) · ${daily}${ordered[0] ? ` · Last started ${started(ordered[0])}` : ''}`
  return <PaneColumn ref={viewport} inset="reading" page data-slot="team-runs" className="@container/runs flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto">
    <PageHead title="Runs" blurb={facts} actions={<>
      <Button variant="outline" disabled={!prefs || trigger.busy}
        onClick={() => void trigger.pause()}>{prefs?.paused ? 'Resume every trigger' : 'Pause every trigger'}</Button>
      <Button variant="outline" onClick={onEdit}>Edit the trigger</Button>
    </>} />
    <Text role="meta" as="p">Pausing stops watching every source and holds all work started by triggers on this Mac, interrupting its turns and checks. Resuming continues that work and reads what arrived meanwhile; interrupted checks wait for you to run them again.</Text>
    {(problem || trigger.problem) && <ActionError>{problem ?? trigger.problem}</ActionError>}
    <div className="flex flex-wrap items-center gap-2">
      <div className="min-w-0 basis-48"><PanelFilter value={query} placeholder="Filter Runs" onChange={setQuery} /></div>
      {['All', 'Running', 'Needs you', 'Settled', 'Stopped'].map(state => <PanelPill key={state} pressed={filter === state} onClick={() => setFilter(state)}>
        {state} <Text role="meta" numeric>{state === 'All' ? runs.length : runs.filter(run => stateOf(run) === state).length}</Text>
      </PanelPill>)}
    </div>
    <div className="min-w-0">
      <Table variant="framed" inset="row" aria-label="Runs" className="table-auto">
        <TableHeader><TableRow>
          <TableHead className="w-full">{origin?.source === 'pull-request' ? 'Pull request' : 'Run'}</TableHead>
          <TableHead className="hidden @[460px]/runs:table-cell">State</TableHead>
          <TableHead className="hidden @[740px]/runs:table-cell">Reviewers</TableHead>
          <TableHead numeric className="hidden @[520px]/runs:table-cell">Took</TableHead>
          <TableHead numeric aria-sort="descending" className="hidden @[640px]/runs:table-cell">Started</TableHead>
          <TableHead><span className="sr-only">Open Run</span></TableHead>
        </TableRow></TableHeader>
        <TableBody>{shown.map(run => <TableRow key={run.id} data-run={run.id} interactive className="relative isolate"
          onClick={event => { if (!(event.target as Element).closest('button')) onOpen(run.id) }}>
          <TableCell className="max-w-0"><div className="min-w-0">
            <Button variant="row" size="content-min" bordered={false} hoverFill={false} stretched className="block min-w-0 max-w-full"
              aria-label={`Open Run ${runs.findIndex(one => one.id === run.id) + 1}: ${title(run)}`} onClick={() => onOpen(run.id)}>
              <Text role="subject" as="span" className="block" truncate title={title(run)}>{title(run)}</Text>
            </Button>
            <Text role="meta" as="div" className="whitespace-normal [overflow-wrap:anywhere]">{detail(run)}</Text>
            <Text role="meta" as="div" className="@[740px]/runs:hidden whitespace-normal">
              <span className="@[460px]/runs:hidden">{stateOf(run)} · </span>{reviewers(run)}
              <span className="@[520px]/runs:hidden"> · {took(run)}</span>
              <span className="@[640px]/runs:hidden"> · {started(run)}</span>
            </Text>
          </div></TableCell>
          <TableCell className="hidden @[460px]/runs:table-cell"><Chip tone={stateOf(run) === 'Needs you' ? 'warning' : run.state === 'running' ? 'info' : run.state === 'settled' ? 'success' : 'neutral'}>{stateOf(run)}</Chip></TableCell>
          <TableCell className="hidden @[740px]/runs:table-cell"><Text role="meta">{reviewers(run)}</Text></TableCell>
          <TableCell numeric className="hidden @[520px]/runs:table-cell"><Text role="meta" numeric>{took(run)}</Text></TableCell>
          <TableCell numeric className="hidden @[640px]/runs:table-cell"><Text role="meta" numeric title={run.startedAt == null ? undefined : new Date(run.startedAt).toISOString()}>{started(run)}</Text></TableCell>
          <TableCell><ChevronIcon /></TableCell>
        </TableRow>)}</TableBody>
      </Table>
      {shown.length === 0 && <EmptyState variant="inline" title={runs.length ? 'No Runs match' : 'No Runs yet'} />}
      <PanelFooter left={`${shown.length} ${shown.length === 1 ? 'Run' : 'Runs'}${shown.length === runs.length ? '' : ` of ${runs.length}`}`}
        right={trigger.view?.definition ? triggerGroupingWords(trigger.view.definition.goal) : 'Newest first'} />
    </div>
  </PaneColumn>
}
