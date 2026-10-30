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

/** A description of a reported spelling, not an access or filesystem check. */
export type ReportedLocation = 'inside' | 'outside' | 'unknown'

const lexicalAbsolute = (input: string): string | null => {
  if (!input.trim() || input.startsWith('\\') || /[\x00-\x1f\x7f]/.test(input)) return null
  const path = input.replace(/\\/g, '/')
  if (path.startsWith('//')) return null
  const drive = /^[a-zA-Z]:\//.exec(path)?.[0]
  if (!drive && !path.startsWith('/')) return null
  const prefix = drive ?? '/'
  const parts: string[] = []
  for (const part of path.slice(prefix.length).split('/')) {
    if (!part || part === '.') continue
    if (part === '..') {
      if (!parts.length) return null
      parts.pop()
    } else parts.push(part)
  }
  return prefix + parts.join('/')
}

export const knownOpenRoots = (
  workspaces: readonly { readonly path: string }[],
  workspace: { readonly path: string } | null,
  sessionCwds: Iterable<string>,
  displayedCwd: string | null | undefined,
): string[] => {
  const candidates = [...workspaces.map(entry => entry.path), ...(workspace ? [workspace.path] : []), ...sessionCwds, ...(displayedCwd ? [displayedCwd] : [])]
  return candidates.flatMap(path => { const normalized = lexicalAbsolute(path); return normalized === null ? [] : [normalized] })
}

export const reportedLocation = (path: string, cwd: string | null | undefined, roots: readonly string[]): ReportedLocation => {
  if (!path.trim() || path.startsWith('\\') || /[\x00-\x1f\x7f]/.test(path)) return 'unknown'
  const spelling = path.replace(/\\/g, '/')
  let absolute = lexicalAbsolute(path)
  if (!absolute) {
    if (spelling.startsWith('/') || /^[a-zA-Z]:/.test(spelling)) return 'unknown'
    const base = cwd ? lexicalAbsolute(cwd) : null
    if (!base) return 'unknown'
    absolute = lexicalAbsolute(`${base.replace(/\/$/, '')}/${spelling}`)
  }
  const validRoots = roots.flatMap(root => { const normalized = lexicalAbsolute(root); return normalized === null ? [] : [normalized] })
  if (!absolute || !validRoots.length) return 'unknown'
  return validRoots.some(root => isPathInside(absolute!, root)) ? 'inside' : 'outside'
}
