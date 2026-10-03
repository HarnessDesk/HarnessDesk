import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Banner, Button, Chip, EmptyState, IconTile, ListRow, ListRows, PaneColumn, Separator, Text } from '../design'
import { openExternal } from '../lib/desktop'
import type { runTimeline } from '../lib/run-timeline'
import { sanitizeHtml } from '../lib/sanitize'
import { doingLine, type DoingLine } from '../lib/team-overview'
import { AgentIcon, CheckIcon, PlanIcon } from './Icons'
import { formatDuration } from './TurnTail'

const words = (value: string): string => {
  const box = document.createElement('template')
  box.innerHTML = sanitizeHtml(value)
  return box.content.textContent ?? ''
}
const states = { running: 'Running', settled: 'Settled', stopped: 'Stopped', stalled: 'Needs you' } as const

/** Read-only story. Selection belongs to the caller for the later inspector. */
export const RunView = ({ model, number, selectedRow, onSelect, faces, doing, pullRequest, pending = false, problem, onRetry }: {
  model: ReturnType<typeof runTimeline>
  number: number
  selectedRow: string | null
  onSelect: (id: string) => void
  faces?: ReadonlyMap<string, ReactNode>
  doing?: ReadonlyMap<string, string | null>
  pullRequest?: { number: number; url: string } | null
  pending?: boolean
  problem?: string | null
  onRetry?: () => void
}) => {
  const [now, setNow] = useState(Date.now)
  const held = useRef(new Map<string, DoingLine>())
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [])
  const header = model.header
  return <div data-slot="run-view" className="flex min-h-0 min-w-0 flex-1 flex-col">
    <PaneColumn inset="reading" data-slot="run-header" className="flex flex-wrap items-center gap-3">
      <Text role="subject">Run {number}</Text>
      <Chip tone={header.needsYou ? 'warning' : 'neutral'}>{header.needsYou ? 'Needs you' : states[header.state]}</Chip>
      <Text role="meta" className="min-w-0 break-words">{words(header.flow)}{header.revision ? ` · ${header.revision}` : ''}</Text>
      {pullRequest && <Button variant="link" size="inline-link" onClick={() => openExternal(pullRequest.url)}>Open pull request #{pullRequest.number}</Button>}
    </PaneColumn>
    <Separator />
    <div data-slot="run-scroll" className="min-h-0 overflow-y-auto">
      <PaneColumn inset="reading">
        {pending && <Text role="meta" as="div">Reading checks and findings…</Text>}
        {problem && <Banner tone="warning" title="Some Run details could not be read">{words(problem)}{onRetry && <Button variant="link" size="inline-link" onClick={onRetry}>Try again</Button>}</Banner>}
        <ListRows size="sm" aria-label="Run timeline">
          {model.rows.map(row => {
            const previous = held.current.get(row.id) ?? null
            const next = row.working && row.seat ? doing?.get(row.seat) ?? null : null
            const line = doingLine(previous, next, now)
            held.current.set(row.id, line)
            const duration = row.durationMs ?? (row.working && row.since !== null ? Math.max(0, now - row.since) : null)
            const rest = row.status === 'Done' || row.status === 'Abandoned' || row.status === 'Waiting' || row.status === 'Result unavailable'
            const status = row.status && (rest ? <Text role="meta">{row.status}</Text> : <Chip tone={row.attention ? 'warning' : 'neutral'}>{words(row.status)}</Chip>)
            const title = <span className="flex min-w-0 flex-wrap items-center gap-2">
              <Text role={row.kind === 'round' ? 'section' : 'row'} className="min-w-0 break-words whitespace-normal [overflow-wrap:anywhere]">{words(row.title)}</Text>
              {status}
              {duration !== null && <Text role="meta" numeric>{formatDuration(duration)}{row.working ? ' so far' : ''}</Text>}
            </span>
            return <ListRow wrapTitle key={row.id} data-row={row.id} data-kind={row.kind} as="button" interactive selected={selectedRow === row.id}
              onClick={() => onSelect(row.id)} title={row.kind === 'end' && row.detail ? null : title}
              className={row.kind === 'round' ? 'mt-4' : undefined}
              lead={row.kind === 'card' ? <IconTile shape="face" size="sm">{row.seat ? faces?.get(row.seat) ?? <AgentIcon /> : <AgentIcon />}</IconTile>
                : row.kind === 'check' ? <IconTile size="sm"><CheckIcon /></IconTile>
                : row.kind === 'brief' ? <IconTile size="sm"><PlanIcon /></IconTile> : undefined}
              subtitle={row.kind !== 'end' && (row.detail || (row.working && line.line)) ? <span data-slot="run-detail" className={row.kind === 'brief' ? 'line-clamp-2' : 'whitespace-pre-line'}>{words(row.detail ?? line.line ?? '')}</span> : undefined}
              wrapSubtitle
              meta={row.kind === 'end' && row.detail ? <Banner tone={row.attention ? 'warning' : 'neutral'} title={row.title}>{words(row.detail)}</Banner>
                : row.kind === 'start' && row.since !== null ? <Text role="meta">{new Date(row.since).toLocaleString()}</Text> : undefined} />
          })}
        </ListRows>
        {!model.rows.some(row => row.kind === 'round') && <EmptyState title="No rounds have opened yet" />}
      </PaneColumn>
    </div>
  </div>
}
