import { useEffect, useRef, useState, type ReactNode } from 'react'

import {
  Button, Card, Chip, DisclosureChevron, EmptyState, Section, SectionBody,
  IconTile, MiddleTruncate, ListRow, ListRows, Page, Table, TableBody, TableCell,
  TableHead, TableHeader, TableRow, Text,
} from '../design'
import { useNarrowLayout } from '../lib/use-narrow-layout'
import { elapsedSince } from '../lib/clock'
import { sanitizeHtml } from '../lib/sanitize'
import type { NeedsYouAnswers } from '../lib/needs-you'
import type { runTimeline } from '../lib/run-timeline'
import { doingLine, type DoingLine, type SeatRow, type teamOverview } from '../lib/team-overview'
import { overviewAttention, type OverviewAttention } from '../lib/overview-attention'
import { runPublication } from '../lib/review-publication'
import { stepName } from '../lib/flow-model'
import { comparisonProgress } from '../lib/team-run-words'
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

export const TeamOverview = ({ attention, uncheckedDone = 0, onBoard, onTask, model, timeline, faces, metered, unavailable, onOpen, answers, onRun, runName = 'Run', runReason, runRules, statusLine, defaultExpanded = false, onStop, onWrap, runNeedsYou = false, onFindings, faceTints, runtimeNames, compact = false, pendingInChat = false, onChat }: {
  compact?: boolean
  pendingInChat?: boolean
  onChat?: () => void
  attention?: readonly OverviewAttention[]
  uncheckedDone?: number | undefined
  onBoard?: (() => void) | undefined
  onTask?: (card: number) => void
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
  onWrap?: (() => void) | undefined
  runName?: string
  runReason?: string | null
  runRules?: readonly { readonly id: string }[] | undefined
  /** The Team's shared live line. Omit only the Run reason when an attention row owns it. */
  statusLine?: (now: number, includeRunReason: boolean) => ReactNode
  defaultExpanded?: boolean
  runNeedsYou?: boolean
}) => {
  const { ref: box, narrow } = useNarrowLayout<HTMLElement>(800)
  const [expanded, setExpanded] = useState(defaultExpanded)
  const [now, setNow] = useState(Date.now)
  const held = useRef(new Map<string, DoingLine>())
  const stoppedCards = new Map(timeline?.rows.filter(row => row.card !== null && (row.status === 'Stopping' || row.status === 'Stopped'))
    .map(row => [row.card, row]) ?? [])
  const cardState = (row: SeatRow) => row.card ? stoppedCards.get(row.card.id) : undefined
  const seatState = (row: SeatRow) => cardState(row)
    ? <span data-slot="seat-state"><Text role="meta">{cardState(row)!.status}</Text></span> : model.run?.state === 'stopped' && row.round !== null
    ? <span data-slot="seat-state"><Text role="meta">Stopped</Text></span> : <SeatState row={row} />
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [])
  const done = model.seats.filter(row => row.done)
  const rows = model.seats.filter(row => !row.done).concat(expanded ? done : [])
  const face = (row: SeatRow) => <IconTile shape="face" tint={faceTints?.get(row.seat) ?? 'blue'}>{faces?.get(row.seat) ?? <AgentIcon />}</IconTile>
  const doing = (row: SeatRow, wrap = false) => {
    if (unavailable?.has(row.seat) || cardState(row) || model.needsYou.some(item => item.seat === row.seat)) return null
    const next = doingLine(held.current.get(row.seat) ?? null, row.doing, now)
    held.current.set(row.seat, next)
    const line = words(next.line ?? row.reason ?? '')
    const path = /^Edit(?:ed|ing) (?:.*[\\/].+|[^.]+\.[\w-]+)$/.test(line)
    return line ? <div data-slot="seat-doing" title={line} className={wrap && !path ? 'whitespace-normal [overflow-wrap:anywhere]' : 'truncate'}><Text role="meta">{path ? <MiddleTruncate>{line}</MiddleTruncate> : line}</Text></div> : null
  }
  const name = (row: SeatRow) => <Text as="span" className="block" role="subject" truncate title={words(row.name)}>{words(row.name)}</Text>
  const openName = (row: SeatRow) => opens(row) ? <Button stretched hoverFill={false} variant="row" size="content-min" bordered={false} aria-label={`Open ${words(row.name)}`} onClick={() => onOpen?.(row.seat)} className="block max-w-full">{name(row)}</Button> : name(row)
  const unavailableReason = (row: SeatRow) => unavailable?.has(row.seat) && row.reason ? words(row.reason) : null
  const role = (row: SeatRow) => unavailableReason(row) ?? [row.role ? stepName(words(row.role)) : null, runtimeNames?.get(row.seat)].filter(Boolean).join(' · ')
  const opens = (row: SeatRow) => Boolean(onOpen && !unavailable?.has(row.seat))
  const showNow = model.seats.some(row => (row.state === 'working' || row.reason !== null)
    && !cardState(row) && !unavailable?.has(row.seat) && !model.needsYou.some(item => item.seat === row.seat))
  const showCost = model.seats.some(row => row.cost !== null)
  const elapsed = (row: SeatRow) => {
    const stopped = cardState(row)
    return stopped ? stopped.durationMs : row.done ? row.durationMs ?? null : elapsedSince(row.since, now)
  }
  const progress = comparisonProgress(timeline?.rows)
  const run = model.run
  const publication = runPublication(run?.findingRun, run?.publicationOn !== false)
  const evidenceWait = run?.waitingEvidence === true
  const reason = runReason ? words(runReasonWords(runReason, runRules)) : evidenceWait ? 'The next step is waiting for its evidence.' : null
  const findingsWait = run?.waitingFindings === true
  const publicationReason = run?.findingRun?.reason ? words(run.findingRun.reason) : null
  const publicationWait = Boolean(publication?.needsYou)
  const reasonInWait = findingsWait || (publicationWait && reason === publicationReason)
  const attentionRows = attention ?? overviewAttention(model, {needsYou:runNeedsYou,runReason:reason})
  const wrapAction = compact && timeline?.header.end ? undefined : onWrap
  const pendingRequests = pendingInChat ? attentionRows.filter(row => row.kind === 'request' && row.item.kind !== 'card').length : 0
  const visibleAttention = attentionRows.filter(row =>
    !(pendingInChat && row.kind === 'request' && row.item.kind !== 'card')
    && !(compact && timeline?.header.end && row.kind === 'run'))
  const attentionAction = (row: Exclude<OverviewAttention, {kind:'request'}>) => row.kind === 'seat' ? onOpen ? () => onOpen(row.seat) : undefined
    : row.kind === 'findings' || row.kind === 'publication' ? onFindings
      : row.kind === 'board' ? onBoard : onRun
  return (
    <div data-slot="team-overview" data-layout={narrow === null ? 'unmeasured' : narrow ? 'narrow' : 'table'} className={compact ? undefined : "min-w-0 overflow-y-auto"}>
      <Page width="wide" gutter={compact ? "none" : "page"}>
        {compact && pendingRequests === 0 && <section aria-label="Run">{statusLine?.(now, !reasonInWait && !timeline?.header.end)}</section>}
        {!compact && run && (
          <Card spacing="compact">
            <section aria-label="Run" className="flex flex-col gap-2">
              <div className="flex flex-wrap items-center gap-2">
                <span>{onRun ? <Button variant="link" size="inline-link" onClick={onRun}><Text role="subject">{words(runName)}</Text></Button> : <Text role="subject">{words(runName)}</Text>}</span>
                {!statusLine && (runNeedsYou || run.needsYou || run.state === 'stalled' || run.state === 'running'
                  ? <Chip tone={runNeedsYou || run.needsYou || run.state === 'stalled' ? 'warning' : evidenceWait ? 'neutral' : 'info'}>{runNeedsYou || run.needsYou ? 'Needs you' : evidenceWait ? 'Waiting' : runWords[run.state]}</Chip>
                  : <Text role="meta">{run.state === 'stopped' && [...stoppedCards.values()].some(row => row.status === 'Stopping') ? 'Stopping' : runWords[run.state]}</Text>)}
                {statusLine && evidenceWait && !findingsWait && !runNeedsYou && !run.needsYou && <Chip tone="neutral">Waiting</Chip>}
                {publication && <Chip tone={publication.tone}>{publication.label}</Chip>}
              </div>
              <div className="flex flex-wrap gap-3">
                {progress ? <Text role="meta">{progress}</Text> : run.round !== null && <Text role="meta">Round {run.round}{run.role ? ` · ${stepName(words(run.role))}` : ''}</Text>}
                {run.startedAt !== null && <Text role="meta">Started {new Date(run.startedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</Text>}
                {!progress && run.reviewRounds && <Text role="meta">Completed rounds {run.reviewRounds.used} of {run.reviewRounds.of}</Text>}
                <Text role="meta" numeric title={run.total.money === null && run.total.turns === null ? 'Recorded usage is unavailable' : undefined}>
                  {[run.total.money !== null ? `$${run.total.money.toFixed(2)}` : null,
                    run.total.turns !== null ? `${run.total.turns} turns` : null].filter(Boolean).join(' · ')}
                </Text>
              </div>
              {[...stoppedCards.values()].filter(row => row.round === run.round).map(row => <div key={row.id} data-slot="run-current-step"><Text role="meta">
                {words(row.title)} · {row.status}{row.durationMs !== null ? ` · ${formatDuration(row.durationMs)}` : ''}
              </Text></div>)}
              {!publicationWait && publication?.needsYou && publicationReason && (statusLine || publicationReason !== reason) && <Text role="meta" as="div">{publicationReason}</Text>}
              {statusLine ? statusLine(now, !reasonInWait) : !reasonInWait && reason && <Text role="meta" as="div">{reason}</Text>}
            </section>
          </Card>
        )}
        {pendingRequests > 0 && <ListRow title={`${pendingRequests} ${pendingRequests === 1 ? 'request needs' : 'requests need'} your reply`}
          trail={<Button variant="outline" size="sm" onClick={onChat}>Open Chat</Button>} />}
        {visibleAttention.length > 0 && (
          <Section level="heading" title={pendingInChat ? "Pending" : "Needs you"} inset="row" className="mt-0">
            <ListRows>
              {visibleAttention.map((row, index) => row.kind === 'request' && pendingInChat ? <ListRow key={`pending-${index}`}
                title={row.item.kind === 'card' ? 'A decision is waiting' : `${model.seats.find(one => one.seat === row.item.seat)?.name ?? 'An agent'} · ${row.item.kind === 'approval' ? 'Approval waiting' : 'Question waiting'}`}
                trail={<Button variant="outline" size="sm" onClick={row.item.kind === 'card' && row.item.card !== null && onTask ? () => onTask(row.item.card!) : onBoard}>{row.item.kind === 'card' ? 'Open task' : 'Open conversation'}</Button>} /> : row.kind === 'request' ? (
                <NeedsYouRow key={row.item.approval !== undefined
                  ? JSON.stringify([row.item.sessionKey ?? row.item.seat, row.item.approval])
                  : row.item.card !== null ? `card-${row.item.card}` : `${row.item.kind}-${row.item.seat}-${index}`} item={row.item}
                  name={model.seats.find(one => one.seat === row.item.seat)?.name ?? null} answers={answers} onOpenSeat={onOpen} />
              ) : <ListRow key={`${row.kind}-${index}`} title={words(row.title)}
                subtitle={row.kind === 'publication' && findingsWait && row.reason === reason ? null : row.reason ? words(row.reason) : null} wrapSubtitle
                trail={attentionAction(row) && <Button variant="outline" size="sm" title={row.kind === 'findings' ? 'You or the reviewer can resolve this wait in Findings.' : undefined} onClick={attentionAction(row)}>
                  {row.kind === 'publication' || row.kind === 'findings' ? 'Open findings' : row.kind === 'board' ? 'Open Board' : row.kind === 'seat' ? 'Open conversation' : 'Open Run'}
                </Button>} />)}
            </ListRows>
          </Section>
        )}
        {(uncheckedDone > 0 || wrapAction) && <ListRow data-unchecked-done={uncheckedDone > 0 ? '' : undefined}
          title={uncheckedDone > 0 ? <Text role="meta">{uncheckedDone} {uncheckedDone === 1 ? 'card' : 'cards'} finished without a check</Text> : null}
          trail={<>
            {uncheckedDone > 0 && onBoard && <Button variant="link" size="inline-link" onClick={onBoard}>Open Board</Button>}
            {wrapAction && <Button variant="outline" onClick={wrapAction}>Wrap</Button>}
          </>} />}
        {!compact && <Section level="heading" ref={box} title={`Agents · ${model.seats.length}`} aria-label="Seats" inset="row" className="mt-0"
          action={done.length > 0 && <Button variant="outline" size="sm" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>
            <DisclosureChevron open={expanded} />{done.length} done
          </Button>}>
          {model.seats.length === 0 ? (
            <SectionBody spacing="inline">
              <EmptyState variant="inline" align="start" title={run ? 'No agent conversations were kept for this Run' : 'No agents in this Team yet'} />
            </SectionBody>
          ) : rows.length === 0 || narrow === null ? null : narrow ? (
            <ListRows>
              {rows.map(row => (
                <ListRow key={row.seat} data-seat={row.seat} interactive={opens(row)} className="relative isolate" onClick={opens(row) ? event => { if (event.currentTarget.contains(event.target as Node) && !(event.target as Element).closest('button')) onOpen?.(row.seat) } : undefined} lead={face(row)}
                  title={<div className="flex min-w-0 items-center justify-between gap-2"><span className="min-w-0 flex-1">{openName(row)}</span><span className="inline-flex shrink-0 items-center gap-2">{seatState(row)}{showCost && <Cost row={row} metered={metered?.get(row.seat)} />}</span></div>}
                  subtitle={unavailableReason(row) ?? (row.done ? role(row) : doing(row, true) ?? role(row))} wrapSubtitle trail={opens(row) ? <ChevronIcon /> : undefined} />
              ))}
            </ListRows>
          ) : (
            <Table variant="framed" inset="row" className="table-auto">
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
                  <TableRow key={row.seat} data-seat={row.seat} interactive={opens(row)} className="relative isolate"
                    onClick={opens(row) ? event => { if (event.currentTarget.contains(event.target as Node) && !(event.target as Element).closest('button')) onOpen?.(row.seat) } : undefined}>
                    <TableCell className="max-w-0" lead={face(row)}><div className="min-w-0 flex-1">{openName(row)}{role(row) && <Text role="meta" as="div" truncate={!unavailableReason(row)} className={unavailableReason(row) ? 'whitespace-normal [overflow-wrap:anywhere]' : undefined}>{role(row)}</Text>}</div></TableCell>
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
        </Section>}
      </Page>
    </div>
  )
}
