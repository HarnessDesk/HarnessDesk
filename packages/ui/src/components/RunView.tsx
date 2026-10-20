import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Banner, Button, Chip, EmptyState, IconTile, ListRow, PaneColumn, Progress, Section, Text, Timeline, TimelineItem, type Tint, type TimelineState } from '../design'
import { commandShown } from '../lib/projects'
import { commitDate } from '../lib/git-refs'
import { type RunTimelineInput, type RunTimelineRow, type runTimeline } from '../lib/run-timeline'
import { runReasonWords } from '../lib/run-reason'
import { sanitizeHtml, sanitizeText } from '../lib/sanitize'
import { doingLine, type DoingLine } from '../lib/team-overview'
import { AgentIcon, BlindIcon, CheckIcon, ReviewIcon } from './Icons'
import { RetryCheck } from './RetryCheck'
import { RunRoundCards, type SeatName } from './RunRoundCards'
import { mayBeDocument } from '../state/committed-document'
import { formatDuration } from './TurnTail'
import { RunSteps } from './RunSteps'
import styles from './RunView.module.css'

const words = (value: string): string => {
  const box = document.createElement('template')
  box.innerHTML = sanitizeHtml(value)
  return box.content.textContent ?? ''
}

/** The two halves of a Run: what happened, and the Flow it was started from. */
export type RunViewTab = 'timeline' | 'flow'

/** Read-only story. Selection belongs to the caller for the later inspector. */
export const RunView = ({ home, model, execution, stepsInput, attemptsRead, faceTints, timelineDetail, selectedRow, selectedRows, onSelect, faces, seatNames, doing, pending = false, problem, onRetry, flow, view, onRunAgain, onWrap, onBoard, onReviewCheck, onDetails, unified = false, introduction, recordRequest }: {
  /** A Team reads its recorded path and recent events together. Other Run surfaces retain their view choice. */
  unified?: boolean
  recordRequest?: number
  introduction?: ReactNode
  home?: string | null
  stepsInput?: RunTimelineInput
  attemptsRead?: 'reading' | 'failed'
  faceTints?: ReadonlyMap<string, Tint>
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
  /** What each Seat is called, and the model it ran: the headers of the cards a round of several cards draws. */
  seatNames?: ReadonlyMap<string, SeatName>
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
  /** The parent permission boundary supplies its truthful refusal. */
  stopRefusal?: string | null
  onRunAgain?: () => void
  onWrap?: () => void
  onBoard?: () => void
  onReviewCheck?: () => void
  runChooser?: ReactNode
  /** Opens the Run summary from its header tool row. */
  onDetails?: () => void
  continuesNumber?: number
}) => {
  // Consent belongs to the Run view: an ending removes the row's retry control.
  const [retry, setRetry] = useState<{ run: string; card: number } | null>(null)
  useEffect(() => setRetry(null), [model.header.run])
  const [fullRecord, setFullRecord] = useState(false)
  useEffect(() => setFullRecord(false), [model.header.run])
  useEffect(() => {
    if (!unified || !selectedRow || !execution) return
    const selectedRound = model.rows.find(row => row.id === selectedRow)?.round
    const recentRounds = execution.rounds.slice(-3)
    const selectedStep = selectedRow.startsWith('step:') ? selectedRow.slice(5) : null
    if (selectedRound != null && !recentRounds.some(round => round.n === selectedRound)
      || selectedStep && execution.rounds.some(round => round.role === selectedStep && !recentRounds.includes(round))) setFullRecord(true)
  }, [unified, selectedRow, execution, model.rows])
  useEffect(() => { if (recordRequest) setFullRecord(true) }, [recordRequest])
  const showing: RunViewTab = flow ? view ?? 'timeline' : 'timeline'
  const [now, setNow] = useState(Date.now)
  const held = useRef(new Map<string, DoingLine>())
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [])
  const header = model.header
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
  const round = Math.max(0, ...model.rows.flatMap(row => row.kind === 'round' && row.round !== null ? [row.round] : []))
  const steps: { row: typeof model.rows[number]; records: typeof model.rows }[] = []
  for (const row of model.rows) {
    if (['start', 'brief', 'round', 'ahead', 'end'].includes(row.kind)) steps.push({ row, records: [] })
    else steps.at(-1)?.records.push(row)
  }
  const stepState = (row: typeof model.rows[number], records: typeof model.rows): TimelineState => {
    if (row.kind === 'ahead') return 'pending'
    if (records.some(one => one.kind !== 'attempt' && ['fail', 'failed', 'timed out', 'did not finish'].includes(one.status?.toLowerCase() ?? ''))) return 'danger'
    if (row.attention || records.some(one => one.attention) || (header.state === 'stalled' && row.kind === 'round' && row.round === round)) return 'warning'
    const recorded = execution?.rounds.find(one => one.n === row.round)
    if (header.state === 'running' && recorded?.state === 'waiting-evidence') return needsYou ? 'warning' : 'active'
    if (row.working || records.some(one => one.working)) return 'active'
    if (row.kind === 'round' && row.complete === false) return 'pending'
    if (row.kind !== 'round' || recorded?.state === 'closed' || row.durationMs !== null) return 'done'
    return 'pending'
  }
  // What a working card's Seat is doing now, held while it is between lines (a card and its row say it the same).
  const doingOf = (row: RunTimelineRow): { line: string | null } => {
    const previous = held.current.get(row.id) ?? null
    const next = row.working && row.seat ? doing?.get(row.seat) ?? null : null
    const line = doingLine(previous, next, now)
    held.current.set(row.id, line)
    return line
  }
  const seatOfCard = (card: number): string | null => model.rows.find(one => one.card === card && one.seat !== null)?.seat ?? null
  const time = (row: typeof model.rows[number]) => {
    const duration = row.durationMs ?? (row.working && row.since !== null ? Math.max(0, now - row.since) : null)
    const facts = [row.since === null ? null : commitDate(row.since, now), duration === null ? null : `${formatDuration(duration)}${row.working ? ' so far' : ''}`].filter(Boolean)
    return facts.length ? facts.join(' · ') : undefined
  }
  const renderTimelineStep = ({ row, records }: (typeof steps)[number]): ReactNode => {
            const isEnd = row.kind === 'end'
            const cards = records.filter(one => ['card', 'check', 'person'].includes(one.kind))
            const asCards = cards.length > 1 || cards.some(one => one.kind === 'person' || one.pick || mayBeDocument(one.change))
            const reason = needsYou || ['Settled', 'Stopped', 'Needs you', 'Stopped by you', 'Stopped by the desk'].includes(row.title) ? null : words(row.title)
            const detail = isEnd ? !needsYou && (reason || row.detail) ? [reason, row.detail ? words(runReasonWords(row.detail, execution?.document.flow.rules)) : null].filter(Boolean).join('\n') : undefined : row.detail ? words(row.detail) : undefined
            const actions = isEnd && !needsYou ? endActions() : undefined
            const meta = [time(row), isEnd && header.end?.kind === 'stopped' ? header.end.by === 'person' ? 'By you' : 'By the desk' : null].filter(Boolean).join(' · ') || undefined
            return <TimelineItem key={row.id} state={stepState(row, records)} data-row={row.id} data-kind={row.kind}
              {...(isEnd ? { 'data-slot': 'run-ending' } : {})}
              meta={meta} title={<span className="flex flex-wrap items-center gap-2">{isEnd ? 'End' : words(row.title)}
                {row.kind === 'round' && row.asked !== null && row.asked > 1 && <Progress as="span" className="w-40" size="sm" value={row.answered} max={row.asked} label={`${row.answered} of ${row.asked} answered`} aria-label={`${row.title} answers`} />}
              </span>} detail={row.kind === 'round' && row.asked !== null && row.asked > 1 ? undefined : detail}
              selected={selectedRow === row.id || selectedRows?.includes(row.id)} onSelect={() => onSelect(row.id)} actions={actions}>
              {asCards ? <RunRoundCards
                rows={cards} attempts={records.filter(one => one.kind === 'attempt')}
                context={{ home, now, needsYou, faces, seatNames, seatOfCard, selectedRow, selectedRows, onSelect,
                  onAgain: one => setRetry({ run: header.run, card: one.card! }), doingOf: one => doingOf(one).line }} /> : undefined}
              {row.blind && <Text as="div" role="meta" className="flex items-center gap-2 mt-2"><BlindIcon size={14} aria-hidden />Blind until the round closes</Text>}
              {records.length ? records.filter(one => !asCards || one.kind === 'findings').map(row => {
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

  }
  const stepRecords = stepsInput ? <RunSteps recent={unified && !fullRecord ? 3 : undefined} input={stepsInput} selectedRow={selectedRow} selectedStep={selectedRow?.startsWith('step:') ? selectedRow.slice(5) : undefined} faces={faces} faceTints={faceTints} attemptsRead={attemptsRead} onSelect={onSelect}
    onSelectStep={id => onSelect(`step:${id}`)} timeline seatNames={seatNames} /> : (unified && !fullRecord ? steps.slice(-3) : steps).map(renderTimelineStep)
  return <div data-slot="run-view" className="flex min-h-0 min-w-0 flex-1 flex-col">
    <div className="flex min-h-0 min-w-0 flex-1">
    <div data-slot="run-scroll" className="min-h-0 min-w-0 flex-1 overflow-y-auto">
      <PaneColumn inset="reading">
        {unified && flow && <Section title="Flow" level="heading">{flow}</Section>}
        {introduction}
        {needsYou && (!introduction || Boolean(header.end)) && <div data-slot="run-need" className={styles.need}>
          <Banner tone="warning" title={words(waiting ? waiting.title : need?.title && need.title !== 'Needs you' ? need.title : 'This Run needs your attention')}
            actions={needActions}>
            {words(runReasonWords(need?.detail ?? execution?.reason ?? (waiting ? 'Waiting for your answer' : 'Review the recorded details to continue.'), execution?.document.flow.rules))}
          </Banner>
        </div>}
        {!unified && showing === 'flow' ? flow : <div data-slot="run-reading" className={styles.reading}><div data-slot="run-steps">
        {pending && <Text role="meta" as="div">Reading checks and findings…</Text>}
        {problem && <Banner tone="warning" title="Some Run details could not be read">{words(problem)}{onRetry && <Button variant="link" size="inline-link" onClick={onRetry}>Try again</Button>}</Banner>}
        {stepsInput && header.end && !needsYou && <div data-slot="run-ending"><Banner title={!ending || ['Settled', 'Stopped', 'Needs you', 'Stopped by you', 'Stopped by the desk'].includes(ending.title) ? undefined : words(ending.title)} actions={endActions()}>
          {[ending?.detail ? words(runReasonWords(ending.detail, execution?.document.flow.rules)) : null, header.end.kind === 'stopped' ? header.end.by === 'person' ? 'By you' : 'By the desk' : null].filter(Boolean).join(' · ')}
        </Banner></div>}
        {unified && <Section level="heading" title={fullRecord ? "Timeline" : "Recent activity"} action={<Button variant="outline" size="sm" aria-expanded={fullRecord} onClick={() => setFullRecord(!fullRecord)}>{fullRecord ? "Recent activity" : "Full record"}</Button>} />}
        {unified && !fullRecord && stepsInput ? stepRecords : <Timeline aria-label="Run timeline">{stepRecords}</Timeline>}</div>
        {!model.rows.some(row => row.kind === 'round') && <EmptyState title="No rounds have opened yet" />}
        </div>}
      </PaneColumn>
    </div>
    {retry?.run === header.run && <RetryCheck run={retry.run} card={retry.card}
      refusal={model.rows.find(row => row.kind === 'check' && row.card === retry.card)?.retryRefusal ?? null}
      onClose={() => setRetry(null)} />}
    {(unified || showing === 'timeline') && timelineDetail}
    </div>
  </div>
}
