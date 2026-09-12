import { execFile } from 'node:child_process'
import { access } from 'node:fs/promises'
import { resolve } from 'node:path'
import { promisify } from 'node:util'

import { parsePorcelain } from './porcelain.js'
import type { GitConclusion, GitFileStatus, GitStatus } from '@harnessdesk/protocol'

/** Git status and diffs for the changes view. Read-only: nothing here mutates a repo. */

const run = promisify(execFile)

const git = async (root: string, args: string[]): Promise<string> => {
  const { stdout } = await run('git', ['-C', root, ...args], {
    timeout: 20_000,
    maxBuffer: 32 * 1024 * 1024,
  })
  return stdout
}

const STATUS_CODES: Record<string, GitFileStatus['status']> = {
  M: 'modified',
  A: 'added',
  D: 'deleted',
  R: 'renamed',
  C: 'added',
  U: 'conflicted',
  '?': 'untracked',
}

/** The states git reports while a merge is unresolved (git-status(1), "Short Format"). */
const UNMERGED = new Set(['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU'])

/**
 * The pseudo-refs `git commit` looks for, and what each says it is
 * concluding. In git's order: `determine_whence` reads `MERGE_HEAD` first
 * and asks the sequencer afterwards.
 */
const CONCLUSIONS = [
  ['MERGE_HEAD', 'merge'],
  ['CHERRY_PICK_HEAD', 'cherry-pick'],
  ['REVERT_HEAD', 'revert'],
] as const satisfies readonly (readonly [string, GitConclusion])[]

/**
 * What a commit in this repository would conclude, or `null` for an ordinary
 * one — the evidence a commit's *shape* is chosen on, so that the choice is
 * never inferred from something else.
 *
 * These are the files `git commit` itself consults to decide what it is
 * finishing, so asking the same question of the same files cannot disagree
 * with git about the answer. Asked through `rev-parse --git-path`, which
 * finds them where they actually are: inside a linked worktree `.git` is a
 * file, the pseudo-refs live in that worktree's own directory under the main
 * repository, and `<root>/.git/MERGE_HEAD` would miss every merge.
 *
 * Measured on git 2.50.1: a partial commit is refused outright while
 * `MERGE_HEAD` exists ("cannot do a partial commit during a merge") or
 * `CHERRY_PICK_HEAD` does ("… during a cherry-pick"). A revert's is not —
 * `git commit` never reads `REVERT_HEAD` — but the partial commit it takes
 * there clears the pseudo-ref and records a commit that says it is the
 * revert while holding only part of it, so all three are reported alike and
 * `commitAll` treats them alike.
 */
export const concluding = async (root: string): Promise<GitConclusion | null> => {
  const args = CONCLUSIONS.flatMap(([file]) => ['--git-path', file])
  const printed = await git(root, ['rev-parse', ...args]).catch(() => '')
  const where = printed
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
  if (where.length !== CONCLUSIONS.length) return null
  for (const [index, [, what]] of CONCLUSIONS.entries()) {
    const path = resolve(root, where[index] ?? '')
    const there = await access(path).then(
      () => true,
      () => false,
    )
    if (there) return what
  }
  return null
}

/** Returns null when `root` is not inside a repository, which is not an error. */
export const status = async (root: string): Promise<GitStatus | null> => {
  let top: string
  try {
    top = (await git(root, ['rev-parse', '--show-toplevel'])).trim()
  } catch {
    return null
  }

  const [branch, porcelain, underway] = await Promise.all([
    git(top, ['rev-parse', '--abbrev-ref', 'HEAD']).then((out) => out.trim()).catch(() => null),
    git(top, ['status', '--porcelain=v1', '-z', '--untracked-files=normal']).catch(() => ''),
    concluding(top),
  ])

  const files: GitFileStatus[] = []
  for (const entry of parsePorcelain(porcelain)) {
    /* One entry per column that says something. A file can be in both at
       once — `MM` is a change staged and another made on top of it, `AM` a
       new file edited after `git add` — and read as one entry the index
       letter won, so the working tree's change was in no view at all (#31). */
    if (UNMERGED.has(entry.index + entry.worktree)) {
      /* A merge's own states. The conflict is resolved in the working tree,
         so that is where the file is, once: read by its index letter it was
         listed as staged, whose diff for it is only "* Unmerged path". */
      files.push({ path: entry.path, status: 'conflicted', staged: false })
      continue
    }
    if (entry.index !== ' ' && entry.index !== '?') {
      files.push({ path: entry.path, status: STATUS_CODES[entry.index] ?? 'modified', staged: true })
    }
    if (entry.worktree !== ' ') {
      files.push({ path: entry.path, status: STATUS_CODES[entry.worktree] ?? 'modified', staged: false })
    }
  }

  let ahead = 0
  let behind = 0
  try {
    const counts = await git(top, ['rev-list', '--left-right', '--count', '@{upstream}...HEAD'])
    const [behindText, aheadText] = counts.trim().split(/\s+/)
    behind = Number(behindText ?? 0)
    ahead = Number(aheadText ?? 0)
  } catch {
    // No upstream configured; leaving both at zero is the honest answer.
  }

  return {
    root: top,
    branch: branch && branch !== 'HEAD' ? branch : null,
    ahead,
    behind,
    files,
    concluding: underway,
  }
}

export const diff = async (
  root: string,
  options: { readonly path?: string; readonly staged?: boolean } = {},
): Promise<string> => {
  // The a/ and b/ every reader of a patch expects, whatever diff.noprefix or diff.mnemonicPrefix says (#171).
  const args = ['diff', '--no-color', '--no-ext-diff', '--src-prefix=a/', '--dst-prefix=b/']
  if (options.staged) args.push('--cached')
  if (options.path) args.push('--', options.path)
  try {
    return await git(root, args)
  } catch {
    return ''
  }
}
