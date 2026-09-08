import { useEffect, useRef, useState, type ReactNode } from 'react'

import { BrandMark } from '../../components/BrandIcons'
import type { Brand } from '../../lib/brands'
import { Avatar, AvatarFallback } from '../ui/avatar'
import { Badge } from '../ui/badge'
import { Button } from '../ui/button'

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
 * Two densities, one implementation
 *
 * The same channel is read in two places that are not the same size, and a
 * chat log wants a different shape in each. In the 360px Team panel it is a
 * glance: a 24px mark, 13px type, and the delivery state floated right so a
 * long name cannot push it off. In the room pane it is *the conversation* and
 * it should read like every chat window the reader has ever used: a 36px mark,
 * 14px body, the name and the time in one run at the left, and a highlight
 * under the row the pointer is on.
 *
 * That highlight used to reach both edges of the pane, because the room's
 * stream was full width. It is not any more: the room reads in `--hd-column`,
 * the same 736px an agent's transcript is set in, because the two sit one
 * keystroke apart and a group chat that ran its lines 40% wider than the
 * conversation beside it was the first thing anyone noticed about the pair.
 * The measure is the caller's — `TeamRoomPane.module.css` — and what is here
 * is only the row's own gutter inside it.
 *
 * The differences are declared once, in `DENSITY` below, rather than sprinkled
 * as ternaries — because the moment they are sprinkled the two stop agreeing
 * about anything but the parts someone remembered to change.
 *
 * Built from the shadcn layer (Avatar, Badge, Button) with Tailwind
 * utilities that resolve to the system's tokens — there is no stylesheet
 * beside this file. Presentation only — no store, no transport. The panel
 * hands it the entry and the verbs; whether a delivery can be released is
 * the host's business.
 */

export type ChannelState = 'delivered' | 'queued' | 'held' | 'refused' | 'shown'

/** A glance in a 360px panel, or the conversation itself in a pane. */
export type ChannelDensity = 'panel' | 'room'

const DENSITY = {
  panel: {
    row: 'grid-cols-[24px_1fr] gap-2 rounded-lg px-2 py-1.5 hover:bg-accent/50',
    avatar: 'size-6',
    mark: 14,
    initials: 'text-[10px]',
    /* The grouped row's own moment, in the gutter the face would be in. */
    stampAlign: 'justify-center',
    stamp: 'pt-0.5 text-[9px] leading-4',
    name: 'text-sm',
    body: 'text-sm',
    /* About eight lines at this size; the "Show more" below opens the rest. */
    clamp: 'max-h-40',
    /* Floated right: at 360px a name and a time on one line is a wrap. */
    stampInline: false,
    signalRail: 'mr-2 w-6',
    signalPad: 'py-0.5 pr-2',
    signalInline: false,
  },
  room: {
    row: 'grid-cols-[36px_1fr] gap-3 px-4 py-1 hover:bg-(--hd-muted)/70',
    avatar: 'size-9',
    mark: 20,
    initials: 'text-xs',
    stampAlign: 'justify-end',
    stamp: 'pt-1.5 text-xs leading-4',
    name: 'text-base',
    body: 'text-base',
    clamp: 'max-h-48',
    /* One run at the left, the way a chat window has always read. */
    stampInline: true,
    signalRail: 'mr-3 w-9',
    signalPad: 'py-0.5 px-4 hover:bg-(--hd-muted)/70',
    signalInline: true,
  },
} as const

export type ChannelMessageProps = {
  /** The sender's display name — "You", or the conversation and its agent. */
  readonly from: string
  /** The sender's mark. Absent for a person, who gets initials instead. */
  readonly brand?: Brand
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
  /** The panel's glance, or the room's conversation. See `DENSITY`. */
  readonly density?: ChannelDensity
  readonly onDeliver?: () => void
}

const INITIALS = (name: string): string =>
  name
    .split(/\s+/)
    .slice(0, 2)
    .map((word) => word[0] ?? '')
    .join('')
    .toUpperCase()

/** The identity tints, as the fill/ink pairs the token layer declares. */
const TINT: Record<NonNullable<ChannelMessageProps['tint']>, string> = {
  blue: 'bg-(--hd-tint-blue-fill) text-(--hd-tint-blue-ink)',
  green: 'bg-(--hd-tint-green-fill) text-(--hd-tint-green-ink)',
  amber: 'bg-(--hd-tint-amber-fill) text-(--hd-tint-amber-ink)',
  violet: 'bg-(--hd-tint-violet-fill) text-(--hd-tint-violet-ink)',
  rose: 'bg-(--hd-tint-rose-fill) text-(--hd-tint-rose-ink)',
  teal: 'bg-(--hd-tint-teal-fill) text-(--hd-tint-teal-ink)',
}

const TROUBLE: Record<string, string> = {
  refused: 'bg-(--hd-tint-rose-fill) text-(--hd-tint-rose-ink)',
  held: 'bg-(--hd-tint-amber-fill) text-(--hd-tint-amber-ink)',
  queued: 'bg-muted text-muted-foreground',
}

export const ChannelMessage = ({
  from,
  brand,
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
  density = 'panel',
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
  const size = DENSITY[density]
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
    <div
      className={`group grid ${size.row} data-[grouped]:py-0`}
      data-grouped={grouped ? '' : undefined}
      data-state={state}
      data-density={density}
    >
      <div className={`flex ${grouped ? size.stampAlign : 'justify-center'}`}>
        {grouped ? (
          // The grouped row's own moment, offered on hover or focus where
          // the face would be — the way a chat app answers "when exactly?".
          // Faded, never hidden: opacity keeps the time in the
          // accessibility tree, so a screen reader hears it whether or not
          // a pointer ever passes.
          <span
            className={`${size.stamp} text-muted-foreground tabular-nums opacity-0 select-none group-hover:opacity-100 group-focus-within:opacity-100`}
          >
            {at}
          </span>
        ) : (
          // The face is decoration — the header says who spoke in words.
          <Avatar aria-hidden="true" className={`${size.avatar} ${TINT[tint]}`}>
            <AvatarFallback className={`bg-transparent ${size.initials} ${TINT[tint]}`}>
              {brand ? <BrandMark brand={brand} size={size.mark} /> : INITIALS(from)}
            </AvatarFallback>
          </Avatar>
        )}
      </div>

      <div className="min-w-0">
        {!grouped && (
          <div className="mb-px flex items-baseline gap-1.5">
            {wrap(
              <span className={`truncate ${size.name} font-semibold text-foreground`}>{from}</span>,
            )}
            {/* `min-w-0`, or `truncate` is decoration: a flex item will not
                shrink below its content without it, and a recipient list of
                138 names ran off the row and gave the channel a scrollbar. */}
            {to && (
              <span className="min-w-0 truncate text-xs text-muted-foreground" title={`to ${to}`}>
                to {to}
              </span>
            )}
            {/* The room reads the attribution as one run — name, who it went
                to, when, and how it went — because that is the line every chat
                window has. The panel floats the time and the state right,
                where 360px cannot afford the wrap. */}
            <span
              className={`flex items-baseline gap-1.5 text-xs text-muted-foreground tabular-nums ${
                size.stampInline ? 'min-w-0' : 'ml-auto flex-none'
              }`}
            >
              {size.stampInline ? (
                <>
                  <span>{at}</span>
                  {whisper && <span aria-hidden>&middot;</span>}
                  {whisper && <span>{whisper}</span>}
                </>
              ) : (
                <>
                  {whisper && <span>{whisper}</span>}
                  <span>{at}</span>
                </>
              )}
            </span>
          </div>
        )}

        {/* `body` when the app gave one, the words themselves otherwise.

            Clamped by height rather than `line-clamp`: line clamping needs
            `display: -webkit-box`, which flattens the very blocks — lists,
            fences, quotes — that a rendered body is made of. */}
        <div
          ref={bodyRef}
          className={`${size.body} break-words text-foreground ${
            body ? '' : 'whitespace-pre-wrap'
          } ${expanded ? '' : `${size.clamp} overflow-hidden`}`}
        >
          {body ?? text}
        </div>
        {(overflows || expanded) && (
          <button
            type="button"
            data-slot="channel-more"
            className="mt-1 text-xs text-muted-foreground hover:text-foreground hover:underline"
            onClick={() => setExpanded((on) => !on)}
          >
            {expanded ? 'Show less' : 'Show more'}
          </button>
        )}

        {outcomes && outcomes.length > 0 && (
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
            {outcomes.map((outcome) => (
              <span
                key={`${outcome.state}-${outcome.reason ?? ''}`}
                className="flex items-center gap-1.5"
              >
                <Badge className={`border-transparent ${TROUBLE[outcome.state] ?? 'bg-muted text-muted-foreground'}`}>
                  {outcome.state}
                </Badge>
                <span className="text-xs text-muted-foreground">
                  {outcome.names.join(', ')}
                  {outcome.reason ? ` — ${outcome.reason}` : ''}
                </span>
              </span>
            ))}
          </div>
        )}

        {(state === 'held' || state === 'refused' || state === 'queued') && (
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
            <Badge className={`border-transparent ${TROUBLE[state]}`}>{state}</Badge>
            {reason && (
              <span className="min-w-0 flex-1 basis-48 text-xs text-muted-foreground">
                {reason}
              </span>
            )}
            {state === 'held' && onDeliver && (
              <Button variant="outline" size="sm" onClick={onDeliver}>
                Deliver now
              </Button>
            )}
          </div>
        )}

        {refusedFirst && (
          <p className="mt-1 text-xs text-muted-foreground">
            First attempt refused — {refusedFirst}
          </p>
        )}

        {envelope && (
          <>
            {/* The exact envelope is a diagnostic, not part of reading the
                message, so the room holds it back until the pointer or the
                keyboard arrives — opacity, never `hidden`, so it stays in the
                accessibility tree and stays tabbable. The panel is already a
                diagnostic surface and keeps it up. */}
            <button
              type="button"
              data-slot="channel-peek"
              className={`mt-1 text-xs text-muted-foreground hover:text-foreground hover:underline ${
                density === 'room' && !peeking
                  ? 'opacity-0 group-hover:opacity-100 group-focus-within:opacity-100'
                  : ''
              }`}
              aria-expanded={peeking}
              onClick={() => setPeeking((on) => !on)}
            >
              {peeking ? 'Hide envelope' : 'Envelope'}
            </button>
            {peeking && (
              <pre className="mt-1.5 overflow-x-auto rounded-md bg-muted p-2 font-mono text-xs leading-[1.4] whitespace-pre-wrap">
                {envelope}
              </pre>
            )}
          </>
        )}
      </div>
    </div>
  )
}
ChannelMessage.displayName = 'ChannelMessage'

/**
 * A board event — claimed, completed, released. The spine the messages hang
 * off: one line, quiet, never a slab, because thirty of them is a normal
 * afternoon and they are read as a sequence rather than one at a time.
 */
export const ChannelSignal = ({
  by,
  said,
  at,
  density = 'panel',
}: {
  readonly by: string
  /** The whole sentence after the actor — "claimed #1 — verify never builds…". */
  readonly said: string
  readonly at: string
  readonly density?: ChannelDensity
}) => (
  <div className={`flex items-baseline ${DENSITY[density].signalPad}`}>
    {/* The rail holds the avatar column open so a signal's sentence starts on
        the same line as a message's name — which is why it takes the density
        with it. Nothing is drawn in it: the alignment is the spine, and a dash
        here read as an artifact rather than a thread. */}
    <span className={`${DENSITY[density].signalRail} flex-none`} aria-hidden />
    <span className="min-w-0 flex-1 text-xs text-muted-foreground">
      <span className="font-medium">{by}</span> {said}
      {/* The room's messages carry their time inline, so a signal that kept a
          right-hand column would be the only thing left on that edge — and
          these sentences wrap, which put the time beside the *first* line of a
          three-line signal. At the end of the sentence it is where the reader
          finishes reading. */}
      {DENSITY[density].signalInline && (
        <span className="ml-1.5 tabular-nums whitespace-nowrap">{at}</span>
      )}
    </span>
    {!DENSITY[density].signalInline && (
      <span className="ml-1.5 flex-none text-xs text-muted-foreground tabular-nums">{at}</span>
    )}
  </div>
)
ChannelSignal.displayName = 'ChannelSignal'

/**
 * What each cause is called where a person reads it, and how it is tinted.
 *
 * Amber for a limit: it is nobody's mistake and it comes back on its own.
 * Rose for a sign-in that lapsed, which somebody has to go and fix.
 */
const CAUSE = {
  limit: { word: 'usage limit', chip: 'bg-(--hd-tint-amber-fill) text-(--hd-tint-amber-ink)' },
  auth: { word: 'signed out', chip: 'bg-(--hd-tint-rose-fill) text-(--hd-tint-rose-ink)' },
  stopped: { word: 'stopped', chip: 'bg-muted text-muted-foreground' },
  /* Not a failure and not the agent's fault: the conversation is not in that
     agent's history any more, so there is nothing left to address. Quiet ink,
     because the row is a fact about the roster rather than something to fix. */
  gone: { word: 'left the room', chip: 'bg-muted text-muted-foreground' },
} as const

/**
 * A row about a member rather than from one: its turn ended without an answer.
 *
 * Shaped like a signal — the same rail, the same aside voice — because it is
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
  density = 'panel',
}: {
  readonly about: string
  readonly cause: 'limit' | 'auth' | 'stopped' | 'gone'
  /** The runtime's own words. */
  readonly text: string
  readonly at: string
  readonly density?: ChannelDensity
}) => (
  <div className={`flex items-baseline ${DENSITY[density].signalPad}`}>
    <span className={`${DENSITY[density].signalRail} flex-none`} aria-hidden />
    <span className="min-w-0 flex-1 text-xs text-muted-foreground">
      <Badge className={`mr-1.5 border-transparent align-baseline ${CAUSE[cause].chip}`}>
        {CAUSE[cause].word}
      </Badge>
      <span className="font-medium">{about}</span> {text}
      {DENSITY[density].signalInline && (
        <span className="ml-1.5 tabular-nums whitespace-nowrap">{at}</span>
      )}
    </span>
    {!DENSITY[density].signalInline && (
      <span className="ml-1.5 flex-none text-xs text-muted-foreground tabular-nums">{at}</span>
    )}
  </div>
)

ChannelNotice.displayName = 'ChannelNotice'
