import { useState } from 'react'

import { projectGroupRootOf, type ProjectGroup } from '../lib/projects'
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
  SettingsIcon,
  TerminalIcon,
  TrashIcon,
  UnpinIcon,
} from './Icons'
import {
  Button,
  ContextMenu,
  MenuItem,
  MenuNote,
  MenuSeparator,
  PopoverGroupLabel,
  SortableAnnouncer,
  useMenuClose,
  useSortable,
  type MenuPoint,
} from '../design'
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
  current,
  actualRoot,
  at,
  onClose,
  onNewWorktree,
}: {
  group: ProjectGroup
  /** Whether `group` is the folder the app has open right now. */
  current: boolean
  /**
   * `group.root`, corrected for the one case it must not be acted on
   * directly: a non-git folder opened through an alias groups by the
   * host's `realPath` (#907), and starting a session, opening a worktree
   * or opening the workspace at that spelling reopened the exact alias
   * this row exists to fold away, as a second, indistinguishable one. Equal
   * to `group.root` whenever `current` is false — there is no "the
   * spelling it was opened at" for a project this window is not standing
   * in, only the root its own sessions were grouped by.
   */
  actualRoot: string
  at: MenuPoint | null
  onClose: () => void
  /** Raises the new-worktree dialog; it belongs to the list, not to a row. */
  onNewWorktree: (root: string) => void
}) => {
  const store = useStore()
  const snapshot = useSnapshot()
  /* The arranged run is a sortable order, and this menu's Move rows are its
     keyboard route: a move is the sortable part's request, answered by the
     store and then said out loud in the part's own words, the way a drag or
     ⌥↑/⌥↓ on a sortable row is. The announcer sits beside the menu rather
     than in it: a menu holds menu items, and the sentence has to outlive the
     menu closing. */
  const sortable = useSortable({
    ids: snapshot.listPrefs.pinned,
    onMove: (root, to) => store.moveProject(root, to),
    name: (root) => (root === group.root ? group.name : root),
    left: (root) => `${root === group.root ? group.name : root} is back in automatic order`,
  })
  return (
    <>
      <ContextMenu at={at} label={`Actions for ${group.name}`} onClose={onClose}>
        <WorkspaceRows
          group={group}
          current={current}
          actualRoot={actualRoot}
          onNewWorktree={onNewWorktree}
          onMove={sortable.move}
        />
      </ContextMenu>
      <SortableAnnouncer message={sortable.announcement} />
    </>
  )
}

const WorkspaceRows = ({
  group,
  current,
  actualRoot,
  onNewWorktree,
  onMove,
}: {
  group: ProjectGroup
  current: boolean
  actualRoot: string
  onNewWorktree: (root: string) => void
  onMove: (root: string, to: number) => void
}) => {
  const store = useStore()
  const snapshot = useSnapshot()
  const close = useMenuClose()
  const [confirming, setConfirming] = useState<'archive' | 'remove' | null>(null)
  const [busy, setBusy] = useState(false)

  // Canonical, like `group.root` itself — a workspace opened through an
  // alias (a symlink, or a non-git folder the host now resolves too, #907)
  // never matches `group.root` by its own raw `path`, current or not. Kept
  // as the entry itself, not only whether one exists: forgetting a project
  // has to name the same raw spelling `workspace/open` recorded it under,
  // which for an alias is not `group.root` either.
  const openEntry = snapshot.workspaces.find((workspace) => projectGroupRootOf(workspace) === group.root)
  const opened = openEntry !== undefined
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

  /* Past the end of the arranged run is back into the sort (the store
     unpins it); anywhere in it is a place in the run. */
  const move = (to: number): void => onMove(group.root, to)

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
        <PopoverGroupLabel>
          {remove ? `Remove ${group.name}?` : `Archive ${sessionsWord}?`}
        </PopoverGroupLabel>
        <MenuNote>
          {remove
            ? `Its ${sessionsWord} are archived and the folder leaves this list. Nothing on disk changes.`
            : 'They leave this list but stay in the agent’s history.'}
        </MenuNote>
        <div className={styles.confirmActions}>
          <Button
            variant="ghost" size="sm"
            disabled={busy}
            onClick={() => setConfirming(null)}
          >
            Cancel
          </Button>
          <Button
            variant="destructive" size="sm"
            disabled={busy}
            onClick={() =>
              void run(async () => {
                await store.archiveSessions(group.sessions)
                if (remove && openEntry) await store.forgetWorkspace(openEntry.path)
              })
            }
          >
            {busy ? 'Working…' : remove ? 'Remove' : 'Archive'}
          </Button>
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
        onSelect={() => void store.startSessionIn(actualRoot)}
      />
      {isRepo && (
        <MenuItem
          icon={<BranchIcon size={14} />}
          label="New worktree…"
          title="Its own checkout on its own branch."
          disabled={!ready}
          onSelect={() => onNewWorktree(actualRoot)}
        />
      )}
      {!current && (
        <MenuItem
          icon={<FolderOpenIcon size={14} />}
          label="Open workspace"
          title="Make this the folder the app works in."
          onSelect={() => void store.openWorkspace(openEntry?.path ?? actualRoot)}
        />
      )}

      <MenuSeparator />

      {isDesktop() && (
        <MenuItem
          icon={<FolderOpenIcon size={14} />}
          label="Reveal in Finder"
          disabled={opened || current ? false : 'Open the workspace first.'}
          onSelect={() => void store.revealWorkspace(actualRoot)}
        />
      )}
      <MenuItem
        icon={<TerminalIcon size={14} />}
        label="Open terminal here"
        disabled={!ready}
        onSelect={() => void store.openTerminal({ cwd: actualRoot })}
      />
      {isRepo && (
        <MenuItem
          icon={<HistoryIcon size={14} />}
          label="History"
          title="Commits, branches and tags, in a pane."
          onSelect={() => store.openGitHistory(actualRoot)}
        />
      )}
      <MenuItem
        icon={<CopyIcon size={14} />}
        label="Copy path"
        hint={actualRoot}
        onSelect={() => void navigator.clipboard?.writeText(actualRoot)}
      />
      <MenuItem
        icon={<SettingsIcon size={14} />}
        label="Project settings"
        title="Its own Agents, on a page of its own."
        onSelect={() => store.askSettings('workspaces', group.root)}
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
        onSelect={() => move(place === -1 ? order.length : place - 1)}
      />
      <MenuItem
        icon={<MoveDownIcon size={14} />}
        label="Move down"
        keepOpen
        hint={place === order.length - 1 ? 'Back into automatic order.' : undefined}
        onSelect={() => move(place === -1 ? order.length : place + 1)}
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
