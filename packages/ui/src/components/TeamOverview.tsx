import { useEffect, useRef, useState, type ReactNode } from 'react'

import {
  Button, Card, CardContent, Chip, DisclosureChevron, EmptyState, GroupLabel,
  IconTile, ListRow, ListRows, PaneColumn, Table, TableBody, TableCell,
  TableHead, TableHeader, TableRow, Text,
} from '../design'
import { elapsedSince } from '../lib/clock'
import { sanitizeHtml } from '../lib/sanitize'
import type { NeedsYouAnswers } from '../lib/needs-you'
import { doingLine, type DoingLine, type SeatRow, type teamOverview } from '../lib/team-overview'
import { AgentIcon } from './Icons'
import { NeedsYouRow } from './NeedsYouRow'
import { formatDuration } from './TurnTail'

/** Agent words stay plain text, with the transcript's sanitation boundary. */
const words = (value: string): string => {
  const box = document.createElement('template')
  box.innerHTML = sanitizeHtml(value)
  return box.content.textContent ?? ''
}
const stateWords = { 'needs-you': 'Needs you', unread: 'Unread', working: 'Working', idle: 'Idle' } as const
const SeatState = ({ row }: { row: SeatRow }) => row.state === 'idle'
  ? <span data-slot="seat-state" data-resting><Text role="meta">{row.done ? 'Done' : 'Idle'}</Text></span>
  : <span data-slot="seat-state"><Chip tone={row.state === 'needs-you' ? 'warning' : 'neutral'}>{stateWords[row.state]}</Chip></span>
const costTitle = (row: SeatRow, metered?: boolean): string => row.cost === null
  ? 'Recorded usage is unavailable'
  : `${row.cost.estimated ? 'Estimated. ' : ''}${row.cost.unit === 'money'
    ? 'This account is metered and a rate is known'
    : metered === false
      ? 'This account is not metered, so turns are counted'
      : 'A money rate is unavailable, so turns are counted'}`
const Cost = ({ row, metered }: { row: SeatRow; metered?: boolean }) => (
  <span data-slot="seat-cost" title={costTitle(row, metered)}>
    <Text role="meta" numeric>
      {row.cost === null ? '—' : row.cost.unit === 'money' ? `$${row.cost.value.toFixed(2)}` : `${row.cost.value} turns`}
    </Text>
  </span>
)
const runWords = { running: 'Running', settled: 'Settled', stopped: 'Stopped', stalled: 'Needs you' } as const

export const TeamOverview = ({ model, faces, metered, unavailable, onOpen, answers, onRun, runName = 'Run', runReason, statusLine, defaultExpanded = false, onStop }: {
  model: ReturnType<typeof teamOverview>
  faces?: ReadonlyMap<string, ReactNode>
  metered?: ReadonlyMap<string, boolean>
  unavailable?: ReadonlySet<string>
  onOpen?: (seat: string) => void
  /** How what needs the person is answered from here; without it the rows only say what waits. */
  answers?: NeedsYouAnswers | undefined
  onRun?: () => void
  onStop?: (() => void) | undefined
  runName?: string
  runReason?: string | null
  /** The Team's shared live line, using this view's ticking clock. */
  statusLine?: (now: number) => ReactNode
  defaultExpanded?: boolean
}) => {
  const box = useRef<HTMLDivElement>(null)
  const [narrow, setNarrow] = useState(false)
  const [expanded, setExpanded] = useState(defaultExpanded)
  const [now, setNow] = useState(Date.now)
  const held = useRef(new Map<string, DoingLine>())
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [])
  useEffect(() => {
    if (!box.current || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(([entry]) => setNarrow((entry?.contentRect.width ?? Infinity) < 800))
    observer.observe(box.current)
    return () => observer.disconnect()
  }, [])
  const done = model.seats.filter(row => row.done)
  const rows = model.seats.filter(row => !row.done).concat(expanded ? done : [])
  const face = (row: SeatRow) => <IconTile shape="face" size="sm">{faces?.get(row.seat) ?? <AgentIcon />}</IconTile>
  const doing = (row: SeatRow) => {
    const next = doingLine(held.current.get(row.seat) ?? null, row.doing, now)
    held.current.set(row.seat, next)
    const line = words(next.line ?? row.reason ?? '')
    return line ? <div data-slot="seat-doing" title={line} className="truncate"><Text role="meta">{line}</Text></div> : null
  }
  const name = (row: SeatRow) => onOpen && !unavailable?.has(row.seat)
    ? <Button variant="link" size="inline-link" onClick={() => onOpen(row.seat)}><Text role="row">{words(row.name)}</Text></Button>
    : <Text role="row">{words(row.name)}</Text>
  const run = model.run
  return (
    <div ref={box} data-slot="team-overview" data-layout={narrow ? 'narrow' : 'table'} className="min-w-0 overflow-y-auto">
      <PaneColumn inset="reading" className="flex flex-col gap-4">
        {run && (
          <Card><CardContent>
            <section aria-label="Run" className="flex flex-col gap-2">
              <div className="flex flex-wrap items-center gap-2">
                <span>{onRun ? <Button variant="link" size="inline-link" onClick={onRun}><Text role="subject">{words(runName)}</Text></Button> : <Text role="subject">{words(runName)}</Text>}</span>
                <Chip tone={run.state === 'stalled' ? 'warning' : 'neutral'}>{runWords[run.state]}</Chip>
                {run.state === 'running' && onStop && <Button variant="outline" onClick={onStop}>Stop run…</Button>}
              </div>
              <div className="flex flex-wrap gap-3">
                {run.round !== null && <Text role="meta">Round {run.round}{run.role ? ` · ${words(run.role)}` : ''}</Text>}
                {run.startedAt !== null && <Text role="meta">Started {new Date(run.startedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</Text>}
                {run.reviewRounds && <Text role="meta">Reviews {run.reviewRounds.used} of {run.reviewRounds.of}</Text>}
                <Text role="meta" numeric>
                  {[run.total.money !== null ? `$${run.total.money.toFixed(2)}` : null,
                    run.total.turns !== null ? `${run.total.turns} turns` : null].filter(Boolean).join(' · ') || 'Usage unavailable'}
                </Text>
              </div>
              {statusLine ? statusLine(now) : runReason && <Text role="meta" as="div">{words(runReason)}</Text>}
            </section>
          </CardContent></Card>
        )}
        {model.needsYou.length > 0 && (
          <section aria-label="Needs you">
            <GroupLabel>Needs you</GroupLabel>
            <ListRows>
              {model.needsYou.map((item, index) => (
                <NeedsYouRow key={item.approval !== undefined
                  ? JSON.stringify([item.sessionKey ?? item.seat, item.approval])
                  : item.card !== null ? `card-${item.card}` : `${item.kind}-${item.seat}-${index}`} item={item}
                  name={model.seats.find(one => one.seat === item.seat)?.name ?? null} answers={answers} onOpenSeat={onOpen} />
              ))}
            </ListRows>
          </section>
        )}
        <section aria-label="Seats" className="min-w-0">
          <GroupLabel>Agents · {model.seats.length}</GroupLabel>
          {model.seats.length === 0 ? <EmptyState title="No agents in this Team yet" /> : rows.length === 0 ? null : narrow ? (
            <ListRows>
              {rows.map(row => (
                <ListRow key={row.seat} data-seat={row.seat} lead={face(row)}
                  title={<span className="flex min-w-0 items-center gap-2">{name(row)}<SeatState row={row} /></span>}
                  subtitle={doing(row)} trail={<Cost row={row} metered={metered?.get(row.seat)} />} />
              ))}
            </ListRows>
          ) : (
            <Table variant="framed" className="table-fixed">
              <TableHeader><TableRow>
                <TableHead className="w-36">Agent</TableHead>
                <TableHead className="w-40">Card</TableHead>
                <TableHead className="w-16">Round</TableHead>
                <TableHead className="w-28">State</TableHead>
                <TableHead>Now</TableHead>
                <TableHead className="w-16">Time</TableHead>
                <TableHead className="w-24">Cost</TableHead>
              </TableRow></TableHeader>
              <TableBody>
                {rows.map(row => {
                  const elapsed = elapsedSince(row.since, now)
                  return (
                    <TableRow key={row.seat} data-seat={row.seat}>
                      <TableCell lead={face(row)}>
                        <div className="min-w-0">{name(row)}{row.role && <Text role="meta" as="div">{words(row.role)}</Text>}</div>
                      </TableCell>
                      <TableCell>
                        <div data-slot="seat-card" className="truncate" title={row.card ? words(row.card.title) : undefined}>
                          <Text role="row">{row.card ? `#${row.card.id} · ${words(row.card.title)}` : '—'}</Text>
                        </div>
                      </TableCell>
                      <TableCell><Text role="meta" numeric>{row.round ?? '—'}</Text></TableCell>
                      <TableCell><SeatState row={row} /></TableCell>
                      <TableCell>{doing(row)}</TableCell>
                      <TableCell><Text role="meta" numeric>{elapsed === null ? '—' : formatDuration(elapsed)}</Text></TableCell>
                      <TableCell><Cost row={row} metered={metered?.get(row.seat)} /></TableCell>
                    </TableRow>
                  )
                })}
              </TableBody>
            </Table>
          )}
          {done.length > 0 && (
            <Button variant="quiet" size="content" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>
              <DisclosureChevron open={expanded} />{done.length} done
            </Button>
          )}
        </section>
      </PaneColumn>
    </div>
  )
}
