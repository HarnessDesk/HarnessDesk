import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'

import { currentTurn, type GitStatus } from '@harnessdesk/protocol'

import { countChanges, splitByFile } from '../lib/diff'
import { useActiveSession, useSnapshot, useStore } from '../state/context'
import { downloadMarkdown, exportFilename, sessionToMarkdown } from '../lib/export-session'
import { inView } from '../lib/git-view'
import { Activity } from './Activity'
import { Agents } from './Agents'
import { DiffView } from './Diff'
import { FileIcon, ReviewIcon, SearchIcon } from './Icons'
import { IconBtn } from '../design/primitives/Kit'
import { Counts, GroupLine, panel, PanelEmpty, PanelRow } from './Panel'
import { Trajectory } from './Trajectory'
import styles from './Details.module.css'

/**
 * The inspectors: what changed, where the time went, which sub-agents ran,
 * what the repository has been doing.
 *
 * They share a frame — a filter row, a scrolling body, a footer of two strings
 * — and nothing else. The strip above them, their labels, their icons and
 * every door that opens one belong to the panel system: they are registered in
 * `panels/builtins.tsx` like any other view, and this file has no opinion about
 * where they are drawn.
 *
 * It used to have one. A `VIEWS` table here named the four, and the conversation
 * header and the command palette built their entries from it — a second
 * registry beside the real one, which is a thing that can only drift and did:
 * the labels went on being maintained here after both consumers had moved to
 * `summonable()`, and its `find` strings were being copied by hand into the
 * call sites below. Both are the registry's now, and this file is four lists
 * of rows.
 *
 * Changes has two sources, deliberately kept apart: what this turn changed
 * (the runtime's aggregated turn diff) and what the working tree looks like
 * now (git). They answer different questions — "what did the agent just do"
 * versus "what would I be committing" — and conflating them hides
 * uncommitted work the agent did not make.
 */

/** What a tab reports about its own list, for the one footer they share. */
export type ReportFoot = (left: string, right: string) => void

const basename = (path: string): string => path.split('/').pop() || path

const dirname = (path: string): string => {
  const cut = path.lastIndexOf('/')
  return cut > 0 ? path.slice(0, cut) : ''
}

/** Where the file is and what happened to it, on the row's one quiet line. */
const where = (path: string, word: string): string => {
  const dir = dirname(path)
  return dir === '' ? word : `${dir} · ${word}`
}

const STATUS_WORD: Record<string, string> = {
  modified: 'modified',
  added: 'added',
  deleted: 'deleted',
  renamed: 'renamed',
  untracked: 'new file, not tracked yet',
  conflicted: 'conflicted',
}

/**
 * The frame the four inspectors share.
 *
 * It used to be the *panel*: one component that drew a tab strip, chose which
 * of four bodies to render, and owned the filter, the footer and the close
 * button for all of them. That made the four inseparable from the right-hand
 * column — the Team surface had to be written a second time as a pane to
 * appear anywhere else.
 *
 * What is left here is only what the four actually share: a filter row, a
 * scrolling body, and a footer they each report two strings into. The strip
 * above them, the close button and the expand controls belong to whatever
 * panel they are docked in, which is why each of these is now a view the
 * workbench can put in the right panel, the bottom panel, or a pane.
 */
const InspectorFrame = ({
  find,
  query,
  onQuery,
  tools,
  foot,
  children,
}: {
  find: string
  query: string
  onQuery: (next: string) => void
  tools?: ReactNode
  foot: readonly [string, string]
  children: ReactNode
}) => {
  const store = useStore()
  const session = useActiveSession()
  return (
    <div className={panel.panel}>
      <div className={panel.tools}>
        <label className={panel.findBox}>
          <SearchIcon size={13} />
          <input
            value={query}
            placeholder={find}
            spellCheck={false}
            aria-label={find}
            onChange={(event) => onQuery(event.target.value)}
          />
        </label>
        {tools}
        <IconBtn
          disabled={!session}
          aria-label="Export this session as Markdown"
          title="Export this session as Markdown"
          onClick={() => {
            if (!session) return
            downloadMarkdown(exportFilename(session), sessionToMarkdown(session))
            store.notice('info', 'Session exported as Markdown.')
          }}
        >
          <FileIcon size={14} />
        </IconBtn>
      </div>

      <div className={panel.body}>{children}</div>

      <div className={panel.foot}>
        {foot[0]}
        <span className={panel.space} />
        {foot[1]}
      </div>
    </div>
  )
}

/** The two strings an inspector's list reports into the footer it shares. */
const useFoot = (): readonly [readonly [string, string], ReportFoot] => {
  const [foot, setFoot] = useState<readonly [string, string]>(['', ''])
  const onFoot: ReportFoot = useCallback((left, right) => {
    setFoot((current) => (current[0] === left && current[1] === right ? current : [left, right]))
  }, [])
  return [foot, onFoot]
}

export const ChangesView = () => {
  const [query, setQuery] = useState('')
  // Staged and unstaged answer different questions — "what have I decided to
  // commit" versus "what else is there" — so the panel shows one at a time
  // rather than a merged diff that hides which is which.
  const [staged, setStaged] = useState(false)
  const [foot, onFoot] = useFoot()
  return (
    <InspectorFrame
      find="Filter files"
      query={query}
      onQuery={setQuery}
      foot={foot}
      tools={
        <>
          <button
            type="button"
            className={panel.pill}
            {...(staged ? { 'data-on': '' } : {})}
            title="Show what is staged instead of what is not"
            onClick={() => setStaged((value) => !value)}
          >
            staged
          </button>
          {/* Not the panel's expand glyph, which sits directly above this one
              in the panel's own strip. That one gives this panel the room; this
              one leaves the layout entirely for the review workspace. Two ⤢ an
              inch apart, doing different things, is the reader's problem. */}
          <IconBtn
            aria-label="Review in a full window"
            title="Review in a full window — folders, hunks, and revise-this-hunk"
            onClick={() => window.dispatchEvent(new CustomEvent('harnessdesk:review'))}
          >
            <ReviewIcon size={14} />
          </IconBtn>
        </>
      }
    >
      <Changes query={query} staged={staged} onFoot={onFoot} />
    </InspectorFrame>
  )
}

export const TrajectoryView = () => {
  const [query, setQuery] = useState('')
  const [timedOnly, setTimedOnly] = useState(false)
  const [foot, onFoot] = useFoot()
  return (
    <InspectorFrame
      find="Filter steps"
      query={query}
      onQuery={setQuery}
      foot={foot}
      tools={
        <button
          type="button"
          className={panel.pill}
          {...(timedOnly ? { 'data-on': '' } : {})}
          title="Show only steps the runtime timed"
          onClick={() => setTimedOnly((value) => !value)}
        >
          timed
        </button>
      }
    >
      <Trajectory query={query} timedOnly={timedOnly} onFoot={onFoot} />
    </InspectorFrame>
  )
}

export const AgentsView = () => {
  const [query, setQuery] = useState('')
  const [foot, onFoot] = useFoot()
  return (
    <InspectorFrame find="Filter sub-agents" query={query} onQuery={setQuery} foot={foot}>
      <Agents query={query} onFoot={onFoot} />
    </InspectorFrame>
  )
}

export const ActivityView = () => {
  const [query, setQuery] = useState('')
  const [foot, onFoot] = useFoot()
  return (
    <InspectorFrame
      find="Filter sessions"
      query={query}
      onQuery={setQuery}
      foot={foot}
      tools={<span className={panel.pill}>this week</span>}
    >
      <Activity query={query} onFoot={onFoot} />
    </InspectorFrame>
  )
}

/** What this conversation edited, and what the tree looks like now. */
const Changes = ({
  query,
  staged,
  onFoot,
}: {
  query: string
  staged: boolean
  onFoot: ReportFoot
}) => {
  const store = useStore()
  const snapshot = useSnapshot()
  const session = useActiveSession()
  /*
   * Three states, not two: `undefined` is "nobody has answered yet", `null` is
   * "asked, and it is not a repository".
   *
   * One `null` for both meant the panel opened saying *This folder is not a
   * git repository* — every time, for as long as the round trip took, about a
   * folder that plainly was one — and said it permanently whenever the request
   * failed. A panel that states something false while it waits is worse than
   * one that says nothing, because the reader has no way to know which of the
   * two they are looking at.
   */
  const [git, setGit] = useState<GitStatus | null | undefined>(undefined)
  const [treeDiff, setTreeDiff] = useState('')
  const [selected, setSelected] = useState<string | null>(null)
  const [fileDiff, setFileDiff] = useState<string>('')

  const root = session?.cwd ?? snapshot.workspace?.path ?? null
  const turn = session ? currentTurn(session) : undefined
  const turnDiff = turn?.diff ?? null

  // Refresh git whenever the agent stops working, since that is when the tree
  // has just changed and the user is most likely to look.
  const busy = session?.status.type === 'active'
  useEffect(() => {
    if (!root) {
      setGit(null)
      return
    }
    let cancelled = false
    void store.transport
      .request('git/status', { root })
      .then((status) => {
        if (!cancelled) setGit(status)
      })
      .catch(() => {
        if (!cancelled) setGit(null)
      })
    return () => {
      cancelled = true
    }
  }, [root, busy, store, turnDiff])

  // The whole tree's diff, once — which is what makes a per-file count
  // possible without a request for every row.
  useEffect(() => {
    if (!root) return
    let cancelled = false
    void store.transport
      .request('git/diff', { root, ...(staged ? { staged: true } : {}) })
      .then((result) => {
        if (!cancelled) setTreeDiff(result.diff)
      })
      .catch(() => setTreeDiff(''))
    return () => {
      cancelled = true
    }
  }, [root, staged, busy, store, turnDiff])

  useEffect(() => {
    if (!root || !selected) {
      setFileDiff('')
      return
    }
    let cancelled = false
    void store.transport
      .request('git/diff', { root, path: selected, ...(staged ? { staged: true } : {}) })
      .then((result) => {
        if (!cancelled) setFileDiff(result.diff)
      })
      .catch(() => setFileDiff(''))
    return () => {
      cancelled = true
    }
  }, [root, selected, staged, store])

  /** How many lines each path gained and lost, read once from the tree diff. */
  const counts = useMemo(() => {
    const map = new Map<string, { added: number; removed: number }>()
    for (const file of splitByFile(treeDiff)) {
      if (file.path) map.set(file.path, countChanges(file.diff))
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
  const turnFiles = useMemo(
    () =>
      (turnDiff ? splitByFile(turnDiff) : []).filter(
        (file) => needle.length === 0 || file.path.toLowerCase().includes(needle),
      ),
    [turnDiff, needle],
  )

  const total = files.reduce(
    (sum, file) => {
      const count = counts.get(file.path)
      return { added: sum.added + (count?.added ?? 0), removed: sum.removed + (count?.removed ?? 0) }
    },
    { added: 0, removed: 0 },
  )

  useEffect(() => {
    onFoot(
      `${files.length} file${files.length === 1 ? '' : 's'}`,
      git?.branch ? `against ${git.branch}` : (snapshot.workspace?.name ?? ''),
    )
  }, [files.length, git?.branch, snapshot.workspace?.name, onFoot])

  /** Puts a request about one file into the focused composer — a review comment the agent will act on. */
  const revise = (path: string): void => {
    window.dispatchEvent(
      new CustomEvent('harnessdesk:compose', {
        detail: `Please revise your change to ${path}: `,
      }),
    )
  }
  const absolute = (path: string): string => (path.startsWith('/') || !root ? path : `${root}/${path}`)

  return (
    <>
      {turnFiles.length > 0 && (
        <>
          <GroupLine left={`This turn · ${turnFiles.length} file${turnFiles.length === 1 ? '' : 's'}`} />
          {turnFiles.map((file, index) => {
            const count = countChanges(file.diff)
            return (
              <div key={`${file.path}-${index}`}>
                <PanelRow
                  mark={<FileIcon size={13} />}
                  title={basename(file.path)}
                  sub={dirname(file.path) || 'in this folder'}
                  subPath
                  tooltip={file.path}
                  trail={<Counts added={count.added} removed={count.removed} />}
                />
                <div className={styles.inline}>
                  <DiffView diff={file.diff} />
                </div>
              </div>
            )
          })}
        </>
      )}

      <GroupLine
        left={`${staged ? 'Staged' : 'Working tree'} · ${files.length}`}
        right={total.added + total.removed > 0 ? `+${total.added} −${total.removed}` : undefined}
      />
      {files.length === 0 ? (
        <PanelEmpty>
          {git === undefined
            ? 'Reading the working tree…'
            : git
              ? needle.length > 0
                ? 'No files match that filter.'
                : staged
                  ? 'Nothing staged.'
                  : 'No uncommitted changes.'
              : 'This folder is not a git repository, so there is nothing to compare against.'}
        </PanelEmpty>
      ) : (
        files.map((file) => {
          const count = counts.get(file.path)
          return (
            <div key={file.path}>
              <PanelRow
                mark={<FileIcon size={13} />}
                title={basename(file.path)}
                sub={where(file.path, STATUS_WORD[file.status] ?? file.status)}
                subPath={dirname(file.path) !== ''}
                tooltip={file.path}
                selected={selected === file.path}
                onClick={() => setSelected(selected === file.path ? null : file.path)}
                {...(count ? { trail: <Counts added={count.added} removed={count.removed} /> } : {})}
              />
              {selected === file.path && (
                <div className={styles.inline}>
                  <div className={styles.fileActions}>
                    <button
                      type="button"
                      className={styles.fileAction}
                      onClick={() => store.openFile(absolute(file.path))}
                    >
                      Open
                    </button>
                    <button
                      type="button"
                      className={styles.fileAction}
                      onClick={() => revise(file.path)}
                    >
                      Revise…
                    </button>
                  </div>
                  {fileDiff ? (
                    <DiffView diff={fileDiff} />
                  ) : (
                    <PanelEmpty>
                      {file.status === 'untracked'
                        ? 'New file — open it to read it.'
                        : 'No diff to show.'}
                    </PanelEmpty>
                  )}
                </div>
              )}
            </div>
          )
        })
      )}
    </>
  )
}
