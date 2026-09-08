import type { SessionSummary, WorkspaceEntry } from '@harnessdesk/protocol'

/**
 * Sessions grouped by project, where a project is a repository rather than
 * a folder.
 *
 * A worktree is a checkout of a project, not a project. Codex gives every
 * thread started "in a worktree" its own checkout under
 * ~/.codex/worktrees/<id>/<name>; Claude Code puts its own under
 * <repo>/.claude/worktrees/<name>; HarnessDesk's live under
 * ~/.harnessdesk/worktrees. Grouped by folder, one project becomes a dozen
 * one-session groups. Grouped by repository they fold back in, the main
 * checkout is the group's home — where "new session here" starts — and the
 * row itself says which checkout it ran in.
 *
 * The repository comes from the host, which asks git per folder, because the
 * agents cannot answer it: one of them reports a git remote and the rest
 * report nothing at all, so a remote alone left every conversation an ACP
 * agent had in a worktree as a project of its own. The remote is still read
 * where it is the only thing on offer — a recorded wire, a session whose
 * folder has since been deleted — so the two signals are reconciled rather
 * than ranked: a folder, a remote and a repository root all resolve to one
 * key, and a project is never split because two of its rows knew different
 * things about it.
 */

export interface ProjectGroup {
  /** The folder the group acts on: the main checkout when one is known. */
  readonly root: string
  readonly name: string
  readonly sessions: SessionSummary[]
  readonly updatedAt: number
}

const WORKTREE_DIRS = ['/.codex/worktrees/', '/.harnessdesk/worktrees/', '/.worktrees/', '/worktrees/']

/**
 * A worktree by the shape of its path, for the rows the host could not ask
 * git about — a folder that has since been deleted, a recorded wire. The
 * host's own answer wins wherever there is one.
 */
export const isWorktreePath = (path: string): boolean => WORKTREE_DIRS.some((dir) => path.includes(dir))

/**
 * The checkout a worktree kept *inside* its repository hangs off.
 *
 * Claude Code puts its worktrees at `<repo>/.claude/worktrees/<name>`, which
 * means the path still names the project after the folder is gone and git
 * can no longer be asked. Codex's and HarnessDesk's own live outside the
 * repository and are not derivable this way, so they get no guess here.
 */
const checkoutOf = (path: string): string | null => {
  for (const dir of ['/.claude/worktrees/', '/.worktrees/']) {
    const at = path.indexOf(dir)
    if (at > 0) return path.slice(0, at)
  }
  return null
}

/** Whether a session ran in a checkout other than its project's main one. */
export const isWorktreeSession = (summary: SessionSummary): boolean =>
  summary.repo ? summary.repo.worktree : isWorktreePath(summary.cwd)

export const folderName = (path: string): string => path.split('/').filter(Boolean).at(-1) ?? path

/**
 * One key per repository, whatever the remote's spelling:
 * git@github.com-alias:owner/repo.git and https://github.com/owner/repo
 * are the same project.
 */
export const repoKey = (originUrl: string | null | undefined): string | null => {
  if (!originUrl) return null
  const trimmed = originUrl.trim().replace(/\.git$/i, '').replace(/\/+$/, '')
  // scp-like: [user@]host[-alias]:owner/repo
  const scp = /^(?:[^@/]+@)?([^:/]+):(.+)$/.exec(trimmed)
  if (scp && !/^[a-z]+:\/\//i.test(trimmed)) {
    return `${hostOf(scp[1] ?? '')}/${scp[2]?.toLowerCase() ?? ''}`
  }
  try {
    const url = new URL(trimmed)
    return `${hostOf(url.hostname)}${url.pathname.toLowerCase()}`
  } catch {
    return trimmed.toLowerCase()
  }
}

/** 'github.com-work' (an SSH config alias) is still github.com. */
const hostOf = (host: string): string => host.toLowerCase().replace(/^([^.]+\.[^.]+)-.*$/, '$1')

/** The folder a project is named after and acts on, when git named a checkout. */
const ROOT = 'root:'

const homeOf = (
  key: string,
  cwds: Map<string, number>,
  workspaces: ReadonlySet<string>,
  current: string | null,
): string => {
  // The main checkout git named. Every worktree of the project folds into it,
  // so the project keeps one name however many checkouts are open — which is
  // the whole reason a worktree is not allowed to be a home below.
  const root = key.startsWith(ROOT) ? key.slice(ROOT.length) : null
  const candidates = [...cwds.entries()]
  // Most sessions wins; shortest path breaks the tie. A project's home must
  // not depend on which of its folders was worked in last: `packages/desktop`
  // and the repo root are both open workspaces of the same project, and
  // taking whichever was touched most recently renames the project under the
  // developer every time an agent runs a session in a subfolder.
  const best = (pool: [string, number][]): string | undefined =>
    [...pool].sort((a, b) => b[1] - a[1] || a[0].length - b[0].length)[0]?.[0]
  // The folder you have open is the home of its own project, whatever the
  // session counts say. `current` is null when that folder is a worktree:
  // opening a checkout to look at it must not rename the project after it.
  if (current !== null && cwds.has(current)) return current
  if (root !== null) return root
  const home = best(candidates.filter(([cwd]) => workspaces.has(cwd)))
  if (home !== undefined) return home
  const plain = candidates.filter(([cwd]) => !isWorktreePath(cwd))
  return best(plain.length > 0 ? plain : candidates) ?? ''
}

export const groupByProject = (
  history: readonly SessionSummary[],
  workspaces: readonly string[],
  /** The folder the app has open, if any: it may claim its project's home. */
  current: WorkspaceEntry | null = null,
): ProjectGroup[] => {
  const known = new Set(workspaces)
  // What each signal resolves to, learned from the rows that carry two of
  // them. A repository root is the strongest — it is one path per project,
  // whether or not the project has a remote at all — so a remote and a
  // folder are both taught which root they belong to before anything is
  // grouped, and rows that know only one of the three still land together.
  const rootByOrigin = new Map<string, string>()
  const rootByFolder = new Map<string, string>()
  const originByFolder = new Map<string, string>()
  for (const summary of history) {
    const origin = repoKey(summary.git?.originUrl)
    if (origin !== null && !originByFolder.has(summary.cwd)) originByFolder.set(summary.cwd, origin)
    const root = summary.repo?.root
    if (root === undefined) continue
    rootByFolder.set(summary.cwd, root)
    if (origin !== null && !rootByOrigin.has(origin)) rootByOrigin.set(origin, root)
  }

  // Only checkouts something else in the list has vouched for. A guess read
  // off a path may name a project, never invent one.
  const roots = new Set([...rootByFolder.values(), ...workspaces])

  const keyOf = (summary: SessionSummary): string => {
    const root = summary.repo?.root ?? rootByFolder.get(summary.cwd)
    if (root !== undefined) return `${ROOT}${root}`
    // A worktree whose folder has since been removed: git has nothing left to
    // answer with, but a checkout kept inside its repository still says in its
    // path which repository that was.
    const checkout = checkoutOf(summary.cwd)
    if (checkout !== null && roots.has(checkout)) return `${ROOT}${checkout}`
    // Not every agent reports git; a session that knows only its folder joins
    // whatever another session placed that folder in.
    const origin = repoKey(summary.git?.originUrl) ?? originByFolder.get(summary.cwd)
    if (origin === undefined) return `path:${summary.cwd}`
    const placed = rootByOrigin.get(origin)
    return placed !== undefined ? `${ROOT}${placed}` : `origin:${origin}`
  }

  const byKey = new Map<string, { sessions: SessionSummary[]; cwds: Map<string, number> }>()
  for (const summary of history) {
    const key = keyOf(summary)
    let entry = byKey.get(key)
    if (!entry) {
      entry = { sessions: [], cwds: new Map() }
      byKey.set(key, entry)
    }
    entry.sessions.push(summary)
    entry.cwds.set(summary.cwd, (entry.cwds.get(summary.cwd) ?? 0) + 1)
  }

  // A worktree is a checkout to work in, not a project to be homed at.
  const claimant = current === null || currentIsWorktree(current) ? null : current.path
  return [...byKey.entries()].map(([key, { sessions, cwds }]) => {
    const root = homeOf(key, cwds, known, claimant)
    return {
      root,
      name: folderName(root),
      sessions: [...sessions].sort((a, b) => b.updatedAt - a.updatedAt),
      updatedAt: Math.max(...sessions.map((entry) => entry.updatedAt)),
    }
  })
}

const currentIsWorktree = (workspace: WorkspaceEntry): boolean =>
  workspace.repo ? workspace.repo.worktree : isWorktreePath(workspace.path)

/**
 * The row the folder you have open belongs to.
 *
 * The same answer `homeOf` gives, and it has to be: everything the list does
 * with "the project you have open" — lighting its row, leading with it,
 * keeping it out of "Other projects", and deciding whether it needs an empty
 * row of its own — compares this against a group's `root`, and a second
 * opinion here shows up as a duplicate project rather than as a wrong
 * highlight. So an open subfolder still claims its project's home, exactly as
 * grouping lets it, and only a worktree defers to the checkout it was cut
 * from.
 */
export const projectRootOf = (workspace: WorkspaceEntry | null | undefined): string | null => {
  if (!workspace) return null
  return currentIsWorktree(workspace) ? (workspace.repo?.root ?? workspace.path) : workspace.path
}
