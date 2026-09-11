import { useEffect, useMemo, useState } from 'react'

import { Btn, Dialog, Input } from '../design'
import { useSnapshot, useStore } from '../state/context'
import { folderName } from '../lib/projects'
import { slugify } from '../lib/worktree-branch'
import { BranchIcon, CheckIcon, FolderOpenIcon, SearchIcon } from './Icons'
import styles from './NewWorktree.module.css'

/**
 * Starting a conversation in a worktree of its own.
 *
 * The button this hangs off used to do the whole thing in one click, and the
 * result was a checkout on a branch called `harnessdesk/session-mfk3x1`,
 * always from HEAD. That is a worktree you cannot find again in `git branch`
 * and cannot start from the branch you meant, which is why it never felt
 * worth pressing. Two answers make it worth pressing, and they are the only
 * two: what to call it, and where it starts.
 *
 * Codex asks for the first of those and not the second (its dialog is
 * "Create worktree and save as a project", from HEAD, name only). The branch
 * matters here because HarnessDesk's own worktrees are where parallel work
 * happens, and parallel work rarely all starts from whatever is checked out
 * at the moment you press the button.
 *
 * It points the draft; it does not cut the checkout. The composer's Work in
 * control then says "New worktree" over the message being written, and the
 * host makes the worktree when that message goes — so a draft abandoned
 * after this dialog leaves no branch and no folder behind, the same bargain
 * a draft already keeps with the agent's history. A checkout wanted for its
 * own sake, with no conversation in it, is the history pane's to make.
 *
 * The name is a name, not a branch: the host slugs it and namespaces it
 * `harnessdesk/`, so a worktree is recognisable among a person's own
 * branches and can never collide with one. The line under the field shows
 * exactly what that will be, because a field whose value is transformed has
 * to show the transformation.
 *
 * Which project it comes off is in the subhead, with its path, because three
 * places raise this dialog and one of them — a project's own context menu —
 * can name a project that is *not* the one the rest of the window is showing.
 * The folder name alone will not do it either: `mathcat` and its worktree are
 * both called `mathcat`, and two checkouts of one repository are the case
 * this feature exists to create.
 */

/** Enough branches that reading the list is slower than typing at it. */
const FILTER_FROM = 6

/**
 * Everything in a path *before* its last segment, shortened from the front.
 *
 * The strip shows one string — the path — with its last segment lit, rather
 * than the folder name and then the path that ends in it, which is the same
 * word twice and leaves neither enough room. Splitting it in two here lets
 * the stylesheet decide which half is allowed to shrink, and the answer is
 * never the name.
 *
 * The front is the end to lose: everything on one machine shares a home
 * directory, and it is the tail that tells `code/deepseek/HarnessDesk` from
 * `.harnessdesk/worktrees/HarnessDesk-7ae59f74`. Done here rather than with
 * `direction: rtl`, which moves a leading `/` to the far end and renders
 * `/one/two` as `one/two/`.
 */
const leadPath = (path: string): string => {
  const parts = path.split('/').filter(Boolean)
  const lead = parts.slice(Math.max(0, parts.length - 3), -1)
  return `${parts.length > 3 ? '…/' : '/'}${lead.length > 0 ? `${lead.join('/')}/` : ''}`
}

export const NewWorktree = ({
  root,
  onClose,
}: {
  /** The repository the worktree comes off. */
  root: string
  onClose: () => void
}) => {
  const store = useStore()
  const snapshot = useSnapshot()
  const folder = folderName(root)
  // Open *here*, not merely in the recent list: a draft belongs to the folder
  // the window is in, so pointing one at a worktree of any other project
  // switches the window first — and the subhead says so before it does.
  const opened = snapshot.workspace?.path === root
  const taken = useMemo(
    () => new Set(snapshot.worktrees.map((entry) => entry.branch ?? '')),
    [snapshot.worktrees],
  )
  // Empty, not prefilled. A default here would be the project's own name,
  // which makes `harnessdesk/harnessdesk` — and a name nobody chose is the
  // thing that made the old one-click button not worth pressing. The line
  // below stays a hint until there is a name to judge, so an untouched field
  // is not scolded for being empty.
  const [name, setName] = useState('')
  const [touched, setTouched] = useState(false)
  const [branches, setBranches] = useState<
    readonly { name: string; current: boolean; committedAt: number }[] | null
  >(null)
  const [base, setBase] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let cancelled = false
    void store.listBranches(root).then((list) => {
      if (cancelled) return
      setBranches(list)
      // "Where you are" is the answer nine times out of ten, so it is the one
      // already chosen — the list is here to disagree with, not to fill in.
      setBase((chosen) => chosen ?? list.find((branch) => branch.current)?.name ?? null)
    })
    return () => {
      cancelled = true
    }
  }, [root, store])

  const shown = useMemo(() => {
    if (!branches) return []
    const needle = query.trim().toLowerCase()
    return needle ? branches.filter((branch) => branch.name.toLowerCase().includes(needle)) : branches
  }, [branches, query])

  const slug = slugify(name)
  const branch = `harnessdesk/${slug}`
  // Taken is what the host refuses: every local branch, not just the ones a
  // worktree has checked out — a branch left behind by a removed worktree
  // collides at `worktree add -b` all the same.
  const clash =
    slug.length > 0 && (taken.has(branch) || (branches ?? []).some((entry) => entry.name === branch))
  const problem = slug.length === 0 ? 'Give it a name.' : clash ? `${branch} already exists.` : null
  const shout = problem !== null && (touched || clash)

  const create = async (): Promise<void> => {
    setBusy(true)
    try {
      // A project reached from its own row is opened first — the store does
      // that, as "New session" on the same row does. Saying so in the
      // subhead beforehand is the difference between this and being refused
      // after filling the whole dialog in.
      if (await store.armWorktree(root, name, base ?? undefined)) onClose()
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog
      title="New worktree"
      icon={<BranchIcon size={16} />}
      size="md"
      onClose={onClose}
      subhead={
        <span className={styles.of} title={root}>
          <FolderOpenIcon size={13} className={styles.ofIcon} />
          <span className={styles.ofLead}>{leadPath(root)}</span>
          <span className={styles.ofName}>{folder}</span>
          {!opened && <span className={styles.ofNote}>switches to this folder first</span>}
        </span>
      }
      footer={
        <>
          <Btn variant="primary" disabled={busy || problem !== null} onClick={() => void create()}>
            {busy ? 'Opening…' : 'Start in a new worktree'}
          </Btn>
          <Btn disabled={busy} onClick={onClose}>
            Cancel
          </Btn>
        </>
      }
    >
      <p className={styles.blurb}>
        A separate checkout on a branch of its own, for the conversation you are starting. It is
        made when you send the first message, and the working tree you have now is left alone.
      </p>

      <label className={styles.field}>
        <span className={styles.label}>Name</span>
        <Input
          value={name}
          autoFocus
          placeholder="what this worktree is for"
          onChange={(event) => {
            setTouched(true)
            setName(event.target.value)
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && problem === null && !busy) void create()
          }}
        />
      </label>
      <p className={styles.preview} {...(shout ? { 'data-problem': '' } : {})}>
        {shout ? (
          problem
        ) : slug.length === 0 ? (
          <>
            Its branch is named <span className={styles.mono}>harnessdesk/…</span>, so it is easy
            to find among your own.
          </>
        ) : (
          <>
            Branch <span className={styles.mono}>{branch}</span>
          </>
        )}
      </p>

      <div className={styles.field}>
        <span className={styles.label}>Start from</span>
        {branches !== null && branches.length >= FILTER_FROM && (
          <div className={styles.search}>
            <SearchIcon size={13} className={styles.searchIcon} />
            <input
              className={styles.filter}
              placeholder={`Search ${folder} branches`}
              value={query}
              spellCheck={false}
              onChange={(event) => setQuery(event.target.value)}
            />
          </div>
        )}
        <div className={styles.branches} role="radiogroup" aria-label="Start the worktree from">
          {branches === null && <p className={styles.note}>Reading branches…</p>}
          {branches !== null && shown.length === 0 && (
            <p className={styles.note}>
              {query ? 'No branch matches.' : 'No branches yet — it will start from HEAD.'}
            </p>
          )}
          {shown.map((entry) => (
            <button
              key={entry.name}
              type="button"
              role="radio"
              aria-checked={entry.name === base}
              className={styles.branch}
              {...(entry.name === base ? { 'data-selected': '' } : {})}
              onClick={() => setBase(entry.name)}
            >
              <BranchIcon size={13} className={styles.branchIcon} />
              <span className={styles.branchName}>{entry.name}</span>
              {entry.current && <span className={styles.here}>current</span>}
              {entry.name === base && <CheckIcon size={13} className={styles.tick} />}
            </button>
          ))}
        </div>
      </div>
    </Dialog>
  )
}
