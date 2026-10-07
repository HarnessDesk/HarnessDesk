import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Banner, Button, Chip, EmptyState, IconTile, ListRow, PaneColumn, Segmented, Separator, Text, Timeline, TimelineItem, type TimelineState } from '../design'
import { commandShown } from '../lib/projects'
import { openExternal } from '../lib/desktop'
import { commitDate } from '../lib/git-refs'
import { currentRunEnd, type RunTimelineInput, type runTimeline } from '../lib/run-timeline'
import { sanitizeHtml, sanitizeText } from '../lib/sanitize'
import { doingLine, type DoingLine } from '../lib/team-overview'
import { AgentIcon, CheckIcon, ReviewIcon } from './Icons'
import { RetryCheck } from './RetryCheck'
import { formatDuration } from './TurnTail'
import styles from './RunView.module.css'

const words = (value: string): string => {
  const box = document.createElement('template')
  box.innerHTML = sanitizeHtml(value)
  return box.content.textContent ?? ''
}
const states = { running: 'Running', settled: 'Settled', stopped: 'Stopped', stalled: 'Stalled' } as const

/** The two halves of a Run: what happened, and the Flow it was started from. */
export type RunViewTab = 'timeline' | 'flow'
const TABS = [{ value: 'timeline', label: 'Timeline' }, { value: 'flow', label: 'Flow' }] as const

/** Read-only story. Selection belongs to the caller for the later inspector. */
export const RunView = ({ home, model, execution, cost, timelineDetail, number, selectedRow, selectedRows, onSelect, faces, doing, pullRequest, pending = false, problem, onRetry, flow, view, onView, onStop, onRunAgain, onWrap, onBoard, onReviewCheck, runChooser, continuesNumber, onDetails }: {
  home?: string | null
  model: ReturnType<typeof runTimeline>
  execution?: RunTimelineInput['execution']
  /** Recorded Seat costs, qualified by the workspace when any Seat is missing. */
  cost?: string
  /** The standalone preview's inspector; the real workbench owns its sibling dock. */
  timelineDetail?: ReactNode
  number: number
  selectedRow: string | null
  selectedRows?: readonly string[]
  onSelect: (id: string) => void
  faces?: ReadonlyMap<string, ReactNode>
  doing?: ReadonlyMap<string, string | null>
  pullRequest?: { number: number; url: string } | null
  pending?: boolean
  problem?: string | null
  onRetry?: () => void
  /** The Flow this Run started with, drawn: with it, the header offers it beside the timeline. */
  flow?: ReactNode
  /** Which half shows, when the caller chooses it; left out, the view keeps it itself. */
  view?: RunViewTab
  onView?: (view: RunViewTab) => void
  onStop?: (() => void) | undefined
  onRunAgain?: () => void
  onWrap?: () => void
  onBoard?: () => void
  onReviewCheck?: () => void
  runChooser?: ReactNode
  /** Opens the Run summary from its header tool row. */
  onDetails?: () => void
  continuesNumber?: number
}) => {
  const [kept, keep] = useState<RunViewTab>('timeline')
  // Consent belongs to the Run view: an ending removes the row's retry control.
  const [retry, setRetry] = useState<{ run: string; card: number } | null>(null)
  useEffect(() => setRetry(null), [model.header.run])
  const showing: RunViewTab = flow ? view ?? kept : 'timeline'
  const [now, setNow] = useState(Date.now)
  const held = useRef(new Map<string, DoingLine>())
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [])
  const header = model.header
  const showView = (next: RunViewTab) => { if (view === undefined) keep(next); onView?.(next) }
  const ending = model.rows.find(row => row.kind === 'end')
  const waiting = !header.end ? model.rows.find(row => row.kind === 'person' && row.attention) : undefined
  const needsYou = header.needsYou || Boolean(waiting)
  const need = waiting ?? ending ?? model.rows.find(row => row.attention)
  const endActions = (primary = false) => header.end ? <>
    {header.end.kind === 'complete' && onWrap && <Button size="sm" variant={primary ? "default" : "outline"} onClick={onWrap}>Wrap</Button>}
    {header.interruptedCheck !== null && onReviewCheck ? <Button size="sm" variant={primary ? "default" : "outline"} onClick={onReviewCheck}>Review and run again…</Button>
      : header.end.kind !== 'complete' && onRunAgain ? <Button size="sm" variant={primary ? "default" : "outline"} onClick={onRunAgain}>Run again…</Button> : null}
    {header.end.kind === 'unrouted' && onBoard && <Button size="sm" variant="outline" onClick={onBoard}>Board</Button>}
  </> : null
  const needActions = header.end ? endActions(true) : waiting ? <Button onClick={() => onSelect(waiting.id)}>Answer…</Button>
    : onDetails ? <Button onClick={onDetails}>Review details</Button> : null
  const started = execution?.startedAt ?? model.rows.find(row => row.kind === 'start')?.since ?? null
  const until = header.state === 'running' ? now : execution ? currentRunEnd(execution) : ending?.since ?? null
  const budget = execution?.findings?.budget
  const extra = execution?.findings?.extraRound
  const limit = budget ? Math.max(budget.rounds, extra ? extra.after + (extra.count ?? 1) : 0) : null
  const round = Math.max(0, ...model.rows.flatMap(row => row.kind === 'round' && row.round !== null ? [row.round] : []))
  const steps: { row: typeof model.rows[number]; records: typeof model.rows }[] = []
  for (const row of model.rows) {
    if (['start', 'brief', 'round', 'end'].includes(row.kind)) steps.push({ row, records: [] })
    else steps.at(-1)?.records.push(row)
  }
  const stepState = (row: typeof model.rows[number], records: typeof model.rows): TimelineState => {
    if (records.some(one => ['Failed', 'Timed out', 'Did not finish', 'fail', 'failed'].includes(one.status ?? ''))) return 'danger'
    if (row.attention || records.some(one => one.attention) || (header.state === 'stalled' && row.kind === 'round' && row.round === round)) return 'warning'
    if (row.working || records.some(one => one.working)) return 'active'
    if (row.kind !== 'round' || execution?.rounds.find(one => one.n === row.round)?.state === 'closed' || row.durationMs !== null) return 'done'
    return 'pending'
  }
  const time = (row: typeof model.rows[number]) => {
    const duration = row.durationMs ?? (row.working && row.since !== null ? Math.max(0, now - row.since) : null)
    const facts = [row.since === null ? null : commitDate(row.since, now), duration === null ? null : `${formatDuration(duration)}${row.working ? ' so far' : ''}`].filter(Boolean)
    return facts.length ? facts.join(' · ') : undefined
  }
  return <div data-slot="run-view" className="flex min-h-0 min-w-0 flex-1 flex-col">
    <PaneColumn inset="reading" page data-slot="run-header" className="flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0 flex-1">
      <div className="flex min-w-0 flex-wrap items-center gap-2">
      <Text role="subject">Run {number}</Text>
      {runChooser}
      <Chip tone={needsYou ? 'warning' : 'neutral'}>{states[header.state]}</Chip>
      {header.publication && <Chip tone={header.publication.tone}>{header.publication.label}</Chip>}
      </div>
      <div data-slot="run-facts" className="mt-1 flex flex-wrap gap-x-3 gap-y-1">
        <Text role="meta" numeric>{started === null ? 'Start not recorded' : `Started ${commitDate(started, now)}`}</Text>
        <Text role="meta" numeric>{started === null || until === null ? 'Elapsed not recorded' : `Elapsed ${formatDuration(Math.max(0, until - started))}`}</Text>
        {round > 0 && <Text role="meta" numeric>Round {round}{limit !== null ? ` of ${limit}` : ''}</Text>}
        <Text role="meta" numeric>{cost ?? 'Cost not recorded'}</Text>
      </div>
      <div className="mt-1 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
      {flow ? <Button data-slot="run-revision" variant="link" size="inline-link" className="min-w-0 whitespace-normal break-words" onClick={() => showView('flow')}>{words(header.flow)}{header.revision ? ` · ${header.revision}` : ''}</Button>
        : <Text role="meta" className="min-w-0 break-words">{words(header.flow)}{header.revision ? ` · ${header.revision}` : ''}</Text>}
      {header.continues && <Text role="meta">Continues {continuesNumber ? `Run ${continuesNumber}` : 'an earlier Run'}</Text>}
      {pullRequest && <Button variant="link" size="inline-link" onClick={() => openExternal(pullRequest.url)}>Open pull request #{pullRequest.number}</Button>}
      {onDetails && <Button variant="link" size="inline-link" onClick={onDetails}>Run details</Button>}
      </div></div>
      <div data-slot="run-actions" className="flex flex-wrap items-center gap-3">
        {header.state === 'running' && onStop && <Button variant="outline" onClick={onStop}>Stop run…</Button>}
        {flow && <Segmented label="Show the Run as" value={showing} options={TABS} onChange={showView} />}
      </div>
    </PaneColumn>
    <Separator />
    <div className="flex min-h-0 min-w-0 flex-1">
    <div data-slot="run-scroll" className="min-h-0 min-w-0 flex-1 overflow-y-auto">
      <PaneColumn inset="reading">
        {needsYou && <div data-slot="run-need" className={styles.need}>
          <Banner tone="warning" title={words(waiting ? waiting.title : need?.title && need.title !== 'Needs you' ? need.title : 'This Run needs your attention')}
            actions={needActions}>
            {words(need?.detail ?? execution?.reason ?? (waiting ? 'Waiting for your answer' : 'Review the recorded details to continue.'))}
          </Banner>
        </div>}
        {showing === 'flow' ? flow : <div data-slot="run-reading" className={styles.reading}>
        {pending && <Text role="meta" as="div">Reading checks and findings…</Text>}
        {problem && <Banner tone="warning" title="Some Run details could not be read">{words(problem)}{onRetry && <Button variant="link" size="inline-link" onClick={onRetry}>Try again</Button>}</Banner>}
        <Timeline aria-label="Run timeline">
          {steps.map(({ row, records }) => {
            const isEnd = row.kind === 'end'
            const reason = needsYou || ['Settled', 'Stopped', 'Needs you', 'Stopped by you', 'Stopped by the desk'].includes(row.title) ? null : words(row.title)
            const detail = isEnd ? !needsYou && (reason || row.detail) ? [reason, row.detail ? words(row.detail) : null].filter(Boolean).join('\n') : undefined : row.detail ? words(row.detail) : undefined
            const actions = isEnd && !needsYou ? endActions() : undefined
            const meta = [time(row), isEnd && header.end?.kind === 'stopped' ? header.end.by === 'person' ? 'By you' : 'By the desk' : null].filter(Boolean).join(' · ') || undefined
            return <TimelineItem key={row.id} state={stepState(row, records)} data-row={row.id} data-kind={row.kind}
              {...(isEnd ? { 'data-slot': 'run-ending' } : {})}
              meta={meta} title={isEnd ? 'End' : words(row.title)} detail={detail}
              selected={selectedRow === row.id || selectedRows?.includes(row.id)} onSelect={() => onSelect(row.id)} actions={actions}>
              {records.length ? records.map(row => {
                if (row.kind === 'attempt') return <ListRow key={row.id} density="compact" data-row={row.id} data-kind="attempt" wrapTitle selected={selectedRows?.includes(row.id)}
                  lead={<IconTile size="sm" aria-hidden className="invisible" />}
                  title={<span className="flex min-w-0 flex-wrap items-center gap-2">
                    <Text role="meta" className="min-w-0 break-words whitespace-normal [overflow-wrap:anywhere]">{words(row.title)}</Text>
                    {row.status && <Chip tone="neutral">{words(row.status)}</Chip>}
                    {row.since !== null && <Text role="meta" numeric>{commitDate(row.since, now)}</Text>}
                  </span>} />
                const previous = held.current.get(row.id) ?? null
                const next = row.working && row.seat ? doing?.get(row.seat) ?? null : null
                const line = doingLine(previous, next, now)
                held.current.set(row.id, line)
                const duration = row.durationMs ?? (row.working && row.since !== null ? Math.max(0, now - row.since) : null)
                const rest = row.status === 'Done' || row.status === 'Abandoned' || row.status === 'Stopped' || row.status === 'Waiting' || row.status === 'Result unavailable'
                const selectedChip = selectedRow === row.id && !row.attention
                const status = row.status && !(needsYou && row.attention && row.status === 'Needs you') && (rest ? <Text role="meta">{row.status}</Text> : <Chip tone={row.attention ? 'warning' : 'neutral'} variant={selectedChip ? 'outline' : 'default'} emphasis={selectedChip}>{words(row.status)}</Chip>)
                const title = <span className="flex min-w-0 flex-wrap items-center gap-2">
                  <Text title={row.kind === 'check' ? sanitizeText(row.title) : undefined} role="row" className="min-w-0 break-words whitespace-normal [overflow-wrap:anywhere]">{words(row.kind === 'check' ? commandShown(row.title, home) : row.title)}</Text>
                  {status}
                  {row.publication && <Chip tone={row.publication.tone}>{row.publication.label}</Chip>}
                  {duration !== null && <Text role="meta" numeric>{formatDuration(duration)}{row.working ? ' so far' : ''}</Text>}
                </span>
                // The retry is a trailing control; the row remains keyboard-selectable without nesting buttons.
                const again = row.kind === 'check' && row.card !== null && row.retryRefusal === null
                const item = <ListRow density="compact" wrapTitle data-row={row.id} data-kind={row.kind} as={again ? "div" : "button"} interactive selected={selectedRow === row.id || selectedRows?.includes(row.id)}
                  onClick={event => { if (!event.currentTarget.contains(event.target as Node)) return; if (!(event.target as Element).closest('[data-slot="list-row-trail"]') && (!again || !(event.target as Element).closest('button'))) onSelect(row.id) }} title={again ? <Button stretched hoverFill={false} variant="row" size="content-min" bordered={false} onClick={() => onSelect(row.id)}>{title}</Button> : title}
                  trail={again ? <Button variant="link" size="xs" onClick={() => setRetry({ run: header.run, card: row.card! })}>Run again…</Button> : undefined}
                  className={again ? 'relative isolate min-w-0' : 'min-w-0'}
                  lead={row.kind === 'card' ? <IconTile shape="face" size="sm">{row.seat ? faces?.get(row.seat) ?? <AgentIcon /> : <AgentIcon />}</IconTile>
                    : row.kind === 'check' ? <IconTile size="sm"><CheckIcon /></IconTile>
                    : row.kind === 'findings' ? <IconTile size="sm"><ReviewIcon /></IconTile> : undefined}
                  subtitle={(row.detail || (row.working && line.line)) ? <span data-slot="run-detail" className="whitespace-pre-line">{words(row.detail ?? line.line ?? '')}</span> : undefined}
                  wrapSubtitle />
                return <div key={row.id} className="contents">{item}</div>
              }) : undefined}
            </TimelineItem>
          })}
        </Timeline>
        {!model.rows.some(row => row.kind === 'round') && <EmptyState title="No rounds have opened yet" />}
        </div>}
      </PaneColumn>
    </div>
    {retry?.run === header.run && <RetryCheck run={retry.run} card={retry.card}
      refusal={model.rows.find(row => row.kind === 'check' && row.card === retry.card)?.retryRefusal ?? null}
      onClose={() => setRetry(null)} />}
    {showing === 'timeline' && timelineDetail}
    </div>
  </div>
}
