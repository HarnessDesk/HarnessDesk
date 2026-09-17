import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

/** Existing tracked files, including staged additions but never local-only files. */
export const repositoryFiles = (root) =>
  execFileSync('git', ['ls-files', '--cached', '-z'], {
    cwd: root,
    encoding: 'utf8',
  })
    .split('\0')
    .filter((file) => file.length > 0 && existsSync(join(root, file)))
