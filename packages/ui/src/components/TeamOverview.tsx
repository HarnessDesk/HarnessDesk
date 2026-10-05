import { useEffect, useRef, useState, type ReactNode } from 'react'

import {
  Button, Card, CardContent, Chip, DisclosureChevron, EmptyState, GroupLabel,
  IconTile, ListRow, ListRows, PaneColumn, Table, TableBody, TableCell,
  TableHead, TableHeader, TableRow, Text,
} from '../design'
import { elapsedSince } from '../lib/clock'
import { sanitizeHtml } from '../lib/sanitize'
import type { NeedsYouAnswers } from '../lib/needs-you'
import type { runTimeline } from '../lib/run-timeline'
import { doingLine, type DoingLine, type SeatRow, type teamOverview } from '../lib/team-overview'
import { runPublication } from '../lib/review-publication'
import { stepName } from '../lib/flow-model'
import { runReasonWords } from '../lib/run-reason'
import type { Tint } from '../design'
import { AgentIcon, ChevronIcon } from './Icons'
import { NeedsYouRow } from './NeedsYouRow'
import { formatDuration } from './TurnTail'

/** Agent words stay plain text, with the transcript's sanitation boundary. */
const words = (value: string): string => {
  const box = document.createElement('template')
  box.innerHTML = sanitizeHtml(value)
  return box.content.textContent ?? ''
}
const stateWords = { 'needs-you': 'Needs you', unread: 'Unread', working: 'Working', idle: 'Idle' } as const
const SeatState = ({ row }: { row: SeatRow }) => row.state === 'idle' || row.state === 'unread'
  ? <span data-slot="seat-state" data-resting><Text role="meta">{row.done ? 'Done' : stateWords[row.state]}</Text></span>
  : <span data-slot="seat-state"><Chip tone={row.state === 'needs-you' ? 'warning' : 'info'}>{stateWords[row.state]}</Chip></span>
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

export const TeamOverview = ({ model, timeline, faces, metered, unavailable, onOpen, answers, onRun, runName = 'Run', runReason, statusLine, defaultExpanded = false, onStop, runNeedsYou = false, onFindings, faceTints, runtimeNames }: {
  model: ReturnType<typeof teamOverview>
  onFindings?: (() => void) | undefined
  faceTints?: ReadonlyMap<string, Tint>
  runtimeNames?: ReadonlyMap<string, string>
  /** Run card presentation is shared with its timeline and inspector. */
  timeline?: ReturnType<typeof runTimeline> | null
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
  /** The Team's shared live line. Omit only the Run reason when an attention row owns it. */
  statusLine?: (now: number, includeRunReason: boolean) => ReactNode
  defaultExpanded?: boolean
  runNeedsYou?: boolean
}) => {
  const box = useRef<HTMLDivElement>(null)
  const [narrow, setNarrow] = useState(false)
  const [expanded, setExpanded] = useState(defaultExpanded)
  const [now, setNow] = useState(Date.now)
  const held = useRef(new Map<string, DoingLine>())
  const stoppedCards = new Map(timeline?.rows.filter(row => row.card !== null && (row.status === 'Stopping' || row.status === 'Stopped'))
    .map(row => [row.card, row]) ?? [])
  const cardState = (row: SeatRow) => row.card ? stoppedCards.get(row.card.id) : undefined
  const seatState = (row: SeatRow) => cardState(row)
    ? <span data-slot="seat-state"><Text role="meta">{cardState(row)!.status}</Text></span> : <SeatState row={row} />
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
  const face = (row: SeatRow) => <IconTile shape="face" tint={faceTints?.get(row.seat) ?? 'blue'}>{faces?.get(row.seat) ?? <AgentIcon />}</IconTile>
  const doing = (row: SeatRow) => {
    if (cardState(row) || model.needsYou.some(item => item.seat === row.seat)) return null
    const next = doingLine(held.current.get(row.seat) ?? null, row.doing, now)
    held.current.set(row.seat, next)
    const line = words(next.line ?? row.reason ?? '')
    return line ? <div data-slot="seat-doing" title={line} className="truncate"><Text role="meta">{line}</Text></div> : null
  }
  const name = (row: SeatRow) => <Text role="subject" truncate title={words(row.name)}>{words(row.name)}</Text>
  const role = (row: SeatRow) => [row.role ? stepName(words(row.role)) : null, runtimeNames?.get(row.seat)].filter(Boolean).join(' · ')
  const opens = (row: SeatRow) => Boolean(onOpen && !unavailable?.has(row.seat))
  const showNow = model.seats.some(row => row.state === 'working' && !cardState(row))
  const showCost = model.seats.some(row => row.cost !== null)
  const elapsed = (row: SeatRow) => {
    const stopped = cardState(row)
    return stopped ? stopped.durationMs : row.done ? row.durationMs ?? null : elapsedSince(row.since, now)
  }
  const run = model.run
  const publication = runPublication(run?.findingRun, run?.publicationOn !== false)
  const evidenceWait = run?.waitingEvidence === true
  const reason = runReason ? words(runReasonWords(runReason)) : evidenceWait ? 'The next step is waiting for its evidence.' : null
  // Only the host's findings waits promise a Findings action. Other guards
  // (checks, CI, reviews, PR state, diffs) keep their recorded reason in Run.
  const findingsWait = evidenceWait && /^Waiting for (?:\d+ open blocking findings?\b|a person to review a new regression or security finding\b)/i.test(reason ?? '')
  const publicationReason = run?.findingRun?.reason ? words(run.findingRun.reason) : null
  const publicationWait = Boolean(publication?.needsYou && onFindings)
  const reasonInWait = evidenceWait || (publicationWait && reason === publicationReason)
  return (
    <div ref={box} data-slot="team-overview" data-layout={narrow ? 'narrow' : 'table'} className="min-w-0 overflow-y-auto">
      <PaneColumn inset="reading" className="flex flex-col gap-4">
        {run && (
          <Card><CardContent>
            <section aria-label="Run" className="flex flex-col gap-2">
              <div className="flex flex-wrap items-center gap-2">
                <span>{onRun ? <Button variant="link" size="inline-link" onClick={onRun}><Text role="subject">{words(runName)}</Text></Button> : <Text role="subject">{words(runName)}</Text>}</span>
                {!statusLine && (runNeedsYou || run.needsYou || run.state === 'stalled' || run.state === 'running'
                  ? <Chip tone={runNeedsYou || run.needsYou || run.state === 'stalled' ? 'warning' : 'info'}>{runNeedsYou || run.needsYou ? 'Needs you' : runWords[run.state]}</Chip>
                  : <Text role="meta">{runWords[run.state]}</Text>)}
                {publication && <Chip tone={publication.tone}>{publication.label}</Chip>}
                {run.state === 'running' && onStop && <Button variant="outline" onClick={onStop}>Stop run…</Button>}
              </div>
              <div className="flex flex-wrap gap-3">
                {run.round !== null && <Text role="meta">Round {run.round}{run.role ? ` · ${stepName(words(run.role))}` : ''}</Text>}
                {run.startedAt !== null && <Text role="meta">Started {new Date(run.startedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</Text>}
                {run.reviewRounds && <Text role="meta">Reviews {run.reviewRounds.used} of {run.reviewRounds.of}</Text>}
                <Text role="meta" numeric>
                  {[run.total.money !== null ? `$${run.total.money.toFixed(2)}` : null,
                    run.total.turns !== null ? `${run.total.turns} turns` : null].filter(Boolean).join(' · ') || '—'}
                </Text>
              </div>
              {[...stoppedCards.values()].filter(row => row.round === run.round).map(row => <div key={row.id} data-slot="run-current-step"><Text role="meta">
                {words(row.title)} · {row.status}{row.durationMs !== null ? ` · ${formatDuration(row.durationMs)}` : ''}
              </Text></div>)}
              {!publicationWait && publication?.needsYou && publicationReason && (statusLine || publicationReason !== reason) && <Text role="meta" as="div">{publicationReason}</Text>}
              {statusLine ? statusLine(now, !reasonInWait) : !reasonInWait && reason && <Text role="meta" as="div">{reason}</Text>}
            </section>
          </CardContent></Card>
        )}
        {(model.needsYou.length > 0 || evidenceWait || publicationWait) && (
          <section aria-label="Needs you">
            <GroupLabel>Needs you</GroupLabel>
            <ListRows>
              {evidenceWait && <ListRow title={findingsWait ? 'Review the findings' : 'Review the evidence'} subtitle={reason} wrapSubtitle
                meta={<Text role="meta">{findingsWait ? 'You or the reviewer can resolve this wait in Findings.' : 'The next step needs recorded evidence. Open the Run to inspect the wait.'}</Text>}
                trail={findingsWait ? onFindings && <Button variant="outline" size="sm" onClick={onFindings}>Open findings</Button>
                  : onRun && <Button variant="outline" size="sm" onClick={onRun}>Open run</Button>} />}
              {publicationWait && <ListRow title="Post the review" subtitle={evidenceWait && publicationReason === reason ? null : publicationReason} wrapSubtitle
                trail={<Button variant="outline" size="sm" onClick={onFindings}>Open findings</Button>} />}
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
          <div className="flex items-center gap-3">
          <GroupLabel>Agents · {model.seats.length}</GroupLabel>
          {done.length > 0 && <Button variant="quiet" size="content" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>
            <DisclosureChevron open={expanded} />{done.length} done
          </Button>}
          </div>
          {model.seats.length === 0 ? <EmptyState variant="inline" align="start" title="No agents in this Team yet" /> : rows.length === 0 ? null : narrow ? (
            <ListRows>
              {rows.map(row => (
                <ListRow key={row.seat} data-seat={row.seat} as={opens(row) ? "button" : "div"} interactive={opens(row)} onClick={opens(row) ? () => onOpen?.(row.seat) : undefined} lead={face(row)}
                  title={name(row)} subtitle={row.done ? role(row) : doing(row) ?? role(row)} trail={<>{seatState(row)}{showCost && <Cost row={row} metered={metered?.get(row.seat)} />}{opens(row) && <ChevronIcon />}</>} />
              ))}
            </ListRows>
          ) : (
            <Table variant="framed" className="table-auto">
              <TableHeader><TableRow>
                <TableHead>Agent</TableHead>
                <TableHead className="w-[1%]">Card</TableHead>
                <TableHead numeric className="w-[1%]">Round</TableHead>
                <TableHead className="w-[1%]">State</TableHead>
                {showNow && <TableHead className="w-[1%]">Now</TableHead>}
                <TableHead numeric className="w-[1%]">Time</TableHead>
                {showCost && <TableHead numeric className="w-[1%]">Cost</TableHead>}
                <TableHead className="w-[1%]"><span className="sr-only">Open conversation</span></TableHead>
              </TableRow></TableHeader>
              <TableBody>
                {rows.map(row => (
                  <TableRow key={row.seat} data-seat={row.seat} interactive={opens(row)} tabIndex={opens(row) ? 0 : undefined}
                    aria-label={opens(row) ? `Open ${words(row.name)}` : undefined}
                    onClick={opens(row) ? () => onOpen?.(row.seat) : undefined}
                    onKeyDown={event => { if (opens(row) && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); onOpen?.(row.seat) } }}>
                    <TableCell className="max-w-0" lead={face(row)}><div className="min-w-0 flex-1">{name(row)}{role(row) && <Text role="meta" as="div" truncate>{role(row)}</Text>}</div></TableCell>
                    <TableCell><div data-slot="seat-card" className="max-w-48 truncate" title={row.card ? words(row.card.title) : undefined}>
                      <Text role="meta">{row.card ? `#${row.card.id} · ${words(row.card.title)}` : '—'}</Text>
                    </div></TableCell>
                    <TableCell numeric><Text role="meta" numeric>{row.round ?? '—'}</Text></TableCell>
                    <TableCell>{seatState(row)}</TableCell>
                    {showNow && <TableCell><div className="max-w-48 truncate">{doing(row) ?? <Text role="meta">—</Text>}</div></TableCell>}
                    <TableCell numeric><Text role="meta" numeric>{elapsed(row) === null ? '—' : formatDuration(elapsed(row)!)}</Text></TableCell>
                    {showCost && <TableCell numeric><Cost row={row} metered={metered?.get(row.seat)} /></TableCell>}
                    <TableCell>{opens(row) && <ChevronIcon />}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </section>
      </PaneColumn>
    </div>
  )
}
