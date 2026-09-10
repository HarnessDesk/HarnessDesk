import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'

import {
  isBusy,
  sessionKey,
  splitSessionKey,
  type Intent,
  type TeamActor,
  type TeamEntry,
  type TeamInbound,
  type RuntimeId,
  type SessionId,
  type SessionKey,
  type TeamPeerInfo,
} from '@harnessdesk/protocol'

import { runtimeTint, type Tint } from '../lib/accounts'
import { brandForRuntime } from '../lib/brands'
import { PaneProvider, useSnapshot, useStore } from '../state/context'
import { useMount } from '../panels/mount'
import { PanelActions } from '../panels/PanelActions'
import { BrandMark } from './BrandIcons'
import {
  AgentIcon,
  ArrowLeftIcon,
  CrossIcon,
  PlanIcon,
  PlusIcon,
  SearchIcon,
  ShieldOffIcon,
  TeamIcon,
} from './Icons'
import { AddMember } from './AddMember'
import { MemberHoverCard, type MemberCardFacts } from './AgentCards'
import { Approvals } from './Approvals'
import { Conversation } from './Conversation'
import { ChannelStream, readChannel } from './Channel'
import { RoomComposer, type RoomComposerHandle } from './RoomComposer'
import { TeamBoardPane } from './TeamBoardPane'
import {
  Button,
  EmptyState,
  IconTile,
  Input,
  ListRow,
  ListRows,
} from '../design/ui'
import styles from './TeamRoomPane.module.css'

/**
 * The empty board, as one object.
 *
 * A workspace with no board has no `TeamState`, and `?? []` there mints a new
 * array on every render — which is invisible until something *memoises* on it.
 * `readChannel` did: fresh entries meant fresh rows, fresh rows re-ran the
 * effect that follows the floor, and that effect set a new `behind` object,
 * which rendered again. A room opened on a project with no board span at 100%
 * of a core doing nothing.
 *
 * So the empty case is a constant, and identity means what identity is
 * supposed to mean.
 */
const NO_ENTRIES: readonly TeamEntry[] = []
const NO_INTENTS: readonly Intent[] = []

/** Nothing missed, as one object, for the same reason. */
const AT_THE_FLOOR = { rows: 0, onlyMessages: true } as const

/**
 * The group project, as one surface: who is here on the left, what they said
 * on the right.
 *
 * The first version of this pane was the channel and nothing else, which
 * missed the shape the design argued for and missed it in a way that mattered:
 * a room is not a stream, it is *a set of people and the conversations you can
 * have with them*. Without the roster there was nowhere to see who was on the
 * board, nowhere to reach one of them, and no way to tell a room of four
 * agents from a log.
 *
 * So the rail is first-class, and it holds the three things a group project
 * has, in the order they matter:
 *
 *   Board        what the work is, in columns.
 *   Chat         where it gets agreed. Everyone in the room reads it.
 *   The agents   one row each, saying what that agent is on right now — so
 *                the rail answers "who is doing what" without anything being
 *                opened at all.
 *
 * All three open in the right half. The rail is a list of destinations, and a
 * row that opened a *second pane* instead would be a different kind of thing
 * wearing the same clothes.
 *
 * Pressing an agent shows **that agent's own conversation, in full**, in the
 * right half. Not a summary and not a reduced view: the same `Conversation`
 * the app renders anywhere else, scoped to that session by a `PaneProvider`.
 * A group project federates conversations; it does not replace them, and an
 * agent you can only talk to through a room is an agent you have lost half of.
 *
 * ---------------------------------------------------------------------------
 * The rebuild: the rail was a list of strings
 *
 * The shape above was right and the roster underneath it was not. Every member
 * was a `ListRow` whose second line joined three unrelated facts with a middle
 * dot — what the conversation calls itself, what it is holding, whether it is
 * mid-turn — and then truncated at the rail's 232px, which meant the fact that
 * survived was whichever happened to be shortest. A person watching four
 * agents work could not answer *is anything running right now* without opening
 * something.
 *
 * So a member is a component rather than a row of text, and the facts are
 * given the form each one deserves:
 *
 *   Working      is a light, not a word. It changes many times a minute and
 *                the eye must be able to find it without reading.
 *   The job      is a chip carrying its own number, because `#3` is the thing
 *                a person says back to an agent and a truncated sentence is
 *                not.
 *   Unreachable  outranks both and wears warning ink: a member that cannot
 *                take a job at all makes the other two facts irrelevant.
 *
 * And the rail gained the two things any roster needs once it is longer than a
 * screen — a count and a filter — plus the one the *watch* feature always
 * needed: the way to put a member beside another is on every row, all the
 * time, rather than appearing only once something was already up.
 */
export const TeamRoomPane = ({
  room,
  onChooseProject = () => undefined,
  onSignIn = () => undefined,
  onOpenUsage = () => undefined,
  onOpenAgents = () => undefined,
}: {
  room: string
  /* The shell's four actions, threaded from `Panes` so the conversation
     embedded below is the same conversation everywhere else — including the
     controls that leave it. Defaulted so a mock or a preview can mount the
     room without inventing a shell. */
  onChooseProject?: () => void
  onSignIn?: (runtime?: RuntimeId) => void
  onOpenUsage?: (runtime: RuntimeId) => void
  onOpenAgents?: () => void
}) => {
  const store = useStore()
  const snapshot = useSnapshot()
  const mount = useMount()
  /**
   * The roster, and the room it belongs to.
   *
   * Keyed by the room because this pane survives being pointed at a different
   * one: the same instance is reused, so a roster kept from the last one is
   * read under the new one's name. That was invisible while a failed request
   * emptied the roster and became visible the moment failure started
   * *preserving* it — Room B, whose fetch failed, wearing Room A's agents, its
   * working count and its recipient menu.
   *
   * `null` — never asked, or asked about somewhere else — is not the same as
   * an empty answer, and only an empty answer may be drawn as one.
   */
  /* `roster` is already the derived member list further down; this is the raw
     answer it is derived from. */
  const [fetched, setFetched] = useState<{
    readonly room: string
    readonly peers: readonly TeamPeerInfo[]
  } | null>(null)
  const peers = fetched && fetched.room === room ? fetched.peers : null
  /**
   * What the right half is showing: the board, the chat, or *members*.
   *
   * Members is a list rather than one key, because reading a second harness
   * while working with the first is a real need and this is the only place it
   * is met — a conversation cannot be docked beside another any more, and the
   * commit that withdrew that said this would replace it. One member is a list
   * of one; the plural case is what that promise was about.
   */
  /* Restored from the view, so an arrangement of columns survives the middle
     being given to something else and handed back by Back. */
  const restored = mount?.view.kind === 'room' ? mount.view.watching : undefined
  const [open, setOpen] = useState<'board' | 'room' | readonly SessionKey[]>(
    restored && restored.length > 0 ? restored : 'room',
  )
  /**
   * Which column was read least recently, so a pick past the cap replaces
   * *that* one rather than the one being looked at. Most-recent last.
   */
  const [seen, setSeen] = useState<readonly SessionKey[]>(restored ?? [])
  /**
   * How many columns fit. A transcript and its composer stop being readable
   * together under about 420px, so the cap is the smaller of three and what
   * the pane can actually hold — measured, because the room gives width up to
   * the rail, the right dock and the window itself.
   */
  const [cap, setCap] = useState(3)
  const watching = useRef<HTMLDivElement | null>(null)
  /* Which half a *narrow* room is showing. Two columns need width; when the
     pane has none — a three-way split, or the details panel open beside it —
     the room becomes one column at a time, the way every master/detail list
     does, rather than two unreadable ones. At full width this is inert: the
     container query below never fires and both halves stay up. */
  const [onRail, setOnRail] = useState(true)
  /** What the roster is filtered to. Empty is the whole room. */
  const [filter, setFilter] = useState('')
  /** The "add an agent" dialog, opened from the roster's own heading. */
  const [adding, setAdding] = useState(false)
  /** The top row's own failure — the board-only switch not landing. */
  const [barTrouble, setBarTrouble] = useState<string | null>(null)
  /**
   * What the *rail* could not do, said on the rail.
   *
   * A third line rather than a share of either: the chat's `trouble` is what
   * the composer could not do and the bar's is what the top row could not do,
   * and a failed Remove reported at either of those is a sentence about a
   * control the reader is not looking at.
   */
  const [railTrouble, setRailTrouble] = useState<string | null>(null)

  const show = (next: 'board' | 'room' | SessionKey): void => {
    setOnRail(false)
    /* Written against the literals rather than narrowed: `SessionKey` is a
       branded string, so comparing it to `'board'` tells the compiler nothing
       and the union survives into the other branch. */
    if (next === 'board') return setOpen('board')
    if (next === 'room') return setOpen('room')
    // A member opens as a list of one; the plural case is `watch`.
    const key = next as SessionKey
    setOpen([key])
    setSeen((was) => [...was.filter((one) => one !== key), key])
  }

  /**
   * Add a member beside the ones already up, or replace the least-recently-read
   * column once the pane is full.
   *
   * Replacing the *focused* column would take away the one being read; the
   * least-recently-read one is the honest victim, and the rail says which
   * before the press rather than after.
   */
  const watch = (key: SessionKey): void => {
    setOpen((was) => {
      const columns = Array.isArray(was) ? [...(was as readonly SessionKey[])] : []
      if (columns.includes(key)) return columns
      if (columns.length < cap) return [...columns, key]
      const victim = seen.find((one) => columns.includes(one)) ?? columns[0]
      return columns.map((one) => (one === victim ? key : one))
    })
    setSeen((was) => [...was.filter((one) => one !== key), key])
    setOnRail(false)
  }

  /**
   * Take a member out of the room.
   *
   * The conversation is untouched — it goes back to the project's own list in
   * the sidebar, keeps its transcript, and can be added again. Only the
   * membership ends, which is why the room is what has to be told and the
   * roster re-read: nothing else on screen changes.
   */
  const leave = (key: SessionKey): void => {
    const { runtime, id } = splitSessionKey(key)
    stopWatching(key)
    setRailTrouble(null)
    void store
      .leaveRoom(room, runtime, id)
      /* The member is dropped from the answer already in hand, rather than
         the answer being thrown away. `null` means "not asked", and the rail
         draws nothing at all for it — so clearing it made the whole roster
         vanish for as long as the refetch took, and would have left it blank
         for good if the refetch had already landed by then. Filtering is both
         the smaller flicker and the one that cannot strand the rail. */
      .then(() =>
        setFetched((was) =>
          was === null || was.room !== room
            ? was
            : {
                room,
                peers: was.peers.filter(
                  (one) => sessionKey(one.runtime, one.sessionId as SessionId) !== key,
                ),
              },
        ),
      )
      .catch(() =>
        setRailTrouble('The host did not take that; the member is still in the room.'),
      )
  }

  /**
   * What one member does with a message sent to it: accept, hold, refuse.
   *
   * The room already has board-only, which is this decision taken for
   * everybody at once. A room is rarely that uniform — one member is mid-
   * refactor and must not be interrupted while the other nine may talk — and
   * until now saying so meant silencing the room. `team/inbound` has carried
   * the per-conversation setting the whole time with nothing to press.
   *
   * Patched into the roster in hand rather than refetched, for the reason
   * `leave` gives: the rail draws nothing for a `null` roster, so throwing
   * the answer away to ask again empties the rail for the length of a round
   * trip.
   */
  const setInbound = (key: SessionKey, mode: TeamInbound): void => {
    const { runtime, id } = splitSessionKey(key)
    setRailTrouble(null)
    void store
      .setTeamInbound(runtime, id, mode)
      .then(() =>
        setFetched((was) =>
          was === null || was.room !== room
            ? was
            : {
                room,
                peers: was.peers.map((one) =>
                  sessionKey(one.runtime, one.sessionId as SessionId) === key
                    ? { ...one, inbound: mode }
                    : one,
                ),
              },
        ),
      )
      .catch(() =>
        setRailTrouble('The host did not take that; the member is set as it was.'),
      )
  }

  /** Take one column down, leaving the rest up. The × and the card share it. */
  const stopWatching = (key: SessionKey): void => {
    setOpen((was) =>
      Array.isArray(was) ? (was as readonly SessionKey[]).filter((one) => one !== key) : was,
    )
  }

  /* The other half of `restored`: what is up is written back to the view as it
     changes, because the view is what Back and the next launch will read. */
  const mountId = mount?.id
  useEffect(() => {
    if (!mountId) return
    store.setRoomWatching(mountId, Array.isArray(open) ? (open as readonly SessionKey[]) : [])
  }, [store, mountId, open])

  /** Which column a pick would take, so the rail can say so before it happens. */
  const wouldReplace = (key: SessionKey): SessionKey | null => {
    const columns = Array.isArray(open) ? (open as readonly SessionKey[]) : []
    if (columns.includes(key) || columns.length < cap) return null
    return seen.find((one) => columns.includes(one)) ?? columns[0] ?? null
  }

  const team = snapshot.teams.get(room)
  const entries = team?.channel ?? NO_ENTRIES
  const intents = team?.intents ?? NO_INTENTS
  /* Read here rather than in the chat, because the switch is on the room's own
     row now and the chat is only one of the three things the room can show. */
  const messaging = team?.messaging ?? true
  /* Messages the board is holding: delivered nowhere until a person releases
     them, and the one thing in the channel that is waiting on the reader. */
  const held = entries.filter(
    (entry) => entry.kind === 'message' && entry.state === 'held',
  ).length

  /* The roster is the host's answer, not a guess from `cwd` prefixes — the
     same resolution the router uses, so a worktree is not mistaken for its
     parent. Re-read as the channel grows *and* as conversations open and
     close: both are how the set of people in the room changes, and a rail
     still listing an agent that has gone is worse than one that is a beat
     late.

     *Membership* is what this fetch answers. Whether a member is mid-turn is
     not asked here, because that changes without the set changing — the
     answer would be a roster fetched once and then wrong for the life of the
     room. It is read live from the session map instead, below.

     And it is re-read when the room's own membership moves, which is how it
     changes now: joining takes neither a new conversation nor a message, so
     with only those two triggers the rail said "Nobody here yet" beside a
     sidebar drawing the two members the room had just gained. The whole list
     rather than its length — one member leaving as another joins keeps the
     count and changes the room. */
  const sessionCount = snapshot.sessions.size
  const membership = (team?.members ?? []).join(' ')
  /* Conversations that live in this project, whether or not they have joined —
     the evidence half of the empty state below. A roster that says zero has to
     be able to say zero *of what*, and "zero of the four running here" is what
     tells somebody the room needs staffing rather than that the app is broken. */
  const root = team?.root ?? ''
  const here = useMemo(
    () =>
      root === ''
        ? 0
        : [...snapshot.sessions.values()].filter(
            (one) => one.cwd === root || one.cwd.startsWith(`${root}/`),
          ).length,
    [snapshot.sessions, root],
  )
  useEffect(() => {
    let live = true
    void store
      .teamPeers(room)
      .then((answer) => {
        if (live) setFetched({ room, peers: answer })
      })
      /* Same rule as the board's: a failed request is not an answer. Emptying
         the roster on one bad poll made the rail claim, in a full sentence,
         that nobody was in a room that was working a second ago. */
      .catch(() => undefined)
    return () => {
      live = false
    }
  }, [store, room, entries.length, sessionCount, membership])

  /* Narrowed once, here, so the provider below gets a `SessionKey` and not a
     union the compiler has to be argued with at the call site. */
  const columns: readonly SessionKey[] = Array.isArray(open) ? (open as readonly SessionKey[]) : []
  /**
   * Open the conversation behind any column that has one.
   *
   * Every other surface that puts a conversation on screen opens it first —
   * the sidebar row, the board's claim holder, the palette. This one never
   * had to, because the rail could only ever list a member the desk was
   * already holding, so `snapshot.sessions` always had it by the time a
   * column mounted. The rail lists members that are *not* open now, and
   * without this a click on one mounted `Conversation` over nothing: the
   * generic "what should we build" empty state, in a column headed by the
   * member's own name.
   *
   * Here rather than in `show` and `watch`, because there is a third way into
   * a column and it is the one that matters most — the view restores its
   * columns on the next launch, which is exactly when nothing is open.
   *
   * `reveal: false` because the column *is* the pane; revealing would replace
   * the room around it. Attempts are remembered so a re-render between the
   * request and its answer does not ask twice; a failure is `openSession`'s
   * own to report, and it does — a background notice — so nothing is said
   * again here, and the column falls back to the conversation's empty state.
   */
  const asked = useRef(new Set<SessionKey>())
  /* The session map as it is *now*, for the settle below — which runs long
     after the render that started the open, and must not decide anything from
     a closure's photograph of it. It is deliberately not a dependency: the
     open is triggered by a column appearing, and re-running this whenever any
     conversation anywhere changes would retry a failing open on somebody
     else's traffic. */
  const openNow = useRef(snapshot.sessions)
  openNow.current = snapshot.sessions
  const upFor = columns.join(' ')
  useEffect(() => {
    for (const key of upFor === '' ? [] : (upFor.split(' ') as SessionKey[])) {
      if (openNow.current.has(key) || asked.current.has(key)) continue
      asked.current.add(key)
      const { runtime, id } = splitSessionKey(key)
      void store
        .openSession(id, { runtime, reveal: false })
        /* `openSession` reports its own failures and resolves either way, so
           this is belt and braces — but it has to be a `catch` and not only a
           `finally`, which passes the rejection straight through to nobody. */
        .catch(() => undefined)
        /* Remember only what worked. Marking the attempt and never unmarking
           it made one transient failure permanent for the life of the pane:
           the agent comes back, the person closes the column and opens it
           again, and nothing asks a second time — the column stays on the
           conversation's own empty state with no way back but a remount.
           Cleared on the *outcome* rather than on the promise, because
           `openSession` reports its own failures and resolves either way. */
        .finally(() => {
          if (!openNow.current.has(key)) asked.current.delete(key)
        })
    }
  }, [store, upFor])
  /* The roster as a list. `here` is already taken, by the count of
     conversations *in the folder* — which is the other half of the zero-state
     below and deliberately a different number. */
  const members = peers ?? []
  const memberOf = (key: SessionKey): TeamPeerInfo | null =>
    members.find((peer) => sessionKey(peer.runtime, peer.sessionId as SessionId) === key) ?? null

  /**
   * Every member with the four facts the rail draws, resolved once.
   *
   * Resolved here rather than inside the row so the *head* can count them: a
   * roster that says "2 here" and a rail that shows one working agent are two
   * readings of the same list, and they must not be able to disagree.
   */
  const roster = useMemo(
    () =>
      (peers ?? []).map((peer) => {
        const key = sessionKey(peer.runtime, peer.sessionId as SessionId)
        const runtime = snapshot.runtimes.find((one) => one.id === peer.runtime) ?? null
        /* Live where we have it. A turn starting or ending changes this and
           changes nothing the roster fetch depends on, so the roster's own
           `busy` is a snapshot that goes stale the moment it is read. For a
           conversation this renderer has open, the session map is the truth and
           updates itself; for one it has never opened, the host's answer is all
           there is. */
        const live = snapshot.sessions.get(key)
        return {
          peer,
          key,
          runtime,
          here: peer.here,
          brand: runtime ? brandForRuntime(runtime) : null,
          /* The account's own ring rather than one fixed colour. A rail of
             five members all in blue says nothing, and the ring exists to
             say which account this is — see lib/accounts.ts. */
          tint: runtimeTint(peer.runtime, snapshot.accountsByRuntime, snapshot.accountPrefs),
          busy: peer.here && (live ? isBusy(live) : peer.busy),
          /* Whether this member can use the board at all. HarnessDesk's tools
             reach an agent through a server the agent has to accept; one that
             refused it can see nothing here and can claim nothing. That used to
             be discoverable only by an agent trying and being refused — the
             person watched an empty board and had no way to learn the door was
             locked. */
          canUseBoard: runtime?.capabilities?.pluginTools !== false,
          /* And whether it has ever actually used them. The line above is the
             runtime's claim about itself; this is evidence. A member that
             advertised the tools, described them back accurately, and could not
             invoke one is why both are on the row: it read as able, took
             nothing, and nothing on screen said why. Only said once there has
             been something to take — a member that has done nothing on an empty
             board has proved nothing either way.

             And only about a member that is *here*: the evidence is what this
             run has seen, so a member nobody has opened this run has proved
             nothing either way by definition. Without the gate, the first
             launch of the day accused every member of every room of ignoring
             a board it had never been shown. */
          idleOnBoard:
            peer.here &&
            runtime?.capabilities?.pluginTools !== false &&
            peer.usedBoard === false &&
            (intents.length > 0 || entries.length > 0),
          /* What this agent is on *right now*, from the board — not the last
             thing it said. That is what makes the rail answer the question
             without anything being opened.

             Both halves of the identity: session ids are unique per runtime,
             not globally, so matching the id alone put one claimed intent on
             two agents' rows the moment two runtimes minted the same id — and
             only one of them held it. */
          onTask:
            intents.find(
              (one: Intent) =>
                one.state === 'claimed' &&
                one.claim?.sessionId === peer.sessionId &&
                one.claim?.runtime === peer.runtime,
            ) ?? null,
          /* The open conversation's own title comes first and the host's roster
             second: the roster is fetched when membership changes, and a rename
             does not change membership, so reading the roster alone left a
             conversation renamed while the room was open wearing its old name
             until something else moved. */
          title: live?.title ?? peer.title ?? null,
        }
      }),
    [
      peers,
      snapshot.runtimes,
      snapshot.sessions,
      snapshot.accountsByRuntime,
      snapshot.accountPrefs,
      intents,
      entries.length,
    ],
  )

  const working = roster.filter((one) => one.busy).length
  /** Members whose conversation the desk actually has open. See the head. */
  const hereCount = roster.filter((one) => one.here).length
  /* Matched on everything a person might type: the room name, the harness, the
     model, the conversation's own title. A filter that only matched the
     nickname would be useless in the room it exists for — four Cursor
     conversations, told apart by model. */
  const needle = filter.trim().toLowerCase()
  const shown = needle
    ? roster.filter((one) =>
        [one.peer.nickname, one.peer.agent, one.peer.model, one.title]
          .filter(Boolean)
          .join(' ')
          .toLowerCase()
          .includes(needle),
      )
    : roster

  /* The cap is measured, not assumed: the room gives width up to the rail, the
     right dock and the window, so what fits is a fact about this pane right
     now. A column dropped by a narrowing pane is the least recently read. */
  useEffect(() => {
    const node = watching.current
    if (!node) return
    const measure = (): void => {
      const fits = Math.max(1, Math.min(3, Math.floor(node.getBoundingClientRect().width / 420)))
      setCap(fits)
      setOpen((was) => {
        if (!Array.isArray(was) || was.length <= fits) return was
        const keep = (was as readonly SessionKey[]).filter(
          (one) => !seen.slice(0, was.length - fits).includes(one),
        )
        return keep.slice(-fits)
      })
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(node)
    return () => observer.disconnect()
  }, [seen])

  return (
    <div className={styles.pane} data-showing={onRail ? 'rail' : 'body'}>
      {adding && <AddMember room={room} root={root} onClose={() => setAdding(false)} />}

      {/*
        * The room's one top row, across both halves.
        *
        * It replaces three things that used to be stacked here, and the reason
        * to say what they were is that each was defensible on its own:
        *
        *   The pane's strip     printed `Room — <name>` above a rail that
        *                        printed `<name>` again, with a single expand
        *                        button at the far end of an otherwise empty
        *                        44px bar.
        *   The rail's head      carried the room's mark, its name and its
        *                        counts, in a block two lines tall whose bottom
        *                        edge lined up with nothing on the other half.
        *   The chat's head      said "Chat / Everyone in this room reads this"
        *                        beside a rail row already reading "Chat /
        *                        Everyone in this room".
        *
        * Three rows, two of them saying the room's name and one of them saying
        * the selected row's name back to it. One row says all of it: which
        * room, what is happening in it, and the verbs that act on it — and
        * because it is one row across the whole pane, the rail and the body
        * below it start at the same y, which is the thing the old arrangement
        * could not do at all.
        *
        * It is also the window's top row when the sidebar is away, so it does
        * what every other top row in this app does: leaves room for the macOS
        * buttons (`--titlebar-inset`, spent in the stylesheet) and moves the
        * window when dragged. The strip it replaces did neither, which is why
        * a room could only be dragged by the conversation header underneath
        * it.
        */}
      <header className={`${styles.bar} hd-drag`}>
        <IconTile tint="violet" size="sm">
          <TeamIcon />
        </IconTile>
        <span className={styles.barName}>{team?.name ?? 'Room'}</span>
        {/* The room in one line, and every number in it is a live count of
            something on this screen. `working` is first because it is the only
            one that changes minute to minute — and the only one a person keeps
            a room open in order to watch.

            The two roster numbers are drawn only once the host has given a
            roster. `0 here` from a request that failed is the same sentence as
            `0 here` from an empty room, and only one of them is true. The
            board's count survives, because it comes from the board. */}
        <span className={styles.barFacts}>
          {peers !== null && (
            <>
              {working > 0 && (
                <>
                  <span className={styles.pulse} aria-hidden />
                  <span className="text-(--hd-foreground)">{working} working</span>
                  {' · '}
                </>
              )}
              {/* Two numbers when they differ, because they are two facts: how
                  many agents are in this room, and how many of their
                  conversations the desk currently has open. After a relaunch
                  the second is zero and the first is not, and a bar that
                  printed only one of them would either read as an empty room
                  or hide that nothing is warm yet. */}
              {hereCount === roster.length
                ? `${roster.length} here`
                : `${hereCount} of ${roster.length} here`}
              {' · '}
            </>
          )}
          {intents.filter((one: Intent) => one.state === 'claimed').length} claimed
        </span>
        {/* Everything to the left of this states a fact; everything to the
            right does something. The conversation's header draws the same
            rule for the same reason. */}
        <span className={styles.barRule} />
        {/* A real box, not `display: contents`: app-region is a property of a
            box, and a boxless wrapper leaves its buttons inside the drag
            region, where a click moves the window instead of pressing them. */}
        <div className={`${styles.barVerbs} hd-no-drag`}>
          {/* Board-only used to live in the chat's header, one surface down.
              It governs *messages* — every one of them, from every member, in
              this room — so it belongs on the room's own row rather than on
              one of the three things the room can be showing. Warning ink when
              it is off, because a board where agents cannot talk is a state
              worth noticing rather than a setting to find out about later. */}
          <Button
            variant="ghost"
            size="sm"
            className={messaging ? 'text-(--hd-muted-foreground)' : 'text-(--hd-warning-ink)'}
            title={
              messaging
                ? 'Agents may message each other. Turn on board-only to stop messages; claims and signals continue.'
                : 'Board-only: agents may claim and signal, but not message. Press to let them talk again.'
            }
            onClick={() =>
              void store
                .teamMessaging(room, !messaging)
                .then(() => setBarTrouble(null))
                .catch(() =>
                  setBarTrouble('The host did not take the change; the switch is as it was.'),
                )
            }
          >
            {messaging ? 'messaging on' : 'board-only'}
          </Button>
          {/* The panel's verbs — fill the window, close, move — at the end of
              the room's own row, which is the bargain `ownsChrome` names: a
              view that draws a header with somewhere to put them gets no
              strip above it. Nothing outside the panel system (the preview
              page, the design explorer) has a mount, and there this draws
              nothing at all. */}
          <PanelActions />
        </div>
      </header>
      {/* The one failure this row can have, said out loud and across the whole
          room: the chat's own trouble line is inside the chat, and a toggle
          that failed while the board was up had nowhere to say so. */}
      {barTrouble && (
        <p className={styles.barTrouble} role="alert">
          {barTrouble}
        </p>
      )}

      <div className={styles.split}>
        <aside className={styles.rail}>
          {/* The work before the chatter: a reader arriving at a group project
              wants the state of the board before they want the conversation.

              One rail drives all three — board, room, agent — because a rail
              whose rows do different *kinds* of thing is not a rail. Pressing
              Board used to open a pane beside this one, which at a split turned
              the room into a strip of names with nowhere to read them; a row in
              a list of destinations must show its destination here. The board
              still has a pane of its own for when it is the work, from the Team
              panel and the command palette. */}
          <div className={styles.railPinned}>
            <ListRow
              size="sm"
              nav
              interactive
              selected={open === 'board'}
              onClick={() => show('board')}
              lead={
                <IconTile size="sm" tint="violet">
                  <PlanIcon />
                </IconTile>
              }
              title="Board"
              subtitle={`${intents.filter((one: Intent) => one.state === 'open').length} unclaimed`}
              trail={<span className={styles.count}>{intents.length}</span>}
            />
            <ListRow
              size="sm"
              nav
              interactive
              selected={open === 'room'}
              onClick={() => show('room')}
              lead={
                <IconTile size="sm" tint="violet">
                  <TeamIcon />
                </IconTile>
              }
              title="Chat"
              subtitle="Everyone in this room"
              /* Not how many things were said — that number answers no question
                 anybody has. What a rail owes the reader is the traffic that is
                 *stuck*: a message the board held is going nowhere until somebody
                 releases it, and it is invisible from anywhere but inside the
                 chat. When nothing is held the slot is empty, because a zero
                 here would be a permanent reminder of a state that is fine. */
              trail={
                held > 0 ? (
                  <span className={styles.heldCount}>{held} held</span>
                ) : undefined
              }
            />
          </div>

          {/* The roster's heading does three jobs: names the section, counts
              it, and carries the one verb a roster is for. Adding a member used
              to mean leaving the room, starting a session somewhere else,
              sending it something, and coming back to see whether it had
              appeared. */}
          <div className={styles.railLabel}>
            <span>Agents</span>
            <span className={styles.count}>{roster.length}</span>
            <button
              type="button"
              className={styles.railAdd}
              aria-label="Add an agent to the room"
              title="Add an agent to the room"
              onClick={() => setAdding(true)}
            >
              <PlusIcon size={13} />
            </button>
          </div>

          {/* A filter, once the roster is longer than the eye scans in one go.
              Four is where a rail of names stops being a picture and starts
              being a list — and below it the box would be a control that costs
              a row to save nothing. */}
          {roster.length > 4 && (
            <div className={styles.railFilter}>
              <SearchIcon />
              <Input
                value={filter}
                placeholder="Filter agents"
                aria-label="Filter agents"
                className="h-7 border-0 bg-transparent px-0 text-sm dark:bg-transparent"
                onChange={(event) => setFilter(event.target.value)}
              />
              {filter !== '' && (
                <button
                  type="button"
                  aria-label="Clear the filter"
                  className={styles.railFilterClear}
                  onClick={() => setFilter('')}
                >
                  <CrossIcon size={12} />
                </button>
              )}
            </div>
          )}

          <ListRows size="sm" className={styles.railList}>
            {peers !== null && roster.length === 0 && (
              /* A zero says what it looked for *and* what it found — and it is
                 only said once the host has actually answered. Drawn from a
                 `null` roster it was not a zero at all, it was silence wearing a
                 sentence: "no conversations in this project yet", in a room that
                 had four of them a moment before the request failed. It used to
                 say only what it wanted — "open one in this workspace and it
                 joins" — to a person who had two conversations open in that
                 workspace and was reading a roster that said none. The rule it
                 applies is real and was applied invisibly, which is
                 indistinguishable from a bug.

                 What the rule *is* has changed: it used to be "a conversation
                 joins when it is attached to its agent", which was true while a
                 folder was a board. Nothing joins by itself now — the + above is
                 the way in — and telling somebody to wait for something that
                 will never happen is worse than saying nothing. */
              <p className={styles.railEmpty}>
                {/* "In this room", not "here": the two used to be one word
                    because a member only appeared while its conversation was
                    open, so an empty roster and an empty room were the same
                    sight. They are different facts now — a room keeps its
                    members across a quit — and this line is only ever the
                    second one. */}
                {here === 0
                  ? 'No agents in this room yet, and no conversations in this project either. + starts one and puts it in.'
                  : here === 1
                    ? 'No agents in this room yet. One conversation is open in this project — + adds an agent.'
                    : `No agents in this room yet. ${here} conversations are open in this project — + adds an agent.`}
              </p>
            )}
            {roster.length > 0 && shown.length === 0 && (
              <p className={styles.railEmpty}>No agent here matches “{filter.trim()}”.</p>
            )}
            {railTrouble && (
              <p className={styles.railEmpty} role="alert">
                {railTrouble}
              </p>
            )}
            {shown.map((member) => (
              <MemberRow
                key={member.key}
                member={member}
                onRemove={() => leave(member.key)}
                onInbound={(mode) => setInbound(member.key, mode)}
                selected={columns.includes(member.key)}
                /* Said before the press, not after. A pick that will take a
                   column away has to say which one while there is still time not
                   to press it. */
                replaces={
                  columns.length > 0 && !columns.includes(member.key)
                    ? (memberOf(wouldReplace(member.key) as SessionKey)?.nickname ?? null)
                    : null
                }
                cap={cap}
                watching={columns.length > 0}
                onOpen={() => show(member.key)}
                onWatch={() => watch(member.key)}
              />
            ))}
          </ListRows>
        </aside>

        <div className={styles.body}>
          {/* Only drawn by the narrow-room container query. The label names what
              it goes back to, because "back" alone in a pane with no history is
              a direction, not a destination. */}
          <button type="button" className={styles.back} onClick={() => setOnRail(true)}>
            <ArrowLeftIcon />
            Agents
          </button>
          {open === 'board' ? (
            <TeamBoardPane room={room} />
          ) : columns.length > 0 ? (
            /* Members, side by side. Each column is the agent's *own*
               conversation — scoped by a provider rather than reimplemented, so
               it is the same transcript, composer and approvals the app renders
               anywhere else. This is the one place two transcripts share a
               screen, and it is a view rather than a loose pane: capped, headed
               by whose it is, and reachable from nowhere but here. */
            <div className={styles.columns} ref={watching} data-columns={columns.length}>
              {columns.map((key) => {
                const member = memberOf(key)
                const entry = roster.find((one) => one.key === key) ?? null
                return (
                  <section key={key} className={styles.column}>
                    {/* Whose column this is — drawn when the rail is not already
                        saying it. One member watched, with the roster beside it,
                        is the case where this row is pure repetition: the rail
                        highlights the row it opened, the conversation's own
                        header carries the title and the status, and the composer
                        underneath names the agent and the model. Three of those
                        four facts printed twice cost a 44px band across the top
                        of the transcript. The stylesheet takes it away at one
                        column and hands it straight back when the room is narrow
                        enough to have dropped the rail. */}
                    <header className={styles.columnHead}>
                      {/* Whose transcript this is, in the mark the reader already
                          knows from the sign-in screen and the model picker — and
                          wearing the same light as its row in the rail, so a
                          column and its row are visibly the same member. */}
                      <MemberCard
                        entry={entry}
                        side="bottom"
                        /* The column is already up, so there is no Open to
                           offer; closing is the one verb this head has, and
                           only while there is another column to be left with. */
                        {...(columns.length > 1 ? { onClose: () => stopWatching(key) } : {})}
                      >
                        <span className={styles.columnMark}>
                          <IconTile size="sm" tint={entry?.tint ?? 'blue'}>
                            {entry?.brand ? <BrandMark brand={entry.brand} size={13} /> : <AgentIcon />}
                          </IconTile>
                          {entry?.busy && <span className={styles.dotOn} aria-hidden />}
                        </span>
                      </MemberCard>
                      <span className={styles.columnName}>{member?.nickname ?? 'Member'}</span>
                      {/* What it runs, beside what it is called — two Cursor
                          conversations on two models are told apart here or
                          nowhere.

                          The harness is dropped when it *is* the name: a room
                          names its members after the model, and the default for
                          the first Codex conversation on a board is "Codex", so
                          the head read "Codex — Codex · gpt-5.6". A word printed
                          twice in four is not context, it is noise. */}
                      <span className={styles.columnSub}>
                        {[member?.agent === member?.nickname ? null : member?.agent, member?.model]
                          .filter(Boolean)
                          .join(' · ')}
                      </span>
                      {columns.length > 1 && (
                        <button
                          type="button"
                          className={styles.columnClose}
                          aria-label={`Stop watching ${member?.nickname ?? 'this member'}`}
                          title={`Stop watching ${member?.nickname ?? 'this member'}`}
                          onClick={() => stopWatching(key)}
                        >
                          <CrossIcon size={12} />
                        </button>
                      )}
                    </header>
                    <div className={styles.columnBody}>
                      <PaneProvider
                        scope={{
                          paneId: `${mount?.id ?? 'team-room'}:${key}`,
                          view: { kind: 'conversation', session: key },
                          sessionKey: key,
                        }}
                      >
                        <Conversation
                          onChooseProject={onChooseProject}
                          onSignIn={onSignIn}
                          onOpenUsage={onOpenUsage}
                          onOpenAgents={onOpenAgents}
                        />
                        {/* An approval is a stop: the turn does not continue
                            until it is answered. Every column mounts its own, or
                            an agent asking for a command blocks with nowhere in
                            this surface to say yes. */}
                        <Approvals />
                      </PaneProvider>
                    </div>
                  </section>
                )
              })}
            </div>
          ) : (
            <Room room={room} members={roster} loaded={peers !== null} onShow={show} />
          )}
        </div>
      </div>
    </div>
  )
}

/** One member of the room, as the rail draws it. */
type Member = {
  peer: TeamPeerInfo
  key: SessionKey
  brand: ReturnType<typeof brandForRuntime> | null
  /** The account's ring, shared with the column head and the name card. */
  tint: Tint
  busy: boolean
  /**
   * Whether the desk has this member's conversation open right now.
   *
   * Not the same question as membership, and the rail draws both: a member
   * that is not open is still in the room, still holds its name and its job,
   * and is still reached — the message opens it. Everything on this row that
   * is a fact about a *live turn* has to be gated on it.
   */
  here: boolean
  canUseBoard: boolean
  /** Reachable, and yet nothing taken — the runtime's claim against evidence. */
  idleOnBoard: boolean
  onTask: Intent | null
  title: string | null
}

/**
 * A rail member, as the card reads it.
 *
 * One function rather than two identical object literals. The rail's row and
 * the chat's author both build these from the same `Member`, and review
 * pointed out the obvious: a field added to `MemberCardFacts` would have to
 * be remembered in two places, and the day it is not, the two surfaces
 * disagree about the same agent.
 */
const cardFacts = (entry: Member): MemberCardFacts => ({
  peer: entry.peer,
  key: entry.key,
  busy: entry.busy,
  here: entry.here,
  canUseBoard: entry.canUseBoard,
  idleOnBoard: entry.idleOnBoard,
  task: entry.onTask ? { id: entry.onTask.id, title: entry.onTask.title } : null,
  /* Only when it is a name of its own. A card whose second name repeats its
     first has spent a slot saying nothing. */
  title: entry.title && entry.title !== entry.peer.nickname ? entry.title : null,
})

/**
 * A member's name card, hung off whatever mark the caller draws.
 *
 * The rail row and the column head are two drawings of one member, so they
 * share this rather than each building a subject of their own — which is how
 * two surfaces come to disagree about whether an agent can take a job.
 *
 * The verbs are the room's, and only the ones that would work: `Open` and
 * `Watch` on the rail, `Close` on a head that is one of several. Messaging a
 * single member is a verb the room has, but it lives on the chat composer's
 * recipient rather than here, and a button that could not reach it would be
 * exactly the greyed verb the card refuses to draw.
 */
/**
 * The three things a member can do with a message addressed to it.
 *
 * A setting, not three verbs — which is a distinction the card had to learn.
 * They went in as actions first, and the row of verbs does not wrap: with Open,
 * Watch beside and Take out of the room already there, five of the seven were
 * off the card's edge and one was cut mid-word. Photographed on the real app,
 * which is how it was found. A thing with three states shows which state it is
 * in, so it is a segmented band beside the other instruments now.
 *
 * `label` is one word each, because the band above them says what they are
 * about. `state` is what the *row* says when the member is in that mode, and
 * `accept` has none: it is the default, and a row that announced the ordinary
 * case would announce it on every member of every room forever.
 */
const INBOUND_MODES: readonly {
  readonly value: TeamInbound
  readonly label: string
  readonly state: string | null
}[] = [
  { value: 'accept', label: 'Accept', state: null },
  { value: 'hold', label: 'Hold', state: 'messages held' },
  { value: 'refuse', label: 'Refuse', state: 'messages refused' },
]

const MemberCard = ({
  entry,
  onOpen,
  onWatch,
  onClose,
  onRemove,
  onInbound,
  children,
  side,
}: {
  readonly entry: Member | null
  readonly onOpen?: () => void
  readonly onWatch?: () => void
  readonly onClose?: () => void
  /**
   * Take the member out of the room.
   *
   * The only way out, and it had to become one: membership used to end by
   * itself whenever a conversation stopped being open, which is exactly the
   * behaviour that emptied every room after a relaunch. Rooms keep their
   * members now, so leaving has to be something a person does — `team/room/leave`
   * existed on the wire the whole time with nothing to press.
   *
   * On the card rather than the row, with Open and Watch: a destructive verb
   * one pixel from the thing it destroys is how a roster gets emptied by
   * accident.
   */
  readonly onRemove?: () => void
  /**
   * Set what this member does with messages addressed to it.
   *
   * On the card for the same reason Open and Watch are: a per-member verb
   * belongs where the member is identified, not on a rail row that has one
   * click and spends it on opening the conversation.
   */
  readonly onInbound?: (mode: TeamInbound) => void
  readonly children: ReactNode
  readonly side?: 'top' | 'right' | 'bottom' | 'left'
}) => {
  if (!entry) return <>{children}</>
  const actions = [
    ...(onOpen ? [{ label: 'Open', onSelect: onOpen, primary: true }] : []),
    ...(onWatch ? [{ label: 'Watch beside', onSelect: onWatch }] : []),
    ...(onClose ? [{ label: 'Close column', onSelect: onClose }] : []),
    /* Last, and last for a reason: the two above put something on screen and
       this one takes an agent out of the work. The conversation itself is
       untouched — it goes back to the project's own list — which is what the
       label has to say, because "Remove" beside a conversation reads like a
       delete. */
    ...(onRemove ? [{ label: 'Take out of the room', onSelect: onRemove }] : []),
  ]
  return (
    <MemberHoverCard
      member={cardFacts(entry)}
      actions={actions}
      {...(onInbound
        ? {
            choice: {
              /* "Messages", not "Inbound": the band names what it governs in
                 the words the room already uses — the switch on the room's own
                 header says "messaging on". */
              label: 'Messages',
              value: entry.peer.inbound,
              options: INBOUND_MODES.map((mode) => ({ value: mode.value, label: mode.label })),
              onChange: (next: string) => onInbound(next as TeamInbound),
            },
          }
        : {})}
      {...(side ? { side } : {})}
    >
      {children}
    </MemberHoverCard>
  )
}

/**
 * A member, as a row.
 *
 * A `ListRow`, because that is what a roster down the side of a screen is made
 * of and a third row idiom is not a thing this app has. What changed is what
 * goes in the slots. The old row spent its one subtitle on three unrelated
 * facts joined by a middle dot — what the conversation calls itself, what it
 * is holding, whether it is mid-turn — and then truncated at the rail's 232px,
 * so the fact that survived was whichever happened to be shortest.
 *
 * Now each fact takes the form it deserves, and they stop competing:
 *
 *   Working    is a light on the tile, not a word in a sentence. It changes
 *              many times a minute and the eye must find it without reading.
 *   The name   the conversation gave itself moves up beside the nickname,
 *              where it is an adjective on *who this is* rather than a
 *              competitor to what they are doing.
 *   The job    gets the whole second line, so `#3` — the thing a person types
 *              back to an agent — is no longer the half that truncates.
 *
 * The second line stays earned. A member with no job and no name of its own
 * gets no second line at all: the agent it runs is already on the row as its
 * mark, and spelling "Claude Code" underneath a row whose icon is the Claude
 * mark is the exact restatement `docs/design.md` forbids.
 */
const MemberRow = ({
  member,
  selected,
  replaces,
  cap,
  watching,
  onOpen,
  onWatch,
  onRemove,
  onInbound,
}: {
  member: Member
  selected: boolean
  /** Whose column this pick would take, when the pane is already full. */
  replaces: string | null
  cap: number
  watching: boolean
  onOpen: () => void
  onWatch: () => void
  /** Take this member out of the room. On the card, never on the row. */
  onRemove: () => void
  /** Set what it does with messages sent to it. On the card, like the rest. */
  onInbound: (mode: TeamInbound) => void
}) => {
  const { peer } = member
  const inboundState = INBOUND_MODES.find((mode) => mode.value === peer.inbound)?.state ?? null
  return (
    <ListRow
      size="sm"
      nav
      interactive
      selected={selected}
      onClick={onOpen}
      className="group/member"
      lead={
        /* The mark is the trigger, never the row: bound to the row, a card
           would fire on every keyboard step down the rail and would fight the
           row's own click. The mark already means "identity", which is what
           the card is about. */
        <MemberCard
          entry={member}
          onOpen={onOpen}
          onWatch={onWatch}
          onRemove={onRemove}
          onInbound={onInbound}
        >
          {/* A member the desk does not have open is drawn quieter — the mark
              loses its full weight, the way an unread row differs from a read
              one. Quieter, never absent: it is a member of this room, it holds
              its name and its job, and a message reaches it. Said in words on
              the second line, and to a screen reader below; the dimming is the
              glance. */}
          <span className={styles.memberMark} {...(member.here ? {} : { 'data-away': '' })}>
            <IconTile size="sm" tint={member.tint}>
              {member.brand ? <BrandMark brand={member.brand} size={13} /> : <AgentIcon />}
            </IconTile>
            {/* Working is a light, not a word. Announced to a screen reader on
                the name below, where it is a sentence rather than a colour. */}
            {member.busy && <span className={styles.dotOn} aria-hidden />}
          </span>
        </MemberCard>
      }
      /* One run of text, not a flex row of two. The row's own `truncate` then
         cuts from the right — which is the behaviour wanted, because the
         nickname is at the left and is what an agent is addressed by — and the
         space between the two names is a real character, so what a screen
         reader reads is what the eye sees. A flex layout would have swallowed
         it. */
      title={
        <>
          {/* The *nickname*: the one name guaranteed to exist and to be unique
              here — three Cursor conversations on three models arrive untitled
              and identical, and used to draw three rows all reading "Cursor". */}
          {peer.nickname}
          {/* What the conversation calls itself, when it has a name of its
              own. Beside the nickname rather than under it: a member holding a
              job has not stopped being the conversation somebody named, and
              the line below is spoken for. */}
          {member.title && <span className={styles.memberAlso}> {member.title}</span>}
          {member.busy && <span className="sr-only"> — working</span>}
          {!member.here && <span className="sr-only"> — not open</span>}
        </>
      }
      subtitle={
        !member.canUseBoard ? (
          /* Outranks everything else on the row: what a member is called and
             what it holds do not matter if it cannot take a job at all.
             HarnessDesk's tools reach an agent through a server the agent has
             to accept, and one that refused it can claim nothing — which used
             to be discoverable only by an agent trying and being refused. */
          <span className={styles.memberWarn}>
            <ShieldOffIcon size={11} />
            cannot take jobs — tools not reachable
          </span>
        ) : inboundState ? (
          /* Second, above every other second line, because it is the one that
             changes what happens when you write to this member — and because
             it is the only one somebody chose. A held or refused member that
             also holds a job would otherwise show the job and hide the reason
             the messages are going nowhere, which is the state this control
             exists to make visible. `accept` says nothing at all: it is the
             default on every member of every room. */
          <span className={styles.memberInbound}>{inboundState}</span>
        ) : member.idleOnBoard ? (
          /* The lesser of the two cautions, and the reason both exist: the line
             above is what the harness says about itself, this is what the board
             has seen. A member can read as able, take nothing, and until now
             nothing on screen said so. No glyph — it is a doubt, not a refusal,
             and it must not shout as loudly as one. */
          <span className={styles.memberIdle}>has not used the board</span>
        ) : member.onTask ? (
          <>
            <span className={styles.memberTaskId}>#{member.onTask.id}</span>{' '}
            {member.onTask.title}
          </>
        ) : !member.here ? (
          /* Last of the four, because the three above are all *more* specific
             and a row shows one. It is here at all because a dimmed mark on
             its own is a hint, and this row's whole job after a relaunch is to
             say that the room is intact and nothing is warm yet — including
             what will happen if you write to it. */
          <span className={styles.memberIdle}>not open — a message opens it</span>
        ) : undefined
      }
      trail={
        /* Watching beside, on every row and at all times.
           This used to appear only once a member was already up, on the theory
           that with nothing on screen there is nothing to sit beside. That is
           true of the *second* column and false of the first: a person who
           wanted two members up had to open one the ordinary way and then
           discover a control that had not existed a moment earlier. It is one
           verb — "put this one up too" — and a verb that appears and
           disappears is a verb nobody learns. */
        <button
          type="button"
          className="flex rounded-(--hd-radius-sm) p-1 text-(--hd-muted-foreground) opacity-0 group-hover/member:opacity-100 hover:bg-(--hd-active) hover:text-(--hd-foreground) focus-visible:opacity-100 [@media(hover:none)]:opacity-100"
          aria-label={
            replaces
              ? `Watch ${peer.nickname} in place of ${replaces}`
              : `Watch ${peer.nickname} beside the others`
          }
          title={
            replaces
              ? /* Said before the press, not after. A pick that will take a
                   column away has to say which one while there is still time
                   not to press it. */
                `Watch ${peer.nickname} in place of ${replaces} — ${cap} fit at this width`
              : watching
                ? `Watch ${peer.nickname} beside the others`
                : `Watch ${peer.nickname} — opens beside anything you add next`
          }
          onClick={(event) => {
            /* The row's own press is on an ancestor, so stopping the bubble
               here is the difference between "put it beside" and "put it
               beside, then replace everything with it". */
            event.stopPropagation()
            onWatch()
          }}
        >
          <PlusIcon size={13} />
        </button>
      }
    />
  )
}

/**
 * The room itself: everyone's channel, and the way into it.
 *
 * The roster is handed down rather than fetched again — one question to the
 * host per room, and the rail and the recipient menu can never disagree about
 * who is here.
 */
const Room = ({
  room,
  members,
  loaded,
  onShow,
}: {
  readonly room: string
  /**
   * The rail's own resolved members, so a card opened from the chat is the
   * card the rail would draw, and the composer offers exactly who the rail
   * lists. The raw `peers` carry names and a `busy` that goes stale the moment
   * a turn starts; whether a member can take a job, and what it is holding, is
   * resolved once in the pane and shared from there.
   */
  readonly members: readonly Member[]
  /**
   * Whether the host has answered about the roster at all. An empty list from
   * a request still in flight is not the same fact as an empty room, and the
   * composer says different things about the two.
   */
  readonly loaded: boolean
  /** Put a member's own conversation up — the chat card's Open. */
  readonly onShow: (key: SessionKey) => void
}) => {
  const store = useStore()
  const snapshot = useSnapshot()
  const [trouble, setTrouble] = useState<string | null>(null)
  /* The composer's own handle. The room has one surface that addresses a
     member from outside the box — a name card on a message, offering
     Message — and this is where it lands. */
  const composer = useRef<RoomComposerHandle>(null)

  const team = snapshot.teams.get(room)
  const entries = team?.channel ?? NO_ENTRIES
  const messaging = team?.messaging ?? true
  const problem = team?.problem ?? null

  /* A chat window opens on the newest thing said, and stays there while new
     things are said — unless the reader has scrolled up, in which case they
     are reading something and must not be yanked away from it. `near` is the
     whole rule: within a couple of lines of the floor counts as being at the
     floor. */
  const stream = useRef<HTMLDivElement>(null)
  const following = useRef(true)
  /**
   * What arrived while the reader was scrolled away.
   *
   * The other half of not yanking them back. Holding position is right and
   * silent is not: an agent answering a question the reader asked two minutes
   * ago arrived under the fold with nothing to say it had. The count is the
   * only thing that makes "stay where you are" a decision rather than a
   * failure to notice.
   *
   * Counted off the *rows the channel draws*, not the entries the host stored,
   * because those are not the same number. A post to everyone is stored once
   * per recipient and drawn once, so a single sentence to three agents used to
   * read as "3 new messages" above one new row. And a signal — a claim, a
   * completion — is an entry too, so the pill called a claim a message.
   */
  const rows = useMemo(() => readChannel(entries), [entries])
  const [behind, setBehind] = useState<{ rows: number; onlyMessages: boolean }>(AT_THE_FLOOR)
  const counted = useRef(rows.length)
  useEffect(() => {
    const box = stream.current
    if (!box) return
    if (following.current) {
      box.scrollTop = box.scrollHeight
      /* Guarded rather than written unconditionally. A `setState` with a fresh
         object literal is a state *change* whatever the object says, so this
         line re-rendered on every run — and any dependency that churns then
         becomes an infinite loop rather than a wasted render. It was one:
         `entries` was a new `[]` per render before `NO_ENTRIES`. */
      setBehind((was) => (was.rows === 0 && was.onlyMessages ? was : AT_THE_FLOOR))
    } else {
      /* A row can absorb a later one — a refusal is folded into the delivery
         that followed it — so the derived list can get *shorter* as entries
         arrive. Resync rather than counting a negative. */
      const fresh = rows.length < counted.current ? [] : rows.slice(counted.current)
      if (fresh.length > 0) {
        setBehind((was) => ({
          rows: was.rows + fresh.length,
          onlyMessages: was.onlyMessages && fresh.every((row) => row.kind === 'message'),
        }))
      }
    }
    counted.current = rows.length
  }, [rows])

  const toFloor = (): void => {
    const box = stream.current
    if (!box) return
    following.current = true
    box.scrollTop = box.scrollHeight
    setBehind((was) => (was.rows === 0 && was.onlyMessages ? was : AT_THE_FLOOR))
  }

  /**
   * Who spoke, off the author's name — Slack's move, with our facts.
   *
   * Built here rather than in `Channel` because this is where the two things
   * a chat card needs both exist: the rail's resolved members, and a way to
   * address one of them. That second one is why the chat card can offer
   * **Message** where the rail card cannot — and a verb that could not reach
   * it would be the greyed verb the card refuses to draw.
   *
   * It reached the recipient through `setTo` when it was written, because the
   * recipient was this component's state. It is the composer's now — the
   * audience belongs with the words — so the verb goes through the composer's
   * own handle, which is the same act as picking the member from `@`. Two
   * halves of one feature, built a branch apart: the card had no landing place
   * and the handle had no caller.
   *
   * A speaker who has since left the room matches nothing and gets no card.
   * The row still reads; there is simply nothing current to say about it.
   */
  const identify = useCallback(
    (actor: TeamActor, node: ReactNode): ReactNode => {
      if (actor.kind !== 'agent') return node
      const entry = members.find(
        (one) => one.peer.runtime === actor.runtime && one.peer.sessionId === actor.sessionId,
      )
      if (!entry) return node
      return (
        <MemberHoverCard
          member={cardFacts(entry)}
          actions={[
            { label: 'Open', onSelect: () => onShow(entry.key), primary: true },
            /* `entry.key` rather than a string joined here: the audience is
               keyed by `SessionKey`, and the two spellings this used to have —
               space-joined in the composer, NUL-joined everywhere else — were
               a disagreement waiting to be found by a member whose id has a
               space in it. */
            { label: 'Message', onSelect: () => composer.current?.address(entry.key) },
          ]}
        >
          {node}
        </MemberHoverCard>
      )
    },
    [members, onShow],
  )

  return (
    /*
     * No header.
     *
     * There was one, and it said "Chat / Everyone in this room reads this"
     * beside a rail row saying "Chat / Everyone in this room" — a title
     * repeating the row that had just been pressed to get here, in a 56px band
     * across the top of the stream. The rail names the destination; the room's
     * top row names the room and carries the one control this header had. What
     * is left is the thing a reader came for, starting at the top of its half.
     */
    <>
      <div className={styles.streamWrap}>
        <div
          ref={stream}
          data-slot="room-stream"
          className={styles.stream}
          onScroll={(event) => {
            const box = event.currentTarget
            const near = box.scrollHeight - box.scrollTop - box.clientHeight < 64
            following.current = near
            if (near) setBehind((was) => (was.rows === 0 && was.onlyMessages ? was : AT_THE_FLOOR))
          }}
        >
          {/* The reading column, which the transcript one keystroke away is
              also set in. The stream box scrolls; this is what is read in it,
              and holding the two apart is what lets the rows be centred on
              the same line as the composer below. */}
          <div className={styles.streamColumn}>
            {entries.length === 0 ? (
              <EmptyState
                icon={<TeamIcon />}
                title="Nothing said yet"
                description={
                  messaging
                    ? 'The agents in this room can message each other and you. Signals — a claim, a completion — land here too.'
                    : /* Where the switch actually is. It named the Team panel,
                         which stopped existing when this room absorbed it, and
                         then the room's own chat header, which the top row has
                         now absorbed in turn — so a reader following the
                         sentence arrived at a surface that was not there. */
                      'Board-only: agents may claim and signal, but not message. Turn messaging back on at the top of the room.'
                }
              />
            ) : (
              <ChannelStream
                entries={entries}
                room={room}
                onTrouble={setTrouble}
                density="room"
                /* The same member card the rail draws, off the same roster —
                   so the chat and the rail can never disagree about whether an
                   agent can take a job. A speaker who has since left the room
                   finds no entry and gets no card, which is honest: the row
                   still reads, and there is nothing current to say. */
                identify={identify}
              />
            )}
          </div>
        </div>
        {behind.rows > 0 && (
          /* "messages" only when that is all they are. A batch with a claim or
             a completion in it takes the plainer word, because a signal is not
             a message and a pill that says it is teaches the reader to distrust
             the count. */
          <button type="button" className={styles.behind} onClick={toFloor}>
            {behind.onlyMessages
              ? behind.rows === 1
                ? '1 new message'
                : `${behind.rows} new messages`
              : behind.rows === 1
                ? '1 new update'
                : `${behind.rows} new updates`}
          </button>
        )}
      </div>

      {/* Two different failures, both said out loud. `problem` is the host's:
          it could not keep the board, so what is on screen may not survive a
          restart — the person needs to know before they act on it. `trouble`
          is this surface's: the last thing you pressed did not land. */}
      {problem && (
        <p className={styles.trouble} role="alert">
          {problem}
        </p>
      )}
      {trouble && (
        <p className={styles.trouble} role="alert">
          {trouble}
        </p>
      )}

      {/* The conversation's composer, not a lookalike: the same shell, the
          same 14px text well, the same ghost anchor on the left and the same
          round accent coin on the right — down to the weight that coin takes
          when the host will hold the message until a turn ends. It sits one
          click from the individual composer inside this very pane, and two
          boxes that nearly match read worse than two that plainly differ.
          What is different is what is genuinely different: the audience,
          which lives with the words because choosing it is part of writing
          the message. */}
      <div className={styles.composer}>
        {/* The reading column, the same one the stream above hangs in. The
            wrapper rather than a prop: `RoomComposer` draws the shell and
            knows nothing about how wide the pane it sits in is, which is the
            caller's business — exactly as `.streamColumn` is. */}
        <div className={styles.composerShell}>
          <RoomComposer
            /* Keyed by the room, so moving between rooms is a new box rather
               than the old one being talked out of its state. The audience
               prunes itself against the new roster either way, but the *words*
               would have come along — a half-written line to one room appearing
               in another, one keystroke from being sent there. */
            key={room}
            ref={composer}
            room={room}
            members={loaded ? members : null}
            messaging={messaging}
            /* The same card the rail and the chat draw, off the same one reader.
               `Open` is the only verb worth offering on a chip: the member is
               already addressed, so Message would be the greyed verb the card
               refuses to draw, and removing them is the ✕ they already carry. */
            card={(key, node) => {
              const entry = members.find((one) => one.key === key)
              if (!entry) return node
              return (
                <MemberHoverCard
                  member={cardFacts(entry)}
                  actions={[{ label: 'Open', onSelect: () => onShow(entry.key), primary: true }]}
                >
                  {node}
                </MemberHoverCard>
              )
            }}
            onTrouble={setTrouble}
            onPosted={toFloor}
          />
        </div>
      </div>
    </>
  )
}
