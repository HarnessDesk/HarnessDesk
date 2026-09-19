import { execFile } from 'node:child_process'
import { realpath, stat } from 'node:fs/promises'
import { resolve } from 'node:path'
import { promisify } from 'node:util'

import type { Freshness, Sha } from '@harnessdesk/protocol'

import { isRevisionName } from '../git-revision.js'
import { repositoryRoot } from '../worktree.js'
import { isSha } from './records.js'

/**
 * What git says about a checkout, for evidence: which commit a fact is bound
 * to, and how far its branch has moved since.
 *
 * Read-only, and read the way a background reader should: through `execFile`,
 * never a shell, and with `GIT_OPTIONAL_LOCKS=0`, so a status taken while an
 * agent is committing never holds the index lock the commit wants.
 */

const run = promisify(execFile)

const git = async (cwd: string, args: readonly string[]): Promise<string> => {
  const { stdout } = await run('git', ['-C', cwd, ...args], {
    timeout: 20_000,
    maxBuffer: 8 * 1024 * 1024,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
  })
  return stdout
}

/** A command's answer, or null when git refused — not a repository, no such ref. */
const gitOr = async (cwd: string, args: readonly string[]): Promise<string | null> => {
  try {
    return await git(cwd, args)
  } catch {
    return null
  }
}

/** Where a checkout is: its commit, the branch it is on, and whether it holds changes not committed. */
export interface Revision {
  readonly head: Sha
  readonly branch: string | null
  readonly dirty: boolean
}

/** The checkout's commit now, read once. Null outside a repository or before its first commit. */
export const headOf = async (cwd: string): Promise<Sha | null> => {
  const head = (await gitOr(cwd, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}']))?.trim() ?? ''
  return isSha(head) ? head : null
}

/** The rest of a revision's evidence metadata, bound to a commit already chosen by the caller. */
export const revisionAt = async (cwd: string, head: Sha): Promise<Revision> => {
  const branch = (await gitOr(cwd, ['symbolic-ref', '--quiet', '--short', 'HEAD']))?.trim() || null
  const status = await gitOr(cwd, ['status', '--porcelain=v1', '--untracked-files=normal'])
  return { head, branch, dirty: status === null || status.trim() !== '' }
}

/** Null outside a repository, or in one with no commit yet: there is no revision to bind a fact to. */
export const revisionOf = async (cwd: string): Promise<Revision | null> => {
  const head = await headOf(cwd)
  return head === null ? null : revisionAt(cwd, head)
}

/**
 * Where a fact's branch is now in its checkout — or HEAD, for a fact observed
 * on a detached HEAD. Null when the branch is gone, or the folder is not a
 * repository any more. A branch name read back from a record is checked before
 * git sees it.
 */
export const tipOf = async (cwd: string, branch: string | null): Promise<Sha | null> => {
  if (branch !== null && !isRevisionName(branch)) return null
  const ref = branch === null ? 'HEAD^{commit}' : `refs/heads/${branch}^{commit}`
  const tip = (await gitOr(cwd, ['rev-parse', '--verify', '--quiet', ref]))?.trim() ?? ''
  return isSha(tip) ? tip : null
}

/** A path as the filesystem resolves it, or as written when it is not there. */
export const canonical = async (path: string): Promise<string> => {
  try {
    return await realpath(path)
  } catch {
    return resolve(path)
  }
}

/**
 * The project a folder belongs to: its repository's main checkout, or the
 * folder itself when it is in no repository. The key a store is kept under.
 */
export const projectOf = async (folder: string): Promise<string> =>
  (await repositoryRoot(folder)) ?? (await canonical(folder))

/**
 * How a fact bound to `at` stands now, against its branch in its checkout.
 *
 * `dirty` is the fact's own: a check that ran on changes never committed is
 * about no commit at all, so it is stale however the branch moves. A checkout
 * that has gone, a branch that has gone, or a folder that is no longer a
 * checkout of the fact's project is `unknown` — and says which, because unknown
 * is not zero.
 *
 * `merged` is for the one fact that can be the last word on its branch: a
 * pull request that was merged. When its branch is gone — deleted after the
 * merge, as a forge usually does — nothing can land on it any more, and the
 * fact is `final` rather than unknown. Every other way it can stand is the same
 * as any fact's: commits after the merge leave it behind, and a rewrite moves it.
 */
export const freshnessOf = async (
  checkout: { readonly cwd: string; readonly branch: string | null },
  at: Sha,
  options: { readonly dirty?: boolean; readonly project?: string; readonly merged?: boolean } = {},
): Promise<Freshness> => {
  const there = await stat(checkout.cwd).then((info) => info.isDirectory(), () => false)
  if (!there) return { state: 'unknown', why: 'its checkout is gone' }
  if (options.project !== undefined && (await projectOf(checkout.cwd)) !== options.project) {
    return { state: 'unknown', why: 'its checkout is no longer part of this project' }
  }
  if (options.dirty) return { state: 'uncommitted' }
  const tip = await tipOf(checkout.cwd, checkout.branch)
  if (tip === null) {
    if (options.merged && checkout.branch !== null && (await revisionOf(checkout.cwd)) !== null) return { state: 'final' }
    return { state: 'unknown', why: checkout.branch === null ? 'it is not a repository any more' : `the branch ${checkout.branch} is gone` }
  }
  if (tip === at) return { state: 'fresh' }
  const ancestor = await gitOr(checkout.cwd, ['merge-base', '--is-ancestor', at, tip])
  if (ancestor === null) return { state: 'moved' }
  const count = Number((await gitOr(checkout.cwd, ['rev-list', '--count', `${at}..${tip}`]))?.trim())
  return Number.isInteger(count) && count > 0 ? { state: 'behind', commits: count } : { state: 'moved' }
}

/**
 * The branch a checkout's work is measured from: the remote's default branch
 * when the repository names one, else a local `main` or `master`. Null when
 * there is none of them — then there is nothing to measure a diff from.
 */
export const baseOf = async (cwd: string): Promise<string | null> => {
  const remote = (await gitOr(cwd, ['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD']))?.trim()
  if (remote && isRevisionName(remote)) return remote
  for (const name of ['main', 'master']) {
    if (await gitOr(cwd, ['rev-parse', '--verify', '--quiet', `refs/heads/${name}^{commit}`])) return `refs/heads/${name}`
  }
  return null
}

/** What a checkout's branch changes against its base, committed work only: the `diff` fact. */
export const diffOf = async (
  cwd: string,
): Promise<{ readonly files: number; readonly added: number; readonly removed: number; readonly from: Sha; readonly to: Sha } | null> => {
  const revision = await revisionOf(cwd)
  const base = await baseOf(cwd)
  if (!revision || !base) return null
  const from = (await gitOr(cwd, ['merge-base', base, revision.head]))?.trim() ?? ''
  if (!isSha(from)) return null
  const shortstat = (await gitOr(cwd, ['diff', '--shortstat', from, revision.head])) ?? ''
  const number = (pattern: RegExp): number => Number(pattern.exec(shortstat)?.[1] ?? 0)
  return {
    files: number(/(\d+) files? changed/),
    added: number(/(\d+) insertions?\(\+\)/),
    removed: number(/(\d+) deletions?\(-\)/),
    from,
    to: revision.head,
  }
}
