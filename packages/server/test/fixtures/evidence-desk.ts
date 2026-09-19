import { execFile } from 'node:child_process'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'

import { tempDir } from '../scratch.js'

/**
 * What the evidence plane's tests stand on: a git repository made the way a
 * person would make one, as Jane Doe. Task 4 adds a desk beside it.
 */

const run = promisify(execFile)

export interface Repo {
  readonly dir: string
  /** git, in the repository, as Jane Doe. */
  git(...args: string[]): Promise<string>
}

/** A repository on `main` with one commit. */
export const makeRepo = async (prefix = 'hd-evidence-repo-'): Promise<Repo> => {
  const dir = tempDir(prefix)
  const git = async (...args: string[]): Promise<string> =>
    (await run('git', ['-C', dir, '-c', 'user.email=dev@example.com', '-c', 'user.name=Jane Doe', ...args])).stdout.trim()
  await git('init', '-q', '-b', 'main')
  await writeFile(join(dir, 'README.md'), 'hello\n')
  await git('add', '.')
  await git('commit', '-q', '-m', 'first')
  return { dir, git }
}
