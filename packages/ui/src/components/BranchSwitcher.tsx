import { useEffect, useMemo, useState } from 'react'

import { useStore } from '../state/context'
import { BranchIcon, PlusIcon } from './Icons'
import { ActionError, Button, Input, MenuItem, MenuLabel, MenuNote, Search } from '../design'
import styles from './BranchSwitcher.module.css'

/**
 * The branches of a folder, as the level behind the branch row.
 *
 * Codex hangs its branch list off the branch itself rather than laying it
 * beside it, which is why this is a submenu's contents and not a section: the
 * top level says which branch you are on, and opening that row is what asks
 * "which others are there". A search box once there are enough to need one,
 * the local branches with the current one checked, and "Create and checkout
 * new branch…" at the foot. The host refuses a checkout on a dirty tree and
 * the refusal shows here, where the click was, rather than as a toast that
 * has already gone by the time the user looks for it.
 */

const relativeTime = (at: number, now: number): string => {
  const minutes = Math.max(1, Math.round((now - at) / 60_000))
  if (minutes < 60) return `${minutes}m`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours}h`
  const days = Math.round(hours / 24)
  return days < 30 ? `${days}d` : new Date(at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

const FILTER_FROM = 6

export const BranchSwitcher = ({ root, onDone }: { root: string; onDone: () => void }) => {
  const store = useStore()
  const [branches, setBranches] = useState<readonly { name: string; current: boolean; committedAt: number }[] | null>(null)
  const [query, setQuery] = useState('')
  const [creating, setCreating] = useState(false)
  const [name, setName] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const now = useMemo(() => Date.now(), [])
  const folder = root.split('/').filter(Boolean).at(-1) ?? root

  useEffect(() => {
    let cancelled = false
    void store.listBranches(root).then((list) => {
      if (!cancelled) setBranches(list)
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

  const checkout = async (branch: string, create: boolean): Promise<void> => {
    if (busy !== null) return
    setBusy(branch)
    setError(null)
    try {
      const ok = await store.checkoutBranch(root, branch, { create })
      if (ok) onDone()
      else setError(create ? `Could not create ${branch}.` : `Could not switch to ${branch}. The working tree may have uncommitted changes.`)
    } finally {
      setBusy(null)
    }
  }

  return (
    <>
      {branches && branches.length >= FILTER_FROM && (
        <div className={styles.search}>
          <Search
            className={styles.filter}
            placeholder={`Search ${folder} branches`}
            value={query}
            autoFocus
            onChange={setQuery}
          />
        </div>
      )}
      <MenuLabel>Branches</MenuLabel>
      <div className={styles.list}>
        {branches === null && <MenuNote>Reading branches…</MenuNote>}
        {branches !== null && shown.length === 0 && (
          <MenuNote>{query ? 'No branch matches.' : 'No branches — not a git repository?'}</MenuNote>
        )}
        {shown.map((branch) => (
          <MenuItem
            key={branch.name}
            icon={<BranchIcon size={15} />}
            label={branch.name}
            value={busy === branch.name ? '…' : relativeTime(branch.committedAt, now)}
            selected={branch.current}
            disabled={busy !== null}
            keepOpen
            onSelect={() => (branch.current ? onDone() : void checkout(branch.name, false))}
          />
        ))}
      </div>
      {error && (
        <ActionError>{error}</ActionError>
      )}
      {creating ? (
        <form
          className={styles.create}
          onSubmit={(event) => {
            event.preventDefault()
            if (name.trim()) void checkout(name.trim(), true)
          }}
        >
          <Input
            variant="quiet" controlSize="compact" className={styles.filter}
            placeholder="new-branch-name"
            value={name}
            autoFocus
            spellCheck={false}
            onChange={(event) => setName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                event.stopPropagation()
                setCreating(false)
              }
            }}
          />
          <Button type="submit" variant="default" size="sm" className={styles.createButton} disabled={!name.trim() || busy !== null}>
            Create
          </Button>
        </form>
      ) : (
        <MenuItem
          icon={<PlusIcon size={15} />}
          label="Create and checkout new branch…"
          keepOpen
          onSelect={() => setCreating(true)}
        />
      )}
    </>
  )
}
