import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'

import { isAgentFolderName, type AgentRoots } from './agents.js'
import { within } from './seat-reads.js'

/**
 * The roster's own folders, as places a file may be read or written by path.
 *
 * This machine's Agents root and the built-in one are host-owned, and an
 * Agent folder linked into them — a dotfiles checkout, say — or its `AGENT.md`
 * linked to a file elsewhere is admitted as a root of its own, because the
 * roster reads it. Finding those takes a listing of the root and a `stat` of
 * every folder's source, and a file request used to do that, synchronously,
 * every time: for the renderer's three-second poll of every open editor tab,
 * and on the host's own thread, where a link onto a volume that had stopped
 * answering stopped every request and every stream with it.
 *
 * So it is read off the thread, once, and kept. A reading stands until
 * `ttlMs` is up or `invalidate()` is told the roster changed (the host does
 * that whenever it says `agent/changed`); a reading in flight is shared, so
 * a stalled volume is asked once and not once per request. Whoever asks waits
 * for a reading no longer than `waitMs` in all, and is answered with the last
 * reading, or with the root alone, when it is not in: a folder not yet seen
 * is not admitted, which is the safe way for a slow disk to be wrong.
 */

const AGENT_ROOTS_TTL_MS = 5_000
const AGENT_ROOTS_WAIT_MS = 2_000

const SOURCE = 'AGENT.md'

/** The two reads a listing makes; a test replaces them. */
export interface AgentFileReads {
  readonly entries: (folder: string) => Promise<readonly { readonly name: string; isDirectory(): boolean; isSymbolicLink(): boolean }[]>
  /** Whether the path, followed through links, is a file. */
  readonly isFile: (path: string) => Promise<boolean>
}

const diskReads: AgentFileReads = {
  entries: (folder) => readdir(folder, { withFileTypes: true }),
  isFile: async (path) => (await stat(path)).isFile(),
}

export interface AgentFileRootsOptions {
  /** Read when asked, never at construction: the host holds its roots after it is made. */
  readonly roots: () => AgentRoots
  readonly ttlMs?: number
  readonly waitMs?: number
  readonly reads?: AgentFileReads
  readonly now?: () => number
}

interface Cached {
  readonly roots: string[]
  readonly at: number
  /** False once the roster is known to have changed. Still the best answer while a newer one is read. */
  fresh: boolean
}

interface InFlight {
  readonly reading: Promise<string[]>
  readonly startedAt: number
}

export class AgentFileRoots {
  readonly #options: AgentFileRootsOptions
  readonly #reads: AgentFileReads
  readonly #cached = new Map<string, Cached>()
  readonly #inFlight = new Map<string, InFlight>()

  constructor(options: AgentFileRootsOptions) {
    this.#options = options
    this.#reads = options.reads ?? diskReads
  }

  /** This machine's roots, and the built-in one for reading only: nobody edits what ships. */
  async list(mode: 'read' | 'write'): Promise<string[]> {
    const { user, builtin } = this.#options.roots()
    const [mine, shipped] = await Promise.all([this.#of(user), mode === 'read' ? this.#of(builtin) : []])
    return [...mine, ...shipped]
  }

  /** The roster changed: what was read is stale, and a reading still in flight is not trusted to be current. */
  invalidate(): void {
    this.#inFlight.clear()
    for (const cached of this.#cached.values()) cached.fresh = false
  }

  async #of(root: string): Promise<string[]> {
    const now = this.#now()
    const kept = this.#cached.get(root)
    if (kept?.fresh && now - kept.at < (this.#options.ttlMs ?? AGENT_ROOTS_TTL_MS)) return kept.roots
    const flight = this.#inFlight.get(root) ?? this.#begin(root, now)
    // A reading already late is not waited for again: the first request paid for it.
    const remaining = Math.max(0, (this.#options.waitMs ?? AGENT_ROOTS_WAIT_MS) - (now - flight.startedAt))
    const answered = await within(() => flight.reading, remaining)
    return answered.settled === 'value' ? answered.value : (kept?.roots ?? [root])
  }

  #begin(root: string, startedAt: number): InFlight {
    const flight: InFlight = { reading: this.#read(root).catch(() => [root]), startedAt }
    this.#inFlight.set(root, flight)
    void flight.reading.then((roots) => {
      // A reading that was invalidated while it ran describes a roster that has since changed.
      if (this.#inFlight.get(root) !== flight) return
      this.#inFlight.delete(root)
      this.#cached.set(root, { roots, at: this.#now(), fresh: true })
    })
    return flight
  }

  #now(): number {
    return (this.#options.now ?? Date.now)()
  }

  /** A root that cannot be listed is a root with nothing linked into it. */
  async #read(root: string): Promise<string[]> {
    let entries
    try {
      entries = await this.#reads.entries(root)
    } catch {
      return [root]
    }
    const folders = await Promise.all(
      entries
        .filter((entry) => isAgentFolderName(entry.name) && (entry.isDirectory() || entry.isSymbolicLink()))
        .map(async (entry) => {
          const folder = join(root, entry.name)
          const source = join(folder, SOURCE)
          // An absent or unreadable source grants no additional root.
          const isFile = await Promise.resolve().then(() => this.#reads.isFile(source)).catch(() => false)
          return isFile ? [folder, source] : [folder]
        }),
    )
    return [root, ...folders.flat()]
  }
}
