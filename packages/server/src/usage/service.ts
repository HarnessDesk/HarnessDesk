import { watch, type FSWatcher } from 'node:fs'

import {
  bindingLane,
  type AgentRuntime,
  type RateLimits,
  type RuntimeId,
  type SpendSummary,
  type UnverifiedUsage,
  type UsageBilling,
  type UsageLane,
  type UsageReport,
} from '@harnessdesk/protocol'

import type { MeterReading, UsageMeter } from './meter.js'

const DAY_MS = 86_400_000
/** "The current billing cycle when the report knows one, else the last 14 days" — "Turns", `docs/usage-dashboard.md`. */
const FALLBACK_TURNS_WINDOW_DAYS = 14
/** `UsageReport.turns.unitsPerTurn` needs this many turns in the window before it says a rate; fewer reports the count with a null rate. */
const MIN_TURNS_FOR_RATE = 10

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

/** What the ledger has to answer for the money half of a report, and, where it knows one, the turns half. */
export interface SpendSource {
  spendFor(runtime: RuntimeId, days?: number): SpendSummary | null
  /**
   * How many turns this runtime ran since `sinceMs`, or `null` when the
   * ledger was never told this runtime has a real turn count at all
   * (`LedgerOptions.turnRuntimes`) — read as unknown, never as zero.
   * Optional so a `SpendSource` built before turns existed is still valid.
   */
  turnsFor?(runtime: RuntimeId, sinceMs: number): { readonly count: number; readonly since: number; readonly source: 'agent' | 'desk' } | null
  /** Ledger requests (priced or not) logged since `sinceMs`, the same window `turnsFor` counted — for a per-turn rate on a requests-based allowance. */
  requestsFor?(runtime: RuntimeId, sinceMs: number): number
  /** What the ledger's rows for this runtime are worth since `sinceMs`, the same window `turnsFor` counted — for a per-turn rate on a balance or a metered key. */
  valueFor?(runtime: RuntimeId, sinceMs: number): number
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
  /**
   * Runs over every report before it is cached, returned or pushed —
   * `reports()`, `refresh()`, `cached()` and `onReport` all see whatever this
   * returns, and never the report without it. This is the one seam a stored
   * plan fee/budget folds in through (`host.ts`'s `planOverlay`), so a report
   * can never leave this service unmerged on one path and merged on another.
   */
  readonly overlay?: (report: UsageReport) => Promise<UsageReport>
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
   * The one place a report is cached and pushed — every exit out of `#build`
   * and `settleSpend` funnels through here, so the overlay (a stored plan
   * fee/budget, when the host supplies one) is applied exactly once and
   * never skipped on one path while another remembers it.
   */
  async #finish(id: RuntimeId, report: UsageReport): Promise<UsageReport> {
    const overlaid = this.#options.overlay ? await this.#options.overlay(report) : report
    this.#cache.set(id, overlaid)
    if (!this.#disposed) this.#options.onReport(overlaid)
    return overlaid
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
      await this.#finish(id, restated)
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
    let unverified: UnverifiedUsage | null = null
    let billing: UsageBilling | undefined
    // Another sign-in's source failing, kept apart from the agent's own error.
    let unverifiedFailure: string | null = null

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
          if (limits.billing) billing = limits.billing
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
      const read = await this.#readMeter(id, candidate)
      // A meter that fails keeps the reading it had, below — but only one it
      // had. With nothing before it, a failure is still silence rather than a
      // card of its own, as it always was. The failure belongs to whoever the
      // figures belong to: the agent's own, or the other sign-in's.
      if ('failure' in read) {
        if (previous && previous.lanes.length > 0) error = { message: read.failure }
        else if (previous?.unverified) unverifiedFailure = read.failure
        return
      }
      const reading = read.reading
      if (!reading) return
      answered = true
      source = candidate.source
      fetchedAt = reading.fetchedAt
      staleAfterMs = reading.staleAfterMs
      error = null
      // Figures the source cannot tie to the account the agent runs as are
      // filed beside the report, never in `lanes`, so nothing that decides
      // whether the agent can run reads them — and the agent's own account
      // label stays its own rather than being lent to another sign-in's quota.
      if (reading.unverified !== undefined) {
        unverified = {
          whose: reading.unverified,
          lanes: reading.lanes,
          reached: reading.reached,
          fetchedAt: reading.fetchedAt,
          staleAfterMs: reading.staleAfterMs,
        }
        return
      }
      lanes = reading.lanes
      plan = reading.plan
      account = reading.account
      credits = reading.credits
      reached = reading.reached
      billing = reading.billing
    }

    await take(meter)

    // Another sign-in's source failing keeps its last figures with the failure
    // on them, and leaves the agent's own standing — and its error — alone.
    if (unverifiedFailure !== null && previous?.unverified && lanes.length === 0) {
      const kept: UsageReport = {
        ...previous,
        spend,
        error,
        unverified: { ...previous.unverified, error: { message: unverifiedFailure } },
      }
      return this.#finish(id, kept)
    }

    // One provider being down does not blank a card. The last good reading
    // stands with its own age, and the failure is shown beside it.
    if (lanes.length === 0 && !unverified && error && previous && (previous.lanes.length > 0 || previous.unverified)) {
      const kept: UsageReport = { ...previous, spend, error }
      return this.#finish(id, kept)
    }

    if (lanes.length === 0 && !credits && !spend && !error && !unverified) {
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

    const turns = this.#turnsFor(id, billing, lanes)

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
      ...(unverified ? { unverified } : {}),
      ...(billing ? { billing } : {}),
      ...(turns ? { turns } : {}),
    }
    return this.#finish(id, report)
  }

  /**
   * A meter that throws is logged, and its failure handed back so a reading
   * the card already has can stand beside it. It is never a card of its own.
   */
  async #readMeter(
    id: RuntimeId,
    meter: UsageMeter,
  ): Promise<{ readonly reading: MeterReading | null } | { readonly failure: string }> {
    try {
      return { reading: await meter.read() }
    } catch (cause) {
      const failure = cause instanceof Error ? cause.message : String(cause)
      this.#options.log?.('a usage meter failed', { runtime: id, meter: meter.id, error: failure })
      return { failure }
    }
  }

  /**
   * `UsageReport.turns`, filled from the ledger's own count — "Turns",
   * `docs/usage-dashboard.md` — for every runtime the ledger was told has one
   * (`SpendSource.turnsFor`), whatever shape `lanes` is otherwise. `null`
   * when the ledger knows nothing (never counted for this runtime) or counts
   * zero turns in the window.
   *
   * `unitsPerTurn` prices one turn in the lane's own unit, and needs at least
   * `MIN_TURNS_FOR_RATE` turns in the window before it says a rate at all:
   * - An allowance lane in requests (Cursor): ledger requests, over the same
   *   window `turnsFor` counted, divided by turns.
   * - A balance or a metered key: Value — vendor-reported cost where the
   *   ledger has it, list price otherwise, `SpendSummary.windowCost` over the
   *   same window — divided by turns, in the report's own currency.
   * - A plain percent window (Codex, Claude Code's plan lanes): `null`. That
   *   needs a history of lane snapshots this host does not keep yet.
   */
  #turnsFor(
    runtime: RuntimeId,
    billing: UsageBilling | undefined,
    lanes: readonly UsageLane[],
  ): UsageReport['turns'] {
    const known = this.#options.spend?.turnsFor?.(runtime, this.#turnsWindowStart(lanes))
    if (!known || known.count <= 0) return null
    let unitsPerTurn: number | null = null
    // A desk-sourced runtime's turns (Cursor, and any unrecognised ACP agent)
    // cover only what ran through this desk, while every other figure a
    // meter has for it — Cursor's own request quota, its balance — is
    // account-wide: a person's other machine, or Cursor used outside this
    // desk at all, adds requests and Value that these turns never saw.
    // Dividing one by the other is not a smaller-sample estimate, it is a
    // number with no relationship to the one being reported, so a
    // desk-sourced rate is always null here rather than exact-or-approximate
    // — the owner's decision, "Turns", `docs/usage-dashboard.md`. Codex,
    // Claude Code, Gemini CLI and Qwen Code are exempt: their own transcript
    // is the turn boundary, and it covers standalone use exactly as well as
    // desk use, so both sides of the rate already agree on what they cover.
    if (known.count >= MIN_TURNS_FOR_RATE && known.source === 'agent') {
      if (billing?.kinds.includes('allowance') && this.#options.spend?.requestsFor) {
        const requests = this.#options.spend.requestsFor(runtime, known.since)
        unitsPerTurn = requests > 0 ? requests / known.count : null
      } else if (billing?.kinds.includes('balance') || billing?.kinds.includes('metered')) {
        const value = this.#options.spend?.valueFor?.(runtime, known.since) ?? null
        unitsPerTurn = value !== null ? value / known.count : null
      }
      // A plain percent window has no per-turn figure yet — see the comment above.
    }
    return { count: known.count, unitsPerTurn, since: known.since }
  }

  /** The current billing cycle when a lane's own reset says one, else the last `FALLBACK_TURNS_WINDOW_DAYS`. */
  #turnsWindowStart(lanes: readonly UsageLane[]): number {
    const lane = bindingLane(lanes)
    if (lane?.resetsAt != null && lane.windowMinutes != null) {
      const start = lane.resetsAt - lane.windowMinutes * 60_000
      if (start < this.#now()) return start
    }
    return this.#now() - FALLBACK_TURNS_WINDOW_DAYS * DAY_MS
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
