import { watch, type FSWatcher } from 'node:fs'
import { readdir, realpath } from 'node:fs/promises'
import { basename, dirname, join, sep } from 'node:path'

/**
 * The one shape this module ever calls `node:fs`'s `watch` with: a path, a
 * plain `{ recursive, persistent }`, and a listener taking the raw event and
 * filename. Named apart from `typeof watch` — which is overloaded many ways
 * for callers this module is not — so a test's replacement can be an ordinary
 * function instead of satisfying every overload `watch` itself answers to.
 */
export type WatchFn = (
  dir: string,
  options: { readonly recursive: boolean; readonly persistent: boolean },
  listener: (event: string, filename: string | Buffer | null) => void,
) => FSWatcher

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
 * that does — and that itself stays inside whatever the root must stay inside —
 * is watched for the next name on the way down, and the root is followed from
 * the moment it appears, or reappears once a link that led out of a project is
 * replaced by a real folder. A fresh desk has no `agents` folder and most
 * projects have no `.harnessdesk`.
 *
 * A root's own top level is read once more, past the watch itself: a link
 * sitting directly in it is a folder the roster admits — a dotfiles checkout
 * linked into this machine's root, or a folder shared between projects and
 * linked into one of them — and FSEvents does not follow a link on its own, so
 * its target is watched too, wherever it leads for this machine's roots, and
 * only where it still resolves inside a project for one of those (a project's
 * own that leads out is left exactly as unwatched as the roster leaves it
 * unread). A link nested deeper than a root's own top level is not watched
 * either way — for a project that already follows from staying inside it; for
 * this machine's roots, which the roster does still read through such a link,
 * this is the one place watching falls short of reading.
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
  /** A watch this module could not make is logged once here, then retried on its own backoff. */
  readonly log?: (message: string, details?: unknown) => void
  /** Test-only: replaces `node:fs`'s `watch`. The host never passes this. */
  readonly watchFn?: WatchFn
  /**
   * Test-only: called the moment `#follow` has confirmed its scope is still
   * live, synchronously and before its own first `await` — the single point
   * from which a project closed a moment later races every await between
   * here and `#watch`. The host never passes this.
   */
  readonly onFollow?: (follow: { readonly scope: string | null; readonly target: string }) => void
}

const SETTLE_MS = 150
/** The backoff a watch that could not be made is retried on: doubling from here, capped below. */
const RETRY_MS = 200
const RETRY_MAX_MS = 5_000

/** One root the watch follows: whose it is, where it is, and what it must stay inside. */
interface Follow {
  /** Null for this machine's roots; the project as it was opened, for its own. */
  readonly scope: string | null
  readonly target: string
  /**
   * A project's real path, which nothing watched may lead out of — not the
   * Agent directory itself, not a folder in it, not a link's target. Null for
   * this machine's roots, which the person's own machine is trusted to link
   * however they like.
   */
  readonly within: string | null
}

const keyOf = (follow: Follow): string => `${follow.scope ?? ''}\u0000${follow.target}`

const inside = (real: string, within: string | null): boolean =>
  within === null || real === within || real.startsWith(within + sep)

const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error))

export class AgentWatch {
  readonly #options: AgentWatchOptions
  readonly #watchers = new Map<string, { readonly scope: string | null; readonly close: () => void }>()
  /** A root's own top-level links, watched at their target: keyed apart from `#watchers` so a rescan can diff them. */
  readonly #links = new Map<string, { readonly scope: string | null; readonly target: string; readonly close: () => void }>()
  readonly #timers = new Map<string | null, ReturnType<typeof setTimeout>>()
  /** A watch that could not be made, waiting on its backoff to retry through `#follow`. */
  readonly #retries = new Map<string, { readonly scope: string | null; readonly timer: ReturnType<typeof setTimeout> }>()
  /** How long the next retry for a key waits, doubling on each failure and reset on success. */
  readonly #retryDelay = new Map<string, number>()
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
    this.#projects = next
    /* Every project in `next` that holds no watcher is (re-)followed — not only
       ones newly added. A project missing at open holds none; if it is opened
       again later with the same set, this is what notices it now exists. Keyed
       replacement in `#watch` makes following an already-watched project again
       harmless, so nothing here needs to tell "new" apart from "reopened". */
    await Promise.all(
      next
        .filter((project) => ![...this.#watchers.values(), ...this.#links.values()].some((one) => one.scope === project))
        .map(async (project) => {
          const within = await realpath(project).catch(() => null)
          // A project that is not there has nothing to watch; opening it again re-points the watch, once it is.
          if (within === null) return
          await this.#follow({ scope: project, target: join(within, '.harnessdesk', 'agents'), within })
        }),
    )
  }

  dispose(): void {
    this.#disposed = true
    for (const one of this.#watchers.values()) one.close()
    this.#watchers.clear()
    for (const one of this.#links.values()) one.close()
    this.#links.clear()
    for (const timer of this.#timers.values()) clearTimeout(timer)
    this.#timers.clear()
    for (const one of this.#retries.values()) clearTimeout(one.timer)
    this.#retries.clear()
  }

  /** Whether `scope` is still one this watch should be doing any work for. */
  #alive(scope: string | null): boolean {
    return !this.#disposed && (scope === null || this.#projects.includes(scope))
  }

  #drop(scope: string | null): void {
    for (const [key, one] of [...this.#watchers]) {
      if (one.scope !== scope) continue
      one.close()
      this.#watchers.delete(key)
    }
    for (const [key, one] of [...this.#links]) {
      if (one.scope !== scope) continue
      one.close()
      this.#links.delete(key)
    }
    for (const [key, one] of [...this.#retries]) {
      if (one.scope !== scope) continue
      clearTimeout(one.timer)
      this.#retries.delete(key)
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
    this.#cancelRetry(keyOf(follow))
    this.#watchers.get(keyOf(follow))?.close()
    this.#watchers.delete(keyOf(follow))
    void this.#follow(follow)
  }

  #cancelRetry(key: string): void {
    const pending = this.#retries.get(key)
    if (pending) clearTimeout(pending.timer)
    this.#retries.delete(key)
  }

  /**
   * Logged once, then `#follow` is retried on a bounded, unref'd backoff that
   * `#drop` and `dispose()` cancel — so a watch that keeps failing (a
   * permission a person never grants, a mount that never returns) retries
   * without ever tightening into a loop, and a persistent watcher error
   * (`F9`) shares the same recovery path rather than refollowing at once.
   */
  #retry(follow: Follow, error: unknown): void {
    const key = keyOf(follow)
    this.#watchers.get(key)?.close()
    this.#watchers.delete(key)
    if (!this.#alive(follow.scope)) {
      this.#retryDelay.delete(key)
      return
    }
    this.#options.log?.('could not watch the roster; retrying', {
      scope: follow.scope,
      target: follow.target,
      error: errorMessage(error),
    })
    const delay = Math.min(this.#retryDelay.get(key) ?? RETRY_MS, RETRY_MAX_MS)
    this.#retryDelay.set(key, Math.min(delay * 2, RETRY_MAX_MS))
    const timer = setTimeout(() => {
      this.#retries.delete(key)
      void this.#follow(follow)
    }, delay)
    timer.unref?.()
    this.#retries.set(key, { scope: follow.scope, timer })
  }

  async #follow(follow: Follow): Promise<void> {
    if (!this.#alive(follow.scope)) return
    // Test-only: see `AgentWatchOptions.onFollow`. The host never sets it.
    this.#options.onFollow?.(follow)
    const real = await realpath(follow.target).catch(() => null)
    if (real !== null && inside(real, follow.within)) {
      this.#watch(follow, follow.target, true, () => {
        this.#poke(follow.scope)
        void this.#rescanLinks(follow)
        // A root that went away is looked for again from above.
        void realpath(follow.target).catch(() => this.#refollow(follow))
      })
      void this.#rescanLinks(follow)
      return
    }
    /* Not there, or there but leading outside the project — a link a project
       opened with is exactly the "not yet a real folder" case, so replacing it
       with one is noticed the same way a folder that did not exist yet is:
       the nearest folder above it that exists, and itself stays inside
       whatever this follow must stay inside, is watched for the next name on
       the way down. */
    let name = basename(follow.target)
    let above = dirname(follow.target)
    for (;;) {
      const seen = await realpath(above).catch(() => null)
      if (seen !== null) {
        if (!inside(seen, follow.within)) return
        const next = join(above, name)
        this.#watch(follow, above, false, (filename) => {
          if (filename !== null && filename !== name) return
          /* A bare name match is not proof that anything worth a notice
             happened: watching a folder that already holds an entry of this
             name — a link leading out, most of all — can report one on its
             own the moment the watch attaches, nothing having changed at all.
             So the name is looked at again, and only a *real* transition —
             it now there, and inside whatever this follow must stay inside —
             is a notice and a reason to follow afresh. `next`, not
             `follow.target`: a walk more than one level up asks about the
             name this ancestor is watching for, not the final target several
             names further down, which a real transition here need not have
             reached yet. */
          void realpath(next).then(
            (real) => {
              if (!inside(real, follow.within)) return
              this.#poke(follow.scope)
              this.#refollow(follow)
            },
            () => {
              // Still not there: no change worth a notice.
            },
          )
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
    this.#watchers.delete(key)
    this.#cancelRetry(key)
    /* A project closed while this follow's own awaits were pending gets no
       watcher, and any made a moment ago (above) is already closed: every
       await between here and `#follow`'s start can race `watchProjects`
       dropping the project mid-flight, and this one check, at the single
       place every one of those paths converges, covers all of them. */
    if (!this.#alive(follow.scope)) return
    const watchFn = this.#options.watchFn ?? watch
    try {
      const watcher = watchFn(dir, { recursive, persistent: false }, (_event, filename) =>
        onEvent(filename === null ? null : String(filename)),
      )
      watcher.on('error', (error) => this.#retry(follow, error))
      this.#watchers.set(key, { scope: follow.scope, close: () => watcher.close() })
      this.#retryDelay.delete(key)
    } catch (error) {
      this.#retry(follow, error)
    }
  }

  /**
   * A root's own top level, read again for the links directly in it (`F7`):
   * kept where a link already watched still points, closed where it no longer
   * exists or no longer resolves the same way, and opened fresh for one seen
   * for the first time. Nothing deeper than the top level is looked at.
   */
  async #rescanLinks(follow: Follow): Promise<void> {
    if (!this.#alive(follow.scope)) return
    let entries
    try {
      entries = await readdir(follow.target, { withFileTypes: true })
    } catch {
      // The root itself is gone; the main watch's own "gone" handling re-follows it.
      return
    }
    const wanted = new Map<string, string>()
    await Promise.all(
      entries
        .filter((entry) => entry.isSymbolicLink())
        .map(async (entry) => {
          const real = await realpath(join(follow.target, entry.name)).catch(() => null)
          if (real === null) return
          // This machine's roots follow a top-level link wherever it leads —
          // the person put it there themselves. A project's own is followed
          // only where it still resolves inside the project; one that leads
          // out is `F3`'s to refuse, and stays unwatched here exactly as the
          // roster leaves it unread.
          if (!inside(real, follow.within)) return
          wanted.set(entry.name, real)
        }),
    )
    if (!this.#alive(follow.scope)) return
    const prefix = `${keyOf(follow)}\u0000link:`
    for (const [key, existing] of [...this.#links]) {
      if (!key.startsWith(prefix)) continue
      if (wanted.get(key.slice(prefix.length)) === existing.target) continue
      existing.close()
      this.#links.delete(key)
    }
    const watchFn = this.#options.watchFn ?? watch
    for (const [name, target] of wanted) {
      if (!this.#alive(follow.scope)) return
      const key = `${prefix}${name}`
      if (this.#links.has(key)) continue
      try {
        const watcher = watchFn(target, { recursive: true, persistent: false }, () => this.#poke(follow.scope))
        watcher.on('error', () => {
          watcher.close()
          this.#links.delete(key)
          // Not this follow's own root, so it is not retried on its own backoff:
          // the next change at the top level — or the next rescan any other
          // event there triggers — looks at this name again.
        })
        this.#links.set(key, { scope: follow.scope, target, close: () => watcher.close() })
      } catch {
        // Gone between the look and the watch; the next rescan tries again.
      }
    }
  }
}
