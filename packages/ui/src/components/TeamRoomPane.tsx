import { InfoCard, SubjectActionsMenu } from '../design'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react'

import {
  flowStepOf,
  currentTurn,
  isBusy,
  sessionKey,
  splitSessionKey,
  type FlowExecution,
  type Intent,
  type ModelInfo,
  type InsightReport,
  type TeamActor,
  type TeamEntry,
  type TeamInbound,
  type RuntimeId,
  type SessionId,
  type SessionKey,
  type TeamPeerInfo,
  type TriggerBudgetState,
  type TriggerGoalStatus,
} from '@harnessdesk/protocol'

import { raceRoleId } from '../lib/flows'
import { runtimeTint, type Tint } from '../lib/accounts'
import { brandForRuntime } from '../lib/brands'
import { elapsedSince } from '../lib/clock'
import { goalRunOf, namedGoalRun } from '../lib/goal-run'
import { teamSeats, hasConversation, seatDisplayName } from '../lib/team-seats'
import { isRecord, RECORD_REASON } from '../lib/team-record'
import { teamOverviewOf } from '@harnessdesk/client/views'
import { clientSnapshot } from '../lib/client-snapshot'
import { runReasonWords } from '../lib/run-reason'
import { runSeatCosts } from '../lib/run-cost'
import { TeamOverview } from './TeamOverview'
import { TeamRunView } from './TeamRunView'
import { TeamRuns, teamTriggerLabel, useTeamTrigger } from './TeamRuns'
import { StopRunDialog, StopRunFailure } from './StopRunDialog'
import { useCheckAttempts } from '../state/check-attempts'
import { runTimelineOf } from '@harnessdesk/client/views'
import { runPullRequest } from '../lib/run-timeline'
import { shortSha } from '../lib/evidence'
import { goalActions, goalName } from '../lib/goals'
import { openExternal } from '../lib/desktop'
import { canPlace, forgetMissing, fromStored, MAX_TILES, placeTile, removeTile, wouldReplace as modelWouldReplace, type SideBySideState } from '../lib/side-by-side'
import { budgetMeterWords, formatMeterUsd, intakeStopWords, openTriggerWaits, originHoverWords, originSubject } from '../lib/intake'
import { isPathInside } from '../lib/paths'
import { PaneProvider, usePane, useSnapshot, useStore } from '../state/context'
import { useNeedsYouAnswers } from '../state/needs-you'
import type { AppSnapshot } from '../state/snapshot'
import { sidebarPlacement } from '../state/workbench'
import { useMount } from '../panels/mount'
import { useTopBar, useTopBarView, useWorkDetails } from '../panels/top-bar'
import { RunDetailsView } from '../panels/run-dock'
import { TEAM_FRAME_PAGES, type TeamFramePage } from '../state/layout'
import { TeamRunFacts } from './TeamRunFacts'
import { RunFlowFile } from './RunFlow'
import { teamSeatCost } from '../lib/team-overview'
import { seatCeilingWords } from '../lib/agents'
import type { RunTimelineInput } from '../lib/run-timeline'
import { WorkTools } from '../panels/WorkTools'
import { BrandMark } from './BrandIcons'
import {
  AgentIcon,
  CommentIcon,
  ClockIcon,
  SideBySideIcon,
  CrossIcon,
  ExpandIcon,
  IssueIcon,
  MessageOffIcon,
  MoreIcon,
  PlusIcon,
  PullRequestIcon,
  ShieldOffIcon,
} from './Icons'
import { AddMember } from './AddMember'
import { MemberHoverCard, SeatFace, type SeatFaceIdentity, type MemberCardFacts } from './AgentCards'
import { Approvals } from './Approvals'
import { Conversation } from './Conversation'
import { SideBySide, sideBySideTileEntry } from './SideBySide'
import { ComparisonVerdict } from './ComparisonVerdict'
import { ComparisonActions } from './ComparisonActions'
import { ComparisonSummary, ChangeStats, Row, Rows } from '../design'
import { comparisonMergeOf, type ComparisonMergeReceipt } from '../lib/comparison-merge'
import { sanitizeText } from '../lib/sanitize'
import { PersonStepDialog } from './PersonStepDialog'
import { comparisonVerdictOf } from '../lib/comparison-verdict'
import { ChannelStream, readChannel } from './Channel'
import { EMPTY_ROOM_DRAFT, RoomComposer, type RoomComposerDraft, type RoomComposerDraftState, type RoomComposerHandle } from './RoomComposer'
import { TeamBoardPane } from './TeamBoardPane'
import { RoomMessagesHeld } from './RoomMessaging'
import { formatDuration } from './TurnTail'
import { GoalFindings } from './GoalFindings'
import { GoalHeader } from './GoalHeader'
import { GoalWrap } from './GoalWrap'
import { GoalReceipt } from './GoalReceipt'
import { GoalReceiptCost } from './GoalReceiptCost'
import { FindingCarry } from './FindingCarry'
import { FindingDetail } from './FindingDetail'
import { FlowRunStatus } from './FlowRunStatus'
import { RetryCheck } from './RetryCheck'
import { RunAgain } from './RunAgain'
import { WindowControls } from './WindowControls'
import {
  SeatList,
  ToolBody,
  ToolSection,
  PanelFilter,
  type SeatListRow,
  type TopBarTab,
  ActionError,
  Bar,
  Button,
  Chip,
  ComposerDock,
  Dot,
  EmptyState,
  IconTile,
  MemberName,
  Menu,
  MenuItem,
  MenuToggle,
  Note,
  PaneColumn,
  PaneSurface,
  Popover,
  ProgressRing,
  Text,
  ToolPaneNotice,
  TurnWorkLive,
  type Tone,
} from '../design'
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
const isFramePage = (value: string): value is TeamFramePage => TEAM_FRAME_PAGES.some(one => one === value)

const AT_THE_FLOOR = { rows: 0, onlyMessages: true } as const

/**
 * A Team has one content column. Section tabs choose the page; the bar's
 * layout toggle shows Seat conversations side by side. Membership controls
 * live in persistent Details, alongside the unchanged sidebar's Seats.
 */

/** Every Team destination shares one measured title, tabs and tools row. */
export const TeamRoomPane = ({
  room,
  onChooseProject = () => undefined,
  onSignIn = () => undefined,
  onOpenUsage = () => undefined,
  onOpenRuntimes = () => undefined,
}: {
  room: string
  /* The shell's four actions, threaded from `Panes` so the conversation
     embedded below is the same conversation everywhere else — including the
     controls that leave it. Defaulted so a mock or a preview can mount the
     room without inventing a shell. */
  onChooseProject?: () => void
  onSignIn?: (runtime?: RuntimeId) => void
  onOpenUsage?: (runtime: RuntimeId) => void
  onOpenRuntimes?: () => void
}) => {
  const store = useStore()
  const snapshot = useSnapshot()
  const mainOwner = usePane()?.paneId ?? ''
  const chatComposer = useRef<RoomComposerHandle>(null)
  const [addressedSeat, setAddressedSeat] = useState<SessionKey | null>(null)
  const goal = snapshot.goals.get(room)
  const record = isRecord(goal)
  const [stoppingRun, setStoppingRun] = useState<string | null>(null)
  const stoppingExecution = stoppingRun ? snapshot.flowExecutions.get(stoppingRun) : null
  // Only the open Seats recorded by this Run: a Team can also hold another Run's Seats.
  const stopSeatIds = new Set(stoppingExecution?.rounds.flatMap(round => round.seats) ?? [])
  const stopSeatNames = new Map(stoppingExecution ? teamSeats(goal, snapshot.teams.get(room), stoppingExecution, 'seat').map(seat => [seat.record.id, seat.name]) : [])
  const stopSeats = (goal?.members ?? []).filter(seat => !seat.closed && stopSeatIds.has(seat.id)).map(seat => ({
    id: seat.id,
    name: stopSeatNames.get(seat.id) ?? 'Agent',
    interrupt: snapshot.runtimes.find(runtime => runtime.id === seat.session.runtime)?.capabilities.interrupt,
  }))
  /** Shared by Overview's Wrap button and the More menu. */
  const wrapDisabled = goal ? goalActions(goal.goal).disabled || goal.problem !== null : true
  /**
   * The run this Goal names for itself — its reservation, else the flow that
   * opened it — asked for below when this window has not cached it yet; and
   * the run the header reads, by the one rule the Findings pane reads too
   * (`lib/goal-run.ts`): reserved, then going on now, then the opener. A
   * Goal's id is reused across incarnations, so an older stopped run merely
   * sharing it never stands in for a run this Goal names and has not loaded.
   */
  const run = namedGoalRun(goal)
  const flowExecution = useMemo(
    () => goalRunOf(room, goal, snapshot.flowExecutions),
    [snapshot.flowExecutions, room, goal],
  )
  // A reopened room whose run predates this window's own pushes has nothing
  // cached yet: read it once, the same pull `flow/execution-changed` is the
  // push half of.
  useEffect(() => {
    if (!run || snapshot.flowExecutions.has(run)) return
    void store.readFlowExecution(run).catch(() => {})
  }, [snapshot.flowExecutions, run, store])
  /**
   * A trigger Goal's own status — its origin, and its live budget — read
   * once per Goal and polled while it is open, since both change under a
   * running trigger: a poll's spend, a round closing, a clock ticking down.
   * The origin chip and the composer's own meter both read this; neither
   * asks Intake a second time.
   */
  const triggerKind = goal?.goal.origin.kind === 'trigger'
  const triggerControl = useTeamTrigger(goal?.goal.root ?? '', goal?.goal.origin.kind === 'trigger' ? goal.goal.origin.trigger : null)
  const goalId = goal?.goal.id ?? null
  const [triggerStatus, setTriggerStatus] = useState<TriggerGoalStatus | null>(null)
  /**
   * The live half of the refresh below: `trigger/attention` pushes every wait
   * this window is told about into `snapshot.triggerAttention` the moment it
   * opens or clears, so a signal of this Goal's own entries — not the whole
   * map, which moves for every Goal's waits — re-asks right away rather than
   * leaving a new or cleared wait to wait out the slow poll below it.
   */
  const attentionSignal = useMemo(
    () =>
      Object.values(snapshot.triggerAttention)
        .filter((one) => one.goal === goalId)
        .map((one) => `${one.id}:${one.resolvedAt ?? ''}`)
        .sort()
        .join('|'),
    [snapshot.triggerAttention, goalId],
  )
  useEffect(() => {
    if (!goalId || !triggerKind) { setTriggerStatus(null); return }
    let live = true
    const read = (): void => {
      store.triggerGoal(goalId).then(
        (status) => { if (live) setTriggerStatus(status) },
        () => { if (live) setTriggerStatus(null) },
      )
    }
    read()
    // A budget's spend and its clock move on their own, between board
    // mutations that would otherwise be the only thing that re-asks. Once a
    // minute is enough to keep the composer's meter honest without asking
    // the host on every render of a ticking second hand — the wait itself
    // does not wait on this: `attentionSignal` above re-runs this effect,
    // and so this same `read`, the moment a wait opens or clears.
    const timer = window.setInterval(read, 60_000)
    return () => { live = false; window.clearInterval(timer) }
    // Keyed on the Goal's own id, not the `GoalView` object: that object is a
    // fresh reference on every board mutation — a chat post, a claim signal,
    // anything — and refetching this on every one of them asked the host the
    // same question dozens of times a minute for a status that changes rarely.
  }, [store, goalId, triggerKind, attentionSignal])
  const originStatus = triggerStatus && triggerStatus.goal === goalId ? triggerStatus : null
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
  /* Two facts on the roster also travel with the room's state, and so reach
     every view of the room the moment they change: what a member is called
     here, and what it does with a message. Read from the push, a name or a
     mode set in another pane, window or client is drawn here too. The roster
     alone is a pull, and kept the old one until something unrelated made it
     ask again. */
  const pushed = snapshot.teams.get(room)
  const peers = useMemo(() => {
    if (!fetched || fetched.room !== room) return null
    return fetched.peers.map((one) => {
      const key = sessionKey(one.runtime, one.sessionId as SessionId)
      const nickname = pushed?.nicknames?.[key] ?? one.nickname
      const inbound = pushed?.inbound?.[key] ?? one.inbound
      return nickname === one.nickname && inbound === one.inbound ? one : { ...one, nickname, inbound }
    })
  }, [fetched, room, pushed?.nicknames, pushed?.inbound])
  const [grid, setGrid] = useState<SideBySideState>(() => fromStored(
    mount?.view.kind === 'room' ? mount.view.sideBySide : undefined,
    mount?.view.kind === 'room' ? mount.view.watching : undefined,
  ))
  // The words and audience belong to the room, through Chat, grid and expand.
  const [drafts, setDrafts] = useState<Readonly<Record<string, RoomComposerDraft>>>({})
  const changeDraft = useCallback<RoomComposerDraftState['onChange']>((next) => {
    setDrafts((current) => ({
      ...current,
      [room]: typeof next === 'function' ? next(current[room] ?? EMPTY_ROOM_DRAFT) : next,
    }))
  }, [room])
  const roomDraft: RoomComposerDraftState = { value: drafts[room] ?? EMPTY_ROOM_DRAFT, onChange: changeDraft }
  const [composerTroubles, setComposerTroubles] = useState<Readonly<Record<string, string | null>>>({})
  const composerTrouble = composerTroubles[room] ?? null
  const setComposerTrouble = useCallback((message: string | null) => {
    setComposerTroubles(current => ({ ...current, [room]: message }))
  }, [room])
  /* A wrapped Team opens on its Receipt, with or without a Run: the record is
     what the person came for, and the page tabs are the way around it. */
  const opensOnReceipt = record && Boolean(goal?.receipt)
  const opensOnAttempts = !record && flowExecution?.document.format === 'agents' && raceRoleId(flowExecution.document.flow) !== null
  const [open, setOpen] = useState<TeamFramePage | 'side-by-side' | SessionKey>(
    () => mount?.view.kind === 'room' && mount.view.chatMember ? mount.view.chatMember
      : mount?.view.kind === 'room' && mount.view.framePage ? mount.view.framePage === 'room' && (mount.view.chatLayout === 'side-by-side' || mount.view.chatLayout === undefined && grid.tiles.length > 0) ? 'side-by-side' : mount.view.framePage
        : opensOnReceipt ? 'receipt' : grid.tiles.length > 0 || opensOnAttempts ? 'side-by-side' : flowExecution || goal?.activity === 'ready-to-wrap' ? 'overview' : 'room',
  )
  const chatLayout = useRef(mount?.view.kind === 'room' && mount.view.chatLayout ? mount.view.chatLayout : grid.tiles.length > 0 ? 'side-by-side' : 'thread')
  const selectedPage = useRef<TeamFramePage>(mount?.view.kind === 'room' && mount.view.framePage ? mount.view.framePage : opensOnReceipt ? 'receipt' : flowExecution || goal?.activity === 'ready-to-wrap' ? 'overview' : 'room')
  const destination = useRef({ room, chosen: mount?.view.kind === 'room' && mount.view.framePage !== undefined })
  const changeGrid = useCallback((next: Parameters<typeof setGrid>[0]) => {
    destination.current.chosen = true
    store.setTeamFramePage(room, 'room', 'side-by-side')
    setGrid(next)
  }, [store, room])
  const roomView = mount?.view.kind === 'room' ? mount.view : undefined
  useEffect(() => {
    if (destination.current.room !== room) {
      const restored = mount?.view.kind === 'room' ? mount.view.framePage : undefined
      destination.current = { room, chosen: restored !== undefined }
      chatLayout.current = mount?.view.kind === 'room' && mount.view.chatLayout ? mount.view.chatLayout : grid.tiles.length > 0 ? 'side-by-side' : 'thread'
      if (restored) {
        selectedPage.current = restored
        const chat = mount?.view.kind === 'room' ? mount.view.chatLayout : undefined
        setOpen(restored === 'room' && (chat === 'side-by-side' || chat === undefined && grid.tiles.length > 0) ? 'side-by-side' : restored)
        return
      }
    }
    // Runs are loaded after the Team opens. Apply its default only until the
    // person chooses a destination; a push must not take them away from Chat.
    if (destination.current.chosen || grid.tiles.length > 0) return
    const next = opensOnReceipt ? 'receipt' : opensOnAttempts ? 'side-by-side' : flowExecution || goal?.activity === 'ready-to-wrap' ? 'overview' : 'room'
    selectedPage.current = next === 'side-by-side' ? 'room' : next
    setOpen(next)
  }, [room, flowExecution?.id, record, opensOnAttempts])
  useEffect(() => {
    if (!roomView || roomView.room !== room) return
    chatLayout.current = roomView.chatLayout ?? (grid.tiles.length > 0 ? 'side-by-side' : 'thread')
    if (roomView.chatMember) {
      destination.current = { room, chosen: true }
      selectedPage.current = 'room'
      setOpen(roomView.chatMember)
      return
    }
    if (roomView.framePage) {
      destination.current = { room, chosen: true }
      selectedPage.current = roomView.framePage
      setOpen(roomView.framePage === 'room' && (roomView.chatLayout === 'side-by-side' || roomView.chatLayout === undefined && grid.tiles.length > 0)
        ? 'side-by-side' : roomView.framePage)
      return
    }
    destination.current = { room, chosen: false }
    const next = opensOnReceipt ? 'receipt' : grid.tiles.length > 0 || opensOnAttempts ? 'side-by-side' : flowExecution || goal?.activity === 'ready-to-wrap' ? 'overview' : 'room'
    selectedPage.current = next === 'side-by-side' ? 'room' : next
    setOpen(next)
  }, [room, roomView?.room, roomView?.chatMember, roomView?.framePage, roomView?.chatLayout,
    roomView?.framePage === 'room' ? grid.tiles.length : 0])
  const [chosenRun, setChosenRun] = useState<string | null>(null)
  const [again, setAgain] = useState<FlowExecution | null>(null)
  const [retryCheck, setRetryCheck] = useState<{ run: string; card: number } | null>(null)
  useEffect(() => { setAgain(null); setRetryCheck(null); setChosenRun(null); setAddressedSeat(null) }, [room])
  const [selectedRunRows, setSelectedRunRows] = useState<ReadonlyMap<string, string>>(new Map())
  const runs = useMemo(() => [...snapshot.flowExecutions.values()].filter(one => one.goal === room)
    .sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0)), [snapshot.flowExecutions, room])
  const [runsReviewProblem, setRunsReviewProblem] = useState<{ room: string; text: string } | null>(null)
  useEffect(() => {
    if (open === 'run' && chosenRun === null) setRunsReviewProblem(null)
  }, [open, room, chosenRun])
  const onRunReviewVisibility = useCallback((run: string, visible: boolean) => {
    if (!visible) {
      store.releaseVisibleFindingRun(room, run)
      return
    }
    void store.loadVisibleFindingRun(room, run).catch(() => {
      setRunsReviewProblem({ room, text: 'Some reviewer results could not be read.' })
    })
  }, [store, room])
  const timelineRun = runs.find(one => one.id === chosenRun) ?? flowExecution
  const timelineCards = timelineRun?.rounds.flatMap(one => one.cards).join(',') ?? ''
  const [timelinePending, setTimelinePending] = useState(false)
  const [timelineReadError, setTimelineReadError] = useState<string | null>(null)
  const [timelineRead, setTimelineRead] = useState(0)
  // What each check of the Run recorded each time it ran: read while the Run is on show, and again when a result lands.
  const detailsVisible = snapshot.workbench.frameTools[`team:${room}`]?.open === true && snapshot.workbench.frameTools[`team:${room}`]?.tool === 'details'
  const readingRun = open === 'run' || detailsVisible
  const checkAttempts = useCheckAttempts({ execution: timelineRun ?? undefined, evidence: snapshot.boardEvidence.get(room), active: readingRun, nonce: timelineRead })
  const [runHistoryProblem, setRunHistoryProblem] = useState<{ room: string; message: string } | null>(null)
  useEffect(() => {
    // A trigger Goal names no opener Run. Discover its history even when
    // this window has not received any execution pushes yet.
    if (!goalId && !run && !flowExecution) return
    let live = true
    setRunHistoryProblem(null)
    void store.loadTeamRuns(room).catch((error: unknown) => {
      if (live) setRunHistoryProblem({ room, message: `Run history is unavailable: ${error instanceof Error ? error.message : String(error)}` })
    })
    return () => { live = false }
  }, [store, room, goalId, run, flowExecution?.id, timelineRead])
  useEffect(() => {
    if (!readingRun || !timelineRun) return
    let live = true
    setTimelinePending(true)
    setTimelineReadError(null)
    const read = async (): Promise<void> => {
      await store.loadFindings(room, 'all')
      let cursor = store.getSnapshot().findings.get(room)?.next
      while (live && cursor) {
        await store.loadFindings(room, 'all', cursor)
        const next = store.getSnapshot().findings.get(room)?.next
        if (next === cursor) break
        cursor = next
      }
    }
    void Promise.all([store.loadBoardEvidence(room), read()]).catch((error: unknown) => {
      if (live) setTimelineReadError(error instanceof Error ? error.message : String(error))
    }).finally(() => { if (live) setTimelinePending(false) })
    const timer = window.setInterval(() => { void store.loadBoardEvidence(room) }, 30_000)
    return () => { live = false; window.clearInterval(timer) }
  }, [store, room, readingRun, timelineRun?.id, timelineCards, timelineRead])
  /** What the roster is filtered to. Empty is the whole room. */
  const [filter, setFilter] = useState('')
  /** The "add an agent" dialog, opened from the roster's own heading. */
  const [adding, setAdding] = useState(false)
  const [wrapping, setWrapping] = useState(false)
  /** A finding opened from the wrapped Goal's receipt: its full history, read on its own. */
  const [receiptFinding, setReceiptFinding] = useState<string | null>(null)
  /**
   * What a member control could not do, said in the Details Seats.
   *
   * A third line rather than a share of either: the chat's `trouble` is what
   * the composer could not do and the bar's is what the top row could not do,
   * and a failed Remove reported at either of those is a sentence about a
   * control the reader is not looking at.
   */
  const [railTrouble, setRailTrouble] = useState<string | null>(null)

  const show = (next: TeamFramePage | 'side-by-side' | SessionKey): void => {
    destination.current.chosen = true
    if (isFramePage(next)) {
      selectedPage.current = next
      if (next === 'room') chatLayout.current = 'thread'
      store.setTeamFramePage(room, next, next === 'room' ? 'thread' : undefined)
      setOpen(next)
      return
    }
    selectedPage.current = 'room'
    if (next === 'side-by-side') chatLayout.current = 'side-by-side'
    if (next === 'side-by-side') store.setTeamFramePage(room, 'room', 'side-by-side')
    else store.openTeamMemberChat(room, next)
    setOpen(next)
  }

  const [runFrameView, setRunFrameView] = useState<'timeline' | 'flow'>('timeline')
  useEffect(() => {
    const request = snapshot.teamFrameRequests[room]
    if (!request || !store.consumeTeamFrame(room, request.serial)) return
    destination.current.chosen = true
    selectedPage.current = request.page
    store.setTeamFramePage(room, request.page)
    setOpen(request.page)
    if (request.runView) setRunFrameView(request.runView)
  }, [room, snapshot.teamFrameRequests, store])

  const watch = (key: SessionKey): void => {
    /* Every other tile pinned (or holding the keys): the grid has no place
       to give, and opening it unchanged would read as the member having
       gone up. The row's own Watch is greyed with the same reason. */
    if (!canPlace(grid, key)) {
      setRailTrouble(`No tile is free: the others are pinned. Unpin one to make room for ${memberOf(key)?.nickname ?? 'this member'}.`)
      return
    }
    setGrid((was) => placeTile(was, key))
    show('side-by-side')
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
    setRailTrouble(null)
    const seat = goal?.members.find((one) => one.closed === null && one.session.runtime === runtime && one.session.sessionId === id)
    const release = seat
      ? store.releaseGoal(room, seat.id)
      : Promise.reject(new Error(goal ? 'That Seat is no longer active.' : 'This compatibility room is read-only.'))
    void release
      /* The member is dropped from the answer already in hand, rather than
         the answer being thrown away. `null` means "not asked", and the rail
         draws nothing at all for it — so clearing it made the whole roster
         vanish for as long as the refetch took, and would have left it blank
         for good if the refetch had already landed by then. Filtering is both
         the smaller flicker and the one that cannot strand the rail. */
      .then(() => {
        // Its tile goes with it: a tile for someone no longer in the room
        // would read "Member" over a conversation the room let go of.
        setGrid((was) => removeTile(was, key))
        // Opened on its own, it goes back to the room's chat the same way.
        setOpen((was) => (was === key ? 'room' : was))
        setFetched((was) =>
          was === null || was.room !== room
            ? was
            : {
                room,
                peers: was.peers.filter(
                  (one) => sessionKey(one.runtime, one.sessionId as SessionId) !== key,
                ),
              },
        )
      })
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

  /* The other half of `restored`: what is up is written back to the view as it
     changes, because the view is what Back and the next launch will read. */
  const mountId = mount?.id
  useEffect(() => {
    if (mountId) store.setRoomWatching(mountId, [])
  }, [store, mountId])
  useEffect(() => {
    if (mountId) store.setRoomSideBySide(mountId, grid)
  }, [store, mountId, grid])

  /** Which column a pick would take, so the rail can say so before it happens. */
  const wouldReplace = (key: SessionKey): SessionKey | null => modelWouldReplace(grid, key)

  const team = snapshot.teams.get(room)
  const entries = team?.channel ?? NO_ENTRIES
  const intents = team?.intents ?? NO_INTENTS
  /* One host setting, shared by the Thread and side-by-side composers. */
  const messaging = team?.messaging ?? true
  const toggleMessaging = (): Promise<void> =>
    store
      .teamMessaging(room, !messaging)
      .then(() => setComposerTrouble(null))
      .catch(() => setComposerTrouble('The host did not take the change; the switch is as it was.'))
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
            (one) => isPathInside(one.cwd, root),
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
  const singleMember: SessionKey | null = isFramePage(open) || open === 'side-by-side' ? null : open as SessionKey
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
   * the room around it. Pending attempts are remembered so a re-render between the
   * request and its answer does not ask twice; a failure is `openSession`'s
   * own to report, and it does — a background notice — so nothing is said
   * again here, and the column falls back to the conversation's empty state.
   */
  const asked = useRef(new Set<SessionKey>())
  const upFor = [...grid.tiles, ...(singleMember ? [singleMember] : [])].join(' ')
  /* Closed Seats remain in the map as metadata. Only a loaded body is ready
     to draw; reconnect can unload one that this column already read. Depend
     on those columns' hydration flags, rather than the whole session map, so
     unrelated traffic does not retry a failed read. */
  const unloaded = (upFor === '' ? [] : (upFor.split(' ') as SessionKey[]))
    .filter(key => !snapshot.sessions.get(key)?.itemsLoaded).join(' ')
  useEffect(() => {
    if (snapshot.status !== 'open') return
    for (const key of unloaded === '' ? [] : (unloaded.split(' ') as SessionKey[])) {
      if (asked.current.has(key)) continue
      asked.current.add(key)
      const { runtime, id } = splitSessionKey(key)
      void store
        .openSession(id, { runtime, reveal: false })
        /* `openSession` reports its own failures and resolves either way, so
           this is belt and braces — but it has to be a `catch` and not only a
           `finally`, which passes the rejection straight through to nobody. */
        .catch(() => undefined)
        /* A loaded body guards a successful read. Neither a success nor a
           failure may prevent a later column open or reconnect from retrying. */
        .finally(() => { asked.current.delete(key) })
    }
  }, [store, upFor, unloaded, snapshot.status])
  /* The roster as a list. `here` is already taken, by the count of
     conversations *in the folder* — which is the other half of the zero-state
     below and deliberately a different number. */
  const allSeats = useMemo(() => teamSeats(goal, team, flowExecution), [goal, team, flowExecution])
  const seats = useMemo(() => allSeats.filter(hasConversation), [allSeats])
  const waitingSeats = useMemo(() => new Set(seats
    .filter(seat => snapshot.approvals.some(approval => approval.key === seat.key))
    .map(seat => seat.record.id)), [seats, snapshot.approvals])
  const unlinked = useMemo(() => allSeats.filter(one => !hasConversation(one)), [allSeats])
  const receiptFaces = useMemo(() => new Map<string, SeatFaceIdentity>(teamSeats(goal, team, flowExecution, 'seat').map(seat => {
    const runtime = seat.record.session?.runtime
    const info = snapshot.runtimes.find(one => one.id === runtime)
    return [seat.record.id, { brand: info ? brandForRuntime(info) : null,
      tint: runtime ? runtimeTint(runtime as RuntimeId, snapshot.accountsByRuntime, snapshot.accountPrefs) : 'blue' }]
  })), [goal, team, flowExecution, snapshot.runtimes, snapshot.accountsByRuntime, snapshot.accountPrefs])
  const members = useMemo(() => {
    return seats.filter(seat => !seat.record.closed).map(seat => {
      const peer = peers?.find(one => sessionKey(one.runtime, one.sessionId) === seat.key)
      if (peer) return peer
      const runtime = snapshot.runtimes.find(one => one.id === seat.record.session.runtime)
      const live = snapshot.sessions.get(seat.key)
      return {
        runtime: seat.record.session.runtime as RuntimeId, sessionId: seat.record.session.sessionId,
        title: live?.title ?? null, agent: runtime?.presentation.name ?? seat.name,
        nickname: team?.nicknames?.[seat.key] ?? seat.name,
        busy: live ? isBusy(live) : false, here: Boolean(live),
        inbound: team?.inbound?.[seat.key] ?? 'accept',
      }
    })
  }, [peers, seats, snapshot.runtimes, snapshot.sessions, team])
  const modelRuntimes = [...new Set(members.map(peer => peer.runtime))].sort()
  const modelScope = JSON.stringify([room, snapshot.activeRuntime, snapshot.models.map(model => [model.id, model.displayName]), members.map(peer => [peer.runtime, peer.sessionId, peer.model ?? null])])
  const [seatModels, setSeatModels] = useState<{ scope: string; catalogs: ReadonlyMap<RuntimeId, readonly ModelInfo[]> } | null>(null)
  useEffect(() => {
    let live = true
    void Promise.all(modelRuntimes.map(async runtime => [runtime, await store.modelsFor(runtime).catch(() => [])] as const))
      .then(catalogs => { if (live) setSeatModels({ scope: modelScope, catalogs: new Map(catalogs) }) })
    return () => { live = false }
  }, [store, modelScope])
  const seatModelName = (runtime: RuntimeId, model: string | null | undefined): string | null => {
    if (!model) return null
    const catalog = seatModels?.scope === modelScope ? seatModels.catalogs.get(runtime) : undefined
    return catalog?.find(one => one.id === model)?.displayName
      ?? (runtime === snapshot.activeRuntime ? snapshot.models.find(one => one.id === model)?.displayName : undefined)
      ?? 'Model not recorded'
  }
  const displayMembers = useMemo(() => members.map(peer => ({
    nickname: peer.nickname,
    record: goal?.members.find(one => sessionKey(one.session.runtime, one.session.sessionId) === sessionKey(peer.runtime, peer.sessionId)),
    runtimeName: snapshot.runtimes.find(one => one.id === peer.runtime)?.presentation.name,
  })), [members, goal?.members, snapshot.runtimes])
  const [report, setReport] = useState<InsightReport | null>(null)
  const closedCards = intents.filter(one => one.state === 'done').map(one => one.id).join(',')
  useEffect(() => {
    let active = true
    setReport(null)
    if ((open !== 'overview' && !detailsVisible) || !goal || typeof store.readGoalInsight !== 'function') return
    const read = () => { void store.readGoalInsight(room).then(answer => { if (active) setReport(answer) }, () => { if (active) setReport(null) }) }
    read()
    const timer = flowExecution?.state === 'running' ? window.setInterval(read, 60_000) : null
    return () => { active = false; if (timer !== null) window.clearInterval(timer) }
  }, [store, room, open, detailsVisible, Boolean(goal), closedCards, flowExecution?.state])
  useEffect(() => {
    if (flowExecution && typeof store.loadFindingRun === 'function') void store.loadFindingRun(room, flowExecution.id).catch(() => {})
  }, [store, room, flowExecution?.id])
  const heldClient = useMemo(() => clientSnapshot(snapshot), [snapshot])
  const overview = useMemo(() => teamOverviewOf(heldClient, room, {
    runtimes: snapshot.runtimes.map(one => ({ id: one.id, name: one.presentation.name, metered: one.capabilities.metered })),
    seats: seats.map(seat => ({
      record: seat.record, name: seatDisplayName(goal?.members.find(one => one.id === seat.record.id), members.find(one => sessionKey(one.runtime, one.sessionId) === seat.key)?.nickname ?? seat.name, snapshot.runtimes.find(one => one.id === seat.record.session.runtime)?.presentation.name, displayMembers),
      runtime: snapshot.runtimes.find(one => one.id === seat.record.session.runtime) ?? null,
      session: snapshot.sessions.get(seat.key) ?? null,
      unreadSince: snapshot.inbox.find(one => !one.read && one.from?.runtime === seat.record.session.runtime && one.from?.sessionId === seat.record.session.sessionId)?.at ?? null,
      approvals: snapshot.approvals.filter(one => one.key === seat.key).map(one => one.approval),
    })),
    run: flowExecution ? {execution: flowExecution, startedAt: flowExecution.startedAt ?? null} : null,
    findingRun: flowExecution ? snapshot.findingRuns.get(flowExecution.id) : null,
    publicationOn: goal?.goal.findingPublication !== false,
    report: report?.goal === room ? report : null,
  }), [heldClient, room, intents, entries, seats, members, displayMembers, snapshot.runtimes, snapshot.sessions, snapshot.inbox, snapshot.approvals, flowExecution, report, snapshot.findingRuns, goal?.goal.findingPublication])
  const overviewTimeline = useMemo(() => flowExecution ? runTimelineOf(heldClient, flowExecution, { sessions: snapshot.sessions, waitingSeats }) : null,
  [heldClient, flowExecution, snapshot.sessions, waitingSeats])
  const comparisonTimeline = useMemo(() => flowExecution ? runTimelineOf(heldClient, flowExecution, {
    sessions: snapshot.sessions, evidence: snapshot.boardEvidence.get(room), waitingSeats,
  }) : null, [heldClient, flowExecution, snapshot.sessions, snapshot.boardEvidence, waitingSeats, room])
  const comparison = comparisonTimeline && flowExecution ? comparisonVerdictOf(comparisonTimeline, flowExecution, intents) : null
  const comparisonId = comparison?.id ?? null
  const [comparisonDismissal, setComparisonDismissal] = useState({ id: comparisonId, hidden: false })
  if (comparisonDismissal.id !== comparisonId) setComparisonDismissal({ id: comparisonId, hidden: false })
  const hasComparison = Boolean(comparisonTimeline?.rows.some(one => one.attempt))
  const [comparisonChoice, setComparisonChoice] = useState<{id: string | null; card: number | null}>({id:comparisonId, card:null})
  const [mergedComparison, setMergedComparison] = useState<ComparisonMergeReceipt | null>(null)
  const [attemptsShown, setAttemptsShown] = useState<string | null>(null)
  const mergeReceipt = flowExecution ? comparisonMergeOf(flowExecution.id, intents.filter(card => flowStepOf(card, undefined, [flowExecution])?.kind === 'person')) ?? (mergedComparison?.run === flowExecution.id ? mergedComparison : null) : null
  const comparisonCosts = flowExecution ? runSeatCosts(flowExecution, overview.seats.map(one => ({id:one.seat, cost:one.cost}))) : null
  const chosenAttempt = comparison?.kind === 'picked' ? comparison.judge.pick?.attempts.find(one => one.card === (comparisonChoice.id === comparisonId ? comparisonChoice.card : null)) ?? comparison.attempt : null
  const comparisonLetters = new Map(comparisonTimeline?.rows.flatMap(row => {
    const seat = seats.find(one => one.record.id === row.seat)
    return seat && row.attempt ? [[seat.key, row.attempt.replace(/^Attempt /, '')] as const] : []
  }) ?? [])
  const comparisonKeeps = new Map(comparison?.kind === 'picked' ? [...comparison.keeps].flatMap(([card, keep]) => {
    const row = comparisonTimeline?.rows.find(one => one.card === card)
    const seat = seats.find(one => one.record.id === row?.seat)
    const selected = mergeReceipt?.card ?? chosenAttempt?.card
    return seat ? [[seat.key, selected === undefined ? keep : card === selected ? 'kept' as const : 'not-kept' as const] as const] : []
  }) : [])
  const [pickingComparison, setPickingComparison] = useState<string | null>(null)
  useEffect(() => {
    if (open !== 'side-by-side' || !flowExecution) return
    void store.loadBoardEvidence(room)
  }, [store, room, open, flowExecution?.id, flowExecution?.rounds.map(one => `${one.n}:${one.state}:${one.cards.join(',')}`).join('|')])
  const stoppingSessions = new Set(overviewTimeline?.rows.filter(row => row.status === 'Stopping').flatMap(row => {
    const claim = intents.find(card => card.id === row.card)?.claim
    return claim ? [sessionKey(claim.runtime, claim.sessionId)] : []
  }) ?? [])
  // What the Overview can do about what needs you: the same requests the board and the docked approval make.
  const needsYouAnswers = useNeedsYouAnswers({ room, execution: flowExecution ?? null, cards: intents, openBoard: () => show('board') })
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
      members.map((peer) => {
        const key = sessionKey(peer.runtime, peer.sessionId as SessionId)
        const runtime = snapshot.runtimes.find((one) => one.id === peer.runtime) ?? null
        /* Live where we have it. A turn starting or ending changes this and
           changes nothing the roster fetch depends on, so the roster's own
           `busy` is a snapshot that goes stale the moment it is read. For a
           conversation this renderer has open, the session map is the truth and
           updates itself; for one it has never opened, the host's answer is all
           there is. */
        const live = snapshot.sessions.get(key)
        const health = snapshot.healthByRuntime[peer.runtime]
        /* What this agent is on *right now*, from the board — not the last
           thing it said. That is what makes the rail answer the question
           without anything being opened.

           Both halves of the identity: session ids are unique per runtime,
           not globally, so matching the id alone put one claimed intent on
           two agents' rows the moment two runtimes minted the same id — and
           only one of them held it. */
        const onTask =
          intents.find(
            (one: Intent) =>
              one.state === 'claimed' &&
              one.claim?.sessionId === peer.sessionId &&
              one.claim?.runtime === peer.runtime,
          ) ?? null
        return {
          peer,
          ...(health?.state === 'unavailable' ? { unavailable: health.message } : {}),
          displayName: seatDisplayName(goal?.members.find(one => sessionKey(one.session.runtime, one.session.sessionId) === key), peer.nickname, runtime?.presentation.name, displayMembers),
          key,
          runtime,
          here: peer.here,
          brand: runtime ? brandForRuntime(runtime) : null,
          /* The account's own ring rather than one fixed colour. A rail of
             five members all in blue says nothing, and the ring exists to
             say which account this is — see lib/accounts.ts. */
          tint: runtimeTint(peer.runtime, snapshot.accountsByRuntime, snapshot.accountPrefs),
          busy: peer.here && (live ? isBusy(live) : peer.busy),
          done: overview.seats.find(one => seats.find(seat => seat.record.id === one.seat)?.key === key)?.done ?? false,
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
             a board it had never been shown.

             And never about a member currently on a task: a claimed card is
             proof it can take work, and the accusation must not replace the
             task that disproves it (#375). */
          idleOnBoard:
            peer.here &&
            runtime?.capabilities?.pluginTools !== false &&
            peer.usedBoard === false &&
            !onTask &&
            (intents.length > 0 || entries.length > 0),
          onTask,
          /* The open conversation's own title comes first and the host's roster
             second: the roster is fetched when membership changes, and a rename
             does not change membership, so reading the roster alone left a
             conversation renamed while the room was open wearing its old name
             until something else moved. */
          title: live?.title ?? peer.title ?? null,
          ceiling: seatCeilingOf(live?.settings, snapshot.flowRuns.get(room) ?? [], peer.runtime, peer.sessionId),
        }
      }),
    [
      members,
      displayMembers,
      goal,
      seats,
      overview,
      snapshot.runtimes,
      snapshot.healthByRuntime,
      snapshot.sessions,
      snapshot.accountsByRuntime,
      snapshot.accountPrefs,
      snapshot.flowRuns,
      room,
      intents,
      entries.length,
    ],
  )

  /* New comparisons follow their attempt Seats as they arrive, until a
     person navigates or arranges a tile. An agent judge stays off this grid.
     Outside that default, removing the last tile returns to Chat. */
  useEffect(() => {
    if (open !== 'side-by-side') return
    if (opensOnAttempts && !destination.current.chosen) {
      const role = flowExecution?.document.format === 'agents' ? raceRoleId(flowExecution.document.flow) : null
      const attempts = seats.filter(seat => seat.record.role === role && !seat.record.closed)
      const keys = (attempts.length ? attempts.map(seat => seat.key) : roster.map(member => member.key)).slice(0, MAX_TILES)
      if (keys.some(key => !grid.tiles.includes(key))) setGrid(keys.reduce((state, key) => placeTile(state, key), grid))
      return
    }
    if (grid.tiles.length === 0) setOpen('room')
  }, [open, grid.tiles.length, opensOnAttempts, roster, seats, flowExecution])

  /* Every answer about who is in the room, not only the first: a member can
     leave from elsewhere — another window, the room's own Goal wrapping —
     and its tile must not outlive its membership. `peers` is null until the
     room has answered, and an unanswered room says nothing about anyone. */
  useEffect(() => {
    if (peers === null) return
    const present = new Set(roster.map((member) => member.key))
    setGrid((was) => forgetMissing(was, present))
    // A member opened on its own who has left takes the body back to the chat.
    setOpen((was) =>
      isFramePage(was) || was === 'side-by-side' || present.has(was as SessionKey) ? was : 'room',
    )
  }, [peers, roster])

  /* The page's name: the Goal's own (`goalName` — for a trigger's Goal, its
     subject, "Issue #42", never the trigger's id the chip beside it already
     answers for), then the room's. Never the placeholder word "Room" for the
     beat before the board answers — a name that reads as real and then
     changes is worse than none. */
  const title = goal ? goalName(goal.goal) : team?.name ?? ''
  /**
   * The one member (if any) a runtime is waiting on a person for, in room
   * order — the header's own state chip pulses for this, the room's chat
   * carries its live line, and the composer's own slot is this member's
   * `Approvals`, not the room's plain one. A room rarely holds two pending
   * approvals at once; where it does, the first in roster order is shown and
   * the rest wait their turn exactly as they would in that member's own pane.
   */
  const pendingApproval = roster.find((one) => snapshot.approvals.some((entry) => entry.key === one.key)) ?? null
  /**
   * The header's own single state chip: what this Goal's run is doing right
   * now, in the words this design settled on — Running, Needs you, Stopped
   * or Done. `FlowRunStatus` used to draw a second chip under this one, in
   * a wordier vocabulary that never actually disagreed with it; it draws
   * neither now.
   */
  /* A trigger's own named waits count as a person being needed exactly as a
     member's approval does — a held message, a held action, a question —
     and a budget stop is a stop, whatever the run's own record says yet. */
  const personWaits = openTriggerWaits(originStatus).filter((wait) => wait.waitingOn.kind === 'person')
  /**
   * Everything beyond a member's own pending approval that makes this Goal
   * read "Needs you" — a named person-kind wait, the Goal's own activity, or
   * a stalled run. One rule, read by the header's chip below and handed to
   * the live line (`Room` → `RoomLiveLine`) as `needsYou`, so a stop reason
   * never shows on the live line while the header has already moved past it
   * to "Needs you" — the two surfaces disagreeing about the same run is
   * exactly the bug this constant exists to close.
   */
  const needsYou = Boolean(overview.run?.needsYou) || personWaits.length > 0 || goal?.activity === 'needs-you' || flowExecution?.state === 'stalled' || flowExecution?.end?.kind === 'unrouted' || flowExecution?.end?.kind === 'budget'
  const runState: { readonly label: string; readonly tone: Tone; readonly pulse: boolean } | null = !goal
    ? null
    : record ? { label: 'Wrapped', tone: 'success', pulse: false }
    : pendingApproval || needsYou
      ? { label: 'Needs you', tone: 'warning', pulse: true }
      : goal.goal.state === 'wrapped' || goal.goal.state === 'wrapping' || flowExecution?.state === 'settled'
        ? { label: 'Done', tone: 'success', pulse: false }
        : flowExecution?.state === 'stopped' || originStatus?.budget?.stop
          ? { label: flowExecution?.state === 'stopped' && stoppingSessions.size ? 'Stopping' : 'Stopped', tone: 'neutral', pulse: false }
          : { label: 'Running', tone: 'info', pulse: false }
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
  /* Whether the board caution belongs to the group rather than to each row:
     every row shown would say it, so it is said once above them. */
  const idleShared = shown.length > 1 && shown.every((member) => member.idleOnBoard)

  // PR evidence is shared by every Team page and persistent Details.
  useEffect(() => { void store.loadBoardEvidence(room).catch(() => undefined) }, [store, room])
  const detailsRun = timelineRun ?? flowExecution
  const pullRequest = runPullRequest(open === 'run' ? timelineRun : flowExecution, snapshot.boardEvidence.get(room))
  const findingCount = isRecord(goal) && goal?.receipt?.findings
    ? goal.receipt.findings.findings.length
    : snapshot.findings.get(room)?.totals?.all ?? snapshot.findingRuns.get(flowExecution?.id ?? '')?.open
  const toggleSideBySide = () => {
    if (open === 'side-by-side') return show(selectedPage.current)
    if (roster.length === 0) return
    if (grid.tiles.length === 0) setGrid(roster.slice(0, MAX_TILES).reduce((state, member) => placeTile(state, member.key), grid))
    show('side-by-side')
  }
  const triggerSourceTitle = triggerControl.view?.definition
    ? teamTriggerLabel(originStatus, triggerControl.view)
    : triggerControl.view?.reason ?? (triggerControl.ready ? undefined : triggerControl.problem ?? 'Trigger declaration is being read')

  const teamRoot = goal?.goal.root ?? null
  const target = goalRunOf(room, goal, snapshot.flowExecutions)?.target
  const teamBranch = snapshot.worktrees.find(one => one.path === teamRoot)?.branch
    ?? (snapshot.workspace?.path === teamRoot ? snapshot.workspace.git?.branch : null)
  const teamChangesRefusal = !teamRoot || !teamBranch || !target?.base || !target.head
    ? 'The Team branch and base are not recorded yet' : undefined
  const teamTabs: TopBarTab[] = [
    { value: 'overview', label: 'Overview', count: needsYou ? 1 : undefined, run: () => show('overview') },
    { value: 'run', label: 'Run', count: runs.length || undefined, disabled: !runs.length ? 'This Team has no Run yet' : false, run: () => show('run') },
    { value: 'board', label: 'Board', count: intents.length, run: () => show('board') },
    { value: 'room', label: 'Chat', count: held || undefined, run: () => show(chatLayout.current === 'side-by-side' ? 'side-by-side' : 'room') },
    { value: 'findings', label: 'Findings', count: findingCount, disabled: !goal ? 'This Team has no findings' : false, run: () => show('findings') },
    ...(triggerKind ? [{ value: 'runs', label: 'Runs', count: runs.length, run: () => { setChosenRun(null); show('runs') } }] : []),
    ...(goal?.receipt ? [{ value: 'receipt', label: 'Receipt', run: () => show('receipt') }] : []),
  ]
  useTopBar(mainOwner, {
    lead: sidebarPlacement(snapshot) !== 'column' ? <WindowControls /> : undefined,
    place: title, state: runState ? <Chip tone={runState.tone}>{runState.pulse && <Dot state="limit" pulse />}{runState.label}</Chip> : undefined,
    tabs: teamTabs, tab: open === 'side-by-side' || singleMember ? 'room' : open,
    view: { disabled: 'This view has no layout or filter choices', content: () => null },
    tools: <WorkTools changesRefusal={teamChangesRefusal} />,
    terminal: true,
    more: close => <>
      {pullRequest && <MenuItem icon={<PullRequestIcon size={16} />} label="Open pull request" onSelect={() => { void openExternal(pullRequest.url); close() }} />}
      <MenuItem icon={<CommentIcon size={16} />} label="Wrap…" disabled={record ? RECORD_REASON : wrapDisabled} onSelect={() => { setWrapping(true); close() }} />
      <MenuItem icon={<ExpandIcon size={16} />} label="Fill the window" onSelect={() => { store.zoomPanel('main', 'window'); close() }} />
    </>, corner: sidebarPlacement(snapshot) !== 'column',
  }, Boolean(mainOwner))

  const detailsAt = detailsRun?.target ? detailsRun.target.kind !== 'diff' && detailsRun.target.head
    ? [detailsRun.target.head, detailsRun.target.label].filter(Boolean).join(' on ') : detailsRun.target.label
    : (!detailsRun || detailsRun.id === flowExecution?.id) ? goal?.goal.at ?? null : null
  const detailsPullRequest = runPullRequest(detailsRun, snapshot.boardEvidence.get(room))
  const detailsCosts = detailsRun ? runSeatCosts(detailsRun, allSeats.map(seat => ({
    id: seat.record.id, cost: teamSeatCost({ team: room, report: report?.goal === room ? report : null }, seat.record.id,
      snapshot.runtimes.find(info => info.id === seat.record.session?.runtime)?.capabilities.metered),
  }))).summary : null
  const detailsInput: RunTimelineInput | null = detailsRun ? {
    execution: detailsRun, cards: intents, sessions: snapshot.sessions,
    evidence: snapshot.boardEvidence.get(room), findings: snapshot.findings.get(room)?.rows,
    findingRun: snapshot.findingRuns.get(detailsRun.id), publicationOn: goal?.goal.findingPublication !== false,
    origin: detailsRun.intake ? `From trigger ${detailsRun.intake.trigger}` : goal?.goal.origin.kind === 'person' ? 'Started by you' : null,
    attempts: checkAttempts.attempts, incompleteAttempts: checkAttempts.incomplete,
  } : null
  const runChooser = runs.length > 1 ? <span aria-label="Choose a Run">
    {runs.map((one, index) => <Button key={one.id} variant="choice" size="sm"
      data-active={detailsRun?.id === one.id || undefined} onClick={() => setChosenRun(one.id)}>Run {index + 1}</Button>)}
  </span> : undefined
  const seatRows: SeatListRow[] = allSeats.map(seat => {
    const member = seat.key ? roster.find(one => one.key === seat.key) : undefined
    const key = seat.key
    const stopped = seat.record.closed != null
    const stoppedReason = stopped ? 'This Seat is stopped. Open its conversation to read the kept history.' : undefined
    const refusal = key === null ? 'Conversation not kept' : member?.unavailable
    return {
      id: seat.record.id, selected: open === key, name: member?.displayName ?? seat.name,
      mark: <MemberCard entry={member ?? null} side="bottom"><IconTile shape="face" tint={member?.tint ?? 'violet'}>{member?.brand ? <BrandMark brand={member.brand} /> : <AgentIcon />}</IconTile></MemberCard>,
      detail: member ? [snapshot.runtimes.find(info => info.id === member.peer.runtime)?.presentation.name ?? 'Agent', seatModelName(member.peer.runtime, member.peer.model), member.ceiling ? seatCeilingWords(member.ceiling.ceiling) : null].filter(Boolean).join(' · ') + [
        !member.canUseBoard ? 'cannot take jobs — tools not reachable' : member.peer.inbound !== 'accept'
          ? member.peer.inbound === 'hold' ? 'messages held' : 'messages refused' : member.onTask ? `#${member.onTask.id} ${member.onTask.title}`
          : member.idleOnBoard && !idleShared ? 'has not used the board' : !member.here ? 'not open — a message opens it' : null,
        member.title && member.title !== member.peer.nickname && (member.title !== member.onTask?.title || member.peer.inbound !== 'accept' || !member.canUseBoard) ? member.title : null,
        !member.here && member.onTask ? 'not open — a message opens it' : null,
      ].filter(Boolean).map(one => ` · ${one}`).join('') : seat.role ?? 'Recorded Seat',
      state: stopped ? 'Stopped' : member && snapshot.approvals.some(one => one.key === member.key) ? 'Needs you' : member?.busy ? 'Working' : member?.done ? 'Done' : member && !member.here ? 'Not open' : 'Idle',
      open: () => { if (key) show(key) }, watch: () => { if (key) watch(key) },
      message: () => { if (key) { show('room'); setAddressedSeat(key) } },
      inbound: member?.peer.inbound ?? 'accept', setInbound: mode => { if (key) setInbound(key, mode) },
      remove: () => { if (key) leave(key) }, refusal,
      watchRefusal: stoppedReason ?? (record ? RECORD_REASON : key && !canPlace(grid, key) ? 'No tile is free; unpin one first' : undefined),
      messageRefusal: stoppedReason ?? (record ? RECORD_REASON : undefined), mutationRefusal: stoppedReason ?? (record ? RECORD_REASON : undefined),
      removeRefusal: stoppedReason ?? (!goal ? 'This compatibility room is read-only' : undefined),
    }
  })
  const filteredSeats = filter.trim() ? seatRows.filter(one => `${one.name} ${one.detail}`.toLowerCase().includes(filter.trim().toLowerCase())) : seatRows
  useWorkDetails(mainOwner, <ToolBody>
    <ToolSection label="Run">
      <TeamRunFacts input={detailsInput} number={detailsRun ? runs.findIndex(one => one.id === detailsRun.id) + 1 : 0}
        chooser={runChooser} at={detailsAt}
        continuesNumber={detailsRun?.continues ? runs.findIndex(one => one.id === detailsRun.continues) + 1 || undefined : undefined}
        flowFile={detailsRun && <RunFlowFile root={goal?.goal.root ?? null} name={detailsRun.document.flow.name} compact />}
        originAction={originStatus?.url ? <Button variant="link" size="inline-link" onClick={() => void openExternal(originStatus.url!)}>Open</Button> : undefined}
        originNote={originStatus ? originHoverWords(originStatus, triggerSourceTitle ?? 'Trigger') : undefined}
        pullRequest={detailsPullRequest} cost={detailsCosts} trigger={triggerKind ? <>{teamTriggerLabel(originStatus, triggerControl.view)}{originStatus && <Text as="span" role="meta" ink="secondary"> · {originHoverWords(originStatus, triggerSourceTitle ?? 'Trigger')}</Text>}{triggerControl.view && <Text as="span" role="meta" title={triggerControl.view.reason ?? undefined}> · {triggerControl.view.armed && triggerControl.prefs?.paused ? 'Paused' : ({ armed: 'Armed', off: 'Off', changed: 'Changed', refused: 'Refused', paused: 'Paused' } as const)[triggerControl.view.state]}</Text>}{triggerControl.view?.reason && <Text as="span" role="meta"> · {triggerControl.view.reason}</Text>}{!detailsInput && originStatus?.url && <Button variant="link" size="inline-link" onClick={() => void openExternal(originStatus.url!)}>Open</Button>}</> : undefined} />
      <RunDetailsView inspectionOnly />
    </ToolSection>
    <ToolSection label="Seats" action={<Button variant="ghost" size="icon-sm" aria-label="Seat an Agent in this Team"
      disabled={record || !goal} title={record ? RECORD_REASON : !goal ? 'This compatibility room is read-only' : undefined}
      onClick={() => setAdding(true)}><PlusIcon /></Button>}>
      {roster.length > 4 && <PanelFilter value={filter} onChange={setFilter} placeholder="Filter Seats" />}
      {idleShared && <Note>None of these agents has used the board yet.</Note>}
      {peers !== null && allSeats.length === 0 && <EmptyState variant="inline" title={record ? 'No Agents were kept in this Team’s receipt.' : here === 0
        ? 'No agents in this Team yet, and no conversations in this project either. + starts one and puts it in.'
        : here === 1 ? 'No agents in this Team yet. One conversation is open in this project — + adds an agent.'
        : `No agents in this Team yet. ${here} conversations are open in this project — + adds an agent.`} />}
      {seatRows.length > 0 && filteredSeats.length === 0 && <EmptyState variant="inline" title={`No agent here matches “${filter.trim()}”.`} />}
      <SeatList rows={filteredSeats} />
    </ToolSection>
  </ToolBody>, Boolean(mainOwner))

  useTopBarView(mainOwner, {
    view: { content: close => <Menu close={close}>
      <MenuItem label="Thread" selected={open === 'room'} onSelect={() => { show('room'); close() }} />
      <MenuItem label="Side by side" selected={open === 'side-by-side'}
        disabled={record ? RECORD_REASON : roster.length === 0 ? 'There are no conversations to watch' : false}
        onSelect={() => { if (open !== 'side-by-side') toggleSideBySide(); close() }} />
    </Menu> },
  }, Boolean(mainOwner) && (open === 'room' || open === 'side-by-side'))

  useLayoutEffect(() => {
    if (open !== 'room' || !addressedSeat || !chatComposer.current) return
    chatComposer.current.address(addressedSeat)
    setAddressedSeat(null)
  }, [open, addressedSeat, pendingApproval?.key])

  return (
    <PaneSurface className={`${styles.pane} h-full`} data-slot="team-room">
      {adding && goal ? <AddMember room={room} root={root} onClose={() => setAdding(false)} /> : null}
      {wrapping && goal ? <GoalWrap view={goal} onClose={() => setWrapping(false)} /> : null}
      {stoppingRun && stoppingExecution?.goal === room ? <StopRunDialog key={stoppingRun} seats={stopSeats}
        refusal={record ? RECORD_REASON : null}
        ended={stoppingExecution.state === 'stopped' || stoppingExecution.state === 'settled'}
        failure={snapshot.flowStopProblems.get(stoppingRun)}
        onStop={reason => store.stopFlowExecution(stoppingRun, reason)} onClose={() => setStoppingRun(null)} /> : null}
      {again?.goal === room && goal && <RunAgain key={again.id} execution={again} root={goal.goal.root} sentence={goal.goal.sentence}
        onClose={() => setAgain(null)} onStarted={next => { setAgain(null); setChosenRun(next.id); show('run'); void store.loadTeamRuns(room) }} />}
      {retryCheck && runs.some(one => one.id === retryCheck.run) && <RetryCheck run={retryCheck.run} card={retryCheck.card} onClose={() => setRetryCheck(null)} />}

      {goal ? <GoalHeader view={goal} coveredProblem={flowExecution?.reason ?? timelineRun?.reason} /> : null}
      {flowExecution?.state === 'stalled' && (open !== 'run' || timelineRun?.id !== flowExecution.id) && <PaneColumn inset="reading"><Button variant="link" size="inline" onClick={() => { setChosenRun(flowExecution.id); show('run') }}>Review stopped Run</Button></PaneColumn>}
      {flowExecution ? <FlowRunStatus execution={flowExecution} checkRecovery={open !== 'run'} /> : null}
      {runs.map((execution, index) => {
        const failure = snapshot.flowStopProblems.get(execution.id)
        return failure ? <StopRunFailure key={execution.id} number={index + 1} message={failure.message}
          refusal={record ? RECORD_REASON : null} onRetry={() => setStoppingRun(execution.id)} /> : null
      })}
      {railTrouble && <ToolPaneNotice tone="danger"><span role="alert">{railTrouble}</span></ToolPaneNotice>}

      {/* No inset reserved here, on purpose: a standing notice for the room
          lives inside `RoomComposer`'s own strip, below, over its composer —
          not above the page tabs or the reading side, which is why nothing in this
          split has to make room for one. */}
      <div className={styles.split}>
        <div className={styles.body} data-slot="room-body">
          {triggerKind && <div hidden={open !== 'runs'} className={open !== 'runs' ? 'hidden' : 'flex min-h-0 min-w-0 flex-1 flex-col'}>
            <TeamRuns key={room} runs={runs} findings={snapshot.findingRuns} ledger={snapshot.findings.get(room)} origin={originStatus} trigger={triggerControl}
              problem={runHistoryProblem?.room === room ? runHistoryProblem.message : runsReviewProblem?.room === room ? runsReviewProblem.text : timelineReadError ?? snapshot.findings.get(room)?.error ?? snapshot.findings.get(room)?.problem ?? null}
              onOpen={id => { setChosenRun(id); show('run') }} onEdit={() => store.openFile(`${goal!.goal.root}/.harnessdesk/triggers.yml`)}
              onRunVisibility={onRunReviewVisibility} active={open === 'runs'} />
          </div>}
          {open === 'receipt' ? (
            <PaneColumn inset="reading" page className="min-h-0 flex-1 overflow-y-auto">
              <div className="w-full max-w-(--hd-column)">
              {goal?.receipt ? (
                <>
                  <GoalReceiptCost receipt={goal.receipt}>
                    {insight => <GoalReceipt receipt={goal.receipt!} root={goal.goal.root} faces={receiptFaces} onOpenFinding={setReceiptFinding} insight={insight} />}
                  </GoalReceiptCost>
                  <FindingCarry source={goal} />
                  {receiptFinding ? <FindingDetail goal={goal.goal.id} finding={receiptFinding} onClose={() => setReceiptFinding(null)} /> : null}
                </>
              ) : null}
              </div>
            </PaneColumn>
          ) : open === 'overview' ? (
            <TeamOverview model={{...overview,seats:[...overview.seats,...unlinked.map(seat => ({seat:seat.record.id,name:seat.name,role:seat.role,card:null,round:null,state:'idle' as const,reason:'Conversation not kept',doing:null,since:null,cost:null,done:false}))]}} unavailable={new Set(unlinked.map(seat=>seat.record.id))} answers={needsYouAnswers} onWrap={!record && goal?.activity === 'ready-to-wrap' && !wrapDisabled ? () => setWrapping(true) : undefined} onRun={() => { if (triggerKind && flowExecution) setChosenRun(flowExecution.id); show('run') }}
              faces={new Map(seats.map(seat => {
                const runtime = snapshot.runtimes.find(one => one.id === seat.record.session.runtime)
                const brand = runtime ? brandForRuntime(runtime) : null
                return [seat.record.id, brand ? <BrandMark brand={brand} size={13} /> : <AgentIcon />]
              }))}
              metered={new Map(seats.flatMap(seat => {
                const runtime = snapshot.runtimes.find(one => one.id === seat.record.session.runtime)
                return runtime ? [[seat.record.id, runtime.capabilities.metered === true] as const] : []
              }))}
              runName={flowExecution?.document.flow.name}
              runNeedsYou={needsYou || Boolean(pendingApproval)}
              onFindings={goal ? () => show('findings') : undefined}
              runReason={flowExecution?.state === 'stalled' ? null : flowExecution?.reason}
              runRules={flowExecution?.document.flow.rules}
              faceTints={new Map(seats.map(seat => [seat.record.id, runtimeTint(seat.record.session.runtime as RuntimeId, snapshot.accountsByRuntime, snapshot.accountPrefs)]))}
              runtimeNames={new Map(seats.flatMap(seat => { const runtime = snapshot.runtimes.find(one => one.id === seat.record.session.runtime); return runtime ? [[seat.record.id, runtime.presentation.name]] : [] }))}
              timeline={overviewTimeline}
              onStop={!record && flowExecution ? () => setStoppingRun(flowExecution.id) : undefined}
              statusLine={(now, includeRunReason) => <RoomLiveLine members={roster} snapshot={snapshot} now={now} triggerStatus={originStatus} flowExecution={flowExecution} needsYou={needsYou} room={room} includeRunReason={includeRunReason && flowExecution?.state !== 'stalled'} stoppingSessions={stoppingSessions} />}
              onOpen={id => { const seat = seats.find(one => one.record.id === id); if (seat) show(seat.key) }} />
          ) : open === 'runs' ? null : open === 'run' && timelineRun ? (
            <div className="flex min-h-0 min-w-0 flex-1 flex-col">
              {triggerKind && <PaneColumn inset="reading" page><Button variant="link" size="inline" aria-label="Back to Runs" onClick={() => show('runs')}>Back to Runs</Button></PaneColumn>}
              <TeamRunView key={timelineRun.id} execution={timelineRun} view={runFrameView} onView={setRunFrameView}
                waitingSeats={waitingSeats}
                stopRefusal={record ? RECORD_REASON : undefined}
                onStop={!record ? () => setStoppingRun(timelineRun.id) : undefined}
                continuesNumber={timelineRun.continues ? runs.findIndex(one => one.id === timelineRun.continues) + 1 || undefined : undefined}
                onRunAgain={goal?.goal.state === 'open' ? () => setAgain(timelineRun) : undefined}
                onWrap={!wrapDisabled ? () => setWrapping(true) : undefined}
                onBoard={() => show('board')}
                onReviewCheck={() => { const check = timelineRun.operations.find(one => one.kind === 'check' && one.state === 'uncertain'); if (check?.card != null) setRetryCheck({ run: timelineRun.id, card: check.card }) }}
                origin={timelineRun.intake ? `From trigger ${timelineRun.intake.trigger}` : goal?.goal.origin.kind === 'person' ? 'Started by you' : null}
                onOpenSeat={show} onOpenBoard={() => show('board')} number={runs.findIndex(one => one.id === timelineRun.id) + 1}
                model={runTimelineOf(heldClient, timelineRun, { sessions: snapshot.sessions, waitingSeats,
                  evidence: snapshot.boardEvidence.get(room),
                  findingRun: snapshot.findingRuns.get(timelineRun.id),
                  publicationOn: goal?.goal.findingPublication !== false,
                  findings: snapshot.findings.get(room)?.filter === 'all' ? snapshot.findings.get(room)?.rows : [],
                  origin: timelineRun.intake ? `From trigger ${timelineRun.intake.trigger}` : goal?.goal.origin.kind === 'person' ? 'Started by you' : null,
                  ...(checkAttempts.attempts ? { attempts: checkAttempts.attempts } : {}),
                  ...(checkAttempts.incomplete.size ? { incompleteAttempts: checkAttempts.incomplete } : {}),
                })}
                attempts={checkAttempts.attempts}
                incompleteAttempts={checkAttempts.incomplete}
                attemptsRead={checkAttempts.read}
                selectedRow={selectedRunRows.get(timelineRun.id) ?? null}
                onSelect={id => setSelectedRunRows(was => new Map(was).set(timelineRun.id, id))}
                doing={new Map(overview.seats.map(one => [one.seat, one.doing]))}
                pending={timelinePending}
                onRetry={() => setTimelineRead(was => was + 1)}
                drawFlow
                problem={snapshot.boardEvidenceFailed.has(room) ? 'Check evidence is unavailable.'
                  : timelineReadError ?? (runHistoryProblem?.room === room ? runHistoryProblem.message : null) ?? snapshot.findings.get(room)?.error ?? snapshot.findings.get(room)?.problem ?? (snapshot.findings.get(room)?.next ? 'More findings remain to be read.' : null)
                  ?? (checkAttempts.read === 'failed' ? 'Earlier attempts of a check could not be read.' : null)}
                faces={new Map(seats.map(seat => {
                  const runtime = snapshot.runtimes.find(one => one.id === seat.record.session.runtime)
                  const brand = runtime ? brandForRuntime(runtime) : null
                  return [seat.record.id, brand ? <BrandMark brand={brand} size={13} /> : <AgentIcon />]
                }))}
                pullRequest={runPullRequest(timelineRun, snapshot.boardEvidence.get(room))} />
            </div>
          ) : open === 'board' ? (
            <TeamBoardPane room={room} />
          ) : open === 'findings' ? (
            goal ? <GoalFindings goal={room} /> : null
          ) : open === 'side-by-side' && grid.tiles.length > 0 ? (
            mergeReceipt && attemptsShown !== mergeReceipt.run ? <ComparisonSummary
              title={`${comparisonTimeline?.rows.find(one => one.card === mergeReceipt.card)?.attempt?.replace(/^Attempt /, '') ?? 'The picked attempt'} is in ${sanitizeText(mergeReceipt.branch)}`}
              meta={<>
                {flowExecution?.startedAt != null && <span>{formatDuration(Math.max(0, mergeReceipt.at - flowExecution.startedAt))}</span>}
                <span>{comparisonCosts?.ids.length ?? seats.length} agents</span>
                <span>{comparisonCosts?.summary ?? 'Cost not recorded'}</span>
                <span>{new Date(mergeReceipt.at).toLocaleString(undefined, {dateStyle:'medium', timeStyle:'short'})}</span>
              </>}
              attempts={<Rows>
                {comparisonTimeline?.rows.filter(one => one.attempt).map(one => <Row key={one.id}
                  mark={<Chip size="sm" tone={one.card === mergeReceipt.card ? 'brand' : 'neutral'}>{one.attempt?.replace(/^Attempt /, '')}</Chip>}
                  title={<>{sanitizeText(seats.find(seat => seat.record.id === one.seat)?.name ?? one.attempt ?? 'Attempt')} · {one.card === mergeReceipt.card ? `merged into ${sanitizeText(mergeReceipt.branch)}` : 'not kept'}</>}
                  desc={one.card === mergeReceipt.card ? <>{shortSha(mergeReceipt.commit)}{one.change && <> · {one.change.files} files · <ChangeStats added={one.change.added} removed={one.change.removed} /></>}</> : 'The attempt stays in this Run'}
                  control={<Button size="sm" variant="outline" onClick={() => {
                    setChosenRun(flowExecution!.id)
                    setSelectedRunRows(was => new Map(was).set(flowExecution!.id, one.id))
                    show('run')
                  }}>{one.card === mergeReceipt.card ? 'View change' : 'Open it'}</Button>}
                />)}
              </Rows>}
              checks={<>{comparisonTimeline?.rows.filter(one => one.kind === 'check').map(one => <Text key={one.id} role="meta" as="div">{one.on ? `${sanitizeText(one.on)}: ` : ''}{sanitizeText(one.title)} · {sanitizeText(one.status ?? 'Result not recorded')}</Text>)}</>}
              judge={comparison?.kind === 'picked' && comparison.reason ? <Text role="prose">“{sanitizeText(comparison.reason)}”</Text> : <Text role="meta">Reason not recorded</Text>}
              onShowAttempts={() => setAttemptsShown(mergeReceipt.run)}
              onRaceAgain={flowExecution && goal?.goal.state === 'open' ? () => setAgain(flowExecution) : undefined}
            /> : <RoomMessagesHeld.Provider value={!messaging}><SideBySide
              state={grid}
              onChange={changeGrid}
              paneId={mount?.id ?? 'team-room'}
              memberOf={(key) => {
                const member = memberOf(key)
                return member ? { nickname: member.nickname, agent: member.agent, model: member.model ?? undefined } : undefined
              }}
              entryOf={(key) => {
                const entry = roster.find((one) => one.key === key)
                if (!entry) return null
                return sideBySideTileEntry({
                  tint: entry.tint,
                  brand: entry.brand,
                  busy: entry.busy,
                  waitingForYou: snapshot.approvals.some((approval) => approval.key === key),
                  queued: entries.some((one) => one.kind === 'message' && one.from.kind === 'user' && one.state === 'queued' && one.to && sessionKey(one.to.runtime, one.to.sessionId as SessionId) === key),
                  ceiling: entry.ceiling,
                  lastTurnStatus: snapshot.sessions.get(key)?.turns.at(-1)?.status,
                  keep: comparisonKeeps.get(key),
                  label: comparisonLetters.get(key),
                })
              }}
              notice={hasComparison && comparison?.kind === 'waiting' && <>
                <ComparisonVerdict verdict={comparison}
                  dismissed={comparisonDismissal.id === comparisonId && comparisonDismissal.hidden}
                  onDismiss={() => setComparisonDismissal({ id: comparisonId, hidden: true })}
                  nameOfSeat={id => { const seat = seats.find(one => one.record.id === id); return members.find(one => sessionKey(one.runtime, one.sessionId) === seat?.key)?.nickname ?? seat?.name ?? 'Judge' }}
                  onOpenRun={row => {
                    if (!flowExecution) return
                    setChosenRun(flowExecution.id)
                    if (row) setSelectedRunRows(was => new Map(was).set(flowExecution.id, row))
                    show('run')
                  }}
                  onPick={() => { if (comparison?.kind === 'waiting') setPickingComparison(comparison.id) }} />
                {comparison?.kind === 'waiting' && pickingComparison === comparison.id && <PersonStepDialog key={comparison.id}
                  room={room} intent={comparison.card} role={comparison.step} mode="review" onClose={() => setPickingComparison(null)} />}
              </>}
              decision={!mergeReceipt && comparison?.kind === 'picked' && chosenAttempt && flowExecution && goal && <ComparisonActions key={comparison.id}
                room={room} root={goal.goal.root} execution={flowExecution} cards={intents} verdict={comparison} choice={chosenAttempt}
                onKeep={card => setComparisonChoice({id:comparisonId, card})} onMerged={setMergedComparison} />}
              onOpenMember={(key) => show(key)}
              conversationProps={{ onChooseProject, onSignIn, onOpenUsage, onOpenRuntimes }}
              composer={(shown) => <>
                {composerTrouble && <ActionError>{composerTrouble}</ActionError>}
                <RoomComposer
                  key={room}
                  room={room}
                  members={peers === null ? null : roster}
                  defaultAudience={shown}
                  tileLabels={new Map(grid.tiles.map((key, index) => [key, comparisonLetters.get(key) ?? String.fromCharCode(65 + index)]))}
                  draftState={roomDraft}
                  messaging={messaging}
                  onMessaging={toggleMessaging}
                  messagingReason={record ? RECORD_REASON : undefined}
                  onTrouble={setComposerTrouble}
                  onPosted={() => {}}
                />
              </>}
              card={(key, who) => (
                <MemberCard
                  entry={roster.find((one) => one.key === key) ?? null}
                  side="bottom"
                  className={styles.columnWho}
                >
                  {who}
                </MemberCard>
              )}
            /></RoomMessagesHeld.Provider>
          ) : singleMember ? (
            (() => {
              const key = singleMember
              const member = memberOf(key)
              const entry = roster.find((one) => one.key === key) ?? null
              return (
                <div className={styles.columns} data-columns="1">
                  <section className={styles.column}>
                    <div className={styles.columnBody}>
                      <PaneProvider scope={{ paneId: `${mount?.id ?? 'team-room'}:${key}`, view: { kind: 'conversation', session: key }, sessionKey: key }}>
                        <Conversation header={false} teamMenuOwner={mainOwner} onChooseProject={onChooseProject} onSignIn={onSignIn} onOpenUsage={onOpenUsage} onOpenRuntimes={onOpenRuntimes} />
                        <Approvals />
                      </PaneProvider>
                    </div>
                  </section>
                </div>
              )
            })()
          ) : (
            <Room onMessaging={toggleMessaging} messagingReason={record ? RECORD_REASON : undefined} composerRef={chatComposer} room={room} draftState={roomDraft} trouble={composerTrouble} onTrouble={setComposerTrouble} members={roster} loaded={peers !== null} onShow={show} pendingApproval={pendingApproval} triggerStatus={originStatus} flowExecution={flowExecution} needsYou={needsYou} />
          )}
        </div>
      </div>
    </PaneSurface>
  )
}

import { seatCeilingOf, type SeatCeilingShown } from '../lib/ceilings'

/** One member of the room, as the rail draws it. */
type Member = {
  peer: TeamPeerInfo
  displayName?: string
  key: SessionKey
  brand: ReturnType<typeof brandForRuntime> | null
  /** The account's ring, shared with the column head and the name card. */
  tint: Tint
  busy: boolean
  done: boolean
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
  ceiling: SeatCeilingShown | null
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
  as,
  className,
  openOnFocus,
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
   * members now, so leaving has to be something a person does — releasing its
   * durable Goal Seat is the explicit boundary.
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
  /** The trigger's element, class and focus rule, passed through — see `AgentHoverCard`. */
  readonly as?: 'span' | 'div'
  readonly className?: string
  readonly openOnFocus?: boolean
}) => {
  if (!entry) return <>{children}</>
  return (
    <MemberHoverCard
      member={cardFacts(entry)}
      {...(side ? { side } : {})}
      {...(as ? { as } : {})}
      {...(className ? { className } : {})}
      {...(openOnFocus !== undefined ? { openOnFocus } : {})}
    >
      {children}
    </MemberHoverCard>
  )
}

const sentence = (text: string): string => (text.length > 0 ? text[0]!.toUpperCase() + text.slice(1) : text)

const RoomLiveLine = ({
  members,
  snapshot,
  now,
  triggerStatus,
  flowExecution,
  needsYou,
  room,
  includeRunReason = false,
  stoppingSessions,
}: {
  readonly members: readonly Member[]
  readonly snapshot: AppSnapshot
  readonly now: number
  /** A trigger Goal's own status: its named waits and its stop reason live here, on this one line. */
  readonly triggerStatus: TriggerGoalStatus | null
  /** A stop reason for a run this Goal's own trigger never opened — a flow a person started. */
  readonly flowExecution: FlowExecution | null
  /** The header chip's own "Needs you" rule, beyond a member's pending approval — one rule, read by both surfaces. */
  readonly needsYou: boolean
  readonly room: string
  /** Overview keeps the Run's reason even when another live fact takes precedence. */
  readonly includeRunReason?: boolean
  /** Overview already reads these turns as Stopping on its current-step line. */
  readonly stoppingSessions?: ReadonlySet<SessionKey>
}) => {
  const store = useStore()
  const runReason = includeRunReason && flowExecution?.reason ? sentence(runReasonWords(flowExecution.reason, flowExecution.document.flow.rules)) : null
  let reasonOnLiveLine = false
  /*
   * The primary line, exactly as before, wrapped so a pending release's own
   * sentence — computed below, independent of which branch here fired — can
   * follow it rather than compete with it for the same line (review #1050
   * finding 3, round 3: the sentence must reach the screen whatever this run's
   * state is, and every branch below answers a different state).
   */
  const primary = (() => {
    /* Every member with a question for you now, roster order — not only the
       first. One is shown; the rest are counted on it and named in full on
       hover, the same rule the run's other waits already keep below. */
    const allWaiting = members.filter((one) => snapshot.approvals.some((entry) => entry.key === one.key))
    const waiting = allWaiting[0]
    /* The order a person needs them in: a member holding a question for you
       now; what else the run is waiting on, a person first; why the run
       stopped; and only then who is merely working. One line — the rest of the
       run's waits are counted on it, and named in full on its hover. */
    const waits = openTriggerWaits(triggerStatus)
    /* A stop reason from either source, said once: the host's own `detail` is
       already a full sentence (`Out of budget: …`, `Timed out: …`) with the
       label baked in, so it is shown alone rather than after
       `intakeStopWords`'s own label — which is only a fallback for a stop with
       no detail to give. A flow a person started carries no `TriggerGoalStatus`
       at all, so its own `reason` is read directly once there is no trigger
       stop to prefer. */
    const stopText = triggerStatus?.budget?.stop
      ? triggerStatus.budget.stop.detail || intakeStopWords(triggerStatus.budget.stop.reason)
      : flowExecution?.state === 'stopped' && flowExecution.reason
        ? sentence(runReasonWords(flowExecution.reason, flowExecution.document.flow.rules))
        : null
    /* The header's own chip (`runState`, above) answers "Needs you" before
       "Stopped" — a person wait, the Goal's own activity or a stalled run all
       outrank a stop the run has already settled into, because each is the
       more urgent fact. `needsYou` is that exact same rule, computed once by
       `TeamRoomPane` and handed down here, so the live line skips the stop
       line under precisely the conditions that moved the header off "Stopped"
       — never a narrower or wider one — and the two surfaces cannot disagree
       about the same run. */
    if (flowExecution?.state === 'stopped' && stoppingSessions?.size) {
      return <TurnWorkLive settled data-slot="room-live-line" data-kind="stop">Stopping</TurnWorkLive>
    }
    if (!waiting && stopText && !needsYou) {
      reasonOnLiveLine = stopText === runReason
      return (
        <TurnWorkLive settled data-slot="room-live-line" data-kind="stop">
          {stopText}
        </TurnWorkLive>
      )
    }
    if (!waiting && waits.length > 0) {
      const wait = waits[0]!
      reasonOnLiveLine = sentence(wait.sentence) === runReason
      const open = wait.action === 'open-usage' || wait.action === 'open-trigger'
        ? () => store.askSettings('workspaces', wait.action === 'open-trigger' ? triggerRootOf(snapshot, room) : 'triggers')
        : wait.action === 'open-permissions'
          ? () => store.askSettings('permissions', 'ceilings')
          : null
      return (
        <TurnWorkLive
          settled
          data-slot="room-live-line"
          data-kind="wait"
          title={waits.length > 1 ? waits.map((one) => one.sentence).join('\n') : undefined}
          /* The way to act on it sits beside the words, outside the region: a
             control is not news. */
          {...(open ? { trail: <Button variant="link" size="inline" onClick={open}>Open</Button> } : {})}
        >
          {wait.waitingOn.kind === 'person' && <Dot state="limit" pulse />}
          <span>
            {wait.sentence}
            {waits.length > 1 && ` · ${waits.length - 1} more`}
          </span>
        </TurnWorkLive>
      )
    }
    /* A stalled run waits on a person as surely as a question does, and its
       reason is the only place that says why and what to do next — a Seat that
       would not open, the siblings its round held back with it. The header
       said "Needs you" and nothing here said for what, so the one visible way
       on was a card's own "Give this to…". Its lines are kept as written.
       An answer its Seat would not take is kept on the run, and sending it
       again is this line's own way on (#998). When that cannot work — the
       Seat is gone, the card finished — the action stays, greyed, and the
       line says why: a control that vanished would say nothing at all. */
    if (!waiting && flowExecution?.state === 'stalled' && flowExecution.reason && (includeRunReason || flowExecution.keptAnswer)) {
      reasonOnLiveLine = true
      const kept = flowExecution.keptAnswer
      const trail = kept ? (
        <Button
          variant="link"
          size="inline"
          disabled={!kept.canContinue}
          title={kept.refusal ?? `Sends “${kept.answer}” to the Seat for card #${kept.card} again.`}
          onClick={() => void store.continueFlowAnswer(flowExecution.id)}
        >
          Continue with this answer
        </Button>
      ) : null
      return (
        <TurnWorkLive settled data-slot="room-live-line" data-kind="stall" {...(trail ? { trail } : {})}>
          <Dot state="limit" pulse />
          <span className="whitespace-pre-line">
            {includeRunReason ? sentence(runReasonWords(flowExecution.reason, flowExecution.document.flow.rules)) : 'Your answer is kept on this Run.'}
            {kept?.refusal ? ` ${sentence(kept.refusal)}` : ''}
          </span>
        </TurnWorkLive>
      )
    }
    const busy = waiting ? null : members.find((one) => one.busy && !stoppingSessions?.has(one.key)) ?? null
    const subject = waiting ?? busy
    if (!subject) return null
    const session = snapshot.sessions.get(subject.key)
    const turn = session ? currentTurn(session) : undefined
    const elapsed = !waiting && turn ? elapsedSince(turn.startedAt, now) : null
    /* One voice for the tail: every line is the transcript's own live line,
       at its size and in its ink. Working is motion, so its words shimmer, and
       its clock ticks beside them, outside the live region — a screen reader
       hears who is working when that changes, never the seconds. A line that
       waits on a person is a state, not motion, and leads with the one light
       the tail has, the pulsing one the header's "Needs you" chip wears: a
       leading light here always means you are needed. */
    if (!waiting) {
      return (
        <TurnWorkLive
          data-slot="room-live-line"
          {...(elapsed !== null ? { trail: ` · ${formatDuration(elapsed)}` } : {})}
        >
          <MemberName
            name={subject.peer.nickname}
            tint={subject.tint}
            mark={subject.brand ? <BrandMark brand={subject.brand} size={10} /> : <AgentIcon size={10} />}
          />{' '}
          is working
        </TurnWorkLive>
      )
    }
    return (
      <TurnWorkLive
        settled
        data-slot="room-live-line"
        title={allWaiting.length > 1 ? allWaiting.map((one) => one.peer.nickname).join('\n') : undefined}
      >
        <Dot state="limit" pulse />
        <span>
          <MemberName
            name={subject.peer.nickname}
            tint={subject.tint}
            mark={subject.brand ? <BrandMark brand={subject.brand} size={10} /> : <AgentIcon size={10} />}
          />{' '}
          is waiting for your approval
          {allWaiting.length > 1 && ` · ${allWaiting.length - 1} more`}
        </span>
      </TurnWorkLive>
    )
  })()
  /*
   * A release waiting on a Seat's turn to end says so on a line of its own,
   * whatever the run above it is doing — stopped, settled, stalled, or a
   * trigger's own stop — because none of those branches above ever reads
   * this field, and a stopped run started by a trigger shows the trigger's
   * own stop line in `stopText`, never this run's `reason` (review #1050
   * finding 3, round 3).
   */
  const pendingNote = flowExecution?.pendingReleaseNote ?? null
  const extraReason = runReason && !reasonOnLiveLine && (!pendingNote || sentence(pendingNote) !== runReason)
  if (!pendingNote && !extraReason) return primary
  return (
    <>
      {primary}
      {extraReason && <TurnWorkLive settled data-slot="room-run-reason" data-kind="reason">
        <span className="whitespace-pre-line">{runReason}</span>
      </TurnWorkLive>}
      {pendingNote && <TurnWorkLive settled data-slot="room-pending-release-line" data-kind="pending-release">
        <span className="whitespace-pre-line">{sentence(pendingNote)}</span>
      </TurnWorkLive>}
    </>
  )
}

/** The project a trigger Goal's room belongs to — what "open its trigger" opens. */
const triggerRootOf = (snapshot: AppSnapshot, room: string): string | null =>
  snapshot.goals.get(room)?.goal.root ?? snapshot.teams.get(room)?.root ?? null

/**
 * The composer's own footer: a small meter ring, filled with what is left —
 * the app's own convention, kept here too — plus the reading it rounds away.
 * Hovering opens the exact numbers: spend, rounds and time, each as used of
 * its own total, and the one footnote a trigger's budget always carries.
 */
export const BudgetFooter = ({ state, now }: { readonly state: TriggerBudgetState; readonly now: number }) => {
  const words = budgetMeterWords(state, now)
  /* Brand ink while there is plenty left, like the context ring: in grey a
     full 14px ring was the track's own colour one step darker, and read as
     an empty outline at the very moment it was full. */
  const tone: Tone = words.percentLeft === null ? 'neutral' : words.percentLeft <= 0 ? 'danger' : words.percentLeft < 20 ? 'warning' : 'brand'
  /* A spend the host cannot read is not nothing spent: the host stops the run
     on it (`budgetRefusal`), so the meter says so — an unfilled, dashed ring
     and "Spend unknown" — rather than a full ring and the whole budget left. */
  const reading = words.leftUsd === null ? 'Spend unknown' : `${formatMeterUsd(words.leftUsd)} left`
  return (
    <div data-slot="room-budget" className="mt-2 flex items-center justify-end gap-(--hd-space-2)">
      <InfoCard
        trigger={<Button variant="ghost" size="chip"><ProgressRing value={words.percentLeft} size={14} tone={tone} label="Budget left" /><Text role="meta">{reading}{words.roundNow !== null && ` · Round ${words.roundNow} of ${words.roundsTotal}`}</Text></Button>}
        title="Run budget"
        side="top"
        align="end"
        rows={[
          { id: 'spend', label: 'Spend', value: `${words.spentUsd === null ? 'Unknown' : formatMeterUsd(words.spentUsd)} of ${formatMeterUsd(words.totalUsd)}` },
          ...(words.roundNow === null ? [] : [{ id: 'round', label: 'Round', value: `${words.roundNow} of ${words.roundsTotal}` }]),
          { id: 'time', label: 'Time', value: `${words.minutesUsed} of ${words.minutesTotal} min` },
        ]}
        notes={[words.spentUsd === null ? 'The run stops while its spend cannot be read.' : state.budget.withoutProgress === 1 ? 'Stops after a round with no progress.' : `Stops after ${state.budget.withoutProgress} rounds with no progress.`]}
      />
    </div>
  )
}

const Room = ({
  onMessaging,
  messagingReason,
  room,
  draftState,
  composerRef,
  trouble,
  onTrouble: setTrouble,
  members,
  loaded,
  onShow,
  pendingApproval,
  triggerStatus,
  flowExecution,
  needsYou,
}: {
  readonly room: string
  readonly onMessaging: () => Promise<void>
  readonly messagingReason?: string
  readonly draftState: RoomComposerDraftState
  readonly composerRef: RefObject<RoomComposerHandle | null>
  readonly trouble: string | null
  readonly onTrouble: (message: string | null) => void
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
  /**
   * The one member (if any) waiting on a person right now — the same fact
   * `TeamRoomPane`'s own header chip pulses for. While it is set, this
   * member's own `Approvals` takes the composer's slot; answering it, either
   * way, is what clears it and brings the composer back.
   */
  readonly pendingApproval: Member | null
  /** For the composer's own budget meter — null off a plain room, or a Goal a person started. */
  readonly triggerStatus: TriggerGoalStatus | null
  /** For the live line's stop reason, on a run this Goal's own trigger never opened. */
  readonly flowExecution: FlowExecution | null
  /** The rest of the header's own "Needs you" rule, beyond a member's pending approval — see `TeamRoomPane`'s own `needsYou`. */
  readonly needsYou: boolean
}) => {
  const store = useStore()
  const snapshot = useSnapshot()
  /* The composer's own handle. The room has one surface that addresses a
     member from outside the box — a name card on a message, offering
     Message — and this is where it lands. */
  const composer = composerRef
  /* A tick every second, for the two readings on this page that move on
     their own between board mutations: the live line's elapsed seconds, and
     the budget meter's minutes. Local to the room, not a shared clock —
     nothing outside this page needs a second hand this fine. */
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [])
  /* The slot the composer and the card share, and whether focus is in it.
     The card takes the focus only from the composer it replaces — a person
     typing in the sidebar, the rail's filter or another pane keeps theirs —
     and it is read at the render the approval arrives in, before the card
     exists to take anything. Keyed by the approval's own id, so two in a row
     for the same member are two arrivals. */
  const slot = useRef<HTMLDivElement>(null)
  const pendingId = pendingApproval
    ? snapshot.approvals.find((entry) => entry.key === pendingApproval.key)?.approval.id ?? null
    : null
  const takeFocus = useMemo(() => {
    if (pendingId === null) return false
    const at = typeof document === 'undefined' ? null : document.activeElement
    return Boolean(at && at !== document.body && slot.current?.contains(at))
    // eslint-disable-next-line react-hooks/exhaustive-deps -- read once per arrival, on purpose
  }, [pendingId])
  /* The approval cleared — answered, either way. Focus goes back to the
     composer only if the card took it from there and the person has not
     since put it somewhere else: the card's answer button vanishing leaves
     it on the page itself, and that is the only case this hands it back. */
  const tookFocus = useRef(false)
  const lastApproval = useRef<string | null>(null)
  useEffect(() => {
    if (pendingId !== null) tookFocus.current = takeFocus
    else if (lastApproval.current !== null && tookFocus.current) {
      tookFocus.current = false
      const at = document.activeElement
      if (!at || at === document.body) composer.current?.focus()
    }
    lastApproval.current = pendingId
  }, [pendingId, takeFocus])

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
      return <>
        <MemberHoverCard source="member" member={cardFacts(entry)}>{node}</MemberHoverCard>
        <SubjectActionsMenu label={entry.peer.nickname} actions={[
          { label: 'Open', onSelect: () => onShow(entry.key) },
          { label: 'Message', onSelect: () => composer.current?.address(entry.key) },
        ]} />
      </>
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
        <PaneColumn
          ref={stream}
          inset="reading"
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
                variant="inline" align="start"
                title={messaging ? <span title="The agents in this room can message each other and you. Signals — a claim, a completion — land here too.">Nothing said yet</span> : 'Nothing said yet. Board-only: agents may claim and signal, but not message. Turn messaging back on in Send to.'}
              />
            ) : (
              <ChannelStream
                entries={entries}
                room={room}
                onTrouble={setTrouble}
                /* The same member card the rail draws, off the same roster —
                   so the chat and the rail can never disagree about whether an
                   agent can take a job. A speaker who has since left the room
                   finds no entry and gets no card, which is honest: the row
                   still reads, and there is nothing current to say. */
                identify={identify}
              />
            )}
          </div>
        </PaneColumn>
        {behind.rows > 0 && (
          /* "messages" only when that is all they are. A batch with a claim or
             a completion in it takes the plainer word, because a signal is not
             a message and a pill that says it is teaches the reader to distrust
             the count. */
          <Button type="button" variant="outline" size="chip" className={styles.behind} onClick={toFloor}>
            {behind.onlyMessages
              ? behind.rows === 1
                ? '1 new message'
                : `${behind.rows} new messages`
              : behind.rows === 1
                ? '1 new update'
                : `${behind.rows} new updates`}
          </Button>
        )}
      </div>

      {/* The conversation's composer dock, not a lookalike: the same inset
          off the pane's edge (`ComposerDock`), the same shell, the same 14px
          text well, the same ghost anchor on the left and the same round
          accent coin on the right — down to the weight that coin takes when
          the host will hold the message until a turn ends. It sits one click
          from the individual composer inside this very pane, and two boxes
          that nearly match read worse than two that plainly differ. What is
          different is what is genuinely different: the audience, which lives
          with the words because choosing it is part of writing the message. */}
      <ComposerDock>
        {/* The thread's own failures, docked with the composer in the same
            reading column the stream hangs in (its live line is the first
            line of the composer's tail, below). `problem` is the host's:
            it could not keep the board, so what is on screen may not survive
            a restart — the person needs to know before they act on it.
            `trouble` is this surface's: the last thing you pressed did not
            land. */}
        <div className={styles.tail}>
          {/* A failure is the conversation's own drawing for an action
              that did not land in the tail: one role, one drawing. */}
          {problem && <ActionError>{problem}</ActionError>}
          {trouble && <ActionError>{trouble}</ActionError>}
        </div>
        {/* The reading column, the same one the stream above hangs in. The
            wrapper rather than a prop: `RoomComposer` draws the shell and
            knows nothing about how wide the pane it sits in is, which is the
            caller's business — exactly as `.streamColumn` is. */}
        <div ref={slot} className={styles.composerShell}>
          {pendingApproval && (
            /* The composer's own slot, taken by whichever member is waiting
               on a person — the same `Approvals` a conversation's own pane
               draws, docked: a card in flow where the composer stood, as
               wide as it, with the thread above left whole and readable. No
               scrim, no blur, not a dialog — the room is everyone's
               conversation, and one member's question does not cover it.
               `team-room:` as the pane id's root is `useIsFocusedPane`'s own
               exception for this surface (see the per-member column below,
               which reads the same way): answering an approval here must not
               depend on bookkeeping meant for a split of panes this page does
               not have. Answering it, either way, clears `pendingApproval`
               and brings this composer back, focused — the effect above. */
            <PaneProvider
              scope={{
                paneId: `team-room:approval:${pendingApproval.key}`,
                view: { kind: 'conversation', session: pendingApproval.key },
                sessionKey: pendingApproval.key,
              }}
            >
              <Approvals placement="docked" takeFocus={takeFocus} />
            </PaneProvider>
          )}
          {/* Mounted whatever holds the slot, and only hidden under the
              card (`suspended`): an approval arriving mid-sentence must not
              throw away the words or the audience being written — they are
              this component's own state, and unmounting it was the loss.
              The live line rides in with it (`statusLine`) so the tail over
              the box is one strip, and it stays visible under an approval,
              where it says who is waiting. */}
          <RoomComposer
            /* Keyed by the room, so moving between rooms is a new box rather
               than the old one being talked out of its state. The audience
               prunes itself against the new roster either way, but the
               *words* would have come along — a half-written line to one
               room appearing in another, one keystroke from being sent
               there. */
            key={room}
            ref={composer}
            room={room}
            draftState={draftState}
            members={loaded ? members : null}
            messaging={messaging}
            onMessaging={onMessaging}
            messagingReason={messagingReason}
            statusLine={<RoomLiveLine members={members} snapshot={snapshot} now={now} triggerStatus={triggerStatus} flowExecution={flowExecution} needsYou={needsYou} room={room} />}
            suspended={pendingApproval !== null}
            /* The same card the rail and the chat draw, off the same one
               reader. `Open` is the only verb worth offering on a chip: the
               member is already addressed, so Message would be the greyed
               verb the card refuses to draw, and removing them is the ✕ they
               already carry. */
            card={(key, node) => {
              const entry = members.find((one) => one.key === key)
              if (!entry) return node
              return <>
                <MemberHoverCard source="member" member={cardFacts(entry)}>{node}</MemberHoverCard>
                <SubjectActionsMenu label={entry.peer.nickname} actions={[{ label: 'Open', onSelect: () => onShow(entry.key) }]} />
              </>
            }}
            onTrouble={setTrouble}
            onPosted={toFloor}
          />
          {/* The footer strip stays put under whichever of the two holds the
              slot: what a run has left to spend is as true while it waits on
              a person as while it works. */}
          {triggerStatus?.budget && <BudgetFooter state={triggerStatus.budget} now={now} />}
        </div>
      </ComposerDock>
    </>
  )
}
