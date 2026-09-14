/**
 * Re-exported, not re-implemented.
 *
 * `shortPath` is shared with the write engine, which prints the same paths
 * into the `---`/`+++` labels of every diff it previews — so it lives in the
 * protocol package that both sides already depend on. This file stays as the
 * name the renderer imports it under.
 */
export { shortPath } from '@harnessdesk/protocol'

/**
 * Whether `child` is identical to or within `parent`.
 *
 * Normalises separators and handles Windows drive letters and case insensitivity.
 */
export const isPathInside = (child: string, parent: string): boolean => {
  if (!child || !parent) return false
  const rawParent = parent.replace(/\\/g, '/')
  const normParent = rawParent.replace(/\/+$/, '') || (rawParent.startsWith('/') ? '/' : rawParent)
  const rawChild = child.replace(/\\/g, '/')
  const normChild = rawChild.replace(/\/+$/, '') || (rawChild.startsWith('/') ? '/' : rawChild)

  const isWin =
    (typeof process !== 'undefined' && process.platform === 'win32') ||
    (/^[a-zA-Z]:\//.test(normParent) && /^[a-zA-Z]:\//.test(normChild))

  if (isWin ? normChild.toLowerCase() === normParent.toLowerCase() : normChild === normParent) return true

  const prefix = normParent === '/' ? '/' : `${normParent}/`
  return isWin
    ? normChild.toLowerCase().startsWith(prefix.toLowerCase())
    : normChild.startsWith(prefix)
}

/**
 * Returns `path` relative to `root` if it is strictly inside `root`, or `path` unchanged.
 *
 * Normalises separators and handles Windows drive letters and case insensitivity.
 */
export const relativeTo = (path: string, root: string): string => {
  if (!path || !root) return path
  const rawRoot = root.replace(/\\/g, '/')
  const normRoot = rawRoot.replace(/\/+$/, '') || (rawRoot.startsWith('/') ? '/' : rawRoot)
  const rawPath = path.replace(/\\/g, '/')
  const normPath = rawPath.replace(/\/+$/, '') || (rawPath.startsWith('/') ? '/' : rawPath)

  const isWin =
    (typeof process !== 'undefined' && process.platform === 'win32') ||
    (/^[a-zA-Z]:\//.test(normRoot) && /^[a-zA-Z]:\//.test(normPath))

  const prefix = normRoot === '/' ? '/' : `${normRoot}/`
  const matches = isWin
    ? normPath.toLowerCase().startsWith(prefix.toLowerCase())
    : normPath.startsWith(prefix)

  return matches ? normPath.slice(prefix.length) : path
}
