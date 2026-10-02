import { realpathSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * Compare folder identity without changing its saved spelling. Seats use
 * canonical paths, while rooms and older records can retain an alias.
 * Missing historical folders keep their lexical identity. This is not an
 * admission check: callers enforcing an unchanged canonical location must
 * still compare the saved path with its current realpath directly.
 */
export const canonicalPath = (path: string): string => {
  try {
    return realpathSync.native(path)
  } catch {
    return resolve(path)
  }
}

export const sameCanonicalPath = (left: string, right: string): boolean =>
  canonicalPath(left) === canonicalPath(right)
