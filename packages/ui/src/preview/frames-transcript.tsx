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
import type { GitTrouble } from '../lib/git-trouble'
import { WorktreeDialog } from '../components/GitWorktrees'
import { MemoryCitation } from '../components/MemoryCitation'
import { NewWorktree } from '../components/NewWorktree'
import { PreviewPane } from '../components/PreviewPane'
import { ProvenanceDialog } from '../components/ProvenanceDialog'
import { StepGroup } from '../components/StepGroup'
import { MountProvider } from '../panels/mount'
import { Menu } from '../design'
import { Dial, Frame } from './main'
import { PREVIEW_SESSION_KEY } from './harness'
import { PROVENANCE_ROOT, provenanceSeat } from './provenance-fixture'
import { previewHistory } from './sidebar-fixture'
import { PaneProvider } from '../state/context'

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
] as const
type DialogOption = (typeof DIALOG_OPTIONS)[number]

/**
 * Git, worktrees, panes and the transcript's own folded steps: a "git dialog"
 * dial for the sheets (the branch switcher, the changes review, asking an
 * agent to fix trouble, the worktree manager, a new worktree, the folder
 * picker, a Seat's provenance, the command palette, deleting a session), and
 * plain frames for the parts a conversation or a project already draws
 * inline — a folded burst of steps, a memory citation, a file preview pane,
 * a folder that is gone, and background tasks.
 */
export const TranscriptFrames = () => {
  const [dialog, setDialog] = useState<DialogOption>('off')
  return (
    <>
      <div className="my-4 flex flex-wrap items-center gap-3">
        <Dial label="git dialog" value={dialog} options={DIALOG_OPTIONS} onChange={setDialog} />
      </div>
      {/* `BranchSwitcher` draws `MenuItem`/`MenuLabel` rows, which throw
          outside a `<Menu>`'s scope — in production it always sits inside the
          conversation's own git menu (`Conversation.tsx`'s branch
          `Submenu`), never bare. */}
      {dialog === 'branch switcher' && (
        <div className="w-[340px] rounded-(--hd-radius-lg) shadow-[inset_0_0_0_1px_var(--hd-border-strong)] bg-(--hd-popover) p-1">
          <Menu close={() => setDialog('off')}>
            <BranchSwitcher root="/work/storefront" onDone={() => setDialog('off')} />
          </Menu>
        </div>
      )}
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
          <PaneProvider scope={{ paneId: 'preview-tasks' as never, view: { kind: 'conversation', session: PREVIEW_SESSION_KEY } as never, sessionKey: PREVIEW_SESSION_KEY }}>
            <BackgroundTasksView />
          </PaneProvider>
        </div>
      </Frame>
    </>
  )
}
