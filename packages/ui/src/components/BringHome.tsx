import { useEffect, useState } from 'react'

import type { Worktree, WorktreeChanges } from '@harnessdesk/protocol'

import { ConfirmDialog } from '../design'
import { useRuntime, useSnapshot, useStore } from '../state/context'
import { HomeIcon } from './Icons'
import { UncommittedFiles, WorktreeProblem, describeUncommitted } from './WorktreeAlerts'

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
 *
 * It draws with nothing of its own. The dialog body already sets and spaces
 * its sentences; the two things here that are not sentences — the files git
 * has not got, and a refusal — are the design system's `Alert`, shared with
 * the removal dialog through `WorktreeAlerts`.
 */

const COMMIT_ASK =
  'Commit the work in this worktree with a clear message, so it can be brought back to the main checkout. ' +
  'Nothing may be left uncommitted, so if something should not be committed, tell me what it is and ask before ' +
  'deleting it. Then tell me the commit hash.'

/** The dialog body's paragraph rhythm, for the alerts set among its paragraphs. */
const RHYTHM = 'mb-3 last:mb-0'

export const BringHome = ({ worktree, onClose }: { worktree: Worktree; onClose: () => void }) => {
  const store = useStore()
  const snapshot = useSnapshot()
  const runtime = useRuntime()
  const [changes, setChanges] = useState<WorktreeChanges | null>(null)
  const [unread, setUnread] = useState<string | null>(null)
  const [mainChanges, setMainChanges] = useState<WorktreeChanges | null>(null)
  const [refused, setRefused] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const main = snapshot.worktrees.find((entry) => entry.isMain)
  const folder = main?.path.split('/').filter(Boolean).at(-1) ?? 'the main checkout'
  const mainPath = main?.path ?? null

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

  // The main checkout's own uncommitted work comes along: `git checkout`
  // carries edits the two branches do not disagree about. Read so the dialog
  // can say so; a read that fails says nothing rather than something wrong.
  useEffect(() => {
    if (!mainPath) return
    let cancelled = false
    void store.transport
      .request('worktree/changes', { path: mainPath })
      .then((result) => {
        if (!cancelled) setMainChanges(result)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [store, mainPath])

  const dirty = changes !== null && changes.modified + changes.untracked > 0
  const carried = mainChanges === null ? 0 : mainChanges.modified + mainChanges.untracked

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
      <p>
        <span className="text-(--hd-foreground)">{folder}</span> switches
        {main?.branch && (
          <>
            {' '}
            from <span className="font-mono">{main.branch}</span>
          </>
        )}{' '}
        to <span className="font-mono">{worktree.branch}</span>, with every commit made here. The
        worktree's folder is removed, and with it anything git ignores there, such as an .env file
        or node_modules; the branch is not.
      </p>

      {mainChanges && carried > 0 && (
        <p>
          {folder} has {describeUncommitted(mainChanges)} not committed. Git carries{' '}
          {carried === 1 ? 'it' : 'them'} onto <span className="font-mono">{worktree.branch}</span>, or refuses the
          switch if {carried === 1 ? 'it clashes' : 'they clash'} with it.
        </p>
      )}

      {unread && <WorktreeProblem className={RHYTHM}>{unread}</WorktreeProblem>}
      {changes === null && !unread && <p>Checking for uncommitted work…</p>}

      {changes !== null && !dirty && (
        <p>
          This conversation cannot move with its folder, so a new one opens in {folder} carrying
          what happened here.
        </p>
      )}

      {dirty && changes && (
        <UncommittedFiles
          className={RHYTHM}
          changes={changes}
          title={`${describeUncommitted(changes)} not committed`}
        >
          The worktree's folder has to go for its branch to be checked out anywhere else, and
          uncommitted work would go with it. Commit it first.
        </UncommittedFiles>
      )}

      {refused && (
        <WorktreeProblem live className={RHYTHM}>
          {refused}
        </WorktreeProblem>
      )}
    </ConfirmDialog>
  )
}
