import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
  type Ref,
} from 'react'

import {
  TEAM_MESSAGE_CHARS,
  type SessionId,
  type SessionKey,
  type TeamPeerInfo,
} from '@harnessdesk/protocol'

import type { Brand } from '../lib/brands'
import { closeMentionGap, cycle, detectMention, stripMention } from '../lib/triggers'
import { useSnapshot, useStore } from '../state/context'
import {
  ComposerChip,
  ComposerChips,
  ComposerGap,
  ComposerSend,
  ComposerShell,
  ComposerText,
  ComposerTools,
} from '../design/ui'
import { BrandMark } from './BrandIcons'
import { AgentIcon, SendIcon, TeamIcon } from './Icons'
import { Menu, MenuItem, MenuLabel, MenuNote, MenuSeparator, MenuToggle } from './Menu'
import { Popover } from './Popover'
import { TriggerMenu, type TriggerItem } from './TriggerMenu'

/**
 * What the composer needs to know about one member.
 *
 * A projection of the row the rail draws, handed down rather than fetched
 * again — the roster and the recipient menu answering "who is here" from two
 * different reads is how a composer offers a member the rail has crossed out.
 * `busy` in particular is live for a conversation this renderer has open and
 * the host's snapshot otherwise, and that resolution belongs in one place.
 *
 * Structural, so the pane's own `Member` is one of these without a mapping.
 */
export interface RoomMember {
  readonly key: SessionKey
  readonly peer: TeamPeerInfo
  readonly brand: Brand | null
  readonly busy: boolean
  readonly canUseBoard: boolean
  readonly title: string | null
}

/**
 * What the room can ask of its composer from outside.
 *
 * One verb, because there is one thing another surface in a room legitimately
 * wants: *put this member in the audience*. A name card hanging off a message
 * in the chat offers **Message** and has to land somewhere; before the
 * audience existed that was `setTo` on the pane's own state, and moving the
 * state into this component took the destination away with it.
 *
 * Deliberately not a controlled `to`/`onTo` pair. The audience belongs with
 * the words — it is part of writing the message, and lifting it into the pane
 * would make every keystroke of the draft the pane's business too.
 */
export interface RoomComposerHandle {
  /** Adds a member to the audience, as picking them from `@` would. */
  readonly address: (key: SessionKey) => void
}

/**
 * A run of members, named. Three and then a count, because the sentence this
 * lands in is read at a glance and a room can hold a hundred.
 */
const nameList = (members: readonly RoomMember[]): string => {
  const names = members.map((one) => one.peer.nickname)
  if (names.length <= 3) return names.join(', ')
  return `${names.slice(0, 3).join(', ')} and ${names.length - 3} more`
}

/** The audience, named the way a person would say it. */
const audienceLabel = (chosen: readonly RoomMember[]): string => {
  if (chosen.length === 0) return 'Everyone'
  const names = chosen.map((one) => one.peer.nickname)
  if (names.length <= 2) return names.join(', ')
  return `${names.slice(0, 2).join(', ')} +${names.length - 2}`
}

/**
 * The room's composer.
 *
 * The conversation's box asks *which agent answers*; this one asks **who this
 * reaches**, and that is the only difference in the design. Everything else —
 * the shell, the 14px text well, the ghost anchor on the left, the round
 * accent coin on the right, the weight that coin takes when the message will
 * be held — is the conversation's, because the two boxes sit one click apart
 * inside this pane and two things that nearly match read worse than two that
 * plainly differ.
 *
 * ---------------------------------------------------------------------------
 * The audience is one piece of state with three ways in
 *
 * A `<select>` held it before, which could say *one* or *all* and nothing
 * between — so "Opus and GPT, compare your findings" was two posts or a trip
 * to the board, in a surface whose whole reason for existing is that work
 * splits. It also could not carry what the reader needs to choose: a member
 * has a brand, a model, a light saying it is mid-turn, and sometimes a
 * refusal — *cannot take jobs, tools not reachable* — and an `<option>` is a
 * string.
 *
 *   The anchor   leftmost in the tool row, where the conversation puts the
 *                agent. Reads `Everyone`, or `Opus`, or `Opus, GPT +1`.
 *   The chips    above the text, when the audience is narrowed. Removable.
 *   `@`          for hands already typing.
 *
 * `@` **builds the audience; it does not notify.** Slack's meaning cannot be
 * imported, because here delivery *is* notification: a post is pushed into
 * each member's context as an ordinary user prompt — it wakes them, it costs
 * a turn, it spends the user's money. A mention that did not change who
 * receives the message would be decoration with a bill attached. Naming
 * somebody in prose already works and needs no mechanism: the words go out
 * raw and every agent reads them.
 *
 * ---------------------------------------------------------------------------
 * What it says before you press send
 *
 * Three facts the host knows and the box used to keep to itself until after
 * the fact: a recipient mid-turn means the message is *queued*, so the coin
 * takes the tinted weight the conversation's coin takes for the same reason; a
 * recipient whose tools are unreachable will not hear it, so the line under
 * the text says so; and the host's character limit is counted here, from a
 * thousand short, because a person who learns the limit from a refused row
 * has already lost the paste.
 *
 * Board-only is the fourth, and it was a defect rather than a gap. The switch
 * stops *agents* messaging each other — `Team.setMessaging` says so in its own
 * comment, and `Team.post` has no messaging check at all — and yet this box
 * disabled itself and told the one participant who can always talk that
 * messages were off.
 */
export const RoomComposer = ({
  ref,
  room,
  members,
  messaging,
  card,
  onTrouble,
  onPosted,
}: {
  /** See `RoomComposerHandle`. React 19 passes this as an ordinary prop. */
  readonly ref?: Ref<RoomComposerHandle>
  readonly room: string
  /** The roster, or null while the host has not answered yet. */
  readonly members: readonly RoomMember[] | null
  readonly messaging: boolean
  /**
   * A member's name card, hung off the chip that carries them.
   *
   * A render prop rather than a card built here, which is the pattern the chat
   * stream already uses for the same reason: the pane owns the one reader that
   * turns a `Member` into card facts, and a second copy in here would be the
   * two surfaces disagreeing about the same agent that reader exists to
   * prevent. The composer stays ignorant of what a card is.
   *
   * The chips only. The `@` list and the audience menu are transient
   * keyboard-driven lists, and a hover card over a row being arrowed through
   * paints over the list and races the pick.
   */
  readonly card?: (key: SessionKey, node: ReactNode) => ReactNode
  readonly onTrouble: (message: string | null) => void
  /** A post of your own always brings the reader back to the floor. */
  readonly onPosted: () => void
}) => {
  const store = useStore()
  const snapshot = useSnapshot()
  const textarea = useRef<HTMLTextAreaElement>(null)
  const [draft, setDraft] = useState('')
  /** Empty is everyone. The default, and the common case by a distance. */
  const [to, setTo] = useState<readonly SessionKey[]>([])
  const [mention, setMention] = useState<{ readonly query: string } | null>(null)
  const [active, setActive] = useState(0)
  /** The draft a pick just left, until the next keystroke — see `closeMentionGap`. */
  const gap = useRef<string | null>(null)

  const roster = useMemo(() => members ?? [], [members])
  const known = members !== null

  /* The host is the referee on the limit, but the count has to happen here to
     be of any use — and the install may have moved it, so the room's own
     setting is preferred to the default it was born with. */
  const limit = useMemo(() => {
    const team = snapshot.plugins.find((one) => one.identity.id === 'team')
    const configured = team?.config?.['messageChars']
    /* The host's own bounds, to the number: it ignores a setting outside
       [200, 200000] and keeps its default. Reading the raw setting here would
       let the box refuse at 50 characters what the host would have taken. */
    return typeof configured === 'number' && configured >= 200 && configured <= 200_000
      ? Math.floor(configured)
      : TEAM_MESSAGE_CHARS
  }, [snapshot.plugins])

  /* A conversation can leave while a message to it is being written. Dropping
     it from the audience rather than sending to it is the same guard the
     `<select>` kept, generalised to a set: the alternative is a post that
     silently becomes a broadcast, or one addressed to somebody who has gone. */
  useEffect(() => {
    if (!known) return
    setTo((current) => {
      const live = current.filter((key) => roster.some((one) => one.key === key))
      /* Length is enough, and only because `live` is a *filter* of `current`:
         a subset of the same length is the same set, in the same order. It
         would not be enough for a recomputed list — one member leaving while
         another joins would come back the same length and a different set —
         which is why this stays a filter rather than a rebuild. */
      return live.length === current.length ? current : live
    })
  }, [known, roster])

  const chosen = useMemo(
    () =>
      to
        .map((key) => roster.find((one) => one.key === key))
        .filter((one): one is RoomMember => one !== undefined),
    [to, roster],
  )
  /** Who the message actually reaches: the chosen, or everybody. */
  const recipients = chosen.length > 0 ? chosen : roster
  const queued = recipients.filter((one) => one.busy)
  /* Members that cannot reach the plugin tools. They still *receive* this —
     the user's post is an ordinary turn, and `Team.post` consults no
     capability — so the warning is about what they cannot do with it, not
     about delivery. Saying "cannot take messages" here was wrong, and wrong
     in the direction that stops a person sending something that would have
     worked. */
  const boardless = recipients.filter((one) => !one.canUseBoard)
  /* Members of the room whose conversation the desk does not have open. The
     message reaches them — sending reopens the conversation, which costs
     nothing and replays what the agent already stored — but that is a thing
     worth saying before the press rather than discovering afterwards, because
     it is the difference between "this goes to two agents already reading"
     and "this wakes two agents up". */
  const away = recipients.filter((one) => !one.peer.here)
  /** Whether the whole message is held, rather than one copy of it. */
  const waits = queued.length > 0 && queued.length === recipients.length
  const over = draft.length > limit
  const empty = known && roster.length === 0
  const canSend = draft.trim().length > 0 && !over && !empty

  const items: TriggerItem[] = useMemo(() => {
    if (!mention) return []
    const needle = mention.query.toLowerCase()
    return roster
      .filter((one) =>
        [one.peer.nickname, one.peer.agent, one.peer.model, one.title]
          .filter(Boolean)
          .join(' ')
          .toLowerCase()
          .includes(needle),
      )
      .slice(0, 8)
      .map((one) => ({
        id: one.key,
        name: one.peer.nickname,
        ...(one.title ?? one.peer.model ? { hint: one.title ?? one.peer.model ?? '' } : {}),
        ...(one.brand ? { mark: <BrandMark brand={one.brand} size={13} /> } : { mark: <AgentIcon size={13} /> }),
        ...(!one.canUseBoard
          ? { badge: 'no tools', badgeTone: 'warn' as const }
          : one.busy
            ? { badge: 'working', badgeTone: 'live' as const }
            : one.peer.here
              ? {}
              : { badge: 'not open', badgeTone: 'muted' as const }),
        ...(to.includes(one.key) ? { selected: true } : {}),
      }))
  }, [mention, roster, to])

  useEffect(() => {
    setActive(0)
  }, [mention?.query, items.length])

  const address = useCallback((key: SessionKey): void => {
    setTo((current) => (current.includes(key) ? current : [...current, key]))
    setDraft((current) => {
      const left = stripMention(current)
      /* The space this pick just left, so the next keystroke can close it if
         it turns out to be punctuation — `Hey @Claude` then `,` is `Hey,`
         rather than `Hey ,`. Held for exactly one change. */
      gap.current = left
      return left
    })
    setMention(null)
    textarea.current?.focus()
    /* Nothing from this render is captured — state setters are stable and the
       textarea is a ref — so the handle below can hold one of these forever
       without going stale. It depended on `roster` before, which was neither
       needed nor true: a reader would have taken that to mean the audience is
       resolved here, and it is not. */
  }, [])

  /* Published after `address` is defined, so the handle is the same act the
     menu performs rather than a second implementation of it. */
  useImperativeHandle(ref, () => ({ address }), [address])

  const change = (value: string): void => {
    const closed = gap.current === null ? value : closeMentionGap(gap.current, value)
    gap.current = null
    setDraft(closed)
    setMention(detectMention(closed))
  }

  /**
   * The three routes a message can take out of this box, as one function.
   *
   * Nobody addressed is a broadcast the *host* resolves — its roster at send
   * time is one fewer thing this renderer can be wrong about between a fetch
   * and a keystroke. One member is a post. Two or more is a hand-out with no
   * variables: one action, one board write, one row in the channel naming
   * everyone it reached, where a loop of posts would be N of each.
   */
  const deliver = (text: string): Promise<{ readonly refused: number } | void> => {
    if (chosen.length === 0) return store.teamPost(room, text)
    if (chosen.length === 1) {
      return store.teamPost(room, text, {
        runtime: chosen[0]!.peer.runtime,
        sessionId: chosen[0]!.peer.sessionId as SessionId,
      })
    }
    return store
      .teamHandout(
        room,
        text,
        chosen.map((one) => ({
          runtime: one.peer.runtime,
          sessionId: one.peer.sessionId as SessionId,
        })),
      )
      .then((tally) => {
        if (tally.refused > 0) {
          onTrouble(`${tally.refused} of ${chosen.length} did not take it. The row in the channel says why.`)
        }
        return tally
      })
  }

  const post = (): void => {
    const text = draft.trim()
    if (!canSend || !text) return
    /* What goes back in the box if the host will not take it — the words as
       they were typed, not the trimmed copy that was sent. */
    const words = draft
    const going = deliver(text)
    /* Cleared before the wait rather than after it, which is the
       conversation's own pattern and is what makes a second press harmless: a
       box that empties only on success takes the same words twice while the
       first send is in the air, and for a hand-out that is N more messages.
       The audience is deliberately *not* cleared — a room conversation is a
       run of lines to the same people far more often than it is one line to
       one of them, and re-picking for every line is the tax that made the
       `<select>` feel like a form. */
    setDraft('')
    setMention(null)
    void going
      .then((result) => {
        // Never clear the sentence this very send just wrote.
        if (!(result && result.refused > 0)) onTrouble(null)
        onPosted()
      })
      /* The words go back in the box. A post that failed and left the field
         empty is a message the person has to write twice, and they will not
         know it failed until they look. */
      .catch(() => {
        setDraft((current) => (current.trim().length > 0 ? current : words))
        onTrouble('The host did not take that. Your words are still here.')
      })
  }

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    /* While the menu is open the keyboard belongs to it — including the Enter
       that matches nothing.
       
       That last part was a defect. `items.length > 0` guarded this whole
       block, so typing `@nobdy`, seeing "Nobody here by that name" and
       pressing Enter fell through to `post()` and broadcast a half-written
       line, `@nobdy` and all, to every member of the room. A menu on screen
       has to be what Enter answers; here it answers by going away. */
    if (mention) {
      if (event.key === 'ArrowDown' && items.length > 0) {
        event.preventDefault()
        setActive((value) => cycle(value, 1, items.length))
        return
      }
      if (event.key === 'ArrowUp' && items.length > 0) {
        event.preventDefault()
        setActive((value) => cycle(value, -1, items.length))
        return
      }
      if (event.key === 'Escape') {
        event.preventDefault()
        setMention(null)
        return
      }
      /* `isComposing` on the pick as well as on the send. Enter ends an IME
         composition — it is how a person typing Japanese or Chinese commits
         the candidate they are looking at — and taking that keystroke as a
         pick addressed whichever member happened to be highlighted and ate
         the half-typed word with it. */
      if ((event.key === 'Enter' && !event.nativeEvent.isComposing) || event.key === 'Tab') {
        event.preventDefault()
        const item = items[active]
        if (item) address(item.id as SessionKey)
        else setMention(null)
        return
      }
    }
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault()
      post()
    }
  }

  /* One line under the text, and only when there is news. The order is the
     order a person would want it: what will not arrive at all, then what will
     arrive late, then the state of the room. */
  /**
   * The one line under the text, and only when there is news.
   *
   * A list read in order rather than a ladder of ternaries, because the order
   * *is* the design and a reader should be able to see it: what will not be
   * taken at all, then who is not here, then what will arrive but cannot act
   * on it, then what will arrive late, then the state of the room. The first
   * true one wins; everything else that is also true is a second sentence
   * nobody asked for.
   */
  const notice =
    (
      [
        over && {
          tone: 'warn',
          text: `${draft.length.toLocaleString()} characters — the room's limit is ${limit.toLocaleString()}. Put long material on the board as a context package.`,
        },
        empty && {
          tone: 'muted',
          text: 'No agents in this room yet. Add one from the roster.',
        },
        boardless.length > 0 && {
          tone: 'warn',
          text: `${nameList(boardless)} will read this, but cannot claim work — the board's tools are not reachable from ${boardless.length === 1 ? 'it' : 'them'}.`,
        },
        /* Below the two above, which are about the message not landing as
           written, and above the queueing note, which is about *when* it
           lands. This one is about what sending does besides send. */
        away.length > 0 && {
          tone: 'muted',
          text:
            away.length === recipients.length
              ? `${nameList(away)} ${away.length === 1 ? 'is' : 'are'} not open — sending opens ${away.length === 1 ? 'that conversation' : 'those conversations'} and delivers.`
              : `${nameList(away)} ${away.length === 1 ? 'is' : 'are'} not open; sending opens ${away.length === 1 ? 'it' : 'them'} too.`,
        },
        /* Whether the *message* waits or only one copy of it does. A broadcast
           to five where one is mid-turn goes to four of them now, and "this
           waits for the turn to end" over that is a sentence the channel
           contradicts a second later. */
        queued.length > 0 && {
          tone: 'muted',
          text:
            queued.length === recipients.length
              ? `${nameList(queued)} ${queued.length === 1 ? 'is' : 'are'} working — this waits for the turn${queued.length === 1 ? '' : 's'} to end.`
              : `${nameList(queued)} ${queued.length === 1 ? 'is' : 'are'} working — ${queued.length === 1 ? 'that copy waits' : 'those copies wait'} for the turn${queued.length === 1 ? '' : 's'} to end. The rest go now.`,
        },
        !messaging && {
          tone: 'muted',
          text: 'Board-only is on: the agents cannot message each other. You still can.',
        },
      ] as const
    ).find((one): one is { readonly tone: 'warn' | 'muted'; readonly text: string } => one !== false) ?? null

  return (
    <ComposerShell className="relative">
      {mention && (
        <TriggerMenu
          title="Address"
          items={items}
          activeIndex={active}
          onHover={setActive}
          onPick={(item) => address(item.id as SessionKey)}
          emptyLabel="Nobody here by that name"
        />
      )}

      {chosen.length > 0 && (
        <ComposerChips>
          {chosen.map((one) => (
            <ComposerChip
              key={one.key}
              className="bg-(--hd-accent-dim) text-(--hd-accent)"
              title={
                one.canUseBoard
                  ? one.busy
                    ? `${one.peer.nickname} is working — this waits for the turn to end.`
                    : `Goes to ${one.peer.nickname} alone.`
                  : `${one.peer.nickname} will read this, but cannot claim work — the board's tools are not reachable from it.`
              }
              onRemove={() => setTo((current) => current.filter((key) => key !== one.key))}
            >
              {/* The mark and the name together, as one trigger — the rule
                  every agent the room draws keeps, the rail's rows included:
                  the card answers to the whole of who this is. The ✕ stays
                  outside it, because a card that opened over the button that
                  removes the chip would be a card in the way of the one verb
                  the chip already has. */}
              {(card ?? ((_key, node) => node))(
                one.key,
                <span className="inline-flex items-center gap-1">
                  {one.brand ? <BrandMark brand={one.brand} size={11} /> : <AgentIcon size={11} />}
                  {one.peer.nickname}
                </span>,
              )}
            </ComposerChip>
          ))}
        </ComposerChips>
      )}

      <ComposerText
        ref={textarea}
        value={draft}
        placeholder="Message the room — @ to address someone"
        onChange={(event) => change(event.target.value)}
        onKeyDown={onKeyDown}
      />

      {notice && (
        <div
          className={`px-3.5 pb-1 text-xs ${notice.tone === 'warn' ? 'text-(--hd-warning-ink)' : 'text-(--hd-muted-foreground)'}`}
        >
          {notice.text}
        </div>
      )}

      <ComposerTools>
        <Popover
          drop="up"
          align="left"
          /* The title becomes the accessible name (the label is a glyph and a
             span, not a string), so it has to *carry* the audience rather than
             describe the control — a screen reader on "Who this reaches" is
             told what the button is for and not what it currently says. */
          title={
            chosen.length === 0
              ? 'This message reaches everyone in the room'
              : `This message reaches ${audienceLabel(chosen)}`
          }
          label={
            <>
              {chosen.length === 1 && chosen[0]!.brand ? (
                <BrandMark brand={chosen[0]!.brand!} size={13} />
              ) : (
                <TeamIcon size={13} />
              )}
              <span>{audienceLabel(chosen)}</span>
            </>
          }
        >
          {(close) => (
            <Menu close={close}>
              <MenuItem
                icon={<TeamIcon />}
                label="Everyone in the room"
                selected={chosen.length === 0}
                onSelect={() => setTo([])}
              />
              <MenuSeparator />
              <MenuLabel>Address only</MenuLabel>
              <MenuNote>Each one gets the message; nobody else is woken.</MenuNote>
              {roster.map((one) => (
                <MenuToggle
                  key={one.key}
                  icon={one.brand ? <BrandMark brand={one.brand} size={14} /> : <AgentIcon size={14} />}
                  label={one.peer.nickname}
                  /* Who this is on the line under the name; what is true of it
                     right now at the end of the row. Two facts, two places —
                     joined by a middle dot they truncate each other, and the
                     half that survives is whichever happened to be shorter. */
                  hint={one.title ?? one.peer.model ?? undefined}
                  value={
                    !one.canUseBoard ? (
                      <span className="text-(--hd-warning-ink)">no tools</span>
                    ) : one.busy ? (
                      'working'
                    ) : undefined
                  }
                  checked={to.includes(one.key)}
                  onChange={(next) =>
                    setTo((current) =>
                      next
                        ? current.includes(one.key)
                          ? current
                          : [...current, one.key]
                        : current.filter((key) => key !== one.key),
                    )
                  }
                />
              ))}
              {roster.length === 0 && (
                /* Not yet answered is not the same fact as nobody here, and
                   only one of the two is a claim this surface may make. */
                <MenuNote>
                  {known ? 'No agents in this room yet.' : 'Still asking the host who is in the room.'}
                </MenuNote>
              )}
            </Menu>
          )}
        </Popover>

        <ComposerGap />

        {/* The count appears a thousand short of the ceiling and not before:
            a number on every message is a number nobody reads. */}
        {draft.length > limit - 1000 && (
          <span
            className={`text-xs tabular-nums ${over ? 'text-(--hd-warning-ink)' : 'text-(--hd-muted-foreground)'}`}
          >
            {draft.length.toLocaleString()} / {limit.toLocaleString()}
          </span>
        )}

        {/* `later` is a claim about the whole message, so it is spent only when
            the whole message waits. A broadcast that reaches four of five now
            is a send, and the line above says which copy is held. */}
        <ComposerSend
          aria-label={waits && canSend ? 'Send when the turn ends' : 'Send'}
          data-when={!canSend ? 'nothing' : waits ? 'later' : 'now'}
          {...(canSend && waits
            ? { title: 'Held by the host until the turn it is waiting on ends.' }
            : {})}
          disabled={!canSend}
          onClick={post}
        >
          <SendIcon />
        </ComposerSend>
      </ComposerTools>
    </ComposerShell>
  )
}
