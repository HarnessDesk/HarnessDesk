import { useEffect, useState } from 'react'

import type { Worktree, WorktreeChanges } from '@harnessdesk/protocol'

import { ConfirmDialog } from '../design'
import { useStore } from '../state/context'
import { AlertIcon, BranchIcon } from './Icons'
import styles from './RemoveWorktree.module.css'

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
 */
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
      <p className={styles.blurb}>
        <span className={styles.mono}>{worktree.path}</span>
        {worktree.branch && (
          <>
            {' '}
            on branch <span className={styles.mono}>{worktree.branch}</span>
          </>
        )}
        . The branch is kept either way; only the checkout goes.
      </p>

      {error && <p className={`${styles.note} ${styles.error}`}>{error}</p>}

      {changes === null && !error && <p className={styles.note}>Checking for unsaved work…</p>}

      {changes !== null && !dirty && (
        <p className={styles.note}>
          Nothing uncommitted.
          {changes.unpushedCommits > 0 &&
            ` ${changes.unpushedCommits} commit${changes.unpushedCommits === 1 ? '' : 's'} on the branch ${
              changes.unpushedCommits === 1 ? 'has' : 'have'
            } not been pushed; the branch keeps ${changes.unpushedCommits === 1 ? 'it' : 'them'}.`}
        </p>
      )}

      {dirty && changes && (
        <section className={styles.group}>
          <div className={styles.groupLabel}>
            <AlertIcon size={12} />
            This would discard {changes.modified > 0 && `${changes.modified} modified`}
            {changes.modified > 0 && changes.untracked > 0 && ' and '}
            {changes.untracked > 0 && `${changes.untracked} untracked`} file
            {changes.modified + changes.untracked === 1 ? '' : 's'}
          </div>
          <ul className={styles.files}>
            {changes.files.map((file) => (
              <li key={file} className={styles.mono}>
                {file}
              </li>
            ))}
          </ul>
          <p className={styles.note}>
            Commit or stash them in the worktree first if you want to keep them. There is no undo
            for discarding.
          </p>
        </section>
      )}
    </ConfirmDialog>
  )
}
