import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'

import { activityOf, flowStepOf, placeCard, type BoardEvidence, type FlowExecution, type FlowPolicy, type Intent, type Session, type TeamState } from '@harnessdesk/protocol'

import { BrowserPane } from '../../components/BrowserPane'
import { Composer } from '../../components/Composer'
import { FilePane } from '../../components/FilePane'
import { Conversation } from '../../components/Conversation'
import { GitPane } from '../../components/GitPane'
import { SignIn } from '../../components/SignIn'
import { Sidebar } from '../../components/Sidebar'
import { TeamBoardPane } from '../../components/TeamBoardPane'
import { TeamRoomPane } from '../../components/TeamRoomPane'
import { Chip, Switch, Text } from '..'
import { TerminalSurface as TerminalPane } from '../../components/TerminalPane'
import { Usage } from '../../components/Usage'
import { MountProvider } from '../../panels/mount'
import { Workbench } from '../../panels/Workbench'
import { dock, emptyWorkbench } from '../../state/workbench'
import { PaneProvider } from '../../state/context'
import type { AppStore } from '../../state/store'
import { Mount, PREVIEW_ROOM, PREVIEW_SESSION_KEY, previewStore } from '../../preview/harness'
import { cardEvidence, checkView, EVIDENCE_ROOM } from '../../preview/evidence-fixture'
import { PREVIEW_FLOW_CARD, sceneFlowExecution } from '../../preview/flow-fixture'
import { PREVIEW_FLOW_GOAL } from '../../preview/goal-fixture'
import { denseTurns, PREVIEW_ROOT, previewHistory, previewSession } from '../../preview/sidebar-fixture'
import { SIGN_IN_SELECTED, signInSeed } from '../../preview/signin-fixture'
import styles from './surfaces.module.css'

const PERSON_REVIEW_ROOM = 'room-person-review'
const personCheck = checkView({ card: 2 })
const personReviewCandidate = {
  id: 'preview-person-review-candidate',
  card: 2,
  at: 'abcdef0123456789abcdef0123456789abcdef01',
  branch: 'attempt-one',
  evidence: [personCheck.record.id],
  holder: 'Implementer',
}
const personReviewExecution: FlowExecution = {
  version: 2,
  id: 'preview-person-review-run',
  goal: PERSON_REVIEW_ROOM,
  document: {
    format: 'agents',
    flow: {
      version: 2, name: 'Comparison', inputs: [], messaging: 'board-only', wait: 240,
      roles: [
        { id: 'competitor', kind: 'agent', uses: ['implementer'], seats: [], isolate: true, grant: 'edit', independentOf: [] },
        { id: 'judge', kind: 'person', outcomes: ['picked'] },
        { id: 'referee', kind: 'person', outcomes: ['merged'] },
      ],
      rules: [{ id: 'to-referee', on: 'judge', when: { every: ['picked'], evidence: [{ review: 'picked' }] }, then: { role: 'referee', title: 'Merge the picked attempt' } }],
      seed: { role: 'competitor', title: 'Implement the task' },
    },
  },
  state: 'running',
  rounds: [
    { n: 1, role: 'competitor', cards: [2], seats: [], evidence: [], state: 'closed', cause: 'seed' },
    { n: 2, role: 'judge', cards: [1], seats: [], evidence: [], state: 'running', cause: 'after:1:judge' },
  ],
  operations: [],
  legacyRun: null,
  reason: null,
}
const personJudgeCard: Intent = {
  id: 1, title: 'Pick the best attempt', detail: null, state: 'open', role: 'judge', files: [], dependsOn: [2],
  claim: null, blockedReason: null, handoff: null, note: null, createdAt: 1, updatedAt: 1,
}
const personAttemptCard: Intent = {
  id: 2, title: 'Implement the task', detail: null, state: 'done', role: 'competitor', files: [], dependsOn: [],
  outcome: 'pass', claim: null, blockedReason: null, handoff: null, note: null, createdAt: 1, updatedAt: 1,
}
const personReviewTeam: TeamState = {
  id: PERSON_REVIEW_ROOM, name: 'Comparison preview', root: PREVIEW_ROOT, updatedAt: 1, members: [], messaging: true,
  intents: [personJudgeCard, personAttemptCard], channel: [],
}
const personReviewEvidence: BoardEvidence = {
  room: PERSON_REVIEW_ROOM, stamp: 1, checks: ['verify'], refused: [], unreadable: null,
  cards: [cardEvidence(2, [personCheck])],
}
const personReviewBase = previewStore().getSnapshot()
const personReviewTeams = new Map(personReviewBase.teams).set(PERSON_REVIEW_ROOM, personReviewTeam)
const personReviewEvidenceByRoom = new Map(personReviewBase.boardEvidence).set(PERSON_REVIEW_ROOM, personReviewEvidence)
const personReviewExecutions = new Map(personReviewBase.flowExecutions).set(personReviewExecution.id, personReviewExecution)
const personReviewBoardStore = new Proxy(previewStore({
  teams: personReviewTeams,
  boardEvidence: personReviewEvidenceByRoom,
  flowExecutions: personReviewExecutions,
}), {
  get(target, property, receiver) {
    if (property === 'flowReviewCandidates') return async () => [personReviewCandidate]
    if (property === 'decideFlowReview') return async () => { throw new Error('The preview shows the chooser without recording a review.') }
    return Reflect.get(target, property, receiver)
  },
})

/** The synthetic board state used in the preview and the design catalogue. */
export const PersonReviewBoard = () => (
  <Mount with={personReviewBoardStore}>
    <TeamBoardPane room={PERSON_REVIEW_ROOM} />
  </Mount>
)

/**
 * The catalogue's whole-screen entries — each one the screen the app ships.
 *
 * Every board above this file shows a *part*: a button in its sizes, a dialog
 * in its states. These answer the question a part cannot, which is whether the
 * set of parts makes a screen. For a long time they answered it with drawings
 * — a `ConversationPage` beside the real `Conversation`, a `GitHistoryPage`
 * beside the real `GitPane` — and a drawing can only ever be right on the day
 * it is drawn. Change the shipped conversation and the catalogue kept showing
 * the old one, confidently, in every palette.
 *
 * So there is nothing here but a frame and a mount. The screen is imported
 * from `components/`, it brings its own stylesheet, and it renders through the
 * same store stub `/preview.html` uses (`preview/harness`) because a screen
 * without a store does not render a simpler version of itself — it throws.
 * `script/check-ui-system.mjs` holds this: every surface row in the catalogue
 * names the shipped module it mounts — a screen in `components/`, or the
 * workbench in `panels/` — and the check walks the import graph from that
 * row's own export here, not from this file: walked from the file, a surface
 * that stopped mounting its screen passed on a sibling that mounts the same
 * one. The explorer tab for the row has to load that export, too.
 *
 * The frames are the only judgement this file makes, and they are about room
 * rather than looks — see `surfaces.module.css`.
 */

const Frame = ({
  height = 'pane',
  children,
}: {
  height?: 'pane' | 'page' | 'window'
  children: ReactNode
}) => (
  <div className={styles.frame} data-height={height}>
    {children}
  </div>
)

/**
 * A store whose `s1` session carries a status, a ceiling or an approval the
 * fixture's own does not, built from a fresh default store rather than the
 * shared one `previewStore()` exports — so a failed case here cannot leave
 * the module's own `store` failed for every other board that imports it.
 */
const conversationStatusStore = (over: {
  status?: unknown
  approvals?: unknown
  /** Strip the fixture's own ceiling — the plain path idle demonstrates. */
  noCeiling?: boolean
}): AppStore => {
  const base = previewStore().getSnapshot()
  const sessions = new Map(base.sessions)
  const session = sessions.get(PREVIEW_SESSION_KEY)
  if (session) {
    const settings = over.noCeiling
      ? { ...(session as never as { settings: Record<string, unknown> }).settings, ceiling: undefined, ceilingNote: undefined }
      : (session as never as { settings: unknown }).settings
    sessions.set(PREVIEW_SESSION_KEY, {
      ...session,
      ...(over.status !== undefined ? { status: over.status } : {}),
      settings,
    } as never)
  }
  return previewStore({
    sessions,
    ...(over.approvals !== undefined ? { approvals: over.approvals as never } : {}),
  } as never)
}

const IDLE_STORE = conversationStatusStore({ noCeiling: true })
const RUNNING_STORE = conversationStatusStore({ status: { type: 'active' } })
const FAILED_STORE = conversationStatusStore({ status: { type: 'error' } })
const WAITING_STORE = conversationStatusStore({
  approvals: [{
    key: PREVIEW_SESSION_KEY,
    approval: {
      id: 'catalog-waiting-approval', type: 'command', kind: 'shell', command: 'pnpm test',
      cwd: PREVIEW_ROOT, reason: 'Runs the project’s tests before the review is written.',
      options: [
        { id: 'yes', label: 'Allow', intent: 'approve' },
        { id: 'always', label: 'Allow for this session', intent: 'approveAlways' },
        { id: 'no', label: 'Deny', intent: 'deny' },
      ],
    },
  }],
})

/**
 * One header case: a caption naming what it proves, a frame cropped to
 * exactly the bar's own height — border included — so nothing from the
 * transcript or the composer shows, and a `data-testid` a browser spec can
 * reach directly rather than searching the tab for the Nth header.
 *
 * The crop alone is not enough: the composer dock is `position: absolute;
 * bottom: 0` of the real screen mounted underneath, not of this frame, so a
 * short frame pulls it up over the header rather than hiding it below the
 * fold. `surfaces.module.css` hides it for this one data-height value only —
 * the one place in this directory a screen's own part is suppressed, and
 * only because the frame around it, not the screen, is what is short here.
 */
const HeaderCase = ({
  id,
  label,
  width,
  children,
}: {
  id: string
  label: string
  width?: number
  children: ReactNode
}) => (
  <div className={styles.headerCase} data-testid={id}>
    <span className={styles.headerCaseLabel}>{label}</span>
    <div className={styles.frame} data-height="header" style={width ? { width } : undefined}>
      {children}
    </div>
  </div>
)

/**
 * The conversation, scoped exactly the way the workbench scopes it.
 *
 * `PaneProvider` is not decoration here: the transcript reads its session from
 * the pane, and the composer under it asks whether its pane has focus. Mount
 * it without one and you are looking at a branch the app never shows.
 *
 * Below the full conversation, the header alone, in the states the fixture
 * above cannot show at once: idle on the plain path (no ceiling — a resting
 * status says nothing its absence does not, and this is the one case that
 * shows it), the ceiling chip named on its own, running with its brand dot,
 * waiting for an approval, failed, and the phone-width fold. Each still
 * mounts the real `Conversation` — only the frame around it is shorter, or
 * narrower, than the one above.
 */
export const ConversationSurface = () => (
  <>
    <Mount>
      <Frame height="page">
        <PaneProvider
          scope={{
            paneId: 'design' as never,
            view: { kind: 'conversation', session: PREVIEW_SESSION_KEY } as never,
            sessionKey: PREVIEW_SESSION_KEY,
          }}
        >
          <Conversation
            onChooseProject={() => {}}
            onSignIn={() => {}}
            onOpenUsage={() => {}}
            onOpenRuntimes={() => {}}
          />
        </PaneProvider>
      </Frame>
    </Mount>
    <div className={styles.headerCases}>
      <HeaderCase id="conversation-header-idle" label="Idle">
        <Mount with={IDLE_STORE}>
          <PaneProvider
            scope={{
              paneId: 'design-idle' as never,
              view: { kind: 'conversation', session: PREVIEW_SESSION_KEY } as never,
              sessionKey: PREVIEW_SESSION_KEY,
            }}
          >
            <Conversation onChooseProject={() => {}} onSignIn={() => {}} onOpenUsage={() => {}} onOpenRuntimes={() => {}} />
          </PaneProvider>
        </Mount>
      </HeaderCase>
      <HeaderCase id="conversation-header-ceiling" label="Ceiling chip (Read · held)">
        <Mount>
          <PaneProvider
            scope={{
              paneId: 'design-ceiling' as never,
              view: { kind: 'conversation', session: PREVIEW_SESSION_KEY } as never,
              sessionKey: PREVIEW_SESSION_KEY,
            }}
          >
            <Conversation onChooseProject={() => {}} onSignIn={() => {}} onOpenUsage={() => {}} onOpenRuntimes={() => {}} />
          </PaneProvider>
        </Mount>
      </HeaderCase>
      <HeaderCase id="conversation-header-running" label="Running — neutral pill, brand dot">
        <Mount with={RUNNING_STORE}>
          <PaneProvider
            scope={{
              paneId: 'design-running' as never,
              view: { kind: 'conversation', session: PREVIEW_SESSION_KEY } as never,
              sessionKey: PREVIEW_SESSION_KEY,
            }}
          >
            <Conversation onChooseProject={() => {}} onSignIn={() => {}} onOpenUsage={() => {}} onOpenRuntimes={() => {}} />
          </PaneProvider>
        </Mount>
      </HeaderCase>
      <HeaderCase id="conversation-header-waiting" label="Waiting for you">
        <Mount with={WAITING_STORE}>
          <PaneProvider
            scope={{
              paneId: 'design-waiting' as never,
              view: { kind: 'conversation', session: PREVIEW_SESSION_KEY } as never,
              sessionKey: PREVIEW_SESSION_KEY,
            }}
          >
            <Conversation onChooseProject={() => {}} onSignIn={() => {}} onOpenUsage={() => {}} onOpenRuntimes={() => {}} />
          </PaneProvider>
        </Mount>
      </HeaderCase>
      <HeaderCase id="conversation-header-failed" label="Failed">
        <Mount with={FAILED_STORE}>
          <PaneProvider
            scope={{
              paneId: 'design-failed' as never,
              view: { kind: 'conversation', session: PREVIEW_SESSION_KEY } as never,
              sessionKey: PREVIEW_SESSION_KEY,
            }}
          >
            <Conversation onChooseProject={() => {}} onSignIn={() => {}} onOpenUsage={() => {}} onOpenRuntimes={() => {}} />
          </PaneProvider>
        </Mount>
      </HeaderCase>
      <HeaderCase id="conversation-header-narrow" label="Phone width (≤400px container)" width={360}>
        <Mount>
          <PaneProvider
            scope={{
              paneId: 'design-narrow' as never,
              view: { kind: 'conversation', session: PREVIEW_SESSION_KEY } as never,
              sessionKey: PREVIEW_SESSION_KEY,
            }}
          >
            <Conversation onChooseProject={() => {}} onSignIn={() => {}} onOpenUsage={() => {}} onOpenRuntimes={() => {}} />
          </PaneProvider>
        </Mount>
      </HeaderCase>
    </div>
  </>
)

/**
 * A store of its own — `ConversationSurface`'s one turn never overflows, so
 * the rail it mounts stays hidden, and the shared default store cannot be
 * patched in place without moving that tab's own conversation out from under
 * it. `denseTurns` is the same fixture `?dense` gives the browser spec: 14
 * exchanges, long enough on their own to overflow a page-height frame without
 * any help.
 */
const denseSession = { ...previewSession, turns: denseTurns } as unknown as Session

/**
 * The conversation map at the pitch a real transcript reads at.
 *
 * `ConversationSurface`, above, has one exchange — two marks, the rail's
 * loosest case. Here there are fourteen: enough for the ~8px ruler the rail
 * only becomes once a transcript is actually long, rather than the wide
 * chip-like dashes two marks alone would still draw at this same width.
 */
export const ConversationMapDenseSurface = () => (
  <div data-testid="conversation-map-dense">
    <Mount with={previewStore({ sessions: new Map([[PREVIEW_SESSION_KEY, denseSession]]) })}>
      <Frame height="page">
        <PaneProvider
          scope={{
            paneId: 'design-map-dense' as never,
            view: { kind: 'conversation', session: PREVIEW_SESSION_KEY } as never,
            sessionKey: PREVIEW_SESSION_KEY,
          }}
        >
          <Conversation
            onChooseProject={() => {}}
            onSignIn={() => {}}
            onOpenUsage={() => {}}
            onOpenRuntimes={() => {}}
          />
        </PaneProvider>
      </Frame>
    </Mount>
  </div>
)

/**
 * The same dense transcript with the rail's own preview already open.
 *
 * Not a hover stood in by hand: a real `.focus()` right after mount, which
 * the rail already treats as the keyboard's — a script-driven focus with no
 * pointer interaction just before it matches `:focus-visible` the same way
 * Tab does — so this is a state the rail genuinely has, caught rather than
 * staged. Press Escape to close it, or Up/Down to move it, the same as
 * anywhere else the rail shows up.
 */
export const ConversationMapPreviewOpenSurface = () => {
  const scope = useRef<HTMLDivElement>(null)
  useEffect(() => {
    // The rail draws nothing until its own effect has measured the scroller
    // and found it overflows, a tick or two after this one mounts — so the
    // nav is not there to focus yet on the first pass. A short-lived
    // observer catches it the moment it is.
    const found = scope.current?.querySelector<HTMLElement>('nav[aria-label="Jump to a message"]')
    if (found) {
      found.focus()
      return
    }
    const node = scope.current
    if (!node) return
    const observer = new MutationObserver(() => {
      const rail = node.querySelector<HTMLElement>('nav[aria-label="Jump to a message"]')
      if (rail) {
        rail.focus()
        observer.disconnect()
      }
    })
    observer.observe(node, { childList: true, subtree: true })
    return () => observer.disconnect()
  }, [])
  return (
    <div ref={scope} data-testid="conversation-map-preview-open">
      <Mount with={previewStore({ sessions: new Map([[PREVIEW_SESSION_KEY, denseSession]]) })}>
        <Frame height="page">
          <PaneProvider
            scope={{
              paneId: 'design-map-preview' as never,
              view: { kind: 'conversation', session: PREVIEW_SESSION_KEY } as never,
              sessionKey: PREVIEW_SESSION_KEY,
            }}
          >
            <Conversation
              onChooseProject={() => {}}
              onSignIn={() => {}}
              onOpenUsage={() => {}}
              onOpenRuntimes={() => {}}
            />
          </PaneProvider>
        </Frame>
      </Mount>
    </div>
  )
}

/**
 * The composer alone, at the width the conversation column gives it.
 *
 * It is the one control a user touches every turn, and it is worth seeing
 * without the transcript above it competing for the judgement — but it is the
 * same module the transcript mounts, not a still of it.
 */
export const ComposerSurface = () => (
  <Mount>
    <Frame>
      <PaneProvider
        scope={{
          paneId: 'design' as never,
          view: { kind: 'conversation', session: PREVIEW_SESSION_KEY } as never,
          sessionKey: PREVIEW_SESSION_KEY,
        }}
      >
        <div className={styles.work} />
        <Composer onChooseProject={() => {}} />
      </PaneProvider>
    </Frame>
  </Mount>
)

/**
 * The sidebar at a window's width, with the work beside it standing in.
 *
 * A rail alone on a white page always looks fine; the only real question about
 * one is how much attention it takes from what it sits next to.
 */
export const RailSurface = () => (
  <Mount>
    <Frame height="page">
      <div className={`${styles.beside} h-full`}>
        <Sidebar
          onOpenSettings={() => {}}
          onOpenPlugins={() => {}}
          onOpenAgents={() => {}}
          onOpenUsage={() => {}}
          onBrowseFolders={() => {}}
          onSignIn={() => {}}
          onSearch={() => {}}
        />
        <div className={styles.work} />
      </div>
    </Frame>
  </Mount>
)

/**
 * A flow's Seats in the left bar: three of one role, one per agent, all
 * titled by the role — and one of them in a folder that has since gone.
 *
 * The role is the title every Seat of it carries, so at the default compact
 * density nothing but the agent tells the three rows apart. That name is a
 * word, so it is a chip on the title's own line, drawn only where rows from
 * more than one agent share a title — the untouched rows below show none.
 * The third Seat's worktree was deleted, so its row also wears the gone-folder
 * mark on the right rail. Seeded on a store of its own so the shared fixture
 * the other surfaces and `/preview.html` read is left as it is.
 */
const seatOf = (from: number, id: string, runtime: string) => ({
  ...previewHistory[from]!,
  id: id as never,
  runtime: runtime as never,
  title: 'Code reviewer',
})
const seatsHistory = [
  seatOf(0, 'seat-review-alpha', 'codex'),
  seatOf(1, 'seat-review-beta', 'claude'),
  seatOf(2, 'seat-review-gamma', 'cursor'),
  ...previewHistory.slice(5, 7),
]
const seatRowsStore = previewStore({
  history: seatsHistory,
  foldersGone: new Map([[previewHistory[2]!.cwd, 'This folder no longer exists.']]),
})

export const SeatRowsSurface = () => (
  <Mount with={seatRowsStore}>
    <Frame height="page">
      <div className={`${styles.beside} h-full`}>
        <Sidebar
          onOpenSettings={() => {}}
          onOpenPlugins={() => {}}
          onOpenAgents={() => {}}
          onOpenUsage={() => {}}
          onBrowseFolders={() => {}}
          onSignIn={() => {}}
          onSearch={() => {}}
        />
        <div className={styles.work} />
      </div>
    </Frame>
  </Mount>
)

/**
 * The repository pane: the graph, and the detail the graph opens.
 *
 * The pane reads its repository from where it is mounted — the root is the
 * view's, not the pane's — so without a `MountProvider` it has no repository
 * and draws an empty frame. That is what this surface showed for a while, and
 * nothing failed: a blank pane is a perfectly valid render.
 */
export const GitSurface = () => (
  <Mount>
    <Frame height="page">
      <MountProvider scope={{ area: 'main', id: 'design-git', view: { kind: 'git', root: PREVIEW_ROOT } }}>
        <GitPane />
      </MountProvider>
    </Frame>
  </Mount>
)

/**
 * A reviewer's card that already answered, in the same round as the Seat the
 * run is stopped on: it stays in Ready with its own outcome whatever the run
 * is doing now — never swept into Needs you beside a teammate who has not
 * answered yet (the fix for #996's placement rule doing exactly that).
 */
const APPROVED_REVIEW_CARD: Intent = {
  id: 2,
  title: 'Review the retry fix',
  detail: null,
  state: 'done',
  role: 'approver',
  outcome: 'approve',
  files: [],
  dependsOn: [],
  claim: null,
  blockedReason: null,
  handoff: null,
  note: 'Looks right — retries once, then surfaces the error.',
  createdAt: 1_799_000_000_000,
  updatedAt: 1_799_000_000_000,
}

/** The front-door Goal's board holding its Seat's card, under a run stopped on that Seat's question. */
const questionStopStore = (): AppStore => {
  const base = previewStore().getSnapshot()
  const goal = PREVIEW_FLOW_GOAL.goal.id
  const teams = new Map(base.teams)
  const board = teams.get(goal)
  const cards = [PREVIEW_FLOW_CARD, APPROVED_REVIEW_CARD]
  if (board) teams.set(goal, { ...board, intents: cards })
  /* A second, already-answered role on the same stalled run — the round that
     opened it long done — so the catalogue proves the rule on the case that
     broke it, not only on the one card `sceneFlowExecution` ships. */
  const baseExecution = sceneFlowExecution('question')
  // `FIX_DOCUMENT` is the 'agents'-format flow, whose roles are the simpler
  // `FlowPolicyRole` this scene's added person role also is — never the
  // legacy `FlowRole` the general `FlowExecution['document']` type also allows.
  const baseFlow = baseExecution.document.flow as FlowPolicy
  const execution: FlowExecution = {
    ...baseExecution,
    document: {
      format: 'agents',
      flow: {
        ...baseFlow,
        roles: [...baseFlow.roles, { id: 'approver', kind: 'person', outcomes: ['approve', 'reject'] }],
      },
    },
    rounds: [
      ...baseExecution.rounds,
      { n: 2, role: 'approver', cards: [APPROVED_REVIEW_CARD.id], seats: [], evidence: [], state: 'running', cause: 'seed' },
    ],
  }
  /* The Goal's activity derived as the host derives it — from the same card
     placement the board draws — never written in: a header and a board that
     disagreed would show here too. */
  const placements = cards.map((card) => {
    const step = flowStepOf(card, undefined, [execution])
    return placeCard({
      intent: card, evidence: undefined, stranded: false, holderWaits: false,
      forPerson: step?.kind === 'person', live: step?.live ?? false, runStopped: step?.stopped ?? false,
    })
  })
  const activity = activityOf(PREVIEW_FLOW_GOAL.goal, {
    needsYou: placements.some((one) => one.column === 'needs'), busy: false, liveFlow: true, cards, dependencies: [],
  })
  const goals = new Map(base.goals)
  goals.set(goal, { ...PREVIEW_FLOW_GOAL, activity })
  return previewStore({
    teams,
    goals,
    flowExecutions: new Map([['preview-flow-run', execution]]),
  })
}

const QUESTION_STOP_STORE = questionStopStore()

/**
 * The front-door Goal's run stalled on a round whose first Seat would not
 * open: both of the round's cards wait unclaimed, and the room's live line
 * carries the host's own reason — the refusal, the sibling held back, the way on.
 */
const seatRefusedStore = (): AppStore => {
  const base = previewStore().getSnapshot()
  const goal = PREVIEW_FLOW_GOAL.goal.id
  const waiting = { ...PREVIEW_FLOW_CARD, state: 'open' as const, claim: null }
  const cards = [waiting, { ...waiting, id: 2 }]
  const teams = new Map(base.teams)
  const board = teams.get(goal)
  if (board) teams.set(goal, { ...board, intents: cards })
  // Derived as the host derives it (`GoalPlane`), from the same placement the board draws.
  const execution = sceneFlowExecution('seat-refused')
  const placed = cards.map((card) => {
    const step = flowStepOf(card, undefined, [execution])
    return placeCard({
      intent: card, evidence: undefined, stranded: false, holderWaits: false,
      forPerson: step?.kind === 'person', live: step?.live ?? false, runStopped: step?.stopped ?? false,
    })
  })
  const activity = activityOf(PREVIEW_FLOW_GOAL.goal, {
    needsYou: placed.some((one) => one.column === 'needs'), busy: false, liveFlow: true, cards, dependencies: [],
  })
  const goals = new Map(base.goals)
  goals.set(goal, { ...PREVIEW_FLOW_GOAL, activity })
  return previewStore({
    teams,
    goals,
    flowExecutions: new Map([['preview-flow-run', execution]]),
  })
}

const SEAT_REFUSED_STORE = seatRefusedStore()

const keptAnswerStore = (scene: 'answer-kept' | 'answer-seat-gone'): AppStore =>
  previewStore({ flowExecutions: new Map([['preview-flow-run', sceneFlowExecution(scene)]]) })

const KEPT_ANSWER_STORE = keptAnswerStore('answer-kept')
const KEPT_ANSWER_SEAT_GONE_STORE = keptAnswerStore('answer-seat-gone')

/**
 * The front-door Goal's run stopped on its time budget while its Seat was
 * still busy: the card stays claimed, and the room's live line — beside
 * whatever it already says about the run having stopped — carries a second
 * line of its own for the release still waiting on that Seat's turn to end
 * (#1027).
 */
const pendingReleaseStore = (): AppStore => {
  const base = previewStore().getSnapshot()
  const goal = PREVIEW_FLOW_GOAL.goal.id
  const cards = [PREVIEW_FLOW_CARD]
  const teams = new Map(base.teams)
  const board = teams.get(goal)
  if (board) teams.set(goal, { ...board, intents: cards })
  const execution = sceneFlowExecution('pending-release')
  const placed = cards.map((card) => {
    const step = flowStepOf(card, undefined, [execution])
    return placeCard({
      intent: card, evidence: undefined, stranded: false, holderWaits: false,
      forPerson: step?.kind === 'person', live: step?.live ?? false, runStopped: step?.stopped ?? false,
    })
  })
  const activity = activityOf(PREVIEW_FLOW_GOAL.goal, {
    needsYou: placed.some((one) => one.column === 'needs'), busy: false, liveFlow: true, cards, dependencies: [],
  })
  const goals = new Map(base.goals)
  goals.set(goal, { ...PREVIEW_FLOW_GOAL, activity })
  return previewStore({
    teams,
    goals,
    flowExecutions: new Map([['preview-flow-run', execution]]),
  })
}

const PENDING_RELEASE_STORE = pendingReleaseStore()

/**
 * A group project: the board and the room that belongs to it, together.
 *
 * Apart they are two panes; together they are the claim the layout exists to
 * make — that a task names the harness holding it, and that the harness is one
 * press from the conversation where the work is happening.
 */
export const GroupSurface = () => (
  <>
    <div className={styles.headerCases}>
      <div className={styles.headerCase} data-testid="group-person-review-step">
        <span className={styles.headerCaseLabel}>A person judges a comparison by choosing one attempt</span>
        <Frame height="page">
          <PersonReviewBoard />
        </Frame>
      </div>
    </div>
    <Mount>
      <div className={styles.pair}>
        <Frame>
          <TeamBoardPane room={PREVIEW_ROOM} />
        </Frame>
        <Frame>
          <TeamRoomPane room={PREVIEW_ROOM} />
        </Frame>
      </div>
    </Mount>
    {/* A Goal whose run stopped on its Seat's unanswered question: the room's
        header says Needs you, and the board draws the Seat's card there and
        counts it — one rule, so the two never disagree. A second card, a
        reviewer who already answered on the same stalled run, stays in Ready
        with its outcome: a finished card is never swept in beside one that
        is not. */}
    <div className={styles.headerCases}>
      <div className={styles.headerCase} data-testid="group-run-stopped-on-a-question">
        <span className={styles.headerCaseLabel}>A run stopped on its Seat’s unanswered question — a finished card stays finished</span>
        <Mount with={QUESTION_STOP_STORE}>
          <div className={styles.pair}>
            <Frame>
              <TeamBoardPane room={PREVIEW_FLOW_GOAL.goal.id} />
            </Frame>
            <Frame>
              <TeamRoomPane room={PREVIEW_FLOW_GOAL.goal.id} />
            </Frame>
          </div>
        </Mount>
      </div>
      <div className={styles.headerCase} data-testid="group-run-stalled-on-a-seat">
        <span className={styles.headerCaseLabel}>A run stalled because one Seat of its round would not open</span>
        {/* The room alone, at the width its conversation needs: the live
            line is the tail of the room's chat, which a half-width frame
            folds away behind the room's own rail. */}
        <Mount with={SEAT_REFUSED_STORE}>
          <Frame>
            <TeamRoomPane room={PREVIEW_FLOW_GOAL.goal.id} />
          </Frame>
        </Mount>
      </div>
      <div className={styles.headerCase} data-testid="group-run-kept-answer">
        <span className={styles.headerCaseLabel}>A stalled run keeps an answer that can be sent again</span>
        <Mount with={KEPT_ANSWER_STORE}>
          <Frame><TeamRoomPane room={PREVIEW_FLOW_GOAL.goal.id} /></Frame>
        </Mount>
      </div>
      <div className={styles.headerCase} data-testid="group-run-kept-answer-seat-gone">
        <span className={styles.headerCaseLabel}>A kept answer whose Seat is gone stays visible and disabled</span>
        <Mount with={KEPT_ANSWER_SEAT_GONE_STORE}>
          <Frame><TeamRoomPane room={PREVIEW_FLOW_GOAL.goal.id} /></Frame>
        </Mount>
      </div>
      <div className={styles.headerCase} data-testid="group-run-stopped-with-a-release-pending">
        <span className={styles.headerCaseLabel}>A stopped run whose Seat is still busy names the pending release on a line of its own</span>
        <Mount with={PENDING_RELEASE_STORE}>
          <Frame>
            <TeamRoomPane room={PREVIEW_FLOW_GOAL.goal.id} />
          </Frame>
        </Mount>
      </div>
    </div>
  </>
)

/**
 * Every tool in the frame they share — the shipped panes, not a picture.
 *
 * This board is the argument that a browser, a terminal and an editor differ
 * only in what they genuinely are: the header, the mark, the subject line, the
 * tab strip and whether the body pads or bleeds are one component across all
 * of them. A drawing cannot make that argument, because a drawing draws the
 * header once and the argument is about six files agreeing.
 *
 * `MountProvider` rather than `PaneProvider`: a tool pane asks *where it is
 * mounted*, not which conversation it is about, and everything its header
 * offers — close, move, zoom — is the mount's rather than the pane's. Given
 * none, the panes render the branch the app never shows.
 */
const TOOL_AREA = 'main' as const

export const ToolsSurface = () => (
  <Mount>
    <div className={styles.pair}>
      <Frame>
        <MountProvider
          scope={{
            area: TOOL_AREA,
            id: 'design-browser',
            view: {
              kind: 'browser',
              tabs: [
                { id: 't1', url: 'http://localhost:5273/design.html', title: 'Design system' },
                { id: 't2', url: 'https://example.com', title: 'Example' },
              ],
              active: 't1',
              driven: 't1',
            },
          }}
        >
          <BrowserPane />
        </MountProvider>
      </Frame>
      <Frame>
        <MountProvider
          scope={{
            area: TOOL_AREA,
            id: 'design-file',
            view: { kind: 'file', path: 'packages/ui/src/lib/brands.ts', runtime: 'codex' as never },
          }}
        >
          <FilePane />
        </MountProvider>
      </Frame>
      <Frame>
        <MountProvider
          scope={{
            area: TOOL_AREA,
            id: 'design-terminal',
            view: {
              kind: 'terminal',
              terminalId: 'design-terminal',
              runtime: 'codex' as never,
              cwd: '/work/storefront',
            },
          }}
        >
          <TerminalPane />
        </MountProvider>
      </Frame>
    </div>
  </Mount>
)

/**
 * The panel system, as the app assembles it.
 *
 * `panels/Workbench.tsx`, the component the window renders, with a store of
 * its own. The app opens with every dock empty, which is the right default
 * and a useless one to judge docking by, so this store starts with the
 * Changes and Trajectory views in the right dock and a terminal in the
 * bottom — put there by `dock`, the function the app calls when you open a
 * view, so the tree is the one the app would build rather than one written
 * out by hand.
 *
 * The verbs are real too. Collapse, expand, move, split and resize are the
 * store's, and the harness answers each with the same pure function the
 * app's store does (`preview/harness.tsx`). What happens when you press
 * something here is what the app would do.
 */
const panelsStore = previewStore({
  workbench: (
    [
      ['right', { kind: 'changes' }],
      ['right', { kind: 'trajectory' }],
      [
        'bottom',
        { kind: 'terminal', terminalId: 'design-terminal', runtime: 'codex' as never, cwd: PREVIEW_ROOT },
      ],
    ] as const
  ).reduce((workbench, [area, view]) => dock(workbench, area, view), emptyWorkbench()),
})

export const PanelsSurface = () => (
  <Mount with={panelsStore}>
    <Frame height="page">
      <Workbench
        sidebar={
          <Sidebar
            onOpenSettings={() => {}}
            onOpenPlugins={() => {}}
          onOpenAgents={() => {}}
            onOpenUsage={() => {}}
            onBrowseFolders={() => {}}
            onSignIn={() => {}}
            onSearch={() => {}}
          />
        }
      />
    </Frame>
  </Mount>
)

/**
 * The Dashboard — plan usage, what it cost, where it went — as the app opens
 * it with ⌘U.
 *
 * There used to be a tab called Dashboard here that was not this: a page of
 * stat tiles and charts assembled for the catalogue, which described itself as
 * "a page that does not exist" while wearing the name of one that does. This
 * is the one that does — `components/Usage.tsx`, in a window-sized frame,
 * because it is a window.
 */
export const DashboardSurface = () => (
  <Mount>
    <Frame height="window">
      <Usage onClose={() => {}} onSignIn={() => {}} />
    </Frame>
  </Mount>
)

/**
 * Sign in, on the agent whose sign-in is waiting for a pasted code.
 *
 * The dialog the app opens from the seat and the rail, on the roster
 * `/preview.html` photographs (`preview/signin-fixture.ts`), in the one state
 * no other page shows: a browser sign-in whose command asked for the code the
 * page shows when it cannot finish by itself. The dialog lays itself out in
 * place rather than in a portal, so a window-sized frame holds it.
 */
const signInStore = previewStore(signInSeed('paste code'))

export const SignInSurface = () => (
  <Mount with={signInStore}>
    <Frame height="window">
      <SignIn runtime={SIGN_IN_SELECTED['paste code']} onClose={() => {}} />
    </Frame>
  </Mount>
)

/**
 * The team's chat twice, as shipped and with the changes a "solid" reading
 * asks for — each one switchable, so the page answers which of them carries
 * the feeling rather than arguing for all of them at once.
 *
 * Both sides mount the same shipped `TeamRoomPane` on the same fixture. B
 * changes nothing in the screen: every variant is either a token override on
 * B's own frame (the mechanism a foundation already uses, scoped to one frame
 * instead of `body`) or a rule in this directory's stylesheet keyed on B's
 * `data-solid` list. An experiment, not a proposal: whichever wins moves into
 * the system — a token, a pattern's prop — and leaves this page.
 */
const SOLID_VARIANTS = [
  { id: 'faces', label: 'Solid faces', about: 'Each sender is a filled tile in its own colour, the mark in white on it.' },
  { id: 'names', label: 'Heavier names', about: 'The sender at semibold instead of medium.' },
  { id: 'ink', label: 'Darker ink', about: 'Secondary and muted text each one tier darker.' },
  { id: 'quiet', label: 'Quiet header', about: 'The header keeps the name and the time; the delivery whisper goes.' },
  { id: 'fade', label: 'Fade the clamp', about: 'A clamped message fades out over its last line instead of cutting through it.' },
  { id: 'strip', label: 'Status strip', about: "The lines over the composer — who is working, who sending opens — sit in a tinted strip of their own instead of standing loose on the page.", candidate: true },
] as const

type SolidVariant = (typeof SOLID_VARIANTS)[number]['id']

/* Each tier up one: what was muted reads as secondary, what was secondary as
   primary. Token references only, so it follows the theme. */
const INK_UP: Record<string, string> = {
  '--hd-muted-foreground': 'var(--hd-secondary-foreground)',
  '--hd-tertiary-foreground': 'var(--hd-secondary-foreground)',
  '--hd-secondary-foreground': 'var(--hd-foreground)',
}


/* The team as a real review reads: one long, structured request — the kind
   whose clamp the eye catches cutting through a row of letters — and a short
   answer. Appended to the preview team's own channel, so A and B share it. */
const LONG_REVIEW = [
  'Deep code review, please — yours alone. Nobody else is reviewing this with you, so nothing here is a second opinion but yours.',
  '',
  'Pull request to review:',
  '',
  '- #1192 — The left sidebar on one row grammar: one-click New session, one row per conversation, complete search, fast large histories',
  '',
  'For each one:',
  '',
  '1. Read the whole diff — `gh pr diff <url>` — and then the files it touches in this checkout. The question is not whether the diff looks tidy but whether the behaviour it claims is the behaviour it ships.',
  '2. Run the tests it adds and the ones beside them, and say which you ran.',
  '3. Leave every finding as a review comment on the line it is about, blocking or not.',
  '4. End with one verdict: approve, or request changes with the list.',
].join('\n')

const solidTeamStore = (): AppStore => {
  const base = previewStore().getSnapshot()
  const teams = new Map(base.teams)
  const team = teams.get(PREVIEW_ROOM)
  if (team) {
    const last = team.channel[team.channel.length - 1]?.at ?? Date.now()
    const codex = { kind: 'agent', runtime: 'codex', sessionId: 'c1', title: 'API migration' }
    teams.set(PREVIEW_ROOM, {
      ...team,
      channel: [
        ...team.channel,
        { id: 'r1', at: last + 60_000, kind: 'message', from: { kind: 'user' }, to: { runtime: 'codex', sessionId: 'c1', title: 'API migration' }, text: LONG_REVIEW, state: 'delivered', reason: null, envelope: null },
        { id: 'r2', at: last + 360_000, kind: 'message', from: codex, text: '1192 — approve — 2 comments, none blocking.', state: 'shown', reason: null, envelope: null },
      ] as unknown as typeof team.channel,
    })
  }
  return previewStore({ teams })
}

const SOLID_TEAM_STORE = solidTeamStore()

export const TeamSolidSurface = () => {
  const [on, setOn] = useState<ReadonlySet<SolidVariant>>(
    () => new Set(SOLID_VARIANTS.filter((one) => !('candidate' in one)).map((one) => one.id)),
  )
  const toggle = (id: SolidVariant, checked: boolean): void =>
    setOn((current) => {
      const next = new Set(current)
      if (checked) next.add(id)
      else next.delete(id)
      return next
    })
  return (
    <div className={styles.solidPage}>
      <div className={styles.solidControls} role="group" aria-label="Variants on B">
        {SOLID_VARIANTS.map((one) => (
          <label key={one.id} className={styles.solidControl} title={one.about}>
            <Switch checked={on.has(one.id)} onCheckedChange={(checked) => toggle(one.id, checked)} />
            <Text role="row">{one.label}</Text>
            {'candidate' in one && <Chip tone="info">new</Chip>}
          </label>
        ))}
      </div>
      <div className={styles.solidPair}>
        <div className={styles.solidSide}>
          <Text role="section">A · as shipped</Text>
          <Mount with={SOLID_TEAM_STORE}>
            <Frame height="page">
              <TeamRoomPane room={PREVIEW_ROOM} />
            </Frame>
          </Mount>
        </div>
        <div className={styles.solidSide}>
          <Text role="section">B · {on.size === 0 ? 'nothing switched on' : `${on.size} of ${SOLID_VARIANTS.length} variants`}</Text>
          <div
            className={styles.solid}
            data-solid={[...on].join(' ')}
            style={on.has('ink') ? (INK_UP as CSSProperties) : undefined}
          >
            <Mount with={SOLID_TEAM_STORE}>
              <Frame height="page">
                <TeamRoomPane room={PREVIEW_ROOM} />
              </Frame>
            </Mount>
          </div>
        </div>
      </div>
    </div>
  )
}
