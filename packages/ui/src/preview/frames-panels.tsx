import { GIT_PREVIEW_ROOT } from './git-fixture'
import { useState } from 'react'

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
/* `Panes`'s own `ViewHost` resolves a pane's view kind ('conversation',
   'file', …) through the registry `panels/builtins.tsx` fills by
   `registerView`, side-effect-only — normally imported once by
   `panels/Workbench.tsx`, which a screen preview never mounts. Without it
   the registry is empty and every pane in a split renders as an unknown,
   chromeless nothing; `TeamRoomPane.test.tsx` and its neighbours import this
   same file for the identical reason. */
import '../panels/builtins'
import { MountProvider } from '../panels/mount'
import { PaneProvider, StoreProvider } from '../state/context'
import { Boundary } from './boundary'
import { Dial, Frame } from './main'
import { PREVIEW_ROOT, previewSession } from './sidebar-fixture'
import { libraryColumnsFor, PREVIEW_SESSION_KEY, previewStore, TEAM } from './harness'
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
  ]) as never,
})

/** The one Goal fixture with a real `waitingOn` — `GoalHeader` draws nothing for a Goal that names neither a dependency nor a reason it cannot wrap, which every other Goal fixture on this page is. */
const GOAL_WAITING = PREVIEW_GOALS.find((one) => one.goal.id === 'goal-waiting')!

const LIBRARY_COLUMNS = libraryColumnsFor([runtimeId('codex'), runtimeId('claude')])

/** A self-contained page, so the browser pane has something to frame with no network reach and no real origin to name. */
const BROWSER_DEMO_URL = `data:text/html,${encodeURIComponent('<!doctype html><meta charset="utf-8"><title>Example</title><body style="font:14px sans-serif;padding:2rem;color:#333">A page open in the browser pane.</body>')}`

/**
 * The tool panes and a few of the transcript's own header parts, each of
 * which reads its state from a `MountProvider` scope the same way the panel
 * system's own dock gives it one — this is one pane's worth of that scope,
 * not the dock itself, which `panels/Workbench.tsx` owns and a screen
 * preview never mounts (see the EXEMPT map in the coverage spec). A
 * "panel dialog" dial holds the sheet among them (`AuthorDialog`, a
 * `Dialog`) and the split tree — off by default like every dialog on the
 * page, but for a second reason here too: `Panes`'s own conversation pane
 * mounts the same `Conversation` the page's main frame already does, and a
 * second copy on screen by default doubled every page-global locator the
 * existing ui-system suite reaches for (the model-and-reasoning trigger, its
 * menu, its submenu) — a strict-mode failure in specs this page must not
 * weaken.
 *
 * The same dial also holds "git tools": `GitPane`'s own "Which branches"
 * segmented control has no scope of its own to tell it apart from another
 * `GitPane` on the same page, and `git-scope.spec.ts` mounts a second one (a
 * synthetic fixture injected straight into `main.tsx`) to measure it —
 * doubling the page-global `getByRole('radiogroup', {name: 'Which
 * branches'})` count that spec holds at exactly two. Off by default keeps a
 * fresh load down to the one `GitPane` a spec expects; the coverage sweep
 * still turns this dial on, so `GitPane.tsx` stays covered.
 */
const PANEL_DIALOG_OPTIONS = ['off', 'write a skill', 'split tree', 'git tools'] as const
type PanelDialogOption = (typeof PANEL_DIALOG_OPTIONS)[number]

export const PanelFrames = () => {
  const [dialog, setDialog] = useState<PanelDialogOption>('off')
  return (
    <>
      <div className="my-4 flex flex-wrap items-center gap-3">
        <Dial label="panel sheet" value={dialog} options={PANEL_DIALOG_OPTIONS} onChange={setDialog} />
      </div>
      {/* Bare, position:fixed, and not inside a `Frame` (which carries its
          own `Boundary`) — without one here a throw would unmount every
          frame this page draws, not just this file's own. */}
      <Boundary>
        {dialog === 'write a skill' && <AuthorDialog columns={LIBRARY_COLUMNS} onClose={() => setDialog('off')} onPlan={() => setDialog('off')} />}
      </Boundary>
      {/* The split tree itself, on the page's own shared store — whatever it
          opened on (the preview conversation), rendered through the same
          `Panes`/`panels/views.tsx` glue the real window's main area uses.
          Not the whole `Workbench` shell around it (no sidebar, no docks,
          no drag/resize wiring) — that is `panels/Workbench.tsx`'s job, and a
          screen preview mounts individual screens, never the app's chassis.
          Off by default: it mounts the same `Conversation` the page's main
          frame does, and two by default doubles every locator the existing
          ui-system suite reaches for expecting one. */}
      {dialog === 'split tree' && (
        <Frame id="panes-split-tree" title="Panes — the split tree">
          <div className="relative h-[420px]">
            <Panes />
          </div>
        </Frame>
      )}
      <Frame id="tools-file" title="Tools — a file">
        <div className="h-[420px]">
          <MountProvider scope={{ area: 'main', id: 'panel-file', view: { kind: 'file', path: '/work/project/lib/brands.ts', runtime: runtimeId('codex') } }}>
            <FilePane />
          </MountProvider>
        </div>
      </Frame>
      {dialog === 'git tools' && (
        <Frame id="tools-git" title="Tools — Git">
          <div className="h-[640px]">
            <MountProvider scope={{ area: 'main', id: 'panel-git', view: { kind: 'git', root: GIT_PREVIEW_ROOT } }}>
              <GitPane />
            </MountProvider>
          </div>
        </Frame>
      )}
        <Frame id="tools-browser" title="Tools — the browser">
        <div className="h-[420px]">
          <MountProvider
            scope={{
              area: 'main',
              id: 'panel-browser',
              // A real remote origin loads over the network and, framed
              // here, answers with its own X-Frame-Options — the one
              // console error a fresh load of this page had. A `data:` URL
              // has no such header and needs no network at all.
              view: { kind: 'browser', tabs: [{ id: 'tab-1', url: BROWSER_DEMO_URL }], active: 'tab-1', driven: 'tab-1' },
            }}
          >
            <BrowserPane />
          </MountProvider>
        </div>
      </Frame>
      <Frame id="tools-terminal" title="Tools — the terminal">
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
      <Frame id="goal-header-row" title="Goal — its header row">
        <div className="p-4">
          <GoalHeader view={GOAL_WAITING} />
        </div>
      </Frame>
      <Frame id="room-channel-grouping" title="Room — the channel's own grouping">
        <div className="max-h-[420px] overflow-y-auto p-4">
          <ChannelStream entries={TEAM.channel} room={TEAM.id} onTrouble={() => {}} />
        </div>
      </Frame>
      <Frame id="tasks-session-plan" title="Tasks — a session's own plan">
        <div className="max-w-[420px] p-4">
          <StoreProvider store={taskPanelStore}>
            <PaneProvider scope={{ paneId: 'preview-tasks' as never, view: { kind: 'conversation', session: PREVIEW_SESSION_KEY } as never, sessionKey: PREVIEW_SESSION_KEY }}>
              <TaskPanel />
            </PaneProvider>
          </StoreProvider>
        </div>
      </Frame>
    </>
  )
}
