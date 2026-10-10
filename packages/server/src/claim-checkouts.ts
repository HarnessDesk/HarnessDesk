import { execFileSync } from 'node:child_process'
import { isAbsolute } from 'node:path'
import { HARDENED_GIT_CONFIG } from './git-hardening.js'
import { canonicalPath } from './path-identity.js'

/**
 * A claim comparison stays synchronous with the board transaction. Resolve
 * the checkout Git actually names, including subfolders and linked worktrees;
 * a missing or unreadable checkout cannot establish that two claims differ.
 * The caller caches these bounded reads only for this comparison.
 */
export const claimCheckout = (cwd: string): string | null => {
  try {
    const root = execFileSync('git', ['-C', cwd, ...HARDENED_GIT_CONFIG,
      'rev-parse', '--path-format=absolute', '--show-toplevel'], {
      encoding: 'utf8', timeout: 2_000, maxBuffer: 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))), GIT_OPTIONAL_LOCKS: '0' },
    }).replace(/\n$/, '')
    return isAbsolute(root) ? canonicalPath(root) : null
  } catch {
    return null
  }
}
