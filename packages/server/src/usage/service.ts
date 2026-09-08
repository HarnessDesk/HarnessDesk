import { watch, type FSWatcher } from 'node:fs'

import type {
  AgentRuntime,
  RateLimits,
  RuntimeId,
  SpendSummary,
  UsageLane,
  UsageReport,
} from '@harnessdesk/protocol'

import type { MeterReading, UsageMeter } from './meter.js'

/**
 * Every metered account's standing, kept warm.
 *
 * Three sources feed one shape, all of them ours. The runtime answers for
 * itself when it can (`getRateLimits`), a meter reads what the agent already
 * wrote down when it cannot, and the ledger supplies the money either way.
 * What comes out is a `UsageReport` per account, which is all the renderer
 * ever sees.
 *
 * Freshness is event-shaped rather than a poll: a finished turn refreshes its
 * own agent, and a file-backed meter is watched. The interval below is the
 * floor under those, not the mechanism.
 */

/** What the ledger has to answer for the money half of a report. */
export interface SpendSource {
  spendFor(runtime: RuntimeId): SpendSummary | null
}

export interface UsageServiceOptions {
  readonly runtimes: () => readonly AgentRuntime[]
  /** Meters bound to a runtime id by the registry, or inferred at bootstrap. */
  readonly meters: ReadonlyMap<RuntimeId, UsageMeter>
  readonly spend?: SpendSource | null
  /** Called for each report as it lands, so a slow source never delays a fast one. */
  readonly onReport: (report: UsageReport) => void
  readonly log?: (message: string, details?: Record<string, unknown>) => void
  readonly now?: () => number
}

const DEFAULT_STALE_AFTER_MS = 5 * 60_000

/**
 * A runtime that meters itself gives us `RateLimits` and nothing about where
 * they came from, so the label is the honest general answer.
 */
const RUNTIME_SOURCE = { kind: 'runtime', label: 'from its own API' } as const
const LEDGER_SOURCE = { kind: 'ledger', label: 'from its transcripts' } as const

const laneFromWindow = (
  window: { label: string; usedPercent: number; windowMinutes: number | null; resetsAt: number | null },
  index: number,
): UsageLane => ({
  id: window.label.toLowerCase().replace(/[^a-z0-9]+/g, '-') || `lane-${index}`,
  label: window.label,
  usedPercent: window.usedPercent,
  windowMinutes: window.windowMinutes,
  resetsAt: window.resetsAt,
})

/** The narrow legacy view, widened without inventing anything. */
export const lanesFrom = (limits: RateLimits): readonly UsageLane[] =>
  limits.lanes ?? (limits.windows ?? []).map(laneFromWindow)

export class UsageService {
  readonly #options: UsageServiceOptions
  readonly #cache = new Map<RuntimeId, UsageReport>()
  readonly #inFlight = new Map<RuntimeId, Promise<UsageReport | null>>()
  readonly #watchers: FSWatcher[] = []
  #disposed = false

  constructor(options: UsageServiceOptions) {
    this.#options = options
    this.#watchMeterFiles()
  }

  #now(): number {
    return this.#options.now?.() ?? Date.now()
  }

  /**
   * Every report we can produce, reading through the cache.
   *
   * A source that fails keeps its previous reading with its own age showing;
   * one provider being down never blanks the screen.
   */
  async reports(): Promise<readonly UsageReport[]> {
    const runtimes = this.#options.runtimes()
    const settled = await Promise.all(runtimes.map((runtime) => this.#reportFor(runtime, false)))
    return settled.filter((report): report is UsageReport => report !== null)
  }

  /** Forces one agent, or every agent, to be asked again. */
  async refresh(runtime?: RuntimeId): Promise<readonly UsageReport[]> {
    const runtimes = this.#options
      .runtimes()
      .filter((entry) => runtime === undefined || entry.info.id === runtime)
    const settled = await Promise.all(runtimes.map((entry) => this.#reportFor(entry, true)))
    return settled.filter((report): report is UsageReport => report !== null)
  }

  /**
   * The narrow view, for the surfaces that already read it — the sidebar
   * footer, the composer ring, the agent card in Settings. A meter's lanes
   * reach them through here without any of those learning a new shape.
   */
  async limitsFor(runtime: AgentRuntime): Promise<RateLimits | null> {
    const own = await runtime.getRateLimits().catch(() => null)
    if (own && (own.lanes?.length || own.windows?.length)) return own
    const report = await this.#reportFor(runtime, false)
    if (!report || report.lanes.length === 0) return own
    return {
      planType: report.plan,
      lanes: report.lanes,
      windows: report.lanes.map((lane) => ({
        label: lane.scope ? `${lane.label} · ${lane.scope}` : lane.label,
        usedPercent: lane.usedPercent,
        windowMinutes: lane.windowMinutes,
        resetsAt: lane.resetsAt,
      })),
      reached: report.reached,
      ...(report.credits
        ? { hasCredits: true, balance: report.credits.remaining, unlimited: report.credits.unlimited === true }
        : {}),
      source: report.source,
    }
  }

  /** The last reading for one agent, without asking anyone. */
  cached(runtime: RuntimeId): UsageReport | null {
    return this.#cache.get(runtime) ?? null
  }

  /**
   * Restates the money after the ledger has learned something new.
   *
   * A finished scan changes the spend half of every report and nothing else,
   * so no account is asked again — the readings already in hand are restated
   * and re-emitted. The exception is an agent that had nothing at all to say
   * and so was never cached: money alone now earns it a card, and that one is
   * built properly.
   */
  async settleSpend(): Promise<void> {
    for (const runtime of this.#options.runtimes()) {
      const id = runtime.info.id
      const spend = this.#options.spend?.spendFor(id) ?? null
      const cached = this.#cache.get(id)
      if (!cached) {
        if (spend) await this.#reportFor(runtime, true).catch(() => null)
        continue
      }
      if (spend === null && cached.spend === null) continue
      const restated: UsageReport = { ...cached, spend }
      this.#cache.set(id, restated)
      if (!this.#disposed) this.#options.onReport(restated)
    }
  }

  dispose(): void {
    this.#disposed = true
    for (const watcher of this.#watchers) watcher.close()
    this.#watchers.length = 0
  }

  async #reportFor(runtime: AgentRuntime, force: boolean): Promise<UsageReport | null> {
    const id = runtime.info.id
    const cached = this.#cache.get(id)
    if (!force && cached && this.#now() - cached.fetchedAt < cached.staleAfterMs) return cached
    const running = this.#inFlight.get(id)
    if (running) return running

    const work = this.#build(runtime).finally(() => this.#inFlight.delete(id))
    this.#inFlight.set(id, work)
    return work
  }

  async #build(runtime: AgentRuntime): Promise<UsageReport | null> {
    const id = runtime.info.id
    const meter = this.#options.meters.get(id) ?? null
    const spend = this.#options.spend?.spendFor(id) ?? null
    const previous = this.#cache.get(id) ?? null

    let lanes: readonly UsageLane[] = []
    let plan: string | null = null
    let account: string | null = null
    let credits: UsageReport['credits'] = null
    let reached: string | null = null
    let source = RUNTIME_SOURCE as UsageReport['source']
    let fetchedAt = this.#now()
    let staleAfterMs = DEFAULT_STALE_AFTER_MS
    let error: UsageReport['error'] = null

    // The runtime first: it is the only source that can be live.
    if (runtime.info.capabilities.metered) {
      try {
        const limits = await runtime.getRateLimits()
        if (limits) {
          lanes = lanesFrom(limits)
          plan = limits.planType ?? null
          reached = limits.reached ?? null
          if (limits.unlimited || limits.hasCredits) {
            credits = { remaining: limits.balance ?? null, unit: 'credits', unlimited: limits.unlimited === true }
          }
          if (limits.source) source = limits.source
        }
      } catch (cause) {
        error = { message: cause instanceof Error ? cause.message : String(cause) }
      }
    }

    // A meter fills in for a runtime that cannot answer; it never overwrites
    // live figures with a cache.
    let answered = false
    const take = async (candidate: UsageMeter | null): Promise<void> => {
      if (!candidate || lanes.length > 0) return
      const reading = await this.#readMeter(id, candidate)
      if (!reading) return
      answered = true
      lanes = reading.lanes
      plan = reading.plan
      account = reading.account
      credits = reading.credits
      reached = reading.reached
      source = candidate.source
      fetchedAt = reading.fetchedAt
      staleAfterMs = reading.staleAfterMs
      error = null
    }

    await take(meter)

    // One provider being down does not blank a card. The last good reading
    // stands with its own age, and the failure is shown beside it.
    if (lanes.length === 0 && error && previous && previous.lanes.length > 0) {
      const kept: UsageReport = { ...previous, spend, error }
      this.#cache.set(id, kept)
      if (!this.#disposed) this.#options.onReport(kept)
      return kept
    }

    if (lanes.length === 0 && !credits && !spend && !error) {
      // Nothing to say about this agent. A card with no content is worse than
      // no card, and the screen names the roster from the runtimes anyway. A
      // balance counts as something: pay-as-you-go has no window to run out
      // of, and "$4.58 left" is the whole answer for an account like that.
      this.#cache.delete(id)
      return null
    }

    if (account === null) {
      account = await this.#accountLabel(runtime)
    }
    // The ledger's own label only when the ledger is genuinely all we have.
    if (lanes.length === 0 && !answered && spend) source = LEDGER_SOURCE

    const report: UsageReport = {
      runtime: id,
      account,
      plan,
      lanes,
      credits,
      spend,
      reached,
      source,
      fetchedAt,
      staleAfterMs,
      error,
    }
    this.#cache.set(id, report)
    if (!this.#disposed) this.#options.onReport(report)
    return report
  }

  /** A meter that throws is logged and treated as silence, never as a card. */
  async #readMeter(id: RuntimeId, meter: UsageMeter): Promise<MeterReading | null> {
    try {
      return await meter.read()
    } catch (cause) {
      this.#options.log?.('a usage meter failed', {
        runtime: id,
        meter: meter.id,
        error: cause instanceof Error ? cause.message : String(cause),
      })
      return null
    }
  }

  async #accountLabel(runtime: AgentRuntime): Promise<string | null> {
    try {
      const status = await runtime.getAccount()
      const first = status.accounts[0]
      return first?.email ?? first?.label ?? null
    } catch {
      return null
    }
  }

  /**
   * A file the agent rewrites as it runs is the cheapest freshness there is:
   * watching costs nothing and beats any interval. A watch that cannot be
   * established is not an error — the interval still covers it.
   */
  #watchMeterFiles(): void {
    for (const [runtime, meter] of this.#options.meters) {
      for (const path of meter.watchPaths()) {
        try {
          const watcher = watch(path, { persistent: false }, () => {
            void this.refresh(runtime).catch(() => undefined)
          })
          watcher.on('error', () => watcher.close())
          this.#watchers.push(watcher)
        } catch {
          // The file may not exist yet; the next read finds it.
        }
      }
    }
  }
}
