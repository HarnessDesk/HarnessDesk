import { useMemo, type ReactNode } from 'react'

import type {
  TeamActor,
  TeamEntry,
  TeamMessage,
  TeamNotice,
  TeamSignal,
} from '@harnessdesk/protocol'

import { useSnapshot, useStore } from '../state/context'
import type { AppSnapshot } from '../state/store'
import { Badge, Separator } from '../design/ui'
import { ChannelMessage, ChannelNotice, ChannelSignal, type ChannelDensity } from '../design'
import { type Brand, brandForRuntime } from '../lib/brands'
import { Markdown } from './Markdown'

/**
 * The channel: what the conversations on one board said, in order.
 *
 * One stream carries both kinds of event — agent messages *and* board
 * signals — because "what happened while I was away" is one question, not
 * two. Every delivery state is shown rather than implied: *delivered*,
 * *queued*, *held*, or *refused and why*, with the exact envelope the
 * receiver saw one press away, because trust in this surface comes from
 * being able to check it, once.
 *
 * This lived inside a Team panel that also drew the board and a composer.
 * The room pane draws all three now, better and at a size worth reading, so
 * the panel is gone and what is left here is the part that was never the
 * panel's: the derivation, and the rows it produces. Presentation and the
 * host's verbs only — where it is mounted, and how wide, is the caller's.
 */

const timeOf = (at: number): string =>
  new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })

/** One calendar day, as an identity — the unit the channel divides on. */
const dayOf = (at: number): string => new Date(at).toDateString()

const dayLabel = (at: number): string => {
  const date = new Date(at)
  return date.toLocaleDateString([], {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    ...(date.getFullYear() !== new Date().getFullYear() ? { year: 'numeric' as const } : {}),
  })
}

const SIGNAL_WORD: Record<string, string> = {
  added: 'added',
  claimed: 'claimed',
  released: 'released',
  blocked: 'marked blocked',
  unblocked: 'unblocked',
  completed: 'completed',
  abandoned: 'abandoned',
  reopened: 'reopened',
  conflict: 'hit a conflict on',
}


/** Identity tints, in the order senders first speak. The user always holds blue. */
const TINTS = ['violet', 'green', 'amber', 'teal', 'rose'] as const

type Tint = (typeof TINTS)[number] | 'blue'

/** One sender, stable across their messages — the conversation, not the agent. */
const senderKey = (actor: TeamActor): string =>
  actor.kind === 'user' ? 'user' : `${actor.runtime}\u0000${actor.sessionId}`

/** A run of messages from one sender is one person talking. */
const GROUP_WINDOW_MS = 5 * 60 * 1000

/**
 * Who a fan-out reached, said in one breath. Three names and a count past
 * four: a hand-out to 138 members printed 138 names on one line and pushed
 * a horizontal scrollbar into the channel. The full list is what the title
 * carries, for whoever hovers.
 */
export const nameSome = (names: readonly string[]): string =>
  names.length <= 4 ? names.join(', ') : `${names.slice(0, 3).join(', ')} and ${names.length - 3} more`

/**
 * What the channel shows, which is not quite what the host stored.
 *
 * Two derivations, both about reading rather than record-keeping. The host
 * keeps every attempt, because a message that did not land is exactly what
 * this surface exists to show; but a refusal followed by the same text
 * delivered is *one* thing that happened to the reader, and printing both in
 * full made the panel unreadable the first time two agents talked — the same
 * nine-hundred-word review, twice, differing by a word in the corner. So the
 * refusal is absorbed into the row that succeeded and kept as a footnote.
 *
 * And a sender who says three things in a minute says them once: the second
 * and third rows drop the header and keep the body.
 *
 * Exported because anything that *counts* the channel has to count the same
 * things it draws. The room's "new messages" pill counted raw entries, so one
 * broadcast to three agents — three stored rows, one drawn row — read as three
 * new messages, and a claim signal read as a message.
 */
export const readChannel = (
  channel: readonly TeamEntry[],
): readonly (
  | { readonly kind: 'signal'; readonly entry: TeamSignal }
  | { readonly kind: 'notice'; readonly entry: TeamNotice }
  | {
      readonly kind: 'message'
      readonly entry: TeamMessage
      readonly grouped: boolean
      readonly refusedFirst?: string
      /** Everyone one broadcast reached, when the host stored a row each. */
      readonly reached?: readonly string[]
      /** Outcomes among those recipients that differ from this row's own. */
      readonly outcomes?: readonly { readonly state: string; readonly names: readonly string[] }[]
    }
)[] => {
  // Pass zero: a post to everyone is stored once per recipient, because a
  // delivery state belongs to a delivery and the user's one sentence may reach
  // one agent and miss another. That is right for the record and wrong for the
  // reader, who typed it once.
  //
  // One broadcast is one row. The header names everyone it went to; the
  // outcomes that differ from the row's are named under it as chips. This used
  // to emit a row per outcome, which printed the same sentence twice — "to
  // Gemini, GPT · delivered" above "to Haiku · queued" — and read as the app
  // having sent the message twice. The exception is the news; the words are
  // not news the second time.
  const fanout = new Map<string, string[]>()
  const merged = new Set<string>()
  /** The outcomes a row stands in for, other than its own. */
  const otherOutcomes = new Map<string, { state: string; names: string[] }[]>()
  for (let i = 0; i < channel.length; i += 1) {
    const head = channel[i]
    if (head?.kind !== 'message' || !head.to) continue
    if (merged.has(head.id)) continue
    /** Every copy of this broadcast, whatever became of it. */
    const copies: TeamMessage[] = [head]
    for (let j = i + 1; j < channel.length; j += 1) {
      const next = channel[j]
      // One sentence typed once and stored per recipient, or one hand-out
      // rendered per member: both are one action, and read as one row. A
      // hand-out's copies differ in their words — that is what it is for —
      // so they are tied by the batch they came from, not by their text.
      const sameBatch = head.batch != null && next?.kind === 'message' && next.batch?.id === head.batch.id
      if (
        next?.kind !== 'message' ||
        !next.to ||
        senderKey(next.from) !== senderKey(head.from) ||
        (!sameBatch && next.text !== head.text)
      ) {
        break
      }
      copies.push(next)
      merged.add(next.id)
    }
    if (copies.length === 1) {
      merged.delete(head.id)
      continue
    }
    const nameOf = (copy: TeamMessage): string => copy.to?.nickname ?? copy.to?.title ?? ''
    // Everyone it went to, in the order the host stored them.
    fanout.set(head.id, copies.map(nameOf))
    /* The reason is part of the outcome, not a decoration on it. Two copies
       both `refused` — one because the conversation had closed, one because
       the send itself failed — are two different pieces of news, and keying
       on the state alone collapsed them into one chip and silently dropped
       the second reason. Which is the actionable difference this channel
       exists to keep. */
    const outcomeOf = (copy: TeamMessage): string => `${copy.state}\u0000${copy.reason ?? ''}`
    const byOutcome = new Map<string, TeamMessage[]>()
    for (const copy of copies) {
      byOutcome.set(outcomeOf(copy), [...(byOutcome.get(outcomeOf(copy)) ?? []), copy])
    }
    // The row wears the outcome most of them share; the rest are named under it.
    const rest = [...byOutcome.values()]
      .filter((group) => outcomeOf(group[0] as TeamMessage) !== outcomeOf(head))
      .map((group) => {
        const one = group[0] as TeamMessage
        return {
          state: one.state,
          names: group.map(nameOf),
          ...(one.reason ? { reason: one.reason } : {}),
        }
      })
    if (rest.length > 0) otherOutcomes.set(head.id, rest)
  }

  // Pass one: absorb a refusal into the later attempt that carried the same
  // text from the same sender. Only forwards, and only into a row that is not
  // itself refused — two refusals are two failures and both are news.
  const absorbed = new Map<string, string>()
  const skip = new Set<string>()
  channel.forEach((entry, index) => {
    if (entry.kind !== 'message' || entry.state !== 'refused') return
    const later = channel.slice(index + 1).find(
      (next) =>
        next.kind === 'message' &&
        next.state !== 'refused' &&
        next.text === entry.text &&
        senderKey(next.from) === senderKey(entry.from),
    )
    if (!later) return
    skip.add(entry.id)
    absorbed.set(later.id, entry.reason ?? 'the host would not send it as addressed')
  })

  const rows: (
    | { kind: 'signal'; entry: TeamSignal }
    | { kind: 'notice'; entry: TeamNotice }
    | {
        kind: 'message'
        entry: TeamMessage
        grouped: boolean
        refusedFirst?: string
        reached?: readonly string[]
        outcomes?: readonly {
          readonly state: string
          readonly names: readonly string[]
          readonly reason?: string
        }[]
      }
  )[] = []
  let last: { key: string; at: number } | null = null

  for (const entry of channel) {
    if (entry.kind === 'signal') {
      rows.push({ kind: 'signal', entry })
      // A signal between two messages ends the run: something happened in
      // between, so the next message introduces itself again.
      last = null
      continue
    }
    if (entry.kind === 'notice') {
      rows.push({ kind: 'notice', entry })
      last = null
      continue
    }
    if (skip.has(entry.id) || merged.has(entry.id)) continue
    // A run is one sender speaking to one audience. The header is the only
    // place a recipient is named, so an addressed message may join a run only
    // behind another to the same member: a room of a hundred handed a page
    // each read as one wall of text, with no way to tell which member any of
    // it was for.
    const key = `${senderKey(entry.from)}\u0000${entry.to ? `${entry.to.runtime}\u0000${entry.to.sessionId}` : 'everyone'}`
    // Only a delivered message joins a run. A grouped row has no header, and
    // the header is where a state is said — so anything that is not the
    // expected outcome introduces itself, every time, and carries its chip.
    const grouped =
      entry.state === 'delivered' &&
      last !== null &&
      last.key === key &&
      entry.at - last.at < GROUP_WINDOW_MS
    const reason = absorbed.get(entry.id)
    const reached = fanout.get(entry.id)
    rows.push({
      kind: 'message',
      entry,
      grouped,
      ...(reason !== undefined ? { refusedFirst: reason } : {}),
      ...(reached ? { reached } : {}),
      ...(otherOutcomes.get(entry.id) ? { outcomes: otherOutcomes.get(entry.id) } : {}),
    })
    last = { key, at: entry.at }
  }
  return rows
}

/** The day said once, between the last of one day and the first of the next. */
const DayDivider = ({ label, density = 'panel' }: { label: string; density?: ChannelDensity }) => (
  <div
    className={`my-1 flex items-center ${density === 'room' ? 'px-4' : 'px-3'}`}
    role="separator"
    aria-label={label}
  >
    <Separator className="w-auto flex-1" />
    <Badge variant="outline" className="mx-2 bg-background font-normal text-muted-foreground">
      {label}
    </Badge>
    <Separator className="w-auto flex-1" />
  </div>
)

/**
 * The channel, rendered.
 *
 * Exported because two surfaces show it now — this panel and the room pane —
 * and a second copy of the grouping, the retry-collapse and the day dividers
 * would be two channels agreeing by hand, with the fifteen tests that pin
 * this behaviour pinning only one of them. What the two callers bring is
 * their own chrome; what a message *is* lives here.
 */
export const ChannelStream = ({
  entries,
  room,
  onTrouble,
  density = 'panel',
  identify,
}: {
  readonly entries: readonly TeamEntry[]
  readonly room: string
  readonly onTrouble: (message: string | null) => void
  /** The panel's glance, or the room's conversation. See `ChannelMessage`. */
  readonly density?: ChannelDensity
  /**
   * Hangs something off a message's face and author name — a name card, where
   * the caller knows the roster.
   *
   * Passed down rather than built here on purpose. The channel knows who spoke
   * (a runtime and a session id) but not whether that member can take a job or
   * what it is holding, and those facts live on the room's roster. Building a
   * thinner card here would give the room two answers about one member, which
   * is the failure the roster was centralised to prevent.
   */
  readonly identify?: (actor: TeamActor, node: ReactNode) => ReactNode
}) => {
  const store = useStore()
  const snapshot = useSnapshot()
  const rows = useMemo(() => readChannel(entries), [entries])

  /* A sender's colour is assigned in the order they first speak on this board,
     so it is stable for as long as the channel is and identical for everyone
     reading it. The user always holds blue. */
  const tints = useMemo(() => {
    const out = new Map<string, (typeof TINTS)[number] | 'blue'>()
    let next = 0
    for (const entry of entries) {
      const who = entry.kind === 'signal' ? entry.by : entry.kind === 'notice' ? entry.about : entry.from
      const key = senderKey(who)
      if (out.has(key)) continue
      out.set(key, who.kind === 'user' ? 'blue' : (TINTS[next++ % TINTS.length] as (typeof TINTS)[number]))
    }
    return out
  }, [entries])

  const setTrouble = onTrouble
  const nodes = (() => {
    const nodes: ReactNode[] = []
    let day: string | null = null
    for (const row of rows) {
      if (dayOf(row.entry.at) !== day) {
        day = dayOf(row.entry.at)
        nodes.push(
          <DayDivider key={`day-${row.entry.at}`} label={dayLabel(row.entry.at)} density={density} />,
        )
      }
      nodes.push(
        row.kind === 'notice' ? (
          <ChannelNotice
            key={row.entry.id}
            about={actorName(row.entry.about, snapshot)}
            cause={row.entry.cause}
            text={row.entry.text}
            at={timeOf(row.entry.at)}
            density={density}
          />
        ) : row.kind === 'signal' ? (
          <ChannelSignal
            key={row.entry.id}
            by={actorName(row.entry.by, snapshot)}
            said={`${SIGNAL_WORD[row.entry.signal] ?? row.entry.signal} #${row.entry.intent} — ${row.entry.title}${row.entry.detail ? ` · ${row.entry.detail}` : ''}`}
            at={timeOf(row.entry.at)}
            density={density}
          />
        ) : (
          <ChannelMessage
            key={row.entry.id}
            from={actorName(row.entry.from, snapshot)}
            at={timeOf(row.entry.at)}
            {...(identify
              ? { identify: (node: ReactNode) => identify(row.entry.from, node) }
              : {})}
            density={density}
            text={row.entry.batch ? row.entry.batch.template : row.entry.text}
            /* Rendered here rather than in the pattern: highlighting a fence
               needs the resolved theme, and the theme is app state. A
               hand-out shows the template it was made from — the words every
               member got, slots and all — rather than the first member's copy. */
            body={<Markdown text={row.entry.batch ? row.entry.batch.template : row.entry.text} chat />}
            state={row.entry.state}
            grouped={row.grouped}
            tint={tints.get(senderKey(row.entry.from)) ?? 'blue'}
            {...(brandOf(row.entry.from, snapshot) ? { brand: brandOf(row.entry.from, snapshot) as Brand } : {})}
            {...(row.reached
              ? { to: nameSome(row.reached) }
              : row.entry.to
                ? { to: row.entry.to.nickname ?? row.entry.to.title }
                : {})}
            {...(row.entry.reason ? { reason: row.entry.reason } : {})}
            {...(row.refusedFirst !== undefined ? { refusedFirst: row.refusedFirst } : {})}
            {...(row.outcomes ? { outcomes: row.outcomes } : {})}
            {...(row.entry.envelope && row.entry.from.kind === 'agent'
              ? { envelope: row.entry.envelope }
              : {})}
            {...(row.entry.state === 'held'
              ? {
                  onDeliver: () =>
                    void store
                      .teamDeliver(room, row.entry.id)
                      .then(() => setTrouble(null))
                      .catch((error: unknown) =>
                        setTrouble(
                          error instanceof Error
                            ? error.message
                            : 'The release did not reach the host.',
                        ),
                      ),
                }
              : {})}
          />
        ),
      )
    }
    return nodes
  })()

  return <>{nodes}</>
}

/**
 * Who wrote an entry, said for a person: "You", or the conversation's name
 * with its agent — and just the agent once when the conversation is
 * untitled, because "Alpha (Alpha)" says one thing twice.
 */
const actorName = (actor: TeamActor, snapshot: AppSnapshot): string => {
  if (actor.kind === 'user') return 'You'
  const agent =
    snapshot.runtimes.find((entry) => entry.id === actor.runtime)?.presentation.name ??
    actor.runtime
  /* The room name first: it is the one that is always there and always
     distinct. Three untitled Cursor conversations fell through to the agent and
     drew three rows all saying "Cursor" — a record nobody can read a
     conversation back out of. A row written before rooms had names still has
     only its title, and still reads. */
  if (actor.nickname) {
    return actor.title && actor.title !== agent && actor.title !== actor.nickname
      ? `${actor.nickname} (${actor.title})`
      : actor.nickname
  }
  return actor.title && actor.title !== agent ? `${actor.title} (${agent})` : agent
}

/**
 * The sender's mark, when the runtime has one. Presentation is the runtime's
 * to declare — this only asks which brand it declared, and renders nothing
 * of its own when the answer is none.
 */
const brandOf = (actor: TeamActor, snapshot: AppSnapshot): Brand | null => {
  if (actor.kind === 'user') return null
  const runtime = snapshot.runtimes.find((entry) => entry.id === actor.runtime)
  return runtime ? brandForRuntime(runtime) : null
}
