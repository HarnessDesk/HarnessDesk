import { Fragment, useEffect, useRef, useState, type ReactNode } from 'react'
import { Banner, Button, Chip, EmptyState, IconTile, ListRow, ListRows, PaneColumn, Segmented, Separator, Text } from '../design'
import { commandShown } from '../lib/projects'
import { openExternal } from '../lib/desktop'
import { commitDate } from '../lib/git-refs'
import type { runTimeline } from '../lib/run-timeline'
import { sanitizeHtml, sanitizeText } from '../lib/sanitize'
import { doingLine, type DoingLine } from '../lib/team-overview'
import { AgentIcon, CheckIcon, PlanIcon } from './Icons'
import { RunAgain } from './RetryCheck'
import { formatDuration } from './TurnTail'

const words = (value: string): string => {
  const box = document.createElement('template')
  box.innerHTML = sanitizeHtml(value)
  return box.content.textContent ?? ''
}
const states = { running: 'Running', settled: 'Settled', stopped: 'Stopped', stalled: 'Needs you' } as const

/** The two halves of a Run: what happened, and the Flow it was started from. */
export type RunViewTab = 'timeline' | 'flow'
const TABS = [{ value: 'timeline', label: 'Timeline' }, { value: 'flow', label: 'Flow' }] as const

/** Read-only story. Selection belongs to the caller for the later inspector. */
export const RunView = ({ home, model, number, selectedRow, selectedRows, onSelect, faces, doing, pullRequest, pending = false, problem, onRetry, flow, view, onView, onStop, onRunAgain, onWrap, onBoard, onReviewCheck, runChooser, continuesNumber }: {
  home?: string | null
  model: ReturnType<typeof runTimeline>
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
  return <div data-slot="run-view" className="flex min-h-0 min-w-0 flex-1 flex-col">
    <PaneColumn inset="reading" data-slot="run-header" className="flex flex-wrap items-center gap-3">
      <Text role="subject">Run {number}</Text>
      {runChooser}
      <Chip tone={header.needsYou ? 'warning' : 'neutral'}>{header.needsYou ? 'Needs you' : states[header.state]}</Chip>
      {header.publication && <Chip tone={header.publication.tone}>{header.publication.label}</Chip>}
      {flow ? <Button data-slot="run-revision" variant="link" size="inline-link" className="min-w-0 whitespace-normal break-words" onClick={() => showView('flow')}>{words(header.flow)}{header.revision ? ` · ${header.revision}` : ''}</Button>
        : <Text role="meta" className="min-w-0 break-words">{words(header.flow)}{header.revision ? ` · ${header.revision}` : ''}</Text>}
      {header.continues && <Text role="meta">Continues {continuesNumber ? `Run ${continuesNumber}` : 'an earlier Run'}</Text>}
      {pullRequest && <Button variant="link" size="inline-link" onClick={() => openExternal(pullRequest.url)}>Open pull request #{pullRequest.number}</Button>}
      {header.state === 'running' && onStop && <Button variant="outline" onClick={onStop}>Stop run…</Button>}
      {flow && <span className="ml-auto"><Segmented label="Show the Run as" value={showing} options={TABS}
        onChange={showView} /></span>}
    </PaneColumn>
    <Separator />
    <div data-slot="run-scroll" className="min-h-0 overflow-y-auto">
      <PaneColumn inset="reading">
        {showing === 'flow' ? flow : <>
        {pending && <Text role="meta" as="div">Reading checks and findings…</Text>}
        {problem && <Banner tone="warning" title="Some Run details could not be read">{words(problem)}{onRetry && <Button variant="link" size="inline-link" onClick={onRetry}>Try again</Button>}</Banner>}
        <ListRows size="sm" aria-label="Run timeline">
          {model.rows.map(row => {
            if (row.kind === 'end') {
              // Status and aggregate publication belong to the header. The ending
              // keeps only its reason, time and doors; each round keeps its own posting.
              const reason = ['Settled', 'Stopped', 'Needs you', 'Stopped by you', 'Stopped by the desk'].includes(row.title) ? null : words(row.title)
              const message = <div className="whitespace-pre-line">
                {reason && <Text role="row" as="div">{reason}</Text>}
                {row.detail && <span>{words(row.detail)}</span>}
              </div>
              const actions = [
                header.end?.kind === 'complete' && onWrap ? <Button key="wrap" size="sm" variant="outline" onClick={onWrap}>Wrap</Button> : null,
                header.interruptedCheck !== null && onReviewCheck ? <Button key="again" size="sm" variant="outline" onClick={onReviewCheck}>Review and run again…</Button>
                  : header.end && header.end.kind !== 'complete' && onRunAgain ? <Button key="again" size="sm" variant="outline" onClick={onRunAgain}>Run again…</Button> : null,
                header.end?.kind === 'unrouted' && onBoard ? <Button key="board" size="sm" variant="outline" onClick={onBoard}>Board</Button> : null,
              ].filter(Boolean)
              return <div key={row.id} data-slot="run-ending">
                <ListRow wrapTitle data-row={row.id} data-kind="end" selected={selectedRow === row.id || selectedRows?.includes(row.id)}
                  title={<span className="flex flex-wrap items-center gap-2">
                    <Button variant="link" size="inline-link" onClick={() => onSelect(row.id)}>End</Button>
                    {row.since !== null && <Text role="meta">{commitDate(row.since, now)}</Text>}
                    {header.end?.kind === 'stopped' && <Text role="meta">{header.end.by === 'person' ? 'By you' : 'By the desk'}</Text>}
                  </span>}
                  subtitle={row.attention ? <Banner tone="warning">{message}</Banner> : reason || row.detail ? message : undefined}
                  wrapSubtitle
                  meta={actions.length > 0 ? <div className="flex flex-wrap gap-2">{actions}</div> : undefined} />
              </div>
            }
            // What a check ran each time, drawn once it has run more than once: plain rows under their check; the check's inspector holds the output.
            if (row.kind === 'attempt') return <ListRow key={row.id} data-row={row.id} data-kind="attempt" wrapTitle selected={selectedRows?.includes(row.id)}
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
            const status = row.status && (rest ? <Text role="meta">{row.status}</Text> : <Chip tone={row.attention ? 'warning' : 'neutral'} variant={selectedChip ? 'outline' : 'default'} emphasis={selectedChip}>{words(row.status)}</Chip>)
            const title = <span className="flex min-w-0 flex-wrap items-center gap-2">
              <Text title={row.kind === 'check' ? sanitizeText(row.title) : undefined} role={row.kind === 'round' ? 'section' : 'row'} className="min-w-0 break-words whitespace-normal [overflow-wrap:anywhere]">{words(row.kind === 'check' ? commandShown(row.title, home) : row.title)}</Text>
              {status}
              {row.publication && <Chip tone={row.publication.tone}>{row.publication.label}</Chip>}
              {duration !== null && <Text role="meta" numeric>{formatDuration(duration)}{row.working ? ' so far' : ''}</Text>}
            </span>
            // *Run again…* is the row's sibling, never inside its button: centred over the end of the whole row, where an invisible spacer in the row's trail keeps the row's own words clear of it.
            const again = row.kind === 'check' && row.card !== null && row.retryRefusal === null
            const item = <ListRow wrapTitle data-row={row.id} data-kind={row.kind} as="button" interactive selected={selectedRow === row.id || selectedRows?.includes(row.id)}
              onClick={() => onSelect(row.id)} title={title}
              trail={again ? <span aria-hidden className="invisible mx-1.5 whitespace-nowrap">Run again…</span> : undefined}
              className={row.kind === 'round' ? 'mt-4' : undefined}
              lead={row.kind === 'card' ? <IconTile shape="face" size="sm">{row.seat ? faces?.get(row.seat) ?? <AgentIcon /> : <AgentIcon />}</IconTile>
                : row.kind === 'check' ? <IconTile size="sm"><CheckIcon /></IconTile>
                : row.kind === 'brief' ? <IconTile size="sm"><PlanIcon /></IconTile> : undefined}
              subtitle={(row.detail || (row.working && line.line)) ? <span data-slot="run-detail" className={row.kind === 'brief' ? 'line-clamp-2' : 'whitespace-pre-line'}>{words(row.detail ?? line.line ?? '')}</span> : undefined}
              wrapSubtitle
              meta={row.kind === 'start' && row.since !== null ? <Text role="meta">{commitDate(row.since, now)}</Text> : undefined} />
            return <Fragment key={row.id}>
              {again ? <div data-slot="run-row" className="relative">{item}
                <div className="absolute end-4 top-1/2 -translate-y-1/2 flex items-center"><RunAgain run={header.run} card={row.card!} refusal={null} onRow /></div>
              </div> : item}
            </Fragment>
          })}
        </ListRows>
        {!model.rows.some(row => row.kind === 'round') && <EmptyState title="No rounds have opened yet" />}
        </>}
      </PaneColumn>
    </div>
  </div>
}
