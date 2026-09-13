import { useEffect, useMemo, useState } from 'react'

import {
  sessionKey,
  type Intent,
  type SessionId,
  type TeamPeerInfo,
} from '@harnessdesk/protocol'

import { Btn, Dialog, Input } from '../design'
import { runtimeTint } from '../lib/accounts'
import { brandForRuntime } from '../lib/brands'
import { useSnapshot, useStore } from '../state/context'
import { AddWork } from './AddWork'
import { HandOut } from './HandOut'
import { SessionHoverCard } from './AgentCards'
import { useDismissOverlays } from './Popover'
import { BrandMark } from './BrandIcons'
import {
  AgentIcon,
  BranchIcon,
  ClockIcon,
  HandoffIcon,
  PlanIcon,
  PlusIcon,
} from './Icons'
import {
  Board,
  BoardCard,
  BoardColumn,
  BoardMenuButton,
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  EmptyState,
  IconTile,
  ToolPane,
  ToolPaneBody,
  ToolPaneHeader,
  type Tint,
} from '../design/ui'

/**
 * The team board, as a board.
 *
 * The intents were already there — `TeamState.intents`, with a state, the file
 * patterns a claim owns, and the runtime and session holding it. What was
 * missing was a shape that showed them as work rather than as a list: the
 * Details panel drew one flat column, so "what is everyone on" meant reading
 * every row and holding the states in your head.
 *
 * Columns are the states, so no card repeats its own. What a card carries that
 * a list row could not is the **claiming harness as a pressable mark** — and
 * that press is the whole reason the board is next to the conversations rather
 * than in a tool of its own. `intent.claim` already names a runtime and a
 * session; pressing it opens exactly that conversation. The data supported the
 * triangle before anything drew it.
 *
 * A pane rather than a panel because a board needs width: the Details panel is
 * 360px and a column is 280, so putting it there would show one column at a
 * time, which is a list with extra steps — and a list is what this replaces.
 *
 * ---------------------------------------------------------------------------
 * The rebuild: what a card-and-column surface owes its reader
 *
 * Three things were missing, and every one of them was a thing the *data*
 * already had:
 *
 *   Moving work.       A board whose cards cannot be moved is a chart. The
 *                      verbs were on every card as a row of three ghost
 *                      buttons, which cost the width the title needed and
 *                      still made "this is done" a hunt for the right word.
 *                      Cards drag now, and the verbs live behind one ⋮.
 *
 *   Saying why.        `blockedReason`, `detail`, `note` and `handoff` are all
 *                      on `Intent` and none of them was drawn. A card that
 *                      says Blocked and not why sends the reader to the
 *                      channel to find out, which is the trip the board exists
 *                      to save.
 *
 *   Adding properly.   Work went on the board through a 40-character field in
 *                      the header, so `files` — the thing that makes parallel
 *                      claims safe — could only ever be set by an agent. The
 *                      dialog asks for what an intent actually has.
 *
 * Dragging is a *shortcut*, never the only way: every drop is a verb that is
 * also in the card's menu, because a drag is a mouse gesture and a keyboard
 * has to be able to do everything a mouse can.
 */

/**
 * The board's columns, in the order work moves through them — and why there
 * are five rather than four.
 *
 * `blocked` is two situations the engine has always told apart and the board
 * never did. `blockedBy: 'graph'` means the dependencies are unfinished —
 * nothing is wrong, nobody is needed, and it frees itself the moment the work
 * it waits on lands. `blockedBy: 'hand'` means somebody stopped it, and only a
 * deliberate reopen starts it again.
 *
 * Drawn as one column they read as one problem, so a person went to help with
 * work that was about to help itself and scrolled past the one thing that was
 * actually stuck. The distinction was in the data the whole time; this is a
 * projection change, not a schema change.
 */
type ColumnId = 'waiting' | 'open' | 'claimed' | 'blocked' | 'done'

const COLUMNS: readonly { state: ColumnId; title: string; tint: Tint }[] = [
  /* Waiting takes `teal`, the quietest tint in the set that is not already
     spoken for: it identifies a column, it does not judge one. Nothing here is
     wrong — the graph simply has not reached it — so it must not borrow
     Blocked's amber and read as a second problem. */
  { state: 'waiting', title: 'Waiting', tint: 'teal' },
  { state: 'open', title: 'Ready', tint: 'sky' },
  { state: 'claimed', title: 'Claimed', tint: 'violet' },
  { state: 'blocked', title: 'Blocked', tint: 'amber' },
  { state: 'done', title: 'Done', tint: 'green' },
]

/** How long ago, said the way a person would say it. */
const describeAge = (ms: number): string => {
  const minutes = Math.floor(ms / 60000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  return hours < 24 ? `${hours}h` : `${Math.floor(hours / 24)}d`
}

/**
 * A claim nobody is renewing.
 *
 * The chip means *this work can be taken over*, so it has to mean exactly what
 * the host means by it. The host's rule (`#stranded` in server/team.ts) is two
 * facts, not one: the lease is in the past **and** the holder is no longer a
 * live peer. Reading the clock alone put "stranded" on every card whose agent
 * was simply mid-thought past the deadline — a long attached turn — while the
 * server went on refusing the takeover the chip had just advertised.
 *
 * Liveness is not derivable here, so it is asked for: `attached` is the host's
 * own peer list for this board, which is the same list `#stranded` consults.
 * Until that answer exists, nothing is called stranded — a chip that arrives a
 * beat late is a smaller failure than one that is wrong.
 *
 * A stranded card stays in Claimed rather than moving: the work has an owner on
 * paper, and the point is that the paper has gone stale. Moving it would hide
 * the thing worth seeing.
 */
const strandedFor = (
  intent: Intent,
  now: number,
  attached: null | ((claim: { runtime: string; sessionId: string }) => boolean),
): number | null => {
  const claim = intent.claim
  const until = claim?.leaseUntil
  if (intent.state !== 'claimed' || !claim || !until || now < until) return null
  if (!attached || attached(claim)) return null
  return now - until
}

/**
 * Abandoned work is settled but not done, and must not sit in `Done` looking
 * finished — it is folded into the last column wearing its own chip.
 */
const columnOf = (intent: Intent): ColumnId => {
  if (intent.state === 'abandoned') return 'done'
  if (intent.state === 'blocked') return intent.blockedBy === 'hand' ? 'blocked' : 'waiting'
  return intent.state
}

/**
 * What the room calls the conversation holding a claim.
 *
 * The board's `nicknames` map is keyed by runtime and session with a NUL
 * between them, because session ids are unique per runtime and not globally —
 * two harnesses that mint the same id are two different members. The key is
 * built here and nowhere else: a separator typed at a call site is a separator
 * that will one day be typed as a space, and the lookup would then simply
 * return nothing, forever, silently.
 */
const nicknameOf = (
  nicknames: Readonly<Record<string, string>> | undefined,
  claim: { runtime: string; sessionId: string },
): string | undefined => nicknames?.[`${claim.runtime}\u0000${claim.sessionId}`]

/** The user's verbs, as the host will take them. */
type Verb = 'reopen' | 'abandon' | 'done' | 'release' | 'block'

/**
 * What dropping this card on that column would do — or why nothing happens.
 *
 * The honest half of drag-and-drop, and the half every reference gets wrong by
 * letting a card land anywhere and inventing a state for it. Three of the five
 * columns are the user's to fill and two are not, because the *engine* says so:
 *
 *   Ready and Done    are `release`/`reopen` and `done` — the referee's verbs,
 *                     which always win over a claim.
 *   Blocked           is `block`, and it is the one drop that asks a question
 *                     first. A card there has to say what stopped it, or the
 *                     column is a place work goes to be forgotten — so the
 *                     drop opens a field rather than guessing a reason
 *                     nobody gave.
 *   Claimed           is not handed out. An agent claims work, and that is
 *                     what makes the file lock mean anything.
 *   Waiting           belongs to the dependency graph. A card is there because
 *                     something it depends on is unfinished, and it leaves the
 *                     moment that lands — dropping one in would be a claim
 *                     about other work that is not true.
 *
 * So a refusal is a sentence, shown on the column while the card is in the
 * air, rather than a drop that silently does nothing.
 */
const dropOn = (
  intent: Intent,
  to: ColumnId,
): { verb: Verb; label: string } | { refusal: string } | null => {
  if (columnOf(intent) === to) return null
  if (to === 'done') return { verb: 'done', label: `Mark #${intent.id} done` }
  if (to === 'open')
    return intent.state === 'claimed'
      ? { verb: 'release', label: `Take #${intent.id} back off its holder` }
      : { verb: 'reopen', label: `Put #${intent.id} back in play` }
  /* The three the user has no verb for, each said in its own words. One shared
     sentence would have been a rule about the board; these are three different
     facts about who owns which column. */
  if (to === 'blocked') return { verb: 'block', label: `Stop #${intent.id} — you will be asked why` }
  if (to === 'claimed')
    return {
      refusal: 'A job is claimed by the agent that takes it, never handed out. Ask someone to pick it up.',
    }
  return {
    refusal: 'Waiting is the dependency graph’s to decide; it clears when the work it waits on lands.',
  }
}

export const TeamBoardPane = ({ room }: { room: string }) => {
  const store = useStore()
  const snapshot = useSnapshot()
  const [trouble, setTrouble] = useState<string | null>(null)
  /** Which card is in the air, and which column the pointer is over. */
  const [dragging, setDragging] = useState<number | null>(null)
  const [over, setOver] = useState<ColumnId | null>(null)
  /**
   * The long form, and the goal it was opened from.
   *
   * `null` is closed; `{ plan }` is open with that goal already chosen, so the
   * Add beside a goal does not make anybody pick it out of a menu they were
   * just looking at.
   */
  const [detailed, setDetailed] = useState<null | { plan: number | null }>(null)
  const [handing, setHanding] = useState(false)
  /**
   * Who is on this board, from the host.
   *
   * Two things need it. The add dialog's last field asks one of them to pick
   * the job up — and the cards need to know which holders are still *attached*,
   * because that is half of what makes a claim strandable and the renderer
   * cannot work it out. `null` is "not asked yet", which is different from
   * "nobody is here": an empty answer would make every expired lease look
   * stranded during the first moments of a board.
   */
  const [roster, setRoster] = useState<{
    readonly room: string
    readonly peers: readonly TeamPeerInfo[]
  } | null>(null)
  /* Keyed by the room: this pane is reused when it is pointed at another one,
     so an answer about the last one must read as no answer about this one.
     Without the key, a failed fetch for Room B left Room A's members deciding
     which of Room B's claims looked stranded. */
  const peers = roster && roster.room === room ? roster.peers : null
  /** The job being stopped, while its reason is being written. */
  const [stopping, setStopping] = useState<Intent | null>(null)

  /* Boards are keyed by room, so a room that has gone — deleted, or named by
     a layout written before it existed — simply has no entry, which is the
     empty state below rather than an error. */
  const board = snapshot.teams.get(room)
  const intents = board?.intents ?? []
  /* Only the goals still running: a wrapped one has said what it had to say,
     and a band that grew forever would push the work off the screen. */
  const running = (board?.plans ?? []).filter(
    (plan) => plan.state === 'running',
  )

  const openCards = intents.filter((one) => one.state === 'open' && !one.claim).length

  const byColumn = useMemo(() => {
    const out = new Map<ColumnId, Intent[]>()
    for (const column of COLUMNS) out.set(column.state, [])
    for (const intent of intents) out.get(columnOf(intent))?.push(intent)
    return out
  }, [intents])

  /* Membership changes when a conversation opens or closes, and when somebody
     is added to or taken out of the room — that last one takes neither a new
     conversation nor a message, so watching only the first two left this
     answer stale for the life of the pane. A claim's holder going away is
     exactly the event a stranded chip is waiting for. */
  const sessionCount = snapshot.sessions.size
  const members = (board?.members ?? []).join(' ')
  /* The room's flow runs, once, when the pane opens. Every change after this
     arrives as `flow/changed` — the same shape the board's own state does —
     so this is only what a window that has just been opened is missing. */
  useEffect(() => {
    void store.loadFlowRuns(room)
  }, [store, room])
  useEffect(() => {
    let live = true
    void store
      .teamPeers(room)
      .then((answer) => {
        if (live) setRoster({ room, peers: answer })
      })
      /* A failed request is not an answer. Writing `[]` here would have been
         the same mistake `null` exists to prevent, one level down: an empty
         roster reads as "nobody is here", which makes every lapsed lease look
         abandonable — and the chip would say a takeover the host still
         refuses. So a failure keeps whatever was last known, and keeps
         "unknown" when nothing is. The next trigger asks again. */
      .catch(() => undefined)
    return () => {
      live = false
    }
  }, [store, room, intents.length, sessionCount, members])

  /* `here`, not merely on the roster: the host's `#stranded` asks whether the
     holder is a *live* peer, and this chip exists to mean exactly what the
     host means by it. The roster answers with every member of the room now,
     open or not — so testing membership alone would call a holder attached
     for as long as it stayed a member, and the chip that advertises "this can
     be taken over" would never appear again after a relaunch. */
  const attached = useMemo(
    () =>
      peers === null
        ? null
        : (claim: { runtime: string; sessionId: string }) =>
            peers.some(
              (peer) =>
                peer.here && peer.runtime === claim.runtime && peer.sessionId === claim.sessionId,
            ),
    [peers],
  )

  /**
   * The clock, for the one thing on this board that changes while nothing
   * happens: a lease running out.
   *
   * Read at render, a claim became visibly stranded only when some unrelated
   * state moved — so a board left open said "held" about work that had been
   * abandonable for twenty minutes. The tick runs only while there is a lease
   * to watch, because a board with nothing claimed has nothing to re-render
   * for, and it is cleared on the way out.
   */
  const watchingLeases = intents.some(
    (one: Intent) => one.state === 'claimed' && one.claim?.leaseUntil != null,
  )
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!watchingLeases) return
    const timer = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(timer)
  }, [watchingLeases])

  const inFlight = dragging === null ? null : (intents.find((one) => one.id === dragging) ?? null)

  /**
   * A title, straight onto the board.
   *
   * The composer clears the moment it hands the title over, so this only has
   * to say what happened. A refusal used to have to put the words back into a
   * field that had never let go of them; now it says so in the pane's own
   * trouble line and quotes the title, because the field it came from has
   * already moved on to the next card.
   */
  const add = (title: string): void => {
    void store
      .teamAdd(room, { title })
      .then(() => setTrouble(null))
      .catch(() =>
        setTrouble(`The host did not take “${title}”; the board is as it was.`),
      )
  }

  /* The reason is only ever passed when there is one: `block` is the only verb
     that reads it, and handing the other four an explicit `undefined` makes
     every call site look like it might have meant something by it. */
  /**
   * The person's verb over a card. `outcome` is what they answered, on a card
   * a flow addressed to them.
   *
   * Called with exactly the arguments that mean something — a trailing
   * `undefined` is dropped from the request either way, and sending one says
   * "I considered this and have nothing" where omitting it says nothing at
   * all, which is what the wire's optional fields are for.
   */
  const act = (id: number, verb: Verb, reason?: string, outcome?: string): void => {
    void (outcome !== undefined
      ? store.teamIntent(room, id, verb, reason, outcome)
      : reason !== undefined
        ? store.teamIntent(room, id, verb, reason)
        : store.teamIntent(room, id, verb)
    )
      .then(() => setTrouble(null))
      .catch((error: unknown) =>
        setTrouble(
          error instanceof Error && error.message
            ? error.message
            : `The host did not take “${verb}” on #${id}; the board is as it was.`,
        ),
      )
  }

  const openAdd = (plan: number | null): void => setDetailed({ plan })

  /** The edge that makes this a board and not a chart: task to conversation. */
  const openHolder = (intent: Intent): void => {
    if (!intent.claim) return
    void store.openSession(intent.claim.sessionId as SessionId, { runtime: intent.claim.runtime })
  }

  const drop = (to: ColumnId): void => {
    const intent = inFlight
    setDragging(null)
    setOver(null)
    if (!intent) return
    const outcome = dropOn(intent, to)
    if (!outcome || 'refusal' in outcome) return
    /* The one drop that asks a question. A card in Blocked that does not say
       what stopped it sends every reader to the channel to find out, which is
       the trip the board exists to save — so the reason is collected before
       the move rather than hoped for after it. Cancelling leaves the card
       exactly where it was. */
    if (outcome.verb === 'block') return setStopping(intent)
    act(intent.id, outcome.verb)
  }

  return (
    /* A container, because this board is no longer only ever a pane of its
       own: it is also the right half of the team room, where the width is
       whatever the room's rail left over. The header's tally is the first
       thing to go — the columns are counted anyway — and the button that adds
       work keeps its label to the last. */
    <ToolPane className="@container/board size-full rounded-none border-0">
      <ToolPaneHeader
        icon={<PlanIcon />}
        title="Board"
        /* The state of the work, not the path. The room's rail already says
           which project this is, and in a pane of its own the tab does — a
           subtitle spent on a repeated string is a line that could have been
           telling the reader something. */
        subtitle={
          intents.length === 0
            ? 'Nothing on the board yet'
            : `${byColumn.get('open')?.length ?? 0} ready · ${
                byColumn.get('claimed')?.length ?? 0
              } claimed · ${byColumn.get('blocked')?.length ?? 0} blocked`
        }
        subtitleFace="text"
        actions={
          /* One primary, said as a button.
             ---------------------------------------------------------------
             This strip used to be a 44px-wide text field wearing a + and a
             `…`, and it was the wrong shape three times over. A field in a
             pane header reads as a *filter* — every other header in this app
             that carries one is searching what is below it — so the one
             control that adds work looked like the one control that hides
             it. It was also the only way in: the dialog that asks for the
             fields the host actually referees (the files a job owns, what it
             waits on, which goal it belongs to) hid behind an ellipsis
             inside the field, which is a button inside a text box and reads
             as a truncation. And a field cannot be the loudest thing on a
             header, so the board had no primary action at all.

             The quick path is not lost, it has moved to where the card lands:
             the Ready column's own slot takes a title and Enter, in the one
             place on the screen that is already about adding work. What is
             here now is what a header is for — the whole-board actions, with
             the loud one last, which is the order the reference draws and the
             order macOS reads. */
          <div className="flex items-center gap-1.5">
            {/* Offered only when both halves exist — a button that opens a
                dialog to say "nothing to hand out" is a button that lies about
                being useful. */}
            {openCards > 0 && (peers?.some((peer) => !peer.busy) ?? false) && (
              <Button
                size="sm"
                variant="outline"
                aria-label="Hand out the open cards"
                title="Hand out the open cards, one per idle member"
                onClick={() => setHanding(true)}
              >
                <HandoffIcon />
                Hand out
              </Button>
            )}
            <Button
              size="sm"
              /* The visible label leads the accessible one, because below
                 `26rem` the span is hidden and the glyph carries the button
                 alone — so it needs a name, and a name that *replaces* the
                 visible one breaks speech control and WCAG 2.5.3: "click New
                 job" has to match what is announced. */
              aria-label="New job — add work with files, dependencies and a goal"
              title="Add work with files, dependencies and a goal"
              onClick={() => openAdd(null)}
            >
              <PlusIcon />
              {/* The label goes at the narrowest width and the glyph carries
                  it, which is the one thing a pane header can give up without
                  losing the action. `@container/board` is on the pane. */}
              <span className="hidden @[26rem]/board:inline">New job</span>
            </Button>
          </div>
        }
      />
      <ToolPaneBody>
        {trouble && (
          <p className="mb-2 text-xs text-(--hd-danger-ink)" role="alert">
            {trouble}
          </p>
        )}
        {/* The goals on this board, above the work. A Room is permanent and a
            goal is not, so this is the only line that can ever say "finished" —
            and the refusal, when something is still live, is read here rather
            than thrown away, because it is an answer rather than a failure. */}
        {running.length > 0 && (
          <div className="mb-2 flex flex-wrap items-center gap-2">
            {running.map((plan) => {
              const live = intents.filter(
                (one: Intent) =>
                  one.plan === plan.id && one.state !== 'done' && one.state !== 'abandoned',
              ).length
              return (
                <span
                  key={plan.id}
                  className="flex items-center gap-2 rounded-(--hd-radius-sm) bg-(--hd-muted) px-2 py-1"
                >
                  <span className="text-xs font-medium">{plan.goal}</span>
                  <span className="text-xs text-(--hd-muted-foreground) tabular-nums">
                    {live > 0 ? `${live} live` : 'all done'}
                  </span>
                  {/* Work goes onto a goal from the goal itself: the one place
                      a reader is already thinking about that goal, and the only
                      way `plan` gets set without typing an id. */}
                  <Button
                    variant="ghost"
                    size="xs"
                    className="text-(--hd-muted-foreground)"
                    title={`Add work to “${plan.goal}”`}
                    onClick={() => openAdd(plan.id)}
                  >
                    <PlusIcon />
                    Add
                  </Button>
                  <Button
                    variant="ghost"
                    size="xs"
                    className="text-(--hd-muted-foreground)"
                    disabled={live > 0}
                    title={
                      live > 0
                        ? `${live} ${live === 1 ? 'job is' : 'jobs are'} still live on this goal`
                        : 'Put this goal away; its jobs stay as the record'
                    }
                    onClick={() => {
                      void store
                        .teamWrap(room, plan.id)
                        .then((answer) =>
                          setTrouble(answer.startsWith('Refused') ? answer : null),
                        )
                        .catch(() =>
                          setTrouble('The host did not take that; the board is as it was.'),
                        )
                    }}
                  >
                    Wrap up
                  </Button>
                </span>
              )
            })}
          </div>
        )}
        {intents.length === 0 ? (
          <EmptyState
            icon={<PlanIcon />}
            title="Nothing on the board"
            description="Work added here — by you, or by any agent that can reach the board — can be claimed by one conversation at a time, with its files owned while the claim lives."
          >
            <Button size="sm" className="self-center" onClick={() => openAdd(null)}>
              <PlusIcon />
              Add the first job
            </Button>
          </EmptyState>
        ) : (
          /* Wrapped, not scrolled: five fixed states in a pane that gives its
             width up to the right dock and the rail. A scrolled board does not
             get shorter, it hides a state — and the first to go is Blocked,
             which is what the board was opened to find. */
          <Board wrap>
            {COLUMNS.map((column) => {
              const cards = byColumn.get(column.state) ?? []
              const outcome = inFlight ? dropOn(inFlight, column.state) : null
              const refused = outcome !== null && 'refusal' in outcome
              const takes = outcome !== null && !('refusal' in outcome)
              return (
                <BoardColumn
                  key={column.state}
                  title={column.title}
                  count={cards.length}
                  tint={column.tint}
                  /* Only the column a person can actually put new work into
                     carries the add affordance. On the other four it would be
                     a button that adds somewhere else, which is worse than no
                     button at all.

                     One affordance, not two: the slot at the foot takes a
                     title on the spot, which is the quick path that used to be
                     a field in the pane header, moved to the place the card
                     will appear. The column keeps no `+` of its own, because
                     the long form already has a door — the pane header's — and
                     a third way to add work on one screen is a reader deciding
                     which of three buttons they meant. */
                  {...(column.state === 'open'
                    ? {
                        addLabel: 'Add work',
                        addPlaceholder: 'Title, then Enter',
                        onAddTitle: add,
                      }
                    : {})}
                  {...(inFlight
                    ? {
                        /* The outline belongs to the column the pointer is
                           over *and* that would take the card. Keyed on `over`
                           alone, it stayed lit on the last legal column while
                           the pointer sat on an illegal one — which is the
                           board pointing at the wrong place at the exact
                           moment somebody is deciding where to let go. */
                        'data-over': over === column.state && takes ? '' : undefined,
                        'data-takes': takes ? '' : undefined,
                        'data-refused': refused ? '' : undefined,
                      }
                    : {})}
                  className={
                    'transition-colors ' +
                    /* The column the card would land in, said while it is still
                       in the air. Dashed rather than filled: the card is not
                       there yet. */
                    'data-[over]:outline-2 data-[over]:outline-dashed data-[over]:outline-(--hd-primary) data-[over]:-outline-offset-2 ' +
                    'data-[refused]:opacity-45'
                  }
                  onDragOver={(event) => {
                    if (!inFlight) return
                    /* Every column the pointer crosses claims `over`, so the
                       one it left stops being lit. Only a column that would
                       take the card allows the drop, though: the rest keep the
                       browser's "no" cursor, which is the platform saying the
                       same thing the column already says in words. */
                    if (over !== column.state) setOver(column.state)
                    if (!takes) return
                    event.preventDefault()
                    event.dataTransfer.dropEffect = 'move'
                  }}
                  onDragLeave={(event) => {
                    /* `dragleave` fires crossing every child, so the pointer
                       leaving a card inside the column would clear the
                       highlight the column just earned. */
                    if (event.currentTarget.contains(event.relatedTarget as Node | null)) return
                    setOver((was) => (was === column.state ? null : was))
                  }}
                  onDrop={(event) => {
                    event.preventDefault()
                    drop(column.state)
                  }}
                >
                  {/* What this column would do with the card, or why it will
                      not take it — said while the card is still in the air, and
                      above the cards rather than under them, because it is a
                      fact about the column and not about whatever happens to be
                      last in it.

                      A tooltip cannot carry either half: no browser shows one
                      mid-drag. And the promise is the *verb*, not "drop here" —
                      the four columns do four different things to a card, and
                      the one a person is about to trigger is worth naming
                      before they let go. */}
                  {takes && (
                    <p className="px-1.5 pb-1 text-xs leading-snug font-medium text-(--hd-primary-ink)">
                      {(outcome as { label: string }).label}
                    </p>
                  )}
                  {refused && (
                    <p className="px-1.5 pb-1 text-xs leading-snug text-(--hd-muted-foreground)">
                      {(outcome as { refusal: string }).refusal}
                    </p>
                  )}
                  {cards.map((intent) => (
                    <IntentCard
                      key={intent.id}
                      intent={intent}
                      room={room}
                      dragging={dragging === intent.id}
                      onDragStart={() => setDragging(intent.id)}
                      onDragEnd={() => {
                        setDragging(null)
                        setOver(null)
                      }}
                      now={now}
                      attached={attached}
                      onOpenHolder={() => openHolder(intent)}
                      onAct={(verb, outcome) =>
                        verb === 'block' ? setStopping(intent) : act(intent.id, verb, undefined, outcome)
                      }
                    />
                  ))}
                  {cards.length === 0 && !inFlight && (
                    /* A column with nothing in it still has to read as a
                       column. Only while nothing is being dragged: with a card
                       in the air the line above is saying something the reader
                       needs more. */
                    <p className="px-1.5 py-3 text-center text-xs text-(--hd-muted-foreground)">
                      Nothing here
                    </p>
                  )}
                </BoardColumn>
              )
            })}
          </Board>
        )}
      </ToolPaneBody>
      {stopping && (
        <StopWork
          intent={stopping}
          onClose={() => setStopping(null)}
          onStop={(reason) => {
            act(stopping.id, 'block', reason)
            setStopping(null)
          }}
        />
      )}
      {handing && (
        <HandOut
          room={room}
          intents={intents}
          peers={peers ?? []}
          onClose={() => setHanding(false)}
          onTrouble={setTrouble}
        />
      )}
      {detailed && (
        <AddWork
          room={room}
          plan={detailed.plan}
          plans={running}
          intents={intents}
          peers={peers ?? []}
          onClose={() => setDetailed(null)}
          onTrouble={setTrouble}
        />
      )}
    </ToolPane>
  )
}

/**
 * Stopping a job, and the one field that makes the Blocked column worth having.
 *
 * The column existed before this verb did: an agent could put work down with
 * `release(blocked)` and a reason, and a person could only *abandon* it —
 * which is a different sentence, and a permanent one. So a person who knew a
 * job should not be worked right now had to say something they did not mean.
 *
 * The reason is asked for rather than hoped for. A card in Blocked that does
 * not say what stopped it is a card the next reader has to go to the channel
 * about, which is the trip the whole board exists to save — and the drag that
 * lands here is exactly the moment the person knows the answer.
 */
const StopWork = ({
  intent,
  onClose,
  onStop,
}: {
  intent: Intent
  onClose: () => void
  onStop: (reason: string) => void
}) => {
  const [reason, setReason] = useState('')
  return (
    <Dialog
      title={`Stop #${intent.id}`}
      onClose={onClose}
      footer={
        <>
          <Btn variant="primary" onClick={() => onStop(reason)}>
            Stop it
          </Btn>
          <Btn onClick={onClose}>Cancel</Btn>
        </>
      }
    >
      <div className="flex flex-col gap-2">
        <p className="text-sm text-(--hd-muted-foreground)">
          “{intent.title}” goes to Blocked. Any claim on it is released, and a finished dependency
          will not start it again — only a deliberate reopen will.
        </p>
        <Input
          autoFocus
          aria-label="Why it is stopped"
          value={reason}
          placeholder="Waiting on the rename"
          onChange={(event) => setReason(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') onStop(reason)
          }}
        />
        {/* Allowed through empty, and told what that costs. Refusing would put
            a modal between a person and a board they are allowed to change;
            saying nothing about it would produce the silent card this field
            exists to prevent. */}
        <p className="text-xs text-(--hd-muted-foreground)">
          {reason.trim()
            ? 'The card will say this, and so will the room.'
            : 'Without a reason the card says only that you stopped it.'}
        </p>
      </div>
    </Dialog>
  )
}

/**
 * One job, as a card.
 *
 * A card never repeats its own state — the column already said it, and that is
 * the whole claim a board makes over a list. What it does carry is everything
 * the column *cannot* say: who holds it, why it stopped, how long it has been
 * sitting there, and what it is waiting on.
 */
const IntentCard = ({
  intent,
  room,
  dragging,
  now,
  attached,
  onDragStart,
  onDragEnd,
  onOpenHolder,
  onAct,
}: {
  intent: Intent
  room: string
  dragging: boolean
  /** The pane's clock, so a lease runs out on screen and not only on re-render. */
  now: number
  /** The host's peer list, as a predicate. `null` until it has answered. */
  attached: null | ((claim: { runtime: string; sessionId: string }) => boolean)
  onDragStart: () => void
  onDragEnd: () => void
  onOpenHolder: () => void
  /** `outcome` is what the person answered, on a card a flow addressed to them. */
  onAct: (verb: Verb, outcome?: string) => void
}) => {
  const snapshot = useSnapshot()

  /*
   * The menu's open state is held here rather than left to Radix, because
   * something other than the menu has to be able to close it. Radix closes on
   * Escape and on a press outside, and a window taking the screen is neither:
   * Settings, Usage and — in a narrow window — the floating sidebar announce
   * themselves instead, and a menu drawn at `--hd-z-popover` outranks all
   * three, so this one hung over whichever of them opened, modal, holding the
   * focus they had just taken (#214).
   */
  const [menuOpen, setMenuOpen] = useState(false)
  useDismissOverlays(menuOpen, () => setMenuOpen(false))

  /* The role this card was addressed to, as the running flow defines it.
     A room with no flow has no entry here at all, which is every room that
     existed before flows — and then every branch below falls through to what
     the card has always drawn. */
  const role = useMemo(() => {
    if (!intent.role) return null
    const run = (snapshot.flowRuns.get(room) ?? []).find((one) => one.state === 'running')
    return run?.flow.roles.find((one) => one.id === intent.role) ?? null
  }, [intent.role, room, snapshot.flowRuns])

  const runtime = intent.claim
    ? (snapshot.runtimes.find((one) => one.id === intent.claim?.runtime) ?? null)
    : null
  const session = intent.claim
    ? snapshot.sessions.get(sessionKey(intent.claim.runtime, intent.claim.sessionId as SessionId))
    : null
  const stranded = strandedFor(intent, now, attached)
  /* The board carries the names, so a card can say who holds it without
     fetching a roster — and without drawing "(untitled)" in the gap before an
     answer that may never come for a conversation nobody named. */
  const holder = intent.claim
    ? nicknameOf(snapshot.teams.get(room)?.nicknames, intent.claim)
    : undefined
  /* The holder by its *room name*. Reading the conversation's own title first
     and falling back to "(untitled)" — which is what an ACP conversation
     always is — put a live Cursor agent that had just claimed the job on the
     card as "(untitled) Cursor". The name the room gave it always exists. */
  const holderName = holder ?? session?.title ?? runtime?.presentation.name ?? '(untitled)'
  /* The holder's own ring, so the face on a card and the row in the rail are
     visibly the same account — see lib/accounts.ts on what the ring is for. */
  const holderTint = intent.claim
    ? runtimeTint(intent.claim.runtime, snapshot.accountsByRuntime, snapshot.accountPrefs)
    : 'blue'

  /**
   * The one line under the title, and the order is the order a reader needs it.
   *
   * Why it stopped outranks what it is: a card in Blocked that does not say
   * what blocked it sends the reader to the channel, which is the trip the
   * board exists to save. A finished card's note is the completion note the
   * next agent will read. Only when neither exists does the card fall back to
   * its own description.
   */
  const note =
    intent.blockedReason ??
    (intent.state === 'done' || intent.state === 'abandoned' ? intent.note : null) ??
    intent.detail ??
    null

  /* The referee's verbs. The user's word is final over any claim, which is why
     these are on every card rather than behind the holder — and why they are
     behind one glyph rather than spread across the foot: three ghost buttons
     cost the width the title needed, and named the same four actions on every
     card whether or not they applied. */
  const verbs: readonly {
    verb: Verb
    label: string
    danger?: boolean
    outcome?: string
  }[] = [
    /* A card a flow addressed to *the person* is a step, not an absence: the
       round opened, the loop is waiting, and what they answer is what the next
       rule branches on. So the menu offers the words the role declared rather
       than "Mark done", which would finish the card and leave the run with
       nothing to read. */
    ...(role?.kind === 'person' && intent.state !== 'done' && intent.state !== 'abandoned'
      ? role.outcomes.map((word) => ({
          verb: 'done' as const,
          label: `Answer ${word}`,
          outcome: word,
        }))
      : intent.state !== 'done' && intent.state !== 'abandoned'
        ? [{ verb: 'done' as const, label: 'Mark done' }]
        : []),
    ...(intent.state === 'claimed'
      ? [{ verb: 'release' as const, label: `Take it back off ${holderName}` }]
      : []),
    ...(intent.state === 'done' || intent.state === 'abandoned' || intent.state === 'blocked'
      ? [{ verb: 'reopen' as const, label: 'Put back in play' }]
      : []),
    /* Stopping is not finishing and not dropping: it says the work should not
       be worked *for now*, and only a deliberate reopen starts it again. It
       was an agent-only verb until the board grew a Blocked column the user
       could not put anything in. */
    ...(intent.state === 'open' || intent.state === 'claimed'
      ? [{ verb: 'block' as const, label: 'Stop it — say why' }]
      : []),
    /* Dropping work is not finishing it, and a board with only `Done` makes
       the reader lie to it to clear a card. Unclaimed work only: taking a card
       away from an agent mid-claim is `Release`. */
    ...(intent.state === 'open' || intent.state === 'blocked'
      ? [{ verb: 'abandon' as const, label: 'Abandon', danger: true }]
      : []),
  ]

  return (
    <BoardCard
      /* The whole card is the handle. A grip glyph would be a second small
         thing to aim at on a surface whose cards are already small, and every
         verb a drag performs is in the menu below — so a keyboard loses a
         shortcut here, never a capability. */
      draggable
      onDragStart={(event) => {
        /* Text too, so a card dragged out of the app arrives somewhere as
           something a person can read. */
        event.dataTransfer.setData('text/plain', `#${intent.id} ${intent.title}`)
        event.dataTransfer.effectAllowed = 'move'
        onDragStart()
      }}
      onDragEnd={onDragEnd}
      className={
        'cursor-grab transition-[opacity,border-color] active:cursor-grabbing ' +
        (dragging ? 'opacity-40' : 'hover:border-(--hd-border-strong)')
      }
      title={
        <>
          <span className="font-(family-name:--hd-font-code) text-xs text-(--hd-muted-foreground)">
            #{intent.id}
          </span>{' '}
          {intent.title}
        </>
      }
      note={note}
      cover={
        intent.claim ? (
          <button
            type="button"
            onClick={onOpenHolder}
            /* Said once. With the conversation loaded, the card on the names
               says who holds this and opens it, and a native tooltip on the
               same rest stacks a second box on the card — so there the
               sentence is the description the platform *exposes* instead. With
               no card to show, it stays the tooltip.

               "Exposes" to the letter: what was measured is that Chromium 148
               reports `aria-description` and `title` alike as the button's
               description in the accessibility tree. What any one assistive
               technology then announces is its own business, and
               `aria-description` is still ARIA 1.3. */
            {...(session
              ? { 'aria-description': `Open the conversation ${holderName} is holding this in` }
              : { title: `Open the conversation ${holderName} is holding this in` })}
            className="flex w-full items-center gap-1.5 rounded-(--hd-radius-sm) bg-(--hd-muted) px-1.5 py-1 text-left hover:bg-(--hd-hover)"
          >
            {/* The face and the names, as one trigger: the holder is who a
                reader rests on, and the name is where they rest. A *session*
                card rather than a member's: the board knows which
                conversation holds this and nothing about the room's roster,
                and the one fact a member card would add — the job — is the
                card this holder is sitting on. Only when the conversation is
                open here; a claim by one this renderer has never loaded has
                nothing to report, and an invented card is worse than none —
                and then the three fall back into the button's own row, which
                lays them out the same. */}
            <SessionHoverCard
              session={session ?? null}
              className="flex min-w-0 flex-1 items-center gap-1.5"
              actions={[{ label: 'Open', primary: true, onSelect: onOpenHolder }]}
            >
              <IconTile size="sm" tint={holderTint}>
                {runtime ? (
                  <BrandMark brand={brandForRuntime(runtime) ?? 'openai'} size={12} />
                ) : (
                  <AgentIcon />
                )}
              </IconTile>
              {/* Two names, and neither is allowed to starve the other.
                  `flex-1` on the left with `shrink-0` on the right meant the
                  right one kept every pixel it asked for and the left one paid
                  for all of it — so a Cursor conversation called "checkout
                  tests" drew as `Curs… checkout tests`, with the *harness* cut
                  to four letters to make room for a title that is the less
                  important of the two. Half the row each, both truncating, is
                  the only split that cannot produce that: when either is short
                  the other takes the slack, and when both are long they lose
                  the same amount. */}
              <span className="min-w-0 flex-1 basis-1/2 truncate text-xs font-medium">
                {holderName}
              </span>
              {/* The conversation's own title, when it is not already the name
                  on the left. Compared against what is *drawn*, not against the
                  nickname: with no nickname the left falls back to the title,
                  and comparing to the nickname printed it twice. No tooltip of
                  its own, though it truncates: it is drawn only when the
                  conversation is loaded, so always inside the card's trigger,
                  and the card's heading is this title, with a card's width to
                  draw it in — a tooltip as well would be the second box on one
                  rest that the button's sentence stopped being. The whole of a
                  long one is in the conversation the button opens. */}
              {session?.title && session.title !== holderName && (
                /* And below a column width of about thirteen rems it is not
                   drawn at all. Half a row each is the right split while there
                   is a row to split; at 176px — five columns inside a room —
                   half of one is four letters, and `Gam… check…` tells a reader
                   neither of the two things it was trying to say. The column is
                   the container that decides, because the pane's width is not
                   the card's width on a board of five. */
                <span
                  className="hidden min-w-0 flex-1 basis-1/2 truncate text-right text-xs text-(--hd-muted-foreground) @[13rem]/board-column:inline"
                >
                  {session.title}
                </span>
              )}
            </SessionHoverCard>
          </button>
        ) : undefined
      }
      /* The paths a claim owns. Shown because they are what makes parallel
         edits safe, and the reason a second claim gets refused. */
      /* A role *identifies* a card — which is what this slot is for — and on a
         flow's board it is the fact a reader is scanning for: this one is the
         fixer's, those three are the reviewers'. Files keep the slot on every
         board that has no flow, which is every board that existed before this,
         and move to the foot when a card has both. */
      tag={
        intent.role
          ? { label: intent.role, tint: 'violet' }
          : intent.files.length > 0
            ? { label: intent.files.join(', '), tint: 'teal' }
            : undefined
      }
      /* A card never repeats its own state. `abandoned` is the one exception,
         because it shares the Done column with work that actually finished and
         the difference is the news. Stranded is the other thing a column
         cannot say, because the card is still in Claimed and still looks
         owned: this is "somebody is on it" versus "somebody was". */
      priority={
        intent.state === 'abandoned'
          ? { label: 'abandoned', tone: 'neutral' }
          : stranded !== null
            ? { label: `stranded ${describeAge(stranded)}`, tone: 'warning' }
            : /* What the card answered, which is the one judgement a finished
                 flow card carries — and the thing the next round was decided
                 on, so a reader asking "why did that open?" reads it here.
                 Neutral, always: the words are the flow author's own and this
                 surface has no way to know which of them is the good news. */
              intent.outcome
              ? { label: intent.outcome, tone: 'neutral' as const }
              : undefined
      }
      meta={
        <span className="flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1 whitespace-nowrap">
          {/* How long since anything happened to it. The number a person is
              actually after on a board is "how long has that been sitting
              there", and until now the card could not answer it at all. */}
          <span
            className="inline-flex items-center gap-1 [&_svg]:size-3.5"
            title={`Last changed ${new Date(intent.updatedAt).toLocaleString()}`}
          >
            <ClockIcon />
            <span className="tabular-nums">{describeAge(now - intent.updatedAt)}</span>
          </span>
          {intent.role && intent.files.length > 0 && (
            <span
              className="inline-flex min-w-0 items-center gap-1 [&_svg]:size-3.5"
              title={`Owns ${intent.files.join(', ')} while claimed`}
            >
              <span className="truncate">{intent.files.join(', ')}</span>
            </span>
          )}
          {intent.dependsOn.length > 0 && (
            <span
              className="inline-flex items-center gap-1 [&_svg]:size-3.5"
              title={`Waits for ${intent.dependsOn.map((one) => `#${one}`).join(', ')}`}
            >
              <BranchIcon />
              <span className="tabular-nums">{intent.dependsOn.length}</span>
            </span>
          )}
          {/* A finished job that left a context package says so, because the
              package is the whole point of finishing one here: it is what the
              next agent reads instead of asking. */}
          {intent.handoff && (
            <span
              className="inline-flex items-center gap-1 [&_svg]:size-3.5"
              title={intent.handoff}
            >
              <HandoffIcon />
              <span>handoff</span>
            </span>
          )}
        </span>
      }
      actions={
        verbs.length > 0 ? (
          <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
            <DropdownMenuTrigger asChild>
              <BoardMenuButton aria-label={`What to do with #${intent.id}`} />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {verbs.map((one) => (
                <DropdownMenuItem
                  key={one.outcome ? `${one.verb}:${one.outcome}` : one.verb}
                  variant={one.danger ? 'destructive' : 'default'}
                  onSelect={() => onAct(one.verb, one.outcome)}
                >
                  {one.label}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        ) : undefined
      }
    />
  )
}
