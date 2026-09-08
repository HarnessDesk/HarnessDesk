import { useState } from 'react'

import type { ProjectGroup } from '../lib/projects'
import { isDesktop } from '../lib/desktop'
import { useSnapshot, useStore } from '../state/context'
import {
  ArchiveIcon,
  BranchIcon,
  CopyIcon,
  FolderOpenIcon,
  HistoryIcon,
  MoveDownIcon,
  MoveUpIcon,
  PinIcon,
  PlusIcon,
  TerminalIcon,
  TrashIcon,
  UnpinIcon,
} from './Icons'
import { ContextMenu, MenuItem, MenuSeparator, useMenuClose, type MenuPoint } from './Menu'
import styles from './WorkspaceMenu.module.css'

/**
 * What can be done to a project, from its row in the sidebar.
 *
 * Grouped the way the verbs group: start something here; get to the folder
 * from outside the app; arrange the list; and, last and in red, the two
 * things that take sessions away. The row itself already opens and closes
 * the group, so the menu does not repeat that.
 *
 * A project is a set of sessions the runtime remembers, not a record of
 * HarnessDesk's own, so "remove" cannot simply delete it: it archives the
 * sessions (the runtime keeps them, out of sight) and forgets the folder.
 * Both destructive rows confirm in place — a second click in the same
 * spot, with the consequence spelled out — rather than in a dialog.
 */

export const WorkspaceMenu = ({
  group,
  at,
  onClose,
  onNewWorktree,
}: {
  group: ProjectGroup
  at: MenuPoint | null
  onClose: () => void
  /** Raises the new-worktree dialog; it belongs to the list, not to a row. */
  onNewWorktree: (root: string) => void
}) => (
  <ContextMenu at={at} label={`Actions for ${group.name}`} onClose={onClose}>
    <WorkspaceRows group={group} onNewWorktree={onNewWorktree} />
  </ContextMenu>
)

const WorkspaceRows = ({
  group,
  onNewWorktree,
}: {
  group: ProjectGroup
  onNewWorktree: (root: string) => void
}) => {
  const store = useStore()
  const snapshot = useSnapshot()
  const close = useMenuClose()
  const [confirming, setConfirming] = useState<'archive' | 'remove' | null>(null)
  const [busy, setBusy] = useState(false)

  const current = snapshot.workspace?.path === group.root
  const opened = snapshot.workspaces.some((workspace) => workspace.path === group.root)
  // The arranged run, and where this project sits in it. -1 means it is not
  // in the run at all: the sort is still deciding where it goes.
  const order = snapshot.listPrefs.pinned
  const place = order.indexOf(group.root)
  const pinned = place !== -1
  const ready = snapshot.health?.state === 'ready'
  // A repository is a precondition for a worktree. The group itself does not
  // know; its sessions do, and the open workspace knows for certain.
  const isRepo = current
    ? Boolean(snapshot.workspace?.git?.branch)
    : group.sessions.some((summary) => Boolean(summary.git?.branch))
  const count = group.sessions.length
  const sessionsWord = count === 1 ? '1 session' : `${count} sessions`

  const run = async (work: () => Promise<void>): Promise<void> => {
    setBusy(true)
    try {
      await work()
    } finally {
      setBusy(false)
      close()
    }
  }

  if (confirming) {
    const remove = confirming === 'remove'
    return (
      <div className={styles.confirm} role="group" aria-label={remove ? 'Remove project' : 'Archive sessions'}>
        <div className={styles.confirmTitle}>
          {remove ? `Remove ${group.name}?` : `Archive ${sessionsWord}?`}
        </div>
        <div className={styles.confirmText}>
          {remove
            ? `Its ${sessionsWord} are archived and the folder leaves this list. Nothing on disk changes.`
            : 'They leave this list but stay in the agent’s history.'}
        </div>
        <div className={styles.confirmActions}>
          <button
            type="button"
            className={styles.button}
            disabled={busy}
            onClick={() => setConfirming(null)}
          >
            Cancel
          </button>
          <button
            type="button"
            className={`${styles.button} ${styles.buttonDanger}`}
            disabled={busy}
            onClick={() =>
              void run(async () => {
                await store.archiveSessions(group.sessions)
                if (remove && opened) await store.forgetWorkspace(group.root)
              })
            }
          >
            {busy ? 'Working…' : remove ? 'Remove' : 'Archive'}
          </button>
        </div>
      </div>
    )
  }

  return (
    <>
      <MenuItem
        icon={<PlusIcon size={14} />}
        label="New session"
        hint={current ? undefined : 'Switches to this folder first.'}
        disabled={!ready}
        onSelect={() => void store.startSessionIn(group.root)}
      />
      {isRepo && (
        <MenuItem
          icon={<BranchIcon size={14} />}
          label="New worktree…"
          title="Its own checkout on its own branch."
          disabled={!ready}
          onSelect={() => onNewWorktree(group.root)}
        />
      )}
      {!current && (
        <MenuItem
          icon={<FolderOpenIcon size={14} />}
          label="Open workspace"
          title="Make this the folder the app works in."
          onSelect={() => void store.openWorkspace(group.root)}
        />
      )}

      <MenuSeparator />

      {isDesktop() && (
        <MenuItem
          icon={<FolderOpenIcon size={14} />}
          label="Reveal in Finder"
          disabled={opened || current ? false : 'Open the workspace first.'}
          onSelect={() => void store.revealWorkspace(group.root)}
        />
      )}
      <MenuItem
        icon={<TerminalIcon size={14} />}
        label="Open terminal here"
        disabled={!ready}
        onSelect={() => void store.openTerminal({ cwd: group.root })}
      />
      {isRepo && (
        <MenuItem
          icon={<HistoryIcon size={14} />}
          label="History"
          title="Commits, branches and tags, in a pane."
          onSelect={() => store.openGitHistory(group.root)}
        />
      )}
      <MenuItem
        icon={<CopyIcon size={14} />}
        label="Copy path"
        hint={group.root}
        onSelect={() => void navigator.clipboard?.writeText(group.root)}
      />

      <MenuSeparator />

      {/* The same move the drag makes, for a keyboard. A project that is not
          in the arranged run yet joins it at the end, which is still above
          everything the sort is ordering — so one press does something, and
          the next two are the ordinary step. */}
      <MenuItem
        icon={<MoveUpIcon size={14} />}
        label="Move up"
        keepOpen
        disabled={place === 0 ? 'Already first.' : false}
        onSelect={() => store.moveProject(group.root, place === -1 ? order.length : place - 1)}
      />
      <MenuItem
        icon={<MoveDownIcon size={14} />}
        label="Move down"
        keepOpen
        hint={place === order.length - 1 ? 'Back into automatic order.' : undefined}
        onSelect={() => store.moveProject(group.root, place === -1 ? order.length : place + 1)}
      />
      <MenuItem
        icon={pinned ? <UnpinIcon size={14} /> : <PinIcon size={14} />}
        label={pinned ? 'Unpin' : 'Pin to top'}
        onSelect={() => store.togglePinned(group.root)}
      />

      <MenuSeparator />

      <MenuItem
        icon={<ArchiveIcon size={14} />}
        label={`Archive ${sessionsWord}…`}
        disabled={count === 0}
        keepOpen
        onSelect={() => setConfirming('archive')}
      />
      <MenuItem
        icon={<TrashIcon size={14} />}
        label="Remove project…"
        danger
        keepOpen
        onSelect={() => setConfirming('remove')}
      />
    </>
  )
}
