import { lstatSync, readlinkSync, realpathSync } from 'node:fs'
import { dirname, join, relative, resolve, sep, isAbsolute } from 'node:path'

/** Resolve links through the deepest existing ancestor, retaining missing names. */
export const canonicalTarget = (path: string, links = 0): string => {
  if (links > 40) throw new Error('Too many links while resolving this path.')
  let ancestor = resolve(path)
  const missing: string[] = []
  for (;;) {
    try {
      return join(realpathSync.native(ancestor), ...missing)
    } catch (error) {
      if (!['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error
    }
    // A dangling link still names a destination; do not treat it as an absent file.
    const info = (() => {
      try { return lstatSync(ancestor) } catch (error) {
        if (!['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error
        return null
      }
    })()
    if (info?.isSymbolicLink()) {
      return join(canonicalTarget(resolve(realpathSync.native(dirname(ancestor)), readlinkSync(ancestor)), links + 1), ...missing)
    }
    const parent = dirname(ancestor)
    if (parent === ancestor) throw new Error('This path has no existing ancestor.')
    missing.unshift(relative(parent, ancestor))
    ancestor = parent
  }
}

export const isWithinPath = (root: string, path: string): boolean => {
  const rel = relative(root, path)
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`))
}
