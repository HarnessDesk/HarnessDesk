import { repoKey, type SessionSummary, type TeamState, type WorkspaceEntry } from '@harnessdesk/protocol'

import { isPathInside, relativeTo, shortPath } from './paths'

// One definition of "the same repository", shared with the host that reads each folder's remote.
export { repoKey }

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
 *
 * A *clone* is not a worktree. It is a second full copy of the repository in
 * a folder of its own — the Team clones a desk makes, one per Team, were a
 * dozen rows for one project — and neither git nor the folders can say it is
 * the same project; only the remote can. So the host sends each folder's
 * `origin` (`RepoInfo.origin`, an `owner/name` on a host, no credentials) and
 * every folder with the same one is one project, whatever its root. A folder
 * with no remote keeps its own root. The project is homed at the checkout the
 * person opened — one of the folders they opened, if any is — and, among
 * those, the one worked in first; the clones a Team made never rename it.
 */

export interface ProjectGroup {
  /** The folder the group acts on: the main checkout when one is known. */
  readonly root: string
  readonly name: string
  readonly sessions: SessionSummary[]
  readonly updatedAt: number
  /**
   * Every folder this project answers to: its home first, then each checkout
   * of the repository the list has met — the clones included — and every
   * folder a conversation of it ran in, by path.
   *
   * A pin or a fold saved under any of them is the project's, and the folder
   * the app has open belongs here even when it is not the home. This is for
   * *comparing*; where an action takes place is still `root`, or the folder
   * the person opened (`projectRootOf`).
   */
  readonly folders: readonly string[]
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
 * A folder, the way a person reads one beside the work it holds: the project's
 * own short name when it is the project (`widgets`), that name plus the way
 * down when it is inside it (`widgets/packages/ui`), and otherwise a
 * home-shortened path (`~/elsewhere`) — never the raw absolute one, which is
 * the hover's to carry.
 */
export const folderShown = (path: string, home: string | null | undefined, project?: string | null): string => {
  if (project && isPathInside(path, project)) {
    const below = relativeTo(path, project)
    return below === path ? folderName(project) : `${folderName(project)}/${below}`
  }
  return shortPath(path, home)
}

/** The folder a project is named after and acts on, when git named a checkout. */
const ROOT = 'root:'
/** A project known by its remote: every folder that shares one is one project. */
const ORIGIN = 'origin:'

/** The repository a conversation ran in, as the host read it or the agent reported it. */
const originOf = (summary: SessionSummary): string | null =>
  repoKey(summary.repo?.origin) ?? repoKey(summary.git?.originUrl)

interface Entry {
  readonly sessions: SessionSummary[]
  /** Every folder a conversation ran in, with how many did. */
  readonly cwds: Map<string, number>
  /** Each checkout git named, with when the oldest conversation worked in it began. */
  readonly roots: Map<string, number>
  /** The checkout git named for a folder, where it named one. */
  readonly rootOf: Map<string, string>
  /** The remote this project is known by, when it has one. */
  readonly origin: string | null
}

/**
 * Which of a project's checkouts leads it.
 *
 * One checkout leads on its own. Several are clones of one repository, and
 * the home must not depend on which of them an agent last ran in, or which a
 * Team made last: the person's own checkout leads. A folder the person opened
 * is theirs — the clones a Team made were never opened here — and among those
 * the one worked in first is the project's home, however many conversations
 * the others hold. With none of them opened, the oldest history leads.
 */
const leadRootOf = (entry: Entry, opened: ReadonlySet<string>, gone: ReadonlySet<string>): string | null => {
  const candidates = [...entry.roots.entries()].filter(([root]) => !gone.has(root))
  const only = candidates[0]
  if (only === undefined) return null
  if (candidates.length === 1) return only[0]
  const mine = candidates.filter(([root]) => [...opened].some((path) => isPathInside(path, root)))
  const first = (pool: [string, number][]): string =>
    [...pool].sort(
      ([a, since], [b, until]) =>
        (since === until ? 0 : since < until ? -1 : 1) || a.length - b.length || a.localeCompare(b),
    )[0]![0]
  return first(mine.length > 0 ? mine : candidates)
}

const homeOf = (
  entry: Entry,
  opened: ReadonlySet<string>,
  current: string | null,
  gone: ReadonlySet<string>,
): string => {
  const lead = leadRootOf(entry, opened, gone)
  // Only the leading checkout's own folders may be the home: the project is
  // not renamed after a clone because that clone is the folder in front of
  // you, any more than after a worktree.
  const own = new Map([...entry.cwds].filter(([cwd]) => !gone.has(cwd) && (lead === null || entry.rootOf.get(cwd) === lead)))
  const candidates = [...own.entries()]
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
  if (current !== null && own.has(current)) return current
  // The main checkout git named. Every worktree of the project folds into it,
  // so the project keeps one name however many checkouts are open — which is
  // the whole reason a worktree is not allowed to be a home below.
  if (lead !== null) return lead
  const home = best(candidates.filter(([cwd]) => opened.has(cwd)))
  if (home !== undefined) return home
  const plain = candidates.filter(([cwd]) => !isWorktreePath(cwd))
  return best(plain.length > 0 ? plain : candidates) ?? ''
}

export const groupByProject = (
  history: readonly SessionSummary[],
  workspaces: readonly (string | WorkspaceEntry)[],
  /** The folder the app has open, if any: it may claim its project's home. */
  current: WorkspaceEntry | null = null,
  options: { identityHistory?: readonly SessionSummary[]; goneFolders?: ReadonlySet<string> } = {},
): ProjectGroup[] => {
  // Visibility never decides repository identity, aliases or the home. Opened
  // checkouts also supply facts before their first history page arrives.
  const facts = options.identityHistory ?? history
  const visible = new Set(history)
  const gone = options.goneFolders ?? new Set<string>()
  const paths = workspaces.map((workspace) => typeof workspace === 'string' ? workspace : workspace.path)
  const opened = new Set(paths.filter((path) => !gone.has(path)))
  const knownWorkspaces = workspaces.filter((workspace): workspace is WorkspaceEntry => typeof workspace !== 'string')
  // What each signal resolves to, learned from the rows that carry two of
  // them. A repository root is the strongest — it is one path per project,
  // whether or not the project has a remote at all — so a remote and a
  // folder are both taught which root they belong to before anything is
  // grouped, and rows that know only one of the three still land together.
  const rootByFolder = new Map<string, string>()
  const originByFolder = new Map<string, string>()
  const originByRoot = new Map<string, string>()
  for (const workspace of knownWorkspaces) {
    const root = workspace.repo?.root
    const origin = repoKey(workspace.repo?.origin)
    if (root !== undefined) rootByFolder.set(workspace.path, root)
    if (origin !== null) {
      originByFolder.set(workspace.path, origin)
      if (root !== undefined) originByRoot.set(root, origin)
    }
  }
  for (const summary of facts) {
    const origin = originOf(summary)
    const root = summary.repo?.root
    if (origin !== null) {
      if (!originByFolder.has(summary.cwd)) originByFolder.set(summary.cwd, origin)
      if (root !== undefined && !originByRoot.has(root)) originByRoot.set(root, origin)
    }
    if (root !== undefined) rootByFolder.set(summary.cwd, root)
  }

  // Only checkouts something else in the list has vouched for. A guess read
  // off a path may name a project, never invent one.
  const vouched = new Set([...rootByFolder.values(), ...paths])

  const rootOfRow = (summary: SessionSummary): string | undefined => {
    const root = summary.repo?.root ?? rootByFolder.get(summary.cwd)
    if (root !== undefined) return root
    // A worktree whose folder has since been removed: git has nothing left to
    // answer with, but a checkout kept inside its repository still says in its
    // path which repository that was.
    const checkout = checkoutOf(summary.cwd)
    return checkout !== null && vouched.has(checkout) ? checkout : undefined
  }

  const byKey = new Map<string, Entry>()
  for (const summary of facts) {
    const root = rootOfRow(summary)
    // Not every agent reports git; a session that knows only its folder joins
    // whatever another session placed that folder, or its checkout, in.
    const origin = originOf(summary) ?? (root !== undefined ? originByRoot.get(root) : undefined) ?? originByFolder.get(summary.cwd) ?? null
    const key = origin !== null ? `${ORIGIN}${origin}` : root !== undefined ? `${ROOT}${root}` : `path:${summary.cwd}`
    let entry = byKey.get(key)
    if (!entry) {
      entry = { sessions: [], cwds: new Map(), roots: new Map(), rootOf: new Map(), origin }
      byKey.set(key, entry)
    }
    if (visible.has(summary)) entry.sessions.push(summary)
    entry.cwds.set(summary.cwd, (entry.cwds.get(summary.cwd) ?? 0) + 1)
    if (root !== undefined) {
      entry.rootOf.set(summary.cwd, root)
      // A conversation with no date says nothing about when a folder was first worked in.
      const began = Number.isFinite(summary.createdAt) && summary.createdAt > 0 ? summary.createdAt : Number.POSITIVE_INFINITY
      entry.roots.set(root, Math.min(entry.roots.get(root) ?? Number.POSITIVE_INFINITY, began))
    }
  }

  for (const workspace of knownWorkspaces) {
    const root = workspace.repo?.root ?? rootByFolder.get(workspace.path)
    const origin = repoKey(workspace.repo?.origin) ?? originByFolder.get(workspace.path) ?? (root === undefined ? null : originByRoot.get(root))
    const key = origin ? `${ORIGIN}${origin}` : root ? `${ROOT}${root}` : `path:${workspace.path}`
    const entry = byKey.get(key)
    if (!entry) continue
    if (!entry.cwds.has(workspace.path)) entry.cwds.set(workspace.path, 0)
    if (root !== undefined) {
      entry.rootOf.set(workspace.path, root)
      if (!entry.roots.has(root)) entry.roots.set(root, Number.POSITIVE_INFINITY)
    }
  }

  // A worktree is a checkout to work in, not a project to be homed at.
  const claimant = current === null || currentIsWorktree(current) ? null : ownPathOf(current)
  // The folder you have open has no conversations of its own yet when it is a
  // fresh clone, but its remote still says which project it is a copy of.
  const openedOrigin = repoKey(current?.repo?.origin)
  const openedFolder = current === null ? null : projectGroupRootOf(current)
  return [...byKey.values()].filter((entry) => entry.sessions.length > 0).map((entry) => {
    const root = homeOf(entry, opened, claimant, gone)
    const others = [...new Set([...entry.cwds.keys(), ...entry.roots.keys()])].filter((folder) => folder !== root).sort()
    const holdsOpenFolder = openedFolder !== null && openedOrigin !== null && entry.origin === openedOrigin
    return {
      root,
      name: folderName(root),
      sessions: [...entry.sessions].sort((a, b) => b.updatedAt - a.updatedAt),
      updatedAt: Math.max(...entry.sessions.map((one) => one.updatedAt)),
      folders: [root, ...others, ...(holdsOpenFolder && openedFolder !== root && !others.includes(openedFolder) ? [openedFolder] : [])],
    }
  })
}

const currentIsWorktree = (workspace: WorkspaceEntry): boolean =>
  workspace.repo ? workspace.repo.worktree : isWorktreePath(workspace.path)

/**
 * `workspace.path`, corrected for the one case a plain string cannot answer.
 *
 * The host keeps `workspace.path` at the spelling it was opened at,
 * deliberately not `realpath`'d (`describeWorkspace`) — a session with no
 * git repository is matched against the open list by that same raw spelling,
 * and resolving links there would strand that case. But git's own root for
 * this folder (`checkoutRoot`, or `repo.root` outside a worktree) is computed
 * by resolving them, so when the folder was reached through one — macOS keeps
 * its own temporary folders behind `/var` → `/private/var` — that root is not
 * a textual ancestor of the path that produced it. That disagreement can
 * only be a spelling difference, never a real subfolder: an ordinary
 * subfolder of an ordinary checkout always passes the lexical check, so this
 * never touches the "home where you are standing" rule below, and resolves
 * only the spelling a link introduced. Grouping sessions by `repo.root`
 * while the workspace list kept the open folder's own spelling filed the same
 * project under two keys, and it showed up twice in the sidebar (#898).
 *
 * Outside git there is no `repo.root` to disagree with — `checkout` is
 * `null` — but the same link can still be in the opened spelling, and the
 * folder's own sessions still report their real `cwd` (an agent process
 * started at a link answers `getcwd` resolved, same as git does). `path`
 * itself is not the answer there either, so this reads `workspace.realPath`
 * — the host's own resolution of the same folder, kept separate from `path`
 * for exactly this reason — with the identical lexical test: only a link
 * fails it, an ordinary folder passes and is left alone (#907).
 */
const ownPathOf = (workspace: WorkspaceEntry): string => {
  const checkout = workspace.checkoutRoot ?? workspace.repo?.root ?? null
  if (checkout) return isPathInside(workspace.path, checkout) ? workspace.path : checkout
  const real = workspace.realPath ?? null
  return real && !isPathInside(workspace.path, real) ? real : workspace.path
}

/**
 * The folder a Goal, a flow or a race actually starts in.
 *
 * Never the canonical form: a Seat's checkout, a flow's `cwd` and a race's
 * worktree are all cut from the folder that was genuinely opened, and
 * `ownPathOf`'s corrected root is a *different folder on disk* the moment a
 * subfolder — or a link into a monorepo package — is what got opened. A
 * review of #905 caught this reading `ownPathOf` for exactly that reason:
 * creation started at the repository's own top instead of the subfolder
 * standing open in front of the person who asked for it. Only a worktree is
 * special here, and it already was before that fix — a worktree is a
 * checkout to work in, not a project to be homed at, so this defers to the
 * checkout it was cut from.
 */
export const projectRootOf = (workspace: WorkspaceEntry | null | undefined): string | null => {
  if (!workspace) return null
  return currentIsWorktree(workspace) ? (workspace.repo?.root ?? workspace.path) : workspace.path
}

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
 *
 * Grouping and comparison only. Never read this where a folder is about to be
 * acted on — `projectRootOf` is that answer, and it is deliberately a
 * different function: the day these two were one, creating a Goal in a
 * subfolder reached through a link created it at the repository's own top
 * instead (a review of #905 caught it).
 */
export const projectGroupRootOf = (workspace: WorkspaceEntry | null | undefined): string | null => {
  if (!workspace) return null
  return currentIsWorktree(workspace) ? (workspace.repo?.root ?? workspace.path) : ownPathOf(workspace)
}

/**
 * The row a room is filed under.
 *
 * A room keeps the folder its work started in, as that folder was opened
 * (`projectRootOf`), because that is where the work is cut from — a folder
 * reached through a link keeps the link's spelling. The list homes the same
 * folder at its canonical root (`projectGroupRootOf`). Filed under its own
 * spelling, the room earned the project a second row, under "Other
 * projects", and went missing from the row it belongs to. A link's spelling
 * must never change where a room is filed. The open folder at the room's own
 * spelling knows both spellings. Once that folder has left the list, the
 * host's resolved root (`realRoot`) stands in for it, and it is looked up in
 * the list as well: a worktree open at the resolved spelling files there
 * under its checkout, just as the same room at that spelling would be
 * (#998).
 */
export const roomGroupRootOf = (
  room: string | Pick<TeamState, 'root' | 'realRoot'>,
  open: readonly (WorkspaceEntry | null | undefined)[],
): string => {
  const { root, realRoot } = typeof room === 'string' ? { root: room, realRoot: undefined } : room
  for (const spelling of [root, realRoot]) {
    if (spelling === undefined) continue
    const opened = open.find((one) => one?.path === spelling)
    if (opened) return projectGroupRootOf(opened) ?? spelling
  }
  return realRoot ?? root
}

/**
 * The project that holds the folder the app has open, if the list has one.
 *
 * Its home when the open folder is the home, and otherwise the project the
 * open folder is one of the folders of: a clone of the repository, or a
 * checkout the person opened that is not the one the project is homed at.
 * Everything the list does with "the project you are in" — leading with it,
 * lighting its row, keeping it out of "Other projects", and deciding whether
 * the folder needs an empty row of its own — asks this, because comparing the
 * open folder with a group's home alone draws a clone's project twice.
 *
 * Comparison only. A new session, a worktree or a Goal still starts in the
 * folder that was opened (`projectRootOf`), never in the project's home.
 */
export const groupHolding = (
  groups: readonly ProjectGroup[],
  workspace: WorkspaceEntry | null | undefined,
): ProjectGroup | undefined => {
  const own = projectGroupRootOf(workspace)
  if (own === null) return undefined
  return groups.find((group) => group.root === own) ?? groups.find((group) => group.folders.includes(own))
}

/**
 * `listPrefs.pinned`/`.collapsed`, corrected for the spellings a project's
 * pin or fold could have been recorded under.
 *
 * A pin or a fold names a project by its group's `root`. Two things move
 * that name without the person doing anything. A project reached through a
 * link — macOS's own `/var` → `/private/var` — was homed at the raw,
 * unresolved path before #898's fix and at the canonical one now. And a
 * project that was a dozen rows — one per clone of the repository — is one
 * row homed at one of them, so what was recorded under another clone is the
 * project's now, and two spellings of one project are one entry.
 *
 * The open workspace is the only entry that knows both spellings of a link,
 * and only the groups know which folders were folded together; anything
 * recorded under a project neither can place is unaffected either way. A
 * room's id never collides with a folder, so it passes through untouched.
 */
export const migratedRoots = (
  roots: readonly string[],
  workspace: WorkspaceEntry | null | undefined,
  groups: readonly ProjectGroup[] = [],
): readonly string[] => {
  const canonical = workspace ? projectGroupRootOf(workspace) : null
  const spelled =
    workspace && canonical && canonical !== workspace.path
      ? roots.map((root) => (root === workspace.path ? canonical : root))
      : roots
  if (groups.length === 0) return spelled
  const homeOfFolder = new Map<string, string>()
  for (const group of groups) {
    for (const folder of group.folders) if (!homeOfFolder.has(folder)) homeOfFolder.set(folder, group.root)
  }
  return [...new Set(spelled.map((root) => homeOfFolder.get(root) ?? root))]
}
