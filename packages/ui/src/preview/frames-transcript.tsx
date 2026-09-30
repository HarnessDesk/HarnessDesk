import { useState } from 'react'

import { runtimeId, type AgentItem } from '@harnessdesk/protocol'

import { BackgroundTasksView } from '../components/BackgroundTasks'
import { BranchSwitcher } from '../components/BranchSwitcher'
import { ChangesReview } from '../components/ChangesReview'
import { CommandPalette, type PaletteHost } from '../components/CommandPalette'
import { DeleteSession } from '../components/DeleteSession'
import { FolderGone } from '../components/FolderGone'
import { FolderPicker } from '../components/FolderPicker'
import { AskAgentDialog } from '../components/GitAskAgent'
import {
  CommitDialog,
  DeleteBranchDialog,
  DiffRangeDialog,
  MergeDialog,
  RenameBranchDialog,
  ResetDialog,
  StashDialog,
  TagDialog,
} from '../components/GitDialogs'
import type { GitTrouble } from '../lib/git-trouble'
import { WorktreeDialog } from '../components/GitWorktrees'
import { MemoryCitation } from '../components/MemoryCitation'
import { NewWorktree } from '../components/NewWorktree'
import { PreviewPane } from '../components/PreviewPane'
import { ProvenanceDialog } from '../components/ProvenanceDialog'
import { StepGroup } from '../components/StepGroup'
import { MountProvider } from '../panels/mount'
import { Boundary } from './boundary'
import { Menu } from '../design'
import { Dial, Frame } from './main'
import { GIT_COMMITS, gitRefs } from './git-fixture'
import { PREVIEW_SESSION_KEY, previewStore } from './harness'
import { PROVENANCE_ROOT, provenanceSeat } from './provenance-fixture'
import { previewHistory, previewSession } from './sidebar-fixture'
import { PaneProvider, StoreProvider } from '../state/context'

/**
 * A store of its own, so `BackgroundTasksView`'s own frame can show a
 * running and a finished task without also giving the *main* Conversation
 * frame's header the same ones — `tasks` is read by session key everywhere
 * on the page that key appears, and a task on the shared store's own map
 * pushed a "1 running in the background" badge into the header the existing
 * header-title-floor.spec.ts already measures at a phone width, overflowing
 * it by the badge's own width.
 */
const backgroundTasksStore = previewStore({
  sessions: new Map([[PREVIEW_SESSION_KEY, previewSession]]) as never,
  tasks: new Map([
    [
      PREVIEW_SESSION_KEY,
      [
        {
          id: 'task-preview-1',
          label: 'pnpm test',
          kind: 'command',
          state: 'completed',
          command: 'pnpm test',
          cwd: '/work/storefront',
          startedAt: Date.now() - 90_000,
          endedAt: Date.now() - 60_000,
          summary: 'Passed, 214 tests.',
        },
        {
          id: 'task-preview-2',
          label: 'pnpm build',
          kind: 'command',
          state: 'running',
          command: 'pnpm build',
          cwd: '/work/storefront',
          startedAt: Date.now() - 20_000,
        },
      ],
    ],
  ]) as never,
})

/** Two ordinary, templated tool calls — the shape `StepGroup` folds away once a run finishes. */
const STEP_ITEMS: readonly AgentItem[] = [
  { id: 'read-1' as never, type: 'toolCall', tool: 'Read', source: { kind: 'builtin' }, status: 'completed', args: { path: 'src/worktrees.ts' } } as unknown as AgentItem,
  { id: 'search-1' as never, type: 'toolCall', tool: 'Grep', source: { kind: 'builtin' }, status: 'completed', args: { pattern: 'listBranches' } } as unknown as AgentItem,
]

const TROUBLE: GitTrouble = {
  attempt: 'rebase of feat/checkout-retry onto main',
  root: '/work/storefront',
  said: 'The rebase onto main would not apply cleanly and was aborted; nothing changed. The file that clashed: src/checkout.ts.',
  posture: 'refused',
  branch: 'feat/checkout-retry',
}

const PALETTE_HOST: PaletteHost = {
  openSettings: () => {},
  openUsage: () => {},
  chooseFolder: () => {},
  openAgents: () => {},
  openFrontDoor: () => {},
  close: () => {},
}

const DIALOG_OPTIONS = [
  'off', 'branch switcher', 'changes review', 'ask agent', 'worktree manager', 'new worktree',
  'folder picker', 'provenance', 'command palette', 'delete session',
  'commit', 'merge', 'rename branch', 'delete branch', 'tag', 'reset', 'stash', 'diff range',
] as const
type DialogOption = (typeof DIALOG_OPTIONS)[number]

/** A history to draw the eight git dialogs against — the same one `GitPane`'s own frame reads. */
const GIT_DIALOG_ROOT = '/work/storefront'
const GIT_DIALOG_REFS = gitRefs()
const GIT_DIALOG_COMMIT = GIT_COMMITS[0]!

/**
 * `BranchSwitcher` draws `MenuItem`/`MenuLabel`/`MenuNote` rows, which throw
 * outside a `<Menu>`'s scope — in production it always sits behind the
 * conversation's own branch row, a `Submenu` that opens on hover
 * (`Conversation.tsx`). A static preview has no hover to give that trigger,
 * and Base UI's own `openOnHover` needs its real pointer-intent timer to
 * fire — not something a synthetic event reliably stands in for outside the
 * exact `Submenu`/`Menu` nesting it was written against — so this renders
 * `BranchSwitcher` open, straight inside the same real `Menu` surface
 * (border, shadow, corner, all from the design system) rather than
 * reproducing the hover mechanics themselves. Real popup chrome, not a
 * hand-drawn shell; not a re-enactment of a mouse that was never there.
 */
const BranchSwitcherFlyout = ({ onDone }: { readonly onDone: () => void }) => (
  <Menu close={onDone}>
    <div className="w-[340px]">
      <BranchSwitcher root="/work/storefront" onDone={onDone} />
    </div>
  </Menu>
)

/**
 * Git, worktrees, panes and the transcript's own folded steps: a "git sheet"
 * dial for the sheets (the branch switcher, the changes review, asking an
 * agent to fix trouble, the worktree manager, a new worktree, the folder
 * picker, a Seat's provenance, the command palette, deleting a session, and
 * `GitDialogs.tsx`'s own eight — commit, merge, rename/delete a branch, tag,
 * reset, stash, a diff range), and plain frames for the parts a conversation
 * or a project already draws inline — a folded burst of steps, a memory
 * citation, a file preview pane, a folder that is gone, and background tasks.
 *
 * The eight `GitDialogs.tsx` exports were never reachable from any frame
 * before this dial: the coverage gate's old name-matching credited the file
 * for a same-named `ConfirmDialog` the design system happens to export too,
 * which the file-identity rewrite (`preview-coverage.spec.ts`) no longer
 * confuses with the genuine article.
 */
export const TranscriptFrames = () => {
  const [dialog, setDialog] = useState<DialogOption>('off')
  return (
    <>
      <div className="my-4 flex flex-wrap items-center gap-3">
        <Dial label="git sheet" value={dialog} options={DIALOG_OPTIONS} onChange={setDialog} />
      </div>
      {/* One `Boundary` around the whole cluster: none of these bare,
          position:fixed dialogs sits inside a `Frame` (which already
          carries its own), and without one here a throw in any single
          dialog unmounts every frame this page draws —
          `PanelFrames`/`GoalFrames`/`SettingsFrames` included, not just
          this file's own. */}
      <Boundary>
        {dialog === 'branch switcher' && <BranchSwitcherFlyout onDone={() => setDialog('off')} />}
        {dialog === 'changes review' && <ChangesReview onClose={() => setDialog('off')} />}
        {dialog === 'ask agent' && <AskAgentDialog trouble={TROUBLE} onDone={() => setDialog('off')} />}
        {dialog === 'worktree manager' && <WorktreeDialog root="/work/storefront" onAdd={() => {}} onDone={() => setDialog('off')} />}
        {dialog === 'new worktree' && <NewWorktree root="/work/storefront" onClose={() => setDialog('off')} />}
        {dialog === 'folder picker' && <FolderPicker onClose={() => setDialog('off')} />}
        {dialog === 'provenance' && (
          <ProvenanceDialog root={PROVENANCE_ROOT} seat={provenanceSeat(7).id} onClose={() => setDialog('off')} />
        )}
        {dialog === 'command palette' && <CommandPalette host={PALETTE_HOST} />}
        {dialog === 'delete session' && <DeleteSession summary={previewHistory[0]!} onClose={() => setDialog('off')} />}
        {dialog === 'commit' && <CommitDialog root={GIT_DIALOG_ROOT} onDone={() => setDialog('off')} />}
        {dialog === 'merge' && <MergeDialog root={GIT_DIALOG_ROOT} refs={GIT_DIALOG_REFS} onDone={() => setDialog('off')} />}
        {dialog === 'rename branch' && (
          <RenameBranchDialog root={GIT_DIALOG_ROOT} from="feat/worktrees" onDone={() => setDialog('off')} />
        )}
        {dialog === 'delete branch' && (
          <DeleteBranchDialog root={GIT_DIALOG_ROOT} name="feat/worktrees" onDone={() => setDialog('off')} />
        )}
        {dialog === 'tag' && <TagDialog root={GIT_DIALOG_ROOT} at={GIT_DIALOG_COMMIT.sha} onDone={() => setDialog('off')} />}
        {dialog === 'reset' && (
          <ResetDialog
            root={GIT_DIALOG_ROOT}
            to={GIT_DIALOG_COMMIT.sha}
            subject={GIT_DIALOG_COMMIT.subject}
            branch="main"
            onDone={() => setDialog('off')}
          />
        )}
        {dialog === 'stash' && <StashDialog root={GIT_DIALOG_ROOT} onDone={() => setDialog('off')} />}
        {dialog === 'diff range' && (
          <DiffRangeDialog
            root={GIT_DIALOG_ROOT}
            from={GIT_DIALOG_REFS.branches[1]!.sha}
            to={GIT_DIALOG_COMMIT.sha}
            onDone={() => setDialog('off')}
          />
        )}
      </Boundary>

      <Frame title="A folded burst of steps">
        <div className="max-w-[640px] p-4">
          <StepGroup items={STEP_ITEMS} running={false} root="/work/storefront" />
        </div>
      </Frame>
      <Frame title="A memory citation, read from the working tree">
        <div className="max-w-[480px] p-4">
          <MemoryCitation root="/work/storefront" goal={null} />
        </div>
      </Frame>
      <Frame title="Preview pane — a file from the tools surface">
        <div className="h-[420px]">
          <MountProvider scope={{ area: 'main', id: 'preview-pane', view: { kind: 'preview', path: '/work/project/lib/brands.ts', runtime: runtimeId('codex') } }}>
            <PreviewPane />
          </MountProvider>
        </div>
      </Frame>
      <Frame title="A folder that no longer exists">
        <div className="p-4">
          <FolderGone folder="/work/storefront" said="No such file or directory" />
        </div>
      </Frame>
      <Frame title="Background tasks — this conversation's own">
        <div className="h-[320px]">
          <StoreProvider store={backgroundTasksStore}>
            <PaneProvider scope={{ paneId: 'preview-tasks' as never, view: { kind: 'conversation', session: PREVIEW_SESSION_KEY } as never, sessionKey: PREVIEW_SESSION_KEY }}>
              <BackgroundTasksView />
            </PaneProvider>
          </StoreProvider>
        </div>
      </Frame>
    </>
  )
}
