import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

import { parsePorcelain } from './porcelain.js'
import type { GitFileStatus, GitStatus } from '@harnessdesk/protocol'

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

/** Returns null when `root` is not inside a repository, which is not an error. */
export const status = async (root: string): Promise<GitStatus | null> => {
  let top: string
  try {
    top = (await git(root, ['rev-parse', '--show-toplevel'])).trim()
  } catch {
    return null
  }

  const [branch, porcelain] = await Promise.all([
    git(top, ['rev-parse', '--abbrev-ref', 'HEAD']).then((out) => out.trim()).catch(() => null),
    git(top, ['status', '--porcelain=v1', '-z', '--untracked-files=normal']).catch(() => ''),
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

  return { root: top, branch: branch && branch !== 'HEAD' ? branch : null, ahead, behind, files }
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
