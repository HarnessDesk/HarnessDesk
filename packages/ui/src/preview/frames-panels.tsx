import { runtimeId } from '@harnessdesk/protocol'

import { AuthorDialog } from '../components/LibraryActions'
import { BrowserPane } from '../components/BrowserPane'
import { ChannelStream } from '../components/Channel'
import { FilePane } from '../components/FilePane'
import { GitPane } from '../components/GitPane'
import { GoalHeader } from '../components/GoalHeader'
import { Panes } from '../components/Panes'
import { TaskPanel } from '../components/TaskPanel'
import { TerminalSurface } from '../components/TerminalPane'
import { MountProvider } from '../panels/mount'
import { PaneProvider, StoreProvider } from '../state/context'
import { Frame } from './main'
import { PREVIEW_ROOT, previewSession } from './sidebar-fixture'
import { PREVIEW_SESSION_KEY, previewStore } from './harness'
import { TEAM } from './harness'
import { PREVIEW_GOALS } from './goal-fixture'

/**
 * A store of its own, so `TaskPanel` — which reads the active session's own
 * `plan` field, the way ACP's `turn/plan` and Codex's `update_plan` both
 * land — has a plan to show without giving the shared preview session a
 * standing checklist that every other frame reading it never asked for.
 */
const taskPanelStore = previewStore({
  sessions: new Map([
    [
      PREVIEW_SESSION_KEY,
      {
        ...previewSession,
        turns: [
          ...previewSession.turns.slice(0, -1),
          {
            ...previewSession.turns[previewSession.turns.length - 1]!,
            plan: [
              { step: 'Find where worktree branches are listed', status: 'completed' as const },
              { step: 'Filter out branches deleted on the remote', status: 'inProgress' as const },
              { step: 'Add a test for the filtered case', status: 'pending' as const },
            ],
          },
        ],
      },
    ],
  ]),
} as never)

/** The one Goal fixture with a real `waitingOn` — `GoalHeader` draws nothing for a Goal that names neither a dependency nor a reason it cannot wrap, which every other Goal fixture on this page is. */
const GOAL_WAITING = PREVIEW_GOALS.find((one) => one.goal.id === 'goal-waiting')!

const LIBRARY_COLUMNS = [
  { id: 'codex' as never, label: 'Codex' },
  { id: 'claude' as never, label: 'Claude Code' },
]

/**
 * The tool panes and a few of the transcript's own header parts, each of
 * which reads its state from a `MountProvider` scope the same way the panel
 * system's own dock gives it one — this is one pane's worth of that scope,
 * not the dock itself, which `panels/Workbench.tsx` owns and a screen
 * preview never mounts (see the EXEMPT map in the coverage spec).
 */
export const PanelFrames = () => (
  <>
    <Frame title="Tools — a file">
      <div className="h-[420px]">
        <MountProvider scope={{ area: 'main', id: 'panel-file', view: { kind: 'file', path: '/work/project/lib/brands.ts', runtime: runtimeId('codex') } }}>
          <FilePane />
        </MountProvider>
      </div>
    </Frame>
    <Frame title="Tools — Git">
      <div className="h-[420px]">
        <MountProvider scope={{ area: 'main', id: 'panel-git', view: { kind: 'git', root: PREVIEW_ROOT } }}>
          <GitPane />
        </MountProvider>
      </div>
    </Frame>
    <Frame title="Tools — the browser">
      <div className="h-[420px]">
        <MountProvider
          scope={{
            area: 'main',
            id: 'panel-browser',
            view: { kind: 'browser', tabs: [{ id: 'tab-1', url: 'https://harnessdesk.app' }], active: 'tab-1', driven: 'tab-1' },
          }}
        >
          <BrowserPane />
        </MountProvider>
      </div>
    </Frame>
    <Frame title="Tools — the terminal">
      <div className="h-[320px]">
        <MountProvider
          scope={{
            area: 'main',
            id: 'panel-terminal',
            view: { kind: 'terminal', terminalId: 't-preview', runtime: runtimeId('codex'), cwd: PREVIEW_ROOT },
          }}
        >
          <TerminalSurface />
        </MountProvider>
      </div>
    </Frame>
    <Frame title="Goal — its header row">
      <div className="p-4">
        <GoalHeader view={GOAL_WAITING} />
      </div>
    </Frame>
    <Frame title="Room — the channel's own grouping">
      <div className="max-h-[420px] overflow-y-auto p-4">
        <ChannelStream entries={TEAM.channel} room={TEAM.id} onTrouble={() => {}} />
      </div>
    </Frame>
    <Frame title="Tasks — a session's own plan">
      <div className="max-w-[420px] p-4">
        <StoreProvider store={taskPanelStore}>
          <PaneProvider scope={{ paneId: 'preview-tasks' as never, view: { kind: 'conversation', session: PREVIEW_SESSION_KEY } as never, sessionKey: PREVIEW_SESSION_KEY }}>
            <TaskPanel />
          </PaneProvider>
        </StoreProvider>
      </div>
    </Frame>
    {/* The split tree itself, on the page's own shared store — whatever it
        opened on (the preview conversation), rendered through the same
        `Panes`/`panels/views.tsx` glue the real window's main area uses.
        Not the whole `Workbench` shell around it (no sidebar, no docks,
        no drag/resize wiring) — that is `panels/Workbench.tsx`'s job, and a
        screen preview mounts individual screens, never the app's chassis. */}
    <Frame title="Panes — the split tree">
      <div className="relative h-[420px]">
        <Panes />
      </div>
    </Frame>
    <Frame title="Library — writing a skill">
      <div className="max-w-[560px]">
        <AuthorDialog columns={LIBRARY_COLUMNS} onClose={() => {}} onPlan={() => {}} />
      </div>
    </Frame>
  </>
)
