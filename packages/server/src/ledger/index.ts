import { join } from 'node:path'

import { runtimeId, type LedgerDay,
  type LedgerQuery,
  type LedgerReport,
  type LedgerRow,
  type RuntimeId,
  type ScanProgress,
  type SpendCoverage,
  type SpendSummary,
} from '@harnessdesk/protocol'

import { Pricing, defaultPricingPaths, type ModelRates } from './pricing.js'
import { listTargets, scanFile, type CorpusSpec, type ScanTarget } from './scan.js'
import { LedgerStore, type UsageRow } from './store.js'

/**
 * Tokens and money, read off the agents' own transcripts.
 *
 * Everything the ledger says is a *list-price equivalent*: what these tokens
 * would have cost at public API rates. That is a useful number — it is how a
 * person decides whether a plan is worth keeping — and it is not an invoice,
 * which is why every total it produces carries its provenance and its coverage.
 *
 * Design: `docs/usage-dashboard.md`.
 */

export interface LedgerOptions {
  readonly stateDir: string
  readonly corpora: readonly CorpusSpec[]
  readonly databasePath?: string
  readonly onProgress?: (progress: ScanProgress) => void
  readonly log?: (message: string, details?: Record<string, unknown>) => void
  readonly now?: () => number
  readonly pricing?: Pricing
}

const DAY = 86_400_000

const startOfDay = (at: number): number => {
  const date = new Date(at)
  date.setHours(0, 0, 0, 0)
  return date.getTime()
}

const IDLE: ScanProgress = {
  running: false,
  filesDone: 0,
  filesTotal: 0,
  bytesDone: 0,
  bytesTotal: 0,
  startedAt: null,
  finishedAt: null,
  error: null,
}

interface Priced {
  readonly cost: number
  readonly tokens: number
  readonly priced: number
  readonly unpriced: number
}

export class Ledger {
  readonly #options: LedgerOptions
  readonly #store: LedgerStore
  readonly #pricing: Pricing
  #progress: ScanProgress = IDLE
  #scanning: Promise<void> | null = null
  #warmed: Promise<void> | null = null

  constructor(options: LedgerOptions) {
    this.#options = options
    this.#store = new LedgerStore(options.databasePath ?? join(options.stateDir, 'usage.sqlite'))
    const paths = defaultPricingPaths(options.stateDir)
    this.#pricing =
      options.pricing ??
      new Pricing({
        ...paths,
        ...(options.log ? { log: options.log } : {}),
        ...(options.now ? { now: options.now } : {}),
      })
    // Buckets move if the zone changes, so the zone the history was built in is
    // recorded. Rebucketing is not attempted: it would shift midnight-adjacent
    // turns between days and change totals nobody asked to have changed.
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone
    const pinned = this.#store.meta('timezone')
    if (pinned === null) this.#store.setMeta('timezone', zone)
    else if (pinned !== zone) {
      options.log?.('usage history was bucketed in another timezone; days may straddle', {
        pinned,
        current: zone,
      })
    }
  }

  close(): void {
    this.#store.close()
  }

  #now(): number {
    return this.#options.now?.() ?? Date.now()
  }

  get progress(): ScanProgress {
    return this.#progress
  }

  /** Prices load once, lazily: nothing is fetched for a screen nobody opened. */
  async warm(): Promise<void> {
    this.#warmed ??= this.#pricing.warm().catch(() => undefined)
    return this.#warmed
  }

  /**
   * Folds in everything written since the last pass.
   *
   * Concurrent callers join the running scan rather than starting a second one.
   */
  async scan(options: { full?: boolean } = {}): Promise<ScanProgress> {
    if (this.#scanning) {
      await this.#scanning
      return this.#progress
    }
    this.#scanning = this.#doScan(options.full === true).finally(() => {
      this.#scanning = null
    })
    await this.#scanning
    return this.#progress
  }

  /** Starts a scan without waiting for it; progress arrives through `onProgress`. */
  begin(options: { full?: boolean } = {}): ScanProgress {
    if (!this.#scanning) void this.scan(options).catch(() => undefined)
    return this.#progress
  }

  async #doScan(full: boolean): Promise<void> {
    const startedAt = this.#now()
    let targets: ScanTarget[] = []
    try {
      targets = await listTargets(this.#options.corpora)
    } catch (error) {
      this.#report({
        ...IDLE,
        startedAt,
        finishedAt: this.#now(),
        error: error instanceof Error ? error.message : String(error),
      })
      return
    }

    const pending = targets.filter((target) => {
      if (full) return true
      const cursor = this.#store.cursor(target.path)
      if (!cursor) return true
      return target.size !== cursor.size || target.mtime !== cursor.mtime
    })
    const bytesTotal = pending.reduce((sum, target) => sum + target.size, 0)
    this.#report({
      running: true,
      filesDone: 0,
      filesTotal: pending.length,
      bytesDone: 0,
      bytesTotal,
      startedAt,
      finishedAt: null,
      error: null,
    })

    let filesDone = 0
    let bytesDone = 0
    for (const target of pending) {
      const cursor = full ? null : this.#store.cursor(target.path)
      // A file that shrank was rewritten, not appended to: its rows go and it
      // is read from the start, which the file-keyed rows make safe.
      const rewritten = cursor !== null && target.size < cursor.offset
      const from = rewritten || cursor === null ? 0 : cursor.offset
      const tail = rewritten || cursor === null ? [] : cursor.tail
      try {
        const result = await scanFile(target, from, tail)
        this.#store.commit(
          { path: target.path, size: target.size, mtime: target.mtime, offset: result.offset, tail: result.tail },
          result.rows,
          this.#now(),
          full || rewritten,
        )
      } catch (error) {
        this.#options.log?.('a transcript could not be read', {
          path: target.path,
          error: error instanceof Error ? error.message : String(error),
        })
      }
      filesDone += 1
      bytesDone += target.size
      // Reporting every file is noisy on a first run of three hundred; every
      // twentieth, and always the last, keeps a progress bar honest and cheap.
      if (filesDone % 20 === 0 || filesDone === pending.length) {
        this.#report({
          running: true,
          filesDone,
          filesTotal: pending.length,
          bytesDone,
          bytesTotal,
          startedAt,
          finishedAt: null,
          error: null,
        })
      }
    }

    this.#store.setMeta('scannedAt', String(this.#now()))
    this.#report({
      running: false,
      filesDone,
      filesTotal: pending.length,
      bytesDone,
      bytesTotal,
      startedAt,
      finishedAt: this.#now(),
      error: null,
    })
  }

  #report(progress: ScanProgress): void {
    this.#progress = progress
    this.#options.onProgress?.(progress)
  }

  #price(row: UsageRow): Priced {
    const tokens = row.input + row.output + row.cacheRead + row.cacheWrite
    const rates: ModelRates | null = this.#pricing.rateFor(row.model)
    if (!rates) return { cost: 0, tokens, priced: 0, unpriced: row.requests }
    const cost =
      row.input * rates.input +
      row.output * rates.output +
      row.cacheRead * rates.cacheRead +
      row.cacheWrite * rates.cacheWrite
    return { cost, tokens, priced: row.requests, unpriced: 0 }
  }

  /** The money half of one agent's card. */
  spendFor(runtime: RuntimeId, days = 30): SpendSummary | null {
    const from = startOfDay(this.#now() - (days - 1) * DAY)
    const rows = this.#store.since(from, runtime)
    if (rows.length === 0) return null
    const today = startOfDay(this.#now())

    let windowCost = 0
    let windowTokens = 0
    let todayCost = 0
    let todayTokens = 0
    let priced = 0
    let unpriced = 0
    const byDay = new Map<number, { cost: number; tokens: number }>()
    for (const row of rows) {
      const cost = this.#price(row)
      windowCost += cost.cost
      windowTokens += cost.tokens
      priced += cost.priced
      unpriced += cost.unpriced
      if (row.day === today) {
        todayCost += cost.cost
        todayTokens += cost.tokens
      }
      const bucket = byDay.get(row.day) ?? { cost: 0, tokens: 0 }
      byDay.set(row.day, { cost: bucket.cost + cost.cost, tokens: bucket.tokens + cost.tokens })
    }

    const anyPriced = priced > 0
    return {
      currency: 'USD',
      todayCost: anyPriced ? todayCost : null,
      windowCost: anyPriced ? windowCost : null,
      windowDays: days,
      todayTokens,
      windowTokens,
      provenance: anyPriced ? 'listPrice' : 'unknown',
      coverage: {
        priced,
        unpriced,
        unmetered: 0,
        estimated: 0,
        daysCovered: this.#store.daysCovered(from, runtime),
        daysRequested: days,
      },
      daily: [...byDay.entries()]
        .sort(([a], [b]) => a - b)
        .map(([day, totals]) => ({ day, cost: anyPriced ? totals.cost : null, tokens: totals.tokens })),
    }
  }

  /** The Spend and *Where it went* bands. */
  query(request: LedgerQuery): LedgerReport {
    const days = Math.max(1, Math.min(365, Math.round(request.days)))
    const from = startOfDay(this.#now() - (days - 1) * DAY)
    const rows = this.#store.since(from, request.runtime)

    let totalCost = 0
    let totalTokens = 0
    let priced = 0
    let unpriced = 0
    interface Group {
      label: string
      /** Distinct paths behind one basename, so a collision can be told apart. */
      path: string
      runtimes: Set<string>
      cost: number
      tokens: number
      unpriced: boolean
    }
    const groups = new Map<string, Group>()
    const daily = new Map<string, LedgerDay>()

    for (const row of rows) {
      const cost = this.#price(row)
      totalCost += cost.cost
      totalTokens += cost.tokens
      priced += cost.priced
      unpriced += cost.unpriced

      // A model or a project is one thing however many agents touched it —
      // "what did this project cost" is the question the pivot is named for,
      // and the per-agent split is the pivot beside it.
      const key =
        request.groupBy === 'runtime' ? row.runtime : request.groupBy === 'model' ? row.model : row.project
      const group = groups.get(key) ?? {
        label:
          request.groupBy === 'runtime'
            ? row.runtime
            : request.groupBy === 'model'
              ? row.model
              : projectName(row.project),
        path: row.project,
        runtimes: new Set<string>(),
        cost: 0,
        tokens: 0,
        unpriced: false,
      }
      group.cost += cost.cost
      group.tokens += cost.tokens
      group.unpriced = group.unpriced || cost.unpriced > 0
      group.runtimes.add(row.runtime)
      groups.set(key, group)

      const dayKey = `${row.day}:${row.runtime}`
      const bucket = daily.get(dayKey) ?? { day: row.day, runtime: runtimeId(row.runtime), cost: 0, tokens: 0 }
      daily.set(dayKey, {
        day: row.day,
        runtime: runtimeId(row.runtime),
        cost: bucket.cost + cost.cost,
        tokens: bucket.tokens + cost.tokens,
      })
    }

    // Two checkouts can share a basename. Only the colliding ones are
    // lengthened; a row that is already unambiguous keeps the short name.
    if (request.groupBy === 'project') {
      const byName = new Map<string, Set<string>>()
      for (const group of groups.values()) {
        const paths = byName.get(group.label) ?? new Set<string>()
        paths.add(group.path)
        byName.set(group.label, paths)
      }
      for (const [key, group] of groups) {
        if ((byName.get(group.label)?.size ?? 0) > 1) {
          groups.set(key, { ...group, label: projectPath(group.path) })
        }
      }
    }

    const anyPriced = priced > 0
    const coverage: SpendCoverage = {
      priced,
      unpriced,
      unmetered: 0,
      estimated: 0,
      daysCovered: this.#store.daysCovered(from, request.runtime),
      daysRequested: days,
    }
    const ordered: LedgerRow[] = [...groups.entries()]
      .map(([key, group]) => ({
        key,
        label: group.label,
        // Named only when one agent owns the row; a shared project belongs to
        // no single mark, and showing one of them would be a lie.
        runtime:
          request.groupBy === 'runtime'
            ? null
            : group.runtimes.size === 1
              ? runtimeId([...group.runtimes][0] as string)
              : null,
        tokens: group.tokens,
        cost: anyPriced ? group.cost : null,
        hasUnpriced: group.unpriced,
      }))
      .sort((a, b) => (b.cost ?? 0) - (a.cost ?? 0) || (b.tokens ?? 0) - (a.tokens ?? 0))

    const scannedAt = Number(this.#store.meta('scannedAt') ?? '')
    return {
      days,
      currency: 'USD',
      totalCost: anyPriced ? totalCost : null,
      totalTokens,
      // Everything the ledger prices is list price. A request it could not
      // price is a hole in the coverage, not a second kind of source, and the
      // counts below are where that is said.
      provenance: anyPriced ? 'listPrice' : 'unknown',
      coverage,
      rows: ordered,
      daily: [...daily.values()].sort((a, b) => a.day - b.day),
      scannedAt: Number.isFinite(scannedAt) && scannedAt > 0 ? scannedAt : null,
    }
  }
}

/** The last path segment is what a person calls a project. */
const projectName = (path: string): string => {
  if (path === '') return 'Unknown project'
  const parts = path.split('/').filter(Boolean)
  return parts[parts.length - 1] ?? path
}

/** Enough of the path to tell two same-named projects apart. */
const projectPath = (path: string): string => {
  if (path === '') return 'Unknown project'
  const parts = path.split('/').filter(Boolean)
  return parts.slice(-2).join('/')
}

export { Pricing } from './pricing.js'
export { defaultCorpora, type CorpusSpec } from './scan.js'
export { LedgerStore } from './store.js'
