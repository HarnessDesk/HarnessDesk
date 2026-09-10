import { useEffect, useState } from 'react'

import type { Worktree, WorktreeChanges } from '@harnessdesk/protocol'

import { ConfirmDialog } from '../design'
import { useRuntime, useSnapshot, useStore } from '../state/context'
import { AlertIcon, HomeIcon } from './Icons'
import styles from './BringHome.module.css'

/**
 * Bringing a worktree's work back to the main checkout.
 *
 * Codex offers this, and it is the half of worktrees that was missing here:
 * a checkout cut for parallel work is a detour, and once the work is worth
 * keeping the person wants it in the folder they actually work in. The host
 * does it as a checkout, not a merge (`worktree/bringHome` says why), and
 * this dialog's job is to say — before anything moves — exactly what will:
 * which branch the main checkout leaves and which it takes, that the folder
 * goes and the branch stays, and what becomes of this conversation.
 *
 * Uncommitted work is the one thing that stops it, because the worktree has
 * to be removed before its branch can be checked out anywhere else. So the
 * tree is read first, and while there is work in it the move is not offered
 * at all: the dialog names the files and offers the one step that unblocks
 * it — asking the agent that made them to commit them, in this conversation,
 * where the message can be read before it goes.
 */

const COMMIT_ASK =
  'Commit the work in this worktree with a clear message, so it can be brought back to the main checkout. ' +
  'Nothing may be left uncommitted, so if something should not be committed, tell me what it is and ask before ' +
  'deleting it. Then tell me the commit hash.'

export const BringHome = ({ worktree, onClose }: { worktree: Worktree; onClose: () => void }) => {
  const store = useStore()
  const snapshot = useSnapshot()
  const runtime = useRuntime()
  const [changes, setChanges] = useState<WorktreeChanges | null>(null)
  const [unread, setUnread] = useState<string | null>(null)
  const [refused, setRefused] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const main = snapshot.worktrees.find((entry) => entry.isMain)
  const folder = main?.path.split('/').filter(Boolean).at(-1) ?? 'the main checkout'

  useEffect(() => {
    let cancelled = false
    void store.transport
      .request('worktree/changes', { path: worktree.path })
      .then((result) => {
        if (!cancelled) setChanges(result)
      })
      .catch((thrown: unknown) => {
        if (!cancelled) setUnread(thrown instanceof Error ? thrown.message : String(thrown))
      })
    return () => {
      cancelled = true
    }
  }, [store, worktree.path])

  const dirty = changes !== null && changes.modified + changes.untracked > 0

  const confirm = async (): Promise<void> => {
    if (dirty) {
      // Into this conversation's composer, not sent: the person reads what
      // the agent is being asked to do before it does it.
      onClose()
      window.dispatchEvent(new CustomEvent('harnessdesk:compose', { detail: COMMIT_ASK }))
      return
    }
    setBusy(true)
    setRefused(null)
    const problem = await store.bringWorktreeHome(worktree.path)
    setBusy(false)
    if (problem) setRefused(problem)
    else onClose()
  }

  return (
    <ConfirmDialog
      title="Bring it back to the main checkout"
      icon={<HomeIcon size={16} />}
      tone="default"
      confirmLabel={dirty ? `Ask ${runtime.presentation.name} to commit them` : 'Bring it back'}
      cancelLabel="Keep it there"
      busyLabel="Bringing it back…"
      busy={busy}
      pending={changes === null}
      onConfirm={() => void confirm()}
      onCancel={onClose}
    >
      <p className={styles.blurb}>
        <span className={styles.name}>{folder}</span> switches
        {main?.branch && (
          <>
            {' '}
            from <span className={styles.mono}>{main.branch}</span>
          </>
        )}{' '}
        to <span className={styles.mono}>{worktree.branch}</span>, with every commit made here. The
        worktree's folder is removed; the branch is not.
      </p>

      {unread && <p className={`${styles.note} ${styles.error}`}>{unread}</p>}
      {changes === null && !unread && <p className={styles.note}>Checking for uncommitted work…</p>}

      {changes !== null && !dirty && (
        <p className={styles.note}>
          This conversation cannot move with its folder, so a new one opens in {folder} carrying
          what happened here.
        </p>
      )}

      {dirty && changes && (
        <section className={styles.group}>
          <div className={styles.groupLabel}>
            <AlertIcon size={12} />
            {changes.modified > 0 && `${changes.modified} modified`}
            {changes.modified > 0 && changes.untracked > 0 && ' and '}
            {changes.untracked > 0 && `${changes.untracked} untracked`} file
            {changes.modified + changes.untracked === 1 ? '' : 's'} not committed
          </div>
          <ul className={styles.files}>
            {changes.files.map((file) => (
              <li key={file} className={styles.mono}>
                {file}
              </li>
            ))}
          </ul>
          <p className={styles.note}>
            The worktree's folder has to go for its branch to be checked out anywhere else, and
            uncommitted work would go with it. Commit it first.
          </p>
        </section>
      )}

      {refused && (
        <p className={`${styles.note} ${styles.error}`} role="alert">
          {refused}
        </p>
      )}
    </ConfirmDialog>
  )
}
