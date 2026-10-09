import { Fragment, type ReactNode } from 'react'
import { Button, ChangeStats, Chip, CodeText, IconTile, RunStateChip, Text, TimelineCard, TimelineCardRow, TimelineCards, TimelineCardWords, TimelineDocument } from '../design'
import { commandShown } from '../lib/projects'
import { commitDate } from '../lib/git-refs'
import type { RunChange, RunTimelineRow } from '../lib/run-timeline'
import { sanitizeText } from '../lib/sanitize'
import { mayBeDocument, useCommittedDocument } from '../state/committed-document'
import { AgentIcon, CheckIcon, FileIcon, UserIcon } from './Icons'
import { Markdown } from './Markdown'
import { formatDuration } from './TurnTail'

/** A Seat as the Run names it: what it is called, and the one line that says which model it ran. */
export interface SeatName {
  readonly name: string
  readonly detail: string | null
}
/** What a round's cards read from the Run view that holds them. */
export interface RoundCardsContext {
  readonly home?: string | null | undefined
  readonly now: number
  /** The page already says a person is wanted: the card does not say it again. */
  readonly needsYou: boolean
  readonly faces?: ReadonlyMap<string, ReactNode> | undefined
  readonly seatNames?: ReadonlyMap<string, SeatName> | undefined
  /** The Seat that held a card, for the attempts a judge lists, which belong to an earlier round. */
  readonly seatOfCard: (card: number) => string | null
  readonly selectedRow: string | null
  readonly selectedRows?: readonly string[] | undefined
  readonly onSelect: (id: string) => void
  readonly onAgain: (row: RunTimelineRow) => void
  /** What a working card's Seat is doing now, held while it is between lines. */
  readonly doingOf: (row: RunTimelineRow) => string | null
}

const short = (revision: string): string => revision.slice(0, 7)
const QUIET = ['Done', 'Abandoned', 'Stopped', 'Waiting', 'Result unavailable']

/** A document the card committed, once the checkout has said what it was; nothing is drawn before then or when it was not one. */
const CommittedDocumentBlock = ({ change }: { change: RunChange }) => {
  const found = useCommittedDocument(change)
  return found === null ? null : <TimelineDocument icon={<FileIcon size={13} aria-hidden />} path={sanitizeText(found.path)}
    meta={<>committed at <CodeText>{short(change.revision)}</CodeText> · {new TextEncoder().encode(found.text).length} bytes</>}>
    <Markdown document text={found.text} />
  </TimelineDocument>
}

const Card = ({ row, attempts, context }: { row: RunTimelineRow; attempts: readonly RunTimelineRow[]; context: RoundCardsContext }) => {
  const { home, now, needsYou, faces, seatNames, selectedRow, selectedRows, onSelect } = context
  const selected = selectedRow === row.id || Boolean(selectedRows?.includes(row.id))
  const seat = row.seat ? seatNames?.get(row.seat) : undefined
  const duration = row.durationMs ?? (row.working && row.since !== null ? Math.max(0, now - row.since) : null)
  const status = row.status && !(needsYou && row.attention && row.status === 'Needs you')
    ? QUIET.includes(row.status) ? <Text role="meta">{sanitizeText(row.status)}</Text> : <RunStateChip state={row.status} /> : null
  const time = duration === null ? null : <Text role="meta" numeric>{formatDuration(duration)}{row.working ? ' so far' : ''}</Text>
  const publication = row.publication ? <Chip tone={row.publication.tone}>{row.publication.label}</Chip> : null
  const doing = row.working ? context.doingOf(row) : null
  const props = { 'data-row': row.id, 'data-kind': row.kind, 'data-keep': row.keep ?? undefined, selected, onSelect: () => onSelect(row.id) }

  if (row.kind === 'person') {
    const footer = status ?? undefined
    return <TimelineCard {...props} name="You" meta="a person’s step" footer={footer}
      lead={<IconTile shape="face" size="sm" tint="amber"><UserIcon /></IconTile>}>
      {row.summary ? <TimelineCardWords>{sanitizeText(row.summary)}</TimelineCardWords> : undefined}
    </TimelineCard>
  }

  if (row.kind === 'check') {
    const again = row.retryRefusal === null && row.card !== null
    const facts = [status, time, publication].filter(Boolean)
    return <TimelineCard {...props} lead={<IconTile size="sm"><CheckIcon /></IconTile>}
      name={<span title={sanitizeText(row.title)}>{sanitizeText(commandShown(row.title, home))}</span>} meta={row.on ? `on ${row.on}` : undefined}
      actions={again ? <Button variant="link" size="xs" onClick={() => context.onAgain(row)}>Run again…</Button> : undefined}
      footer={facts.length ? <>{facts.map((fact, index) => <Fragment key={index}>{fact}</Fragment>)}</> : undefined}>
      {attempts.length ? <div className="flex flex-col gap-1">{attempts.map(one => <span key={one.id} data-row={one.id} data-kind="attempt" className="flex flex-wrap items-center gap-2">
        <Text role="meta">{sanitizeText(one.title)}</Text>
        {one.status && <Chip tone="neutral">{sanitizeText(one.status)}</Chip>}
        {one.since !== null && <Text role="meta" numeric>{commitDate(one.since, now)}</Text>}
      </span>)}</div> : undefined}
    </TimelineCard>
  }

  // An agent's card: an attempt is named for its place in its round, and its Seat says which model it ran.
  const name = row.attempt ?? sanitizeText(seat?.name ?? row.title)
  const meta = row.attempt ? sanitizeText(seat?.detail ?? seat?.name ?? '') : seat?.detail ? sanitizeText(seat.detail) : undefined
  const change = row.change
  const facts = [row.keep ? <Chip key="keep" tone={row.keep === 'kept' ? 'success' : 'neutral'}>{row.keep === 'kept' ? 'Picked' : 'Not kept'}</Chip> : null, status, change ? <ChangeStats key="change" added={change.added} removed={change.removed} /> : null, time,
    change?.branch ? /^harnessdesk\/lane-/.test(change.branch) ? <Text key="branch" role="meta">Isolated attempt</Text> : <CodeText key="branch">{sanitizeText(change.branch)}</CodeText> : null, publication].filter(Boolean)
  const pick = row.pick
  const rows = pick ? <>{pick.attempts.map(one => {
    const owner = context.seatOfCard(one.card)
    return <TimelineCardRow key={one.card} data-attempt={one.card} dim={one.keep === 'not-kept'}
      lead={<IconTile shape="face" size="xs" tint="violet">{owner ? faces?.get(owner) ?? <AgentIcon /> : <AgentIcon />}</IconTile>}
      trail={one.keep === 'kept' ? <Chip tone="success">Picked</Chip> : one.keep === 'not-kept' ? <Chip tone="neutral">Not kept</Chip> : undefined}>
      {one.label}{one.revision ? <> at <CodeText>{short(one.revision)}</CodeText></> : <> · no change recorded</>}
    </TimelineCardRow>
  })}</> : undefined
  return <TimelineCard {...props} name={name} meta={meta} rows={rows} footer={facts.length ? <>{facts.map((fact, index) => <Fragment key={index}>{fact}</Fragment>)}</> : undefined}
    lead={<IconTile shape="face" size="sm">{row.seat ? faces?.get(row.seat) ?? <AgentIcon /> : <AgentIcon />}</IconTile>}>
    {row.summary ? <TimelineCardWords>{sanitizeText(row.summary)}</TimelineCardWords> : doing ? <Text role="meta" as="div" data-slot="run-detail">{sanitizeText(doing)}</Text> : undefined}
    {mayBeDocument(change) && <CommittedDocumentBlock change={change} />}
  </TimelineCard>
}

/**
 * One round's cards (`TimelineCards`): each a card of its own kind, with the
 * results a check has run again under its own. The Run view draws a round this
 * way when it holds several cards, a person's step, or a judge's pick; one
 * ordinary card stays the row it has always been.
 */
export const RunRoundCards = ({ rows, attempts, context }: { rows: readonly RunTimelineRow[]; attempts: readonly RunTimelineRow[]; context: RoundCardsContext }) =>
  <TimelineCards count={rows.length}>
    {rows.map(row => <Card key={row.id} row={row} attempts={attempts.filter(one => one.card === row.card)} context={context} />)}
  </TimelineCards>
