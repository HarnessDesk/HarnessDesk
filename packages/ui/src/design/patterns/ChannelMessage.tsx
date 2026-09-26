import { useEffect, useRef, useState, type ReactNode } from 'react'

import { BrandMark } from '../../components/BrandIcons'
import type { Brand } from '../../lib/brands'
import { Bubble, BubbleContent } from '../ui/bubble'
import { Button } from '../ui/button'
import { IconTile } from '../ui/icon-tile'
import { Message, MessageContent, MessageFooter, MessageHeader } from '../ui/message'
import type { Tone } from '../ui/tone'
import { Chip, CodeText, MetaList, Monogram, Text } from './Settings'
import { TurnItem } from './TurnWork'

/**
 * One line in the team channel, said the way a person reads a conversation.
 *
 * The panel this replaces gave every message the same full-width tinted slab:
 * a two-word "ok" and a nine-hundred-word review were the same shape, the
 * sender was a string rather than a face, and a message that was refused and
 * then re-sent printed its whole body twice in a row. A real run put two
 * identical copies of one review on screen, one above the other, and the only
 * difference between them was a word in the corner.
 *
 * So the rules here are the ones a chat window has always used, and one that
 * is ours:
 *
 *   Who spoke is a face.        The brand mark on the agent's tint, in a
 *                               column, so the eye finds the sender without
 *                               reading. Tints identify; they never judge.
 *   Consecutive is grouped.     The same sender inside five minutes keeps the
 *                               body and drops the header — the run reads as
 *                               one person talking, not four announcements.
 *                               A grouped row shows its own time in the
 *                               gutter on hover, the way a chat app does.
 *   Long is folded.             Past eight lines the body clamps with a
 *                               "Show more". A review is a document; the
 *                               channel is a conversation about documents.
 *   State is only news when     `delivered` is what everyone expects, so it
 *   it is bad news.             says nothing. Held and refused carry a chip
 *                               and the host's own reason underneath.
 *   A retry is one message.     THE fix: a refused attempt followed by the
 *                               same text delivered collapses into a single
 *                               row, with the failure kept as a footnote. The
 *                               channel records that it happened without
 *                               making the reader scroll past a duplicate.
 *
 * ---------------------------------------------------------------------------
 * One density, and the transcript's parts
 *
 * The channel used to be read in two places — a 360px Team panel and the room
 * — and carried a density for each. The panel is gone; the room is where the
 * channel is *the conversation*, one keystroke from an agent's own transcript,
 * so it reads the way that transcript does and is built from the same parts:
 *
 *   The rhythm        each row is a transcript item (`TurnItem`); a grouped
 *                     message and a board event are its light register, a
 *                     line rather than a card.
 *   The face          the room's identity tile (`IconTile`), on the sender's
 *                     tint — the tile the rail and the board draw the same
 *                     member in — with a `Monogram` when there is no mark.
 *   The words         `Text` roles: the name is the subject, the attribution
 *                     is a `MetaList` of facts, an aside is meta.
 *   The trouble       a `Chip` in the tone the trouble is (usage.ts, `tone`),
 *                     on the same `MessageFooter` a message's time and
 *                     actions stand on elsewhere.
 *   The quiet verbs   "Show more" and "Envelope" are the muted button.
 *
 * The measure is the caller's — `TeamRoomPane.module.css` sets it to
 * `--hd-column`, the transcript's — and the rows sit on its edges the way the
 * transcript's items do. The row itself is the transcript's own `Message`
 * (design/ui/message.tsx): a name uses `MessageHeader`, the words stand in
 * `Bubble` (design/ui/bubble.tsx) unframed the way an answer's own prose is,
 * and a delivery's trouble reads from `MessageFooter` — a second screen for
 * parts that would otherwise exist for the transcript alone, not a box
 * borrowed and then switched off.
 *
 * What stays here is what only a channel has: the clamp that folds a long
 * message, and the grid that keeps every row's words on one line after the
 * face column. Presentation only — no store, no transport. The room hands it
 * the entry and the verbs; whether a delivery can be released is the host's
 * business.
 */

export type ChannelState = 'delivered' | 'queued' | 'held' | 'refused' | 'shown'

/** The face column, which every row keeps open so its words start on one line. */
const FACE = 'grid-cols-[32px_1fr] gap-3'
/** The same column, held open by a row with no face — a board event, a notice. */
const SPINE = 'mr-3 w-8 flex-none'

export type ChannelMessageProps = {
  /** The sender's display name — "You", or the conversation and its agent. */
  readonly from: string
  /** The sender's mark. Absent for a person, who gets their `face` or their initials. */
  readonly brand?: Brand
  /**
   * A picture of the caller's own, drawn in the face's place — the one a
   * person chose for themselves. It wins over the mark and the initials, and
   * the tint is not painted under it, because a picture brings its own plate.
   *
   * A node rather than a URL for the reason `identify` is a render prop: this
   * pattern knows nothing about the app, and whose face it is — and what an
   * unchosen one looks like — are the app's to answer. It fills the tile, so
   * it takes the tile's size and corner.
   */
  readonly face?: ReactNode
  /** Which of the five identity tints this sender holds on this board. */
  readonly tint?: 'blue' | 'green' | 'amber' | 'violet' | 'rose' | 'teal'
  /** Who it reached. Absent means the whole board. */
  readonly to?: string
  readonly at: string
  /**
   * Wraps the author's name, for a surface that can say more about who spoke
   * than a row has room for.
   *
   * A render prop rather than a card prop: this pattern is app-unaware, and
   * *who an agent is* is the most app-aware question there is. The room hands
   * down a name card; the design explorer hands down nothing and the name
   * renders bare.
   *
   * The name and nothing else — not the face beside it, and not the body.
   * The body is out for the Slack reason: reading a long reply would open a
   * card halfway through it. The face is out for a subtler one that review
   * found. Two wrappers around two elements are two *separate* cards, so
   * moving the pointer the three pixels from the face to the name closed one
   * and opened the other after a fresh open delay — a flicker, over the same
   * agent, for a gesture that went nowhere. They cannot share one card
   * either: they live in different cells of the row's grid, and a hover card
   * has exactly one trigger. So the identity goes where it is written in
   * words. The face keeps its own comment two lines down: it is decoration,
   * and the header is what says who spoke.
   */
  readonly identify?: (node: ReactNode) => ReactNode
  readonly text: string
  /**
   * The message's words, already rendered.
   *
   * Agents write markdown — bold for the file under discussion, backticks for
   * an identifier, a list of findings, a fence around the command they ran, a
   * quote of what the board answered. Printed raw it reads `**limiter.js:**`
   * and a wall of asterisks, which is the one thing a room of agents cannot
   * afford: their output looking worse here than in the transcript two panes
   * over.
   *
   * Rendering it needs the resolved theme, because a code fence is highlighted
   * for the theme it is read in, and the theme comes from app state. This
   * pattern has to mount without app state — that is what makes it a pattern,
   * and its own tests mount it bare — so the app passes the rendered body in
   * and the pattern stays a layout. `text` remains the source of truth for
   * grouping, clamping and the fan-out merge, which are all decided on the
   * words rather than on their markup.
   */
  readonly body?: ReactNode
  /**
   * What became of a broadcast for the recipients it did *not* go the same way
   * for — `[{ state: 'queued', names: ['Haiku'] }]`.
   *
   * A post to everyone is stored once per recipient, because a delivery state
   * belongs to a delivery. Showing that record as one row per outcome printed
   * the sentence twice: once "to Gemini, GPT — delivered" and again "to Haiku —
   * queued", which reads as the app having sent it twice. The exception is the
   * news, not the words. One row, everyone it went to in the header, and the
   * outcomes that differ named here.
   */
  readonly outcomes?: readonly {
    readonly state: string
    readonly names: readonly string[]
    /** Why, when the host gave one. Two refusals for two reasons are two rows. */
    readonly reason?: string
  }[]
  readonly state: ChannelState
  /** The host's sentence for a message it would not send as addressed. */
  readonly reason?: string
  /**
   * An earlier attempt at this same text that the host refused. Shown as one
   * quiet line rather than a second copy of the message.
   */
  readonly refusedFirst?: string
  /** The exact envelope the receiver saw. */
  readonly envelope?: string
  /** Same sender, moments ago: keep the body, drop the header. */
  readonly grouped?: boolean
  readonly onDeliver?: () => void
}

const INITIALS = (name: string): string =>
  name
    .split(/\s+/)
    .slice(0, 2)
    .map((word) => word[0] ?? '')
    .join('')
    .toUpperCase()

/**
 * What a delivery's trouble is, in the tone it is (usage.ts, family `tone`):
 * a refusal is broken until someone sends it differently, a held message
 * waits on a person to release it, and a queued one only on a turn ending.
 */
const TROUBLE_TONE: Readonly<Record<string, Tone>> = {
  refused: 'danger',
  held: 'warning',
  queued: 'neutral',
}

const troubleTone = (state: string): Tone => TROUBLE_TONE[state] ?? 'neutral'

export const ChannelMessage = ({
  from,
  brand,
  face,
  tint = 'blue',
  to,
  at,
  identify,
  text,
  body,
  outcomes,
  state,
  reason,
  refusedFirst,
  envelope,
  grouped = false,
  onDeliver,
}: ChannelMessageProps) => {
  const [expanded, setExpanded] = useState(false)
  const [peeking, setPeeking] = useState(false)
  /**
   * Whether there is more than the clamp is showing — measured, not guessed.
   *
   * This used to count the source: more than eight lines, or 520 characters.
   * Once the words are rendered that number stops describing anything on
   * screen. Markdown source carries blank lines between every block, so a tidy
   * two-bullet finding with a fence under it counts as twelve lines and eight
   * hundred characters and renders to six comfortable ones — and every message
   * in the room grew a "Show more" that opened nothing. The box knows its own
   * overflow; ask it.
   */
  const bodyRef = useRef<HTMLDivElement | null>(null)
  const [overflows, setOverflows] = useState(false)
  useEffect(() => {
    // Only while clamped: expanded, the box is its full height and would
    // measure as fitting, which would take away the control to collapse it.
    if (expanded) return undefined
    const node = bodyRef.current
    if (!node) return undefined
    const check = (): void => setOverflows(node.scrollHeight > node.clientHeight + 2)
    check()
    if (typeof ResizeObserver === 'undefined') return undefined
    // The content, not just the box: a code fence that highlights a beat later,
    // or an image that loads, changes the height under a box of fixed size.
    const observer = new ResizeObserver(check)
    observer.observe(node)
    for (const child of node.children) observer.observe(child)
    return () => observer.disconnect()
  }, [text, body, expanded])
  /* Identity, where the surface offered one. `identify` is called rather than
     spread over a wrapper element so a caller that has nothing to say adds no
     node at all — a bare `<span>` around the face would change the grid. */
  const wrap = (node: ReactNode): ReactNode => (identify ? identify(node) : node)

  /* Delivery is shown, never implied — the expected outcome is a whisper and
     only trouble takes a chip. `shown` is an answer that landed in the room
     and in nobody's context; a reader who cannot tell it from `delivered`
     will think the sender was told.

     It reads "in the room" rather than "not sent", which is what it used to
     say. Both are true, but only one of them is what happened: `shown` is the
     loop guard working — an answer recorded here on purpose, because sending it
     would wake the asker, whose answer would wake the receiver. Naming a
     deliberate outcome by what it is not turns the one state that is a feature
     into the only one that looks like a failure, and a live run read three
     working replies as three errors. */
  const whisper =
    state === 'delivered' ? 'delivered' : state === 'shown' ? 'in the room' : null

  return (
    <TurnItem
      {...(grouped ? { register: 'light' as const } : {})}
      /* Grouped, the gutter holds a time rather than a face, and it sits on
         the first line of the words beside it rather than at the row's top. */
      className={`group grid ${FACE} data-[grouped]:items-baseline`}
      data-channel="message"
      data-grouped={grouped ? '' : undefined}
      data-state={state}
    >
      <div className={`flex ${grouped ? 'justify-end' : 'justify-center'}`}>
        {grouped ? (
          // The grouped row's own moment, offered on hover or focus where
          // the face would be — the way a chat app answers "when exactly?".
          // Faded, never hidden: opacity keeps the time in the
          // accessibility tree, so a screen reader hears it whether or not
          // a pointer ever passes.
          <Text
            role="meta"
            numeric
            className="whitespace-nowrap opacity-0 select-none group-hover:opacity-100 group-focus-within:opacity-100"
          >
            {at}
          </Text>
        ) : (
          // The face is decoration — the header says who spoke in words. A
          // picture brings its own plate, so the tint is not painted under it.
          face ? (
            <IconTile aria-hidden="true" tone="neutral">{face}</IconTile>
          ) : (
            <IconTile aria-hidden="true" tint={tint}>
              {brand ? <BrandMark brand={brand} size={16} /> : <Monogram>{INITIALS(from)}</Monogram>}
            </IconTile>
          )
        )}
      </div>

      {/* The room's row genuinely stands on the transcript's own parts now —
          not a box borrowed and switched off. `Message` keeps its real flex
          column; only two of its defaults are tuned for this caller:
          `items-stretch` because a header and a content column both need to
          fill the row rather than hug their own width (the way `ghost`
          already tunes `Bubble` for the same reason), and `gap-px` in place
          of the transcript's 6px — the exact `mb-px` the header carried
          before it was `MessageHeader`, so the row's own rhythm does not
          move. */}
      <Message align="start" className="items-stretch gap-px">
        {!grouped && (
          <MessageHeader>
            {wrap(<Text role="subject" truncate>{from}</Text>)}
            {/* `min-w-0`, or `truncate` is decoration: a flex item will not
                shrink below its content without it, and a recipient list of
                138 names ran off the row and gave the channel a scrollbar. */}
            {to && (
              <Text role="meta" truncate className="min-w-0" title={`to ${to}`}>
                to {to}
              </Text>
            )}
            {/* The attribution is one run — name, who it went to, when, and
                how it went — because that is the line every chat window has.
                In a narrow room it wraps a whole fact at a time, never "04:54"
                on one line and "AM" on the next. */}
            <MetaList className="min-w-0 whitespace-nowrap">
              <span>{at}</span>
              {whisper && <span>{whisper}</span>}
            </MetaList>
          </MessageHeader>
        )}

        {/* `gap-0`: the transcript's default rhythm between a content
            column's own parts (4px) is not this row's — its body, "Show
            more", outcomes and trouble each already carry the margin they
            had before this was `MessageContent`, so the column adds none of
            its own on top. */}
        <MessageContent className="gap-0">
          {/* `body` when the app gave one, the words themselves otherwise, at
              the document's own reading size — the rendered body sets its own.

              Clamped by height rather than `line-clamp`: line clamping needs
              `display: -webkit-box`, which flattens the very blocks — lists,
              fences, quotes — that a rendered body is made of. Nine lines —
              desk: 192px (`max-h-48`) → 9 lines (189px), the nearest whole
              line at the reading size, the same unit Items' own clamp is
              expressed in rather than a pixel count the audit cannot see.
              The "Show more" below opens the rest. */}
          <Bubble variant="ghost">
            <BubbleContent
              ref={bodyRef}
              data-slot="channel-body"
              clampLines={9}
              expanded={expanded}
              // Several screens (Items, FindingDetail, ProjectTriggers, the
              // session tree) each clamp long content with their own "Show
              // more", none sharing a part. Giving that role one owner is a
              // wider decision than this message body alone.
              className={`break-words ${body ? '' : 'whitespace-pre-wrap'}`}
            >
              {body ?? text}
            </BubbleContent>
          </Bubble>
          {(overflows || expanded) && (
            <Button
              variant="muted"
              size="xs"
              type="button"
              data-slot="channel-more"
              className="mt-1"
              aria-expanded={expanded}
              onClick={() => setExpanded((on) => !on)}
            >
              {expanded ? 'Show less' : 'Show more'}
            </Button>
          )}

          {outcomes && outcomes.length > 0 && (
            <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
              {outcomes.map((outcome) => (
                <span
                  key={`${outcome.state}-${outcome.reason ?? ''}`}
                  className="flex items-center gap-1.5"
                >
                  <Chip tone={troubleTone(outcome.state)}>{outcome.state}</Chip>
                  <Text role="meta">
                    {outcome.names.join(', ')}
                    {outcome.reason ? ` — ${outcome.reason}` : ''}
                  </Text>
                </span>
              ))}
            </div>
          )}

          {/* A message's trouble, in the same footer the transcript's own
              reads its time and actions from — status on the left, the one
              action a held delivery offers on the right. */}
          {(state === 'held' || state === 'refused' || state === 'queued') && (
            <MessageFooter align="start" className="mt-1.5 flex-wrap gap-1.5">
              <Chip tone={troubleTone(state)}>{state}</Chip>
              {reason && (
                <Text role="meta" className="min-w-0 flex-1 basis-48">
                  {reason}
                </Text>
              )}
              {state === 'held' && onDeliver && (
                <Button variant="outline" size="sm" onClick={onDeliver}>
                  Deliver now
                </Button>
              )}
            </MessageFooter>
          )}

          {refusedFirst && (
            <Text as="p" role="meta" className="mt-1">
              First attempt refused — {refusedFirst}
            </Text>
          )}

          {envelope && (
            <>
              {/* The exact envelope is a diagnostic, not part of reading the
                  message, so the room holds it back until the pointer or the
                  keyboard arrives — opacity, never `hidden`, so it stays in the
                  accessibility tree and stays tabbable. */}
              <Button
                variant="muted"
                size="xs"
                type="button"
                data-slot="channel-peek"
                className={`mt-1 ${
                  peeking ? '' : 'opacity-0 group-hover:opacity-100 group-focus-within:opacity-100'
                }`}
                aria-expanded={peeking}
                onClick={() => setPeeking((on) => !on)}
              >
                {peeking ? 'Hide envelope' : 'Envelope'}
              </Button>
              {peeking && (
                <CodeText as="pre" block ground="muted" wrap className="mt-1.5">
                  {envelope}
                </CodeText>
              )}
            </>
          )}
        </MessageContent>
      </Message>
    </TurnItem>
  )
}
ChannelMessage.displayName = 'ChannelMessage'

/**
 * A board event — claimed, completed, released. The spine the messages hang
 * off: one line, quiet, never a slab, because thirty of them is a normal
 * afternoon and they are read as a sequence rather than one at a time. The
 * transcript's light register, like a step inside a turn's work.
 */
export const ChannelSignal = ({
  by,
  said,
  at,
}: {
  readonly by: string
  /** The whole sentence after the actor — "claimed #1 — verify never builds…". */
  readonly said: string
  readonly at: string
}) => (
  <TurnItem register="light" data-channel="signal" className="flex items-baseline">
    {/* The spine holds the face column open so a signal's sentence starts on
        the same line as a message's name. Nothing is drawn in it: the
        alignment is the spine, and a dash here read as an artifact rather
        than a thread. */}
    <span className={SPINE} aria-hidden />
    <Text role="meta" className="min-w-0 flex-1">
      <Text role="meta" ink="secondary">{by}</Text> {said}
      {/* At the end of the sentence, where the reader finishes reading:
          these sentences wrap, and a right-hand column put the time beside
          the *first* line of a three-line signal. */}
      <Text role="meta" numeric className="ml-1.5 whitespace-nowrap">{at}</Text>
    </Text>
  </TurnItem>
)
ChannelSignal.displayName = 'ChannelSignal'

/**
 * What each cause is called where a person reads it, and its tone.
 *
 * A usage limit is a wait the person must act on or sit out; a sign-in that
 * lapsed is broken until somebody goes and fixes it.
 */
const CAUSE = {
  limit: { word: 'usage limit', tone: 'warning' },
  auth: { word: 'signed out', tone: 'danger' },
  stopped: { word: 'stopped', tone: 'neutral' },
  /* Not a failure and not the agent's fault: the conversation is not in that
     agent's history any more, so there is nothing left to address. Neutral,
     because the row is a fact about the roster rather than something to fix. */
  gone: { word: 'left the room', tone: 'neutral' },
} as const satisfies Record<string, { word: string; tone: Tone }>

/**
 * A row about a member rather than from one: its turn ended without an answer.
 *
 * Shaped like a signal — the same spine, the same aside voice — because it is
 * the room narrating rather than somebody speaking. It carries a chip, though,
 * because the difference between "still reading" and "ran out of its window
 * forty minutes ago" is the whole reason the row exists, and a grey sentence
 * in a busy channel is not that difference.
 */
export const ChannelNotice = ({
  about,
  cause,
  text,
  at,
}: {
  readonly about: string
  readonly cause: 'limit' | 'auth' | 'stopped' | 'gone'
  /** The runtime's own words. */
  readonly text: string
  readonly at: string
}) => (
  <TurnItem register="light" data-channel="notice" className="flex items-baseline">
    <span className={SPINE} aria-hidden />
    <Text role="meta" className="min-w-0 flex-1">
      <Chip tone={CAUSE[cause].tone} className="mr-1.5 align-baseline">
        {CAUSE[cause].word}
      </Chip>
      <Text role="meta" ink="secondary">{about}</Text> {text}
      <Text role="meta" numeric className="ml-1.5 whitespace-nowrap">{at}</Text>
    </Text>
  </TurnItem>
)

ChannelNotice.displayName = 'ChannelNotice'
