import { watch } from 'node:fs'
import { realpath } from 'node:fs/promises'
import { basename, dirname, join, sep } from 'node:path'

/**
 * The roster, watched: when a file under one of its roots changes, the desk
 * says so, and every listing and dry run drawn from the roster is asked again.
 *
 * This machine's root and the built-in one are watched for as long as the host
 * runs. A project's `.harnessdesk/agents` is watched while the project is
 * open, and only where it resolves inside the project: the roster never reads
 * through a link that leads out of a project, and a watch there would be a way
 * of learning when something outside it changed.
 *
 * A root that does not exist yet is not an error. The nearest folder above it
 * that does is watched for the next name on the way down, and the root is
 * followed from the moment it appears — a fresh desk has no `agents` folder
 * and most projects have no `.harnessdesk`.
 *
 * Nothing is read here. The notice says only whose Agents may have changed;
 * the listing is still `Agents.list`, with every rule it has. And a burst of
 * changes — an editor's save is several — is one notice.
 */

export interface AgentWatchOptions {
  /** This machine's roster and the built-in one, watched for as long as the host runs. */
  readonly roots: readonly string[]
  /** Once per settled burst: the project whose own Agents changed, or null for the roots above. */
  readonly changed: (project: string | null) => void
  /** How long a burst is gathered before its one notice goes out. */
  readonly settleMs?: number
}

const SETTLE_MS = 150

/** One root the watch follows: whose it is, where it is, and what it must stay inside. */
interface Follow {
  /** Null for this machine's roots; the project as it was opened, for its own. */
  readonly scope: string | null
  readonly target: string
  /** A project's real path, which nothing watched may lead out of; null where links are followed. */
  readonly within: string | null
}

const keyOf = (follow: Follow): string => `${follow.scope ?? ''}\u0000${follow.target}`

const inside = (real: string, within: string | null): boolean =>
  within === null || real === within || real.startsWith(within + sep)

export class AgentWatch {
  readonly #options: AgentWatchOptions
  readonly #watchers = new Map<string, { readonly scope: string | null; readonly close: () => void }>()
  readonly #timers = new Map<string | null, ReturnType<typeof setTimeout>>()
  #projects: readonly string[] = []
  #disposed = false

  constructor(options: AgentWatchOptions) {
    this.#options = options
    for (const root of options.roots) void this.#follow({ scope: null, target: root, within: null })
  }

  /** Points the watch at exactly these projects: new ones are watched, ones no longer open are let go. */
  async watchProjects(projects: readonly string[]): Promise<void> {
    const next = [...new Set(projects)]
    for (const gone of this.#projects.filter((one) => !next.includes(one))) this.#drop(gone)
    const added = next.filter((one) => !this.#projects.includes(one))
    this.#projects = next
    await Promise.all(
      added.map(async (project) => {
        const within = await realpath(project).catch(() => null)
        // A project that is not there has nothing to watch; opening it again re-points the watch.
        if (within === null) return
        await this.#follow({ scope: project, target: join(within, '.harnessdesk', 'agents'), within })
      }),
    )
  }

  dispose(): void {
    this.#disposed = true
    for (const one of this.#watchers.values()) one.close()
    this.#watchers.clear()
    for (const timer of this.#timers.values()) clearTimeout(timer)
    this.#timers.clear()
  }

  #drop(scope: string | null): void {
    for (const [key, one] of [...this.#watchers]) {
      if (one.scope !== scope) continue
      one.close()
      this.#watchers.delete(key)
    }
    const timer = this.#timers.get(scope)
    if (timer) clearTimeout(timer)
    this.#timers.delete(scope)
  }

  /** One notice per burst, per scope. */
  #poke(scope: string | null): void {
    if (this.#disposed) return
    const pending = this.#timers.get(scope)
    if (pending) clearTimeout(pending)
    const timer = setTimeout(() => {
      this.#timers.delete(scope)
      if (!this.#disposed) this.#options.changed(scope)
    }, this.#options.settleMs ?? SETTLE_MS)
    // Unref'd like every other coalescing timer in this host (`CatalogRefresher`,
    // `Flows`'s check timeout): a notice that has not yet settled must never be
    // the reason a quit — or this process — waits. `dispose()` is what actually
    // cancels it; this only keeps a *live* one from holding the loop open.
    timer.unref?.()
    this.#timers.set(scope, timer)
  }

  /** Stops whatever follows this root now, and follows it again from wherever it can be seen. */
  #refollow(follow: Follow): void {
    this.#watchers.get(keyOf(follow))?.close()
    this.#watchers.delete(keyOf(follow))
    void this.#follow(follow)
  }

  async #follow(follow: Follow): Promise<void> {
    if (this.#disposed) return
    if (follow.scope !== null && !this.#projects.includes(follow.scope)) return
    const real = await realpath(follow.target).catch(() => null)
    if (real !== null) {
      if (!inside(real, follow.within)) return
      this.#watch(follow, follow.target, true, () => {
        this.#poke(follow.scope)
        // A root that went away is looked for again from above.
        void realpath(follow.target).catch(() => this.#refollow(follow))
      })
      return
    }
    // Not there yet: the nearest folder above that is, watched for the next name on the way down.
    let name = basename(follow.target)
    let above = dirname(follow.target)
    for (;;) {
      const seen = await realpath(above).catch(() => null)
      if (seen !== null) {
        if (!inside(seen, follow.within)) return
        this.#watch(follow, above, false, (filename) => {
          if (filename !== null && filename !== name) return
          this.#poke(follow.scope)
          this.#refollow(follow)
        })
        return
      }
      if (dirname(above) === above) return
      name = basename(above)
      above = dirname(above)
    }
  }

  #watch(follow: Follow, dir: string, recursive: boolean, onEvent: (filename: string | null) => void): void {
    if (this.#disposed) return
    const key = keyOf(follow)
    // Two follows of one root can race; the later watch replaces the earlier, never beside it.
    this.#watchers.get(key)?.close()
    try {
      const watcher = watch(dir, { recursive, persistent: false }, (_event, filename) =>
        onEvent(filename === null ? null : String(filename)),
      )
      watcher.on('error', () => this.#refollow(follow))
      this.#watchers.set(key, { scope: follow.scope, close: () => watcher.close() })
    } catch {
      // Gone between the look and the watch: the next change above it looks again.
      this.#watchers.delete(key)
    }
  }
}
