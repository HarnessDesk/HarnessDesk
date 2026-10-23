import { lstat, readlink, realpath } from 'node:fs/promises'
import { basename, dirname, join, parse, relative, resolve, sep, isAbsolute } from 'node:path'

import { errnoOf, NOTHING_HERE } from './errno.js'

/**
 * Where a path really leads, asked of the disk without waiting on it here.
 *
 * Every call below goes through `fs/promises`, so a volume that has stopped
 * answering holds one worker of the thread pool and not the host's own thread,
 * which would stop every request and every stream behind it. A signal ends the
 * walk between two calls; it cannot take back one already asked.
 */

/** The most links one walk to a destination follows; the kernel allows about as many. */
const MAX_LINKS = 40

const failure = (code: string, message: string): NodeJS.ErrnoException =>
  Object.assign(new Error(message), { code })

/** A link's target split into the names the kernel walks, which are not the names the text spells. */
const NAME_SEPARATOR = sep === '\\' ? /[\\/]+/ : /\/+/
const namesOf = (target: string): string[] => target.split(NAME_SEPARATOR).filter((name) => name !== '' && name !== '.')

/** Where a link at `path` points, or null when `path` is not a link (or is not there at all). */
const linkAt = async (path: string): Promise<string | null> => {
  try {
    return (await lstat(path)).isSymbolicLink() ? await readlink(path) : null
  } catch (error) {
    // `EINVAL` is a path that stopped being a link between the two calls.
    if (NOTHING_HERE.has(errnoOf(error)) || errnoOf(error) === 'EINVAL') return null
    throw error
  }
}

/**
 * Where a dangling link leads, walked the way the kernel walks it.
 *
 * `..` goes up from the folder the walk is in, which — after a link — is the
 * folder the link led to, never the folder the text before it names. Reading
 * `sub/../x` as text makes it a sibling of `sub`, wherever `sub` leads; the
 * kernel makes it a file beside the folder `sub` points at, which can be
 * outside the project that holds both links. So the walk starts at the link's
 * real parent (or at the root for an absolute target) and goes one name at a
 * time: a `..` takes the parent of the real folder reached so far, a name that
 * exists is replaced by its real path, and a link that does not lead anywhere
 * yet is followed in turn. Names are only appended once one is missing.
 */
const destinationOf = async (parent: string, target: string, signal?: AbortSignal): Promise<string> => {
  let real = isAbsolute(target) ? parse(target).root : parent
  const pending = namesOf(target)
  let followed = 1
  while (pending.length > 0) {
    signal?.throwIfAborted()
    const name = pending.shift()!
    if (name === '..') {
      real = dirname(real)
      continue
    }
    const next = join(real, name)
    try {
      real = await realpath(next)
      continue
    } catch (error) {
      if (!NOTHING_HERE.has(errnoOf(error))) throw error
    }
    const link = await linkAt(next)
    if (link === null) {
      // Nothing is here, so nothing below it can be reached either: the names that
      // follow are where it would be made, and a `..` among them has no folder to go up from.
      if (pending.includes('..')) throw failure('ENOENT', `${next} does not exist, so a ".." after it leads nowhere.`)
      return join(next, ...pending)
    }
    followed += 1
    if (followed > MAX_LINKS) throw failure('ELOOP', 'Too many links while resolving this path.')
    if (isAbsolute(link)) real = parse(link).root
    pending.unshift(...namesOf(link))
  }
  return real
}

/**
 * Resolve links through the deepest existing ancestor, retaining missing names.
 *
 * `realpath` here is `realpath(3)`, as `realpathSync.native` was: it keeps the
 * casing the disk has, which a turn's targets are compared in.
 */
export const canonicalTarget = async (path: string, signal?: AbortSignal): Promise<string> => {
  let ancestor = resolve(path)
  const missing: string[] = []
  for (;;) {
    signal?.throwIfAborted()
    try {
      return join(await realpath(ancestor), ...missing)
    } catch (error) {
      if (!NOTHING_HERE.has(errnoOf(error))) throw error
    }
    // A dangling link still names a destination; do not treat it as an absent file.
    const link = await linkAt(ancestor)
    if (link !== null) return join(await destinationOf(await realpath(dirname(ancestor)), link, signal), ...missing)
    const parent = dirname(ancestor)
    if (parent === ancestor) throw new Error('This path has no existing ancestor.')
    missing.unshift(basename(ancestor))
    ancestor = parent
  }
}

export const isWithinPath = (root: string, path: string): boolean => {
  const rel = relative(root, path)
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`))
}
