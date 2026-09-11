import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type FocusEvent as ReactFocusEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react'

import {
  currentTurn,
  isBusy,
  sessionKey,
  type Account,
  type RuntimeId,
  type RuntimeInfo,
  type Session,
  type SessionKey,
  type SessionSummary,
  type TeamPeerInfo,
} from '@harnessdesk/protocol'

import { accountIdentity, accountKey, accountName, runtimeTint } from '../lib/accounts'
import { elapsedSince } from '../lib/clock'
import { describeContext, formatTokens } from '../lib/context-usage'
import { formatElapsed } from '../lib/turn-view'
import { bindingLane, describeLane } from '../lib/usage'
import { useSnapshot, useStore } from '../state/context'
import type { AppSnapshot } from '../state/store'
import { AgentCard, type AgentCardAction, type AgentCardSubject } from '../design/patterns/AgentCard'
import {
  HOVER_CARD_OPEN_DELAY,
  HOVER_CARD_SIDE_OFFSET,
  HOVER_CARD_WIDTH_REM,
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from '../design/ui'
import { RuntimeMark } from './BrandIcons'
import { AgentIcon } from './Icons'

/**
 * The app's side of the name card: what a subject is, read off the store.
 *
 * `design/patterns/AgentCard` draws the card and knows nothing about this app.
 * This file is the other half — one reader per subject, so the question "what
 * does this app know about that agent" is answered once rather than by every
 * surface that draws a mark. A screen imports the wrapper for its subject,
 * wraps its existing mark in it, and passes the verbs it can honestly offer.
 *
 * Three rules the readers hold, and they are the reason this is one file:
 *
 *   Absent, never zeroed.   A harness that reports no context window gets no
 *                           meter — not a full bar. A card claiming a budget
 *                           it cannot see is worse than one that says nothing.
 *   The ring is the account's.  Every surface that draws this agent uses the
 *                           same tint, because that is what `lib/accounts.ts`
 *                           says the ring is *for*: telling two accounts of
 *                           one harness apart. A per-surface colour would make
 *                           the ring decoration.
 *   State carries a number. "Working" alone repeats the lamp on the mark.
 *                           "Working — 41s into this turn" is a reading.
 */

/* ── The wrapper ──────────────────────────────────────────────────────── */

/**
 * Whether something is being dragged anywhere in the window.
 *
 * The board's cards are draggable, and their assignee faces are triggers. A
 * card that opened under the pointer mid-drag would cover the column being
 * dragged into. One listener for the whole app rather than one per trigger:
 * a board with forty cards would otherwise hold eighty listeners for a fact
 * that is the same for all of them.
 */
let dragging = false
const onDragStart = (): void => {
  dragging = true
}
const onDragStop = (): void => {
  dragging = false
}

/*
 * Four ways out of a drag, and the last two are why.
 *
 * `dragend` fires on the *source* and `drop` on the target, so a drag whose
 * source is unmounted mid-gesture — a card dragged out of a column that
 * re-renders under it — ends with neither. This flag is module-level, so a
 * miss is not a stale row: it is every hover card in the window refusing to
 * open, until some later drag happens to end properly. Review found it, and
 * the fix is that a pointer release means no drag is in progress, whatever
 * the drag API did or did not say. `pointerup` covers the usual case and
 * `pointercancel` the one where the browser takes the pointer away.
 */
const DRAG_ON = ['dragstart'] as const
const DRAG_OFF = ['dragend', 'drop', 'pointerup', 'pointercancel'] as const

/**
 * Whether the last thing done in the window was a key rather than a press —
 * the question `:focus-visible` answers, asked here because a focus event
 * cannot say which of the two it followed.
 *
 * Focus opens a card for a keyboard. But a press moves focus too: a click
 * focuses the link it lands on, and a tap or a stylus focuses what it touched
 * a moment after lifting, when the pointer has already gone. That focus is
 * the press's, not a question about the agent, so it opens nothing. This
 * replaced a flag set by a touch press and cleared by the next blur, which a
 * tap that moved no focus left set — the next keyboard lost its card — and
 * which a stylus, pressing the same way, never set at all. Radix's own menus
 * ask the question like this. Module-level for the reason `dragging` is.
 */
let keyboard = true
const onKey = (): void => {
  keyboard = true
}
const onPress = (): void => {
  keyboard = false
}

const WATCHED = [
  ...DRAG_ON.map((name) => [name, onDragStart] as const),
  ...DRAG_OFF.map((name) => [name, onDragStop] as const),
  ['keydown', onKey] as const,
  ['pointerdown', onPress] as const,
]
let watchers = 0

const useWindowWatch = (): void => {
  useEffect(() => {
    watchers += 1
    if (watchers === 1) {
      for (const [name, listener] of WATCHED) window.addEventListener(name, listener, true)
    }
    return () => {
      watchers -= 1
      if (watchers === 0) {
        for (const [name, listener] of WATCHED) window.removeEventListener(name, listener, true)
        // Nothing is watching, so nothing can keep these current either.
        dragging = false
        keyboard = true
      }
    }
  }, [])
}

type CardSide = 'top' | 'right' | 'bottom' | 'left'

const beside = (side: CardSide): boolean => side === 'left' || side === 'right'

/**
 * Whether a card fits beside the trigger: on its right or, failing that, on
 * its left — the trade the positioner makes by itself.
 *
 * Against the root element's width, not the window's. The positioner keeps a
 * card inside the page, and a classic scrollbar is window but not page.
 */
const roomBeside = (trigger: HTMLElement): boolean => {
  const box = trigger.getBoundingClientRect()
  const rem = Number.parseFloat(getComputedStyle(document.documentElement).fontSize) || 16
  const reach = HOVER_CARD_WIDTH_REM * rem + HOVER_CARD_SIDE_OFFSET
  return document.documentElement.clientWidth - box.right >= reach || box.left >= reach
}

/**
 * The side a card opens on, settled as it opens.
 *
 * Beside the trigger wherever there is room beside it, and under it where
 * there is not. The positioner already trades right for left when one edge is
 * short, but it never tries a side at right angles to the one it was asked
 * for: with both edges short it picks the less bad of the two, which is still
 * off the window. A rail row is exactly that trigger when a narrow window
 * leaves a room nothing but its rail. (A narrow *pane* in a wide window never
 * gets here — its rows have room on one side, and the positioner takes it.)
 * Under is the least bad of three bad answers rather than a good one: it
 * covers the rows below the one being read, above would cover the rows above,
 * and off the window shows nothing at all.
 *
 * An open card never changes sides. The positioner answers asynchronously, and
 * moving an open card to a new side let an answer for the old side land last —
 * measured: settled below, drawn on the left. So a card beside its trigger
 * that loses the room beside it closes instead, and the next rest opens it
 * where it fits.
 */
const sideFor = (trigger: HTMLElement, wanted: CardSide): CardSide =>
  !beside(wanted) || roomBeside(trigger) ? wanted : 'bottom'

/**
 * Who an agent is, and the card that opens when the pointer rests on it.
 *
 * The trigger is the whole of how the agent is drawn: its mark *and* its
 * name, and in a rail the row the two sit on. It used to be the mark alone,
 * which is the smaller half — in a room's rail the card answered to the tile
 * and not to "Gemini" beside it, which is where a reader actually rests. So a
 * rail row is a trigger from edge to edge, and a column's head, a claim's
 * holder and a composer chip are each a mark and a name together.
 *
 * The session tree and the seat's menu keep the mark alone. Their rows are
 * for picking — a conversation to open, an account to run as — and a pointer
 * crosses them constantly on its way to the pick; a card at every rest there
 * paints over the list being scanned, which is the same reason the composer's
 * `@` list has no cards at all.
 *
 * "The mark, never the row" had two reasons, and both are dealt with here
 * rather than avoided:
 *
 *   Focus.    Radix opens a card for focus as well as for the pointer, and
 *             where the trigger is one thing to focus — a publication's link —
 *             that is how a keyboard reaches its card, so it stays, for a
 *             keyboard's focus (see `keyboard`). A row is different: it holds
 *             controls of its own (the rail's +), focus on one of them is a
 *             keyboard step down a list rather than a question about the
 *             agent, and a card at every step is a card nobody asked for. Such
 *             a trigger says so with `openOnFocus={false}`, and then focus
 *             neither opens its card nor, leaving, closes one the pointer is
 *             resting on. The caller says it, because the element cannot: a
 *             chip laid out as a block is still one thing to focus.
 *   A press.  Pressing the trigger takes its card away and keeps it away until
 *             the pointer leaves. The press opened something, and a card that
 *             stayed — or arrived a beat later, off the timer the pointer
 *             started on its way in — would float over what it had just
 *             opened.
 *
 * A control inside the trigger with a tooltip of its own is marked
 * `data-no-card`: resting there asks about the control, not the agent, so no
 * card opens while the pointer is on it, and an open one goes. The rail's + is
 * the case — its title says which column a pick will take away, and a card
 * beside that sentence would be saying something else. It sits at the row's
 * trailing edge, the edge a pointer coming from the chat crosses first, and
 * moving on from it to the name is the same visit to the trigger: Radix hears
 * no second arrival and asks nothing. So the card is asked for again as the
 * pointer moves off the control, after the delay of any rest.
 *
 * The trigger is a `span`, or a `div` where it wraps a block, and `asChild` is
 * not offered to callers. Radix's own default is an `<a>`, and these triggers
 * sit inside rows that are already buttons — an anchor inside a button is
 * invalid HTML, and browsers resolve it by breaking one of the two. A span
 * nests anywhere and lets the row keep its click.
 *
 * ---------------------------------------------------------------------------
 * The card is a *function*, not a value
 *
 * `body` is called only while the card is open, and everything expensive lives
 * on the other side of that call: the store subscription, the once-a-second
 * clock behind the turn timer, and the arithmetic that turns app state into a
 * subject. Handing this component a built subject instead — which is what it
 * did first — is a quiet O(rows) tax on the app's busiest lists, and review
 * caught it:
 *
 *   Every mark in the session tree, every face and name in the channel, and
 *   every row of a room rail mounts one of these. A sixty-session tree and a
 *   fifty-message room came to some 160 wrappers, each holding its own
 *   `setInterval(…, 1000)` and its own `useSyncExternalStore` subscription,
 *   each rebuilding a subject on every tick and every store patch — for cards
 *   that are closed essentially all of the time. In an Electron window that is
 *   enough to keep the CPU out of its low-power states all day.
 *
 * A closed trigger now costs a `useState` and a few module-level listeners
 * shared by every trigger in the window. The timer count is one while a card
 * is open and zero otherwise.
 */
export const AgentHoverCard = ({
  body,
  children,
  side,
  align,
  className,
  as: Trigger = 'span',
  openOnFocus = true,
  disabled = false,
}: {
  /**
   * The card's contents, built on demand.
   *
   * Called during render of the open card and never before, so a reader may
   * use hooks inside whatever it returns — that is the whole point of it being
   * a function rather than a node.
   */
  readonly body: () => ReactNode
  readonly children: ReactNode
  readonly side?: CardSide
  readonly align?: 'start' | 'center' | 'end'
  readonly className?: string
  /**
   * The trigger's own element: a `span`, which nests anywhere — inside a row
   * that is already a button, above all — or a `div`, for a trigger that holds
   * a block, such as a whole row of a rail.
   */
  readonly as?: 'span' | 'div'
  /**
   * Whether a keyboard's focus arriving inside the trigger opens the card, as
   * Radix does. False for a trigger that holds controls of its own, where
   * focus then neither opens the card nor closes it. See the note above.
   */
  readonly openOnFocus?: boolean
  /** The surface has nothing worth a card; the mark renders bare. */
  readonly disabled?: boolean
}) => {
  const [open, setOpen] = useState(false)
  /* Where it opens — see `sideFor`. */
  const [placed, setPlaced] = useState<CardSide>(side ?? 'right')
  /* The trigger's element, kept current by React. Read wherever the trigger
     is measured or looked for, rather than an element taken from an event:
     a trigger drawn again under an open card would leave that one detached,
     contained by nothing and never resized. */
  const triggerRef = useRef<HTMLElement | null>(null)
  /* What the card may open for — a pointer resting on the trigger, or a
     keyboard's focus inside it where `openOnFocus`. Radix asks to open for
     either and cannot say which, so these say it. */
  const resting = useRef(false)
  const focused = useRef(false)
  /* Held shut: pressed since the pointer arrived, until it leaves. */
  const pressed = useRef(false)
  /* Held shut: the pointer is on a `data-no-card` control, until it is not. */
  const quiet = useRef(false)
  /* The open asked for again as the pointer moves off such a control. */
  const again = useRef<number | undefined>(undefined)
  useWindowWatch()

  /* The one way a card opens: Radix's requests come here, and so does the
     one asked for again. */
  const ask = (): void => {
    window.clearTimeout(again.current)
    if (pressed.current || quiet.current || dragging) return
    const trigger = triggerRef.current
    if (!trigger || !(resting.current || focused.current)) return
    setPlaced(sideFor(trigger, side ?? 'right'))
    setOpen(true)
  }

  useEffect(() => () => window.clearTimeout(again.current), [])

  /* A card anchored to a row that has scrolled away is pointing at somebody
     else, so a scroll that moves the trigger closes it — and only that one.
     The room's chat follows every new message, and a listener that took any
     scroll in the window shut the card whenever an agent spoke: measured in
     the real app, resting on a member's name while the room was answering,
     the stream scrolled three times in 1.4s and the card never stayed open.
     "Moves the trigger" is read as "contains the trigger" — the document
     included, since it contains everything. That is a proxy: a sticky header
     inside a scroller would be closed by a scroll that leaves it where it is,
     and nothing here is shaped that way today. Capture-phase, because the
     scroller is an ancestor of the trigger and scroll does not bubble. */
  useEffect(() => {
    if (!open) return undefined
    const close = (event: Event): void => {
      const trigger = triggerRef.current
      const scroller = event.target
      if (!trigger || (scroller instanceof Node && scroller.contains(trigger))) setOpen(false)
    }
    window.addEventListener('scroll', close, true)
    return () => window.removeEventListener('scroll', close, true)
  }, [open])

  /* A card beside its trigger closes when the room beside it goes — the
     window dragged narrower, or the trigger widened by the details panel
     opening beside the room. Left open, it would face a side with no room,
     which is the off-window card `sideFor` exists to prevent; moved, it would
     race the positioner (see `sideFor`). */
  useEffect(() => {
    if (!open || !beside(placed)) return undefined
    const trigger = triggerRef.current
    if (!trigger) return undefined
    const check = (): void => {
      const now = triggerRef.current
      if (!now || !roomBeside(now)) setOpen(false)
    }
    const observer = new ResizeObserver(check)
    observer.observe(trigger)
    window.addEventListener('resize', check)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', check)
    }
  }, [open, placed])

  /* Disabling the card must also close it. The state outlives the Radix
     tree below, which unmounts while `disabled` holds — so a card that was
     open when a menu took the seat came straight back, unhovered, the moment
     the menu closed. The pointer is forgotten with it: a trigger unmounted
     from under the pointer sends no `pointerleave` to say it has gone. */
  useEffect(() => {
    if (!disabled) return
    setOpen(false)
    window.clearTimeout(again.current)
    resting.current = false
    focused.current = false
    pressed.current = false
    quiet.current = false
  }, [disabled])

  if (disabled) return <>{children}</>

  return (
    <HoverCard
      open={open}
      onOpenChange={(next) => {
        if (next) ask()
        else setOpen(false)
      }}
    >
      <HoverCardTrigger asChild>
        {/* The card is supplementary — every fact on it is reachable through
            the row's own action — so the trigger stays out of the tab order
            rather than adding a stop before every row in a list of sixty. */}
        <Trigger
          ref={(node: HTMLElement | null) => {
            triggerRef.current = node
          }}
          className={className}
          tabIndex={-1}
          onPointerEnter={() => {
            resting.current = true
          }}
          onPointerOver={(event: ReactPointerEvent<HTMLElement>) => {
            const control = (event.target as Element).closest('[data-no-card]')
            const onControl = control !== null && event.currentTarget.contains(control)
            if (onControl === quiet.current) return
            quiet.current = onControl
            window.clearTimeout(again.current)
            if (onControl) setOpen(false)
            else again.current = window.setTimeout(ask, HOVER_CARD_OPEN_DELAY)
          }}
          onPointerLeave={() => {
            resting.current = false
            pressed.current = false
            quiet.current = false
            window.clearTimeout(again.current)
          }}
          onPointerDown={() => {
            pressed.current = true
            window.clearTimeout(again.current)
            setOpen(false)
          }}
          onFocus={(event: ReactFocusEvent<HTMLElement>) => {
            /* Refused before Radix sees it: its handler runs after this one and
               skips an event already prevented, so a row's focus neither opens
               the card nor — on the way out — closes it. */
            if (!openOnFocus) {
              event.preventDefault()
              return
            }
            focused.current = keyboard
          }}
          onBlur={(event: ReactFocusEvent<HTMLElement>) => {
            if (!openOnFocus) {
              event.preventDefault()
              return
            }
            focused.current = false
          }}
        >
          {children}
        </Trigger>
      </HoverCardTrigger>
      {/* `body()` builds an element; Radix's portal keeps it unmounted until
          the card opens, so the hooks inside it — the store subscription and
          the clock — do not run before then, and stop when it closes. Creating
          an element is a couple of object allocations and no more. */}
      <HoverCardContent
        side={placed}
        {...(align ? { align } : {})}
        className="p-0"
        /* A verb dismisses the card that offered it. Every action here opens,
           renames or addresses something *behind* this card, and review found
           it left floating over the destination until the pointer happened to
           move away. Keyed on a real control rather than on any click, so a
           press that selects a path or a task title does not close the thing
           being read from. */
        onClick={(event) => {
          /* The card is a portal, and a React portal's events bubble through
             the React *tree* — so every press inside it also reached the row
             this card hangs off. Open was harmless (the row opens too), and
             the rest were not: Watch beside opened the member as well as
             putting it in a column, Take out of the room opened the
             conversation it had just removed, and picking an inbound mode
             navigated away from the room. Found by photographing the real app.
             The card acts on its own behalf; the row is not part of it. */
          event.stopPropagation()
          const target = event.target as HTMLElement
          /* A setting is not a verb. The band that holds one says which value
             is current, which is the whole reason to look at it, so it does
             not dismiss the card the way an action does. */
          if (target.closest('[data-slot="agent-card-choice"]')) return
          if (target.closest('button')) setOpen(false)
        }}
      >
        {body()}
      </HoverCardContent>
    </HoverCard>
  )
}

/* ── Reading the store ────────────────────────────────────────────────── */

/** The account this runtime signs in as, when it has one. */
const accountOf = (snapshot: AppSnapshot, runtime: RuntimeId): Account | null =>
  snapshot.accountsByRuntime[runtime]?.accounts[0] ?? null

/** The ring this agent wears here, and everywhere else it is drawn. */
const tintFor = (snapshot: AppSnapshot, runtime: RuntimeId) =>
  runtimeTint(runtime, snapshot.accountsByRuntime, snapshot.accountPrefs)

/** "Claude Code · shane@harnessdesk.app", or as much of it as is true. */
const identityOf = (snapshot: AppSnapshot, info: RuntimeInfo | null, fallback: string): string => {
  const name = info?.presentation.name ?? fallback
  if (!info) return name
  const account = accountOf(snapshot, info.id)
  if (account) {
    const who = accountName(account, snapshot.accountPrefs[accountKey(info.id, account)])
    return `${name} · ${who}`
  }
  /* `?.` although the type says it is always there: this reads a runtime the
     card was handed, and a card must not be the thing that throws. */
  return info.capabilities?.account ? `${name} · not signed in` : name
}

/** The version that decides what models exist — the driven CLI's, not the bridge's. */
const versionOf = (info: RuntimeInfo | null): string | null =>
  info?.drives?.version ?? info?.version ?? null

/**
 * "Working — 41s into this turn" / "Idle — last spoke 4 minutes ago".
 *
 * Null where neither half can be believed. `elapsedSince` refuses a stamp that
 * cannot be a wall-clock reading, which is why an unopened session or a
 * fixture never produces "Idle — last spoke 496541h ago".
 */
const stateOf = (
  busy: boolean,
  startedAt: number | null,
  updatedAt: number | null,
  now: number,
): string | null => {
  if (busy) {
    const span = elapsedSince(startedAt, now)
    return span === null ? 'Working' : `Working — ${formatElapsed(span)} into this turn`
  }
  const span = elapsedSince(updatedAt, now)
  return span === null ? null : `Idle — last spoke ${formatElapsed(span)} ago`
}

/** The context band, or nothing at all for a harness that does not report one. */
const meterOf = (
  snapshot: AppSnapshot,
  key: SessionKey,
  agentName: string,
): AgentCardSubject['meter'] => {
  const live = snapshot.sessions.get(key)
  const view = describeContext(live?.usage, agentName)
  const fill = view?.fill ?? null
  if (!fill) return null
  const left = Math.max(0, fill.size - fill.used)
  return {
    label: 'Context',
    left,
    of: fill.size,
    reading: `${formatTokens(left)} left of ${formatTokens(fill.size)}`,
    tone: fill.tone === 'bad' ? 'danger' : fill.tone === 'warn' ? 'warning' : 'success',
  }
}

/** "~/code-shane/HarnessDesk · main" — the ground the session stands on. */
const groundOf = (cwd: string | null | undefined, branch: string | null | undefined): string | null => {
  const home = cwd ? cwd.replace(/^\/Users\/[^/]+/, '~').replace(/^\/home\/[^/]+/, '~') : null
  return [home, branch].filter(Boolean).join(' · ') || null
}

/**
 * When the turn now running began, or null.
 *
 * Guarded rather than trusting `Session.turns` to be there. The type says it
 * always is, and the store's own sessions always have it — but a card can be
 * asked to draw over a session assembled anywhere, and a hover card that
 * throws takes down the pane it opened over. A missing turn costs a duration
 * on one line; a thrown error costs the board.
 */
const turnStartedAt = (live: Session | undefined): number | null => {
  if (!live || !Array.isArray(live.turns)) return null
  return currentTurn(live)?.startedAt ?? null
}

/** Mid-turn, read the same guarded way — `isBusy` reads `turns` too. */
const busyNow = (live: Session | undefined): boolean =>
  live !== undefined && Array.isArray(live.turns) && isBusy(live)

/**
 * Once a second, so a turn timer counts while it is being read.
 *
 * Only ever called from a card *body*, which Radix mounts when the card opens
 * and unmounts when it closes — so this is one timer while a card is on
 * screen and none otherwise. It used to sit in the wrapper, where it was one
 * timer per mark in the window; see `AgentHoverCard`.
 */
const useTick = (): number => {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [])
  return now
}

/* ── Member: a session inside a room ──────────────────────────────────── */

export type MemberCardFacts = {
  readonly peer: TeamPeerInfo
  readonly key: SessionKey
  readonly busy: boolean
  /**
   * Whether the desk has this member's conversation open right now.
   *
   * The card is largely facts about a live conversation — what it is running,
   * how far through its window it is, when its last turn started — and for a
   * member that is not open there is no live conversation to ask. So the card
   * says which it is before it says anything that depends on it.
   */
  readonly here: boolean
  /** Whether this member's harness can reach the board's tools at all. */
  readonly canUseBoard: boolean
  /** Reachable, and yet nothing taken — the claim against the evidence. */
  readonly idleOnBoard: boolean
  /** The board task it holds, when it holds one. */
  readonly task: { readonly id: string | number; readonly title: string } | null
  /** What the conversation calls itself, when that is not the nickname. */
  readonly title: string | null
}

/** The member's card, mounted only while it is open. */
const MemberCardBody = ({
  member,
  actions,
  choice,
}: {
  readonly member: MemberCardFacts
  readonly actions?: readonly AgentCardAction[]
  /** A setting with three states — the room's inbound mode. See `AgentCard`. */
  readonly choice?: AgentCardSubject['choice']
}) => {
  const snapshot = useSnapshot()
  const now = useTick()

  const subject = useMemo<AgentCardSubject>(() => {
    const info = snapshot.runtimes.find((one) => one.id === member.peer.runtime) ?? null
    const live = snapshot.sessions.get(member.key)
    const cautions: AgentCardSubject['cautions'] = [
      ...(!member.canUseBoard
        ? ([
            {
              tone: 'danger' as const,
              text: 'Cannot take jobs — the board’s tools are not reachable from this harness.',
            },
          ] as const)
        : []),
      /* Both, not the higher-ranked one. The rail can show a single warning
         and drops the loser; having room for the pair is most of why this
         card is more than a longer tooltip. */
      ...(member.canUseBoard && member.idleOnBoard
        ? ([
            {
              tone: 'quiet' as const,
              text: 'Reachable, but has taken nothing from the board this run.',
            },
          ] as const)
        : []),
      /* Not a doubt about the member — an explanation of the card. Half of
         what is drawn below is about a live conversation and there is not one
         to read: the model is what the room last saw, and the state is "not
         open" rather than an age. Quiet, because nothing is wrong — this is
         the ordinary state of every member of every room until somebody opens
         one. */
      ...(!member.here
        ? ([
            {
              tone: 'quiet' as const,
              text: 'Not open — still in the room, and a message opens it.',
            },
          ] as const)
        : []),
    ]

    return {
      kind: 'member',
      name: member.peer.nickname,
      also: member.title,
      identity: identityOf(snapshot, info, member.peer.agent),
      tint: tintFor(snapshot, member.peer.runtime),
      mark: info ? <RuntimeMark runtime={info} size={16} /> : <AgentIcon size={16} />,
      working: member.busy,
      running: {
        model: member.peer.model ?? live?.settings?.model ?? null,
        version: versionOf(info),
        /* "Idle — last spoke twenty minutes ago" is a claim about a live
           conversation, and `live` is absent for a member that is not open —
           so the honest answer is the state itself rather than an age nothing
           measured. */
        state: member.here
          ? stateOf(member.busy, turnStartedAt(live), live?.updatedAt ?? null, now)
          : 'Not open',
      },
      meter: meterOf(snapshot, member.key, info?.presentation.name ?? member.peer.agent),
      on: member.task
        ? {
            taskId: `#${member.task.id}`,
            title: member.task.title,
            where: groundOf(live?.cwd, live?.git?.branch),
          }
        : { where: groundOf(live?.cwd, live?.git?.branch) },
      cautions,
      ...(choice ? { choice } : {}),
      ...(actions ? { actions } : {}),
    }
  }, [snapshot, member, actions, choice, now])

  return <AgentCard subject={subject} />
}

export const MemberHoverCard = ({
  member,
  actions,
  choice,
  children,
  className,
  side,
  as,
  openOnFocus,
}: {
  readonly member: MemberCardFacts
  readonly actions?: readonly AgentCardAction[]
  readonly choice?: AgentCardSubject['choice']
  readonly children: ReactNode
  readonly className?: string
  readonly side?: 'top' | 'right' | 'bottom' | 'left'
  /** A `div` where the trigger wraps a whole row — see `AgentHoverCard`. */
  readonly as?: 'span' | 'div'
  /** False where the trigger holds controls of its own — see `AgentHoverCard`. */
  readonly openOnFocus?: boolean
}) => (
  <AgentHoverCard
    body={() => (
      <MemberCardBody
        member={member}
        {...(actions ? { actions } : {})}
        {...(choice ? { choice } : {})}
      />
    )}
    className={className}
    {...(side ? { side } : {})}
    {...(as ? { as } : {})}
    {...(openOnFocus !== undefined ? { openOnFocus } : {})}
  >
    {children}
  </AgentHoverCard>
)

/* ── Session: one conversation, anywhere ──────────────────────────────── */

/** The conversation's card, mounted only while it is open. */
const SessionCardBody = ({
  session,
  actions,
}: {
  readonly session: SessionSummary
  readonly actions?: readonly AgentCardAction[]
}) => {
  const snapshot = useSnapshot()
  const now = useTick()

  const subject = useMemo<AgentCardSubject>(() => {
    const info = snapshot.runtimes.find((one) => one.id === session.runtime) ?? null
    const key = sessionKey(session.runtime, session.id)
    const live = snapshot.sessions.get(key)
    const busy = busyNow(live)
    const agentName = info?.presentation.name ?? session.runtime

    return {
      kind: 'session',
      /* The title it gave itself, or its opening line, or nothing — never the
         id, which names the conversation to a machine and to nobody else. */
      name: session.title?.trim() || session.preview?.trim() || 'Untitled session',
      identity: identityOf(snapshot, info, agentName),
      tint: tintFor(snapshot, session.runtime),
      mark: info ? <RuntimeMark runtime={info} size={16} /> : <AgentIcon size={16} />,
      working: busy,
      running: {
        model: live?.settings?.model ?? null,
        version: versionOf(info),
        state: stateOf(busy, turnStartedAt(live), session.updatedAt, now),
      },
      meter: meterOf(snapshot, key, agentName),
      on: { where: groundOf(session.cwd, session.git?.branch) },
      /* An archived conversation says so once, here, rather than everywhere
         its row appears. */
      cautions: session.archived
        ? [{ tone: 'quiet', text: 'Archived. It is not in the sidebar until you restore it.' }]
        : [],
      ...(actions ? { actions } : {}),
    }
  }, [snapshot, session, actions, now])

  return <AgentCard subject={subject} />
}

export const SessionHoverCard = ({
  session,
  actions,
  children,
  className,
  side,
}: {
  /** Null where the surface knows of a conversation it has not loaded. */
  readonly session: SessionSummary | null
  readonly actions?: readonly AgentCardAction[]
  readonly children: ReactNode
  readonly className?: string
  readonly side?: 'top' | 'right' | 'bottom' | 'left'
}) => (
  /* No card at all rather than one built out of guesses: a claim held by a
     conversation this renderer has never loaded has nothing to report, and an
     invented reading is worse than none. Decided here rather than inside the
     body, because it needs no store and must be known before the card opens. */
  <AgentHoverCard
    disabled={session === null}
    body={() =>
      session ? <SessionCardBody session={session} {...(actions ? { actions } : {})} /> : null
    }
    className={className}
    {...(side ? { side } : {})}
  >
    {children}
  </AgentHoverCard>
)

/* ── Account: a harness plus a credential ─────────────────────────────── */

/** The account's card, mounted only while it is open. */
const AccountCardBody = ({
  info,
  account,
  onOpenUsage,
}: {
  readonly info: RuntimeInfo
  readonly account: Account | null
  readonly onOpenUsage?: (runtime: RuntimeId) => void
}) => {
  const snapshot = useSnapshot()
  /* From context, like every other reader here. This used to arrive as a
     `store` prop — the one asymmetry in the three cards, and review called it
     out. It existed only because `selectRuntime` is a verb rather than a
     field on the snapshot, which is not a reason for one call site to hand
     over something the others get for free. */
  const store = useStore()

  const subject = useMemo<AgentCardSubject>(() => {
    const key = account ? accountKey(info.id, account) : info.id
    const report =
      snapshot.usage.find(
        (one) => one.runtime === info.id && (account === null || one.account === null || one.account === account.label),
      ) ?? null
    /* The lane with the least left, which is the one that will actually stop
       a session — not the first one the source happened to list. */
    const lane = report ? bindingLane(report.lanes) : null
    const view = lane ? describeLane(lane, Date.now(), report?.lanes ?? []) : null

    const sessions = [...snapshot.sessions.values()].filter((one) => one.runtime === info.id)
    const working = sessions.filter((one) => busyNow(one)).length

    /* A verb that would do nothing is absent, not greyed: the agent that
       already is the default gets no "run new sessions as this", which
       `selectRuntime` would return from without a word. The seat's own row
       and the menu's tick already say it is the default. */
    const actions: AgentCardAction[] = [
      ...(info.id === snapshot.activeRuntime
        ? []
        : [
            {
              label: 'Run new sessions as this',
              onSelect: () => void store.selectRuntime(info.id),
              primary: true,
            },
          ]),
      ...(onOpenUsage ? [{ label: 'Usage', onSelect: () => onOpenUsage(info.id) }] : []),
    ]

    return {
      kind: 'account',
      name: account ? accountName(account, snapshot.accountPrefs[key], info.presentation.name) : info.presentation.name,
      identity: account
        ? `${info.presentation.name} · ${accountIdentity(account)}`
        : `${info.presentation.name} · not signed in`,
      tint: tintFor(snapshot, info.id),
      mark: <RuntimeMark runtime={info} size={16} />,
      /* No `Running` band, and the version goes with it. Review found this
         passing `running: { version }` and never drawing it: the band asks for
         a model or a state and an account has neither, so the object was dead.
         Surfacing it instead would have been the wrong repair — a band headed
         "Running" holding nothing but `0.153.0` is the divider-for-one-fact
         that `AgentCard`'s own test forbids, and an account is not running
         anything. Settings › Agents is where a version is the subject. */
      /* The same band as a session's context, a different budget: both answer
         "how much of this can I still spend". `remainingPercent` is null when
         the source gave a figure that cannot be read as one, and the band
         then does not draw rather than showing a full bar. */
      meter:
        view && view.remainingPercent !== null
          ? {
              label: 'Plan',
              left: view.remainingPercent,
              of: 100,
              reading: [`${view.remainingPercent}% left`, view.label, view.shortCountdown && `resets in ${view.shortCountdown}`]
                .filter(Boolean)
                .join(' · '),
              tone: view.tone === 'bad' ? 'danger' : view.tone === 'warn' ? 'warning' : 'success',
            }
          : null,
      on:
        sessions.length > 0
          ? {
              title: `${sessions.length} ${sessions.length === 1 ? 'session' : 'sessions'} open${working > 0 ? ` · ${working} working` : ''}`,
            }
          : null,
      cautions: account
        ? []
        : [{ tone: 'warning', text: `${info.presentation.name} has no account on this machine yet.` }],
      actions,
    }
  }, [snapshot, info, account, store, onOpenUsage])

  return <AgentCard subject={subject} />
}

export const AccountHoverCard = ({
  info,
  account,
  onOpenUsage,
  children,
  className,
  side,
  align,
  disabled,
}: {
  readonly info: RuntimeInfo
  /** Null for a seat that has not signed in; the card then says so. */
  readonly account: Account | null
  readonly onOpenUsage?: (runtime: RuntimeId) => void
  readonly children: ReactNode
  readonly className?: string
  readonly side?: 'top' | 'right' | 'bottom' | 'left'
  readonly align?: 'start' | 'center' | 'end'
  /** The mark renders bare — while a menu is already open over the same seat, say. */
  readonly disabled?: boolean
}) => (
  <AgentHoverCard
    {...(disabled !== undefined ? { disabled } : {})}
    body={() => (
      <AccountCardBody
        info={info}
        account={account}
        {...(onOpenUsage ? { onOpenUsage } : {})}
      />
    )}
    className={className}
    {...(side ? { side } : {})}
    {...(align ? { align } : {})}
  >
    {children}
  </AgentHoverCard>
)
