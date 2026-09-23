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

/**
 * The append-only Git logs whose unchanged identity proves a checkout did not
 * leave one HEAD and return to it. Null means that continuity cannot be
 * observed, so a run must fail closed rather than become revision evidence.
 */
export type HeadMark = string

const reflogMark = async (cwd: string, name: string): Promise<string | null> => {
  const path = (await gitOr(cwd, ['rev-parse', '--git-path', `logs/${name}`]))?.trim()
  if (!path) return null
  try {
    const info = await stat(resolve(cwd, path), { bigint: true })
    if (!info.isFile()) return null
    return `${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`
  } catch {
    return null
  }
}

/**
 * A monotonic mark for this worktree's HEAD and, when attached, its branch.
 * Ordinary Git ref moves append to one or both reflogs. Comparing the marks
 * therefore catches a move away and back that two SHA point samples cannot.
 */
export const headMarkOf = async (cwd: string, branch: string | null): Promise<HeadMark | null> => {
  const [head, attached] = await Promise.all([
    reflogMark(cwd, 'HEAD'),
    branch === null ? Promise.resolve(null) : reflogMark(cwd, `refs/heads/${branch}`),
  ])
  if (head === null || (branch !== null && attached === null)) return null
  return `${head}|${attached ?? 'detached'}`
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

/**
 * The remote's copy of the branch a checkout works on, when there is one:
 * what a pull brings into it. The branch's own configured upstream, whatever
 * it is called; else the remote's default branch as `origin/HEAD` — or any
 * remote's — names it. A local branch is never it.
 */
const upstreamOf = async (cwd: string): Promise<string | null> => {
  const tracked = (await gitOr(cwd, ['rev-parse', '--symbolic-full-name', '--verify', '--quiet', '@{upstream}']))?.trim()
  if (tracked && tracked.startsWith('refs/remotes/') && isRevisionName(tracked)) return tracked
  const heads = (await gitOr(cwd, ['for-each-ref', '--format=%(refname) %(symref)', 'refs/remotes/*/HEAD'])) ?? ''
  const named = heads.split('\n').map((line) => line.trim().split(' ')).filter((parts) => parts.length === 2 && parts[1])
  const origin = named.find((parts) => parts[0] === 'refs/remotes/origin/HEAD') ?? named[0]
  return origin && isRevisionName(origin[1]!) ? origin[1]! : null
}

/** Where the remote's copy of a checkout's branch stands now, as git last fetched it; null when there is none. */
export const upstreamTipOf = async (cwd: string): Promise<Sha | null> => {
  const upstream = await upstreamOf(cwd)
  if (!upstream) return null
  const tip = (await gitOr(cwd, ['rev-parse', '--verify', '--quiet', `${upstream}^{commit}`]))?.trim() ?? ''
  return isSha(tip) ? tip : null
}

/**
 * How a reflog entry says a commit was made in this checkout, rather than
 * brought into it: committed (a cherry-pick or revert finished by hand after
 * a conflict reads `commit (cherry-pick)`), picked, reverted, rebased, or a
 * patch applied with `git am`. A commit written by `commit-tree` and moved in
 * by `update-ref` leaves no such line, or only the one its caller wrote, so
 * it is not counted: the `diff` fact then reads short, never long.
 */
const MADE_HERE = /^(commit( \((amend|initial|merge|cherry-pick)\))?|cherry-pick|revert|am|[a-z -]*\((pick|reword|edit|squash|fixup)\)):/

/**
 * The commits this checkout's HEAD record says were made here — committed,
 * amended, picked, reworded — as opposed to brought in by a pull, a reset or
 * a checkout. Null when there is no such record to read.
 */
const madeHere = async (cwd: string): Promise<ReadonlySet<string> | null> => {
  const log = await gitOr(cwd, ['log', '-g', '--format=%H%x09%gs', '-n', '10000', 'HEAD', '--'])
  if (log === null || log.trim() === '') return null
  const out = new Set<string>()
  for (const line of log.split('\n')) {
    const tab = line.indexOf('\t')
    if (tab > 0 && MADE_HERE.test(line.slice(tab + 1))) out.add(line.slice(0, tab))
  }
  return out
}

/**
 * What a checkout's work changes, committed work only: the `diff` fact.
 *
 * Measured from `since` when it is given and the checkout's history leads
 * from it — the commit the card's holder was at when it took the card — as
 * the card's own work: the non-merge commits on the checkout's first-parent
 * line since then that were made in this checkout, as its own record of
 * HEAD's moves says. So a pull is not the step's work whether or not the
 * step has pushed since, a merge brings nothing of its own, and a Seat's
 * second card is measured from where that card began. With no such record
 * (reflogs off, or removed), what the remote's copy of the branch held when
 * the card was taken (`upstream`) is set aside instead — which keeps a push
 * of the step's own commits and cannot tell a later pull apart. What neither
 * can tell apart is whose commit it is: on a checkout several Seats share,
 * every commit made in it while the card was held counts. With no usable
 * `since`, what the branch changes against the base branch it came from —
 * nothing, on the base branch itself.
 */
export const diffOf = async (
  cwd: string,
  since: Sha | null = null,
  options: { readonly upstream?: Sha | null } = {},
): Promise<{ readonly files: number; readonly added: number; readonly removed: number; readonly from: Sha; readonly to: Sha } | null> => {
  const revision = await revisionOf(cwd)
  if (!revision) return null
  const began = since !== null && isSha(since) && (since === revision.head || (await gitOr(cwd, ['merge-base', '--is-ancestor', since, revision.head])) !== null)
    ? since : null
  if (began !== null) {
    const here = await madeHere(cwd)
    // Without the record, the remote as it stood when the card was taken; a card from before that was kept, the remote now.
    const setAside = here ? null
      : options.upstream !== undefined ? (options.upstream !== null && isSha(options.upstream) ? options.upstream : null)
        : await upstreamOf(cwd)
    const log = await gitOr(cwd, [
      'log', '--first-parent', '--no-merges', '--numstat', '--format=%x00%H', `${began}..${revision.head}`,
      ...(setAside ? ['--not', setAside] : []), '--',
    ])
    if (log === null) return null
    const files = new Set<string>()
    let added = 0
    let removed = 0
    for (const commit of log.split('\0').slice(1)) {
      const [sha, ...lines] = commit.split('\n')
      if (here && !here.has(sha!.trim())) continue
      for (const line of lines) {
        const found = /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(line)
        if (!found) continue
        files.add(found[3]!)
        added += found[1] === '-' ? 0 : Number(found[1])
        removed += found[2] === '-' ? 0 : Number(found[2])
      }
    }
    return { files: files.size, added, removed, from: began, to: revision.head }
  }
  const base = await baseOf(cwd)
  if (!base) return null
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
