import { useEffect, useMemo, useState, type ReactNode } from 'react'

import type { GitFileStatus, GitMergeOutcome, GitRefsSummary, GitResetMode } from '@harnessdesk/protocol'

import { useStore } from '../state/context'
import { Dialog } from '../design/primitives/Dialog'
import { Btn, Input, Toggle } from '../design/primitives/Kit'
import { DiffView } from './Diff'
import {
  BranchIcon,
  CheckIcon,
  CommitIcon,
  DiffIcon,
  MergeIcon,
  PencilIcon,
  ResetIcon,
  StashIcon,
  TagIcon,
  TrashIcon,
} from './Icons'
import { shortSha } from '../lib/git-refs'
import { TroubleNote } from './GitAskAgent'
import type { GitTrouble } from '../lib/git-trouble'
import styles from './GitDialogs.module.css'

/**
 * The history pane's questions, each in the shape the app already asks
 * questions: a `Dialog`, a refusal shown inline where the person can act on
 * it, and the confirming button first in the footer. Every dialog runs its
 * own request — the pane hears back only "done or not", and re-reads the
 * repository when it was.
 *
 * A verb that can end in conflicts (merge here, pull and the rest from the
 * toolbar) does not treat them as failure: the conflicted files are real
 * state the Changes surface shows, so the dialog closes, says so as a
 * warning, and opens that surface.
 */

const reason = (error: unknown): string => (error instanceof Error ? error.message : String(error))

/**
 * One row of the commit dialog: a path and what committing it records. Every
 * `GitFileStatus` word, plus `nothing` — which is not a state a file can be
 * in, but what a commit makes of one pair of them.
 */
type CommitRow = { readonly path: string; readonly status: GitFileStatus['status'] | 'nothing' }

const STATUS_LETTER: Record<CommitRow['status'], string> = {
  modified: 'M',
  added: 'A',
  deleted: 'D',
  renamed: 'R',
  untracked: 'U',
  conflicted: '!',
  nothing: '—',
}

// ------------------------------------------------------------------- commit

/**
 * One row for each path, labelled by what committing it records. The commit
 * takes each path's working-tree contents (`git commit -- <paths>`), so a file
 * staged and then deleted (`MD`) is committed as a deletion. Labelled by its
 * index entry, the row said "modified" (#180). Otherwise the index's word
 * stands, because it says what the commit records against the last one: `AM`
 * is still an addition.
 *
 * `AD` — added to the index, then deleted from the working tree — is the one
 * pair neither word fits. The path is in no commit and in no tree, so nothing
 * is recorded for it either way. Measured on git 2.50.1: named on its own,
 * `git commit -- <path>` exits 1 with "nothing to commit"; named beside
 * another file, the commit succeeds and mentions only the other; and the
 * all-files branch's `git add -A` drops the staged add outright. So the row
 * says it records nothing and carries no box to check, rather than claiming a
 * deletion the commit does not make (#248).
 *
 * It stays in the list rather than being dropped from it. The path is in the
 * Changes panel either way, and this is the one surface that can say why it is
 * not going in — a row that simply vanishes is a gap the reader has to close
 * alone. Keeping it also holds `everything` below false, which sends the
 * commit down the pathspec branch: measured, that is the only branch that
 * leaves the staged add where it is instead of erasing it.
 */
const onePerPath = (files: readonly GitFileStatus[]): CommitRow[] => {
  const first = new Map<string, GitFileStatus>()
  const goneFromTree = new Set<string>()
  for (const file of files) {
    if (!first.has(file.path)) first.set(file.path, file)
    if (!file.staged && file.status === 'deleted') goneFromTree.add(file.path)
  }
  return [...first.values()].map((file) => ({
    path: file.path,
    status: !goneFromTree.has(file.path)
      ? file.status
      : file.staged && file.status === 'added'
        ? 'nothing'
        : 'deleted',
  }))
}

/**
 * The toolbar's Commit: the dirty files with a check each, a message, one
 * button. Unchecking a file leaves it dirty for a later commit; with every
 * row checked the commit is asked without pathspecs, which is also the only
 * shape git takes while a merge is being concluded. A row that records
 * nothing cannot be checked, so its presence alone keeps that shape away.
 */
export const CommitDialog = ({ root, onDone }: { root: string; onDone: (done: boolean) => void }) => {
  const store = useStore()
  const [files, setFiles] = useState<readonly CommitRow[] | null>(null)
  const [excluded, setExcluded] = useState<ReadonlySet<string>>(new Set())
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    void store.transport
      .request('git/status', { root })
      .then((status) => {
        // One row a file: status lists a file staged and changed again twice, one entry a column (#31).
        if (!cancelled) setFiles(onePerPath(status?.files ?? []))
      })
      .catch(() => {
        if (!cancelled) setFiles([])
      })
    return () => {
      cancelled = true
    }
  }, [root, store])

  /* A row that records nothing is not a file to commit: it is never chosen,
     so the count on the button and the pathspecs sent both stay true to what
     the commit will contain. */
  const chosen = (files ?? []).filter((file) => file.status !== 'nothing' && !excluded.has(file.path))

  const commit = async (): Promise<void> => {
    if (message.trim().length === 0 || chosen.length === 0) return
    setBusy(true)
    setError(null)
    try {
      const everything = chosen.length === (files ?? []).length
      const { sha } = await store.transport.request('git/commitAll', {
        root,
        message: message.trim(),
        ...(everything ? {} : { paths: chosen.map((file) => file.path) }),
      })
      store.notice('info', `Committed ${shortSha(sha)}.`)
      onDone(true)
    } catch (raised) {
      setError(reason(raised))
      setBusy(false)
    }
  }

  return (
    <Dialog
      title="Commit"
      icon={<CommitIcon size={16} />}
      size="md"
      onClose={() => onDone(false)}
      footer={
        <>
          <Btn
            variant="primary"
            onClick={() => void commit()}
            disabled={busy || message.trim().length === 0 || chosen.length === 0}
          >
            {busy
              ? 'Committing…'
              : chosen.length === 1
                ? 'Commit 1 file'
                : `Commit ${chosen.length} files`}
          </Btn>
          <Btn onClick={() => onDone(false)} disabled={busy}>
            Cancel
          </Btn>
        </>
      }
    >
      <div className={styles.body}>
        <textarea
          className={styles.message}
          value={message}
          rows={3}
          placeholder="What this commit does"
          autoFocus
          aria-label="Commit message"
          onChange={(event) => setMessage(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) void commit()
          }}
        />
        {files === null ? (
          <div className={styles.quiet}>Reading the working tree…</div>
        ) : files.length === 0 ? (
          <div className={styles.quiet}>The working tree is clean — there is nothing to commit.</div>
        ) : (
          <div className={styles.files} role="group" aria-label="Files to commit">
            {files.map((file) => {
              if (file.status === 'nothing') {
                /* Declared and greyed rather than withdrawn: the path is in
                   the Changes panel, so a row missing here reads as an
                   oversight instead of an answer. */
                return (
                  <div key={file.path} className={styles.file} data-moot="">
                    <span className={styles.blank} />
                    <span className={styles.status} data-status="nothing">
                      {STATUS_LETTER.nothing}
                    </span>
                    <span className={styles.path}>{file.path}</span>
                    <span className={styles.records}>records nothing</span>
                  </div>
                )
              }
              const on = !excluded.has(file.path)
              return (
                <button
                  key={file.path}
                  type="button"
                  role="checkbox"
                  aria-checked={on}
                  className={styles.file}
                  onClick={() =>
                    setExcluded((current) => {
                      const next = new Set(current)
                      if (on) next.add(file.path)
                      else next.delete(file.path)
                      return next
                    })
                  }
                >
                  <span className={styles.check} {...(on ? { 'data-on': '' } : {})}>
                    {on && <CheckIcon size={11} />}
                  </span>
                  <span className={styles.status} data-status={file.status}>
                    {STATUS_LETTER[file.status]}
                  </span>
                  <span className={styles.path}>{file.path}</span>
                </button>
              )
            })}
          </div>
        )}
        {error && <div className={styles.error}>{error}</div>}
      </div>
    </Dialog>
  )
}

// -------------------------------------------------------------------- merge

/** The toolbar's Merge: pick what joins the current branch. */
export const MergeDialog = ({
  root,
  refs,
  preselect,
  onDone,
}: {
  root: string
  refs: GitRefsSummary
  preselect?: string
  onDone: (done: boolean) => void
}) => {
  const store = useStore()
  const current = refs.branch
  const choices = useMemo(() => {
    const locals = refs.branches.filter((branch) => !branch.current).map((branch) => branch.name)
    const remotes = refs.remotes.map((remote) => `${remote.remote}/${remote.name}`)
    const tags = refs.tags.map((tag) => tag.name)
    return [...locals, ...remotes, ...tags]
  }, [refs])
  const [ref, setRef] = useState(preselect ?? choices[0] ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const merge = async (): Promise<void> => {
    if (!ref) return
    setBusy(true)
    setError(null)
    try {
      const outcome = await store.transport.request('git/merge', { root, ref })
      settle(store, outcome)
      onDone(true)
    } catch (raised) {
      setError(reason(raised))
      setBusy(false)
    }
  }

  return (
    <Dialog
      title={current ? `Merge into ${current}` : 'Merge'}
      icon={<MergeIcon size={16} />}
      onClose={() => onDone(false)}
      footer={
        <>
          <Btn variant="primary" onClick={() => void merge()} disabled={busy || !ref}>
            {busy ? 'Merging…' : 'Merge'}
          </Btn>
          <Btn onClick={() => onDone(false)} disabled={busy}>
            Cancel
          </Btn>
        </>
      }
    >
      <div className={styles.body}>
        <select
          className={styles.select}
          value={ref}
          aria-label="What to merge"
          onChange={(event) => setRef(event.target.value)}
        >
          {choices.map((choice) => (
            <option key={choice} value={choice}>
              {choice}
            </option>
          ))}
        </select>
        <span className={styles.note}>
          A conflict is not a failure: the files stay in the working tree, named, and committing concludes the
          merge.
        </span>
        {error && <div className={styles.error}>{error}</div>}
      </div>
    </Dialog>
  )
}

/** One warning for every conflicted outcome, and the surface that shows it. */
const settle = (store: ReturnType<typeof useStore>, outcome: GitMergeOutcome): void => {
  if (outcome.conflicts.length > 0) {
    store.notice('warning', outcome.summary)
    // Open, never toggle: a Changes panel already showing must stay.
    store.openDetailsTab('changes')
  } else {
    store.notice('info', outcome.summary)
  }
}

// ------------------------------------------------------------------ rename

export const RenameBranchDialog = ({
  root,
  from,
  onDone,
}: {
  root: string
  from: string
  onDone: (done: boolean) => void
}) => {
  const store = useStore()
  const [to, setTo] = useState(from)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const rename = async (): Promise<void> => {
    const name = to.trim()
    if (name.length === 0 || name === from) return
    setBusy(true)
    setError(null)
    try {
      await store.transport.request('git/renameBranch', { root, from, to: name })
      store.notice('info', `Renamed ${from} to ${name}.`)
      onDone(true)
    } catch (raised) {
      setError(reason(raised))
      setBusy(false)
    }
  }

  return (
    <Dialog
      title={`Rename ${from}`}
      icon={<PencilIcon size={16} />}
      onClose={() => onDone(false)}
      footer={
        <>
          <Btn variant="primary" onClick={() => void rename()} disabled={busy || to.trim().length === 0 || to.trim() === from}>
            {busy ? 'Renaming…' : 'Rename'}
          </Btn>
          <Btn onClick={() => onDone(false)} disabled={busy}>
            Cancel
          </Btn>
        </>
      }
    >
      <div className={styles.body}>
        <Input
          value={to}
          autoFocus
          spellCheck={false}
          aria-label="New branch name"
          onChange={(event) => setTo(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') void rename()
          }}
        />
        <span className={styles.note}>Only the local branch renames; a remote copy keeps its name.</span>
        {error && <div className={styles.error}>{error}</div>}
      </div>
    </Dialog>
  )
}

// ------------------------------------------------------------------ delete

export const DeleteBranchDialog = ({
  root,
  name,
  onDone,
}: {
  root: string
  name: string
  onDone: (done: boolean) => void
}) => {
  const store = useStore()
  const [force, setForce] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const remove = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      await store.transport.request('git/deleteBranch', { root, name, ...(force ? { force: true } : {}) })
      store.notice('info', `Deleted ${name}.`)
      onDone(true)
    } catch (raised) {
      setError(reason(raised))
      setBusy(false)
    }
  }

  return (
    <Dialog
      title={`Delete ${name}`}
      icon={<TrashIcon size={16} />}
      tone="destructive"
      onClose={() => onDone(false)}
      footer={
        <>
          <Btn variant="danger" onClick={() => void remove()} disabled={busy}>
            {busy ? 'Deleting…' : 'Delete'}
          </Btn>
          <Btn onClick={() => onDone(false)} disabled={busy}>
            Cancel
          </Btn>
        </>
      }
    >
      <div className={styles.body}>
        <span className={styles.note}>
          Work already merged is safe to delete — the commits stay in the history. A branch with unmerged
          commits refuses unless forced, and forcing it orphans those commits.
        </span>
        <div className={styles.row}>
          <Toggle on={force} onChange={setForce} label="Force — delete even with unmerged commits" />
          <span>Delete even if its commits are nowhere else.</span>
        </div>
        {error && <div className={styles.error}>{error}</div>}
      </div>
    </Dialog>
  )
}

// --------------------------------------------------------------------- tag

export const TagDialog = ({
  root,
  at,
  onDone,
}: {
  root: string
  at: string
  onDone: (done: boolean) => void
}) => {
  const store = useStore()
  const [name, setName] = useState('')
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const create = async (): Promise<void> => {
    if (name.trim().length === 0) return
    setBusy(true)
    setError(null)
    try {
      await store.transport.request('git/createTag', {
        root,
        name: name.trim(),
        at,
        ...(message.trim().length > 0 ? { message: message.trim() } : {}),
      })
      store.notice('info', `Tagged ${shortSha(at)} as ${name.trim()}.`)
      onDone(true)
    } catch (raised) {
      setError(reason(raised))
      setBusy(false)
    }
  }

  return (
    <Dialog
      title={`Tag ${shortSha(at)}`}
      icon={<TagIcon size={16} />}
      onClose={() => onDone(false)}
      footer={
        <>
          <Btn variant="primary" onClick={() => void create()} disabled={busy || name.trim().length === 0}>
            {busy ? 'Tagging…' : 'Create tag'}
          </Btn>
          <Btn onClick={() => onDone(false)} disabled={busy}>
            Cancel
          </Btn>
        </>
      }
    >
      <div className={styles.body}>
        <Input
          value={name}
          placeholder="v1.2.0"
          autoFocus
          spellCheck={false}
          aria-label="Tag name"
          onChange={(event) => setName(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') void create()
          }}
        />
        <Input
          value={message}
          placeholder="Message — optional; makes the tag annotated"
          spellCheck={false}
          aria-label="Tag message"
          onChange={(event) => setMessage(event.target.value)}
        />
        {error && <div className={styles.error}>{error}</div>}
      </div>
    </Dialog>
  )
}

// ------------------------------------------------------------------- reset

const RESET_MODES: readonly { mode: GitResetMode; label: string; what: string }[] = [
  { mode: 'soft', label: 'Soft', what: 'Keep every change since, staged.' },
  { mode: 'mixed', label: 'Mixed', what: 'Keep every change since, unstaged.' },
  { mode: 'hard', label: 'Hard', what: 'Discard every change since — erases uncommitted work.' },
]

export const ResetDialog = ({
  root,
  to,
  subject,
  branch,
  onDone,
}: {
  root: string
  to: string
  subject: string
  branch: string
  onDone: (done: boolean) => void
}) => {
  const store = useStore()
  const [mode, setMode] = useState<GitResetMode>('mixed')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const reset = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      await store.transport.request('git/reset', { root, to, mode })
      store.notice('info', `Reset ${branch} to ${shortSha(to)} (${mode}).`)
      onDone(true)
    } catch (raised) {
      setError(reason(raised))
      setBusy(false)
    }
  }

  return (
    <Dialog
      title={`Reset ${branch} to ${shortSha(to)}`}
      icon={<ResetIcon size={16} />}
      {...(mode === 'hard' ? { tone: 'destructive' as const } : {})}
      onClose={() => onDone(false)}
      footer={
        <>
          <Btn variant={mode === 'hard' ? 'danger' : 'primary'} onClick={() => void reset()} disabled={busy}>
            {busy ? 'Resetting…' : mode === 'hard' ? 'Reset and discard' : 'Reset'}
          </Btn>
          <Btn onClick={() => onDone(false)} disabled={busy}>
            Cancel
          </Btn>
        </>
      }
    >
      <div className={styles.body}>
        <span className={styles.note}>
          Moves {branch} back to “{subject}”. Commits after it leave the branch either way; the modes differ
          in what happens to the work itself.
        </span>
        <div role="radiogroup" aria-label="Reset mode" className={styles.modes}>
          {RESET_MODES.map((choice) => (
            <button
              key={choice.mode}
              type="button"
              role="radio"
              aria-checked={mode === choice.mode}
              className={styles.mode}
              {...(mode === choice.mode ? { 'data-on': '' } : {})}
              {...(choice.mode === 'hard' ? { 'data-hard': '' } : {})}
              onClick={() => setMode(choice.mode)}
            >
              <span className={styles.modeName}>{choice.label}</span>
              <span className={styles.modeWhat}>{choice.what}</span>
            </button>
          ))}
        </div>
        {error && <div className={styles.error}>{error}</div>}
      </div>
    </Dialog>
  )
}

// ------------------------------------------------------------------- stash

export const StashDialog = ({ root, onDone }: { root: string; onDone: (done: boolean) => void }) => {
  const store = useStore()
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const stash = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      await store.transport.request('git/stashSave', {
        root,
        ...(message.trim().length > 0 ? { message: message.trim() } : {}),
      })
      store.notice('info', 'Stashed the working tree.')
      onDone(true)
    } catch (raised) {
      setError(reason(raised))
      setBusy(false)
    }
  }

  return (
    <Dialog
      title="Stash the working tree"
      icon={<StashIcon size={16} />}
      onClose={() => onDone(false)}
      footer={
        <>
          <Btn variant="primary" onClick={() => void stash()} disabled={busy}>
            {busy ? 'Stashing…' : 'Stash'}
          </Btn>
          <Btn onClick={() => onDone(false)} disabled={busy}>
            Cancel
          </Btn>
        </>
      }
    >
      <div className={styles.body}>
        <Input
          value={message}
          placeholder="What this work was — optional"
          autoFocus
          spellCheck={false}
          aria-label="Stash message"
          onChange={(event) => setMessage(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') void stash()
          }}
        />
        <span className={styles.note}>
          Sets every change aside, untracked files included, and appears under Stashes in the rail.
        </span>
        {error && <div className={styles.error}>{error}</div>}
      </div>
    </Dialog>
  )
}

// -------------------------------------------------------------- range diff

/** “Diff against current”: the plain difference between two revisions. */
export const DiffRangeDialog = ({
  root,
  from,
  to,
  onDone,
}: {
  root: string
  from: string
  to: string
  onDone: () => void
}) => {
  const store = useStore()
  const [diff, setDiff] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    void store.transport
      .request('git/diffRange', { root, from, to })
      .then((result) => {
        if (!cancelled) setDiff(result.diff)
      })
      .catch((raised: unknown) => {
        if (!cancelled) setError(reason(raised))
      })
    return () => {
      cancelled = true
    }
  }, [root, from, to, store])

  return (
    <Dialog
      title={`${from} → ${to}`}
      icon={<DiffIcon size={16} />}
      size="xl"
      tall
      flush
      onClose={onDone}
      footer={<Btn onClick={onDone}>Close</Btn>}
    >
      {error ? (
        <div className={styles.error}>{error}</div>
      ) : diff === null ? (
        <div className={styles.quiet}>Reading the difference…</div>
      ) : diff.length === 0 ? (
        <div className={styles.quiet}>The two are identical.</div>
      ) : (
        <div className={styles.rangeDiff}>
          <DiffView diff={diff} />
        </div>
      )}
    </Dialog>
  )
}

// ----------------------------------------------------------------- confirm

/**
 * One question, one verb — for the moves that deserve a pause but no form:
 * a detached checkout, a rebase, dropping a stash, deleting a tag. The verb
 * itself is handed in; this owns the busy state and the inline refusal.
 */
export const ConfirmDialog = ({
  title,
  body,
  confirmLabel,
  tone,
  icon,
  act,
  trouble,
  onAsk,
  onDone,
}: {
  title: string
  body: ReactNode
  confirmLabel: string
  tone?: 'destructive'
  icon?: ReactNode
  act: () => Promise<string | null>
  /**
   * Turns this dialog's refusal into work an agent could take on. Absent for
   * the questions where a refusal is the right answer — the main checkout
   * really cannot be removed, and offering to have that "fixed" is a lie.
   */
  trouble?: (said: string) => GitTrouble
  onAsk?: (trouble: GitTrouble) => void
  onDone: (done: boolean) => void
}) => {
  const store = useStore()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const confirm = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      const summary = await act()
      if (summary) store.notice('info', summary)
      onDone(true)
    } catch (raised) {
      setError(reason(raised))
      setBusy(false)
    }
  }

  return (
    <Dialog
      title={title}
      icon={icon ?? <BranchIcon size={16} />}
      {...(tone ? { tone } : {})}
      onClose={() => onDone(false)}
      footer={
        <>
          <Btn variant={tone === 'destructive' ? 'danger' : 'primary'} onClick={() => void confirm()} disabled={busy}>
            {busy ? '…' : confirmLabel}
          </Btn>
          <Btn onClick={() => onDone(false)} disabled={busy}>
            Cancel
          </Btn>
        </>
      }
    >
      <div className={styles.body}>
        <span className={styles.note}>{body}</span>
        {error &&
          (trouble && onAsk ? (
            <TroubleNote message={error} trouble={trouble(error)} onAsk={onAsk} />
          ) : (
            <div className={styles.error}>{error}</div>
          ))}
      </div>
    </Dialog>
  )
}
