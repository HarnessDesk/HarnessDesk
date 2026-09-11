import { useEffect, useMemo, useRef, useState } from 'react'

import type { GitFileStatus, GitStatus } from '@harnessdesk/protocol'

import { countChanges, splitByFile, splitHunks, type DiffHunk } from '../lib/diff'
import { inView } from '../lib/git-view'
import { Tabs, TabsList, TabsTrigger } from '../design/ui'
import { useActiveSession, useSnapshot, useStore } from '../state/context'
import { AppWindow, WindowGroup, WindowNav, WindowNavEmpty, WindowNavItem, WindowPage } from './AppWindow'
import { DiffView } from './Diff'
import { FileIcon } from './Icons'
import styles from './ChangesReview.module.css'

/**
 * Changes as a review workspace: the whole working tree in a full window,
 * grouped by folder, every hunk carrying the one action a multi-agent tool
 * should own — "revise this hunk", which quotes the hunk into the composer
 * for whichever agent holds the conversation. Staging stays git's: nothing
 * here writes to the index, and the staged toggle only changes what is read.
 *
 * The side panel's Changes tab answers "what just happened" beside the
 * conversation; this is where a person goes to *read* a day's work, which
 * needs the width and the folder shape the panel cannot give.
 */

/** How much of a hunk rides a revise request; enough to identify, not a paste bomb. */
const QUOTE_CAP = 1_800

const dirname = (path: string): string => {
  const cut = path.lastIndexOf('/')
  return cut > 0 ? path.slice(0, cut) : ''
}
const basename = (path: string): string => path.split('/').pop() || path

interface FolderGroup {
  readonly folder: string
  readonly files: readonly GitFileStatus[]
}

/** Files by folder, folders in path order, so the nav reads like the tree. */
const groupByFolder = (files: readonly GitFileStatus[]): FolderGroup[] => {
  const map = new Map<string, GitFileStatus[]>()
  for (const file of files) {
    const key = dirname(file.path)
    const list = map.get(key) ?? []
    list.push(file)
    map.set(key, list)
  }
  return [...map.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([folder, grouped]) => ({
      folder,
      files: [...grouped].sort((a, b) => a.path.localeCompare(b.path)),
    }))
}

const Counts = ({ added, removed }: { added: number; removed: number }) =>
  added + removed > 0 ? (
    <span className={styles.counts}>
      {added > 0 && <span className={styles.added}>+{added}</span>}
      {removed > 0 && <span className={styles.removed}>−{removed}</span>}
    </span>
  ) : null

export const ChangesReview = ({ onClose }: { onClose: () => void }) => {
  const store = useStore()
  const snapshot = useSnapshot()
  const session = useActiveSession()
  const root = session?.cwd ?? snapshot.workspace?.path ?? null

  const [staged, setStaged] = useState(false)
  const [query, setQuery] = useState('')
  const [git, setGit] = useState<GitStatus | null>(null)
  const [treeDiff, setTreeDiff] = useState('')
  const sections = useRef<Map<string, HTMLElement>>(new Map())

  useEffect(() => {
    if (!root) return
    let cancelled = false
    void store.transport
      .request('git/status', { root })
      .then((status) => {
        if (!cancelled) setGit(status)
      })
      .catch(() => setGit(null))
    void store.transport
      .request('git/diff', { root, ...(staged ? { staged: true } : {}) })
      .then((result) => {
        if (!cancelled) setTreeDiff(result.diff)
      })
      .catch(() => setTreeDiff(''))
    return () => {
      cancelled = true
    }
  }, [root, staged, store])

  /** Each path's own diff, cut once from the tree's. */
  const diffs = useMemo(() => {
    const map = new Map<string, string>()
    for (const file of splitByFile(treeDiff)) {
      if (file.path) map.set(file.path, file.diff)
    }
    return map
  }, [treeDiff])

  const needle = query.trim().toLowerCase()
  const files = useMemo(
    () =>
      (git?.files ?? [])
        .filter((file) => inView(file, staged))
        .filter((file) => needle.length === 0 || file.path.toLowerCase().includes(needle)),
    [git, staged, needle],
  )
  const groups = useMemo(() => groupByFolder(files), [files])

  const total = files.reduce(
    (sum, file) => {
      const count = countChanges(diffs.get(file.path) ?? '')
      return { added: sum.added + count.added, removed: sum.removed + count.removed }
    },
    { added: 0, removed: 0 },
  )

  /** The one hunk action: quote it into the composer and hand the window back. */
  const reviseHunk = (path: string, hunk: DiffHunk): void => {
    const quoted = hunk.text.length > QUOTE_CAP ? `${hunk.text.slice(0, QUOTE_CAP)}\n…` : hunk.text
    window.dispatchEvent(
      new CustomEvent('harnessdesk:compose', {
        detail: `Please revise this hunk of ${path}:\n\`\`\`diff\n${quoted}\n\`\`\`\n`,
      }),
    )
    onClose()
  }

  const jumpTo = (path: string): void => {
    // The pane's smooth-scroll silently no-ops in some hosts; land it plainly.
    sections.current.get(path)?.scrollIntoView({ block: 'start', behavior: 'auto' })
  }

  const absolute = (path: string): string => (path.startsWith('/') || !root ? path : `${root}/${path}`)

  return (
    <AppWindow label="Changes">
      <WindowNav
        onBack={onClose}
        search={{ value: query, placeholder: 'Filter files', label: 'Filter files', onChange: setQuery }}
      >
        {groups.length === 0 ? (
          <WindowNavEmpty>
            {git === null
              ? 'Not a git repository.'
              : needle.length > 0
                ? 'No files match that filter.'
                : staged
                  ? 'Nothing staged.'
                  : 'No uncommitted changes.'}
          </WindowNavEmpty>
        ) : (
          groups.map((group) => (
            <WindowGroup key={group.folder || '.'} label={group.folder || 'in this folder'}>
              {group.files.map((file) => {
                const count = countChanges(diffs.get(file.path) ?? '')
                return (
                  <WindowNavItem
                    key={file.path}
                    icon={<FileIcon size={13} />}
                    label={basename(file.path)}
                    trail={<Counts added={count.added} removed={count.removed} />}
                    selected={false}
                    onClick={() => jumpTo(file.path)}
                  />
                )
              })}
            </WindowGroup>
          ))
        )}
      </WindowNav>

      <WindowPage wide>
        <header className={styles.head}>
          <div>
            <h1 className={styles.title}>Changes</h1>
            <div className={styles.sub}>
              {git?.branch ? `on ${git.branch} · ` : ''}
              {files.length} file{files.length === 1 ? '' : 's'}
              {total.added + total.removed > 0 ? ` · +${total.added} −${total.removed}` : ''}
            </div>
          </div>
          {/* Was a hand-rolled tablist: correct roles, but no arrow keys and no
              roving focus, so a keyboard tabbed through every scope one at a
              time. The system's tabs bring both. */}
          <Tabs
            value={staged ? 'staged' : 'working'}
            onValueChange={(next) => setStaged(next === 'staged')}
            className={styles.scope}
          >
            <TabsList aria-label="Which changes">
              <TabsTrigger value="working">Working tree</TabsTrigger>
              <TabsTrigger value="staged">Staged</TabsTrigger>
            </TabsList>
          </Tabs>
        </header>

        {groups.length === 0 && (
          <div className={styles.empty}>
            {git === null
              ? 'This folder is not a git repository, so there is nothing to compare against.'
              : staged
                ? 'Nothing staged. Staging stays in git — stage there, review here.'
                : 'No uncommitted changes.'}
          </div>
        )}

        {groups.map((group) => (
          <section key={group.folder || '.'} className={styles.folder}>
            <h2 className={styles.folderName}>{group.folder || 'in this folder'}</h2>
            {group.files.map((file) => {
              const diff = diffs.get(file.path) ?? ''
              const hunks = splitHunks(diff)
              const count = countChanges(diff)
              return (
                <article
                  key={file.path}
                  className={styles.file}
                  ref={(element) => {
                    if (element) sections.current.set(file.path, element)
                    else sections.current.delete(file.path)
                  }}
                >
                  <div className={styles.fileHead}>
                    <span className={styles.filePath} title={file.path}>
                      {basename(file.path)}
                    </span>
                    <Counts added={count.added} removed={count.removed} />
                    <span className={styles.space} />
                    <button type="button" className={styles.action} onClick={() => store.openFile(absolute(file.path))}>
                      Open
                    </button>
                  </div>
                  {hunks.length === 0 ? (
                    <div className={styles.quiet}>
                      {file.status === 'untracked'
                        ? 'New file — open it to read it.'
                        : staged
                          ? 'No staged diff for this file.'
                          : 'No diff to show.'}
                    </div>
                  ) : (
                    hunks.map((hunk, index) => (
                      <div key={`${file.path}-${index}`} className={styles.hunk}>
                        <div className={styles.hunkHead}>
                          <code className={styles.hunkRange}>{hunk.header}</code>
                          <span className={styles.space} />
                          <button
                            type="button"
                            className={styles.action}
                            title="Quote this hunk into the composer as a revision request"
                            onClick={() => reviseHunk(file.path, hunk)}
                          >
                            Revise this hunk…
                          </button>
                        </div>
                        <DiffView diff={hunk.text} />
                      </div>
                    ))
                  )}
                </article>
              )
            })}
          </section>
        ))}
      </WindowPage>
    </AppWindow>
  )
}
