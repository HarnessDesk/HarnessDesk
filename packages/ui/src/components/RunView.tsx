import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Banner, Button, Chip, EmptyState, IconTile, ListRow, ListRows, PaneColumn, Segmented, Separator, Text, TextMark } from '../design'
import { commandShown } from '../lib/projects'
import { openExternal } from '../lib/desktop'
import { commitDate } from '../lib/git-refs'
import { currentRunEnd, type RunTimelineInput, type runTimeline } from '../lib/run-timeline'
import { sanitizeHtml, sanitizeText } from '../lib/sanitize'
import { doingLine, type DoingLine } from '../lib/team-overview'
import { AgentIcon, CheckIcon, PlanIcon } from './Icons'
import { RunAgain } from './RetryCheck'
import { formatDuration } from './TurnTail'
import styles from './RunView.module.css'

const words = (value: string): string => {
  const box = document.createElement('template')
  box.innerHTML = sanitizeHtml(value)
  return box.content.textContent ?? ''
}
const states = { running: 'Running', settled: 'Settled', stopped: 'Stopped', stalled: 'Stalled' } as const
const clockTime = (at: number) => new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })

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
  const waiting = model.rows.find(row => row.kind === 'person' && row.attention)
  const needsYou = header.needsYou || Boolean(waiting)
  const need = waiting ?? ending ?? model.rows.find(row => row.attention)
  const recovery = header.interruptedCheck !== null && onReviewCheck
    ? { label: 'Review and run again…', act: onReviewCheck }
    : waiting ? { label: 'Answer…', act: () => onSelect(waiting.id) }
      : header.end && header.end.kind !== 'complete' && onRunAgain ? { label: 'Run again…', act: onRunAgain }
        : onDetails ? { label: 'Review details', act: onDetails } : null
  const started = execution?.startedAt ?? model.rows.find(row => row.kind === 'start')?.since ?? null
  const until = header.state === 'running' ? now : execution ? currentRunEnd(execution) : ending?.since ?? null
  const budget = execution?.findings?.budget
  const extra = execution?.findings?.extraRound
  const limit = budget ? Math.max(budget.rounds, extra ? extra.after + (extra.count ?? 1) : 0) : null
  const round = Math.max(0, ...model.rows.flatMap(row => row.kind === 'round' && row.round !== null ? [row.round] : []))
  const entry = (row: typeof model.rows[number], item: ReactNode) => <div key={row.id} data-slot="run-entry" className={styles.entry}>
    <div data-slot="run-time" data-time-for={row.id} className={styles.time}>
      {row.kind === 'round' && <>
        <Text role="muted" ink="secondary" weight="medium" numeric>{row.since === null ? 'Unknown' : clockTime(row.since)}</Text>
        <Text role="meta" numeric tone={row.working ? 'warning' : undefined}>{row.working ? 'now' : row.durationMs !== null ? formatDuration(row.durationMs) : '—'}</Text>
      </>}
    </div>
    <div className={styles.rail} aria-hidden="true">
      <Separator orientation="vertical" className="absolute inset-y-0" />
      {(row.kind === 'round' || row.kind === 'start' || row.kind === 'end') && <TextMark role="meta" className={styles.marker}>●</TextMark>}
    </div>
    {item}
  </div>
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
        <Text role="meta" numeric>{started === null ? 'Start not recorded' : `Started ${clockTime(started)}`}</Text>
        <Text role="meta" numeric>{started === null || until === null ? 'Elapsed not recorded' : `Elapsed ${formatDuration(Math.max(0, until - started))}`}</Text>
        <Text role="meta" numeric>Round {round}{limit !== null ? ` of ${limit}` : ''}</Text>
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
            actions={<>{header.end?.kind === 'unrouted' && onBoard && <Button variant="outline" onClick={onBoard}>Board</Button>}
              {recovery && <Button onClick={recovery.act}>{recovery.label}</Button>}</>}>
            {words(need?.detail ?? execution?.reason ?? 'Review the recorded details to continue.')}
          </Banner>
        </div>}
        {showing === 'flow' ? flow : <div data-slot="run-reading" className={styles.reading}>
        {pending && <Text role="meta" as="div">Reading checks and findings…</Text>}
        {problem && <Banner tone="warning" title="Some Run details could not be read">{words(problem)}{onRetry && <Button variant="link" size="inline-link" onClick={onRetry}>Try again</Button>}</Banner>}
        <ListRows aria-label="Run timeline">
          {model.rows.map(row => {
            if (row.kind === 'end') {
              // Status and aggregate publication belong to the header. The ending
              // keeps only its reason, time and doors; each round keeps its own posting.
              const reason = needsYou || ['Settled', 'Stopped', 'Needs you', 'Stopped by you', 'Stopped by the desk'].includes(row.title) ? null : words(row.title)
              const message = <div className="whitespace-pre-line">
                {reason && <Text role="row" as="div">{reason}</Text>}
                {!needsYou && row.detail && <span>{words(row.detail)}</span>}
              </div>
              const actions = needsYou ? [] : [
                header.end?.kind === 'complete' && onWrap ? <Button key="wrap" size="sm" variant="outline" onClick={onWrap}>Wrap</Button> : null,
                header.interruptedCheck !== null && onReviewCheck ? <Button key="again" size="sm" variant="outline" onClick={onReviewCheck}>Review and run again…</Button>
                  : header.end && header.end.kind !== 'complete' && onRunAgain ? <Button key="again" size="sm" variant="outline" onClick={onRunAgain}>Run again…</Button> : null,
                header.end?.kind === 'unrouted' && onBoard ? <Button key="board" size="sm" variant="outline" onClick={onBoard}>Board</Button> : null,
              ].filter(Boolean)
              return entry(row, <div data-slot="run-ending">
                <ListRow wrapTitle data-row={row.id} data-kind="end" selected={selectedRow === row.id || selectedRows?.includes(row.id)}
                  title={<span className="flex flex-wrap items-center gap-2">
                    <Button variant="link" size="inline-link" onClick={() => onSelect(row.id)}>End</Button>
                    {row.since !== null && <Text role="meta">{commitDate(row.since, now)}</Text>}
                    {header.end?.kind === 'stopped' && <Text role="meta">{header.end.by === 'person' ? 'By you' : 'By the desk'}</Text>}
                  </span>}
                  subtitle={!needsYou && (reason || row.detail) ? message : undefined}
                  wrapSubtitle
                  meta={actions.length > 0 ? <div className="flex flex-wrap gap-2">{actions}</div> : undefined} />
              </div>)
            }
            // What a check ran each time, drawn once it has run more than once: plain rows under their check; the check's inspector holds the output.
            if (row.kind === 'attempt') return entry(row, <ListRow data-row={row.id} data-kind="attempt" wrapTitle selected={selectedRows?.includes(row.id)}
              lead={<IconTile size="sm" aria-hidden className="invisible" />}
              title={<span className="flex min-w-0 flex-wrap items-center gap-2">
                <Text role="meta" className="min-w-0 break-words whitespace-normal [overflow-wrap:anywhere]">{words(row.title)}</Text>
                {row.status && <Chip tone="neutral">{words(row.status)}</Chip>}
                {row.since !== null && <Text role="meta" numeric>{commitDate(row.since, now)}</Text>}
              </span>} />)
            const previous = held.current.get(row.id) ?? null
            const next = row.working && row.seat ? doing?.get(row.seat) ?? null : null
            const line = doingLine(previous, next, now)
            held.current.set(row.id, line)
            const duration = row.durationMs ?? (row.working && row.since !== null ? Math.max(0, now - row.since) : null)
            const rest = row.status === 'Done' || row.status === 'Abandoned' || row.status === 'Stopped' || row.status === 'Waiting' || row.status === 'Result unavailable'
            const selectedChip = selectedRow === row.id && !row.attention
            const status = row.status && !(needsYou && row.attention && row.status === 'Needs you') && (rest ? <Text role="meta">{row.status}</Text> : <Chip tone={row.attention ? 'warning' : 'neutral'} variant={selectedChip ? 'outline' : 'default'} emphasis={selectedChip}>{words(row.status)}</Chip>)
            const title = <span className="flex min-w-0 flex-wrap items-center gap-2">
              <Text title={row.kind === 'check' ? sanitizeText(row.title) : undefined} role={row.kind === 'round' ? 'section' : 'row'} className="min-w-0 break-words whitespace-normal [overflow-wrap:anywhere]">{words(row.kind === 'check' ? commandShown(row.title, home) : row.title)}</Text>
              {status}
              {row.publication && <Chip tone={row.publication.tone}>{row.publication.label}</Chip>}
              {row.kind !== 'round' && duration !== null && <Text role="meta" numeric>{formatDuration(duration)}{row.working ? ' so far' : ''}</Text>}
            </span>
            // The retry is a trailing control; the row remains keyboard-selectable without nesting buttons.
            const again = row.kind === 'check' && row.card !== null && row.retryRefusal === null
            const item = <ListRow wrapTitle data-row={row.id} data-kind={row.kind} as={again ? "div" : "button"} interactive selected={selectedRow === row.id || selectedRows?.includes(row.id)}
              onClick={event => { if (!event.currentTarget.contains(event.target as Node)) return; if (!(event.target as Element).closest('[data-slot="list-row-trail"]') && (!again || !(event.target as Element).closest('button'))) onSelect(row.id) }} title={again ? <Button stretched hoverFill={false} variant="row" size="content-min" bordered={false} onClick={() => onSelect(row.id)}>{title}</Button> : title}
              trail={again ? <RunAgain run={header.run} card={row.card!} refusal={null} onRow /> : undefined}
              className={again ? 'relative isolate min-w-0' : 'min-w-0'}
              lead={row.kind === 'card' ? <IconTile shape="face" size="sm">{row.seat ? faces?.get(row.seat) ?? <AgentIcon /> : <AgentIcon />}</IconTile>
                : row.kind === 'check' ? <IconTile size="sm"><CheckIcon /></IconTile>
                : row.kind === 'brief' ? <IconTile size="sm"><PlanIcon /></IconTile> : undefined}
              subtitle={(row.detail || (row.working && line.line)) ? <span data-slot="run-detail" className={row.kind === 'brief' ? 'line-clamp-2' : 'whitespace-pre-line'}>{words(row.detail ?? line.line ?? '')}</span> : undefined}
              wrapSubtitle
              meta={row.kind === 'start' && row.since !== null ? <Text role="meta">{commitDate(row.since, now)}</Text> : undefined} />
            return entry(row, item)
          })}
        </ListRows>
        {!model.rows.some(row => row.kind === 'round') && <EmptyState title="No rounds have opened yet" />}
        </div>}
      </PaneColumn>
    </div>
    {showing === 'timeline' && timelineDetail}
    </div>
  </div>
}
