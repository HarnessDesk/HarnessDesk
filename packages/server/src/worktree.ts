import { execFile } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { mkdir, readdir, realpath, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, isAbsolute, join, parse, resolve, sep } from 'node:path'
import { promisify } from 'node:util'

import { repoKey, type RepoInfo, type Worktree, type WorktreeChanges } from '@harnessdesk/protocol'

import { defaultStateDir } from './state.js'
import { assertAbsolute } from './workspace.js'

import { parsePorcelain } from './porcelain.js'
import { HARDENED_GIT_CONFIG } from './git-hardening.js'
import { commonDir } from './git-ops.js'
import { withGitMutation } from './git-mutation.js'

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

interface CheckoutIdentity {
  readonly checkoutRoot: string
  readonly gitCommonDir: string
  readonly gitDir: string
}

/** Live metadata is evidence of an unchanged identity, never new shell authority. */
export const shellCheckoutIdentity = async (folder: string): Promise<CheckoutIdentity | null> => {
  try {
    // rev-parse has no NUL path mode. Read each payload separately and remove
    // only Git's final newline, preserving whitespace inside the path.
    const [common, dir, top] = await Promise.all(['--git-common-dir', '--git-dir', '--show-toplevel'].map(async (flag) =>
      (await run('git', ['-C', folder, ...HARDENED_GIT_CONFIG,
        'rev-parse', '--path-format=absolute', flag,
      ], {
        env: { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))), GIT_OPTIONAL_LOCKS: '0' },
        timeout: 20_000, maxBuffer: 1024 * 1024,
      })).stdout.replace(/\n$/, ''),
    ))
    if (!common || !dir || !top) return null
    const [gitCommonDir, gitDir, checkoutRoot] = await Promise.all([realpath(common), realpath(dir), realpath(top)])
    return { gitCommonDir, gitDir, checkoutRoot }
  } catch {
    return null
  }
}

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

/**
 * How many ignored entries travel on the wire. The count beside them is the
 * whole truth; this is what a dialog can read without becoming a listing.
 */
const SHOWN_IGNORED = 40

const plural = (count: number, noun: string): string => `${count} ${noun}${count === 1 ? '' : 's'}`

const describeChanges = (changes: WorktreeChanges): string => {
  const parts: string[] = []
  if (changes.modified > 0) parts.push(plural(changes.modified, 'modified file'))
  if (changes.untracked > 0) parts.push(plural(changes.untracked, 'untracked file'))
  if (changes.unpushedCommits > 0) parts.push(plural(changes.unpushedCommits, 'unpushed commit'))
  return parts.join(', ') || 'no changes'
}

/**
 * Git the host runs on its own — reading a checkout, cutting a lane for a
 * conversation or a flow — with the hardened floor (`git-hardening.ts`): no
 * hook or filesystem monitor the repository configures runs here. A hook
 * path a repository sets (husky's is a tracked folder) is one an agent in
 * that checkout can edit, so running hooks on an operation nobody asked for
 * would run agent-written code as the host.
 */
const git = async (cwd: string, args: readonly string[]): Promise<string> => {
  const { stdout } = await run('git', ['-C', cwd, ...HARDENED_GIT_CONFIG, ...args], {
    timeout: 30_000,
    maxBuffer: 8 * 1024 * 1024,
  })
  return stdout
}

/**
 * Git for a verb the person triggered themselves — bringing a branch home —
 * which runs with their hooks, as their own git would: a post-checkout hook
 * is how a repository sets itself up after a switch, and the person chose
 * this switch. Only the filesystem monitor is off, as it is for every read.
 */
const personGit = async (cwd: string, args: readonly string[]): Promise<string> => {
  const { stdout } = await run('git', ['-C', cwd, '-c', 'core.fsmonitor=false', ...args], {
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
  // The container exists before its path is canonicalised, or a first run
  // would name it through an unresolved link (`/var` for `/private/var`).
  await mkdir(join(stateDir, 'worktrees'), { recursive: true })
  return worktreeHomePath(repoRoot, stateDir)
}

/** The managed worktree container, without creating it; previews use this to predict future checkouts. */
export const worktreeHomePath = async (repoRoot: string, stateDir: string): Promise<string> => {
  const root = await canonical(repoRoot)
  const hash = createHash('sha256').update(root).digest('hex').slice(0, 10)
  return join(await canonical(join(stateDir, 'worktrees')), `${basename(root)}-${hash}`)
}

/** Where `create` would put a checkout of this name, predicted without creating anything. */
export const managedWorktreePath = async (repoPath: string, stateDir: string, name: string): Promise<string> => {
  const main = await repositoryRoot(repoPath)
  if (!main) throw new Error(`${repoPath} is not inside a git repository.`)
  return join(await worktreeHomePath(main, stateDir), slugify(name))
}

/** The main checkout for any path inside a repository or one of its worktrees. */
export const repositoryRoot = async (path: string): Promise<string | null> =>
  (await repositoryOf(path))?.root ?? null

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
  const checkout = await shellCheckoutIdentity(path)
  if (!checkout) return null
  const { gitCommonDir: common, gitDir: dir, checkoutRoot: here } = checkout
  if (samePath(dir, common)) {
    if (!await isMainCheckout(here, common)) return null
    return { root: here, worktree: false, ...(await originOf(path)) }
  }
  const main = await mainCheckoutOf(path, common)
  return main === null ? null : { root: main, worktree: true, ...(await originOf(path)) }
}

/**
 * The repository's identity, as `{ origin }` or nothing, so a repository with
 * no remote answers exactly as it always did.
 *
 * `remote get-url` rather than the config's own text: it applies the
 * `url.<base>.insteadOf` rewrites a person set up, so `gh:acme/widgets` and
 * `https://github.com/acme/widgets` are the repository git would reach, and
 * the same one. The answer is an identity (`repoKey`), not the URL — a remote
 * may carry a token, and nothing above this needs the address.
 */
const originOf = async (path: string): Promise<{ readonly origin: string } | null> => {
  try {
    const origin = repoKey((await git(path, ['remote', 'get-url', 'origin'])).trim())
    return origin === null ? null : { origin }
  } catch {
    // No remote called origin, or one git cannot read: this repository has no identity to share.
    return null
  }
}

/** A folder's own checkout metadata must agree with the repository that named it. */
const isMainCheckout = async (folder: string, common: string): Promise<boolean> => {
  const checkout = await shellCheckoutIdentity(folder)
  return checkout !== null && samePath(checkout.checkoutRoot, folder) &&
    samePath(checkout.gitCommonDir, common) && samePath(checkout.gitDir, common)
}

/** The first NUL-delimited `worktree` field is always the main one. */
const mainCheckoutOf = async (path: string, common: string): Promise<string | null> => {
  try {
    const porcelain = await git(path, ['worktree', 'list', '--porcelain', '-z'])
    const first = porcelain.split('\0').find((field) => field.startsWith('worktree '))
    if (first === undefined) return null
    const listed = first.slice('worktree '.length)
    const checkout = await shellCheckoutIdentity(listed)
    if (checkout) {
      const folder = checkout.checkoutRoot
      return await isMainCheckout(folder, common) ? folder : null
    }
    // A separate git directory may not record its working folder. Keep that
    // existing listing behavior, but refuse a recorded folder that is missing.
    const recorded = await git(path, ['config', '--get', 'core.worktree']).catch(() => null)
    return recorded === null ? await canonical(listed) : null
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

  /** A shell boundary is a captured project, its opened checkout or a managed lane, never caller metadata. */
  async shellRoot(project: string, candidate?: string, gitCommonDir: string | null = null, openedCheckoutRoot: string | null = null): Promise<string> {
    assertAbsolute(project)
    const root = await realpath(project)
    if (!samePath(root, project)) throw new Error('The project checkout changed its canonical location. Open it again before running shell commands.')
    if (samePath(root, parse(root).root) || samePath(root, await realpath(homedir()))) {
      throw new Error('The filesystem root or home directory cannot be a shell boundary. Open a project folder instead.')
    }
    if (!candidate || !isAbsolute(candidate)) return root
    try {
      const checkout = await realpath(candidate)
      if (samePath(checkout, parse(checkout).root) || samePath(checkout, await realpath(homedir()))) return root
      if (samePath(checkout, root)) return root
      const registered = (await this.list(root)).find((entry) =>
        samePath(entry.path, checkout) && (entry.managed || openedCheckoutRoot !== null && samePath(checkout, openedCheckoutRoot)))
      // A listing path replaced by a link no longer names the checkout it registered.
      if (!registered || !samePath(await realpath(registered.path), registered.path)) return root
      const repository = await shellCheckoutIdentity(checkout)
      // Only the identity captured at open authorizes a linked checkout.
      return repository && gitCommonDir && samePath(repository.checkoutRoot, checkout) && samePath(repository.gitCommonDir, gitCommonDir) ? checkout : root
    } catch {
      return root
    }
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

/**
 * Whether a worktree path reported by git is inside HarnessDesk's managed
 * worktree directory.
 *
 * Git reports paths with forward slashes on every platform, while Node's path
 * functions produce backslashes on Windows. On Windows only, separators and
 * casing are folded; POSIX backslashes are literal filename characters.
 */
export const isManagedWorktree = (worktreePath: string, home: string): boolean => {
  const isWin = process.platform === 'win32'
  const normPath = (isWin ? worktreePath.replace(/\\/g, '/') : worktreePath).replace(/\/+$/, '')
  const normHome = (isWin ? home.replace(/\\/g, '/') : home).replace(/\/+$/, '')
  const prefix = `${normHome}/`
  return isWin
    ? normPath.toLowerCase().startsWith(prefix.toLowerCase())
    : normPath.startsWith(prefix)
}

/** Canonical POSIX paths are exact; only Windows folds separators and casing. */
export const samePath = (a: string, b: string): boolean => {
  if (process.platform !== 'win32') return a === b
  const normalize = (path: string): string => path.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
  return normalize(a) === normalize(b)
}

export const parseWorktreeList = (porcelain: string, home: string, nul = false): Worktree[] => {
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
      managed: isManagedWorktree(current.path, home),
    })
    current = {}
  }
  for (const rawLine of porcelain.split(nul ? '\0' : '\n')) {
    const line = nul ? rawLine : rawLine.replace(/\r$/, '')
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

export const list = async (repoRoot: string, stateDir: string): Promise<Worktree[]> => {
  const main = await repositoryRoot(repoRoot)
  if (!main) return []
  const porcelain = await git(main, ['worktree', 'list', '--porcelain', '-z'])
  const home = await worktreeHome(main, stateDir)
  const entries = parseWorktreeList(porcelain, home, true)
  /* The first entry is the main checkout, but git names it by its git
     directory when that is not the folder someone works in: `.git/modules/<name>`
     for a submodule. The interface starts conversations in this path, opens it,
     and reads its changes, so it carries the folder `repositoryRoot` answered
     (from a linked checkout that is this same entry put through
     `--show-toplevel`). Where git cannot say — a `--separate-git-dir` checkout
     asked from one of its worktrees — the entry stays what git named. */
  const first = entries[0]
  if (first) {
    const folder = await mainEntryFolder(first.path, main)
    if (folder !== first.path) entries[0] = { ...first, path: folder }
  }
  return entries
}

/**
 * The folder the main entry of a worktree listing stands for. Where git named
 * the folder already, that is it. Where it named a git directory, the folder
 * is the one that directory's own work tree says (a submodule's
 * `core.worktree`), taken only if that folder's own metadata agrees with the
 * repository, as `mainCheckoutOf` requires; and only where git records none (a
 * `--separate-git-dir` checkout) is it the folder the listing was asked from.
 * Not simply the folder asked from: a `.git` file that names another
 * repository leaves that folder a checkout of it, and the main entry is still
 * the repository's own.
 */
export const mainEntryFolder = async (listed: string, asked: string): Promise<string> => {
  if (samePath(await canonical(listed), asked)) return listed
  const checkout = await shellCheckoutIdentity(listed)
  if (checkout && await isMainCheckout(checkout.checkoutRoot, checkout.gitCommonDir)) return checkout.checkoutRoot
  return asked
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
    ...heads.split(/[\r\n]+/).filter((line) => line.length > 0),
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

type CheckoutGitRunner = (
  command: string, args: readonly string[],
  options: { readonly timeout: number; readonly maxBuffer: number; readonly signal?: AbortSignal },
) => Promise<{ readonly stdout: string }>

/** A tree write has its own bound; ordinary Git reads keep their 30 s limit. */
const CHECKOUT_TIMEOUT_MS = 3 * 60_000

/** Wait for Git to exit even when AbortSignal rejects execFile before close,
 * so cleanup cannot race a child still writing the tree. */
const checkoutGit: CheckoutGitRunner = async (command, args, options) => {
  const pending = run(command, args, options)
  const closed = new Promise<void>((resolve) => pending.child.once('close', () => resolve()))
  try { return await pending } finally { await closed }
}

/**
 * A detached checkout of the repository at commit `at`, under HarnessDesk's
 * own worktree folder, cut with the hardened floor — no hook the repository
 * configures runs — for one run of a declared check a Seat asked for
 * (`run_check`, #1082). No branch is made; `remove` with `force` takes it
 * away after.
 */
export const createDetached = async (
  repoPath: string,
  options: { readonly name: string; readonly at: string; readonly stateDir: string; readonly timeoutMs?: number; readonly signal?: AbortSignal },
  execute: CheckoutGitRunner = checkoutGit,
): Promise<string> => {
  if (!/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(options.at)) throw new Error(`${options.at} is not a full commit id.`)
  const main = await repositoryRoot(repoPath)
  if (!main) throw new Error(`${repoPath} is not inside a git repository.`)
  const home = await worktreeHome(main, options.stateDir)
  await mkdir(home, { recursive: true })
  const path = join(home, `${slugify(options.name)}-${randomBytes(4).toString('hex')}`)
  const timeout = options.timeoutMs ?? CHECKOUT_TIMEOUT_MS
  try {
    await execute('git', ['-C', main, ...HARDENED_GIT_CONFIG, 'worktree', 'add', '--quiet', '--detach', path, options.at], {
      timeout, maxBuffer: 8 * 1024 * 1024, ...(options.signal ? { signal: options.signal } : {}),
    })
  } catch (error) {
    // The child has exited. Cleanup must run even when the caller's signal
    // is aborted, and even when add left too little metadata for remove.
    await git(main, ['worktree', 'remove', '--force', path]).catch(() => undefined)
    await rm(path, { recursive: true, force: true })
    await git(main, ['worktree', 'prune', '--expire', 'now'])
    if (options.signal?.aborted) throw new Error('Cutting the checkout was stopped.', { cause: error })
    const failure = error as { killed?: boolean; code?: string }
    if (failure?.killed && failure.code !== 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
      const limit = timeout >= 60_000 ? `${timeout / 60_000} minutes` : `${timeout} ms`
      throw new Error(`Cutting the checkout took longer than ${limit}.`, { cause: error })
    }
    throw error
  }
  return path
}

/** A `run_check` checkout's folder name: `createDetached`'s, for `check-<sha12>`. */
const CHECK_FOLDER = /^check-[0-9a-f]{12}-[0-9a-f]{8}$/

/**
 * The `run_check` checkouts a crash left behind (#1082): every `check-…`
 * folder in HarnessDesk's own worktree folder, removed with hardened git —
 * `worktree remove --force`, then `prune` — and the folder itself taken away
 * if git would not. Nothing else there is touched. Answers what it removed.
 */
export const removeCheckoutsLeftBehind = async (stateDir: string): Promise<string[]> => {
  const root = join(stateDir, 'worktrees')
  const removed: string[] = []
  let homes: string[]
  try {
    homes = await readdir(root)
  } catch {
    return removed
  }
  for (const home of homes) {
    let entries: string[]
    try {
      entries = await readdir(join(root, home))
    } catch {
      continue
    }
    for (const entry of entries.filter((name) => CHECK_FOLDER.test(name))) {
      const path = join(root, home, entry)
      let common: string | null = null
      try {
        common = (await git(path, ['rev-parse', '--path-format=absolute', '--git-common-dir'])).trim() || null
      } catch {
        common = null
      }
      if (common) {
        await run('git', ['--git-dir', common, ...HARDENED_GIT_CONFIG, 'worktree', 'remove', '--force', path], { timeout: 30_000 }).catch(() => undefined)
      }
      await rm(path, { recursive: true, force: true })
      if (common) await run('git', ['--git-dir', common, ...HARDENED_GIT_CONFIG, 'worktree', 'prune'], { timeout: 30_000 }).catch(() => undefined)
      removed.push(path)
    }
  }
  return removed
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
  /* What git ignores is not in `status` and goes anyway. `git worktree remove`
     deletes it without being forced and so does the `rm` that ends a
     bring-back, so a checkout holding an `.env` reads as clean here and is
     emptied silently. That `.env` was never in git, so nothing can put it
     back — which makes naming it the whole fix (#209). Read with directories
     collapsed, so `node_modules/` is one entry rather than thirty thousand. */
  const ignored = await ignoredIn(path)
  return {
    modified,
    untracked,
    unpushedCommits,
    files,
    ignored: ignored.slice(0, SHOWN_IGNORED),
    ignoredCount: ignored.length,
  }
}

/**
 * The main checkout of the repository a path is in, or null when it is in none,
 * refused when no open workspace is part of that repository. The verbs
 * that change a repository — removing one of its checkouts, switching its main
 * checkout's branch — answer to the boundary the rest of the git surface does:
 * the folders opened here (the projects the desk remembers and the folders of
 * live conversations). A worktree lives in the state directory,
 * outside every workspace, so what is confined is its repository, open as its
 * main checkout, as a folder inside it, or as the worktree itself — or sitting
 * inside an open folder, as it does for every other git read.
 *
 * The checkouts git lists are not the only ones that count. Git lists a
 * submodule's main checkout as its git directory, `<super>/.git/modules/<name>`,
 * and that of a checkout made with `--separate-git-dir` as the directory kept
 * apart from it, so compared with the listing alone either was refused when
 * opened on its own, and the refusal named the open folder as the project not
 * opened. The folder `repositoryRoot` names counts as well, but only when the
 * repository's database is open by the rule `#confineGitRoot` uses: it lies
 * inside that folder or an open root, or it is the database of an open
 * checkout (which is how a submodule or a separate git directory keeps its
 * `.git` outside its own folder). A folder whose `.git` file names a
 * repository elsewhere shares its database with nothing open, so it is refused
 * here as it is there, and so is the repository it names. A failed read of the
 * database refuses with the same try-again sentence; it is not read as "not
 * open", and it is not read when the listing already admits the path.
 *
 * A worktree of a `--separate-git-dir` checkout is still refused with only
 * that checkout open. From the worktree, git names the repository's main
 * checkout by its git directory, and nothing in git records the folder. Let
 * through, it would get no further: `remove` and `bringHome` list the
 * repository from that directory, and find no worktree there.
 */
export const openRepositoryRoot = async (path: string, roots: readonly string[]): Promise<string | null> => {
  // Before git reads it. `git -C` takes a relative path from the host's
  // working directory, wherever the app happened to be started, so the
  // repository judged below was that of a folder the request never named.
  assertAbsolute(path)
  const main = await repositoryRoot(path)
  if (!main) return null
  // Every checkout of the repository from one listing, then path arithmetic
  // against the open roots: no git per root, and the roots are resolved
  // together rather than one after another, so a refusal does not cost a
  // probe for every project the desk remembers.
  const porcelain = await git(main, ['worktree', 'list', '--porcelain'])
  const checkouts = await Promise.all(
    porcelain
      .split('\n')
      .map((l) => l.replace(/\r$/, ''))
      .filter((line) => line.startsWith('worktree '))
      .map((line) => canonical(line.slice('worktree '.length))),
  )
  const opened = await Promise.all(roots.map((root) => canonical(root)))
  const within = (inner: string, outer: string): boolean => {
    const isWin = process.platform === 'win32'
    const normInner = (isWin ? inner.replace(/\\/g, '/') : inner).replace(/\/+$/, '')
    const normOuter = (isWin ? outer.replace(/\\/g, '/') : outer).replace(/\/+$/, '')
    const prefix = `${normOuter}/`
    if (isWin ? normInner.toLowerCase() === normOuter.toLowerCase() : normInner === normOuter) return true
    return isWin
      ? normInner.toLowerCase().startsWith(prefix.toLowerCase())
      : normInner.startsWith(prefix)
  }
  const touches = (checkout: string): string[] =>
    opened.filter((root) => within(root, checkout) || within(checkout, root))
  if (checkouts.some((checkout) => touches(checkout).length > 0)) return main
  // The folder git did not list: a submodule's or a separate git directory's
  // own, or one whose `.git` file points somewhere else. It counts only when
  // the repository git resolves there is open too.
  const near = touches(main)
  if (near.length > 0) {
    const database = await commonDir(main)
    if (database !== null) {
      if (within(database, main) || opened.some((root) => within(database, root))) return main
      for (const root of near) if ((await commonDir(root)) === database) return main
      throw new Error(
        `${path} belongs to ${main}, where git resolves to a repository (${database}) that is not open here. ` +
          'Open that repository to work in it.',
      )
    }
  }
  throw new Error(`${path} belongs to ${main}, which is not a project opened here. Open it first.`)
}

/** `openRepositoryRoot` for the verbs that take a worktree, where a path in no repository is refused too. */
export const confineToOpenRepository = async (path: string, roots: readonly string[]): Promise<void> => {
  if ((await openRepositoryRoot(path, roots)) === null) throw new Error(`${path} is not a git worktree.`)
}

/**
 * Removes a worktree. Refuses, with the list of what would be lost, unless
 * `force` is set. The branch stays. Only worktrees HarnessDesk created are
 * removable from here: the person's own checkouts are not this app's to
 * delete, force or no force.
 */
export const remove = async (
  path: string,
  options: { readonly force?: boolean; readonly keepIgnored?: boolean; readonly keepDetached?: boolean;
    readonly expectedInventory?: string; readonly assertUnused?: () => void; readonly stateDir: string },
): Promise<{ readonly branch: string | null }> => {
  const main = await repositoryRoot(path)
  if (!main) throw new Error(`${path} is not a git worktree.`)
  const target = await canonical(path)
  const entry = (await list(main, options.stateDir)).find((candidate) => samePath(candidate.path, target))
  if (!entry) throw new Error(`${path} is not a worktree of ${main}.`)
  if (entry.isMain) throw new Error(`${path} is the main checkout and cannot be removed.`)
  if (!entry.managed) {
    throw new Error(`${path} was not created by HarnessDesk; remove it with git worktree remove yourself.`)
  }
  // With no branch retaining HEAD, even a clean checkout may be the only
  // reference to committed work. Cleanup and confirmed Discard both keep it.
  if (options.keepDetached && !entry.branch) throw new Error('The detached worktree has no branch retaining its commits. Create or check out a branch at its current commit before discarding it.')

  const pending = await changes(target)
  if (options.expectedInventory !== undefined && await worktreeInventoryKey(target) !== options.expectedInventory) throw new Error('The worktree changed. Review it again before discarding.')
  if (!options.force && (pending.modified > 0 || pending.untracked > 0 || options.keepIgnored && pending.ignoredCount > 0)) {
    throw new WorktreeDirtyError(target, pending)
  }
  // Admission can change during the asynchronous Git reads above. Check the
  // live owner at the mutation boundary, with no await before spawning Git.
  options.assertUnused?.()
  await git(main, ['worktree', 'remove', ...(options.force ? ['--force'] : []), target]).catch((error: unknown) => {
    throw new Error(`Git would not remove the worktree at ${target}. ${gitSaid(error)}`)
  })
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
 * repository to the ones opened here, and holds the move while a
 * conversation in the worktree is working.
 */
export const bringHome = async (
  path: string,
  options: { readonly stateDir: string },
): Promise<{ readonly branch: string; readonly from: string | null; readonly root: string; readonly warning?: string }> => {
  const main = await repositoryRoot(path)
  if (!main) throw new Error(`${path} is not a git worktree.`)
  return withGitMutation(main, () => bringHomeInCheckout(path, main, options))
}

const bringHomeInCheckout = async (
  path: string,
  main: string,
  options: { readonly stateDir: string },
): Promise<{ readonly branch: string; readonly from: string | null; readonly root: string; readonly warning?: string }> => {
  const target = await canonical(path)
  const entry = (await list(main, options.stateDir)).find((candidate) => samePath(candidate.path, target))
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
  await personGit(main, ['worktree', 'remove', target]).catch((error: unknown) => {
    // The first thing this changes, and git can refuse it — a locked worktree,
    // a submodule, a file written in between — before anything has moved.
    throw new Error(`${basename(main)} could not remove the worktree at ${target}, so nothing moved. ${gitSaid(error)}`)
  })
  let warning: string | undefined
  try {
    await personGit(main, ['checkout', entry.branch])
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

export const branchExists = async (root: string, branch: string): Promise<boolean> =>
  git(root, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`]).then(() => true, (error: unknown) => {
    if ((error as { code?: number }).code === 1) return false
    throw error
  })

/** Recreate the same managed path from its retained branch; no new branch. */
export const restore = async (root: string, path: string, branch: string, stateDir: string): Promise<void> => {
  const home = await worktreeHomePath(root, stateDir)
  if (!isManagedWorktree(path, home)) throw new Error('That path is not a managed worktree.')
  await mkdir(home, { recursive: true })
  await personGit(root, ['worktree', 'add', path, branch])
}

/** Full inventory, including entries beyond the display cap. */
export const worktreeInventoryKey = async (path: string): Promise<string> => {
  const status = await git(path, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignored=matching'])
  // Status may collapse a directory ignored as a whole. Include every ignored
  // file too, so adding one there invalidates a confirmation just like adding
  // an untracked file. NUL boundaries preserve whitespace in Git paths.
  const ignored = await git(path, ['ls-files', '--others', '--ignored', '--exclude-standard', '-z'])
  return createHash('sha256').update(status).update('\0').update(ignored).digest('hex')
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
export const putBack = async (
  main: string,
  target: string,
  branch: string,
  refused: unknown,
  stateDir: string,
  ignored: readonly string[],
  listFn: (main: string, stateDir: string) => Promise<Worktree[]> = list,
): Promise<never> => {
  const failed = await personGit(main, ['worktree', 'add', target, branch]).then(
    () => null,
    (error: unknown) => error,
  )
  const back = failed === null || (await listFn(main, stateDir).catch(() => [])).some((entry) => samePath(entry.path, target))
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
