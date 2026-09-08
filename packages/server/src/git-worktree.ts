import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { realpath, rm } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve, sep } from 'node:path'
import { promisify } from 'node:util'

import type { GitWorktree, GitWorktreeCheckout, GitWorktreeInventory } from '@harnessdesk/protocol'

import { changes, worktreeHome, WorktreeDirtyError } from './worktree.js'

/**
 * Worktrees, as a git client manages them.
 *
 * `worktree.ts` is the session plane's: HarnessDesk cuts a disposable
 * checkout for a conversation, keeps it in its own directory, and refuses to
 * remove anything it did not make. This module is the repository's own view —
 * every checkout, whoever made it, with the verbs a person expects from a git
 * client: add, remove, prune, lock, move.
 *
 * Two of the refusals here are ours rather than git's, and both are about the
 * socket being a boundary rather than a formality:
 *
 * - **A new worktree lands beside the repository.** The destination resolves
 *   against the main checkout's parent directory and may not leave it. A path
 *   arriving over the wire is not a place this process will write just because
 *   it is well-formed, and "beside the repository" is where every git client
 *   suggests putting one anyway.
 * - **The main checkout is never removed.** Git already refuses it; saying so
 *   first means the person reads our sentence instead of git's.
 *
 * Everything else is git's own judgement, reported in git's own words: a
 * branch already checked out elsewhere, a locked worktree that will not move,
 * a directory that is not empty.
 */

const run = promisify(execFile)

/** Copying a tree out or deleting one is not a hang; give it room. */
const SLOW = 120_000

const git = async (cwd: string, args: readonly string[], timeout = 20_000): Promise<string> => {
  const { stdout } = await run('git', ['-C', cwd, ...args], { timeout, maxBuffer: 16 * 1024 * 1024 })
  return stdout
}

/**
 * Both streams, for the one verb that reports on the wrong one: `worktree
 * prune -v` names what it took on stderr, and reading only stdout would have
 * this module announce that it pruned nothing while git pruned three.
 */
const gitSaid = async (cwd: string, args: readonly string[]): Promise<string> => {
  const { stdout, stderr } = await run('git', ['-C', cwd, ...args], {
    timeout: 20_000,
    maxBuffer: 16 * 1024 * 1024,
  })
  return `${stdout}\n${stderr}`
}

/**
 * git's own reason, without the exec noise around it. Carriage returns split
 * too: a verb that draws progress overwrites its own line, and git's reason
 * then rides behind it — see the note on `plain` in `git-actions.ts`.
 */
const plain = (error: unknown): string => {
  const text = error instanceof Error ? error.message : String(error)
  const lines = text
    .split(/[\n\r]/)
    .map((line) => line.trim())
    .filter((line) => /^(error|fatal):/.test(line))
    .map((line) => line.replace(/^(error|fatal):\s*/, ''))
  return lines.length > 0 ? lines.join(' ') : (text.split('\n')[0] ?? text)
}

const fail = (doing: string, error: unknown): never => {
  throw new Error(`${doing}: ${plain(error)}`)
}

/**
 * Git reports real paths and the caller may not: on macOS `/var` is a link to
 * `/private/var`, and a worktree must not read as foreign over that.
 */
const canonical = async (path: string): Promise<string> => {
  try {
    return await realpath(path)
  } catch {
    return resolve(path)
  }
}

const under = (path: string, base: string): boolean =>
  path === base || path.startsWith(base.endsWith(sep) ? base : base + sep)

const exists = async (path: string): Promise<boolean> => {
  try {
    await realpath(path)
    return true
  } catch {
    return false
  }
}

// -------------------------------------------------------------------- list

/** One `worktree list --porcelain -z` record, before it is enriched. */
interface Listed {
  path: string
  head: string | null
  branch: string | null
  bare: boolean
  detached: boolean
  locked: { reason: string } | null
  prunable: { reason: string } | null
}

/**
 * Parses `worktree list --porcelain -z`. NUL-separated because a checkout's
 * path may contain a newline, and an empty field is the record boundary.
 */
const parseList = (out: string): Listed[] => {
  const records: Listed[] = []
  let current: Listed | null = null
  for (const field of out.split('\0')) {
    if (field.length === 0) {
      if (current) records.push(current)
      current = null
      continue
    }
    if (field.startsWith('worktree ')) {
      if (current) records.push(current)
      current = {
        path: field.slice('worktree '.length),
        head: null,
        branch: null,
        bare: false,
        detached: false,
        locked: null,
        prunable: null,
      }
      continue
    }
    if (!current) continue
    if (field.startsWith('HEAD ')) current.head = field.slice('HEAD '.length)
    else if (field.startsWith('branch ')) current.branch = field.slice('branch '.length).replace(/^refs\/heads\//, '')
    else if (field === 'detached') current.detached = true
    else if (field === 'bare') current.bare = true
    // `locked` and `prunable` carry a reason when git has one, and stand
    // alone when it does not — a hand-locked worktree usually has none.
    else if (field === 'locked') current.locked = { reason: '' }
    else if (field.startsWith('locked ')) current.locked = { reason: field.slice('locked '.length) }
    else if (field === 'prunable') current.prunable = { reason: '' }
    else if (field.startsWith('prunable ')) current.prunable = { reason: field.slice('prunable '.length) }
  }
  if (current) records.push(current)
  return records
}

/**
 * Everything removing this checkout would delete, and a digest of it.
 *
 * Two things live here that a status count alone misses. **Ignored files go
 * too**: `git worktree remove` deletes them without being forced, so a
 * checkout holding `.env.local` reads as clean and is emptied silently — the
 * inventory names them instead. And the **digest** is what a removal is
 * confirmed against: the caller echoes back the one it was shown, so work
 * that appeared between the looking and the clicking cannot be discarded on
 * the strength of a number that is no longer true.
 *
 * Ignored contents are asked for with directories collapsed — `node_modules/`
 * as one line rather than thirty thousand — which is both the readable answer
 * and the fast one.
 */
const SHOWN = 40

export const inventory = async (path: string): Promise<GitWorktreeInventory> => {
  const changes: { path: string; status: string }[] = []
  const ignored: string[] = []

  const out = await git(path, ['status', '--porcelain=v1', '-z', '--untracked-files=all'])
  const fields = out.split('\0')
  for (let index = 0; index < fields.length; index += 1) {
    const entry = fields[index]
    if (!entry || entry.length < 4) continue
    const status = entry.slice(0, 2)
    // A rename record is followed by its origin as its own field; one file.
    if (entry[0] === 'R' || entry[1] === 'R' || entry[0] === 'C') index += 1
    changes.push({ path: entry.slice(3), status })
  }

  // Ignored contents are their own call, without `--untracked-files=all`:
  // with it, git expands every file inside an ignored directory.
  const dirty = await git(path, ['status', '--porcelain=v1', '-z', '--ignored']).catch(() => '')
  for (const entry of dirty.split('\0')) {
    if (entry.startsWith('!! ')) ignored.push(entry.slice(3))
  }

  // Over the whole inventory, not the shown slice: a change beyond the cap
  // still has to invalidate a confirmation.
  const digest = createHash('sha256')
  for (const change of changes) digest.update(`${change.status}\u0000${change.path}\u0000`)
  for (const entry of ignored) digest.update(`!!\u0000${entry}\u0000`)

  return {
    changes: changes.slice(0, SHOWN),
    ignored: ignored.slice(0, SHOWN),
    changeCount: changes.length,
    ignoredCount: ignored.length,
    stateId: digest.digest('hex').slice(0, 32),
  }
}

/**
 * How many files a checkout is holding uncommitted, untracked included.
 * Null when the tree could not be read at all — a prunable entry whose
 * directory is gone — because that is not the same fact as a clean tree.
 */
const dirtyCount = async (path: string): Promise<number | null> => {
  try {
    const out = await git(path, ['status', '--porcelain=v1', '-z', '--untracked-files=all'])
    const fields = out.split('\0')
    let count = 0
    for (let index = 0; index < fields.length; index += 1) {
      const entry = fields[index]
      if (!entry || entry.length < 4) continue
      // A rename record is followed by its origin as its own field; one file.
      if (entry[0] === 'R' || entry[1] === 'R' || entry[0] === 'C') index += 1
      count += 1
    }
    return count
  } catch {
    return null
  }
}

/**
 * Every checkout of the repository `root` belongs to. Git lists the main
 * worktree first, which is how `isMain` is known; `managed` is asked of the
 * session plane's own directory, so a row can say what it is about to remove.
 */
export const list = async (root: string, stateDir: string): Promise<GitWorktree[]> => {
  const records = parseList(await git(root, ['worktree', 'list', '--porcelain', '-z']))
  if (records.length === 0) return []
  const here = await canonical(root)
  const main = records[0]!.path
  const home = await worktreeHome(main, stateDir)
  return Promise.all(
    records.map(async (record, index) => ({
      path: record.path,
      branch: record.branch,
      head: record.head,
      isMain: index === 0,
      isCurrent: (await canonical(record.path)) === here,
      bare: record.bare,
      detached: record.detached,
      locked: record.locked,
      prunable: record.prunable,
      managed: under(record.path, home),
      // A bare repository has no working tree to be dirty, and a prunable
      // entry has no directory left to read; neither is worth a git call.
      dirty: record.bare || record.prunable ? null : await dirtyCount(record.path),
    })),
  )
}

/** The one entry a verb is about, found by path however it was spelled. */
const find = async (worktrees: readonly GitWorktree[], path: string): Promise<GitWorktree | null> => {
  const target = await canonical(path)
  for (const entry of worktrees) {
    if ((await canonical(entry.path)) === target) return entry
  }
  return null
}

/**
 * The inventory for one of this repository's worktrees, by path. The lookup
 * is the confinement: a path this repository does not claim is refused
 * before anything reads inside it.
 */
export const inventoryOf = async (
  root: string,
  path: string,
  stateDir: string,
): Promise<GitWorktreeInventory> => {
  const entry = await find(await list(root, stateDir), path)
  if (!entry) throw new Error(`${path} is not a worktree of this repository.`)
  // A folder git has already lost holds nothing to lose.
  if (entry.prunable) {
    return { changes: [], ignored: [], changeCount: 0, ignoredCount: 0, stateId: 'gone' }
  }
  return inventory(await canonical(entry.path))
}

// ------------------------------------------------------------- destinations

/**
 * Where a worktree may land: beside the repository, under the main
 * checkout's parent. A relative path is read against that parent — which is
 * how the dialog offers it — and an absolute one must already be inside it.
 * A path inside another checkout is refused separately: git allows it, but
 * each tree then shows the other as untracked clutter forever.
 */
/**
 * The real path a destination names, resolving the links along the way.
 *
 * `realpath` refuses a path that does not exist yet, and a new worktree's
 * folder never does — so resolving it means finding the deepest ancestor
 * that *is* there, resolving that, and putting the missing components back.
 * Without this the containment test is lexical again, and a symlinked
 * ancestor walks straight out of it: with `beside/link -> /elsewhere`,
 * `link/added` passes the test and materialises in `/elsewhere/added`.
 */
const canonicalDestination = async (path: string): Promise<string> => {
  const target = resolve(path)
  const missing: string[] = []
  let walk = target
  for (;;) {
    try {
      return join(await realpath(walk), ...missing.reverse())
    } catch {
      const up = dirname(walk)
      // The root exists on any sane filesystem; this is the belt to that brace.
      if (up === walk) return target
      missing.push(walk.slice(up.length + 1))
      walk = up
    }
  }
}

const destination = async (
  worktrees: readonly GitWorktree[],
  path: string,
): Promise<string> => {
  const trimmed = path.trim()
  if (trimmed.length === 0) throw new Error('A worktree needs a folder to live in.')
  if (trimmed.startsWith('-')) throw new Error(`"${trimmed}" is not a usable folder name.`)
  const main = worktrees[0]?.path
  if (!main) throw new Error('This repository has no main checkout to sit beside.')
  const beside = dirname(await canonical(main))
  const target = await canonicalDestination(isAbsolute(trimmed) ? trimmed : resolve(beside, trimmed))
  if (target === beside || !under(target, beside)) {
    throw new Error(`New worktrees are made beside the repository, under ${beside}.`)
  }
  for (const entry of worktrees) {
    const existing = await canonical(entry.path)
    if (under(target, existing)) {
      throw new Error(
        `${target} is inside the checkout at ${entry.path}; a worktree beside it keeps the two out of each other's status.`,
      )
    }
  }
  if (await exists(target)) throw new Error(`${target} already exists.`)
  return target
}

// --------------------------------------------------------------------- add

/** A branch name, judged by git itself. */
const checkBranchName = async (root: string, name: string): Promise<void> => {
  if (name.startsWith('-')) throw new Error(`"${name}" is not a usable branch name.`)
  try {
    await git(root, ['check-ref-format', '--branch', name])
  } catch {
    throw new Error(`"${name}" is not a usable branch name.`)
  }
}

/** A revision this module will hand to git, confirmed to name a commit. */
const resolveCommitish = async (root: string, ref: string): Promise<string> => {
  if (!/^[\w][\w./@{}-]*$/.test(ref) || ref.includes('..')) {
    throw new Error(`"${ref}" is not a usable revision name.`)
  }
  try {
    return (await git(root, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`])).trim()
  } catch {
    throw new Error(`"${ref}" does not name a commit in this repository.`)
  }
}

/**
 * Adds a worktree: on a branch made for it, on one that already exists, or
 * detached at a commit. Git refuses a branch already checked out somewhere
 * else, and says where — that refusal is the right one, so it is passed on
 * rather than pre-empted.
 */
export const add = async (
  root: string,
  path: string,
  checkout: GitWorktreeCheckout,
  stateDir: string,
): Promise<{ path: string; branch: string | null }> => {
  const worktrees = await list(root, stateDir)
  const target = await destination(worktrees, path)

  let args: string[]
  let branch: string | null
  switch (checkout.kind) {
    case 'new': {
      await checkBranchName(root, checkout.branch)
      const base = checkout.base ? await resolveCommitish(root, checkout.base) : null
      args = ['worktree', 'add', '-b', checkout.branch, target, ...(base ? [base] : [])]
      branch = checkout.branch
      break
    }
    case 'existing': {
      await checkBranchName(root, checkout.branch)
      await resolveCommitish(root, checkout.branch)
      args = ['worktree', 'add', target, checkout.branch]
      branch = checkout.branch
      break
    }
    case 'detach': {
      const at = await resolveCommitish(root, checkout.at)
      args = ['worktree', 'add', '--detach', target, at]
      branch = null
      break
    }
    default:
      throw new Error('That is not a way to check a worktree out.')
  }

  // Checked again against the resolved path, immediately before the write:
  // between the test above and here, a link could have been laid down.
  if ((await canonicalDestination(target)) !== target) {
    throw new Error(`${target} moved while it was being checked; nothing was created.`)
  }
  try {
    await git(root, args, SLOW)
  } catch (error) {
    fail('Could not add the worktree', error)
  }
  return { path: target, branch }
}

/** What an inventory amounts to, in the words a refusal uses. */
const said = (held: GitWorktreeInventory): string => {
  const parts: string[] = []
  if (held.changeCount > 0) {
    parts.push(`${held.changeCount} uncommitted file${held.changeCount === 1 ? '' : 's'}`)
  }
  if (held.ignoredCount > 0) {
    parts.push(`${held.ignoredCount} ignored file${held.ignoredCount === 1 ? '' : 's'} or folder${held.ignoredCount === 1 ? '' : 's'}`)
  }
  return parts.join(' and ')
}

// ------------------------------------------------------------------ remove

/**
 * Removes a worktree. The main checkout refuses always; a worktree holding
 * uncommitted work refuses unless `force`, with the files named — the same
 * bargain the session plane makes, and the same error class, so the two
 * surfaces say it the same way. The branch is kept: cheap to keep, expensive
 * to lose, and `git branch -d` is one gesture away for a person who decided.
 */
export const remove = async (
  root: string,
  path: string,
  force: boolean,
  expect: string | undefined,
  stateDir: string,
): Promise<{ branch: string | null }> => {
  const worktrees = await list(root, stateDir)
  const entry = await find(worktrees, path)
  if (!entry) throw new Error(`${path} is not a worktree of this repository.`)
  if (entry.isMain) throw new Error('That is the repository’s main checkout; it cannot be removed.')
  if (entry.locked) {
    throw new Error(
      entry.locked.reason
        ? `That worktree is locked (${entry.locked.reason}). Unlock it first.`
        : 'That worktree is locked. Unlock it first.',
    )
  }

  const target = await canonical(entry.path)
  // A prunable entry has no directory left to read, so there is nothing to
  // lose and nothing to ask about; git drops the record on its own.
  if (!entry.prunable) {
    const held = await inventory(target).catch(() => null)
    const loses = held !== null && (held.changeCount > 0 || held.ignoredCount > 0)

    // Anything worth losing has to be confirmed against the inventory the
    // caller actually saw. `force` says "discard tracked work"; this says
    // "and here is exactly what I was shown" — without it, a boolean minted
    // from a stale count is standing authority over whatever is there now.
    if (loses) {
      if (!expect) {
        throw new Error(
          `${target} has ${said(held)} in it. Read what is there and confirm the removal against it.`,
        )
      }
      if (expect !== held.stateId) {
        throw new Error(
          `${target} changed since you looked — it now has ${said(held)}. Check again before removing it.`,
        )
      }
    }

    const pending = await changes(target).catch(() => null)
    if (!force && pending && (pending.modified > 0 || pending.untracked > 0)) {
      throw new WorktreeDirtyError(target, pending)
    }
  }
  try {
    await git(root, ['worktree', 'remove', ...(force ? ['--force'] : []), target], SLOW)
  } catch (error) {
    fail('Could not remove the worktree', error)
  }
  // Some git versions leave the emptied directory behind; nothing of value
  // is in it by now, and leaving it would make the folder look still-there.
  await rm(target, { recursive: true, force: true }).catch(() => {})
  return { branch: entry.branch }
}

// ------------------------------------------------------------------- prune

/**
 * Drops the administrative records of worktrees whose directories are gone.
 * The dry run first is what lets the summary name them: `prune` itself is
 * silent about what it took unless asked, and "pruned 3" with no names is a
 * worse answer than the list.
 */
export const prune = async (root: string): Promise<{ summary: string; removed: string[] }> => {
  let removed: string[] = []
  try {
    const preview = await gitSaid(root, ['worktree', 'prune', '--dry-run', '-v'])
    removed = preview
      .split('\n')
      .map((line) => /^Removing (?:worktrees\/)?(.+?):/.exec(line.trim())?.[1] ?? null)
      .filter((name): name is string => name !== null)
    if (removed.length === 0) return { summary: 'Nothing to prune — every worktree is where git left it.', removed }
    await git(root, ['worktree', 'prune'])
  } catch (error) {
    fail('Could not prune', error)
  }
  return {
    summary: `Pruned ${removed.length} stale worktree record${removed.length === 1 ? '' : 's'}: ${removed.join(', ')}.`,
    removed,
  }
}

// -------------------------------------------------------------------- lock

/**
 * Locks a worktree against pruning, or unlocks it. The reason is git's own
 * field and comes back on the listing, so a checkout on a removable drive
 * can say why it is pinned.
 */
export const setLock = async (
  root: string,
  path: string,
  locked: boolean,
  reason: string | undefined,
  stateDir: string,
): Promise<void> => {
  const entry = await find(await list(root, stateDir), path)
  if (!entry) throw new Error(`${path} is not a worktree of this repository.`)
  if (entry.isMain) throw new Error('The main checkout is never pruned, so it cannot be locked.')
  const target = await canonical(entry.path)
  const said = reason?.trim()
  try {
    await git(
      root,
      locked
        ? ['worktree', 'lock', ...(said && said.length > 0 ? ['--reason', said] : []), target]
        : ['worktree', 'unlock', target],
    )
  } catch (error) {
    fail(locked ? 'Could not lock the worktree' : 'Could not unlock the worktree', error)
  }
}

// -------------------------------------------------------------------- move

/**
 * Moves a worktree's directory, keeping git's record of it correct — which
 * is the whole reason this is a git verb and not a rename in Finder. The
 * destination obeys the same "beside the repository" rule an added one does.
 */
export const move = async (
  root: string,
  from: string,
  to: string,
  stateDir: string,
): Promise<{ path: string }> => {
  const worktrees = await list(root, stateDir)
  const entry = await find(worktrees, from)
  if (!entry) throw new Error(`${from} is not a worktree of this repository.`)
  if (entry.isMain) throw new Error('The main checkout is not moved with git worktree move.')
  const target = await destination(worktrees, to)
  if ((await canonicalDestination(target)) !== target) {
    throw new Error(`${target} moved while it was being checked; nothing was moved.`)
  }
  try {
    await git(root, ['worktree', 'move', await canonical(entry.path), target], SLOW)
  } catch (error) {
    fail('Could not move the worktree', error)
  }
  return { path: target }
}
