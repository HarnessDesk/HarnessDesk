import { isRecord, RECORD_REASON } from '../lib/team-record'
import { useEffect, useMemo, useRef, useState } from 'react'

import {
  sessionKey,
  type BoardEvidence,
  type CardEvidence,
  type CheckUnseen,
  type Intent,
  type SessionId,
  type TeamPeerInfo,
} from '@harnessdesk/protocol'

import { ChangeStats, Chip, Dialog, Dot, Field, Input, Note, Segmented, TableCell, TableRow, Text } from '../design'
import { teamBoardLayout } from '../lib/team-board-layout'
import { TeamBoardList, JOB_COLUMN_CLASS, type JobColumn } from './TeamBoardList'
import { chipOf, ciVerdict, isCurrent, standingWords } from '../lib/evidence'
import { openExternal } from '../lib/desktop'
import { runtimeTint } from '../lib/accounts'
import { FACT_COLUMNS, flowStepOf, evidenceForCard, placeCard, type FactColumn, type Placement } from '../lib/board-facts'
import { brandForRuntime } from '../lib/brands'
import { namedGoalRun } from '../lib/goal-run'
import { shortSha } from '../lib/git-refs'
import { stepWords } from '../lib/run-timeline'
import type { AppSnapshot } from '../state/store'
import { useSnapshot, useStore } from '../state/context'
import { AddWork } from './AddWork'
import { PersonStepDialog } from './PersonStepDialog'
import { EvidenceChips } from './EvidenceChips'
import { RetryCheck } from './RetryCheck'
import { RunCheck } from './RunCheck'
import { FrontDoor } from './FrontDoor'
import { HandOut } from './HandOut'
import { GoalAssign } from './GoalAssign'
import { SessionHoverCard } from './AgentCards'
import { BrandMark } from './BrandIcons'
import {
  AgentIcon,
  BranchIcon,
  ClockIcon,
  HandoffIcon,
  MoreIcon,
  PlusIcon,
  TeamIcon,
} from './Icons'
import {
  Board,
  BoardCard,
  BoardColumn,
  BOARD_COLUMN_MIN_WIDTH,
  BOARD_RAIL_WIDTH,
  Banner,
  BannerAction,
  Button,
  EmptyState,
  PaneColumn,
  IconTile,
  Menu,
  MenuItem,
  MenuSeparator,
  Popover,
  ToolPane,
  ToolPaneBody,
  ViewBar,
  type Tint,
} from '../design'

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
const TINTS: Readonly<Record<FactColumn, Tint>> = {
  todo: 'teal',
  working: 'sky',
  needs: 'amber',
  review: 'violet',
  ready: 'green',
  aside: 'blue',
}

const COLUMNS: readonly { id: FactColumn; title: string; tint: Tint }[] = FACT_COLUMNS.map((column) => ({
  ...column,
  tint: TINTS[column.id],
}))

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

/** One attribution and note rule for the card, list and its filter. */
const jobCopy = (intent: Intent, room: string, snapshot: AppSnapshot) => {
  const lifecycle = snapshot.teams.get(room)?.channel.slice().reverse().find(one =>
    one.kind === 'signal' && one.intent === intent.id && one.signal !== 'conflict')
  const former = lifecycle?.kind === 'signal' && lifecycle.by.kind === 'agent' &&
    ((intent.state === 'done' && lifecycle.signal === 'completed') ||
     (intent.state === 'blocked' && intent.blockedBy === 'hand' && lifecycle.signal === 'blocked'))
    ? lifecycle.by : null
  const assignee = intent.claim ?? former
  const holderName = assignee
    ? nicknameOf(snapshot.teams.get(room)?.nicknames, assignee) ??
      snapshot.sessions.get(sessionKey(assignee.runtime, assignee.sessionId as SessionId))?.title ??
      snapshot.runtimes.find(one => one.id === assignee.runtime)?.presentation.name ?? '(untitled)'
    : intent.state === 'done' || intent.state === 'abandoned' ? '—' : 'Unassigned'
  const repairLead = (() => {
    const run = intent.dispatch?.split(':')[0]
    const round = intent.dispatch?.split(':')[1]
    const view = run ? snapshot.findingRuns.get(run) : undefined
    if (!view?.repair || String(view.round) !== round) return null
    return view.repair
      .map((lead) => {
        const claimed = lead.claimed.length > 0 ? lead.claimed.join(', ') : 'none'
        const unresolved = lead.unresolved.length > 0 ? lead.unresolved.join(', ') : 'none'
        return `Repair delta ${shortSha(lead.from)} → ${shortSha(lead.to)} — claims to close ${claimed}; still open ${unresolved}`
      })
      .join(' ')
  })()

  const note =
    intent.blockedReason ??
    repairLead ??
    (intent.state === 'done' || intent.state === 'abandoned' ? intent.note : null) ??
    stepWords(intent.detail) ??
    null

  return { assignee, holderName, note }
}

/** The user's verbs, as the host will take them. */
type Verb = 'reopen' | 'abandon' | 'done' | 'release' | 'block'

type BoardChecks = Pick<BoardEvidence, 'checks' | 'refused' | 'unreadable'>

const NO_CHECKS: BoardChecks = { checks: [], refused: [], unreadable: null }

const CHECKS_FILE_WORDS = '.harnessdesk/checks.yml'

export const TeamBoardPane = ({ room }: { room: string }) => {
  const store = useStore()
  const snapshot = useSnapshot()
  const [preferredView, setView] = useState<'board' | 'list'>('board')
  const paneRef = useRef<HTMLElement>(null)
  const bodyRef = useRef<HTMLDivElement>(null)
  const boardRef = useRef<HTMLDivElement>(null)
  const [paneSize, setPaneSize] = useState<{ width: number; contentWidth: number; gap: number } | null>(null)
  const [openedColumns, setOpenedColumns] = useState<ReadonlySet<string>>(() => new Set())
  const layout = teamBoardLayout(paneSize?.width ?? Infinity, paneSize?.contentWidth ?? Infinity, openedColumns, paneSize?.gap ?? 12)
  const view = layout.compact ? 'list' : preferredView
  useEffect(() => {
    const pane = paneRef.current
    const body = bodyRef.current
    if (!pane || !body) return
    const measure = () => {
      // The body reserves its scrollbar gutter, so changing layout cannot
      // change the width that chose it. Read resolved CSS lengths so a
      // foundation may express spacing in rem or calc() as well as px.
      const width = body.clientWidth
      if (width <= 0) return
      const style = getComputedStyle(body)
      const contentWidth = width - parseFloat(style.paddingInlineStart) - parseFloat(style.paddingInlineEnd)
      const board = boardRef.current
      setPaneSize(previous => {
        const gap = board ? parseFloat(getComputedStyle(board).columnGap) : previous?.gap ?? 12
        return previous?.width === width && previous.contentWidth === contentWidth && previous.gap === gap
          ? previous : { width, contentWidth, gap }
      })
    }
    measure()
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', measure)
      return () => window.removeEventListener('resize', measure)
    }
    const observer = new ResizeObserver(measure)
    observer.observe(body)
    return () => observer.disconnect()
  }, [view])
  const [trouble, setTrouble] = useState<string | null>(null)
  /**
   * The long form, and the goal it was opened from.
   *
   * `null` is closed; `{ plan }` is open with that goal already chosen, so the
   * Add beside a goal does not make anybody pick it out of a menu they were
   * just looking at.
   */
  const [detailed, setDetailed] = useState(false)
  const [handing, setHanding] = useState(false)
  const [assigning, setAssigning] = useState<number | null>(null)
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
  const [asking, setAsking] = useState<{ readonly card: number; readonly unseen: CheckUnseen } | null>(null)
  const [starting, setStarting] = useState(false)
  const [startingTeam, setStartingTeam] = useState(false)

  /* Boards are keyed by room, so a room that has gone — deleted, or named by
     a layout written before it existed — simply has no entry, which is the
     empty state below rather than an error. */
  const board = snapshot.teams.get(room)
  const goal = snapshot.goals.get(room)
  const record = isRecord(goal)
  const namedRun = namedGoalRun(goal)
  const intents = board?.intents ?? []
  const openCards = intents.filter((one) => one.state === 'open' && !one.claim).length
  /* The front door's own reusable-empty-Goal rule: no Seats yet. A Goal
     already carrying one is a live effort, not a blank slate — reusing it
     from here would start a second, unrelated run beside it rather than
     the fresh one this button promises. */
  const emptyGoal = goal !== undefined && goal.members.length === 0 ? goal : null

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

  // A board restored without its room pane must recover the same execution;
  // finished checks still need their role and operation to offer Run again.
  useEffect(() => {
    if (!namedRun || snapshot.flowExecutions.has(namedRun)) return
    void store.readFlowExecution(namedRun).catch(() => {})
  }, [snapshot.flowExecutions, namedRun, store])

  useEffect(() => {
    const read = (): void => void store.loadBoardEvidence(room)
    read()
    const timer = setInterval(read, 30_000)
    window.addEventListener('focus', read)
    return () => {
      clearInterval(timer)
      window.removeEventListener('focus', read)
    }
  }, [store, room])
  const evidence = snapshot.boardEvidence.get(room)
  const evidenceFailed = snapshot.boardEvidenceFailed.has(room)
  const waitingForEvidence = evidence === undefined && intents.some((intent) => intent.state === 'done')
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
    if (!watchingLeases && view !== 'list') return
    const timer = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(timer)
  }, [watchingLeases, view])

  const waiting = useMemo(() => new Set(snapshot.approvals.map((one) => one.key)), [snapshot.approvals])
  const flowRun = (snapshot.flowRuns.get(room) ?? []).find(
    (one) => one.state === 'running' || one.state === 'stalled',
  )
  const executions = useMemo(
    () => [...snapshot.flowExecutions.values()].filter((one) => one.goal === room),
    [snapshot.flowExecutions, room],
  )
  const placed = useMemo(() => {
    const out = new Map<number, Placement>()
    for (const intent of intents) {
      // A completed card's column is an evidence verdict. Until the first
      // read succeeds, omitting it is honest; “nothing checked” is not.
      if (intent.state === 'done' && evidence === undefined) continue
      const role = flowStepOf(intent, flowRun, executions)
      out.set(
        intent.id,
        placeCard({
          intent,
          evidence: evidenceForCard(intent, intents, evidence, flowRun, executions),
          flowStep: role,
          stranded: strandedFor(intent, now, attached) !== null,
          holderWaits: intent.claim
            ? waiting.has(sessionKey(intent.claim.runtime, intent.claim.sessionId as SessionId))
            : false,
          forPerson: role?.kind === 'person',
          live: role?.live ?? false,
          runStopped: role?.stopped ?? false,
        }),
      )
    }
    return out
  }, [intents, evidence, now, attached, waiting, flowRun, executions])
  const byColumn = useMemo(() => {
    const out = new Map<FactColumn, Intent[]>()
    for (const column of COLUMNS) out.set(column.id, [])
    for (const intent of intents) {
      const placement = placed.get(intent.id)
      if (placement) out.get(placement.column)?.push(intent)
    }
    return out
  }, [intents, placed])
  const shown = COLUMNS.filter(
    (column) => column.id !== 'aside' || (byColumn.get('aside')?.length ?? 0) > 0,
  )

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
  const [retryCard, setRetryCard] = useState<{ run: string; card: number } | null>(null)
  const act = (id: number, verb: Verb, reason?: string, outcome?: string): void => {
    if (verb === 'reopen') {
      const card = board?.intents.find((one) => one.id === id)
      const step = card ? flowStepOf(card, undefined, [...snapshot.flowExecutions.values()].filter((one) => one.goal === room)) : null
      if (step?.kind === 'check' && step.run) { setRetryCard({ run: step.run, card: id }); return }
    }
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

  const openAdd = (): void => setDetailed(true)

  const runCheck = (
    card: number,
    name: string,
    answer?: { readonly seen: string; readonly digest: string },
  ): void => {
    setStarting(answer !== undefined)
    void (answer !== undefined
      ? store.runCheck(room, card, name, answer)
      : store.runCheck(room, card, name))
      .then((result) => {
        if (result.kind === 'unseen') {
          setAsking({ card, unseen: result.unseen })
          return
        }
        setAsking(null)
        setTrouble(null)
      })
      .catch((error: unknown) => {
        setAsking(null)
        setTrouble(
          error instanceof Error && error.message
            ? error.message
            : `${name} did not start on #${card}; nothing ran.`,
        )
      })
      .finally(() => setStarting(false))
  }

  /** The edge that makes this a board and not a chart: task to conversation. */
  const openHolder = (intent: Intent): void => {
    if (!intent.claim) return
    void store.openSession(intent.claim.sessionId as SessionId, { runtime: intent.claim.runtime })
  }

  const notices = trouble || waitingForEvidence ? <>
        {trouble && <Note tone="bad">{trouble}</Note>}
        {waitingForEvidence && (
          <Banner
            tone={evidenceFailed ? 'danger' : 'info'}
            title={evidenceFailed ? 'Evidence unavailable' : 'Checking current evidence'}
            role={evidenceFailed ? 'alert' : 'status'}
            actions={
              evidenceFailed ? (
                <BannerAction onClick={() => void store.loadBoardEvidence(room)}>Try again</BannerAction>
              ) : undefined
            }
          >
            {evidenceFailed
              ? 'The desk could not read the current facts, so completed work has not been placed.'
              : 'Completed work will be placed after the desk reads its current facts.'}
          </Banner>
        )}
  </> : null

  return (
    /* A container, because this board is no longer only ever a pane of its
       own: it is also the right half of the team room, where the width is
       whatever the room's rail left over. The header's tally is the first
       thing to go — the columns are counted anyway — and the button that adds
       work keeps its label to the last. */
    <ToolPane ref={paneRef} variant="integrated" className="@container/board">
      {/* The state of the work, not its name: the tab above already says
          "Board". List summaries share the table text edge; columns keep
          the canvas gutter below the view row. */}
      <ViewBar
        contentInset={view === 'list' ? 'reading-table' : 'page'}
        aria-label="Board"
        summary={
          `${byColumn.get('todo')?.length ?? 0} to do · ${
            byColumn.get('working')?.length ?? 0
          } working · ${byColumn.get('needs')?.length ?? 0} need you`
        }
        actions={
          /* Top-bar actions stay outlined: a filled button belongs with the
             work itself. The Ready column keeps its contextual title-and-
             Enter shortcut, while the header holds the board-wide verbs. */
          <div className="flex items-center gap-1.5">
            {/* Offered only when both halves exist — a button that opens a
                dialog to say "nothing to hand out" is a button that lies about
                being useful. */}
            {openCards > 0 && (peers?.some((peer) => !peer.busy) ?? false) && (
              <Button
                disabled={record}
                size="sm"
                variant="outline"
                aria-label="Hand out the open cards"
                title={record ? RECORD_REASON : "Hand out the open cards, one per idle member"}
                onClick={() => setHanding(true)}
              >
                <HandoffIcon />
                Hand out
              </Button>
            )}
            {emptyGoal && intents.length === 0 && (
              <Button size="sm" variant="secondary" disabled={record} title={record ? RECORD_REASON : undefined} onClick={() => setStartingTeam(true)}>
                <TeamIcon />Start with a team
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
              disabled={record}
              title={record ? RECORD_REASON : "Add work with files, dependencies and a goal. Work added here can be claimed by one conversation at a time, with its files owned while the claim lives."}
              variant="outline"
              onClick={openAdd}
            >
              <PlusIcon />
              {/* The label goes at the narrowest width and the glyph carries
                  it, which is the one thing a pane header can give up without
                  losing the action. `@container/board` is on the pane. */}
              <span className="hidden @[26rem]/board:inline">New job</span>
            </Button>
            <Segmented label="Board view" value={view} options={[{ value: 'board', label: 'Board', disabled: layout.compact && 'Board needs at least 600px of content width' }, { value: 'list', label: 'List' }]} onChange={setView} />
          </div>
        }
      />
      <ToolPaneBody ref={bodyRef} bleed={view === 'list'} inset="dense" className="[scrollbar-gutter:stable]">
        {notices && (view === 'list' ? <PaneColumn inset="reading" className="flex flex-col gap-2">{notices}</PaneColumn> : notices)}
        {/* The goals on this board, above the work. A Room is permanent and a
            goal is not, so this is the only line that can ever say "finished" —
            and the refusal, when something is still live, is read here rather
            than thrown away, because it is an answer rather than a failure. */}
        {intents.length === 0 ? (
          <PaneColumn inset="reading">
            <EmptyState variant="inline" align="start" title="Nothing on the board yet" />
          </PaneColumn>
        ) : view === 'list' ? (
          <TeamBoardList intents={intents} placed={placed} compact={layout.compact} grouped={layout.compact}
            unplacedTitle={evidenceFailed ? 'Evidence unavailable' : 'Checking current evidence'}
            defaultColumns={new Set<JobColumn>([
              'assignee', 'state', 'updated',
              ...(evidence?.cards.some(one => intents.some(intent => intent.id === one.card) && one.facts.some(fact => fact.record.fact.kind === 'pr')) ? ['pr' as const] : []),
              ...(evidence?.cards.some(one => intents.some(intent => intent.id === one.card) && (one.running.length > 0 || one.facts.some(fact => fact.record.fact.kind === 'check' || fact.record.fact.kind === 'ci'))) ? ['checks' as const] : []),
              ...(evidence?.cards.some(one => intents.some(intent => intent.id === one.card) && one.facts.some(fact => fact.record.fact.kind === 'diff')) ? ['changes' as const] : []),
            ])}
            searchText={intent => {
              const copy = jobCopy(intent, room, snapshot)
              const stranded = strandedFor(intent, now, attached)
              const placement = placed.get(intent.id)
              const reason = stranded !== null ? `stranded ${describeAge(stranded)}`
                : placement?.column === 'needs' ? placement.why : null
              const stateWords = placement ? FACT_COLUMNS.find(one => one.id === placement.column)!.title
                : snapshot.boardEvidenceFailed.has(room) ? 'Evidence unavailable' : 'Checking evidence'
              const outcome = intent.state === 'done' && !reason ? intent.outcome : null
              return [copy.holderName, copy.note, reason, stateWords,
                outcome, ...intent.files,
                ...(evidence?.cards.find(one => one.card === intent.id)?.facts.flatMap(one => one.record.fact.kind === 'pr' ? [`#${one.record.fact.number}`] : []) ?? [])]
            }} renderRow={(intent, columns) => (
            <IntentCard key={intent.id} listGrouped={layout.compact} listColumns={columns} intent={intent} room={room}
              placement={placed.get(intent.id) ?? null} now={now} attached={attached}
              evidence={evidenceForCard(intent, intents, evidence, flowRun, executions)} checks={evidence ?? NO_CHECKS}
              onRunCheck={name => runCheck(intent.id, name)}
              onAssign={goal && !intent.claim && intent.state === 'open' ? () => setAssigning(intent.id) : undefined}
              onOpenHolder={() => openHolder(intent)}
              onAct={(verb, outcome) => verb === 'block' ? setStopping(intent) : act(intent.id, verb, undefined, outcome)} />
          )} />
        ) : (
          <Board ref={boardRef} wrap derived className="items-stretch" data-layout={layout.lanes ? 'lanes' : 'columns'}
            style={{ gridTemplateColumns: layout.lanes
              ? `repeat(2, minmax(${BOARD_COLUMN_MIN_WIDTH}px, 1fr))${layout.folded.includes('ready') ? ` ${BOARD_RAIL_WIDTH}px` : ''}`
              : ['needs', 'working', 'review', 'todo', 'ready'].map(id => layout.folded.includes(id as FactColumn) ? `${BOARD_RAIL_WIDTH}px` : `minmax(${BOARD_COLUMN_MIN_WIDTH}px, 1fr)`).join(' ') }}>
            {['needs', 'working', 'review', 'todo', 'ready', 'aside'].flatMap(id => shown.filter(column => column.id === id)).map((column) => {
              const cards = byColumn.get(column.id) ?? []
              const withoutColumn = new Set(openedColumns)
              withoutColumn.delete(column.id)
              const canFold = openedColumns.has(column.id) && teamBoardLayout(
                paneSize?.width ?? Infinity, paneSize?.contentWidth ?? Infinity, withoutColumn, paneSize?.gap ?? 12,
              ).folded.includes(column.id)
              return (
                <BoardColumn key={column.id} title={column.title} count={cards.length} tint={column.tint}
                  data-column={column.id} collapsed={layout.folded.includes(column.id)}
                  style={column.id === 'aside' ? { gridColumn: '1 / -1' }
                    : layout.lanes && layout.folded.includes(column.id) ? { gridColumn: 3, gridRow: '1 / span 2' } : undefined}
                  onCollapsedChange={layout.folded.includes(column.id) || canFold ? collapsed => setOpenedColumns(previous => {
                    const next = new Set(previous)
                    if (collapsed) next.delete(column.id)
                    else next.add(column.id)
                    return next
                  }) : undefined}>
                  {cards.map((intent) => (
                    <IntentCard
                      key={intent.id}
                      intent={intent}
                      room={room}
                      placement={placed.get(intent.id) ?? null}
                      now={now}
                      attached={attached}
                      evidence={evidenceForCard(intent, intents, evidence, flowRun, executions)}
                      checks={evidence ?? NO_CHECKS}
                      onRunCheck={(name) => runCheck(intent.id, name)}
                      onAssign={goal && !intent.claim && intent.state === 'open' ? () => setAssigning(intent.id) : undefined}
                      onOpenHolder={() => openHolder(intent)}
                      onAct={(verb, outcome) =>
                        verb === 'block' ? setStopping(intent) : act(intent.id, verb, undefined, outcome)
                      }
                    />
                  ))}
                </BoardColumn>
              )
            })}
          </Board>
        )}
      </ToolPaneBody>
      {stopping && (
        <StopWork
          intent={stopping}
          record={record}
          onClose={() => setStopping(null)}
          onStop={(reason) => {
            act(stopping.id, 'block', reason)
            setStopping(null)
          }}
        />
      )}
      {asking && (
        <RunCheck
          unseen={asking.unseen}
          card={asking.card}
          busy={starting}
          record={record}
          onRun={() =>
            runCheck(asking.card, asking.unseen.check.name, {
              seen: asking.unseen.check.run,
              digest: asking.unseen.digest,
            })
          }
          onCancel={() => setAsking(null)}
        />
      )}
      {retryCard && <RetryCheck run={retryCard.run} card={retryCard.card} onClose={() => setRetryCard(null)} />}
      {handing && (
        <HandOut
          room={room}
          intents={intents}
          peers={peers ?? []}
          onClose={() => setHanding(false)}
          onTrouble={setTrouble}
        />
      )}
      {assigning !== null && goal ? (
        <GoalAssign view={goal} card={assigning} onClose={() => setAssigning(null)} />
      ) : null}
      {detailed && (
        <AddWork
          room={room}
          intents={intents}
          peers={peers ?? []}
          onClose={() => setDetailed(false)}
          onTrouble={setTrouble}
        />
      )}
      {startingTeam && emptyGoal && (
        <FrontDoor
          context={{ kind: 'project', root: emptyGoal.goal.root }}
          goal={{ id: emptyGoal.goal.id, revision: emptyGoal.goal.revision }}
          onClose={() => setStartingTeam(false)}
          onStarted={() => {
            // The same Goal, mid-start already — nothing here to navigate to
            // that this pane is not already showing.
            setStartingTeam(false)
          }}
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
  record,
  onClose,
  onStop,
}: {
  intent: Intent
  /** The Team wrapped while this was open — a Run that ends wraps its Team, under whoever is stopping a card (#1317). */
  record: boolean
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
          <Button variant="default" disabled={record} title={record ? RECORD_REASON : undefined} onClick={() => onStop(reason)}>
            Stop it
          </Button>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
        </>
      }
    >
      <p>
        “{intent.title}” goes to Blocked. Any claim on it is released, and a finished dependency
        will not start it again — only a deliberate reopen will.
      </p>
      {/* Allowed through empty, and told what that costs. Refusing would put
          a modal between a person and a board they are allowed to change;
          saying nothing about it would produce the silent card this field
          exists to prevent. */}
      <Field
        label="Why it is stopped"
        optional
        hint={reason.trim()
          ? 'The card will say this, and so will the room.'
          : 'Without a reason the card says only that you stopped it.'}
      >
        {(control) => (
          <Input
            {...control}
            autoFocus
            value={reason}
            placeholder="Waiting on the rename"
            onChange={(event) => setReason(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !record) onStop(reason)
            }}
          />
        )}
      </Field>
      {record && <Note>{RECORD_REASON}</Note>}
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
import { seatCeilingOf } from '../lib/ceilings'
import { CeilingChip } from './CeilingChip'

const IntentCard = ({
  listColumns,
  listGrouped = false,
  intent,
  room,
  placement,
  now,
  attached,
  evidence,
  checks,
  onRunCheck,
  onAssign,
  onOpenHolder,
  onAct,
}: {
  listGrouped?: boolean
  listColumns?: ReadonlySet<JobColumn>
  intent: Intent
  room: string
  placement: Placement | null
  /** The pane's clock, so a lease runs out on screen and not only on re-render. */
  now: number
  /** The host's peer list, as a predicate. `null` until it has answered. */
  attached: null | ((claim: { runtime: string; sessionId: string }) => boolean)
  /** What the desk observed on this card; undefined when nothing. */
  evidence: CardEvidence | undefined
  /** The checks the room's project names: to run, refused, or none readable. */
  checks: BoardChecks
  onRunCheck: (name: string) => void
  onAssign?: () => void
  onOpenHolder: () => void
  /** `outcome` is what the person answered, on a card a flow addressed to them. */
  onAct: (verb: Verb, outcome?: string) => void
}) => {
  const store = useStore()
  const snapshot = useSnapshot()
  const [reviewDialog, setReviewDialog] = useState<'review' | 'answer' | null>(null)

  /* The role this card was addressed to, as the running flow defines it.
     A room with no flow has no entry here at all, which is every room that
     existed before flows — and then every branch below falls through to what
     the card has always drawn. */
  const role = useMemo(
    () =>
      flowStepOf(
        intent,
        (snapshot.flowRuns.get(room) ?? []).find(
          (one) => one.state === 'running' || one.state === 'stalled',
        ),
        [...snapshot.flowExecutions.values()].filter((one) => one.goal === room),
      ),
    [intent, room, snapshot.flowRuns, snapshot.flowExecutions],
  )

  const checkOperation = role?.kind === 'check' && role.run
    ? snapshot.flowExecutions.get(role.run)?.operations.find((one) => one.kind === 'check' && one.card === intent.id)
    : null
  const canRetryCheck = checkOperation?.state === 'finished' || checkOperation?.state === 'uncertain'

  const openReviewDialog = (): void => { if (role?.review && role.run) setReviewDialog('review') }
  const openAnswerDialog = (): void => { if (role && !record) setReviewDialog('answer') }

  const { assignee: observedAssignee, holderName, note } = jobCopy(intent, room, snapshot)
  const assignee = intent.claim ?? (listColumns ? observedAssignee : null)
  const record = isRecord(snapshot.goals.get(room))
  const runtime = assignee
    ? (snapshot.runtimes.find((one) => one.id === assignee?.runtime) ?? null)
    : null
  const session = assignee
    ? snapshot.sessions.get(sessionKey(assignee.runtime, assignee.sessionId as SessionId))
    : null
  const stranded = strandedFor(intent, now, attached)
  /* The holder's own ring, so the face on a card and the row in the rail are
     visibly the same account — see lib/accounts.ts on what the ring is for. */
  const holderTint = assignee
    ? runtimeTint(assignee.runtime, snapshot.accountsByRuntime, snapshot.accountPrefs)
    : 'blue'
  const holderCeiling = intent.claim
    ? seatCeilingOf(session?.settings, snapshot.flowRuns.get(room) ?? [], intent.claim.runtime, intent.claim.sessionId)
    : null

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
    review?: true
  }[] = [
    /* A card a flow addressed to *the person* is a step, not an absence: the
       round opened, the loop is waiting, and what they answer is what the next
       rule branches on. So the menu offers the words the role declared rather
       than "Mark done", which would finish the card and leave the run with
       nothing to read. A person role that declares no outcomes at all — UC1's
       own referee (`kind: person`, no `outcomes:`) is exactly this shape —
       has nothing to "Answer", but the person still needs a way to finish the
       card, so this falls back to "Mark done" rather than leaving the menu
       with no finishing verb at all. */
    ...(role?.kind === 'person' && role.review && role.outcomes.length > 0 && intent.state !== 'done' && intent.state !== 'abandoned'
      ? [{ verb: 'done' as const, label: 'Pick an attempt…', review: true as const }]
      : role?.kind === 'person' && role.outcomes.length > 0 && intent.state !== 'done' && intent.state !== 'abandoned'
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
    ...(role?.kind === 'check'
      ? canRetryCheck ? [{ verb: 'reopen' as const, label: 'Run this check again…' }] : []
      : intent.state === 'done' || intent.state === 'abandoned' || intent.state === 'blocked'
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

  const busy = evidence?.running[0]?.name ?? null
  const checkItems: readonly {
    readonly key: string
    readonly label: string
    readonly why: string | null
  }[] =
    intent.state === 'abandoned'
      ? []
      : [
          ...checks.checks.map((name) => ({
            key: name,
            label: `Run ${name}`,
            why:
              busy === null
                ? null
                : `${busy} is running on this card, and one check runs on a card at a time`,
          })),
          ...checks.refused.map((one) => ({
            key: one.name,
            label: `Run ${one.name}`,
            why: `${CHECKS_FILE_WORDS} refuses it; the project's page says why`,
          })),
          ...(checks.unreadable
            ? [{ key: '', label: 'Run a check', why: `${CHECKS_FILE_WORDS} cannot be read` }]
            : []),
        ]

  const primary = intent.state === 'done' || intent.state === 'abandoned' || (intent.state === 'blocked' && intent.blockedBy === 'hand')
    ? verbs.find(one => one.verb === 'reopen')
    : intent.state !== 'claimed' && role?.kind === 'person' && role.outcomes.length > 0
      ? role.review ? verbs.find(one => one.review) : { label: 'Answer…', answer: true as const }
      : undefined
  const menuVerbs = verbs.filter(one => !listColumns || record || one !== primary)
  const actions = (
        menuVerbs.length > 0 || checkItems.length > 0 || onAssign ? (
          <Popover label={<MoreIcon size={14} />} title={`What to do with #${intent.id}`} align="right">
            {(close) => (
              <Menu close={close}>
                {onAssign ? <MenuItem label="Give this to…" disabled={record ? RECORD_REASON : false} onSelect={onAssign} /> : null}
                {onAssign && (checkItems.length > 0 || verbs.length > 0) ? <MenuSeparator /> : null}
                {checkItems.map((one) => (
                  <MenuItem
                    key={`check:${one.key}`}
                    label={one.label}
                    disabled={record ? RECORD_REASON : one.why ?? false}
                    onSelect={() => onRunCheck(one.key)}
                  />
                ))}
                {checkItems.length > 0 && menuVerbs.length > 0 && <MenuSeparator />}
                {menuVerbs.map((one) => (
                  <MenuItem
                    key={one.outcome ? `${one.verb}:${one.outcome}` : one.verb}
                    label={one.label}
                    disabled={record ? RECORD_REASON : false}
                    danger={one.danger}
                    onSelect={() => one.review ? void openReviewDialog() : onAct(one.verb, one.outcome)}
                  />
                ))}
              </Menu>
            )}
          </Popover>
        ) : undefined
  )
  const latest = (kind: 'pr' | 'diff') => [...evidence?.facts ?? []]
    .filter(one => one.record.fact.kind === kind).sort((a, b) => b.record.observedAt - a.record.observedAt)[0]
  const pr = latest('pr')
  const diff = latest('diff')
  const checkFacts = [...evidence?.facts ?? []].filter(one => one.record.fact.kind === 'check' || one.record.fact.kind === 'ci')
  // The host normally folds facts; retain only the newest observation of each check here too.
  const latestChecks = new Map<string, typeof checkFacts[number]>()
  for (const one of [...checkFacts].sort((a, b) => a.record.observedAt - b.record.observedAt)) {
    const fact = one.record.fact
    latestChecks.set(fact.kind === 'check' ? `check:${fact.name}` : fact.kind, one)
  }
  const checksNow = [...latestChecks.values()]
  const checkWords = evidence?.running.length ? 'Running'
    : checksNow.length === 0 ? '—'
    : checksNow.some(one => !isCurrent(one.freshness)) ? 'Stale or unknown'
    : checksNow.some(one => chipOf(one).outcome === 'failed' || chipOf(one).outcome === 'timed out') ? 'Failed'
    : checksNow.some(one => one.record.fact.kind === 'ci' && ciVerdict(one.record.fact.checks) === 'running') ? 'Running'
    : checksNow.every(one => chipOf(one).outcome === 'passed') ? 'Passed' : 'Not passed'
  const stateWords = placement ? FACT_COLUMNS.find(one => one.id === placement.column)!.title
    : snapshot.boardEvidenceFailed.has(room) ? 'Evidence unavailable' : 'Checking evidence'
  const reason = stranded !== null ? `stranded ${describeAge(stranded)}`
    : placement?.column === 'needs' ? placement.why : null
  const visibleOutcome = intent.state === 'done' && !reason ? intent.outcome : null
  const brand = runtime ? brandForRuntime(runtime) : null
  const face = assignee ? <IconTile shape="face" tint={holderTint}>
    {brand ? <BrandMark brand={brand} size={16} /> : <AgentIcon size={16} />}
  </IconTile> : <IconTile shape="face" empty />

  return (
    <>
    {listColumns ? (
      <TableRow interactive className="group/job" data-job={intent.id}>
        <TableCell className="whitespace-normal min-w-0 max-w-0">
          <span className="flex min-w-0 flex-wrap items-center gap-2"><Text role="meta">#{intent.id}</Text><Text role="row" className="min-w-0 break-words [overflow-wrap:anywhere]" title={intent.title}>{intent.title}</Text>{intent.role && <Chip tone="neutral">{intent.role}</Chip>}</span>
          {note && <Text role="meta" className="whitespace-normal line-clamp-2 break-words [overflow-wrap:anywhere]" title={note}>{note}</Text>}
          {intent.files.length > 0 && <Text role="meta" className="block min-w-0 truncate" title={`Owns ${intent.files.join(', ')} while claimed`}>{intent.files.join(', ')}</Text>}
          {listColumns.has('assignee') && <span className="@[720px]/board:hidden"><Text role="meta" className="block truncate" title={holderName}>Assignee · {holderName}</Text></span>}
          {listGrouped && (reason || visibleOutcome) && <Text role="meta" className="block whitespace-normal break-words">{reason ?? visibleOutcome}</Text>}
          {listColumns.has('state') && <span className="@[520px]/board:hidden"><Text role="meta">{stateWords}{reason ? ` · ${reason}` : visibleOutcome ? ` · ${visibleOutcome}` : ''}</Text></span>}
        </TableCell>
        {listColumns.has('assignee') && <TableCell className={`${JOB_COLUMN_CLASS.assignee} w-40 max-w-40`}>
          {assignee ? <Button variant="ghost" size="inline" onClick={() => void store.openSession(assignee.sessionId as SessionId, { runtime: assignee.runtime })} title={`Open ${holderName}'s conversation`} className="max-w-full gap-2">{face}<span className="min-w-0 truncate" title={holderName}>{holderName}</span></Button>
            : <span className="inline-flex max-w-full items-center gap-2">{holderName !== '—' && face}<Text role="meta" className="min-w-0 truncate" title={holderName}>{holderName}</Text></span>}
        </TableCell>}
        {listColumns.has('state') && <TableCell className={`${JOB_COLUMN_CLASS.state} whitespace-normal`}>
          <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
            <Chip tone={placement?.column === 'needs' ? 'warning' : placement?.column === 'ready' ? 'success' : 'neutral'}>{stateWords}</Chip>
            {visibleOutcome && <Chip tone="neutral">{visibleOutcome}</Chip>}
          </span>
          {reason && <Text role="meta" className="block whitespace-normal break-words" title={reason}>{reason}</Text>}
        </TableCell>}
        {listColumns.has('pr') && <TableCell className={JOB_COLUMN_CLASS.pr}>
          {pr?.record.fact.kind === 'pr' ? <Button variant="link" size="inline" disabled={!pr.record.fact.url} title={standingWords(pr.freshness)} onClick={() => pr.record.fact.kind === 'pr' && pr.record.fact.url && openExternal(pr.record.fact.url)}>
            #{pr.record.fact.number}{!isCurrent(pr.freshness) && ' · stale or unknown'}
          </Button> : <Text role="meta">—</Text>}
        </TableCell>}
        {listColumns.has('checks') && <TableCell className={JOB_COLUMN_CLASS.checks}><span className="inline-flex items-center gap-1.5" title={checksNow.map(one => `${chipOf(one).label}: ${standingWords(one.freshness)}`).join(' · ')}>
          {checkWords !== '—' && <Dot tone={checkWords === 'Passed' ? 'success' : checkWords === 'Failed' ? 'danger' : 'neutral'} />}<Text role="meta">{checkWords}</Text>
        </span></TableCell>}
        {listColumns.has('changes') && <TableCell numeric className={JOB_COLUMN_CLASS.changes}>
          {diff?.record.fact.kind === 'diff' ? <span title={standingWords(diff.freshness)}><ChangeStats added={diff.record.fact.added} removed={diff.record.fact.removed} />{!isCurrent(diff.freshness) && <Text role="meta"> · stale or unknown</Text>}</span> : <Text role="meta">—</Text>}
        </TableCell>}
        {listColumns.has('updated') && <TableCell numeric className={JOB_COLUMN_CLASS.updated}><Text role="meta" numeric title={new Date(intent.updatedAt).toLocaleString()}>{describeAge(now - intent.updatedAt)}</Text></TableCell>}
        <TableCell className="w-px">
          {primary && !record && <Button variant="outline" size="sm" onClick={() => 'answer' in primary ? openAnswerDialog() : primary.review ? void openReviewDialog() : onAct(primary.verb, primary.outcome)}>{primary.label}</Button>}
        </TableCell>
        <TableCell align="end" className="w-px">
          <span className="opacity-0 group-hover/job:opacity-100 group-focus-within/job:opacity-100 has-[[aria-expanded=true]]:opacity-100">{actions}</span>
        </TableCell>
      </TableRow>
    ) : <BoardCard
      title={
        <>
          <Text role="meta">#{intent.id}</Text>{' '}
          {intent.title}
        </>
      }
      note={note}
      cover={
        intent.claim ? (
          <Button variant="subtle" size="row"
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
            className="flex w-full items-center gap-1.5 text-left"
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
              <IconTile size="sm" shape="face" tint={holderTint}>
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
              {/* The card's key fact — who holds it — in a row's name role,
                  the weight a name on a row is set in. */}
              <Text role="row" truncate className="min-w-0 flex-1 basis-1/2">
                {holderName}
              </Text>
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
                <Text
                  role="meta"
                  align="end"
                  truncate
                  className="hidden min-w-0 flex-1 basis-1/2 @[13rem]/board-column:inline"
                >
                  {session.title}
                </Text>
              )}
              {holderCeiling && <CeilingChip ceiling={holderCeiling.ceiling} note={holderCeiling.note} />}
            </SessionHoverCard>
          </Button>
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
      priority={
        stranded !== null
          ? { label: `stranded ${describeAge(stranded)}`, tone: 'warning' }
          : placement?.column === 'needs' && placement.why
            ? { label: placement.why, tone: 'warning' }
            : intent.outcome
              ? { label: intent.outcome, tone: 'neutral' as const }
              : undefined
      }
      meta={
        <span className="flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1 whitespace-nowrap">
          <EvidenceChips id={intent.id} title={intent.title} card={evidence} finished={intent.state === 'done'} />
          {/* How long since anything happened to it. The number a person is
              actually after on a board is "how long has that been sitting
              there", and until now the card could not answer it at all. */}
          <span
            className="inline-flex items-center gap-1"
            title={`Last changed ${new Date(intent.updatedAt).toLocaleString()}`}
          >
            <ClockIcon size={14} />
            <Text role="meta" numeric>{describeAge(now - intent.updatedAt)}</Text>
          </span>
          {intent.role && intent.files.length > 0 && (
            <span
              className="inline-flex min-w-0 items-center gap-1"
              title={`Owns ${intent.files.join(', ')} while claimed`}
            >
              <span className="truncate">{intent.files.join(', ')}</span>
            </span>
          )}
          {intent.dependsOn.length > 0 && (
            <span
              className="inline-flex items-center gap-1"
              title={`Waits for ${intent.dependsOn.map((one) => `#${one}`).join(', ')}`}
            >
              <BranchIcon size={14} />
              <Text role="meta" numeric>{intent.dependsOn.length}</Text>
            </span>
          )}
          {/* A finished job that left a context package says so, because the
              package is the whole point of finishing one here: it is what the
              next agent reads instead of asking. */}
          {intent.handoff && (
            <span
              className="inline-flex items-center gap-1"
              title={intent.handoff}
            >
              <HandoffIcon size={14} />
              <span>handoff</span>
            </span>
          )}
        </span>
      }
      actions={actions}
    />}
    {reviewDialog && role && <PersonStepDialog room={room} intent={intent} role={role} mode={reviewDialog} onClose={() => setReviewDialog(null)} />}
    </>
  )
}
