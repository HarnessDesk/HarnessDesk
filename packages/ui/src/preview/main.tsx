import { TeamFrame } from './frames-team-frame'
import { IconFollowupsFrames } from './frames-icon-followups'
import { capabilityListsStore } from './capability-lists-fixture'
import { CompactPanelFrames, compactAgentsStore, compactChangesStore } from './compact-panels-fixture'
import { TablesFamily } from '../design/explorer/tables-family'
import { NoticesFrame } from './frames-notices'
import { CatalogueRefusedUndo } from '../design/explorer/boards'
import { SidebarStructureExample } from './sidebar-structure-fixture'
import { SiteRunPreview } from '../../site-demo/run-demo'
import { TeamRecordFrames } from './frames-team-record'
import { TeamsPageFrames } from './frames-teams-page'
import { CliInstallFrame } from './frames-cli-install'
import { StrictMode, useMemo, useState, useSyncExternalStore, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'

import { runtimeId, sessionId, sessionKey, type RuntimeId, type Worktree, type WorktreeChanges } from '@harnessdesk/protocol'

import { BringHome } from '../components/BringHome'
import { Conversation } from '../components/Conversation'
import { CommitProvenance, CommitSeatLabels } from '../components/CommitProvenance'
import { ProjectProvenance } from '../components/ProjectProvenance'
import { ActivityView, AgentsView, ChangesView, TrajectoryView } from '../components/Details'
import { ObservedDialog } from '../components/EvidenceChips'
import { RunCheck } from '../components/RunCheck'
import { ProjectChecks } from '../components/ProjectChecks'
import { ProjectFlows } from '../components/ProjectFlows'
import { ProjectTriggers } from '../components/ProjectTriggers'
import { TriggerArm } from '../components/TriggerArm'
import { FlowUpdate } from '../components/FlowUpdate'
import { RaceStart } from '../components/RaceStart'
import { FlowRunStatus } from '../components/FlowRunStatus'
import { RetryCheck } from '../components/RetryCheck'
import { AppearanceSection } from '../components/SettingsYou'
import { LibrarySection } from '../components/Library'
import { AgentsWindow } from '../components/AgentsWindow'
import { NewSessionChoice } from '../components/NewSessionChoice'
import { SeatSheet } from '../components/SeatSheet'
import { SaveAsAgentDialog } from '../components/SaveAsAgent'
import { Settings, WorkspacesSection, type Section } from '../components/Settings'
import { Usage, type DashboardView } from '../components/Usage'
import { SignIn } from '../components/SignIn'
import { RuntimesSection } from '../components/SettingsAgents'
import { SIGN_IN_SCENES, SIGN_IN_SELECTED, runtimesSeed, signInSeed, type SignInScene } from './signin-fixture'
import { RemoveWorktree } from './../components/RemoveWorktree'
import { Sidebar } from '../components/Sidebar'
import { BoardListFrames } from './frames-board-list'
import { TeamBoardPane } from '../components/TeamBoardPane'
import { TeamRoomPane } from '../components/TeamRoomPane'
import { ApprovalDialog, ApprovalReason, NativeSelect, PaneColumn } from '../design'
import { PaneProvider, StoreProvider } from '../state/context'
import { useTheme } from '../state/theme'
import { AppWindowMode } from '../components/AppWindow'
import { emptySnapshot, type AppSnapshot, type AppStore } from '../state/store'
import {
  Boundary,
  EDGE_ROOM,
  EMPTY_ROOM,
  Mount,
  PREVIEW_EMPTY_SESSION_KEY,
  PREVIEW_PLANS,
  PREVIEW_ROOM,
  PREVIEW_SESSION_KEY,
  previewStore,
  runtime,
  store,
  TEAM,
} from './harness'
import { PublicationCard } from '../components/Publication'
import { usagePreviewStore } from './usage-fixture'
import { denseTurns, PREVIEW_ROOT } from './sidebar-fixture'
import { sidebarProjectsFixture, sidebarProjectsUnloadedSearchFixture } from './sidebar-projects-fixture'
import { EVIDENCE_BOARD, EVIDENCE_ROOM, EVIDENCE_TEAM, PREVIEW_UNSEEN } from './evidence-fixture'
import { captureHealth, commitProvenance, provenanceSeat, PROVENANCE_ROOT, PROVENANCE_SHA } from './provenance-fixture'
import { PREVIEW_FLOW_GOAL, PREVIEW_GOAL, PREVIEW_TRIGGER_GOAL } from './goal-fixture'
import { GOAL_INTAKE_SCENES, sceneArmPreview, sceneGoalStatus, triggerFiring, triggerHistoryPage, triggerProjectView, TRIGGER_ARM_SCENES, type GoalIntakeScene, type TriggerArmScene } from './intake-fixture'
import { FLOW_EXECUTION_SCENES, sceneFlowExecution, type FlowExecutionScene } from './flow-fixture'
import { COMPOSER_SESSION_KEY, composerStore } from './composer-fixture'
import { BOARD_TOOL_FRAMES, boardToolFrame } from './approval-fixture'
import { MessageQueue } from '../components/MessageQueue'
import { FindingFrames, GoalFrames } from './frames-goals'
import { PanelFrames } from './frames-panels'
import { CoverageFrames, NoticePlacementFrames } from './frames-coverage'
import { PersonReviewBoard } from '../design/surfaces/surfaces'
import { SettingsFrames } from './frames-settings'
import { TranscriptFrames } from './frames-transcript'
import { LibraryDevFrames } from './frames-library-dev'
import { LibraryOptionFrames } from './frames-library-options'
import { FlowOverlayFrames } from './frames-flow-overlay'
import { FlowGraphFrames } from './frames-flow-graph'
import { RunViewFrames, RunEndingRigFrames, RunAgainExample, RunAgainFrames, RUN_AGAIN_STATES } from './frames-run-view'
import { RunInspectorFrames } from './frames-run-inspector'
import { ReviewPublicationFrames } from './frames-review-publication'
import { ABANDON_VARIANTS, RunControlsFrames, type AbandonVariant } from './frames-run-controls'
import { TeamOverviewFrames } from './frames-team-overview'
import { STOP_RUN_DIALOG_STATES, STOP_RUN_STATES, StopRunDialogFrames, StopRunFrames } from './frames-stop-run'
import { SideBySideFrames } from './frames-side-by-side'
import { AgentBriefFrames } from './frames-agent-brief'
import { ComposerSlotsFrames } from './frames-composer-slots'
import { CjkSpecimen } from './cjk-specimen'
import { BRIEF_SCENES, FlowBriefDialog, type BriefScene } from './flow-brief-content'
import '../styles/app.css'

const SHOW_COMPOSER = new URLSearchParams(window.location.search).has('composer')
/* A second full `<Conversation>` duplicates every ambient header element —
   the plan strip, its "other agents" trigger — which is exactly what broke
   the composer frames above before they were gated the same way. Only on
   `preview.html?empty`, for the same reason. */
const SHOW_EMPTY = new URLSearchParams(window.location.search).has('empty')
/* The conversation map's own long transcript, swapped in for `s1` rather than
   given a session of its own — the map is the one thing on the page that
   reads differently with dozens of turns instead of one, and every other
   fixture on this screen still wants the ordinary short exchange. */
const SHOW_DENSE = new URLSearchParams(window.location.search).has('dense')
/* Up to four more full `<Conversation>`s, one per tile — the duplication
   `?empty` is gated against, four times over. Only on
   `preview.html?side-by-side`; the design page's own board draws the grid
   for the coverage sweep. */
const SHOW_SIDE_BY_SIDE = new URLSearchParams(window.location.search).has('side-by-side')
/* The Library's UX option mockups are a design record for the owner, not a
   shipped surface: they render only on `preview.html?library-options`, so the
   default page the UI-system census reads holds shipped components alone.
   Phase 1 of the Library plan deletes them once the real components exist. */
const SHOW_LIBRARY_OPTIONS = new URLSearchParams(window.location.search).has('library-options')
const SHOW_COMPOSER_SLOTS = new URLSearchParams(window.location.search).has('composer-slots')
/* Eleven whole `Workbench` windows that show where a notice goes: each one adds
   a composer, a model control and a conversation rail of its own, so they
   render only on `preview.html?notice-placement` and the default page keeps one
   of each. */
const SHOW_NOTICE_PLACEMENT = new URLSearchParams(window.location.search).has('notice-placement')
const SHOW_BOARD_TOOL_APPROVALS = new URLSearchParams(window.location.search).has('board-tool-approvals')
/* Which of the Dashboard's five rail rows the preview frame opens on — the
   rig's own way to shoot each view without clicking through the rail by
   hand: `preview.html?view=spend`. Falls back to the dial beside the frame. */
const DASHBOARD_VIEW_PARAM = new URLSearchParams(window.location.search).get('view')
const SIDEBAR_VARIANT_PARAM = new URLSearchParams(window.location.search).get('sidebar')
/* Painted only when asked for: the fixture draws its two pictures at load. */
const composerWaiting = SHOW_COMPOSER ? composerStore(store.getSnapshot()) : store
const composerPaused = SHOW_COMPOSER ? composerStore(store.getSnapshot(), true) : store
const settingsListsStore = capabilityListsStore(new URLSearchParams(location.search).get('capability-lists') === 'stress')
const sidebarNoFolderStore = previewStore({ workspace: null, workspaces: [], history: [], activeSessionKey: null })
/* A session with a folder but no turns: both inline actions belong to this
   empty state, and a draft without a folder cannot exercise the Team link. */
const emptyConversationStore = SHOW_EMPTY ? previewStore({
  workspace: { path: '/work/storefront', name: 'storefront', lastOpenedAt: 1 },
  runtimes: [runtime('codex', 'Alpha')],
  activeSessionKey: PREVIEW_EMPTY_SESSION_KEY,
  sessions: new Map([[PREVIEW_EMPTY_SESSION_KEY, {
    id: sessionId('preview-empty'),
    runtime: runtimeId('codex'),
    cwd: '/work/storefront',
    status: { type: 'idle' },
    createdAt: 1,
    updatedAt: 1,
    turns: [],
    itemsLoaded: true,
  }]]),
}) : store
const sidebarProjectsStore = previewStore(sidebarProjectsFixture(store.getSnapshot()))
const sidebarProjectsSearchStore = previewStore(sidebarProjectsUnloadedSearchFixture(store.getSnapshot()))
const sidebarProjectsSearchBeforeStore = previewStore(sidebarProjectsUnloadedSearchFixture(store.getSnapshot(), true))

const previewProvenance = commitProvenance({ seats: [{ ...provenanceSeat(7), runtime: 'codex', session: { runtime: 'codex', sessionId: 'conversation-7' } }] })
const previewMutable = store as unknown as { patch(partial: Partial<AppSnapshot>): void }
/**
 * The store this page mounted, for a spec that has to stage state in it.
 *
 * A spec cannot reach it by importing `./harness` itself. Once Vite has
 * hot-reloaded `harness.tsx` (or a module it imports), the page runs
 * `harness.tsx?t=…` and the bare URL is a second module instance with a second
 * store, so the spec changes a store nothing mounted and the screen it then
 * reads is unchanged (#1313). This file is the page's one entry, loaded once
 * whatever URL names it, so the `store` it holds is the one the page mounts
 * its frames on. `e2e/ui-system/trajectory-layout.spec.ts` is the caller.
 */
;(window as unknown as { __hdPreview: unknown }).__hdPreview = { store, sessionKey: PREVIEW_SESSION_KEY }
// The roster and chat share the real name role; populate this Goal's chat
// with the existing rig messages so both treatments can be read together.
previewMutable.patch({
  teams: new Map(store.getSnapshot().teams).set(PREVIEW_GOAL.goal.id, {
    ...PREVIEW_GOAL.board, channel: TEAM.channel,
  }),
})
previewMutable.patch({ captureHealth: new Map([[PROVENANCE_ROOT, captureHealth()]]) })
/* One Agent notice, addressed to the preview conversation, so `ComposerNotices` — mounted inside it — has something real to draw rather than its own "nothing asking" empty return. */
previewMutable.patch({
  agentNotices: [
    {
      id: 'notice-preview-1',
      where: 'composer',
      title: 'Found a second place this same check runs',
      body: 'Worth folding into one — want me to open a follow-up?',
      task: 'Fold the duplicate check into one',
      from: { runtime: 'codex', sessionId: 's1', name: 'Alpha' },
      at: Date.now(),
    },
  ],
})
/* `Panes`'s own default layout — the one `emptySnapshot()` gives every store
   until something opens a session into it — is one pane showing the empty
   pitch, "What should we build?", which is a thin thing for a frame whose
   whole point is showing the split tree itself. A real split, the preview
   conversation beside a file, is what that frame exists to draw. Nothing
   else on this page reads `snapshot.layout` — `Conversation` and its
   siblings are all scoped by their own explicit `PaneProvider`, never by
   this one — so overriding it here cannot narrow any other frame. */
previewMutable.patch({
  layout: {
    root: {
      kind: 'split',
      id: 'split-preview',
      direction: 'row',
      ratio: 0.55,
      first: { kind: 'pane', id: 'pane-preview-conversation', view: { kind: 'conversation', session: PREVIEW_SESSION_KEY } },
      second: { kind: 'pane', id: 'pane-preview-file', view: { kind: 'file', path: '/work/project/lib/brands.ts', runtime: runtimeId('codex') } },
    },
    focused: 'pane-preview-conversation',
    expanded: null,
  } as never,
})
if (SHOW_DENSE) {
  const key = sessionKey(runtimeId('codex'), 's1' as never)
  const session = store.getSnapshot().sessions.get(key)
  if (session) previewMutable.patch({ sessions: new Map(store.getSnapshot().sessions).set(key, { ...session, turns: denseTurns }) })
}

/**
 * A real streaming turn, for the one thing only a browser can answer:
 * whether the auto-scroll that follows it can undo a reader's own release
 * before the frame is out (#983 round 1). Appends one chunk to the
 * conversation's own last turn every `intervalMs`, exactly as a live agent's
 * items arrive, so `Conversation.tsx`'s real `onScroll` and layout effect run
 * on real growth and a real native `scroll` event — jsdom fires neither.
 * `e2e/ui-system/transcript-follow.spec.ts` is the one caller.
 */
;(window as unknown as { __hdStreamPreview: (chunks: number, intervalMs: number) => Promise<void> }).__hdStreamPreview =
  async (chunks: number, intervalMs: number): Promise<void> => {
    const snapshot = store.getSnapshot()
    const target = snapshot.sessions.get(PREVIEW_SESSION_KEY)
    if (!target) throw new Error('[preview] no session at PREVIEW_SESSION_KEY to stream into')
    const turnIndex = target.turns.length - 1
    const turn = target.turns[turnIndex] as { id: string; items: readonly unknown[] }
    // Grown locally rather than re-read each tick: the turn's own identity
    // and status stay exactly what the fixture gave them, so this is the one
    // thing changing — new items landing — not a second, confounding change
    // this test does not care about.
    let items = turn.items.slice()
    for (let index = 0; index < chunks; index += 1) {
      await new Promise((resolve) => setTimeout(resolve, intervalMs))
      items = [...items, { id: `stream-${index}`, type: 'assistantMessage', text: `streamed chunk ${index}` }]
      const currentSnapshot = store.getSnapshot()
      const currentSession = currentSnapshot.sessions.get(PREVIEW_SESSION_KEY)!
      const turns = currentSession.turns.slice()
      turns[turnIndex] = { ...turn, items } as never
      const sessions = new Map(currentSnapshot.sessions)
      sessions.set(PREVIEW_SESSION_KEY, { ...currentSession, turns } as never)
      previewMutable.patch({ sessions })
    }
  }
Object.assign(store as unknown as Record<string, unknown>, {
  readProvenance: async () => ({ project: PROVENANCE_ROOT, revision: 1, health: captureHealth(), commits: [previewProvenance] }),
  readProvenanceSeat: async () => ({ seat: null, session: previewProvenance.seats[0]!.session, unavailable: 'The historical Seat record is unavailable.' }),
  loadCaptureHealth: async () => {},
  setCapture: async (_root: string, enabled: boolean) => {
    const health = captureHealth({ enabled, state: enabled ? 'healthy' : 'stopped', revision: enabled ? 3 : 2, reason: enabled ? 'Capture is current for the refs Git exposes.' : 'Capture is off on this machine.', nextStep: enabled ? 'No action needed.' : 'Turn capture on.' })
    previewMutable.patch({ captureHealth: new Map([[PROVENANCE_ROOT, health]]) })
    return health
  },
  retryCapture: async () => captureHealth(),
})

// The one run `goal-flow`'s own reservation names — its header reads
// whichever of these `flowExecutions` holds, exactly as a real room does.
previewMutable.patch({ flowExecutions: new Map([['preview-flow-run', sceneFlowExecution('pinned')]]) })
/** Set from the "flow scene" Dial; `flowExecutions` is read synchronously off the snapshot, never fetched. */
const setPreviewFlowExecutionScene = (scene: FlowExecutionScene): void => {
  previewMutable.patch({ flowExecutions: new Map([['preview-flow-run', sceneFlowExecution(scene)]]) })
}

// The project's own trigger list is mutable here: arming and disarming the
// switch in "Project — its triggers" below writes back into this state, the
// same way the capture switch above does, so the preview page is something
// a person can actually operate rather than a frozen screenshot.
let goalIntakeScene: GoalIntakeScene = 'pull-request'
/** Read by `triggerGoal` below; set from the "goal intake scene" Dial. */
const setPreviewGoalIntakeScene = (scene: GoalIntakeScene): void => {
  goalIntakeScene = scene
  /* The one scene that is not the trigger's own status: a member of the room
     asking before it runs a command, which the room draws in its composer's
     slot. The rest clear it, so no scene inherits another's question. */
  previewMutable.patch({
    approvals: scene === 'approval'
      ? [{
          key: sessionKey(runtimeId('codex'), 'c1'),
          approval: {
            id: 'preview-approval', type: 'command', kind: 'shell', command: 'pnpm test', cwd: PREVIEW_TRIGGER_GOAL.goal.cwd,
            reason: 'Runs the project’s tests before the review is written.',
            options: [
              { id: 'yes', label: 'Allow', intent: 'approve' },
              { id: 'always', label: 'Allow for this session', intent: 'approveAlways' },
              { id: 'no', label: 'Deny', intent: 'deny' },
            ],
          },
        }] as never
      : [],
  })
}

let previewTriggers = triggerProjectView()
Object.assign(store as unknown as Record<string, unknown>, {
  projectTriggers: async () => previewTriggers,
  previewTrigger: async (_root: string, id: string) => sceneArmPreview((TRIGGER_ARM_SCENES as readonly string[]).includes(id) ? (id as TriggerArmScene) : 'ready'),
  armTrigger: async (_root: string, id: string) => {
    const armed = previewTriggers.triggers.find((one) => one.id === id)
    if (!armed) throw new Error(`[preview] no trigger named ${id}`)
    const next = { ...armed, armed: true, state: 'armed' as const }
    previewTriggers = { ...previewTriggers, triggers: previewTriggers.triggers.map((one) => (one.id === id ? next : one)) }
    return next
  },
  disarmTrigger: async (_root: string, id: string) => {
    const off = previewTriggers.triggers.find((one) => one.id === id)
    if (!off) throw new Error(`[preview] no trigger named ${id}`)
    const next = { ...off, armed: false, state: 'off' as const }
    previewTriggers = { ...previewTriggers, triggers: previewTriggers.triggers.map((one) => (one.id === id ? next : one)) }
    return next
  },
  // Answered for the Goal asked about: the room reads a status only when it
  // names the Goal it is showing, and the fixture's own id is a different one.
  triggerGoal: async (goal: string) => (goal === PREVIEW_TRIGGER_GOAL.goal.id ? { ...sceneGoalStatus(goalIntakeScene), goal } : null),
  respondToApproval: async () => { previewMutable.patch({ approvals: [] }) },
  triggerHistory: async () => triggerHistoryPage({
    items: [
      triggerFiring(),
      triggerFiring({ id: 'firing-2', subject: '11', outcome: 'skipped', reason: 'A stranger’s head; forks are never run.', goal: null, run: null, round: null, head: 'b'.repeat(40) }),
      triggerFiring({ id: 'firing-3', subject: '11', outcome: 'duplicate', reason: null }),
    ],
    next: null,
  }),
})

/**
 * The screen preview: real screens on a stubbed store, in a browser.
 *
 * `pnpm --filter @harnessdesk/ui run dev`, then /preview.html. Dev-only —
 * the build's rollup inputs never list this page. It exists because the
 * screens worth restyling are exactly the ones that need a host: the Team
 * tab wants a board with traffic on it, the Library wants four agents'
 * directories, and neither state can be arranged on demand in the real app.
 * Here the store is a fixture and every theme dial is on the page, so a
 * change to a screen or to the token layer can be seen in every palette in
 * under a minute.
 *
 * The store and the fixture under it are `./harness`, which the design
 * explorer's surface boards mount too — so a screen looks the same in the
 * catalogue as it does here, for the reason that it is the same screen.
 */

/** A stand-in pane, so the frame's own edges are what the frame shows. */
export const Frame = ({ id, title, children }: { id: string; title: string; children: ReactNode }) => (
  <section data-frame-id={id} className="min-w-0">
    <h2 data-preview-caption="" className="mb-2 text-sm font-semibold text-muted-foreground">{title}</h2>
    <div className="overflow-hidden rounded-lg border bg-background">
      <Boundary>{children}</Boundary>
    </div>
  </section>
)

/**
 * The two worktree dialogs, on a store of their own.
 *
 * They are the one pair of screens that cannot be reached from the page's main
 * fixture: each reads `worktree/changes` over the wire and neither is a pane,
 * so the interesting state — a checkout git calls clean that is holding an
 * `.env` — has no way to be arranged except by answering that read. A dialog
 * also covers the page while it is open, so this is off by default and chosen
 * from the dial above.
 *
 * The values are the ones worth looking at: nothing uncommitted, and two
 * ignored entries of the two different kinds — a file git never had, and a
 * folder that can be built again (#209).
 */
const DIALOG_TREE: Worktree = {
  path: '/state/worktrees/storefront-1a/checkout-retry',
  branch: 'harnessdesk/checkout-retry',
  head: 'b',
  isMain: false,
  managed: true,
}

const DIALOG_MAIN: Worktree = { path: '/work/storefront', branch: 'main', head: 'a', isMain: true, managed: false }

const DIALOG_CHANGES: WorktreeChanges = {
  modified: 0,
  untracked: 0,
  unpushedCommits: 2,
  files: [],
  ignored: ['.env', 'node_modules/'],
  ignoredCount: 2,
}

const WorktreeDialogs = ({ which, onClose }: { which: 'remove' | 'bring back'; onClose: () => void }) => {
  const snapshot = {
    ...emptySnapshot(),
    status: 'open',
    /* A runtime with no brand in it. The bring-back dialog asks the agent to
       commit only when the tree is dirty, which this fixture's never is, so the
       name is off camera — and `pnpm layering` is right that a brand name
       written into the shell is how that rule rots. */
    runtimes: [runtime('agent', 'The agent')],
    activeRuntime: runtimeId('agent'),
    worktrees: [DIALOG_MAIN, DIALOG_TREE],
    sessions: new Map(),
  } as unknown as AppSnapshot
  const dialogStore = {
    subscribe: () => () => {},
    getSnapshot: () => snapshot,
    transport: { request: async () => DIALOG_CHANGES },
    removeWorktree: async () => false,
    bringWorktreeHome: async () => null,
  } as unknown as AppStore
  return (
    <StoreProvider store={dialogStore}>
      {which === 'remove' ? (
        <RemoveWorktree worktree={DIALOG_TREE} onClose={onClose} />
      ) : (
        <BringHome worktree={DIALOG_TREE} onClose={onClose} />
      )}
    </StoreProvider>
  )
}

/**
 * Sign-in on a roster of its own: every state the dialog draws is one scene
 * of `signin-fixture.ts`, and each scene opens on the agent that shows it.
 */
const SignInPreview = ({ scene, onClose }: { scene: SignInScene; onClose: () => void }) => {
  const own = useMemo(() => previewStore(signInSeed(scene)), [scene])
  return (
    <StoreProvider store={own}>
      <SignIn runtime={SIGN_IN_SELECTED[scene]} onClose={onClose} />
    </StoreProvider>
  )
}

/* The page itself, not a second Settings sheet: a page has one Settings
   window, and the specs that find it by its name are right to expect one. */
const RuntimesPreview = () => {
  const own = useMemo(() => previewStore(runtimesSeed()), [])
  return (
    <StoreProvider store={own}>
      <div className="mx-auto max-w-[760px] px-8 py-10">
        <RuntimesSection onSignIn={() => {}} />
      </div>
    </StoreProvider>
  )
}

export const Dial = <T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string
  value: T
  options: readonly T[]
  onChange: (next: T) => void
}) => (
  <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
    {label}
    <NativeSelect value={value} onChange={(event) => onChange(event.target.value as T)}>
      {options.map((option) => (
        <option key={option} value={option}>
          {option}
        </option>
      ))}
    </NativeSelect>
  </label>
)

const SETTINGS_SECTIONS = [
  'profile',
  'general',
  'appearance',
  'notifications',
  'shortcuts',
  'workspaces',
  'archive',
  'runtimes',
  'models',
  'skills',
  'extensions',
  'library',
  'plugins',
  'permissions',
  'browser',
] as const satisfies readonly Section[]

const Preview = () => {
  useTheme()
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot)
  // The whole `Section`, not just the dial's shortlist: the sheet's own nav
  // rail writes back here too, and it offers every page.
  const [settingsSection, setSettingsSection] = useState<Section>('general')
  const [dialog, setDialog] = useState<
    | 'off'
    | 'remove'
    | 'bring back'
    | 'sign in'
    | 'new session'
    | 'seat sheet'
    | 'save as agent'
    | 'what was observed'
    | 'run a check'
    | 'retry check'
    | 'retry check refused'
    | 'flow update'
    | 'flow customize'
    | 'race'
    | 'trigger arm'
  >('off')
  const [armScene, setArmScene] = useState<TriggerArmScene>('ready')
  const [signInScene, setSignInScene] = useState<SignInScene>('refused')
  const [goalScene, setGoalScene] = useState<GoalIntakeScene>('pull-request')
  const [flowScene, setFlowScene] = useState<FlowExecutionScene>('pinned')
  // The Agents window's own rail selection: the overview, or one Agent's own page.
  const [agentsFocus, setAgentsFocus] = useState<string>('overview')
  const [dashboardView, setDashboardView] = useState<DashboardView>(
    (DASHBOARD_VIEW_PARAM as DashboardView | null) ?? 'overview',
  )
  const [dashboardScope, setDashboardScope] = useState<RuntimeId | null>(null)
  const dashboardStore = useMemo(() => usagePreviewStore(), [])
  if (new URLSearchParams(window.location.search).has('icon-followups')) return <IconFollowupsFrames />
  return (
    <div className="min-h-full bg-background p-4 text-foreground">
      <section aria-label="Provenance preview">
        <Frame id="provenance-seats" title="History — associated Seats"><CommitSeatLabels value={previewProvenance} /><CommitProvenance root={PROVENANCE_ROOT} sha={PROVENANCE_SHA} /></Frame>
        <Frame id="project-capture" title="Project — capture"><ProjectProvenance root={PROVENANCE_ROOT} /></Frame>
      </section>
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <span className="text-sm font-semibold">Screen preview</span>
        <Dial
          label="theme"
          value={snapshot.theme}
          options={['system', 'light', 'dark'] as const}
          onChange={(next) => store.setTheme(next)}
        />
        <Dial
          label="palette"
          value={snapshot.palette}
          options={['harnessdesk', 'editorial', 'shadcn'] as const}
          onChange={(next) => store.setPalette(next)}
        />
        <Dial
          label="accent"
          value={snapshot.accent}
          options={['default', 'violet', 'green', 'rose', 'orange', 'mono'] as const}
          onChange={(next) => store.setAccent(next)}
        />
        <Dial
          label="interface"
          value={snapshot.look}
          options={['desk', 'studio'] as const}
          onChange={(next) => store.setLook(next)}
        />
        <Dial
          label="corners"
          value={snapshot.corners}
          options={['default', 'square', 'round'] as const}
          onChange={(next) => store.setCorners(next)}
        />
        <Dial
          label="faces"
          value={snapshot.faces}
          options={['square', 'round'] as const}
          onChange={(next) => store.setFaces(next)}
        />
        <Dial
          label="dialog"
          value={dialog}
          options={['off', 'remove', 'bring back', 'sign in', 'new session', 'seat sheet', 'save as agent', 'what was observed', 'run a check', 'retry check', 'retry check refused', 'flow update', 'flow customize', 'race', 'trigger arm'] as const}
          onChange={setDialog}
        />
        <Dial label="trigger arm scene" value={armScene} options={TRIGGER_ARM_SCENES} onChange={setArmScene} />
        <Dial label="sign in scene" value={signInScene} options={SIGN_IN_SCENES} onChange={setSignInScene} />
        <Dial
          label="goal intake scene"
          value={goalScene}
          options={GOAL_INTAKE_SCENES}
          onChange={(next) => { setGoalScene(next); setPreviewGoalIntakeScene(next) }}
        />
        <Dial
          label="flow scene"
          value={flowScene}
          options={FLOW_EXECUTION_SCENES}
          onChange={(next) => { setFlowScene(next); setPreviewFlowExecutionScene(next) }}
        />
      </div>
      {/* Sign-in stands on a store of its own, seeded by `signin-fixture.ts`:
          the page's roster is all signed in, which is the one roster this
          dialog never has to help with. The scene dial picks which state it
          opens on. */}
      {dialog === 'sign in' && <SignInPreview key={signInScene} scene={signInScene} onClose={() => setDialog('off')} />}
      {dialog === 'what was observed' && (
        <ObservedDialog
          id={1}
          title={EVIDENCE_TEAM.intents[0]?.title ?? ''}
          card={EVIDENCE_BOARD.cards[0]}
          onClose={() => setDialog('off')}
        />
      )}
      {dialog === 'run a check' && (
        <RunCheck
          unseen={PREVIEW_UNSEEN}
          card={2}
          busy={false}
          record={false}
          onRun={() => setDialog('off')}
          onCancel={() => setDialog('off')}
        />
      )}
      {dialog === 'new session' && <NewSessionChoice onClose={() => setDialog('off')} />}
      {dialog === 'retry check' && <RetryCheck run="run-preview" card={7} onClose={() => setDialog('off')} />}
      {dialog === 'retry check refused' && <RetryCheck run="run-preview-ended" card={7} onClose={() => setDialog('off')} />}
      {dialog === 'flow update' && (
        <FlowUpdate root={PREVIEW_ROOT} id="old-fix" mode="update" onClose={() => setDialog('off')} onApplied={() => setDialog('off')} />
      )}
      {dialog === 'flow customize' && (
        <FlowUpdate root={PREVIEW_ROOT} id="comparison" mode="customize" onClose={() => setDialog('off')} onApplied={() => setDialog('off')} />
      )}
      {dialog === 'race' && (
        <RaceStart root={PREVIEW_ROOT} task="Fix the retry bug" onClose={() => setDialog('off')} />
      )}
      {dialog === 'trigger arm' && (
        <TriggerArm root={PREVIEW_ROOT} id={armScene} onClose={() => setDialog('off')} onArmed={() => setDialog('off')} />
      )}
      {dialog === 'seat sheet' && (
        <SeatSheet
          refusal={{
            agent: 'security-reviewer',
            name: 'Security reviewer',
            blocked: null,
            opened: false,
            candidates: PREVIEW_PLANS.get('security-reviewer')?.candidates ?? [],
          }}
          onClose={() => setDialog('off')}
          onFix={() => setDialog('off')}
        />
      )}
      {dialog === 'save as agent' && (
        <SaveAsAgentDialog
          session={store.getSnapshot().sessions.get(PREVIEW_SESSION_KEY)!}
          onClose={() => setDialog('off')}
        />
      )}
      {dialog === 'remove' || dialog === 'bring back' ? (
        <WorktreeDialogs which={dialog} onClose={() => setDialog('off')} />
      ) : null}
      {/* The board, in a pane of its own — which is one of the two shapes it
          really has (the other is the room's right half, further down). It is
          first here because it is the widest surface the token layer touches:
          a button, a chip, a card, a column ground and an empty state all in
          one screen, so a change to the system is visible here before it is
          hunted for anywhere else. */}
      <Frame id="board-populated" title="Board — the pane, with work on it">
        <div className="h-[560px]">
          <TeamBoardPane room={PREVIEW_ROOM} />
        </div>
      </Frame>

      {/* The two real permission-card states shown by the design catalogue:
          Gemini offered an allow-always choice, or its permanent approval
          setting is off. */}
      {SHOW_BOARD_TOOL_APPROVALS && <div className="grid grid-cols-3 gap-4">
        {BOARD_TOOL_FRAMES.map(({ state, caseId, title }) => {
          const frame = boardToolFrame(state, () => {})
          return (
            <Frame key={state} id={caseId} title={title}>
              <ApprovalDialog title="Permission" icon={null} focused={false} focusKey={`preview-board-tool-${state}`} placement="docked" actions={frame.actions}>
                <ApprovalReason title={frame.note.title}>{frame.note.text}</ApprovalReason>
              </ApprovalDialog>
            </Frame>
          )
        })}
      </div>}
      <Frame id="board-person-review" title="Board — choose an attempt for the person judge">
        <div className="h-[560px]">
          <PersonReviewBoard />
        </div>
      </Frame>
      <Frame id="board-observed" title="Board — what the desk observed">
        <div className="h-[640px]">
          <TeamBoardPane room={EVIDENCE_ROOM} />
        </div>
      </Frame>
      <Frame id="board-empty" title="Board — the empty state">
        <div className="h-[420px]">
          <TeamBoardPane room={EMPTY_ROOM} />
        </div>
      </Frame>
      {/* Narrow on purpose: the room gives its board whatever the rail left
          over, and every truncation bug this fixture exists for only appears
          at a width the card cannot have all of. */}
      <Frame id="board-edges" title="Board — the edges, at the width the room leaves it">
        <div className="h-[560px] w-[760px]">
          <TeamBoardPane room={EDGE_ROOM} />
        </div>
      </Frame>
      {/* Settings is a fixed-position sheet, so it would paint over the whole
          page. A `transform` on the wrapper makes it the containing block for
          `position: fixed`, which pins the real dialog — unedited — inside a
          frame. It is the only way to see the settings surface at the 980px
          it actually opens at. */}
      <Frame id="settings-sheet" title="Settings — the sheet, its nav, and a page">
        <div className="relative h-[940px]" style={{ transform: 'translateZ(0)' }}>
          {/* The page is the caller's, so the dial drives it directly and the
              sheet's own nav rail writes back to the same state — no remount,
              and clicking around in here moves the dial with it. */}
          <StoreProvider store={settingsListsStore}><Settings
            section={settingsSection}
            onSection={setSettingsSection}
            onClose={() => {}}
            onSignIn={() => {}}
          /></StoreProvider>
        </div>
      </Frame>
      <div className="my-4 flex flex-wrap items-center gap-3">
        <Dial
          label="settings page"
          value={settingsSection}
          options={SETTINGS_SECTIONS}
          onChange={setSettingsSection}
        />
      </div>
      {/* Settings › Runtimes on a roster that needs something: the page's own
          frame, because the sheet above opens on the all-signed-in fixture,
          which is the one roster this page never has to help with. */}
      <Frame id="runtimes-status" title="Runtimes — what needs you, then what is ready">
        <RuntimesPreview />
      </Frame>
      {/* The Agents window: the owner's left-menu decision, in its own
          top-level screen, never a Settings page — the same containment
          trick as Settings and Usage, both `AppWindow`s too. */}
      <Frame id="agents-roster" title="Agents — the roster, and a selected Agent">
        <div className="relative h-[940px]" style={{ transform: 'translateZ(0)' }}>
          <AgentsWindow
            focus={agentsFocus === 'overview' ? null : agentsFocus}
            onClose={() => {}}
            onFocus={(id) => setAgentsFocus(id ?? 'overview')}
          />
        </div>
      </Frame>
      <div className="my-4 flex flex-wrap items-center gap-3">
        <Dial
          label="agents focus"
          // Task 15's page states remain here. Task 16 adds the four seating
          // frames to the same dial: 'release-checker' has no list on this Mac;
          // 'code-reviewer' has two seats, one passed over with a fix;
          // 'security-reviewer' has a broken seating entry; and Add a seat…
          // opens the fourth, the word-only dialog.
          value={agentsFocus}
          options={['overview', 'release-checker', 'code-reviewer', 'security-reviewer', 'draft'] as const}
          onChange={setAgentsFocus}
        />
      </div>
      <Frame id="workspace-project" title="Settings › Workspaces — a project">
        <div className="p-4">
          <WorkspacesSection focus={PREVIEW_ROOT} />
        </div>
      </Frame>
      <Frame id="workspace-triggers" title="Settings › Workspaces — Triggers on this Mac">
        <div className="p-4">
          <WorkspacesSection />
        </div>
      </Frame>
      {/* The Dashboard, at the width the window really opens it at. Its rail
          is now five views rather than one row per account; the header's own
          "All accounts ▾" scopes whichever view is open, so picking an
          account in here shows the burn-down band on Plans the way the app
          does.

          It needs the same `transform` the Settings frame above does, and for
          the same reason: `Usage` is an `AppWindow`, which is
          `position: fixed`. Without a containing block it escaped its frame
          and painted over the *whole* preview page — every other frame on
          this page became unreachable, and a screenshot of any of them came
          back as the Dashboard. One line, and the trap is already documented
          four frames up. */}
      <Frame id="dashboard-overview" title="Dashboard — what is left, what it cost, where it went">
        <div className="relative h-[900px]" style={{ transform: 'translateZ(0)' }}>
          <StoreProvider store={dashboardStore}>
            <Usage
              view={dashboardView}
              scope={dashboardScope}
              onView={setDashboardView}
              onScope={setDashboardScope}
              onClose={() => {}}
              onSignIn={() => {}}
            />
          </StoreProvider>
        </div>
      </Frame>
      <div className="my-4 flex flex-wrap items-center gap-3">
        <Dial
          label="dashboard view"
          value={dashboardView}
          options={['overview', 'plans', 'spend', 'activity', 'projects'] as const}
          onChange={setDashboardView}
        />
      </div>

      {/* The conversation, which is the app. It is scoped by a `PaneProvider`
          exactly the way the workbench scopes it, so this is the same
          component the window renders and not a reduced one — the transcript,
          its header, and the composer under it. */}
      <Frame id="conversation-composer" title="Conversation — the transcript and its composer">
        <div className="h-[820px]">
          <PaneProvider
            scope={{
              paneId: 'preview' as never,
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
        </div>
      </Frame>

      {/* A conversation with its folder and no turns: the transcript's own
          pitch and both inline actions before the first message.
          Only on `preview.html?empty` — see `SHOW_EMPTY` above. */}
      {SHOW_EMPTY && (
        <Frame id="conversation-empty" title="Conversation — the empty pane">
          <div className="h-[560px]">
            <StoreProvider store={emptyConversationStore}>
              <PaneProvider
                scope={{
                  paneId: 'preview-empty' as never,
                  view: { kind: 'conversation', session: PREVIEW_EMPTY_SESSION_KEY } as never,
                  sessionKey: PREVIEW_EMPTY_SESSION_KEY,
                }}
              >
                <Conversation
                  onChooseProject={() => {}}
                  onSignIn={() => {}}
                  onOpenUsage={() => {}}
                  onOpenRuntimes={() => {}}
                />
              </PaneProvider>
            </StoreProvider>
          </div>
        </Frame>
      )}

      {/* The card a publication chip opens on hover: the forge's own crest,
          state, size and excerpt. Rendered directly — no transcript in this
          fixture set carries a publication item yet. */}
      <Frame id="publication-card" title="Publication card — a pull request">
        <div className="w-[320px] rounded-(--hd-radius-lg) shadow-[inset_0_0_0_1px_var(--hd-border-strong)] bg-(--hd-popover)">
          <PublicationCard
            reference={{
              kind: 'pullRequest',
              action: 'opened',
              repo: 'harnessdesk/harnessdesk',
              number: 748,
              url: 'https://github.com/harnessdesk/harnessdesk/pull/748',
              title: 'Converge the conversation, its cards and its bars onto the design system',
              state: 'open',
              author: 'shane',
              additions: 214,
              deletions: 58,
              files: 6,
              excerpt: 'Screens compose the parts design/ already owns instead of drawing their own appearance.',
              via: 'gh',
              signature: null,
            }}
          />
        </div>
      </Frame>

      {/* The composer holding everything it can at once, on a store of its
          own: a model list that folds behind a filter, a build with a newer
          one out, three messages waiting, and a sent message with two
          pictures to open in the lightbox. Only on `preview.html?composer`:
          a second conversation on the page would give every spec that finds
          "the" model trigger or "the" transcript two of them. */}
      {SHOW_COMPOSER && <>
      <Frame id="composer-pickers" title="Composer — its pickers, the queue and a picture">
        <div className="h-[820px]" data-preview="composer">
          <StoreProvider store={composerWaiting}>
            <PaneProvider
              scope={{
                paneId: 'preview-composer' as never,
                view: { kind: 'conversation', session: COMPOSER_SESSION_KEY } as never,
                sessionKey: COMPOSER_SESSION_KEY,
              }}
            >
              <Conversation
                onChooseProject={() => {}}
                onSignIn={() => {}}
                onOpenUsage={() => {}}
                onOpenRuntimes={() => {}}
              />
            </PaneProvider>
          </StoreProvider>
        </div>
      </Frame>
      <Frame id="composer-paused" title="Composer — a paused queue">
        <div className="p-4" data-preview="queue-paused">
          <StoreProvider store={composerPaused}>
            <PaneProvider
              scope={{
                paneId: 'preview-queue' as never,
                view: { kind: 'conversation', session: COMPOSER_SESSION_KEY } as never,
                sessionKey: COMPOSER_SESSION_KEY,
              }}
            >
              <MessageQueue />
            </PaneProvider>
          </StoreProvider>
        </div>
      </Frame>
      </>}

      <div className="mt-4 grid grid-cols-1 gap-4 xl:grid-cols-[380px_1fr]">
        {/* The two right-dock panels, at the width the dock actually gives
            them — a panel judged at full width is not the panel. */}
        <Frame id="panel-changes" title="Side panel — Changes">
          <div className="h-[420px]">
            <PaneProvider
              scope={{
                paneId: 'preview' as never,
                view: { kind: 'conversation', session: PREVIEW_SESSION_KEY } as never,
                sessionKey: PREVIEW_SESSION_KEY,
              }}
            >
              <StoreProvider store={compactChangesStore}><ChangesView /></StoreProvider>
            </PaneProvider>
          </div>
        </Frame>
        <Frame id="panel-trajectory" title="Side panel — Trajectory">
          <div className="h-[420px]">
            <PaneProvider
              scope={{
                paneId: 'preview' as never,
                view: { kind: 'conversation', session: PREVIEW_SESSION_KEY } as never,
                sessionKey: PREVIEW_SESSION_KEY,
              }}
            >
              <TrajectoryView />
            </PaneProvider>
          </div>
        </Frame>
        <Frame id="panel-agents" title="Side panel — Agents">
          <div className="h-[420px]">
            <PaneProvider
              scope={{
                paneId: 'preview' as never,
                view: { kind: 'conversation', session: PREVIEW_SESSION_KEY } as never,
                sessionKey: PREVIEW_SESSION_KEY,
              }}
            >
              <StoreProvider store={compactAgentsStore}><AgentsView /></StoreProvider>
            </PaneProvider>
          </div>
        </Frame>
        <Frame id="panel-activity" title="Side panel — Activity, this week's audit">
          <div className="h-[420px]">
            <PaneProvider
              scope={{
                paneId: 'preview' as never,
                view: { kind: 'conversation', session: PREVIEW_SESSION_KEY } as never,
                sessionKey: PREVIEW_SESSION_KEY,
              }}
            >
              <ActivityView />
            </PaneProvider>
          </div>
        </Frame>
        <Frame id="project-flows" title="Project — its flows">
          <div className="p-4">
            <ProjectFlows root={PREVIEW_ROOT} current />
          </div>
        </Frame>
        <Frame id="flow-status" title="Flow — run status, interrupted check">
          <div className="p-4">
            <FlowRunStatus
              execution={{
                version: 2, id: 'run-preview', goal: PREVIEW_ROOM, document: { format: 'agents', flow: { version: 2, name: 'Fix and review', inputs: [], roles: [], rules: [], seed: { role: 'verify', title: 'Check the fix' }, messaging: 'board-only', wait: 240 } },
                state: 'stalled',
                rounds: [{ n: 2, role: 'verify', cards: [7], seats: [], evidence: [], state: 'running', cause: 'x' }],
                operations: [{ key: 'check:2:0', kind: 'check', state: 'uncertain', card: 7, seat: null }],
                legacyRun: null, reason: 'This check was interrupted. Inspect its effects, then choose Run again.',
              }}
            />
          </div>
        </Frame>
        <Frame id="project-checks" title="Project — its checks">
          <div className="p-4">
            <ProjectChecks root={PREVIEW_ROOT} />
          </div>
        </Frame>
        <Frame id="project-triggers" title="Project — its triggers">
          <div className="p-4">
            <ProjectTriggers root={PREVIEW_ROOT} />
          </div>
        </Frame>
      </div>

      {new URLSearchParams(window.location.search).has('compact-panels') && <CompactPanelFrames />}

      <div className="mt-4 grid grid-cols-1 gap-4 xl:grid-cols-[380px_1fr]">
        {/* The sidebar at its real width, on the plate it really sits on:
            the right edge only reads true against the column's own ground. */}
        <Frame id="sidebar-column" title="Sidebar — 240px column">
          <div
            className="h-[720px]"
            style={{ width: 240, background: 'var(--hd-sidebar-plate, transparent)' }}
          >
            <Mount with={SIDEBAR_VARIANT_PARAM === 'projects-search-before'
              ? sidebarProjectsSearchBeforeStore
              : SIDEBAR_VARIANT_PARAM === 'projects-search'
                ? sidebarProjectsSearchStore
                : SIDEBAR_VARIANT_PARAM === 'projects' ? sidebarProjectsStore : store}>
              <Sidebar
                onOpenSettings={() => {}}
                onOpenPlugins={() => {}}
                onOpenTeams={() => {}} onOpenAgents={() => {}}
                onOpenUsage={() => {}}
                onBrowseFolders={() => {}}
                onSignIn={() => {}}
                onSearch={() => {}}
              />
            </Mount>
          </div>
        </Frame>
        {SIDEBAR_VARIANT_PARAM === 'compact' && <Frame id="sidebar-compact" title="Sidebar — 200px column">
          <div className="h-[720px]" style={{ width: 200, background: 'var(--hd-sidebar-plate, transparent)' }}>
            <Sidebar
              onOpenSettings={() => {}}
              onOpenPlugins={() => {}}
              onOpenTeams={() => {}} onOpenAgents={() => {}}
              onOpenUsage={() => {}}
              onBrowseFolders={() => {}}
              onSignIn={() => {}}
              onSearch={() => {}}
            />
          </div>
        </Frame>}
        {SIDEBAR_VARIANT_PARAM === 'no-folder' && <Frame id="sidebar-no-folder" title="Sidebar — no project folder">
          <div className="h-[540px]" style={{ width: 240, background: 'var(--hd-sidebar-plate, transparent)' }}>
            <Mount with={sidebarNoFolderStore}>
              <Sidebar
                onOpenSettings={() => {}}
                onOpenPlugins={() => {}}
                onOpenTeams={() => {}} onOpenAgents={() => {}}
                onOpenUsage={() => {}}
                onBrowseFolders={() => {}}
                onSignIn={() => {}}
                onSearch={() => {}}
              />
            </Mount>
          </div>
        </Frame>}
        <Frame id="goal-roster" title="Goal — state, roster and channel">
          <div className="h-[540px]">
            <TeamRoomPane room={PREVIEW_GOAL.goal.id} />
          </div>
        </Frame>
        <Frame id="goal-triggered" title="Goal — opened by a trigger">
          <div className="h-[540px]">
            <TeamRoomPane key={goalScene} room={PREVIEW_TRIGGER_GOAL.goal.id} />
          </div>
        </Frame>
        {/* A front-door start's own header meta: a pinned revision ("at
            a1b2c3d on branch feature"), a diff or working-tree's label alone
            (no head to repeat), or a person's own stop line — all read off
            `flowExecutions`, never fetched, so the "flow scene" Dial above
            is what moves this frame. */}
      <Frame id="goal-front-door" title="Goal — a front-door start's pinned revision or stop line">
          <div className="h-[540px]">
            <TeamRoomPane key={flowScene} room={PREVIEW_FLOW_GOAL.goal.id} />
          </div>
        </Frame>
      </div>

      {/* Full width, like every other Settings frame on this page — the same
          two-column grid above has exactly four cells (2×2) for its sidebar
          and three Goal frames; a fifth item auto-placed into it lands back
          in the 380px sidebar column, not the wide one, which is what
          crushed this frame's own text to one word a line. */}
      <Frame id="settings-library" title="Settings › Library">
        <div className="max-h-[540px] overflow-y-auto p-4">
          <LibrarySection />
        </div>
      </Frame>
      {SHOW_LIBRARY_OPTIONS && <LibraryDevFrames />}
      {SHOW_LIBRARY_OPTIONS && <LibraryOptionFrames />}
      <Frame id="settings-appearance" title="Settings › Appearance">
        <div className="p-4">
          <AppearanceSection />
        </div>
      </Frame>

      <Frame id="tables-family" title="Tables: the family"><div className="p-4"><TablesFamily /></div></Frame>
      <SettingsFrames />
      <Frame id="typography-cjk" title="CJK — reading text and controls">
        <CjkSpecimen />
      </Frame>
      <GoalFrames />
      <RunAgainFrames />
      <StopRunDialogFrames scene={STOP_RUN_DIALOG_STATES.find(one => one === new URLSearchParams(window.location.search).get('stop-run-dialog'))} />
      <TranscriptFrames />
      <PanelFrames />
      <CoverageFrames />
      {SHOW_SIDE_BY_SIDE && <SideBySideFrames />}
      {new URLSearchParams(window.location.search).has('run-inspector') && <RunInspectorFrames />}
      {new URLSearchParams(window.location.search).has('flow-graph') && <FlowGraphFrames />}
      {new URLSearchParams(window.location.search).has('run-controls') && <RunControlsFrames variant={ABANDON_VARIANTS.find((one: AbandonVariant) => one === new URLSearchParams(window.location.search).get('abandon')) ?? null} />}
      {new URLSearchParams(window.location.search).has('teams-page') && <TeamsPageFrames />}
      {new URLSearchParams(window.location.search).has('sidebar-structure') && <SidebarStructureExample />}
      {new URLSearchParams(window.location.search).has('team-record') && <TeamRecordFrames />}
      {new URLSearchParams(window.location.search).has('team-overview') && <TeamOverviewFrames />}
      {new URLSearchParams(window.location.search).has('stop-run') && <StopRunFrames scene={STOP_RUN_STATES.find(one => one === new URLSearchParams(window.location.search).get('stop-run')) ?? 'running'} />}
      {SHOW_COMPOSER_SLOTS && <ComposerSlotsFrames />}
      {SHOW_NOTICE_PLACEMENT && <NoticePlacementFrames />}
    </div>
  )
}

/** An audited Run frame mounts only its own synthetic data, like the Brief dialog. */
const RunPreview = () => {
  useTheme()
  const params = new URLSearchParams(window.location.search)
  if (params.has('run-again')) return <RunAgainExample opened scene={RUN_AGAIN_STATES.find(one => one === params.get('run-again')) ?? 'default'} />
  if (params.has('run-ending-rig')) return <RunEndingRigFrames />
  return <><RunViewFrames />{params.has('run-inspector') && <RunInspectorFrames />}</>
}

const container = document.getElementById('root')
if (!container) throw new Error('#root is missing from preview.html')

const TablesPreview = () => {
  useTheme()
  return <div className="bg-background p-4 text-foreground"><Frame id="tables-family" title="Tables: the family"><div className="p-4"><TablesFamily /></div></Frame></div>
}

const PublicationPreview = () => {
  useTheme()
  return <ReviewPublicationFrames />
}

const RefusedUndoPreview = () => {
  const theme = useTheme()
  return <div data-frame-id="undo-refused" className="h-screen bg-background">
    <PaneColumn inset="reading" page>
      <CatalogueRefusedUndo theme={theme} />
    </PaneColumn>
  </div>
}

const FindingsPreview = () => {
  useTheme()
  return <div className="min-h-screen bg-background p-4 text-foreground"><FindingFrames scene={new URLSearchParams(window.location.search).get('findings')} /></div>
}

createRoot(container).render(
  <StrictMode>
    <StoreProvider store={store}>
      <AppWindowMode.Provider value="embedded">
        {new URLSearchParams(window.location.search).has('team-frame')
          ? <TeamFrame />
          : new URLSearchParams(window.location.search).has('site-run')
          ? <SiteRunPreview />
          : new URLSearchParams(window.location.search).has('board-list')
          ? <BoardListFrames />
          : new URLSearchParams(window.location.search).has('tables')
          ? <TablesPreview />
          : new URLSearchParams(window.location.search).has('undo-refused')
          ? <RefusedUndoPreview />
          : new URLSearchParams(window.location.search).has('notices')
          ? <NoticesFrame />
          : new URLSearchParams(window.location.search).has('findings')
          ? <FindingsPreview />
          : new URLSearchParams(window.location.search).has('agent-brief')
          ? <AgentBriefFrames />
          : new URLSearchParams(window.location.search).has('cli-install')
          ? <CliInstallFrame />
          : new URLSearchParams(window.location.search).has('review-publication')
          ? <PublicationPreview />
          : new URLSearchParams(window.location.search).has('flow-brief')
          ? <FlowBriefDialog scene={(BRIEF_SCENES.find((one) => one === new URLSearchParams(window.location.search).get('flow-brief')) ?? 'empty') as BriefScene} />
          : new URLSearchParams(window.location.search).has('flow-overlay') ? <FlowOverlayFrames />
          : ['run-view', 'run-again', 'run-ending-rig'].some(one => new URLSearchParams(window.location.search).has(one)) ? <RunPreview /> : <Preview />}
      </AppWindowMode.Provider>
    </StoreProvider>
  </StrictMode>,
)
