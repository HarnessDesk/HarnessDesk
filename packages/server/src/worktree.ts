import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, realpath, rm } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import { promisify } from 'node:util'

import type { RepoInfo, Worktree, WorktreeChanges } from '@harnessdesk/protocol'

import { defaultStateDir } from './state.js'

import { parsePorcelain } from './porcelain.js'

/**
 * Git worktrees, one per conversation that asks for one.
 *
 * A worktree gives a conversation its own checkout on its own branch, so two
 * agents editing the same path do not see each other's half-finished work.
 * They live outside the repository — under HarnessDesk's own directory, keyed
 * by the repository — so the agent never finds a nest of sibling checkouts
 * inside its project, and so deleting a worktree cannot touch the main one.
 *
 * The one hard rule: **uncommitted work is never silently destroyed.**
 * Removing a worktree with changes in it is refused with the list of what
 * would be lost; the caller must say `force`, and the interface names the
 * files before it does. The branch is never deleted here at all — a branch is
 * cheap to keep and expensive to lose, and `git branch -d` is one command
 * away for a person who has decided.
 */

const run = promisify(execFile)

export class WorktreeDirtyError extends Error {
  constructor(
    readonly path: string,
    readonly changes: WorktreeChanges,
  ) {
    super(
      `${path} has ${describeChanges(changes)}. Commit or stash them, or remove the worktree with force to discard them.`,
    )
    this.name = 'WorktreeDirtyError'
  }
}

const plural = (count: number, noun: string): string => `${count} ${noun}${count === 1 ? '' : 's'}`

const describeChanges = (changes: WorktreeChanges): string => {
  const parts: string[] = []
  if (changes.modified > 0) parts.push(plural(changes.modified, 'modified file'))
  if (changes.untracked > 0) parts.push(plural(changes.untracked, 'untracked file'))
  if (changes.unpushedCommits > 0) parts.push(plural(changes.unpushedCommits, 'unpushed commit'))
  return parts.join(', ') || 'no changes'
}

const git = async (cwd: string, args: readonly string[]): Promise<string> => {
  const { stdout } = await run('git', ['-C', cwd, ...args], {
    timeout: 30_000,
    maxBuffer: 8 * 1024 * 1024,
  })
  return stdout
}

/**
 * Paths compared here are canonical, because git reports real paths and the
 * caller may not — on macOS `/var` is a link to `/private/var`, and a
 * worktree must not be declared foreign for that.
 */
const canonical = async (path: string): Promise<string> => {
  try {
    return await realpath(path)
  } catch {
    return resolve(path)
  }
}

/** Where a repository's worktrees go: outside it, under HarnessDesk's own directory. */
export const worktreeHome = async (repoRoot: string, stateDir: string): Promise<string> => {
  const root = await canonical(repoRoot)
  const hash = createHash('sha256').update(root).digest('hex').slice(0, 10)
  await mkdir(join(stateDir, 'worktrees'), { recursive: true })
  return join(await canonical(join(stateDir, 'worktrees')), `${basename(root)}-${hash}`)
}

/** The main checkout for any path inside a repository or one of its worktrees. */
export const repositoryRoot = async (path: string): Promise<string | null> =>
  (await repositoryOf(path))?.root ?? null

/**
 * The working tree at the top of a checkout, asked of git rather than derived
 * from where git keeps its state.
 *
 * `dirname(--git-common-dir)` is the main checkout only for the ordinary
 * layout. A submodule's common dir is `<super>/.git/modules/<path>` and a
 * repository made with `--separate-git-dir` keeps it anywhere at all, so that
 * arithmetic answers with a directory of git's own bookkeeping — which the
 * interface would then name a project and start conversations in.
 */
const topLevelOf = async (path: string): Promise<string | null> => {
  try {
    return canonical((await git(path, ['rev-parse', '--path-format=absolute', '--show-toplevel'])).trim())
  } catch {
    // A bare repository, or a git directory with no working tree attached.
    return null
  }
}

/**
 * Which repository a folder belongs to, and whether it is a linked worktree
 * of it — the two facts the session list groups and marks on.
 *
 * `--git-common-dir` is shared by every checkout of a repository and
 * `--git-dir` differs from it only inside a linked worktree, where git keeps
 * that worktree's own state under `<common>/worktrees/<name>`. So a subfolder
 * of the main tree comes back as the project rather than as a worktree, which
 * is the honest answer — it is the same working copy.
 *
 * The root is the working tree git names, never a path computed from the git
 * directory. From a linked checkout that means asking `git worktree list`,
 * whose first entry is always the main worktree; its answer for a submodule
 * is that submodule's git directory, so it is put back through
 * `--show-toplevel` to reach the folder someone actually works in.
 */
export const repositoryOf = async (path: string): Promise<RepoInfo | null> => {
  let common: string | undefined
  let dir: string | undefined
  let here: string | undefined
  try {
    const out = await git(path, [
      'rev-parse',
      '--path-format=absolute',
      '--git-common-dir',
      '--git-dir',
      '--show-toplevel',
    ])
    ;[common, dir, here] = out.split('\n').map((line) => line.trim())
  } catch {
    return null
  }
  if (!common || !dir || !here) return null
  if (dir === common) return { root: await canonical(here), worktree: false }
  const main = await mainCheckoutOf(path)
  return main === null ? null : { root: main, worktree: true }
}

/** The first `worktree` line of the porcelain listing is always the main one. */
const mainCheckoutOf = async (path: string): Promise<string | null> => {
  try {
    const porcelain = await git(path, ['worktree', 'list', '--porcelain'])
    const first = porcelain.split('\n').find((line) => line.startsWith('worktree '))
    if (first === undefined) return null
    const listed = first.slice('worktree '.length)
    return (await topLevelOf(listed)) ?? (await canonical(listed))
  } catch {
    return null
  }
}

/**
 * Turns a name into something safe as both a branch and a directory: lower
 * case, dashes, nothing git rejects. An empty result gets a timestamp.
 */
export const slugify = (name: string): string => {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .replace(/\.\.+/g, '.')
    .slice(0, 48)
  return slug.length > 0 ? slug : `work-${Date.now().toString(36)}`
}

/** The service, bound to the directory HarnessDesk keeps its worktrees under. */
export class Worktrees {
  constructor(private readonly stateDir: string = defaultStateDir()) {}

  list(repoRoot: string): Promise<Worktree[]> {
    return list(repoRoot, this.stateDir)
  }

  create(repoRoot: string, options: { readonly name: string; readonly base?: string }): Promise<Worktree> {
    return create(repoRoot, { ...options, stateDir: this.stateDir })
  }

  changes(path: string): Promise<WorktreeChanges> {
    return changes(path)
  }

  remove(path: string, options: { readonly force?: boolean } = {}): Promise<{ readonly branch: string | null }> {
    return remove(path, { ...options, stateDir: this.stateDir })
  }

  bringHome(path: string): Promise<{ readonly branch: string; readonly from: string | null; readonly root: string; readonly warning?: string }> {
    return bringHome(path, { stateDir: this.stateDir })
  }
}

export const list = async (repoRoot: string, stateDir: string): Promise<Worktree[]> => {
  const main = await repositoryRoot(repoRoot)
  if (!main) return []
  const porcelain = await git(main, ['worktree', 'list', '--porcelain'])
  const home = await worktreeHome(main, stateDir)
  const worktrees: Worktree[] = []
  let current: { path?: string; head?: string; branch?: string | null; detached?: boolean } = {}
  const flush = (): void => {
    if (!current.path) return
    worktrees.push({
      path: current.path,
      branch: current.branch ?? null,
      head: current.head ?? null,
      // The first entry, which is git's own definition of the main worktree —
      // not a path comparison against `main`. For a submodule the listing
      // names that submodule's git directory while `main` is the folder it is
      // checked out at, and the two would never meet.
      isMain: worktrees.length === 0,
      managed: current.path.startsWith(home + '/'),
    })
    current = {}
  }
  for (const line of porcelain.split('\n')) {
    if (line.startsWith('worktree ')) {
      flush()
      current = { path: line.slice('worktree '.length) }
    } else if (line.startsWith('HEAD ')) current.head = line.slice('HEAD '.length)
    else if (line.startsWith('branch ')) current.branch = line.slice('branch '.length).replace(/^refs\/heads\//, '')
    else if (line === 'detached') current.branch = null
  }
  flush()
  return worktrees
}

/**
 * Creates a worktree on a new branch from the repository's current HEAD (or
 * `base`). The branch is namespaced `harnessdesk/` so it is recognisable in
 * `git branch` and never collides with a person's own branch of the same name.
 */
export const create = async (
  repoRoot: string,
  options: { readonly name: string; readonly base?: string; readonly stateDir: string },
): Promise<Worktree> => {
  const main = await repositoryRoot(repoRoot)
  if (!main) throw new Error(`${repoRoot} is not inside a git repository.`)
  const home = await worktreeHome(main, options.stateDir)
  await mkdir(home, { recursive: true })

  // Taken names are every local branch, not just the ones a worktree has
  // checked out: `worktree add -b` refuses an existing branch either way,
  // and a branch left behind by a removed worktree is the common case.
  const [tied, heads] = await Promise.all([
    list(main, options.stateDir),
    git(main, ['for-each-ref', '--format=%(refname:short)', 'refs/heads/']),
  ])
  const existing = new Set<string | null>([
    ...tied.map((entry) => entry.branch),
    ...heads.split('\n').filter((line) => line.length > 0),
  ])
  let slug = slugify(options.name)
  let attempt = 1
  while (existing.has(`harnessdesk/${slug}`)) {
    attempt += 1
    slug = `${slugify(options.name)}-${attempt}`
  }
  const path = join(home, slug)
  const branch = `harnessdesk/${slug}`
  await git(main, ['worktree', 'add', '-b', branch, path, options.base ?? 'HEAD'])
  return { path, branch, head: (await git(path, ['rev-parse', 'HEAD'])).trim(), isMain: false, managed: true }
}

/** What would be lost if this worktree were removed right now. */
export const changes = async (path: string): Promise<WorktreeChanges> => {
  const porcelain = await git(path, ['status', '--porcelain=v1', '-z', '--untracked-files=all'])
  const files: string[] = []
  let modified = 0
  let untracked = 0
  for (const entry of parsePorcelain(porcelain)) {
    files.push(entry.path)
    if (entry.index === '?' && entry.worktree === '?') untracked += 1
    else modified += 1
  }
  // Commits on this branch that no other ref contains would vanish with the
  // branch — and the branch is kept, so they are reported, not counted as a
  // reason to refuse. Upstream is the usual other ref; main is the fallback.
  let unpushedCommits = 0
  try {
    const count = await git(path, ['rev-list', '--count', '@{upstream}..HEAD'])
    unpushedCommits = Number(count.trim()) || 0
  } catch {
    try {
      const main = await repositoryRoot(path)
      const mainHead = main ? (await git(main, ['rev-parse', 'HEAD'])).trim() : null
      if (mainHead) {
        const count = await git(path, ['rev-list', '--count', `${mainHead}..HEAD`])
        unpushedCommits = Number(count.trim()) || 0
      }
    } catch {
      // A brand-new repository with no commits; nothing to count.
    }
  }
  return { modified, untracked, unpushedCommits, files }
}

/**
 * Refuses a worktree whose repository no open workspace is part of. The verbs
 * that change a repository — removing one of its checkouts, switching its main
 * checkout's branch — answer to the boundary the rest of the git surface does:
 * the folders the window has open. A worktree lives in the state directory,
 * outside every workspace, so what is confined is its repository, open as its
 * main checkout, as a folder inside it, or as the worktree itself.
 */
export const confineToOpenRepository = async (path: string, roots: readonly string[]): Promise<void> => {
  const main = await repositoryRoot(path)
  if (!main) throw new Error(`${path} is not a git worktree.`)
  for (const root of roots) {
    if ((await repositoryRoot(root).catch(() => null)) === main) return
  }
  throw new Error(`${path} belongs to ${main}, which is not open in this window. Open it first.`)
}

/**
 * Removes a worktree. Refuses, with the list of what would be lost, unless
 * `force` is set. The branch stays. Only worktrees HarnessDesk created are
 * removable from here: the person's own checkouts are not this app's to
 * delete, force or no force.
 */
export const remove = async (
  path: string,
  options: { readonly force?: boolean; readonly stateDir: string },
): Promise<{ readonly branch: string | null }> => {
  const main = await repositoryRoot(path)
  if (!main) throw new Error(`${path} is not a git worktree.`)
  const target = await canonical(path)
  const entry = (await list(main, options.stateDir)).find((candidate) => candidate.path === target)
  if (!entry) throw new Error(`${path} is not a worktree of ${main}.`)
  if (entry.isMain) throw new Error(`${path} is the main checkout and cannot be removed.`)
  if (!entry.managed) {
    throw new Error(`${path} was not created by HarnessDesk; remove it with git worktree remove yourself.`)
  }

  const pending = await changes(target)
  if (!options.force && (pending.modified > 0 || pending.untracked > 0)) {
    throw new WorktreeDirtyError(target, pending)
  }
  await git(main, ['worktree', 'remove', ...(options.force ? ['--force'] : []), target])
  // `git worktree remove --force` leaves an empty directory behind on some
  // versions; nothing of value is in it by now.
  await rm(target, { recursive: true, force: true })
  return { branch: entry.branch }
}

/**
 * Brings a worktree's work back to the main checkout: the branch is checked
 * out there, and the side checkout goes.
 *
 * **Checkout, not merge.** "Hand it back to local" means *stop doing this in a
 * separate checkout and do it here* — the branch travels intact, no history is
 * folded into whatever the main tree happened to be on, and nothing is
 * created that a person did not ask for. Folding one branch into another is a
 * different verb and the history pane already has it.
 *
 * The order is forced: git will not check out a branch a second worktree
 * holds, so the worktree has to go first — and a removal is only safe on a
 * clean tree, which is why uncommitted work is refused here with the same
 * error `remove` raises. That leaves one window where the checkout could
 * fail (the main tree has its own edits to a file the two branches disagree
 * about) with the worktree already gone, so the failure **puts it back**:
 * `worktree add <path> <branch>` restores everything git tracks, which is all
 * of the work, because what was taken was clean. What git ignores there does
 * not come back, and the refusal names it; when git will not put it back at
 * all, the refusal says the folder is gone rather than that it was put back.
 * A switch git reports as failed after making it — a failing post-checkout
 * hook — completes, with git's words as `warning`.
 *
 * Only worktrees HarnessDesk created, as with `remove`: the person's own
 * checkouts are theirs to move. The method handler also confines the
 * repository to the ones the window has open.
 */
export const bringHome = async (
  path: string,
  options: { readonly stateDir: string },
): Promise<{ readonly branch: string; readonly from: string | null; readonly root: string; readonly warning?: string }> => {
  const main = await repositoryRoot(path)
  if (!main) throw new Error(`${path} is not a git worktree.`)
  const target = await canonical(path)
  const entry = (await list(main, options.stateDir)).find((candidate) => candidate.path === target)
  if (!entry) throw new Error(`${path} is not a worktree of ${main}.`)
  if (entry.isMain) throw new Error(`${path} is the main checkout; it is already home.`)
  // The header offers this only on HarnessDesk's own worktrees, but this is
  // the boundary, and anything that can name a path on the wire reaches it.
  if (!entry.managed) {
    throw new Error(`${path} was not created by HarnessDesk; move its branch to the main checkout with git yourself.`)
  }
  if (!entry.branch) {
    throw new Error(
      `${path} is not on a branch, so there is nothing to check out in the main checkout. Make a branch there first.`,
    )
  }

  // Uncommitted work would be destroyed by the removal below, and the
  // removal is not optional. Same refusal as `remove`, so both surfaces word
  // the loss identically — and there is no `force` here at all: discarding
  // the work is the opposite of bringing it back.
  const pending = await changes(target)
  if (pending.modified > 0 || pending.untracked > 0) throw new WorktreeDirtyError(target, pending)

  const from = await currentBranchOf(main)
  // What git ignores there — an .env, node_modules — is not work git refuses
  // to lose: `git status` never counts it, and `worktree remove` takes it with
  // the folder. Named now, while the folder is still there, so a refusal can
  // say what putting the worktree back did not bring back.
  const ignored = await ignoredIn(target)
  await git(main, ['worktree', 'remove', target])
  let warning: string | undefined
  try {
    await git(main, ['checkout', entry.branch])
  } catch (error) {
    // A post-checkout hook runs after the switch, and git returns its exit
    // status as checkout's own: a failing hook reads as a refusal that did
    // not happen. Where the main checkout is now is the answer — and what git
    // said is still the person's to read.
    if ((await currentBranchOf(main)) !== entry.branch) {
      await putBack(main, target, entry.branch, error, options.stateDir, ignored)
    }
    warning = `${basename(main)} is on ${entry.branch}, but git reported a failure after switching: ${gitSaid(error)}`
  }
  await rm(target, { recursive: true, force: true })
  return { branch: entry.branch, from, root: main, ...(warning ? { warning } : {}) }
}

/**
 * Puts a worktree back after the main checkout refused its branch, and throws
 * what happened. The tree was clean, so `worktree add` on the same path and
 * branch restores everything git tracks — when git lets it. What git ignores
 * there (an `.env`, `node_modules`) went with the removal and does not come
 * back, so the error names it. When git will not re-add it (a second worktree
 * forced onto the branch holds it, the disk is full), the folder is gone, and
 * the error says that rather than that it was put back. The listing decides,
 * not the exit status: `worktree add` reports a failing hook too, after it has
 * done its work.
 */
const putBack = async (
  main: string,
  target: string,
  branch: string,
  refused: unknown,
  stateDir: string,
  ignored: readonly string[],
): Promise<never> => {
  const failed = await git(main, ['worktree', 'add', target, branch]).then(
    () => null,
    (error: unknown) => error,
  )
  const back = failed === null || (await list(main, stateDir).catch(() => [])).some((entry) => entry.path === target)
  if (back) {
    const without = ignored.length > 0 ? `, without what git ignores there: ${named(ignored)}` : ''
    throw new Error(
      `${basename(main)} could not switch to ${branch}, so the worktree was put back from its branch${without}. ${gitSaid(refused)}`,
    )
  }
  throw new Error(
    `${basename(main)} could not switch to ${branch}, and the worktree could not be put back at ${target}, so that ` +
      `folder is gone; the branch keeps every commit. Switching: ${gitSaid(refused)} Putting it back: ${gitSaid(failed)}`,
  )
}

/**
 * What git ignores in a checkout, as its porcelain names it: one entry per
 * ignored file, or per directory ignored whole (`node_modules/`). Empty when
 * the listing cannot be read — it only ever words a message.
 */
const ignoredIn = async (path: string): Promise<string[]> => {
  try {
    const porcelain = await git(path, ['status', '--porcelain=v1', '-z', '--ignored=matching'])
    return porcelain
      .split('\0')
      .filter((line) => line.startsWith('!! '))
      .map((line) => line.slice('!! '.length))
  } catch {
    return []
  }
}

/** A few names and a count, for a sentence rather than a listing. */
const named = (entries: readonly string[]): string =>
  entries.length <= 5 ? entries.join(', ') : `${entries.slice(0, 5).join(', ')} and ${entries.length - 5} more`

/** The branch a checkout is on, or null when it is detached. */
const currentBranchOf = async (root: string): Promise<string | null> => {
  try {
    const name = (await git(root, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim()
    return name === 'HEAD' || name === '' ? null : name
  } catch {
    return null
  }
}

/**
 * What git actually said, rather than "Command failed: git -C /long/path …".
 *
 * A verb that draws progress overwrites its own line, so the reason arrives
 * after a carriage return; splitting on both terminators is the only way to
 * reach it. See the same trap in `git-actions.ts`.
 */
const gitSaid = (error: unknown): string => {
  const streams = error as { stderr?: string; stdout?: string } | null
  const said = `${streams?.stderr ?? ''}\n${streams?.stdout ?? ''}`
    .split(/[\n\r]+/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !/^hint:/i.test(line))
  return said.length > 0 ? said.join(' ') : error instanceof Error ? error.message : String(error)
}
