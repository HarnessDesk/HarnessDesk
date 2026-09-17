import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

/** Tracked and untracked, non-ignored files that currently exist in a checkout. */
export const repositoryFiles = (root) =>
  execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], {
    cwd: root,
    encoding: 'utf8',
  })
    .split('\0')
    .filter((file) => file.length > 0 && existsSync(join(root, file)))
