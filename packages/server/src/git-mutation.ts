import { execFile } from 'node:child_process'
import { realpath } from 'node:fs/promises'
import { promisify } from 'node:util'

import { HARDENED_GIT_CONFIG } from './git-hardening.js'

const run = promisify(execFile)
const mutations = new Map<string, Promise<void>>()

/**
 * A host move of HEAD owns the checkout until its result has been read back.
 * The worktree's Git directory is the key: subfolders and symlink spellings
 * share a queue, while separate worktrees can still work independently.
 */
export const withGitMutation = async <T>(root: string, operation: () => Promise<T>): Promise<T> => {
  const { stdout } = await run('git', ['-C', root, ...HARDENED_GIT_CONFIG, 'rev-parse', '--absolute-git-dir'], { timeout: 20_000 })
  const key = await realpath(stdout.replace(/\r?\n$/, ''))
  const previous = mutations.get(key)
  let release!: () => void
  const current = new Promise<void>(resolve => { release = resolve })
  mutations.set(key, current)
  if (previous) await previous
  try {
    return await operation()
  } finally {
    release()
    if (mutations.get(key) === current) mutations.delete(key)
  }
}
