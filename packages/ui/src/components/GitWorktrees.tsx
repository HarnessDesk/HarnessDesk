import { useCallback, useEffect, useMemo, useState } from 'react'

import type {
  GitRefsSummary,
  GitWorktree,
  GitWorktreeCheckout,
  GitWorktreeInventory,
} from '@harnessdesk/protocol'

import { useStore } from '../state/context'
import { Dialog } from '../design/primitives/Dialog'
import { Btn, Input, Toggle } from '../design/primitives/Kit'
import {
  BranchIcon,
  CommitIcon,
  FolderOpenIcon,
  LockIcon,
  MoveFolderIcon,
  PruneIcon,
  TrashIcon,
  UnlockIcon,
  WorktreeIcon,
} from './Icons'
import { shortSha } from '../lib/git-refs'
import { ltr } from './ToolPaneHeader'
import styles from './GitWorktrees.module.css'

/**
 * Worktrees, managed.
 *
 * A worktree is a second folder the same repository is checked out in, on its
 * own branch. In a git client that is a convenience; here it is the shape of
 * the work — an agent per checkout, each on its own branch, none of them
 * stashing over another's half-finished edits. So this surface does the git
 * verbs (add, remove, prune, lock, move) *and* the two only this app can
 * offer: open a worktree as the workspace, and make one already opened.
 *
 * Two dialogs, never stacked. The list asks its questions *in the row* — a
 * strip that replaces that row's buttons — and hands the one question that
 * needs a form of its own to a second dialog, which hands the list back when
 * it is done.
 *
 * The dialog never decides that a removal is safe. It says what the listing
 * already knows will be lost, sends `force` only when it has said so in red,
 * and shows whatever the host refuses where the refusal happened.
 */

const reason = (error: unknown): string => (error instanceof Error ? error.message : String(error))

const folderOf = (path: string): string => path.split('/').filter(Boolean).at(-1) ?? path

/**
 * What a removal would take, in words. Ignored files are counted beside the
 * uncommitted ones because `git worktree remove` deletes both — a checkout
 * holding `.env.local` reads as clean and would be emptied without a word.
 */
const lost = (held: GitWorktreeInventory): string => {
  const parts: string[] = []
  if (held.changeCount > 0) {
    parts.push(`${held.changeCount} uncommitted file${held.changeCount === 1 ? '' : 's'}`)
  }
  if (held.ignoredCount > 0) {
    parts.push(`${held.ignoredCount} ignored file${held.ignoredCount === 1 ? '' : 's'} or folder${held.ignoredCount === 1 ? '' : 's'}`)
  }
  return parts.join(' and ')
}

/** A branch name turned into the folder that would hold it. */
const slug = (name: string): string =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 48)

/** What a row is being asked about, when it is being asked anything. */
type RowAsk =
  /** `held` arrives from the host; until it does the question is not asked. */
  | { readonly kind: 'remove'; readonly held: GitWorktreeInventory | null; readonly failed?: string }
  | { readonly kind: 'move'; readonly to: string }
  | { readonly kind: 'lock'; readonly reason: string }

// -------------------------------------------------------------- the manager

export const WorktreeDialog = ({
  root,
  focus,
  onAdd,
  onDone,
}: {
  root: string
  /** A row to open a question on straight away, when a menu sent us here. */
  focus?: { readonly path: string; readonly intent: 'remove' | 'move' }
  /** Hands over to the add dialog; this one closes rather than stacking. */
  onAdd: () => void
  onDone: (changed: boolean) => void
}) => {
  const store = useStore()
  const [worktrees, setWorktrees] = useState<readonly GitWorktree[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [changed, setChanged] = useState(false)
  const [ask, setAsk] = useState<{ readonly path: string; readonly ask: RowAsk } | null>(
    focus
      ? { path: focus.path, ask: focus.intent === 'move' ? { kind: 'move', to: '' } : { kind: 'remove', held: null } }
      : null,
  )

  /**
   * What removing a checkout would actually delete, asked at the moment of
   * asking. Not carried in the listing: reading ignored contents costs a
   * walk per worktree, and the answer is only wanted once, here, where it is
   * about to be acted on. The digest it carries is what the removal is
   * confirmed against.
   */
  const look = useCallback(
    (path: string): void => {
      setAsk({ path, ask: { kind: 'remove', held: null } })
      void store.transport
        .request('git/worktreeInventory', { root, path })
        .then((held) => setAsk((current) => (current?.path === path ? { path, ask: { kind: 'remove', held } } : current)))
        .catch((raised: unknown) =>
          setAsk((current) =>
            current?.path === path ? { path, ask: { kind: 'remove', held: null, failed: reason(raised) } } : current,
          ),
        )
    },
    [root, store],
  )

  const load = useCallback(async (): Promise<void> => {
    setWorktrees(await store.transport.request('git/worktrees', { root }))
  }, [root, store])

  useEffect(() => {
    let cancelled = false
    void store.transport
      .request('git/worktrees', { root })
      .then((listed) => {
        if (!cancelled) setWorktrees(listed)
      })
      .catch((raised: unknown) => {
        if (!cancelled) setError(reason(raised))
      })
    return () => {
      cancelled = true
    }
  }, [root, store])

  // A menu that sent us straight at a removal still has to look first.
  useEffect(() => {
    if (focus?.intent === 'remove') look(focus.path)
  }, [focus, look])

  /**
   * One verb: says which row is working, keeps the refusal beside the list,
   * re-reads afterwards, and remembers that the pane behind must re-read too.
   */
  const act = useCallback(
    (key: string, run: () => Promise<string | null>): void => {
      setBusy(key)
      setError(null)
      void run()
        .then(async (said) => {
          setChanged(true)
          setAsk(null)
          await load()
          if (said) store.notice('info', said)
        })
        .catch((raised: unknown) => setError(reason(raised)))
        .finally(() => setBusy(null))
    },
    [load, store],
  )

  /** Opening a worktree switches workspace, so this dialog's root is stale. */
  const open = (path: string): void => {
    void store.openWorkspace(path)
    onDone(true)
  }

  const stale = (worktrees ?? []).filter((entry) => entry.prunable).length

  return (
    <Dialog
      title="Worktrees"
      icon={<WorktreeIcon size={16} />}
      size="lg"
      onClose={() => onDone(changed)}
      footer={
        <>
          <Btn variant="primary" disabled={busy !== null} onClick={onAdd}>
            Add worktree…
          </Btn>
          <Btn onClick={() => onDone(changed)}>Done</Btn>
        </>
      }
      footerAside={
        stale > 0 ? (
          <Btn
            small
            disabled={busy !== null}
            title="Drop git's records of the worktrees whose folders are gone"
            onClick={() =>
              act('prune', async () => (await store.transport.request('git/worktreePrune', { root })).summary)
            }
          >
            <PruneIcon size={13} />
            {busy === 'prune' ? 'Pruning…' : `Prune ${stale} stale`}
          </Btn>
        ) : null
      }
    >
      <div className={styles.body}>
        <p className={styles.lede}>
          Every folder this repository is checked out in. Each worktree has its own branch and its own working
          tree, so an agent can work in one without touching what another has open.
        </p>

        {worktrees === null ? (
          <div className={styles.quiet}>Reading the repository…</div>
        ) : (
          <div className={styles.list}>
            {worktrees.map((entry) => (
              <WorktreeRow
                key={entry.path}
                entry={entry}
                busy={busy === entry.path}
                anyBusy={busy !== null}
                ask={ask?.path === entry.path ? ask.ask : null}
                onAsk={(next) => setAsk(next ? { path: entry.path, ask: next } : null)}
                onLook={() => look(entry.path)}
                onOpen={() => open(entry.path)}
                onReveal={() => void store.revealWorkspace(entry.path)}
                onRemove={(force, expect) =>
                  act(entry.path, async () => {
                    const { branch } = await store.transport.request('git/worktreeRemove', {
                      root,
                      path: entry.path,
                      ...(force ? { force: true } : {}),
                      ...(expect ? { expect } : {}),
                    })
                    return branch
                      ? `Removed ${folderOf(entry.path)}. The branch ${branch} is still here.`
                      : `Removed ${folderOf(entry.path)}.`
                  })
                }
                onMove={(to) =>
                  act(entry.path, async () => {
                    const moved = await store.transport.request('git/worktreeMove', {
                      root,
                      from: entry.path,
                      to,
                    })
                    return `Moved ${folderOf(entry.path)} to ${moved.path}.`
                  })
                }
                onLock={(locked, why) =>
                  act(entry.path, async () => {
                    await store.transport.request('git/worktreeLock', {
                      root,
                      path: entry.path,
                      locked,
                      ...(why && why.trim().length > 0 ? { reason: why.trim() } : {}),
                    })
                    return locked ? `Locked ${folderOf(entry.path)}.` : `Unlocked ${folderOf(entry.path)}.`
                  })
                }
              />
            ))}
          </div>
        )}

        {error && <div className={styles.error}>{error}</div>}
      </div>
    </Dialog>
  )
}

// --------------------------------------------------------------------- rows

const WorktreeRow = ({
  entry,
  busy,
  anyBusy,
  ask,
  onAsk,
  onLook,
  onOpen,
  onReveal,
  onRemove,
  onMove,
  onLock,
}: {
  entry: GitWorktree
  busy: boolean
  anyBusy: boolean
  ask: RowAsk | null
  onAsk: (next: RowAsk | null) => void
  /** Reads what the removal would delete; the question waits on the answer. */
  onLook: () => void
  onOpen: () => void
  onReveal: () => void
  onRemove: (force: boolean, expect: string | undefined) => void
  onMove: (to: string) => void
  onLock: (locked: boolean, reason?: string) => void
}) => {
  const gone = entry.prunable !== null
  const dirty = entry.dirty ?? 0
  const name = entry.branch ?? (entry.head ? `detached at ${shortSha(entry.head)}` : 'no commits yet')

  return (
    <div
      className={styles.row}
      {...(entry.isCurrent ? { 'data-here': '' } : {})}
      {...(gone ? { 'data-gone': '' } : {})}
    >
      <div className={styles.rowHead}>
        <span className={styles.rowIcon}>
          {entry.branch ? <BranchIcon size={14} /> : <CommitIcon size={14} />}
        </span>
        <span className={styles.rowName}>{name}</span>
        {entry.isCurrent && (
          <span className={styles.chip} data-kind="here">
            here
          </span>
        )}
        {entry.isMain && (
          <span className={styles.chip} data-kind="main">
            main checkout
          </span>
        )}
        {entry.managed && (
          <span className={styles.chip} data-kind="managed" title="HarnessDesk cut this one for a session.">
            session
          </span>
        )}
        {entry.locked && (
          <span
            className={styles.chip}
            data-kind="locked"
            title={entry.locked.reason || 'Locked against pruning.'}
          >
            <LockIcon size={10} />
            locked
          </span>
        )}
        {gone && (
          <span className={styles.chip} data-kind="gone" title={entry.prunable?.reason}>
            folder is gone
          </span>
        )}
        {dirty > 0 && (
          <span className={styles.chip} data-kind="dirty">
            {dirty} uncommitted
          </span>
        )}
      </div>
      <div className={styles.rowPath} title={entry.path}>
        {ltr(entry.path)}
      </div>

      {ask === null ? (
        <div className={styles.verbs}>
          {!gone && (
            <>
              <Btn
                small
                disabled={anyBusy || entry.isCurrent}
                title={
                  entry.isCurrent
                    ? 'This is the workspace you are in.'
                    : 'Open this checkout as the workspace'
                }
                onClick={onOpen}
              >
                <FolderOpenIcon size={13} />
                Open
              </Btn>
              <Btn small disabled={anyBusy} title="Show the folder in Finder" onClick={onReveal}>
                Reveal
              </Btn>
            </>
          )}
          {!entry.isMain && (
            <>
              {entry.locked ? (
                <Btn small disabled={anyBusy} onClick={() => onLock(false)}>
                  <UnlockIcon size={13} />
                  Unlock
                </Btn>
              ) : (
                <Btn small disabled={anyBusy} onClick={() => onAsk({ kind: 'lock', reason: '' })}>
                  <LockIcon size={13} />
                  Lock…
                </Btn>
              )}
              {!gone && (
                <Btn small disabled={anyBusy} onClick={() => onAsk({ kind: 'move', to: '' })}>
                  <MoveFolderIcon size={13} />
                  Move…
                </Btn>
              )}
              <Btn small disabled={anyBusy} onClick={onLook}>
                <TrashIcon size={13} />
                Remove…
              </Btn>
            </>
          )}
          {busy && <span className={styles.working}>Working…</span>}
        </div>
      ) : ask.kind === 'remove' ? (
        <div className={styles.ask} data-tone="destructive">
          <span className={styles.askWhat}>
            {ask.failed ? (
              ask.failed
            ) : ask.held === null ? (
              'Reading what is in it…'
            ) : (
              <>
                {gone
                  ? 'The folder is already gone; this drops git’s record of it.'
                  : ask.held.changeCount === 0 && ask.held.ignoredCount === 0
                    ? 'The folder goes, and there is nothing in it to lose.'
                    : `${lost(ask.held)} would be deleted.`}
                {entry.branch ? ` The branch ${entry.branch} is kept either way.` : ''}
                {ask.held.ignoredCount > 0 && (
                  <span className={styles.askList} title={ask.held.ignored.join('\n')}>
                    {ask.held.ignored.slice(0, 4).join(', ')}
                    {ask.held.ignoredCount > 4 ? `, and ${ask.held.ignoredCount - 4} more` : ''}
                  </span>
                )}
              </>
            )}
          </span>
          <span className={styles.askDo}>
            <Btn
              small
              variant="danger"
              disabled={busy || (ask.held === null && !gone)}
              onClick={() => onRemove((ask.held?.changeCount ?? 0) > 0, ask.held?.stateId)}
            >
              {busy
                ? 'Removing…'
                : (ask.held?.changeCount ?? 0) > 0 || (ask.held?.ignoredCount ?? 0) > 0
                  ? 'Remove and discard'
                  : 'Remove'}
            </Btn>
            <Btn small disabled={busy} onClick={() => onAsk(null)}>
              Cancel
            </Btn>
          </span>
        </div>
      ) : ask.kind === 'move' ? (
        <div className={styles.ask}>
          <Input
            value={ask.to}
            placeholder={`Where it goes — beside the repository, e.g. ${folderOf(entry.path)}-2`}
            autoFocus
            aria-label="New folder for this worktree"
            onChange={(event) => onAsk({ kind: 'move', to: event.target.value })}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && ask.to.trim().length > 0) onMove(ask.to.trim())
            }}
          />
          <span className={styles.askDo}>
            <Btn
              small
              variant="primary"
              disabled={busy || ask.to.trim().length === 0}
              onClick={() => onMove(ask.to.trim())}
            >
              {busy ? 'Moving…' : 'Move'}
            </Btn>
            <Btn small disabled={busy} onClick={() => onAsk(null)}>
              Cancel
            </Btn>
          </span>
        </div>
      ) : (
        <div className={styles.ask}>
          <Input
            value={ask.reason}
            placeholder="Why it is pinned — optional, and git remembers it"
            autoFocus
            aria-label="Reason for locking"
            onChange={(event) => onAsk({ kind: 'lock', reason: event.target.value })}
            onKeyDown={(event) => {
              if (event.key === 'Enter') onLock(true, ask.reason)
            }}
          />
          <span className={styles.askDo}>
            <Btn small variant="primary" disabled={busy} onClick={() => onLock(true, ask.reason)}>
              {busy ? 'Locking…' : 'Lock'}
            </Btn>
            <Btn small disabled={busy} onClick={() => onAsk(null)}>
              Cancel
            </Btn>
          </span>
        </div>
      )}
    </div>
  )
}

// ------------------------------------------------------------ the new one

/**
 * What a new worktree needs: where it goes, and what it checks out. The
 * folder follows the branch name until someone types their own — which is
 * what every client does, and what makes the ordinary case one field.
 *
 * A branch another checkout already holds is offered greyed rather than
 * withdrawn: "why is my branch missing" is a worse question than a row that
 * says where it went.
 */
export const AddWorktreeDialog = ({
  root,
  refs,
  onDone,
}: {
  root: string
  /** The rail's refs, for the branch and base pickers. Null before they land. */
  refs: GitRefsSummary | null
  /** `made` is true when a worktree now exists — the pane re-reads on it. */
  onDone: (made: boolean) => void
}) => {
  const store = useStore()
  const [kind, setKind] = useState<GitWorktreeCheckout['kind']>('new')
  const [branch, setBranch] = useState('')
  const [folder, setFolder] = useState('')
  const [ownFolder, setOwnFolder] = useState(false)
  const [base, setBase] = useState('HEAD')
  const [existing, setExisting] = useState('')
  const [at, setAt] = useState('')
  const [andOpen, setAndOpen] = useState(true)
  const [held, setHeld] = useState<ReadonlyMap<string, string>>(new Map())
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Which branches are spoken for. Asked of the same listing the manager
  // shows, because git will refuse a second checkout of one and saying so
  // before the attempt is the whole point of the picker.
  useEffect(() => {
    let cancelled = false
    void store.transport
      .request('git/worktrees', { root })
      .then((listed) => {
        if (cancelled) return
        setHeld(new Map(listed.filter((entry) => entry.branch).map((entry) => [entry.branch!, entry.path])))
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [root, store])

  const bases = useMemo(
    () => [
      'HEAD',
      ...(refs?.branches ?? []).map((entry) => entry.name),
      ...(refs?.remotes ?? []).map((entry) => `${entry.remote}/${entry.name}`),
      ...(refs?.tags ?? []).map((entry) => entry.name),
    ],
    [refs],
  )

  const branches = refs?.branches ?? []
  const pick = existing || branches.find((entry) => !held.has(entry.name))?.name || ''
  const taken = kind === 'existing' ? held.get(pick) : undefined
  const named = kind === 'new' ? branch.trim() : kind === 'existing' ? pick : at.trim()
  const where = (ownFolder ? folder : folder || slug(named)).trim()
  const ready = where.length > 0 && named.length > 0 && taken === undefined

  const create = (): void => {
    if (!ready || busy) return
    const checkout: GitWorktreeCheckout =
      kind === 'new'
        ? { kind: 'new', branch: branch.trim(), ...(base && base !== 'HEAD' ? { base } : {}) }
        : kind === 'existing'
          ? { kind: 'existing', branch: pick }
          : { kind: 'detach', at: at.trim() }
    setBusy(true)
    setError(null)
    void store.transport
      .request('git/worktreeAdd', { root, path: where, checkout })
      .then((made) => {
        store.notice('info', `Made ${folderOf(made.path)}${made.branch ? ` on ${made.branch}` : ''}.`)
        if (andOpen) void store.openWorkspace(made.path)
        onDone(true)
      })
      .catch((raised: unknown) => {
        setError(reason(raised))
        setBusy(false)
      })
  }

  return (
    <Dialog
      title="New worktree"
      icon={<WorktreeIcon size={16} />}
      size="md"
      onClose={() => onDone(false)}
      footer={
        <>
          <Btn variant="primary" disabled={busy || !ready} onClick={create}>
            {busy ? 'Making…' : 'Create worktree'}
          </Btn>
          <Btn disabled={busy} onClick={() => onDone(false)}>
            Cancel
          </Btn>
        </>
      }
    >
      <div className={styles.body}>
        <div className={styles.modes} role="radiogroup" aria-label="What the worktree checks out">
          {(
            [
              ['new', 'New branch', 'Cut a branch for this checkout.'],
              ['existing', 'Existing branch', 'Take one no other checkout holds.'],
              ['detach', 'A commit', 'Read an old state, on no branch.'],
            ] as const
          ).map(([value, label, what]) => (
            <button
              key={value}
              type="button"
              role="radio"
              aria-checked={kind === value}
              className={styles.mode}
              {...(kind === value ? { 'data-on': '' } : {})}
              onClick={() => setKind(value)}
            >
              <span className={styles.modeName}>{label}</span>
              <span className={styles.modeWhat}>{what}</span>
            </button>
          ))}
        </div>

        {kind === 'new' && (
          <>
            <label className={styles.field}>
              <span className={styles.label}>Branch</span>
              <Input
                value={branch}
                placeholder="feature/the-thing"
                autoFocus
                aria-label="New branch name"
                onChange={(event) => setBranch(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') create()
                }}
              />
            </label>
            <label className={styles.field}>
              <span className={styles.label}>From</span>
              <select
                className={styles.select}
                value={base}
                aria-label="Where the branch starts"
                onChange={(event) => setBase(event.target.value)}
              >
                {bases.map((choice) => (
                  <option key={choice} value={choice}>
                    {choice}
                  </option>
                ))}
              </select>
            </label>
          </>
        )}

        {kind === 'existing' && (
          <label className={styles.field}>
            <span className={styles.label}>Branch</span>
            <select
              className={styles.select}
              value={pick}
              aria-label="Which branch to check out"
              onChange={(event) => setExisting(event.target.value)}
            >
              {branches.length === 0 && <option value="">No branches yet</option>}
              {branches.map((entry) => {
                const where = held.get(entry.name)
                return (
                  <option key={entry.name} value={entry.name} disabled={where !== undefined}>
                    {where ? `${entry.name} — already in ${folderOf(where)}` : entry.name}
                  </option>
                )
              })}
            </select>
          </label>
        )}

        {kind === 'detach' && (
          <label className={styles.field}>
            <span className={styles.label}>Commit</span>
            <Input
              value={at}
              placeholder="A commit id, a tag, or a branch to read from"
              autoFocus
              aria-label="Which commit to check out"
              onChange={(event) => setAt(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') create()
              }}
            />
          </label>
        )}

        <label className={styles.field}>
          <span className={styles.label}>Folder</span>
          <Input
            value={ownFolder ? folder : folder || slug(named)}
            placeholder="A name, beside the repository"
            aria-label="Folder for the worktree"
            onChange={(event) => {
              setOwnFolder(true)
              setFolder(event.target.value)
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') create()
            }}
          />
        </label>
        <span className={styles.note}>
          A worktree is made beside the repository: a plain name lands next to it, in a folder of its own so
          neither checkout shows up in the other’s status.
        </span>

        <div className={styles.switchRow}>
          <Toggle on={andOpen} onChange={setAndOpen} label="Open it as the workspace once it is made" />
          <span>Open it here once it is made.</span>
        </div>

        {taken && (
          <div className={styles.error}>
            {pick} is already checked out in {folderOf(taken)}; a branch lives in one worktree at a time.
          </div>
        )}
        {error && <div className={styles.error}>{error}</div>}
      </div>
    </Dialog>
  )
}
