import { createHash } from 'node:crypto'
import { lstat, readFile, readdir, stat, watch as fsWatch, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

import type {
  FileEntry,
  FileMatch,
  FileMetadata,
  RuntimeFiles,
  Unsubscribe,
} from '@harnessdesk/protocol'

/**
 * Workspace file services.
 *
 * Two halves. `LocalFiles` is HarnessDesk's own reader, the declared fallback
 * for a runtime that offers no filesystem view of its own; a runtime that
 * does (`AgentRuntime.files`) is preferred, so the person sees what the agent
 * sees and `@` mentions rank the way its other clients rank them. The
 * confinement below applies to both: neither reader is a sandbox, and the
 * renderer must not be able to read the user's home directory through the
 * host just because the socket is open.
 */

/**
 * Refuses a path that is not under one of the roots the user has opened.
 *
 * Lexical, on the resolved path: `..` segments are collapsed first, so
 * `root/../etc/passwd` is refused. A symlink inside a root that points
 * outside it is not caught here, because a runtime's reader resolves links on
 * its own side; that is a known limit, not an oversight.
 */
export const confine = (path: string, roots: readonly string[]): string => {
  if (!isAbsolute(path)) throw new Error(`${path} is not an absolute path.`)
  const target = resolve(path)
  const inside = roots.some((root) => {
    const base = resolve(root)
    return target === base || target.startsWith(base.endsWith(sep) ? base : base + sep)
  })
  if (!inside) {
    throw new Error(
      `${target} is outside every open workspace. Open its folder first to read from it.`,
    )
  }
  return target
}

const IGNORED_DIRECTORIES = new Set([
  '.git',
  'node_modules',
  'dist',
  'build',
  'out',
  'target',
  '.next',
  '.turbo',
  '.venv',
  'venv',
  '__pycache__',
  '.pytest_cache',
  'DerivedData',
  '.gradle',
  'Pods',
  '.idea',
  '.cache',
])

const MAX_FILES_SCANNED = 40_000
const MAX_DEPTH = 12

/**
 * Subsequence match with a bias toward matches on the file name and on segment
 * boundaries, which is what makes `usrsvc` find `src/user/service.ts`.
 */
export const fuzzyScore = (candidate: string, query: string): number | null => {
  if (query.length === 0) return 0
  const haystack = candidate.toLowerCase()
  const needle = query.toLowerCase()

  let score = 0
  let cursor = 0
  let previousIndex = -1

  for (const character of needle) {
    const index = haystack.indexOf(character, cursor)
    if (index === -1) return null
    // Consecutive characters are a much stronger signal than scattered ones.
    if (index === previousIndex + 1) score += 6
    const preceding = index > 0 ? haystack[index - 1] : sep
    if (preceding === sep || preceding === '-' || preceding === '_' || preceding === '.') score += 4
    if (index === 0) score += 4
    score += 1
    previousIndex = index
    cursor = index + 1
  }

  // Prefer shallower paths and shorter names among otherwise equal matches.
  const depth = candidate.split(sep).length
  return score - depth * 0.5 - candidate.length * 0.01
}

export interface SearchOptions {
  readonly limit?: number
  readonly signal?: AbortSignal
}

export const searchFiles = async (
  root: string,
  query: string,
  options: SearchOptions = {},
): Promise<FileMatch[]> => {
  const limit = options.limit ?? 40
  const results: FileMatch[] = []
  let scanned = 0

  const walk = async (directory: string, depth: number): Promise<void> => {
    if (depth > MAX_DEPTH || scanned >= MAX_FILES_SCANNED) return
    if (options.signal?.aborted) return

    let entries
    try {
      entries = await readdir(directory, { withFileTypes: true })
    } catch {
      return
    }

    for (const entry of entries) {
      if (scanned >= MAX_FILES_SCANNED) return
      if (entry.name.startsWith('.') && entry.name !== '.github') continue
      const full = join(directory, entry.name)
      if (entry.isDirectory()) {
        if (IGNORED_DIRECTORIES.has(entry.name)) continue
        await walk(full, depth + 1)
        continue
      }
      if (!entry.isFile()) continue
      scanned += 1
      const relativePath = relative(root, full)
      const score = fuzzyScore(relativePath, query)
      if (score === null) continue
      // A hit in the file name beats the same hit buried in a directory.
      const nameBonus = fuzzyScore(basename(relativePath), query) !== null ? 8 : 0
      results.push({ path: full, relativePath, score: score + nameBonus })
    }
  }

  await walk(resolve(root), 0)
  results.sort((a, b) => b.score - a.score)
  return results.slice(0, limit)
}

export const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex')

/** HarnessDesk's own reader, with the same shape a runtime's view has. */
export class LocalFiles implements RuntimeFiles {
  async write(path: string, data: Uint8Array): Promise<void> {
    await writeFile(path, data)
  }

  async search(roots: readonly string[], query: string, limit: number): Promise<readonly FileMatch[]> {
    const pages = await Promise.all(roots.map((root) => searchFiles(root, query, { limit })))
    return pages
      .flat()
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
  }

  async read(path: string): Promise<Uint8Array> {
    const info = await stat(path)
    if (!info.isFile()) throw new Error(`${path} is not a file`)
    return readFile(path)
  }

  async list(path: string): Promise<readonly FileEntry[]> {
    const found = await readdir(path, { withFileTypes: true })
    return found.map((entry) => ({
      name: entry.name,
      kind: entry.isDirectory() ? 'directory' : entry.isFile() ? 'file' : 'other',
    }))
  }

  async stat(path: string): Promise<FileMetadata> {
    /* `lstat` first, for the one thing only it can see: whether the path is a
       link. `stat` follows links, so `isSymbolicLink()` on its answer was
       always false (#77). The kind is still the target's — a link to a folder
       opens as a folder — and a link whose target is gone is 'other'. */
    const link = await lstat(path)
    const info = link.isSymbolicLink() ? await stat(path).catch(() => null) : link
    return {
      kind: info?.isDirectory() ? 'directory' : info?.isFile() ? 'file' : 'other',
      isSymlink: link.isSymbolicLink(),
      modifiedAt: (info ?? link).mtimeMs,
    }
  }

  /** Non-recursive, to match what a runtime's watch offers. */
  async watch(
    path: string,
    listener: (changedPaths: readonly string[]) => void,
  ): Promise<Unsubscribe> {
    const controller = new AbortController()
    void (async () => {
      try {
        for await (const event of fsWatch(path, { signal: controller.signal })) {
          if (event.filename) listener([join(path, String(event.filename))])
        }
      } catch {
        // Aborted, or the directory went away; either way the watch is over.
      }
    })()
    return () => controller.abort()
  }
}

const DEFAULT_MAX_BYTES = 2 * 1024 * 1024

/** Decodes a read as UTF-8 text, truncating past `maxBytes` rather than refusing. */
export const asText = (
  raw: Uint8Array,
  maxBytes = DEFAULT_MAX_BYTES,
): { content: string; truncated: boolean } => {
  const buffer = Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength)
  if (buffer.byteLength <= maxBytes) return { content: buffer.toString('utf8'), truncated: false }
  return { content: buffer.subarray(0, maxBytes).toString('utf8'), truncated: true }
}

/**
 * Lists the directories under a path, for the in-app folder picker.
 *
 * Directories only, and hidden ones omitted: this exists to choose a project
 * folder, not to browse a filesystem. Defaults to the user's home so the first
 * screen is somewhere they recognise. Deliberately not confined: its purpose
 * is to pick a root, and it reveals names only.
 */
export const browseDirectories = async (
  files: RuntimeFiles,
  path?: string,
): Promise<{
  path: string
  parent: string | null
  entries: { name: string; path: string }[]
}> => {
  const target = resolve(path && path.length > 0 ? path : homedir())
  const parent = dirname(target)
  let entries: { name: string; path: string }[] = []
  try {
    const found = await files.list(target)
    entries = found
      .filter((entry) => entry.kind === 'directory' && !entry.name.startsWith('.'))
      .map((entry) => ({ name: entry.name, path: join(target, entry.name) }))
      .sort((a, b) => a.name.localeCompare(b.name))
  } catch {
    // An unreadable directory lists as empty rather than failing the call —
    // the user can still navigate back out of it.
  }
  return { path: target, parent: parent === target ? null : parent, entries }
}

export const describeWorkspace = async (
  path: string,
): Promise<{ path: string; name: string }> => {
  const resolved = resolve(path)
  const info = await stat(resolved)
  if (!info.isDirectory()) throw new Error(`${resolved} is not a directory`)
  return { path: resolved, name: basename(resolved) || resolved }
}
