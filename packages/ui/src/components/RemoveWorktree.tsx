import { useEffect, useState } from 'react'

import type { Worktree, WorktreeChanges } from '@harnessdesk/protocol'

import { ConfirmDialog } from '../design'
import { useStore } from '../state/context'
import { BranchIcon } from './Icons'
import { IgnoredEntries, UncommittedFiles, WorktreeProblem, describeUncommitted } from './WorktreeAlerts'

/**
 * Removing a worktree.
 *
 * The host refuses to remove one with uncommitted work unless told to force,
 * and this dialog is the only place that ever sends force: it fetches what
 * would be lost, lists every file, and makes discarding them a separate,
 * red, explicitly-labelled step. A clean worktree goes without ceremony.
 * The branch is never deleted — the host keeps it, and the dialog says so.
 *
 * The surface, the Escape key, the focus return and where the buttons go are
 * all `ConfirmDialog`'s problem now; what is left here is the only part that
 * is about worktrees.
 *
 * Nor does it draw anything of its own any more. Its sentences are the
 * dialog body's, and the files it would discard are the design system's
 * warning `Alert` — the one the bring-back dialog shows for the same fact.
 *
 * It also names what git ignores. `git worktree remove` deletes those without
 * being forced and `git status` counts none of them, so this dialog said
 * "only the checkout goes" over a folder holding an `.env` that was never in
 * git and could not be got back (#209).
 */

/** The dialog body's paragraph rhythm, for the alerts set among its paragraphs. */
const RHYTHM = 'mb-3 last:mb-0'

export const RemoveWorktree = ({
  worktree,
  onClose,
}: {
  worktree: Worktree
  onClose: () => void
}) => {
  const store = useStore()
  const [changes, setChanges] = useState<WorktreeChanges | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let cancelled = false
    void store.transport
      .request('worktree/changes', { path: worktree.path })
      .then((result) => {
        if (!cancelled) setChanges(result)
      })
      .catch((thrown: unknown) => {
        if (!cancelled) setError(thrown instanceof Error ? thrown.message : String(thrown))
      })
    return () => {
      cancelled = true
    }
  }, [store, worktree.path])

  const dirty = changes !== null && changes.modified + changes.untracked > 0

  const remove = async (force: boolean): Promise<void> => {
    setBusy(true)
    try {
      const removed = await store.removeWorktree(worktree.path, force)
      if (removed) onClose()
    } finally {
      setBusy(false)
    }
  }

  return (
    <ConfirmDialog
      title="Remove worktree"
      icon={<BranchIcon size={15} />}
      confirmLabel={dirty ? 'Discard changes and remove' : 'Remove worktree'}
      busyLabel={dirty ? 'Discarding…' : 'Removing…'}
      busy={busy}
      pending={changes === null}
      onConfirm={() => void remove(dirty)}
      onCancel={onClose}
    >
      <p>
        <span className="font-mono break-all">{worktree.path}</span>
        {worktree.branch && (
          <>
            {' '}
            on branch <span className="font-mono">{worktree.branch}</span>
          </>
        )}
        . The branch is kept either way; the folder goes, with anything git ignores in it.
      </p>

      {error && <WorktreeProblem className={RHYTHM}>{error}</WorktreeProblem>}

      {changes === null && !error && <p>Checking for unsaved work…</p>}

      {changes !== null && !dirty && (
        <p>
          Nothing uncommitted.
          {changes.unpushedCommits > 0 &&
            ` ${changes.unpushedCommits} commit${changes.unpushedCommits === 1 ? '' : 's'} on the branch ${
              changes.unpushedCommits === 1 ? 'has' : 'have'
            } not been pushed; the branch keeps ${changes.unpushedCommits === 1 ? 'it' : 'them'}.`}
        </p>
      )}

      {changes && <IgnoredEntries className={RHYTHM} changes={changes} />}

      {dirty && changes && (
        <UncommittedFiles
          className={RHYTHM}
          changes={changes}
          title={`This would discard ${describeUncommitted(changes)}`}
        >
          Commit or stash them in the worktree first if you want to keep them. There is no undo
          for discarding.
        </UncommittedFiles>
      )}
    </ConfirmDialog>
  )
}
