import { AsyncLocalStorage } from 'node:async_hooks'
import { realpathSync } from 'node:fs'
import { resolve } from 'node:path'

const computations = new AsyncLocalStorage<{ paths: Map<string, string> | null }>()

/**
 * One read computation shares folder identities, including after an await.
 * A new computation starts fresh: no TTL or watcher can leave a renamed,
 * removed or retargeted folder cached for the next list/event. Detached work
 * inherits the scope, but cannot keep its cache alive after the read ends.
 * Unchanged-location admission checks must still use realpath directly.
 */
export const withCanonicalPaths = <T>(read: () => T): T => {
  if (computations.getStore()?.paths) return read()
  const scope: { paths: Map<string, string> | null } = { paths: new Map() }
  const clear = () => { scope.paths = null }
  return computations.run(scope, () => {
    try {
      const result = read()
      if (result instanceof Promise) return result.finally(clear) as T
      clear()
      return result
    } catch (error) {
      clear()
      throw error
    }
  })
}

/**
 * Compare folder identity without changing its saved spelling. Seats use
 * canonical paths, while rooms and older records can retain an alias.
 * Missing historical folders keep their lexical identity. This is not an
 * admission check: callers enforcing an unchanged canonical location must
 * still compare the saved path with its current realpath directly.
 */
export const canonicalPath = (path: string): string => {
  const paths = computations.getStore()?.paths
  const cached = paths?.get(path)
  if (cached !== undefined) return cached
  let canonical: string
  try {
    canonical = realpathSync.native(path)
    // A native-resolved endpoint is already canonical in this computation.
    paths?.set(canonical, canonical)
  } catch {
    canonical = resolve(path)
  }
  paths?.set(path, canonical)
  return canonical
}

export const sameCanonicalPath = (left: string, right: string): boolean =>
  left === right || canonicalPath(left) === canonicalPath(right)
