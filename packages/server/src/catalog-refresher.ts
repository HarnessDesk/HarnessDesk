import type { AgentRuntime, InstallationCheck, RuntimeId } from '@harnessdesk/protocol'

/**
 * Keeps every runtime's answer to "what do you offer?" current while the
 * app is open.
 *
 * A model picker is the agent's last answer, and the agent's answer changes
 * under a running app in two ways: the vendor adds a model server-side
 * (Cursor does this with no binary change), or the user upgrades the agent
 * while HarnessDesk is open. Neither is visible until someone asks again.
 * This asks again — on a timer, on request, and when the window returns —
 * by calling the two optional `AgentRuntime` methods in order: first
 * `checkInstallation`, which moves an idle runtime onto a new build, then
 * `refreshCatalog`, unless the check already restarted the process (a fresh
 * process has already asked).
 *
 * Failures are per runtime and logged; one agent that cannot answer never
 * stops the others from being asked. The schedule is deliberately slow —
 * every thirty minutes — because each tick can mean a subprocess for a
 * bridge and because nothing here is urgent: a model added an hour ago is
 * fine to learn about in thirty minutes, and anyone in a hurry has the
 * menu's "Refresh models".
 */

export interface CatalogRefresherOptions {
  readonly intervalMs?: number
  readonly now?: () => number
  readonly log?: (message: string, details?: unknown) => void
  /** Told after every check, whether or not anything changed. */
  readonly onChecked?: (runtime: RuntimeId, result: RefreshResult) => void
}

export interface RefreshResult {
  readonly checkedAt: number
  readonly installation: InstallationCheck | null
  /**
   * True when the runtime actually re-read — not merely when the call
   * returned.
   *
   * This used to be set on any `refreshCatalog()` that resolved, which is a
   * different question: an ACP agent refreshes by restarting and declines,
   * silently and successfully, while a turn is in flight. So the flag said
   * yes, the caller believed it, and the one surface that shows a person the
   * result reported a re-read that never happened.
   */
  readonly refreshed: boolean
  /** Why it did not, when it did not. A sentence, from the runtime. */
  readonly reason?: string
}

export const DEFAULT_REFRESH_INTERVAL_MS = 30 * 60 * 1000

export class CatalogRefresher {
  readonly #runtimes = new Map<RuntimeId, AgentRuntime>()
  readonly #lastChecked = new Map<RuntimeId, number>()
  readonly #inflight = new Map<RuntimeId, Promise<RefreshResult>>()
  #timer: ReturnType<typeof setInterval> | null = null
  /**
   * Whether `stop()` has been called — which on this host means the app is
   * quitting, since `Host.dispose()` is the only caller.
   *
   * Clearing the interval stops the *next* tick; it does not stop a caller
   * that arrives during the shutdown, and every check here can end in a
   * restarted agent. A restart during a quit is at best wasted subprocesses
   * — `checkInstallation` shells out to ask the machine what is installed —
   * and at worst a new agent process spawned into a teardown that has
   * already gone past the point where anything would end it. The runtimes
   * refuse that spawn themselves, which is where the invariant belongs; this
   * is `stop()` meaning stopped rather than meaning the timer is off.
   *
   * It does not touch a refresh that is *already* running: nothing here may
   * hold the quit open, and a check that has reached the agent is unbounded.
   */
  #stopped = false

  constructor(private readonly options: CatalogRefresherOptions = {}) {}

  watch(runtime: AgentRuntime): void {
    this.#runtimes.set(runtime.info.id, runtime)
    // A runtime that has just come up declared its catalogue just now, so
    // its last answer is as fresh as an answer gets. Left unstamped, the
    // renderer read "never checked" as "stale", and the first time the window
    // came back into focus after launch every idle agent was restarted to
    // re-ask a question it had answered seconds earlier.
    if (!this.#lastChecked.has(runtime.info.id)) {
      this.#lastChecked.set(runtime.info.id, (this.options.now ?? Date.now)())
    }
  }

  /** Stops watching one — an account that was removed. Unknown ids are fine. */
  forget(id: RuntimeId): void {
    this.#runtimes.delete(id)
    this.#lastChecked.delete(id)
  }

  start(): void {
    this.#stopped = false
    if (this.#timer) return
    this.#timer = setInterval(() => void this.refreshAll(), this.options.intervalMs ?? DEFAULT_REFRESH_INTERVAL_MS)
    this.#timer.unref?.()
  }

  stop(): void {
    this.#stopped = true
    if (this.#timer) clearInterval(this.#timer)
    this.#timer = null
  }

  lastChecked(runtime: RuntimeId): number | null {
    return this.#lastChecked.get(runtime) ?? null
  }

  async refreshAll(): Promise<void> {
    await Promise.all([...this.#runtimes.keys()].map((id) => this.refresh(id)))
  }

  /**
   * One check for one runtime. Concurrent calls share a run — the menu's
   * button and the timer firing together must not restart an agent twice.
   * Never throws: the result says what happened, the log says what failed.
   */
  refresh(id: RuntimeId): Promise<RefreshResult> {
    // Nothing new begins after `stop()` — see `#stopped`. Answered rather
    // than thrown, because the one caller that can still arrive here is a
    // person's "Refresh models" landing as the window closes, and a refusal
    // with a sentence is what every other refusal in this file is.
    if (this.#stopped) {
      /* Unless one is genuinely running, in which case that run is the honest
         answer: two callers asking about one runtime must not get two
         different stories about it, one of them a refusal for work that is
         happening. Only a caller with nothing to join is turned away. */
      const running = this.#inflight.get(id)
      if (running) return running
      return Promise.resolve({
        checkedAt: (this.options.now ?? Date.now)(),
        installation: null,
        refreshed: false,
        reason: 'HarnessDesk is shutting down.',
      })
    }
    let pending = this.#inflight.get(id)
    if (!pending) {
      pending = this.#refreshOnce(id).finally(() => this.#inflight.delete(id))
      this.#inflight.set(id, pending)
    }
    return pending
  }

  async #refreshOnce(id: RuntimeId): Promise<RefreshResult> {
    const runtime = this.#runtimes.get(id)
    const now = (this.options.now ?? Date.now)()
    let installation: InstallationCheck | null = null
    let refreshed = false
    let reason: string | undefined
    const health = runtime?.health()
    // A crashed runtime goes through: its own health says "select the
    // runtime again to restart it", a selection ends here, and the runtime's
    // refresh is the restart. Every other not-ready state — starting, or
    // blocked by its launch check — is not something a re-read can mend.
    const crashed = health?.state === 'unavailable' && health.reason === 'crashed'
    if (!runtime) {
      reason = 'It is not registered here.'
    } else if (health?.state !== 'ready' && !crashed) {
      reason = 'It is not running.'
    } else {
      try {
        installation = (await runtime.checkInstallation?.()) ?? null
      } catch (error) {
        this.options.log?.('installation check failed', { runtime: id, error: String(error) })
      }
      const restarted = installation?.changed === true && installation.restarted
      if (restarted) {
        refreshed = true
      } else if (runtime.refreshCatalog) {
        try {
          const verdict = await runtime.refreshCatalog()
          refreshed = verdict.refreshed
          reason = verdict.reason
        } catch (error) {
          this.options.log?.('catalog refresh failed', { runtime: id, error: String(error) })
          reason = error instanceof Error ? error.message : String(error)
        }
      } else {
        reason = 'It does not re-read its catalogue on request.'
      }
    }
    this.#lastChecked.set(id, now)
    const result: RefreshResult = {
      checkedAt: now,
      installation,
      refreshed,
      ...(reason !== undefined ? { reason } : {}),
    }
    this.options.onChecked?.(id, result)
    return result
  }
}
