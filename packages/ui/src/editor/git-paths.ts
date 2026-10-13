import type { GitStatus } from '@harnessdesk/protocol'

const folder = (path: string): string => path.replace(/\/+$/, '') || '/'
const relative = (root: string, path: string): string | null => {
  if (!root.startsWith('/') || !path.startsWith('/') || path.split('/').some(part => part === '..' || part === '.')) return null
  const base = folder(root), prefix = base === '/' ? '/' : `${base}/`
  return path === base ? '' : path.startsWith(prefix) ? path.slice(prefix.length) : null
}
const join = (root: string, path: string): string => `${folder(root) === '/' ? '' : folder(root)}/${path}`
const validFile = (path: string): boolean => !!path && !path.startsWith('/') && path.split('/').every(part => !!part && part !== '..' && part !== '.')

/** Only the host's request-local admission can identify a filesystem alias. */
export const repositoryPath = (root: string, path: string, git: GitStatus): string | null => {
  if (!path.startsWith('/')) return validFile(path) ? path : null
  let canonical = path
  if (git.resolvedRoot) {
    if (relative(git.root, git.resolvedRoot) === null) return null
    const local = relative(root, path)
    if (local !== null) canonical = join(git.resolvedRoot, local)
  }
  const result = relative(git.root, canonical)
  return result && validFile(result) ? result : null
}

/** Git paths return to the conversation's own spelling and stay within it. */
export const conversationPath = (root: string, path: string, git: GitStatus): string | null => {
  const file = path.replace(/\/$/, '')
  if (!validFile(file)) return null
  const resolved = git.resolvedRoot ?? root
  if (relative(git.root, resolved) === null) return null
  const local = relative(resolved, join(git.root, file))
  return local ? join(root, local) : null
}
