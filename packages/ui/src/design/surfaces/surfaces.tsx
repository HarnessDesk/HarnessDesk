import { useEffect, useRef, type ReactNode } from 'react'

import { activityOf, flowStepOf, placeCard, type Session } from '@harnessdesk/protocol'

import { BrowserPane } from '../../components/BrowserPane'
import { Composer } from '../../components/Composer'
import { FilePane } from '../../components/FilePane'
import { Conversation } from '../../components/Conversation'
import { GitPane } from '../../components/GitPane'
import { Sidebar } from '../../components/Sidebar'
import { TeamBoardPane } from '../../components/TeamBoardPane'
import { TeamRoomPane } from '../../components/TeamRoomPane'
import { TerminalSurface as TerminalPane } from '../../components/TerminalPane'
import { Usage } from '../../components/Usage'
import { MountProvider } from '../../panels/mount'
import { Workbench } from '../../panels/Workbench'
import { dock, emptyWorkbench } from '../../state/workbench'
import { PaneProvider } from '../../state/context'
import type { AppStore } from '../../state/store'
import { Mount, PREVIEW_ROOM, PREVIEW_SESSION_KEY, previewStore } from '../../preview/harness'
import { PREVIEW_FLOW_CARD, sceneFlowExecution } from '../../preview/flow-fixture'
import { PREVIEW_FLOW_GOAL } from '../../preview/goal-fixture'
import { denseTurns, PREVIEW_ROOT, previewHistory, previewSession } from '../../preview/sidebar-fixture'
import styles from './surfaces.module.css'

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
 * A store whose `s1` session carries a status or an approval the fixture's
 * own does not, built from a fresh default store rather than the shared one
 * `previewStore()` exports — so a failed case here cannot leave the module's
 * own `store` failed for every other board that imports it.
 */
const conversationStatusStore = (over: { status?: unknown; approvals?: unknown }): AppStore => {
  const base = previewStore().getSnapshot()
  const sessions = new Map(base.sessions)
  const session = sessions.get(PREVIEW_SESSION_KEY)
  if (over.status !== undefined && session) sessions.set(PREVIEW_SESSION_KEY, { ...session, status: over.status } as never)
  return previewStore({
    sessions,
    ...(over.approvals !== undefined ? { approvals: over.approvals as never } : {}),
  } as never)
}

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
 * One header case: a caption naming what it proves, a frame cropped to the
 * bar's own height (or, for the phone case, the header's own width) so the
 * catalogue reads as a row of states rather than six repeats of the whole
 * transcript, and a `data-testid` a browser spec can reach directly rather
 * than searching the tab for the Nth header.
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
 * above cannot show at once: idle (with the ceiling chip its own settings
 * already carry), running with its brand dot, waiting for an approval,
 * failed, the ceiling chip named on its own, and the phone-width fold. Each
 * still mounts the real `Conversation` — only the frame around it is
 * shorter, or narrower, than the one above.
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
        <Mount>
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

/** The front-door Goal's board holding its Seat's card, under a run stopped on that Seat's question. */
const questionStopStore = (): AppStore => {
  const base = previewStore().getSnapshot()
  const goal = PREVIEW_FLOW_GOAL.goal.id
  const teams = new Map(base.teams)
  const board = teams.get(goal)
  if (board) teams.set(goal, { ...board, intents: [PREVIEW_FLOW_CARD] })
  /* The Goal's activity derived as the host derives it — from the same card
     placement the board draws — never written in: a header and a board that
     disagreed would show here too. */
  const execution = sceneFlowExecution('question')
  const step = flowStepOf(PREVIEW_FLOW_CARD, undefined, [execution])
  const placed = placeCard({
    intent: PREVIEW_FLOW_CARD, evidence: undefined, stranded: false, holderWaits: false,
    forPerson: step?.kind === 'person', runStopped: step?.stopped ?? false,
  })
  const activity = activityOf(PREVIEW_FLOW_GOAL.goal, {
    needsYou: placed.column === 'needs', busy: false, liveFlow: true, cards: [PREVIEW_FLOW_CARD], dependencies: [],
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
 * A group project: the board and the room that belongs to it, together.
 *
 * Apart they are two panes; together they are the claim the layout exists to
 * make — that a task names the harness holding it, and that the harness is one
 * press from the conversation where the work is happening.
 */
export const GroupSurface = () => (
  <>
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
        counts it — one rule, so the two never disagree. */}
    <div className={styles.headerCases}>
      <div className={styles.headerCase} data-testid="group-run-stopped-on-a-question">
        <span className={styles.headerCaseLabel}>A run stopped on its Seat’s unanswered question</span>
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
