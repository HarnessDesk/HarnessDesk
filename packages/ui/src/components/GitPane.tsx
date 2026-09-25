import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react'

import type {
  GitBranchRef,
  GitCommitDetail,
  GitLogCommit,
  GitLogScope,
  GitLogSearch,
  GitMergeOutcome,
  GitRefsSummary,
  GitStashRef,
  GitTagRef,
  GitWorktree,
} from '@harnessdesk/protocol'

import { laneWindow, layoutGraph, type GraphRow, type LaneWindow } from '../lib/git-graph'
import { CommitProvenance, CommitSeatLabels, useProvenanceBatch } from './CommitProvenance'
import { GitGraph } from './GitGraph'
import { clampColumn, GIT_COLUMNS, type GitColumnName } from '../lib/git-columns'
import { branchTree, commitDate, inFolder, refChips, shortSha, type RefChip as RefChipData } from '../lib/git-refs'
import { openExternal } from '../lib/desktop'
import { shortPath } from '../lib/paths'
import { useActiveSession, useSnapshot, useStore } from '../state/context'
import { useMount } from '../panels/mount'
import { ActionError, Alert, Badge, Card, CardContent, ChangeStats, Chip, CodeText, Dialog, DisclosureChevron, Dot, EmptyState, FileState, GitHistoryActionBar, GitHistoryCommitDetail, GitHistoryCommitDetailHeader, GitHistoryCommitFileList, GitHistoryDiffViewport, GitHistoryFilters, GitHistoryInlinePatch, GitHistoryTableHeader, KeyValue, KeyValueRow, Note, PatchHeader, PopoverGroupLabel, ResizeHandle, Separator, Text } from '../design'
import { Button, Input, NativeSelect, RefusedAction, Search, Segmented, Switch } from '../design'
import { DiffView } from './Diff'
import {
  AgentIcon,
  BranchIcon,
  CommitIcon,
  CopyIcon,
  CrossIcon,
  DiffIcon,
  FetchIcon,
  FileIcon,
  FolderIcon,
  LockIcon,
  MergeIcon,
  MoveFolderIcon,
  PencilIcon,
  PullIcon,
  PullRequestIcon,
  PushIcon,
  RefreshIcon,
  ResetIcon,
  SidebarIcon,
  StashIcon,
  TagIcon,
  TeamIcon,
  TrashIcon,
  UnlockIcon,
  WorktreeIcon,
} from './Icons'
import { ContextMenu, MenuItem, MenuLabel, MenuSeparator, useContextMenu } from '../design'
import { FrontDoor } from './FrontDoor'
import { ltr, ToolPaneHeader } from './ToolPaneHeader'
import {
  CommitDialog,
  ConfirmDialog,
  DeleteBranchDialog,
  DiffRangeDialog,
  MergeDialog,
  RenameBranchDialog,
  ResetDialog,
  StashDialog,
  TagDialog,
} from './GitDialogs'
import { AddWorktreeDialog, WorktreeDialog } from './GitWorktrees'
import { AskAgentDialog } from './GitAskAgent'
import type { GitTrouble } from '../lib/git-trouble'
import styles from './GitPane.module.css'

/**
 * The repository's history, as a pane — the SourceTree shape mapped onto
 * this app's rules. A table of commits over a lane graph; a rail of refs;
 * one commit opened underneath with its files and each file's patch on
 * demand; a toolbar of the client verbs (commit, pull, push, fetch, branch,
 * merge, stash) and context menus on commits, branches, tags and stashes.
 *
 * Every write goes through the host's refusal-first gates: a checkout
 * refuses on a dirty tree, a rebase aborts itself on conflict, a hard reset
 * is asked twice in red. The verbs that can end in conflicts (merge, pull,
 * revert, cherry-pick, stash apply) treat them as state, not failure — the
 * files stay in the tree, named, and the Changes surface opens on them.
 * The agent is still a first-class way to do the risky things: "ask the
 * agent to revert" composes the request instead of running it.
 *
 * The table is windowed by hand: a history is tens of thousands of rows,
 * every row is the same height, and a dependency would re-derive exactly
 * this arithmetic.
 */

const PAGE = 400
/** How deep a jump-to-ref will page before admitting the commit is far away. */
const JUMP_CAP = 4000
const ROW = 26
const LANE_W = 12
/** Lanes drawn before the gutter stops growing; deeper ones clip. */
const LANE_CAP = 10

const OVERSCAN = 12

/** Padding between the last lane and the description. */
const GUTTER_PAD = 10

const RefChip = ({ chip }: { chip: RefChipData }) => {
  const appearance = chip.kind === 'head'
    ? { tone: 'brand' as const, emphasis: true as const }
    : chip.kind === 'branch'
      ? { tint: 'blue' as const }
      : chip.kind === 'tag'
        ? { tint: 'amber' as const }
        : { tone: 'neutral' as const }

  return (
    <Chip {...appearance} className={styles.chip} title={chip.name}>
      {chip.kind === 'tag' ? <TagIcon size={10} /> : <BranchIcon size={10} />}
      <span className={styles.chipName}>{chip.name}</span>
    </Chip>
  )
}

/** Which columns fit, measured from the pane itself. */
const fits = (width: number) => ({
  rail: width >= 640,
  sha: width >= 470,
  date: width >= 570,
  author: width >= 700,
  sideBySide: width >= 880,
  /** The toolbar's words; below this the verbs stand as glyphs alone. */
  labels: width >= 560,
})

interface HistoryPage {
  readonly commits: readonly GitLogCommit[]
  readonly hasMore: boolean
}

/** What a rail row's context menu is about. */
type RailTarget =
  | { readonly kind: 'branch'; readonly branch: GitBranchRef }
  | { readonly kind: 'remote'; readonly remote: string; readonly name: string; readonly sha: string }
  | { readonly kind: 'tag'; readonly tag: GitTagRef }
  | { readonly kind: 'stash'; readonly stash: GitStashRef }
  | { readonly kind: 'worktree'; readonly worktree: GitWorktree }

/** Which question is open over the pane, with what it needs to ask it. */
type DialogState =
  | { readonly kind: 'commit' }
  | { readonly kind: 'worktrees'; readonly focus?: { readonly path: string; readonly intent: 'remove' | 'move' } }
  | { readonly kind: 'worktreeAdd' }
  | { readonly kind: 'merge'; readonly preselect?: string }
  | { readonly kind: 'rename'; readonly from: string }
  | { readonly kind: 'deleteBranch'; readonly name: string }
  | { readonly kind: 'tag'; readonly at: string }
  | { readonly kind: 'reset'; readonly to: string; readonly subject: string }
  | { readonly kind: 'stash' }
  | { readonly kind: 'diffRange'; readonly from: string; readonly to: string }
  | { readonly kind: 'review'; readonly branch: string }
  | {
      readonly kind: 'confirm'
      readonly title: string
      readonly body: ReactNode
      readonly confirmLabel: string
      readonly tone?: 'destructive'
      readonly icon?: ReactNode
      readonly act: () => Promise<string | null>
      /** Turns this dialog's refusal into something an agent can be handed. */
      readonly trouble?: (said: string) => GitTrouble
    }

export const GitPane = () => {
  const mount = useMount()
  const view = mount?.view.kind === 'git' ? mount.view : null
  // Everything below is repository-scoped state — commits, refs, selection,
  // the search — so a pane re-pointed at another root remounts whole rather
  // than showing the old repository's rows until the new answers land.
  return <GitPaneBody key={view?.root ?? ''} root={view?.root ?? null} />
}

const GitPaneBody = ({ root }: { root: string | null }) => {
  const store = useStore()
  const snapshot = useSnapshot()
  const session = useActiveSession()
  const folder = root?.split('/').filter(Boolean).at(-1) ?? ''
  /* The strip puts a repository's whole path on screen, which for a checkout
     under home means the machine's username — in every screenshot and every
     screen-share of this pane. Written the way the rest of the app writes a
     path: `~/work/storefront`. Only the label changes; `root` itself stays
     absolute, because that is what git is asked with. */
  const shown = root === null ? '' : shortPath(root, snapshot.home)

  const [commits, setCommits] = useState<readonly GitLogCommit[]>([])
  const [hasMore, setHasMore] = useState(false)
  const [loading, setLoading] = useState(true)
  const [refsSummary, setRefsSummary] = useState<GitRefsSummary | null>(null)
  const [isRepo, setIsRepo] = useState<boolean | null>(null)
  const [dirtyCount, setDirtyCount] = useState(0)
  const [worktrees, setWorktrees] = useState<readonly GitWorktree[]>([])
  const [scope, setScope] = useState<GitLogScope>('all')
  const [query, setQuery] = useState('')
  const [needle, setNeedle] = useState('')
  const [search, setSearch] = useState<GitLogSearch>('message')
  const [selected, setSelected] = useState<string | null>(null)
  const [selectedProvenance, setSelectedProvenance] = useState<import('@harnessdesk/protocol').CommitProvenance | undefined>()
  const [railOpen, setRailOpen] = useState(true)
  const [railError, setRailError] = useState<string | null>(null)
  const [branchAt, setBranchAt] = useState<string | null>(null)
  const [tick, setTick] = useState(0)
  const historyKey = JSON.stringify([root, scope, needle, search, tick])
  const [loadedFor, setLoadedFor] = useState('')
  const provenance = useProvenanceBatch(root, loadedFor === historyKey ? commits.map((commit) => commit.sha) : [], historyKey)

  // One generation per reload: a page arriving for a root or query the pane
  // has moved past must fall on the floor, not into the table.
  const gen = useRef(0)
  const loadingMore = useRef(false)

  const request = useMemo(() => store.transport.request.bind(store.transport), [store])

  useEffect(() => {
    const timer = window.setTimeout(() => setNeedle(query.trim()), 250)
    return () => window.clearTimeout(timer)
  }, [query])

  useEffect(() => {
    if (!root) return
    const mine = (gen.current += 1)
    setLoading(true)
    void Promise.all([
      request('git/log', { root, scope, limit: PAGE, ...(needle ? { query: needle, search } : {}) }).catch(
        (): HistoryPage => ({ commits: [], hasMore: false }),
      ),
      request('git/refs', { root }).catch(() => null),
      request('git/status', { root }).catch(() => null),
      // A repository with one checkout is the common case, so this stays
      // quiet rather than empty-stating: the rail's section and the toolbar
      // badge both simply do not appear until there is a second one.
      request('git/worktrees', { root }).catch((): readonly GitWorktree[] => []),
    ]).then(([page, refsResult, status, checkouts]) => {
      if (gen.current !== mine) return
      setLoadedFor(JSON.stringify([root, scope, needle, search, tick]))
      setCommits(page.commits)
      setHasMore(page.hasMore)
      setRefsSummary(refsResult)
      setIsRepo(refsResult !== null)
      setDirtyCount(distinctPaths(status?.files))
      setWorktrees(checkouts)
      // The banner is a claim about the tree, so every re-read is allowed to
      // withdraw it: a terminal or another agent can settle the conflicts we
      // announced, and a strip that outlives them offers to send an agent
      // after a problem that is over. Only a status that was actually read
      // may do the withdrawing — a failed read is "I do not know", and
      // treating it as "resolved" would drop a real warning on a hiccup.
      if (status) {
        const left = status.files.filter((file) => file.status === 'conflicted').map((file) => file.path)
        setConflicted((current) =>
          current === null ? null : left.length === 0 ? null : { ...current, conflicts: left },
        )
      }
      setLoading(false)
    })
  }, [root, scope, needle, search, tick, request])

  // The tree just changed under the pane in the two moments that matter:
  // the agent stopped working, and the window came back. Both re-read.
  const busy = session?.status.type === 'active'
  const wasBusy = useRef(busy)
  useEffect(() => {
    if (wasBusy.current && !busy) setTick((value) => value + 1)
    wasBusy.current = busy
  }, [busy])
  useEffect(() => {
    const back = (): void => {
      if (document.visibilityState === 'visible') setTick((value) => value + 1)
    }
    window.addEventListener('focus', back)
    return () => window.removeEventListener('focus', back)
  }, [])

  const loadMore = useCallback((): void => {
    if (!root || !hasMore || loadingMore.current) return
    loadingMore.current = true
    const mine = gen.current
    void request('git/log', {
      root,
      scope,
      skip: commits.length,
      limit: PAGE,
      ...(needle ? { query: needle, search } : {}),
    })
      .then((page) => {
        if (gen.current !== mine) return
        const known = new Set(commits.map((commit) => commit.sha))
        setCommits([...commits, ...page.commits.filter((commit) => !known.has(commit.sha))])
        setHasMore(page.hasMore)
      })
      .catch(() => {})
      .finally(() => {
        loadingMore.current = false
      })
  }, [root, scope, needle, search, hasMore, commits, request])

  // The graph only means something over the unbroken walk; search results
  // are scattered commits, so they list flat, the way SourceTree's own
  // search view drops the graph.
  const searching = needle.length > 0
  const rows = useMemo(() => (searching ? [] : layoutGraph(commits)), [commits, searching])
  const lanes = useMemo(
    () => Math.min(LANE_CAP, rows.reduce((max, row) => Math.max(max, row.width), 1)),
    [rows],
  )

  const remoteNames = useMemo(
    () => new Set((refsSummary?.remotes ?? []).map((remote) => remote.remote)),
    [refsSummary],
  )

  // ------------------------------------------------------------- selection

  const listRef = useRef<HTMLDivElement>(null)
  const [scrollTop, setScrollTop] = useState(0)
  const [viewport, setViewport] = useState(360)

  const select = useCallback((sha: string | null): void => {
    setSelected(sha)
    setSelectedProvenance(sha === null ? undefined : provenance.values.get(sha))
  }, [provenance.values])

  const scrollToIndex = useCallback((index: number): void => {
    const list = listRef.current
    if (!list) return
    const top = index * ROW
    if (top < list.scrollTop + ROW || top > list.scrollTop + list.clientHeight - ROW * 2) {
      list.scrollTop = Math.max(0, top - list.clientHeight / 3)
    }
  }, [])

  /**
   * Lands on a commit wherever it is: on screen, deeper in the walk — paged
   * in quietly up to a cap — or beyond it, which is said plainly rather
   * than scrolled toward forever.
   */
  const jumpTo = useCallback(
    (sha: string): void => {
      if (!root) return
      const at = commits.findIndex((commit) => commit.sha === sha)
      if (at !== -1) {
        select(sha)
        scrollToIndex(at)
        return
      }
      const mine = gen.current
      const walk = async (): Promise<void> => {
        let all = [...commits]
        let more = hasMore
        while (more && all.length < JUMP_CAP) {
          const page: HistoryPage = await request('git/log', {
            root,
            scope,
            skip: all.length,
            limit: PAGE,
            ...(needle ? { query: needle, search } : {}),
          })
          if (gen.current !== mine) return
          all = [...all, ...page.commits]
          more = page.hasMore
          if (page.commits.some((commit) => commit.sha === sha)) break
          if (page.commits.length === 0) break
        }
        if (gen.current !== mine) return
        setCommits(all)
        setHasMore(more)
        const index = all.findIndex((commit) => commit.sha === sha)
        if (index === -1) {
          // Still worth opening: the detail reads any commit by address.
          select(sha)
          store.notice('info', 'That commit is deeper than the loaded history; its details are open below.')
          return
        }
        select(sha)
        requestAnimationFrame(() => scrollToIndex(index))
      }
      void walk().catch(() => {})
    },
    [root, commits, hasMore, scope, needle, search, request, select, scrollToIndex, store],
  )

  // ------------------------------------------------------------ interactions

  const menu = useContextMenu()
  const [menuSha, setMenuSha] = useState<string | null>(null)
  const menuCommit = commits.find((commit) => commit.sha === menuSha) ?? null

  const railMenu = useContextMenu()
  const [railTarget, setRailTarget] = useState<RailTarget | null>(null)
  const onRailMenu = useCallback(
    (target: RailTarget, event: ReactMouseEvent): void => {
      setRailTarget(target)
      railMenu.open(event)
    },
    [railMenu],
  )

  const compose = (text: string): void => {
    window.dispatchEvent(new CustomEvent('harnessdesk:compose', { detail: text }))
  }

  const checkout = useCallback(
    async (branch: string): Promise<void> => {
      if (!root) return
      setRailError(null)
      const ok = await store.checkoutBranch(root, branch)
      if (ok) setTick((value) => value + 1)
      else setRailError(`Could not switch to ${branch}. The working tree may have uncommitted changes.`)
    },
    [root, store],
  )

  // ----------------------------------------------------------------- verbs

  const [working, setWorking] = useState<string | null>(null)
  const [dialog, setDialog] = useState<DialogState | null>(null)
  /**
   * Conflicts a verb left behind, kept on screen rather than in a toast: the
   * tree is mid-merge until someone finishes it, and a notice that fades is
   * the wrong shape for a state that does not.
   */
  const [conflicted, setConflicted] = useState<GitTrouble | null>(null)
  const [asking, setAsking] = useState<GitTrouble | null>(null)

  /** Every mutation ends here: the table, the refs and the sidebar re-read. */
  const refresh = useCallback((): void => {
    setTick((value) => value + 1)
    void store.loadWorkspaces()
  }, [store])

  const closeDialog = useCallback(
    (done: boolean): void => {
      setDialog(null)
      if (done) refresh()
    },
    [refresh],
  )

  /**
   * Runs one toolbar or menu verb: says what it is doing while it runs,
   * notices the summary or the refusal, and re-reads the repository. The
   * verbs themselves live in the host; this is just the reporting.
   */
  const verb = useCallback(
    (label: string, act: () => Promise<string | null>): void => {
      setWorking(label)
      void act()
        .then((summary) => {
          if (summary) store.notice('info', summary)
          refresh()
        })
        .catch((raised: unknown) =>
          store.notice('error', raised instanceof Error ? raised.message : String(raised)),
        )
        .finally(() => setWorking(null))
    },
    [store, refresh],
  )

  /**
   * A merge-like verb's outcome. Conflicts are state, not failure: warn in
   * the verb's own words and open the surface that shows the files.
   */
  const settled = useCallback(
    (attempt: string, outcome: GitMergeOutcome): string | null => {
      if (outcome.conflicts.length > 0) {
        store.notice('warning', outcome.summary)
        // Open, never toggle: a Changes panel already showing must stay.
        store.openDetailsTab('changes')
        setConflicted({
          attempt,
          root: root!,
          said: outcome.summary,
          posture: 'conflicted',
          conflicts: outcome.conflicts,
          branch: refsSummary?.branch ?? null,
        })
        return null
      }
      setConflicted(null)
      return outcome.summary
    },
    [store, root, refsSummary],
  )

  const currentRef = refsSummary?.branches.find((branch) => branch.current) ?? null
  const branchName = refsSummary?.branch ?? null
  const headSha = refsSummary?.headSha ?? null

  const doPull = (): void =>
    verb('Pulling…', async () => settled('pull', await request('git/pull', { root: root! })))
  const doPush = (): void => verb('Pushing…', async () => (await request('git/push', { root: root! })).summary)
  const doFetch = (): void => verb('Fetching…', async () => (await request('git/fetch', { root: root! })).summary)
  const doMergeRef = (ref: string): void =>
    verb('Merging…', async () => settled(`merge of ${ref}`, await request('git/merge', { root: root!, ref })))
  const doRebaseOnto = (onto: string, label: string): void =>
    setDialog({
      kind: 'confirm',
      title: `Rebase ${branchName ?? 'the current branch'} onto ${label}`,
      icon: <BranchIcon size={16} />,
      body: `Replays this branch's commits on top of ${label}, rewriting them. A conflict aborts the whole rebase and leaves everything as it is now.`,
      confirmLabel: 'Rebase',
      act: async () => (await request('git/rebase', { root: root!, onto })).summary,
      // A rebase this app refuses is the one refusal an agent can always act
      // on: nothing changed, and the work is exactly "do it and settle it".
      trouble: (said) => ({
        attempt: `rebase of ${branchName ?? 'the current branch'} onto ${label}`,
        root: root!,
        said,
        posture: 'refused',
        branch: branchName,
      }),
    })
  const doDetachAt = (sha: string, label: string): void =>
    setDialog({
      kind: 'confirm',
      title: `Check out ${label}`,
      icon: <BranchIcon size={16} />,
      body: 'This detaches HEAD — you are reading an old state of the tree, on no branch. Switch back to a branch to keep working.',
      confirmLabel: 'Check out',
      act: async () => {
        await request('git/checkoutCommit', { root: root!, sha })
        return `Checked out ${label}; HEAD is detached.`
      },
    })
  const doDiffAgainst = (to: string): void => setDialog({ kind: 'diffRange', from: 'HEAD', to })
  const doPullRequest = (branch: string): void =>
    verb('Opening the compare page…', async () => {
      const { url } = await request('git/pullRequestUrl', { root: root!, branch })
      if (!url) return 'The remote is not a forge this can open a pull request on.'
      openExternal(url)
      return null
    })
  /**
   * Locking a worktree is one gesture from the rail — it is reversible, and
   * the reason git can carry is offered by the manager, not demanded here.
   */
  const doWorktreeLock = (entry: GitWorktree, locked: boolean): void =>
    verb(locked ? 'Locking…' : 'Unlocking…', async () => {
      await request('git/worktreeLock', { root: root!, path: entry.path, locked })
      const name = entry.path.split('/').filter(Boolean).at(-1) ?? entry.path
      return locked ? `Locked ${name} against pruning.` : `Unlocked ${name}.`
    })

  /** Copying reads; it neither refreshes nor deserves a spinner. */
  const doCopy = (text: string, said: string): void => {
    void navigator.clipboard?.writeText(text)
    store.notice('info', said)
  }

  // ---------------------------------------------------------------- sizing

  const frame = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(900)
  useEffect(() => {
    const element = frame.current
    if (!element) return
    const observer = new ResizeObserver((entries) => {
      const box = entries[0]?.contentRect
      if (box) setWidth(box.width)
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [])
  const fit = fits(width)

  useEffect(() => {
    const list = listRef.current
    if (!list) return
    const observer = new ResizeObserver(() => setViewport(list.clientHeight))
    observer.observe(list)
    return () => observer.disconnect()
  }, [isRepo])

  // ------------------------------------------------------------------ rows

  const total = commits.length
  const first = Math.max(0, Math.floor(scrollTop / ROW) - OVERSCAN)
  const last = Math.min(total, Math.ceil((scrollTop + viewport) / ROW) + OVERSCAN)
  // What the graph would like, before anyone drags it.
  const wanted = searching ? 0 : Math.min(lanes, LANE_CAP) * LANE_W + GUTTER_PAD
  const chosen = snapshot.listPrefs.gitColumns ?? {}
  const widths = {
    graph: chosen.graph ?? wanted,
    sha: chosen.sha ?? GIT_COLUMNS.sha.initial,
    date: chosen.date ?? GIT_COLUMNS.date.initial,
    author: chosen.author ?? GIT_COLUMNS.author.initial,
  }
  // A drag shows its result immediately and is written to preferences once,
  // on release: a resize is one decision, not one per pixel.
  const dragging = useRef<{ name: GitColumnName; from: number; at: number } | null>(null)
  const [drag, setDrag] = useState<{ name: GitColumnName; width: number } | null>(null)
  const live = drag ? { ...widths, [drag.name]: drag.width } : widths
  const gutter = searching ? 0 : live.graph

  /**
   * Which lanes fit. Chosen once for the loaded page — see `laneWindow` — so
   * a lane keeps its column while you scroll rather than sliding about.
   */
  const lanesFit = useMemo(
    () => laneWindow(rows, Math.max(0, Math.floor((gutter - GUTTER_PAD) / LANE_W))),
    [rows, gutter],
  )

  /**
   * Dragging a column edge. The width follows the pointer live and is written
   * to preferences once, on release: a column resize is one decision, not one
   * per pixel, and the round trip per pixel would be absurd.
   */
  const onGrab = useCallback(
    (name: GitColumnName, event: ReactPointerEvent): void => {
      event.preventDefault()
      const start = chosen[name] ?? (name === 'graph' ? wanted : GIT_COLUMNS[name].initial ?? 0)
      dragging.current = { name, from: start, at: event.clientX }
      setDrag({ name, width: start })
      event.currentTarget.setPointerCapture(event.pointerId)
    },
    [chosen, wanted],
  )

  const onDragMove = useCallback((event: ReactPointerEvent): void => {
    const held = dragging.current
    if (!held) return
    const next = clampColumn(held.name, held.from + (event.clientX - held.at))
    setDrag({ name: held.name, width: next })
  }, [])

  /** The keyboard's resize: same clamp, same write, no drag state to hold. */
  const onNudge = useCallback(
    (name: GitColumnName, to: number): void => {
      const width = clampColumn(name, to)
      store.setListPrefs({ gitColumns: { ...chosen, [name]: width } })
    },
    [chosen, store],
  )

  const onRelease = useCallback((): void => {
    const held = dragging.current
    dragging.current = null
    setDrag((current) => {
      if (held && current) {
        store.setListPrefs({ gitColumns: { ...chosen, [held.name]: current.width } })
      }
      return null
    })
  }, [chosen, store])

  const onScroll = useCallback((): void => {
    const list = listRef.current
    if (!list) return
    setScrollTop(list.scrollTop)
    if (list.scrollTop + list.clientHeight > list.scrollHeight - ROW * 30) loadMore()
  }, [loadMore])

  const onKeyDown = useCallback(
    (event: ReactKeyboardEvent): void => {
      if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
      event.preventDefault()
      const at = commits.findIndex((commit) => commit.sha === selected)
      const next = event.key === 'ArrowDown' ? Math.min(total - 1, at + 1) : Math.max(0, at === -1 ? 0 : at - 1)
      const commit = commits[next]
      if (commit) {
        select(commit.sha)
        scrollToIndex(next)
      }
    },
    [commits, selected, total, select, scrollToIndex],
  )

  if (!root) return null

  if (isRepo === false) {
    return (
      <>
        <ToolPaneHeader title={folder ? `History — ${folder}` : 'History'} subtitle={shown} />
        <EmptyState tight title="No repository" description="This folder is not a git repository, so there is no history to show." />
      </>
    )
  }

  return (
    <div className={styles.frame} ref={frame}>
      <ToolPaneHeader title={folder ? `History — ${folder}` : 'History'} subtitle={shown} hint={shown}>
        {fit.rail && (
          <Button
            variant={railOpen ? 'secondary' : 'ghost'}
            size="icon-sm"
            {...(railOpen ? { 'data-on': '' } : {})}
            onClick={() => setRailOpen((value) => !value)}
            title={railOpen ? 'Hide branches, tags and stashes' : 'Show branches, tags and stashes'}
            aria-label="Switch the refs rail"
          >
            <SidebarIcon size={14} />
          </Button>
        )}
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={() => setTick((value) => value + 1)}
          title="Read the repository again"
          aria-label="Refresh history"
        >
          <RefreshIcon size={13} />
        </Button>
      </ToolPaneHeader>

      <GitHistoryActionBar role="toolbar" aria-label="Repository actions">
        <ActionBtn
          icon={<CommitIcon size={15} />}
          label="Commit"
          badge={dirtyCount}
          words={fit.labels}
          busy={working !== null}
          disabled={dirtyCount === 0 ? 'The working tree is clean.' : false}
          title="Commit the working tree…"
          onClick={() => setDialog({ kind: 'commit' })}
        />
        <ActionBtn
          icon={<PullIcon size={15} />}
          label="Pull"
          badge={currentRef?.behind ?? 0}
          words={fit.labels}
          busy={working !== null}
          disabled={pullRefusal(currentRef)}
          title={currentRef?.upstream ? `Pull ${currentRef.upstream}` : 'Pull'}
          onClick={doPull}
        />
        <ActionBtn
          icon={<PushIcon size={15} />}
          label="Push"
          badge={currentRef?.ahead ?? 0}
          words={fit.labels}
          busy={working !== null}
          disabled={branchName ? false : 'HEAD is detached; there is no branch to push.'}
          title={
            currentRef?.upstream ? `Push to ${currentRef.upstream}` : 'Push — a first push sets the upstream'
          }
          onClick={doPush}
        />
        <ActionBtn
          icon={<FetchIcon size={15} />}
          label="Fetch"
          words={fit.labels}
          busy={working !== null}
          title="Fetch every remote"
          onClick={doFetch}
        />
        <Separator orientation="vertical" className={styles.actionSep} />
        <ActionBtn
          icon={<BranchIcon size={15} />}
          label="Branch"
          words={fit.labels}
          busy={working !== null}
          disabled={headSha ? false : 'No commits yet.'}
          title="New branch at HEAD…"
          onClick={() => headSha && setBranchAt(headSha)}
        />
        <ActionBtn
          icon={<MergeIcon size={15} />}
          label="Merge"
          words={fit.labels}
          busy={working !== null}
          disabled={branchName ? false : 'HEAD is detached; there is nothing to merge into.'}
          title="Merge into the current branch…"
          onClick={() => setDialog({ kind: 'merge' })}
        />
        <ActionBtn
          icon={<StashIcon size={15} />}
          label="Stash"
          badge={refsSummary?.stashes.length ?? 0}
          words={fit.labels}
          busy={working !== null}
          disabled={dirtyCount === 0 ? 'There is nothing to stash.' : false}
          title="Stash the working tree…"
          onClick={() => setDialog({ kind: 'stash' })}
        />
        <ActionBtn
          icon={<WorktreeIcon size={15} />}
          label="Worktrees"
          badge={Math.max(0, worktrees.length - 1)}
          words={fit.labels}
          busy={working !== null}
          title="Every folder this repository is checked out in…"
          onClick={() => setDialog({ kind: 'worktrees' })}
        />
        <span className={styles.space} />
        {working && <Text role="meta">{working}</Text>}
      </GitHistoryActionBar>
      <Separator />

      {conflicted && (
        <Alert tone="warning" className={styles.troubleBar} role="status">
          <Text role="muted" tone="warning" className={styles.troubleWhat}>{conflicted.said}</Text>
          <Button variant="secondary" size="sm" onClick={() => setAsking(conflicted)}>
            <AgentIcon size={13} />
            Ask an agent to fix this
          </Button>
          <Button variant="secondary" size="sm" onClick={() => store.openDetailsTab('changes')}>
            Open Changes
          </Button>
          <Button
            type="button"
            variant="ghost" size="icon-sm" className={styles.troubleClose}
            aria-label="Dismiss"
            title="Dismiss — the conflicts stay in the tree either way"
            onClick={() => setConflicted(null)}
          >
            <CrossIcon size={12} />
          </Button>
        </Alert>
      )}

      <GitHistoryFilters className={styles.tools}>
        <Segmented<GitLogScope>
          label="Which branches"
          options={[
            { value: 'all', label: 'All branches' },
            { value: 'head', label: 'Current' },
          ]}
          value={scope}
          onChange={(next) => { if (next) setScope(next) }}
        />
        {/* The field and the select that says what it matches are one
            control, so when the row wraps they move to the next line
            together rather than leaving the qualifier on its own. */}
        <span className={styles.searchGroup}>
          <Search
            className={styles.historySearch}
            value={query}
            placeholder="Search"
            label="Search history"
            onChange={setQuery}
            clear={{ label: 'Clear the search', onClick: () => setQuery('') }}
          />
          <NativeSelect
            variant="filled" className={styles.searchScope}
            value={search}
            aria-label="What the search matches"
            onChange={(event) => setSearch(event.target.value as GitLogSearch)}
          >
            <option value="message">Message</option>
            <option value="author">Author</option>
            <option value="sha">Commit id</option>
            <option value="file">File</option>
          </NativeSelect>
        </span>
        <span className={styles.space} />
        <Text role="meta" numeric className={styles.count}>
          {loading ? 'Reading…' : `${total.toLocaleString()}${hasMore ? '+' : ''} commits`}
        </Text>
      </GitHistoryFilters>
      <Separator />

      {provenance.error && <Note>Provenance could not be read. <Button variant="link" onClick={provenance.retry}>Retry provenance</Button></Note>}

      <div className={styles.body}>
        {fit.rail && railOpen && refsSummary && (
          <RefsRail
            refs={refsSummary}
            worktrees={worktrees}
            error={railError}
            onJump={jumpTo}
            onCheckout={(branch) => void checkout(branch)}
            onSelectSha={select}
            onMenu={onRailMenu}
          />
        )}

        <div className={styles.main}>
          {dirtyCount > 0 && !searching && (
            <Button type="button" variant="row" size="row" className={styles.dirtyRow} onClick={() => store.setDetailsTab('changes')}>
              <Dot state="limit" />
              Uncommitted changes · {dirtyCount} file{dirtyCount === 1 ? '' : 's'}
              <Text role="meta" className={styles.dirtyHint}>open Changes</Text>
            </Button>
          )}

          <GitHistoryTableHeader role="row" onPointerMove={onDragMove} onPointerUp={onRelease}>
            {!searching && (
              <HeadCell
                name="graph"
                width={gutter}
                hidden={lanesFit.hidden}
                dragging={drag?.name === 'graph'}
                onGrab={onGrab}
                onNudge={onNudge}
              />
            )}
            <span className={styles.headCell} data-flex="">
              <Text role="meta">Description</Text>
            </span>
            {fit.sha && (
              <HeadCell
                name="sha"
                width={live.sha}
                dragging={drag?.name === 'sha'}
                onGrab={onGrab}
                onNudge={onNudge}
              />
            )}
            {fit.date && (
              <HeadCell
                name="date"
                width={live.date}
                dragging={drag?.name === 'date'}
                onGrab={onGrab}
                onNudge={onNudge}
              />
            )}
            {fit.author && (
              <HeadCell
                name="author"
                width={live.author}
                dragging={drag?.name === 'author'}
                onGrab={onGrab}
                onNudge={onNudge}
              />
            )}
          </GitHistoryTableHeader>
          <Separator />

          <div
            className={styles.list}
            ref={listRef}
            onScroll={onScroll}
            onKeyDown={onKeyDown}
            tabIndex={0}
            role="listbox"
            aria-label="Commits"
          >
            {total === 0 && !loading ? (
              <EmptyState
                variant="inline"
                title={
                  searching
                    ? 'Nothing in the history matches that search.'
                    : 'No commits yet — the history starts with the first one.'
                }
              />
            ) : (
              <div style={{ height: total * ROW, position: 'relative' }}>
                {commits.slice(first, last).map((commit, offset) => {
                  const index = first + offset
                  const row = searching ? null : rows[index] ?? null
                  return (
                    <CommitRow
                      key={commit.sha}
                      commit={commit}
                      provenance={provenance.values.get(commit.sha) ?? null}
                      row={row}
                      top={index * ROW}
                      gutter={gutter}
                      lanes={lanesFit}
                      widths={live}
                      fit={fit}
                      remotes={remoteNames}
                      selected={selected === commit.sha}
                      now={Date.now()}
                      onSelect={() => select(selected === commit.sha ? null : commit.sha)}
                      onMenu={(event) => {
                        setMenuSha(commit.sha)
                        menu.open(event)
                      }}
                    />
                  )
                })}
              </div>
            )}
          </div>

          {selected && root && (
            <CommitDetail
              root={root}
              sha={selected}
              provenance={provenance.error ? selectedProvenance : provenance.values.get(selected)}
              wide={fit.sideBySide}
              remotes={remoteNames}
              onClose={() => select(null)}
              onJump={jumpTo}
            />
          )}
        </div>
      </div>

      <ContextMenu at={menuSha ? menu.at : null} label="Commit actions" onClose={menu.close}>
        {menuCommit && (
          <>
            <MenuLabel>{shortSha(menuCommit.sha)}</MenuLabel>
            <MenuItem
              icon={<BranchIcon size={14} />}
              label="Check out this commit…"
              hint="Detaches HEAD."
              onSelect={() => doDetachAt(menuCommit.sha, shortSha(menuCommit.sha))}
            />
            <MenuItem
              icon={<MergeIcon size={14} />}
              label={branchName ? `Merge into ${branchName}` : 'Merge into the current branch'}
              disabled={branchName ? false : 'HEAD is detached.'}
              onSelect={() => doMergeRef(menuCommit.sha)}
            />
            <MenuItem
              icon={<BranchIcon size={14} />}
              label={`Rebase ${branchName ?? 'the current branch'} onto here…`}
              disabled={branchName ? false : 'HEAD is detached.'}
              onSelect={() => doRebaseOnto(menuCommit.sha, shortSha(menuCommit.sha))}
            />
            <MenuSeparator />
            <MenuItem
              icon={<TagIcon size={14} />}
              label="Tag this commit…"
              onSelect={() => setDialog({ kind: 'tag', at: menuCommit.sha })}
            />
            <MenuItem
              icon={<BranchIcon size={14} />}
              label="Create branch here…"
              onSelect={() => setBranchAt(menuCommit.sha)}
            />
            <MenuSeparator />
            <MenuItem
              icon={<ResetIcon size={14} />}
              label={`Reset ${branchName ?? 'the branch'} to this commit…`}
              disabled={branchName ? false : 'HEAD is detached.'}
              onSelect={() => setDialog({ kind: 'reset', to: menuCommit.sha, subject: menuCommit.subject })}
            />
            <MenuItem
              icon={<CommitIcon size={14} />}
              label="Revert this commit"
              hint="A new commit that undoes it."
              onSelect={() =>
                verb('Reverting…', async () =>
                  settled(
                    `revert of ${shortSha(menuCommit.sha)}`,
                    await request('git/revert', { root, sha: menuCommit.sha }),
                  ),
                )
              }
            />
            <MenuItem
              icon={<CommitIcon size={14} />}
              label="Cherry-pick onto the current branch"
              disabled={menuCommit.parents.length > 1 ? 'A merge commit does not cherry-pick.' : false}
              onSelect={() =>
                verb('Cherry-picking…', async () =>
                  settled(
                    `cherry-pick of ${shortSha(menuCommit.sha)}`,
                    await request('git/cherryPick', { root, sha: menuCommit.sha }),
                  ),
                )
              }
            />
            <MenuItem
              icon={<CopyIcon size={14} />}
              label="Copy as a patch"
              hint="The mail-format text git am takes."
              onSelect={() =>
                verb('Building the patch…', async () => {
                  const { patch } = await request('git/patch', { root, sha: menuCommit.sha })
                  await navigator.clipboard?.writeText(patch)
                  return `Copied ${shortSha(menuCommit.sha)} as a patch.`
                })
              }
            />
            <MenuSeparator />
            <MenuItem
              icon={<CopyIcon size={14} />}
              label="Copy commit id"
              onSelect={() => void navigator.clipboard?.writeText(menuCommit.sha)}
            />
            <MenuItem
              icon={<CopyIcon size={14} />}
              label="Copy message"
              onSelect={() => void navigator.clipboard?.writeText(menuCommit.subject)}
            />
            <MenuSeparator />
            <MenuItem
              icon={<CommitIcon size={14} />}
              label="Ask the agent to revert this commit"
              hint="Puts the request in the composer; you send it."
              disabled={session ? false : 'Open a conversation first.'}
              onSelect={() =>
                compose(
                  `Please revert commit ${shortSha(menuCommit.sha)} — "${menuCommit.subject}" — and tell me the new commit hash.`,
                )
              }
            />
            <MenuItem
              icon={<CommitIcon size={14} />}
              label="Ask the agent to cherry-pick it"
              hint="Onto the current branch, in the composer."
              disabled={session ? false : 'Open a conversation first.'}
              onSelect={() =>
                compose(
                  `Please cherry-pick commit ${shortSha(menuCommit.sha)} ("${menuCommit.subject}") onto the current branch and tell me how it went.`,
                )
              }
            />
          </>
        )}
      </ContextMenu>

      <ContextMenu at={railTarget ? railMenu.at : null} label="Ref actions" onClose={railMenu.close}>
        {railTarget?.kind === 'branch' && (
          <BranchMenu
            branch={railTarget.branch}
            current={branchName}
            onCheckout={() => void checkout(railTarget.branch.name)}
            onMerge={() => doMergeRef(railTarget.branch.name)}
            onRebase={() => doRebaseOnto(railTarget.branch.name, railTarget.branch.name)}
            onPull={doPull}
            onPush={doPush}
            onDiff={() => doDiffAgainst(railTarget.branch.name)}
            onRename={() => setDialog({ kind: 'rename', from: railTarget.branch.name })}
            onDelete={() => setDialog({ kind: 'deleteBranch', name: railTarget.branch.name })}
            onCopy={() => doCopy(railTarget.branch.name, `Copied “${railTarget.branch.name}”.`)}
            onPullRequest={() => doPullRequest(railTarget.branch.name)}
            onReview={() => setDialog({ kind: 'review', branch: railTarget.branch.name })}
          />
        )}
        {railTarget?.kind === 'remote' && (
          <>
            <MenuLabel>{`${railTarget.remote}/${railTarget.name}`}</MenuLabel>
            <MenuItem
              icon={<BranchIcon size={14} />}
              label={`Check out ${railTarget.name}`}
              hint="As a local branch tracking it."
              onSelect={() => void checkout(railTarget.name)}
            />
            <MenuItem
              icon={<MergeIcon size={14} />}
              label={branchName ? `Merge into ${branchName}` : 'Merge into the current branch'}
              disabled={branchName ? false : 'HEAD is detached.'}
              onSelect={() => doMergeRef(`${railTarget.remote}/${railTarget.name}`)}
            />
            <MenuItem
              icon={<BranchIcon size={14} />}
              label={`Rebase ${branchName ?? 'the current branch'} onto ${railTarget.remote}/${railTarget.name}…`}
              disabled={branchName ? false : 'HEAD is detached.'}
              onSelect={() =>
                doRebaseOnto(
                  `${railTarget.remote}/${railTarget.name}`,
                  `${railTarget.remote}/${railTarget.name}`,
                )
              }
            />
            <MenuItem
              icon={<DiffIcon size={14} />}
              label="Diff against current"
              onSelect={() => doDiffAgainst(`${railTarget.remote}/${railTarget.name}`)}
            />
            <MenuSeparator />
            <MenuItem
              icon={<CopyIcon size={14} />}
              label="Copy branch name"
              onSelect={() =>
                doCopy(
                  `${railTarget.remote}/${railTarget.name}`,
                  `Copied “${railTarget.remote}/${railTarget.name}”.`,
                )
              }
            />
          </>
        )}
        {railTarget?.kind === 'tag' && (
          <>
            <MenuLabel>{railTarget.tag.name}</MenuLabel>
            <MenuItem
              icon={<BranchIcon size={14} />}
              label="Check out this tag…"
              hint="Detaches HEAD."
              onSelect={() => doDetachAt(railTarget.tag.sha, railTarget.tag.name)}
            />
            <MenuItem
              icon={<BranchIcon size={14} />}
              label="Create branch here…"
              onSelect={() => setBranchAt(railTarget.tag.sha)}
            />
            <MenuItem
              icon={<DiffIcon size={14} />}
              label="Diff against current"
              onSelect={() => doDiffAgainst(railTarget.tag.name)}
            />
            <MenuSeparator />
            <MenuItem
              icon={<TrashIcon size={14} />}
              label="Delete tag…"
              danger
              onSelect={() =>
                setDialog({
                  kind: 'confirm',
                  title: `Delete the tag ${railTarget.tag.name}`,
                  icon: <TagIcon size={16} />,
                  tone: 'destructive',
                  body: 'The commit it marks stays; only the name goes. A copy already pushed to a remote keeps existing there.',
                  confirmLabel: 'Delete tag',
                  act: async () => {
                    await request('git/deleteTag', { root, name: railTarget.tag.name })
                    return `Deleted the tag ${railTarget.tag.name}.`
                  },
                })
              }
            />
            <MenuSeparator />
            <MenuItem
              icon={<CopyIcon size={14} />}
              label="Copy tag name"
              onSelect={() => doCopy(railTarget.tag.name, `Copied “${railTarget.tag.name}”.`)}
            />
          </>
        )}
        {railTarget?.kind === 'worktree' && (
          <>
            <MenuLabel>{railTarget.worktree.path.split('/').filter(Boolean).at(-1) ?? ''}</MenuLabel>
            <MenuItem
              icon={<FolderIcon size={14} />}
              label="Open as the workspace"
              hint="Switches this window to that checkout."
              disabled={
                railTarget.worktree.isCurrent
                  ? 'You are already in it.'
                  : railTarget.worktree.prunable
                    ? 'Its folder is gone.'
                    : false
              }
              onSelect={() => void store.openWorkspace(railTarget.worktree.path)}
            />
            <MenuItem
              icon={<FileIcon size={14} />}
              label="Reveal in Finder"
              disabled={railTarget.worktree.prunable ? 'Its folder is gone.' : false}
              onSelect={() => void store.revealWorkspace(railTarget.worktree.path)}
            />
            <MenuSeparator />
            {railTarget.worktree.locked ? (
              <MenuItem
                icon={<UnlockIcon size={14} />}
                label="Unlock"
                hint={railTarget.worktree.locked.reason || undefined}
                onSelect={() => doWorktreeLock(railTarget.worktree, false)}
              />
            ) : (
              <MenuItem
                icon={<LockIcon size={14} />}
                label="Lock against pruning"
                disabled={railTarget.worktree.isMain ? 'The main checkout is never pruned.' : false}
                onSelect={() => doWorktreeLock(railTarget.worktree, true)}
              />
            )}
            <MenuItem
              icon={<MoveFolderIcon size={14} />}
              label="Move…"
              disabled={railTarget.worktree.isMain ? 'The main checkout does not move.' : false}
              onSelect={() =>
                setDialog({ kind: 'worktrees', focus: { path: railTarget.worktree.path, intent: 'move' } })
              }
            />
            <MenuItem
              icon={<TrashIcon size={14} />}
              label="Remove…"
              danger
              disabled={railTarget.worktree.isMain ? 'The main checkout cannot be removed.' : false}
              onSelect={() =>
                setDialog({ kind: 'worktrees', focus: { path: railTarget.worktree.path, intent: 'remove' } })
              }
            />
            <MenuSeparator />
            <MenuItem
              icon={<CopyIcon size={14} />}
              label="Copy path"
              onSelect={() => doCopy(railTarget.worktree.path, 'Copied the path.')}
            />
            <MenuItem
              icon={<WorktreeIcon size={14} />}
              label="Manage worktrees…"
              onSelect={() => setDialog({ kind: 'worktrees' })}
            />
          </>
        )}
        {railTarget?.kind === 'stash' && (
          <>
            <MenuLabel>{railTarget.stash.message || railTarget.stash.ref}</MenuLabel>
            <MenuItem
              icon={<StashIcon size={14} />}
              label="Apply"
              hint="Puts the work back; the stash stays."
              onSelect={() =>
                verb('Applying the stash…', async () =>
                  settled(
                    'stash apply',
                    await request('git/stashApply', { root, ref: railTarget.stash.ref }),
                  ),
                )
              }
            />
            <MenuItem
              icon={<StashIcon size={14} />}
              label="Apply and drop"
              hint="Kept anyway if the apply conflicts."
              onSelect={() =>
                verb('Applying the stash…', async () =>
                  settled(
                    'stash apply',
                    await request('git/stashApply', { root, ref: railTarget.stash.ref, pop: true }),
                  ),
                )
              }
            />
            <MenuSeparator />
            <MenuItem
              icon={<TrashIcon size={14} />}
              label="Drop…"
              danger
              onSelect={() =>
                setDialog({
                  kind: 'confirm',
                  title: 'Drop this stash',
                  icon: <StashIcon size={16} />,
                  tone: 'destructive',
                  body: `“${railTarget.stash.message || railTarget.stash.ref}” is discarded for good — the work it holds is nowhere else.`,
                  confirmLabel: 'Drop stash',
                  act: async () => {
                    await request('git/stashDrop', { root, ref: railTarget.stash.ref })
                    return 'Dropped the stash.'
                  },
                })
              }
            />
          </>
        )}
      </ContextMenu>

      {branchAt && root && (
        <CreateBranch
          root={root}
          at={branchAt}
          onDone={(created) => {
            setBranchAt(null)
            if (created) refresh()
          }}
        />
      )}

      {dialog?.kind === 'commit' && <CommitDialog root={root} onDone={closeDialog} />}
      {dialog?.kind === 'worktrees' && (
        <WorktreeDialog
          root={root}
          {...(dialog.focus ? { focus: dialog.focus } : {})}
          onAdd={() => setDialog({ kind: 'worktreeAdd' })}
          onDone={closeDialog}
        />
      )}
      {dialog?.kind === 'worktreeAdd' && (
        <AddWorktreeDialog
          root={root}
          refs={refsSummary}
          onDone={(made) => {
            // Back to the list it came from — unless the new one was opened,
            // which switched workspace and took this pane's root with it.
            if (made) refresh()
            setDialog({ kind: 'worktrees' })
          }}
        />
      )}
      {dialog?.kind === 'merge' && refsSummary && (
        <MergeDialog root={root} refs={refsSummary} preselect={dialog.preselect} onDone={closeDialog} />
      )}
      {dialog?.kind === 'rename' && <RenameBranchDialog root={root} from={dialog.from} onDone={closeDialog} />}
      {dialog?.kind === 'deleteBranch' && (
        <DeleteBranchDialog root={root} name={dialog.name} onDone={closeDialog} />
      )}
      {dialog?.kind === 'tag' && <TagDialog root={root} at={dialog.at} onDone={closeDialog} />}
      {dialog?.kind === 'reset' && branchName && (
        <ResetDialog root={root} to={dialog.to} subject={dialog.subject} branch={branchName} onDone={closeDialog} />
      )}
      {dialog?.kind === 'stash' && <StashDialog root={root} onDone={closeDialog} />}
      {dialog?.kind === 'diffRange' && (
        <DiffRangeDialog root={root} from={dialog.from} to={dialog.to} onDone={() => setDialog(null)} />
      )}
      {dialog?.kind === 'review' && root && (
        <FrontDoor
          context={{ kind: 'branch', root, branch: dialog.branch }}
          onClose={() => closeDialog(false)}
          onStarted={(execution) => {
            store.openGoal(execution.goal)
            closeDialog(false)
          }}
        />
      )}
      {dialog?.kind === 'confirm' && (
        <ConfirmDialog
          title={dialog.title}
          body={dialog.body}
          confirmLabel={dialog.confirmLabel}
          tone={dialog.tone}
          icon={dialog.icon}
          act={dialog.act}
          {...(dialog.trouble ? { trouble: dialog.trouble } : {})}
          onAsk={(raised) => {
            // One dialog at a time: the refusal hands over to the ask, it
            // does not sit behind it. Nothing is lost — the refusal's words
            // are the first thing the prompt quotes.
            setDialog(null)
            setAsking(raised)
          }}
          onDone={closeDialog}
        />
      )}

      {asking && (
        <AskAgentDialog
          trouble={asking}
          onDone={(started) => {
            setAsking(null)
            // The session took the screen; the conflicts it went to settle
            // are no longer this pane's to nag about.
            if (started) {
              setDialog(null)
              setConflicted(null)
            }
          }}
        />
      )}
    </div>
  )
}

/**
 * One column heading with the handle that resizes it. The handle sits on the
 * column's right edge and resizes that column; Description has none, because
 * it is the one that absorbs whatever the others give up.
 */
const HeadCell = ({
  name,
  width,
  hidden = 0,
  dragging,
  onGrab,
  onNudge,
}: {
  name: GitColumnName
  width: number
  /** Lanes the graph column is too narrow to draw, said rather than hidden. */
  hidden?: number
  dragging: boolean
  onGrab: (name: GitColumnName, event: ReactPointerEvent) => void
  /** The keyboard's way to the same widths, through the same clamp. */
  onNudge: (name: GitColumnName, to: number) => void
}) => {
  // The label shrinks and ellipsises with its column, so a narrow one still
  // says what it is. The count cannot shrink — it is three characters or it
  // is a lie — so it goes when the column is too narrow for even one lane,
  // which is also the point at which the column is simply off. The handle
  // carries the sentence either way.
  const missing =
    hidden > 0 ? `${hidden} more ${hidden === 1 ? 'lane' : 'lanes'} — widen this column to see them` : null
  return (
    <span className={styles.headCell} style={{ width }}>
      <Text role="meta" className={styles.headLabel}>{GIT_COLUMNS[name].label}</Text>
      {hidden > 0 && width >= LANE_W && (
        <Badge title={missing ?? undefined}>+{hidden}</Badge>
      )}
      {name === 'graph' && (
        <Separator orientation="vertical" className="pointer-events-none absolute right-0 top-0" />
      )}
      <ResizeHandle
        orientation="vertical"
        value={(width - GIT_COLUMNS[name].min) / (GIT_COLUMNS[name].max - GIT_COLUMNS[name].min)}
        min={0}
        max={1}
        onChange={(next) => onNudge(name, GIT_COLUMNS[name].min + next * (GIT_COLUMNS[name].max - GIT_COLUMNS[name].min))}
        className={styles.headGrip}
        {...(dragging ? { 'data-dragging': '' } : {})}
        {...(width < LANE_W ? { 'data-tight': '' } : {})}
        label={`Resize the ${GIT_COLUMNS[name].label} column`}
        aria-valuenow={width}
        aria-valuemin={GIT_COLUMNS[name].min}
        aria-valuemax={GIT_COLUMNS[name].max}
        title={missing ?? `Resize the ${GIT_COLUMNS[name].label} column`}
        onPointerDown={(event) => onGrab(name, event)}
        onKeyDown={(event) => {
          const step = event.shiftKey ? 24 : 4
          const to =
            event.key === 'ArrowLeft'
              ? width - step
              : event.key === 'ArrowRight'
                ? width + step
                : event.key === 'Home'
                  ? GIT_COLUMNS[name].min
                  : event.key === 'End'
                    ? GIT_COLUMNS[name].max
                    : null
          if (to === null) return
          event.preventDefault()
          onNudge(name, to)
        }}
      />
    </span>
  )
}

/** Files with anything uncommitted, each once: status lists a file staged and changed again twice, one entry a column (#31). */
const distinctPaths = (files: readonly { readonly path: string }[] | undefined): number =>
  new Set((files ?? []).map((file) => file.path)).size

/**
 * Why Pull cannot run for this branch, or false when it can. A branch whose
 * upstream was deleted on its remote still names it, and a pull from it can
 * only fail, so it says why rather than offering a button that errors. #98.
 */
const pullRefusal = (branch: GitBranchRef | null | undefined): string | false =>
  !branch?.upstream
    ? 'This branch tracks no remote branch.'
    : branch.gone
      ? // What it tracks can be a local branch as well, so the sentence names no remote.
        `The branch this one tracks, ${branch.upstream}, is gone.`
      : false

/** One toolbar verb: a glyph, its word when the pane is wide, and a count. */
const ActionBtn = ({
  icon,
  label,
  badge,
  words,
  busy,
  disabled,
  title,
  onClick,
}: {
  icon: ReactNode
  label: string
  badge?: number
  words: boolean
  busy: boolean
  disabled?: string | false
  title?: string
  onClick: () => void
}) => {
  const refusal = typeof disabled === 'string' ? disabled : undefined
  return (
    <RefusedAction reason={refusal}>
      <Button
        variant="ghost"
        size="sm"
        className={styles.actionLayout}
        disabled={busy || Boolean(disabled)}
        title={refusal ? undefined : (title ?? label)}
        aria-label={label}
        onClick={onClick}
      >
        {icon}
        {words && <span>{label}</span>}
        {badge !== undefined && badge > 0 && (
          <Badge>{badge > 99 ? '99+' : badge}</Badge>
        )}
      </Button>
    </RefusedAction>
  )
}

/** A local branch's menu — the SourceTree set, minus what the host refuses. */
const BranchMenu = ({
  branch,
  current,
  onCheckout,
  onMerge,
  onRebase,
  onPull,
  onPush,
  onDiff,
  onRename,
  onDelete,
  onCopy,
  onPullRequest,
  onReview,
}: {
  branch: GitBranchRef
  current: string | null
  onCheckout: () => void
  onMerge: () => void
  onRebase: () => void
  onPull: () => void
  onPush: () => void
  onDiff: () => void
  onRename: () => void
  onDelete: () => void
  onCopy: () => void
  onPullRequest: () => void
  onReview: () => void
}) => {
  const itself = branch.current
  return (
    <>
      <MenuLabel>{branch.name}</MenuLabel>
      <MenuItem
        icon={<BranchIcon size={14} />}
        label={`Check out ${branch.name}`}
        disabled={itself ? 'This branch is checked out.' : false}
        onSelect={onCheckout}
      />
      <MenuItem
        icon={<MergeIcon size={14} />}
        label={`Merge ${branch.name} into ${current ?? 'the current branch'}`}
        disabled={itself ? 'A branch does not merge into itself.' : current ? false : 'HEAD is detached.'}
        onSelect={onMerge}
      />
      <MenuItem
        icon={<BranchIcon size={14} />}
        label={`Rebase ${current ?? 'the current branch'} onto ${branch.name}…`}
        disabled={itself ? 'The branch is already here.' : current ? false : 'HEAD is detached.'}
        onSelect={onRebase}
      />
      <MenuSeparator />
      <MenuItem
        icon={<PullIcon size={14} />}
        label={branch.upstream ? `Pull ${branch.upstream}` : 'Pull'}
        disabled={!itself ? 'Check it out first.' : pullRefusal(branch)}
        onSelect={onPull}
      />
      <MenuItem
        icon={<PushIcon size={14} />}
        label={branch.upstream ? `Push to ${branch.upstream}` : 'Push'}
        disabled={!itself ? 'Check it out first.' : false}
        onSelect={onPush}
      />
      <MenuSeparator />
      <MenuItem
        icon={<DiffIcon size={14} />}
        label="Diff against current"
        disabled={itself ? 'This is the current branch.' : false}
        onSelect={onDiff}
      />
      <MenuSeparator />
      <MenuItem icon={<PencilIcon size={14} />} label="Rename…" onSelect={onRename} />
      <MenuItem
        icon={<TrashIcon size={14} />}
        label={`Delete ${branch.name}…`}
        danger
        disabled={itself ? 'This branch is checked out.' : false}
        onSelect={onDelete}
      />
      <MenuSeparator />
      <MenuItem icon={<CopyIcon size={14} />} label="Copy branch name" onSelect={onCopy} />
      <MenuItem
        icon={<PullRequestIcon size={14} />}
        label="Create pull request…"
        hint="On the branch's forge, in the browser."
        onSelect={onPullRequest}
      />
      <MenuSeparator />
      <MenuItem
        icon={<TeamIcon size={14} />}
        label="Review…"
        hint="Choose a shape and start a team on this branch."
        onSelect={onReview}
      />
    </>
  )
}

// ---------------------------------------------------------------- the rows

const CommitRow = ({
  commit,
  provenance,
  row,
  top,
  gutter,
  lanes,
  widths,
  fit,
  remotes,
  selected,
  now,
  onSelect,
  onMenu,
}: {
  commit: GitLogCommit
  provenance: import('@harnessdesk/protocol').CommitProvenance | null
  row: GraphRow | null
  top: number
  gutter: number
  lanes: LaneWindow
  widths: { sha: number; date: number; author: number }
  fit: ReturnType<typeof fits>
  remotes: ReadonlySet<string>
  selected: boolean
  now: number
  onSelect: () => void
  onMenu: (event: ReactMouseEvent) => void
}) => {
  const chips = refChips(commit.refs, remotes)
  const merge = commit.parents.length > 1
  return (
    <Button
      type="button"
      variant="row"
      size="content"
      bordered={false}
      cursor="default"
      className={styles.row}
      style={{ top, height: ROW, paddingRight: 'var(--hd-space-3)' }}
      {...(selected ? { 'data-selected': '' } : {})}
      {...(merge ? { 'data-merge': '' } : {})}
      role="option"
      aria-selected={selected}
      onClick={onSelect}
      onContextMenu={onMenu}
    >
      <span className={styles.gutter} style={{ width: gutter }}>
        {row && gutter > 0 && <GitGraph row={row} lanes={lanes} rowHeight={ROW} laneWidth={LANE_W} className={styles.graph} />}
      </span>
      <span className={styles.subject}>
        {chips.map((chip) => <RefChip key={`${chip.kind}-${chip.name}`} chip={chip} />)}
        <Text role={merge ? 'muted' : 'row'} className={styles.subjectText} title={commit.subject}>
          {commit.subject}
        </Text>
        <CommitSeatLabels value={provenance} />
      </span>
      {fit.sha && (
        <Text role="meta" className={styles.sha} style={{ width: widths.sha }}>
          <CodeText>{shortSha(commit.sha)}</CodeText>
        </Text>
      )}
      {fit.date && (
        <Text role="meta" numeric className={styles.date} style={{ width: widths.date }}>
          {commitDate(commit.authoredAt, now)}
        </Text>
      )}
      {fit.author && (
        <Text
          role="meta"
          className={styles.author}
          style={{ width: widths.author }}
          title={`${commit.author} <${commit.authorEmail}>`}
        >
          {commit.author}
        </Text>
      )}
    </Button>
  )
}


// ---------------------------------------------------------------- the rail

const RefsRail = ({
  refs,
  worktrees,
  error,
  onJump,
  onCheckout,
  onSelectSha,
  onMenu,
}: {
  refs: GitRefsSummary
  worktrees: readonly GitWorktree[]
  error: string | null
  onJump: (sha: string) => void
  onCheckout: (branch: string) => void
  onSelectSha: (sha: string) => void
  onMenu: (target: RailTarget, event: ReactMouseEvent) => void
}) => {
  const [filter, setFilter] = useState('')
  const [closed, setClosed] = useState<ReadonlySet<string>>(new Set())
  const needle = filter.trim().toLowerCase()

  const toggle = (key: string): void => {
    setClosed((current) => {
      const next = new Set(current)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  const matches = (name: string): boolean => needle.length === 0 || name.toLowerCase().includes(needle)
  const branches = refs.branches.filter((branch) => matches(branch.name))
  const tree = useMemo(() => branchTree(branches), [branches])
  const remotes = useMemo(() => {
    const map = new Map<string, { name: string; sha: string }[]>()
    for (const remote of refs.remotes) {
      if (!matches(`${remote.remote}/${remote.name}`)) continue
      const list = map.get(remote.remote) ?? []
      list.push({ name: remote.name, sha: remote.sha })
      map.set(remote.remote, list)
    }
    return map
  }, [refs.remotes, needle])
  const tags = refs.tags.filter((tag) => matches(tag.name))
  const stashes = refs.stashes.filter((stash) => matches(stash.message))
  // Only worth a section when there is more than one checkout: a repository
  // with a single worktree has no fact here the rest of the rail lacks.
  const checkouts =
    worktrees.length > 1
      ? worktrees.filter((entry) => matches(`${entry.branch ?? ''} ${entry.path}`))
      : []

  const track = (branch: GitBranchRef): string | null => {
    // The word the worktree rows already use for a branch that no longer resolves.
    if (branch.gone) return 'gone'
    if (branch.ahead === 0 && branch.behind === 0) return null
    return [branch.ahead > 0 ? `↑${branch.ahead}` : null, branch.behind > 0 ? `↓${branch.behind}` : null]
      .filter(Boolean)
      .join(' ')
  }

  const branchRow = (branch: GitBranchRef, label: string, indent: boolean) => (
    <Button
      key={branch.name}
      type="button" variant="row" size="row" className={styles.railRow}
      {...(indent ? { 'data-indent': '' } : {})}
      {...(branch.current ? { 'data-current': '' } : {})}
      title={`${branch.name} — click to find it, double-click to check it out`}
      onClick={() => onJump(branch.sha)}
      onDoubleClick={() => {
        if (!branch.current) onCheckout(branch.name)
      }}
      onContextMenu={(event) => onMenu({ kind: 'branch', branch }, event)}
    >
      <BranchIcon size={12} />
      <span className={styles.railName}>{label}</span>
      {branch.current && <Chip tone="brand" emphasis>HEAD</Chip>}
      {track(branch) && <Text role="meta" numeric className={styles.railTrack}>{track(branch)}</Text>}
    </Button>
  )

  return (
    <>
    <aside className={styles.rail} aria-label="Branches, remotes, tags and stashes">
      <Search
        className={styles.railSearch}
        value={filter}
        placeholder="Filter refs"
        label="Filter refs"
        onChange={setFilter}
      />
      {error && <ActionError className={styles.railError}>{error}</ActionError>}
      <div className={styles.railScroll}>
        <PopoverGroupLabel>Branches · {branches.length}</PopoverGroupLabel>
        {tree.map((entry) =>
          entry.kind === 'branch' ? (
            branchRow(entry.branch, entry.branch.name, false)
          ) : (
            <div key={`folder-${entry.name}`}>
              <Button type="button" variant="quiet" size="content" className={styles.railFolder} onClick={() => toggle(`b:${entry.name}`)}>
                <DisclosureChevron open={!closed.has(`b:${entry.name}`)} size="xs" />
                {entry.name}
                <Text role="meta" numeric className={styles.railCount}>{entry.branches.length}</Text>
              </Button>
              {!closed.has(`b:${entry.name}`) && entry.branches.map((branch) => branchRow(branch, inFolder(branch), true))}
            </div>
          ),
        )}

        {remotes.size > 0 && <PopoverGroupLabel>Remotes</PopoverGroupLabel>}
        {[...remotes.entries()].map(([remote, list]) => (
          <div key={`remote-${remote}`}>
            <Button type="button" variant="quiet" size="content" className={styles.railFolder} onClick={() => toggle(`r:${remote}`)}>
              <DisclosureChevron open={!closed.has(`r:${remote}`)} size="xs" />
              {remote}
              <Text role="meta" numeric className={styles.railCount}>{list.length}</Text>
            </Button>
            {!closed.has(`r:${remote}`) &&
              list.map((branch) => (
                <Button
                  key={`${remote}/${branch.name}`}
                  type="button" variant="row" size="row" className={styles.railRow}
                  data-indent=""
                  title={`${remote}/${branch.name} — click to find it`}
                  onClick={() => onJump(branch.sha)}
                  onContextMenu={(event) =>
                    onMenu({ kind: 'remote', remote, name: branch.name, sha: branch.sha }, event)
                  }
                >
                  <BranchIcon size={12} />
                  <span className={styles.railName}>{branch.name}</span>
                </Button>
              ))}
          </div>
        ))}

        {tags.length > 0 && <PopoverGroupLabel>Tags · {tags.length}</PopoverGroupLabel>}
        {tags.map((tag) => (
          <Button
            key={`tag-${tag.name}`}
            type="button" variant="row" size="row" className={styles.railRow}
            title={`${tag.name} — click to find the commit it marks`}
            onClick={() => onJump(tag.sha)}
            onContextMenu={(event) => onMenu({ kind: 'tag', tag }, event)}
          >
            <TagIcon size={12} />
            <span className={styles.railName}>{tag.name}</span>
          </Button>
        ))}

        {stashes.length > 0 && <PopoverGroupLabel>Stashes · {stashes.length}</PopoverGroupLabel>}
        {stashes.map((stash) => (
          <Button
            key={stash.ref}
            type="button" variant="row" size="row" className={styles.railRow}
            title={`${stash.ref} — click to read what it holds`}
            onClick={() => onSelectSha(stash.sha)}
            onContextMenu={(event) => onMenu({ kind: 'stash', stash }, event)}
          >
            <StashIcon size={12} />
            <span className={styles.railName}>{stash.message}</span>
          </Button>
        ))}

        {checkouts.length > 0 && <PopoverGroupLabel>Worktrees · {checkouts.length}</PopoverGroupLabel>}
        {checkouts.map((entry) => {
          const folder = entry.path.split('/').filter(Boolean).at(-1) ?? entry.path
          return (
            <Button
              key={entry.path}
              type="button" variant="row" size="row" className={styles.railRow}
              {...(entry.isCurrent ? { 'data-current': '' } : {})}
              title={`${entry.path} — click to find what it has checked out`}
              onClick={() => entry.head && onJump(entry.head)}
              onContextMenu={(event) => onMenu({ kind: 'worktree', worktree: entry }, event)}
            >
              <WorktreeIcon size={12} />
              <span className={styles.railName}>{entry.branch ?? folder}</span>
              {entry.isCurrent && <Chip tone="brand" emphasis>Here</Chip>}
              {entry.locked && <LockIcon size={10} />}
              {entry.prunable && <Text role="meta" className={styles.railTrack}>gone</Text>}
              {entry.dirty !== null && entry.dirty > 0 && (
                <Text role="meta" numeric className={styles.railTrack}>{entry.dirty}</Text>
              )}
            </Button>
          )
        })}
      </div>
    </aside>
    <Separator orientation="vertical" />
    </>
  )
}

// -------------------------------------------------------------- the detail

const CommitDetail = ({
  root,
  sha,
  provenance,
  wide,
  remotes,
  onClose,
  onJump,
}: {
  root: string
  sha: string
  provenance: import('@harnessdesk/protocol').CommitProvenance | null | undefined
  wide: boolean
  remotes: ReadonlySet<string>
  onClose: () => void
  onJump: (sha: string) => void
}) => {
  const store = useStore()
  const request = useMemo(() => store.transport.request.bind(store.transport), [store])
  const [detail, setDetail] = useState<GitCommitDetail | null>(null)
  const [failed, setFailed] = useState(false)
  const [file, setFile] = useState<string | null>(null)
  const [diffs, setDiffs] = useState<ReadonlyMap<string, string>>(new Map())
  const [fraction, setFraction] = useState(0.45)
  const dragging = useRef(false)
  const host = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let cancelled = false
    setDetail(null)
    setFailed(false)
    setFile(null)
    setDiffs(new Map())
    void request('git/commit', { root, sha })
      .then((result) => {
        if (cancelled) return
        setDetail(result)
        setFile(result.files[0]?.path ?? null)
      })
      .catch(() => {
        if (!cancelled) setFailed(true)
      })
    return () => {
      cancelled = true
    }
  }, [root, sha, request])

  useEffect(() => {
    if (!file || diffs.has(file)) return
    let cancelled = false
    void request('git/commitDiff', { root, sha, path: file })
      .then((result) => {
        if (!cancelled) setDiffs((current) => new Map(current).set(file, result.diff))
      })
      .catch(() => {
        if (!cancelled) setDiffs((current) => new Map(current).set(file, ''))
      })
    return () => {
      cancelled = true
    }
  }, [file, diffs, root, sha, request])

  // The divider between the table and this detail: a plain fraction drag,
  // clamped so neither side can be pushed into uselessness.
  const onDividerMove = useCallback((event: ReactPointerEvent<HTMLDivElement>): void => {
    if (!dragging.current) return
    const parent = host.current?.parentElement?.getBoundingClientRect()
    if (!parent) return
    const fromBottom = (parent.bottom - event.clientY) / parent.height
    setFraction(Math.min(0.75, Math.max(0.2, fromBottom)))
  }, [])

  const chips = detail ? refChips(detail.refs, remotes) : []
  const subject = detail?.message.split('\n')[0] ?? ''
  const body = detail?.message.split('\n').slice(1).join('\n').trim() ?? ''
  const absolute = (path: string): string => (path.startsWith('/') ? path : `${root}/${path}`)

  const card = detail && (
    <Card className={styles.detailCard}>
      <CardContent>
      <Text role="subject">{subject}</Text>
      {body.length > 0 && <Text as="p" role="muted" className={styles.bodyCopy}>{body}</Text>}
      {chips.length > 0 && (
        <div className={styles.cardChips}>
          {chips.map((chip) => <RefChip key={`${chip.kind}-${chip.name}`} chip={chip} />)}
        </div>
      )}
      <KeyValue className={styles.cardMeta}>
        <KeyValueRow label="Commit">
          <CodeText as="code">{detail.sha}</CodeText>
          <Button
            type="button"
            variant="ghost" size="icon-sm" className={styles.cardCopy}
            aria-label="Copy the commit id"
            title="Copy the commit id"
            onClick={() => void navigator.clipboard?.writeText(detail.sha)}
          >
            <CopyIcon size={12} />
          </Button>
        </KeyValueRow>
        {detail.parents.length > 0 && (
          <KeyValueRow label="Parents">
              {detail.parents.map((parent) => (
                <Button key={parent} type="button" variant="link" size="content" className={styles.parentLink} onClick={() => onJump(parent)}>
                  {shortSha(parent)}
                </Button>
              ))}
          </KeyValueRow>
        )}
        <KeyValueRow label="Author">
          {detail.author} &lt;{detail.authorEmail}&gt; ·{' '}
          {new Date(detail.authoredAt).toLocaleString(undefined, {
            dateStyle: 'medium',
            timeStyle: 'short',
          })}
        </KeyValueRow>
        {detail.committer !== detail.author && (
          <KeyValueRow label="Committer">{detail.committer}</KeyValueRow>
        )}
      </KeyValue>
      </CardContent>
    </Card>
  )

  const fileRow = (entry: GitCommitDetail['files'][number]) => (
    <Button
      key={entry.path}
      type="button"
      variant="row" size="row" className={styles.fileRow}
      {...(file === entry.path ? { 'data-selected': '' } : {})}
      title={entry.oldPath ? `${entry.oldPath} → ${entry.path}` : entry.path}
      onClick={() => setFile(wide ? entry.path : file === entry.path ? null : entry.path)}
    >
      <FileState state={entry.status as Parameters<typeof FileState>[0]['state']} />
      <span className={styles.filePath}>{ltr(entry.path)}</span>
      {entry.added === null ? (
        <ChangeStats binary />
      ) : (
        <ChangeStats added={entry.added} removed={entry.removed ?? 0} />
      )}
    </Button>
  )

  return (
    <GitHistoryCommitDetail className={styles.detail} style={{ flexBasis: `${fraction * 100}%` }} ref={host}>
      <Separator />
      <ResizeHandle
        orientation="horizontal"
        value={fraction}
        min={0.2}
        max={0.75}
        onChange={setFraction}
        className={styles.detailHandle}
        label="Resize the commit detail"
        onPointerDown={(event) => {
          event.preventDefault()
          event.currentTarget.setPointerCapture(event.pointerId)
          dragging.current = true
        }}
        onPointerMove={onDividerMove}
        onPointerUp={() => {
          dragging.current = false
        }}
        onPointerCancel={() => {
          dragging.current = false
        }}
      />
      <GitHistoryCommitDetailHeader>
        <CommitIcon size={13} />
        <Text role="meta"><CodeText as="code">{shortSha(sha)}</CodeText></Text>
        <Text role="row" className={styles.detailTitle}>{subject}</Text>
        <span className={styles.space} />
        <Button variant="ghost" size="icon-sm" aria-label="Close the commit" onClick={onClose}>
          <CrossIcon size={13} />
        </Button>
      </GitHistoryCommitDetailHeader>
      <Separator />

      {failed ? (
        <Note>Could not read that commit — it may have been rewritten away.</Note>
      ) : !detail ? (
        <Note>Reading the commit…</Note>
      ) : wide ? (
        <div className={styles.detailSplit}>
          <div className={styles.detailLeft}>
            {card}
            <CommitProvenance root={root} sha={sha} value={provenance} />
            <PopoverGroupLabel>
              {detail.files.length} file{detail.files.length === 1 ? '' : 's'}
            </PopoverGroupLabel>
            <GitHistoryCommitFileList>{detail.files.map(fileRow)}</GitHistoryCommitFileList>
          </div>
          <Separator orientation="vertical" />
          <div className={styles.detailRight}>
            {file ? (
              <>
                <PatchHeader className={styles.diffHead}>
                  <FileIcon size={12} />
                  <span className={styles.filePath}>{ltr(file)}</span>
                  <span className={styles.space} />
                  <Button variant="ghost" size="sm" className={styles.fileAction} onClick={() => store.openFile(absolute(file))}>
                    Open current version
                  </Button>
                </PatchHeader>
                {diffs.get(file) === undefined ? (
                  <Note>Reading the patch…</Note>
                ) : diffs.get(file) === '' ? (
                  <Note>No text patch — a binary file, or an empty change.</Note>
                ) : (
                  <GitHistoryDiffViewport>
                    <DiffView diff={diffs.get(file)!} />
                  </GitHistoryDiffViewport>
                )}
              </>
            ) : (
              <Note>Select a file to read its patch.</Note>
            )}
          </div>
        </div>
      ) : (
        <div className={styles.detailStack}>
          {card}
          <CommitProvenance root={root} sha={sha} value={provenance} />
          <PopoverGroupLabel>
            {detail.files.length} file{detail.files.length === 1 ? '' : 's'}
          </PopoverGroupLabel>
          {detail.files.map((entry) => (
            <div key={entry.path}>
              {fileRow(entry)}
              {file === entry.path &&
                (diffs.get(entry.path) === undefined ? (
                  <Note>Reading the patch…</Note>
                ) : diffs.get(entry.path) === '' ? (
                  <Note>No text patch — a binary file, or an empty change.</Note>
                ) : (
                  <GitHistoryInlinePatch>
                    <DiffView diff={diffs.get(entry.path)!} />
                  </GitHistoryInlinePatch>
                ))}
            </div>
          ))}
        </div>
      )}
    </GitHistoryCommitDetail>
  )
}

// ---------------------------------------------------------- create branch

const CreateBranch = ({
  root,
  at,
  onDone,
}: {
  root: string
  at: string
  onDone: (created: boolean) => void
}) => {
  const store = useStore()
  const request = useMemo(() => store.transport.request.bind(store.transport), [store])
  const [name, setName] = useState('')
  const [checkout, setCheckout] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const create = async (): Promise<void> => {
    if (!name.trim()) return
    setBusy(true)
    setError(null)
    try {
      await request('git/createBranch', { root, name: name.trim(), at, ...(checkout ? { checkout: true } : {}) })
      onDone(true)
    } catch (raised) {
      setError(raised instanceof Error ? raised.message : String(raised))
      setBusy(false)
    }
  }

  return (
    <Dialog
      title={`New branch at ${shortSha(at)}`}
      icon={<BranchIcon size={16} />}
      onClose={() => onDone(false)}
      footer={
        <>
          <Button variant="default" onClick={() => void create()} disabled={busy || !name.trim()}>
            {busy ? 'Creating…' : 'Create'}
          </Button>
          <Button variant="secondary" onClick={() => onDone(false)} disabled={busy}>
            Cancel
          </Button>
        </>
      }
    >
      <div className={styles.createBody}>
        <Input
          value={name}
          placeholder="branch-name"
          autoFocus
          spellCheck={false}
          aria-label="Branch name"
          onChange={(event) => setName(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') void create()
          }}
        />
        <div className={styles.createRow}>
          <Switch checked={checkout} onCheckedChange={setCheckout} aria-label="Check the new branch out" />
          <Text role="muted">Check it out too — refused if the working tree is dirty.</Text>
        </div>
        {error && <ActionError>{error}</ActionError>}
      </div>
    </Dialog>
  )
}
