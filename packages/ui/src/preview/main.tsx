import { StrictMode, useState, useSyncExternalStore, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'

import { runtimeId, sessionKey, type Worktree, type WorktreeChanges } from '@harnessdesk/protocol'

import { BringHome } from '../components/BringHome'
import { Conversation } from '../components/Conversation'
import { CommitProvenance, CommitSeatLabels } from '../components/CommitProvenance'
import { ProjectProvenance } from '../components/ProjectProvenance'
import { AgentsView, ChangesView, TrajectoryView } from '../components/Details'
import { ObservedDialog } from '../components/EvidenceChips'
import { RunCheck } from '../components/RunCheck'
import { ProjectChecks } from '../components/ProjectChecks'
import { ProjectFlows } from '../components/ProjectFlows'
import { ProjectTriggers } from '../components/ProjectTriggers'
import { TriggerArm } from '../components/TriggerArm'
import { FlowUpdate } from '../components/FlowUpdate'
import { RaceStart } from '../components/RaceStart'
import { FlowRunStatus } from '../components/FlowRunStatus'
import { AppearanceSection } from '../components/SettingsYou'
import { LibrarySection } from '../components/Library'
import { AgentsWindow } from '../components/AgentsWindow'
import { NewSessionChoice } from '../components/NewSessionChoice'
import { SeatSheet } from '../components/SeatSheet'
import { SaveAsAgentDialog } from '../components/SaveAsAgent'
import { Settings, WorkspacesSection, type Section } from '../components/Settings'
import { Usage } from '../components/Usage'
import { SignIn } from '../components/SignIn'
import { RemoveWorktree } from './../components/RemoveWorktree'
import { Sidebar } from '../components/Sidebar'
import { TeamBoardPane } from '../components/TeamBoardPane'
import { TeamRoomPane } from '../components/TeamRoomPane'
import { NativeSelect } from '../design'
import { PaneProvider, StoreProvider } from '../state/context'
import { useTheme } from '../state/theme'
import { AppWindowMode } from '../components/AppWindow'
import { emptySnapshot, type AppSnapshot, type AppStore } from '../state/store'
import {
  Boundary,
  EDGE_ROOM,
  EMPTY_ROOM,
  PREVIEW_PLANS,
  PREVIEW_ROOM,
  PREVIEW_SESSION_KEY,
  runtime,
  store,
} from './harness'
import { PREVIEW_ROOT } from './sidebar-fixture'
import { EVIDENCE_BOARD, EVIDENCE_ROOM, EVIDENCE_TEAM, PREVIEW_UNSEEN } from './evidence-fixture'
import { captureHealth, commitProvenance, provenanceSeat, PROVENANCE_ROOT, PROVENANCE_SHA } from './provenance-fixture'
import { PREVIEW_GOAL, PREVIEW_TRIGGER_GOAL } from './goal-fixture'
import { GOAL_INTAKE_SCENES, sceneArmPreview, sceneGoalStatus, triggerFiring, triggerHistoryPage, triggerProjectView, TRIGGER_ARM_SCENES, type GoalIntakeScene, type TriggerArmScene } from './intake-fixture'
import '../styles/app.css'

const previewProvenance = commitProvenance({ seats: [{ ...provenanceSeat(7), runtime: 'codex', session: { runtime: 'codex', sessionId: 'conversation-7' } }] })
const previewMutable = store as unknown as { patch(partial: Partial<AppSnapshot>): void }
previewMutable.patch({ captureHealth: new Map([[PROVENANCE_ROOT, captureHealth()]]) })
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
const Frame = ({ title, children }: { title: string; children: ReactNode }) => (
  <section className="min-w-0">
    <h2 className="mb-2 text-sm font-semibold text-muted-foreground">{title}</h2>
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

const Dial = <T extends string>({
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
    | 'flow update'
    | 'flow customize'
    | 'race'
    | 'trigger arm'
  >('off')
  const [armScene, setArmScene] = useState<TriggerArmScene>('ready')
  const [goalScene, setGoalScene] = useState<GoalIntakeScene>('pull-request')
  // The Agents window's own rail selection: the overview, or one Agent's own page.
  const [agentsFocus, setAgentsFocus] = useState<string>('overview')
  return (
    <div className="min-h-full bg-background p-4 text-foreground">
      <section aria-label="Provenance preview">
        <Frame title="History — associated Seats"><CommitSeatLabels value={previewProvenance} /><CommitProvenance root={PROVENANCE_ROOT} sha={PROVENANCE_SHA} /></Frame>
        <Frame title="Project — capture"><ProjectProvenance root={PROVENANCE_ROOT} /></Frame>
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
          label="dialog"
          value={dialog}
          options={['off', 'remove', 'bring back', 'sign in', 'new session', 'seat sheet', 'save as agent', 'what was observed', 'run a check', 'flow update', 'flow customize', 'race', 'trigger arm'] as const}
          onChange={setDialog}
        />
        <Dial label="trigger arm scene" value={armScene} options={TRIGGER_ARM_SCENES} onChange={setArmScene} />
        <Dial
          label="goal intake scene"
          value={goalScene}
          options={GOAL_INTAKE_SCENES}
          onChange={(next) => { setGoalScene(next); setPreviewGoalIntakeScene(next) }}
        />
      </div>
      {/* Sign-in is on this page's own store rather than the worktree one: it
          reads the roster, which the fixture already has, and it is the one
          screen here that is *only* ever a dialog — so at a narrow window
          nothing else on the page shows what it does. */}
      {dialog === 'sign in' && <SignIn onClose={() => setDialog('off')} />}
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
          onRun={() => setDialog('off')}
          onCancel={() => setDialog('off')}
        />
      )}
      {dialog === 'new session' && <NewSessionChoice onClose={() => setDialog('off')} />}
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
      <Frame title="Board — the pane, with work on it">
        <div className="h-[560px]">
          <TeamBoardPane room={PREVIEW_ROOM} />
        </div>
      </Frame>
      <Frame title="Board — what the desk observed">
        <div className="h-[640px]">
          <TeamBoardPane room={EVIDENCE_ROOM} />
        </div>
      </Frame>
      <Frame title="Board — the empty state">
        <div className="h-[420px]">
          <TeamBoardPane room={EMPTY_ROOM} />
        </div>
      </Frame>
      {/* Narrow on purpose: the room gives its board whatever the rail left
          over, and every truncation bug this fixture exists for only appears
          at a width the card cannot have all of. */}
      <Frame title="Board — the edges, at the width the room leaves it">
        <div className="h-[560px] w-[760px]">
          <TeamBoardPane room={EDGE_ROOM} />
        </div>
      </Frame>
      {/* Settings is a fixed-position sheet, so it would paint over the whole
          page. A `transform` on the wrapper makes it the containing block for
          `position: fixed`, which pins the real dialog — unedited — inside a
          frame. It is the only way to see the settings surface at the 980px
          it actually opens at. */}
      <Frame title="Settings — the sheet, its nav, and a page">
        <div className="relative h-[860px]" style={{ transform: 'translateZ(0)' }}>
          {/* The page is the caller's, so the dial drives it directly and the
              sheet's own nav rail writes back to the same state — no remount,
              and clicking around in here moves the dial with it. */}
          <Settings
            section={settingsSection}
            onSection={setSettingsSection}
            onClose={() => {}}
            onSignIn={() => {}}
          />
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
      {/* The Agents window: the owner's left-menu decision, in its own
          top-level screen, never a Settings page — the same containment
          trick as Settings and Usage, both `AppWindow`s too. */}
      <Frame title="Agents — the roster, and a selected Agent">
        <div className="relative h-[860px]" style={{ transform: 'translateZ(0)' }}>
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
      <Frame title="Settings › Workspaces — a project">
        <div className="max-h-[560px] overflow-y-auto p-4">
          <WorkspacesSection focus={PREVIEW_ROOT} />
        </div>
      </Frame>
      <Frame title="Settings › Workspaces — Triggers on this Mac">
        <div className="max-h-[560px] overflow-y-auto p-4">
          <WorkspacesSection />
        </div>
      </Frame>
      {/* The Dashboard, at the width the window really opens it at. Its own
          rail scopes the page, so clicking an account in here shows the
          burn-down band the way the app does.

          It needs the same `transform` the Settings frame above does, and for
          the same reason: `Usage` is an `AppWindow`, which is
          `position: fixed`. Without a containing block it escaped its frame
          and painted over the *whole* preview page — every other frame on
          this page became unreachable, and a screenshot of any of them came
          back as the Dashboard. One line, and the trap is already documented
          four frames up. */}
      <Frame title="Dashboard — what is left, what it cost, where it went">
        <div className="relative h-[900px]" style={{ transform: 'translateZ(0)' }}>
          <Usage onClose={() => {}} onSignIn={() => {}} />
        </div>
      </Frame>

      {/* The conversation, which is the app. It is scoped by a `PaneProvider`
          exactly the way the workbench scopes it, so this is the same
          component the window renders and not a reduced one — the transcript,
          its header, and the composer under it. */}
      <Frame title="Conversation — the transcript and its composer">
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

      <div className="mt-4 grid grid-cols-1 gap-4 xl:grid-cols-[380px_1fr]">
        {/* The two right-dock panels, at the width the dock actually gives
            them — a panel judged at full width is not the panel. */}
        <Frame title="Side panel — Changes">
          <div className="h-[420px]">
            <PaneProvider
              scope={{
                paneId: 'preview' as never,
                view: { kind: 'conversation', session: PREVIEW_SESSION_KEY } as never,
                sessionKey: PREVIEW_SESSION_KEY,
              }}
            >
              <ChangesView />
            </PaneProvider>
          </div>
        </Frame>
        <Frame title="Side panel — Trajectory">
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
        <Frame title="Side panel — Agents, with the Seat record">
          <div className="h-[420px]">
            <PaneProvider
              scope={{
                paneId: 'preview' as never,
                view: { kind: 'conversation', session: PREVIEW_SESSION_KEY } as never,
                sessionKey: PREVIEW_SESSION_KEY,
              }}
            >
              <AgentsView />
            </PaneProvider>
          </div>
        </Frame>
        <Frame title="Project — its flows">
          <div className="p-4">
            <ProjectFlows root={PREVIEW_ROOT} current />
          </div>
        </Frame>
        <Frame title="Flow — run status, interrupted check">
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
        <Frame title="Project — its checks">
          <div className="p-4">
            <ProjectChecks root={PREVIEW_ROOT} />
          </div>
        </Frame>
        <Frame title="Project — its triggers">
          <div className="p-4">
            <ProjectTriggers root={PREVIEW_ROOT} />
          </div>
        </Frame>
      </div>

      <div className="mt-4 grid grid-cols-1 gap-4 xl:grid-cols-[380px_1fr]">
        {/* The sidebar at its real width, on the plate it really sits on:
            the right edge only reads true against the column's own ground. */}
        <Frame title="Sidebar — the column and its right edge">
          <div
            className="h-[720px]"
            style={{ width: 260, background: 'var(--hd-sidebar-plate, transparent)' }}
          >
            <Sidebar
              onOpenSettings={() => {}}
              onOpenPlugins={() => {}}
          onOpenAgents={() => {}}
              onOpenUsage={() => {}}
              onBrowseFolders={() => {}}
              onSignIn={() => {}}
              onSearch={() => {}}
            />
          </div>
        </Frame>
        <Frame title="Goal — state, roster and channel">
          <div className="h-[540px]">
            <TeamRoomPane room={PREVIEW_GOAL.goal.id} />
          </div>
        </Frame>
        <Frame title="Goal — opened by a trigger">
          <div className="h-[540px]">
            <TeamRoomPane key={goalScene} room={PREVIEW_TRIGGER_GOAL.goal.id} />
          </div>
        </Frame>
        <div className="flex min-w-0 flex-col gap-4">
          <Frame title="Settings › Library">
            <div className="max-h-[540px] overflow-y-auto p-4">
              <LibrarySection />
            </div>
          </Frame>
          <Frame title="Settings › Appearance">
            <div className="p-4">
              <AppearanceSection />
            </div>
          </Frame>
        </div>
      </div>
    </div>
  )
}

const container = document.getElementById('root')
if (!container) throw new Error('#root is missing from preview.html')

createRoot(container).render(
  <StrictMode>
    <StoreProvider store={store}>
      <AppWindowMode.Provider value="embedded">
        <Preview />
      </AppWindowMode.Provider>
    </StoreProvider>
  </StrictMode>,
)
