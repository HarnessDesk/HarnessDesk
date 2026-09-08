import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

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
  // `-z` output is NUL-separated; renames add a second NUL-separated path that
  // must be consumed or every subsequent entry shifts.
  const entries = porcelain.split('\0')
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index]
    if (!entry || entry.length < 4) continue
    const staged = entry[0] ?? ' '
    const unstaged = entry[1] ?? ' '
    const path = entry.slice(3)
    if (staged === 'R' || unstaged === 'R') index += 1
    const code = staged !== ' ' && staged !== '?' ? staged : unstaged
    files.push({
      path,
      status: STATUS_CODES[code] ?? 'modified',
      staged: staged !== ' ' && staged !== '?',
    })
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
  const args = ['diff', '--no-color', '--no-ext-diff']
  if (options.staged) args.push('--cached')
  if (options.path) args.push('--', options.path)
  try {
    return await git(root, args)
  } catch {
    return ''
  }
}
