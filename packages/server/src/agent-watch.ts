import { watch, type FSWatcher } from 'node:fs'
import { readdir, realpath } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path'

import { resolveWithin } from './agents.js'

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

/** A timer handle this module can cancel; a fake clock's handle need not be a real one. */
export interface ClockTimer {
  readonly unref?: () => void
}

/**
 * The one shape this module ever schedules a delay through: every settle
 * timer (`#poke`, `#scheduleRescan`) and the retry backoff (`#retry`) go
 * through this rather than calling `setTimeout`/`clearTimeout` directly, so a
 * test can hold time still while a real burst of filesystem events lands —
 * however unevenly a loaded machine spaces them out — and then move it
 * forward itself, in one step, to settle the burst on its own terms instead
 * of racing a real window against real load.
 */
export interface Clock {
  readonly setTimeout: (callback: () => void, ms: number) => ClockTimer
  readonly clearTimeout: (timer: ClockTimer) => void
}

const realClock: Clock = {
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (timer) => clearTimeout(timer as NodeJS.Timeout),
}

/**
 * The roster, watched: when a file under one of its roots changes, the desk
 * says so, and every listing and dry run drawn from the roster is asked again.
 *
 * This machine's root and the built-in one are watched for as long as the host
 * runs. A project's `.harnessdesk/agents` is watched while the project is
 * open, and only as the roster reads it. Every path in a project — the Agent
 * directory, a folder above it, a link in it — is judged by the roster's own
 * walk (`resolveWithin` in `agents.ts`), which goes step by step from the
 * project's real path and never looks outside it, so a link that leaves the
 * project is refused even where it comes back. The roster never reads through
 * a link that leads out of a project, and a watch there would be a way of
 * learning when something outside it changed.
 *
 * A root that is not there yet is not an error, and neither is one that leads
 * where the roster will not read. The nearest folder above it that is there,
 * and inside whatever the root must stay inside, is watched for the next name
 * on the way down. A folder on the way that is missing, or that leads out of
 * the project, is walked past and never watched — for a project, up to its own
 * folder and never above it. The root is followed from the moment it appears,
 * or from the moment a link on the way that led out of the project is replaced
 * by a real folder. A fresh desk has no `agents` folder and most projects have
 * no `.harnessdesk`.
 *
 * A root's own top level is read once more, past the watch itself: a link
 * sitting directly in it is a folder the roster admits — a dotfiles checkout
 * linked into this machine's root, or a folder shared between projects and
 * linked into one of them — and FSEvents does not follow a link on its own, so
 * its target is watched too: wherever it leads for this machine's roots, and
 * for a project only where the roster's walk keeps it inside. These link
 * watchers live and die with their root, and of two readings of a top level
 * only the later one is applied.
 *
 * Deeper links are read but not watched. The roster reads through a link at
 * any depth below a root — a folder linked inside an Agent's folder, an
 * `AGENT.md` that is itself a link — wherever for this machine's roots, and
 * inside the project for a project's. This watch follows only the links
 * directly in a root's top level, so a change at a deeper link's target raises
 * no notice. That is a known limit.
 *
 * No Agent is read here. The notice says only whose Agents may have changed;
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
  /**
   * A watch that could not be made, or that failed once it was, is retried on
   * its own backoff and logged here once for each run of failures — from the
   * first failure after it last worked until it works again — never once per
   * attempt.
   */
  readonly log?: (message: string, details?: unknown) => void
  /** Test-only: replaces `node:fs`'s `watch`. The host never passes this. */
  readonly watchFn?: WatchFn
  /**
   * Test-only: replaces every `setTimeout`/`clearTimeout` this watch
   * schedules — both settle timers and the retry backoff. The host never
   * passes this; it defaults to the real clock.
   */
  readonly clock?: Clock
  /**
   * Test-only: called the moment `#follow` has confirmed its scope is still
   * live, synchronously and before its own first `await` — the single point
   * from which a project closed a moment later races every await between
   * here and `#watch`. The host never passes this.
   */
  readonly onFollow?: (follow: { readonly scope: string | null; readonly target: string }) => void
  /**
   * Test-only: awaited by a reading of a root's top-level links once it has
   * read them and before it applies what it read — the one gap in which a
   * later reading can overtake it. The host never passes this.
   */
  readonly onRescan?: (follow: { readonly scope: string | null; readonly target: string }) => Promise<void> | void
}

const SETTLE_MS = 150
/** The backoff a failed watch is retried on: doubling from here, capped below, for as long as it keeps failing. */
const RETRY_MS = 200
const RETRY_MAX_MS = 5_000

/** One root the watch follows: whose it is, where it is, and what it must stay inside. */
interface Follow {
  /** Null for this machine's roots; the project as it was opened, for its own. */
  readonly scope: string | null
  readonly target: string
  /**
   * A project's real path, which nothing watched may lead out of — not the
   * Agent directory itself, not a folder above it, not a link's target — by
   * the roster's own walk. Null for this machine's roots, which the person's
   * own machine is trusted to link however they like.
   */
  readonly within: string | null
}

const keyOf = (follow: Follow): string => `${follow.scope ?? ''}\u0000${follow.target}`

/** What every link watcher of one root is keyed under, so a root can find — and close — its own. */
const linksOf = (key: string): string => `${key}\u0000link:`

const inside = (real: string, within: string | null): boolean =>
  within === null || real === within || real.startsWith(within + sep)

const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error))

/**
 * Where `path` leads by the rule the roster reads it by, or null where nothing
 * is there or the rule refuses it.
 *
 * For this machine's roots, the system's own answer: their links go wherever
 * the person put them. For a project, the roster's own walk, from the
 * project's real path and never outside it, so the watch and the roster agree
 * on every link. The system's answer is asked too, but only once the walk has
 * said "inside" — so it looks nowhere a link out could lead — and it must
 * agree: the walk trusts `within` to still be the project's real path, and a
 * watch is where a wrong answer would become a notice about somewhere else.
 */
const reach = async (path: string, within: string | null): Promise<string | null> => {
  if (within === null) return realpath(path).catch(() => null)
  const rest = relative(within, path)
  if (isAbsolute(rest) || rest === '..' || rest.startsWith(`..${sep}`)) return null
  let reached
  try {
    reached = await resolveWithin(within, within, rest === '' ? [] : rest.split(sep))
  } catch {
    return null
  }
  if (reached.to !== 'inside') return null
  const real = await realpath(reached.path).catch(() => null)
  return real !== null && inside(real, within) ? real : null
}

/**
 * Whether recursively watching `real` would also cover a project's own
 * Agents folder — `follow.target`, always inside `follow.within` — from
 * above: the project root itself, when a link resolves there
 * (`.harnessdesk/agents -> ..`), or any folder between the root and the
 * Agents folder still inside the project (`.harnessdesk/agents/x -> ../..`,
 * a link one level short of the root). `real === follow.target` — the
 * ordinary case, a real folder or a link to one that is not an ancestor of
 * itself — is never this: a proper ancestor is what is dangerous, because a
 * recursive watch there also covers everything else beside the Agents
 * folder, `node_modules` and `.git` included, at whatever cost that subtree
 * has to offer on every change in it.
 *
 * Always false for this machine's own roots (`follow.within === null`):
 * there is no shared Agents folder above them to protect, and the person's
 * own links are trusted wherever they lead, exactly as `reach` already
 * trusts them.
 */
const coversAgentsFolder = (real: string, follow: Follow): boolean =>
  follow.within !== null && follow.target.startsWith(real + sep)

export class AgentWatch {
  readonly #options: AgentWatchOptions
  readonly #watchers = new Map<string, { readonly scope: string | null; readonly close: () => void }>()
  /** A root's own top-level links, watched at their target: keyed under the root's own key (`linksOf`). */
  readonly #links = new Map<string, { readonly scope: string | null; readonly target: string; readonly close: () => void }>()
  readonly #clock: Clock
  readonly #timers = new Map<string | null, ClockTimer>()
  /**
   * A root's own re-scan of its top-level links, still pending: reset on
   * every accepted event from its recursive watch, so it runs once per
   * settled burst rather than once per file underneath it. Keyed like
   * `#watchers` (`keyOf`), not by scope alone — this machine's own roots
   * share `scope: null` between them, and each root's rescan settles on its
   * own.
   */
  readonly #rescanTimers = new Map<string, { readonly scope: string | null; readonly timer: ClockTimer }>()
  /** A watch that could not be made, waiting on its backoff to retry through `#follow`. */
  readonly #retries = new Map<string, { readonly scope: string | null; readonly timer: ClockTimer }>()
  /**
   * A run of failures, per root: how long the wait before its latest retry
   * was. Present from a failure until a watch for that root proves healthy —
   * it reported an event, or it stayed up for as long as that wait without
   * failing — so a watch made and failing at once, every time, backs off, and
   * the run is logged once, at its first failure.
   */
  readonly #runs = new Map<string, { readonly scope: string | null; readonly delay: number }>()
  /** The latest reading of each root's top level; one that finishes after a later one began applies nothing. */
  readonly #rescans = new Map<string, { readonly scope: string | null; readonly generation: number }>()
  #rescanCount = 0
  #projects: readonly string[] = []
  #disposed = false

  constructor(options: AgentWatchOptions) {
    this.#options = options
    this.#clock = options.clock ?? realClock
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
    for (const timer of this.#timers.values()) this.#clock.clearTimeout(timer)
    this.#timers.clear()
    for (const one of this.#rescanTimers.values()) this.#clock.clearTimeout(one.timer)
    this.#rescanTimers.clear()
    for (const one of this.#retries.values()) this.#clock.clearTimeout(one.timer)
    this.#retries.clear()
    this.#runs.clear()
    this.#rescans.clear()
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
      this.#clock.clearTimeout(one.timer)
      this.#retries.delete(key)
    }
    for (const [key, one] of [...this.#rescanTimers]) {
      if (one.scope !== scope) continue
      this.#clock.clearTimeout(one.timer)
      this.#rescanTimers.delete(key)
    }
    for (const [key, one] of [...this.#runs]) if (one.scope === scope) this.#runs.delete(key)
    for (const [key, one] of [...this.#rescans]) if (one.scope === scope) this.#rescans.delete(key)
    const timer = this.#timers.get(scope)
    if (timer) this.#clock.clearTimeout(timer)
    this.#timers.delete(scope)
  }

  /**
   * One notice per burst, per scope — and none for a project no longer open.
   * A walk-up's look at a name is asynchronous, and one that comes back after
   * its project closed is not news to anyone.
   */
  #poke(scope: string | null): void {
    if (!this.#alive(scope)) return
    const pending = this.#timers.get(scope)
    if (pending) this.#clock.clearTimeout(pending)
    const timer = this.#clock.setTimeout(() => {
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

  /**
   * `#rescanLinks`, once per settled burst rather than once per event —
   * exactly what `#poke` already does for the notice itself, on the same
   * clock. A root's own recursive watch fires once per change anywhere
   * beneath it, and reading its top level again on every one of those (a
   * `readdir`, plus a `reach` — its own `lstat`s and `realpath`s — per link
   * found there) is a cost a run of writes to an unrelated subtree, a full
   * `node_modules` included, must never pay once per write.
   */
  #scheduleRescan(follow: Follow): void {
    if (!this.#alive(follow.scope)) return
    const key = keyOf(follow)
    const pending = this.#rescanTimers.get(key)
    if (pending) this.#clock.clearTimeout(pending.timer)
    const timer = this.#clock.setTimeout(() => {
      this.#rescanTimers.delete(key)
      void this.#rescanLinks(follow)
    }, this.#options.settleMs ?? SETTLE_MS)
    timer.unref?.()
    this.#rescanTimers.set(key, { scope: follow.scope, timer })
  }

  /** Stops whatever follows this root now, its links with it, and follows it again from wherever it can be seen. */
  #refollow(follow: Follow): void {
    const key = keyOf(follow)
    this.#cancelRetry(key)
    this.#watchers.get(key)?.close()
    this.#watchers.delete(key)
    this.#closeLinks(key)
    void this.#follow(follow)
  }

  #cancelRetry(key: string): void {
    const pending = this.#retries.get(key)
    if (pending) this.#clock.clearTimeout(pending.timer)
    this.#retries.delete(key)
  }

  /**
   * Closes the link watchers a root's readings opened — they live and die with
   * the root — and makes any reading of it still under way stale, so it cannot
   * open them again behind this.
   */
  #closeLinks(key: string): void {
    const prefix = linksOf(key)
    for (const [linkKey, one] of [...this.#links]) {
      if (!linkKey.startsWith(prefix)) continue
      one.close()
      this.#links.delete(linkKey)
    }
    const reading = this.#rescans.get(key)
    if (reading) this.#rescans.set(key, { scope: reading.scope, generation: ++this.#rescanCount })
  }

  /**
   * A failed watch — one that could not be made (`upFor` 0), or that failed
   * after `upFor` ms — is retried through `#follow` on a bounded, unref'd
   * backoff that `#drop` and `dispose()` cancel, so a watch that keeps failing
   * (a permission a person never grants, a mount that never returns) never
   * tightens into a loop.
   *
   * The wait doubles for as long as the run of failures lasts, and only the
   * run's first failure is logged. A run ends when a watch for the root proves
   * healthy: it reported an event (`#watch`), or it stayed up for as long as
   * the wait before it without failing — so a failure after that starts a new
   * run, logged, from the shortest wait again. Making a watch is not proof it
   * works: resetting the wait there had a watch that fails once made re-made
   * every 200ms, with a line each time.
   */
  #retry(follow: Follow, error: unknown, upFor: number): void {
    const key = keyOf(follow)
    this.#cancelRetry(key)
    this.#watchers.get(key)?.close()
    this.#watchers.delete(key)
    this.#closeLinks(key)
    if (!this.#alive(follow.scope)) {
      this.#runs.delete(key)
      return
    }
    const run = this.#runs.get(key)
    const continuing = run !== undefined && upFor < run.delay
    const delay = continuing ? Math.min(run.delay * 2, RETRY_MAX_MS) : RETRY_MS
    if (!continuing) {
      this.#options.log?.('could not watch the roster; retrying', {
        scope: follow.scope,
        target: follow.target,
        error: errorMessage(error),
      })
    }
    this.#runs.set(key, { scope: follow.scope, delay })
    const timer = this.#clock.setTimeout(() => {
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
    const real = await reach(follow.target, follow.within)
    // A resolution that covers the Agents folder from above — the project
    // root itself, most of all — is treated exactly like one that leads
    // nowhere: walked past below, never watched, so a committed
    // `.harnessdesk/agents -> ..` never turns into a recursive watch on the
    // whole checkout.
    if (real !== null && !coversAgentsFolder(real, follow)) {
      this.#watch(follow, real, true, () => {
        this.#poke(follow.scope)
        this.#scheduleRescan(follow)
        // A root that went away, or that now leads somewhere else, is followed afresh from wherever it can be seen.
        void reach(follow.target, follow.within).then((now) => {
          if (now !== real) this.#refollow(follow)
        })
      })
      void this.#rescanLinks(follow)
      return
    }
    /* Not there, or leading where the roster will not read — a link a project
       opened with is exactly the "not yet a real folder" case, so replacing it
       with one is noticed the same way a folder that did not exist yet is. The
       root's links went with it. Then the walk up: the nearest folder above
       that is there, and inside whatever this follow must stay inside, is
       watched for the next name on the way down. One on the way that is
       missing or leads out is walked past, never watched and never given up
       on, and a project's walk ends at the project's own folder. */
    this.#closeLinks(keyOf(follow))
    let name = basename(follow.target)
    let above = dirname(follow.target)
    for (;;) {
      const seen = await reach(above, follow.within)
      if (seen !== null) {
        const next = join(above, name)
        /* A bare name match is not proof that anything worth a notice
           happened: watching a folder that already holds an entry of this
           name — a link leading out, most of all — can report one on its
           own the moment the watch attaches, nothing having changed at all.
           So the name is looked at again, and only a *real* transition —
           it now there, and read by the roster's rule — is a notice and a
           reason to follow afresh. `next`, not `follow.target`: a walk more
           than one level up asks about the name this ancestor is watching
           for, not the final target several names further down, which a
           real transition here need not have reached yet. */
        const noticeIfThere = (): void => {
          void reach(next, follow.within).then((now) => {
            if (now === null) return
            /* `next` can be `follow.target` itself — a walk exactly one hop
               above it, most of all — in which case "it resolves" is not
               automatically "notice this": the walk-up was chosen precisely
               because that same resolution covers the Agents folder from
               above (a committed `.harnessdesk/agents -> ..`, chief among
               them), and nothing about that has changed. Re-following an
               unchanged refusal forever — once for every accepted event, and
               once more for every `#follow` it starts — is exactly what a
               bare "it resolves" check causes here; `#follow`'s own gate,
               asked again, catches it the same way it did the first time. */
            if (next === follow.target && coversAgentsFolder(now, follow)) return
            this.#poke(follow.scope)
            this.#refollow(follow)
          })
        }
        this.#watch(follow, seen, false, (filename) => {
          if (filename !== null && filename !== name) return
          noticeIfThere()
        })
        /* The same look, run once right away: `next` can appear in the gap
           between the `reach` above and this watcher actually attaching — a
           concurrent `mkdir -p` landing there, most of all — and a fresh
           watcher only ever reports a *future* event, never one that already
           happened by the time it starts listening. Without this, a project
           opened while something else is still creating its own
           `.harnessdesk/agents` never gets picked up at all: the ancestor
           watch is armed, the name it wants appears in the window it could
           not see, and nothing after that ever tells it so. */
        noticeIfThere()
        return
      }
      if (above === follow.within || dirname(above) === above) return
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
    let watcher: FSWatcher
    try {
      watcher = watchFn(dir, { recursive, persistent: false }, (_event, filename) => {
        // Healthy: it reported something, so whatever run of failures led here is over.
        this.#runs.delete(key)
        onEvent(filename === null ? null : String(filename))
      })
    } catch (error) {
      this.#retry(follow, error, 0)
      return
    }
    const madeAt = Date.now()
    watcher.on('error', (error) => this.#retry(follow, error, Date.now() - madeAt))
    this.#watchers.set(key, { scope: follow.scope, close: () => watcher.close() })
  }

  /**
   * A root's own top level, read again for the links directly in it (`F7`):
   * kept where a link already watched still leads, closed where it no longer
   * exists or no longer leads the same way, and opened fresh for one seen for
   * the first time. Nothing deeper than the top level is looked at.
   *
   * A root that cannot be read any more has no links: its link watchers are
   * closed, never left behind. And a reading overtaken by a later one while it
   * read — or by the root being followed afresh — applies nothing: the later
   * one's view is the newer.
   */
  async #rescanLinks(follow: Follow): Promise<void> {
    if (!this.#alive(follow.scope)) return
    const key = keyOf(follow)
    const generation = ++this.#rescanCount
    this.#rescans.set(key, { scope: follow.scope, generation })
    const wanted = new Map<string, string>()
    const root = await reach(follow.target, follow.within)
    // A root that resolves above its own Agents folder — the project root
    // itself, chief among them — has no top level worth reading here: reading
    // it would mean scanning the *project's* own top level for links to
    // follow, recursively, wherever an unrelated one of them leads.
    if (root !== null && !coversAgentsFolder(root, follow)) {
      const entries = await readdir(root, { withFileTypes: true }).catch(() => [])
      await Promise.all(
        entries
          .filter((entry) => entry.isSymbolicLink())
          .map(async (entry) => {
            // This machine's roots follow a top-level link wherever it leads —
            // the person put it there themselves. A project's own is followed
            // only where the roster's walk keeps it inside the project; one
            // that leads out, even to come back, stays unwatched exactly as
            // the roster leaves it unread — and one that leads to the project
            // root, or anything else above the Agents folder, stays unwatched
            // the same way: recursively watching it would cover the whole
            // project, not just the folder this link sits in.
            const real = await reach(join(root, entry.name), follow.within)
            if (real !== null && !coversAgentsFolder(real, follow)) wanted.set(entry.name, real)
          }),
      )
    }
    // Test-only: see `AgentWatchOptions.onRescan`. The host never sets it.
    await this.#options.onRescan?.(follow)
    if (!this.#alive(follow.scope) || this.#rescans.get(key)?.generation !== generation) return
    const prefix = linksOf(key)
    for (const [linkKey, existing] of [...this.#links]) {
      if (!linkKey.startsWith(prefix)) continue
      if (wanted.get(linkKey.slice(prefix.length)) === existing.target) continue
      existing.close()
      this.#links.delete(linkKey)
    }
    const watchFn = this.#options.watchFn ?? watch
    for (const [name, target] of wanted) {
      if (!this.#alive(follow.scope)) return
      const linkKey = `${prefix}${name}`
      if (this.#links.has(linkKey)) continue
      try {
        const watcher = watchFn(target, { recursive: true, persistent: false }, () => this.#poke(follow.scope))
        const entry = { scope: follow.scope, target, close: () => watcher.close() }
        watcher.on('error', () => {
          watcher.close()
          if (this.#links.get(linkKey) === entry) this.#links.delete(linkKey)
          // Not this follow's own root, so it is not retried on its own backoff:
          // the next change at the top level — or the next reading any other
          // event there starts — looks at this name again.
        })
        this.#links.set(linkKey, entry)
      } catch {
        // Gone between the look and the watch; the next reading tries again.
      }
    }
  }
}
