import { createHash } from 'node:crypto'
import { join } from 'node:path'

import { runtimeId, type LedgerDay,
  type LedgerHour,
  type LedgerQuery,
  type LedgerReport,
  type LedgerRow,
  type RuntimeId,
  type ScanProgress,
  type SpendCoverage,
  type SpendSummary,
  type InsightQuery,
  type InsightSource,
} from '@harnessdesk/protocol'

import { Pricing, defaultPricingPaths, type ModelRates } from './pricing.js'
import { safeLedgerDiagnostic } from './diagnostics.js'
import type { RemoteEventsSource } from './remote.js'
import { HOUR_CAPABLE_KINDS, listTargets, scanFile, wholeFile, type CorpusSpec, type ScanTarget } from './scan.js'
import { LedgerStore, type UsageRow } from './store.js'
import { INSIGHT_BYTE_LIMIT, INSIGHT_BYTE_LIMIT_MESSAGE, InsightBudgetExceededError, InsightSourceChangedError, type UsageDetail, type UsageSample } from './insight.js'
import { InsightCache } from './insight-cache.js'

/**
 * Tokens and money, read off the agents' own transcripts.
 *
 * Most of what the ledger says is a *list-price equivalent*: what these tokens
 * would have cost at public API rates. That is a useful number — it is how a
 * person decides whether a plan is worth keeping — and it is not an invoice,
 * which is why every total it produces carries its provenance and its coverage.
 * Where an agent records what it billed (OpenCode, Cline), that figure is used
 * as it stands and the total says so: `vendorMetered`, or `mixed` beside
 * list-priced rows.
 *
 * Design: `docs/usage-dashboard.md`.
 */

export interface LedgerOptions {
  readonly stateDir: string
  readonly corpora: readonly CorpusSpec[]
  /** Sources that live on a server rather than in a file — see `remote.ts`. */
  readonly remoteSources?: readonly RemoteEventsSource[]
  /**
   * Which runtimes have a real turn count behind them — see "Turns",
   * `docs/usage-dashboard.md`, and `TURN_CAPABLE_KINDS` (`scan.ts`) for the
   * scanners that can tell. Explicit rather than inferred from `corpora`'s
   * kinds alone, because the desk's own transcript (`desk-turns.ts`) also
   * earns a runtime a place here without a `CorpusSpec` at all — the host's
   * wiring computes the whole list once, for every source it registered.
   */
  readonly turnRuntimes?: ReadonlySet<RuntimeId>
  /**
   * Which of `turnRuntimes` earn their turn count from the desk's own
   * transcript (`ledger/desk-turns.ts`) rather than the agent's own records
   * -- Cursor today, and any unrecognised ACP agent. `Ledger.turnsFor`'s
   * `source` reads this, because a desk-sourced runtime's turns cover only
   * what ran through this desk, never standalone use the way an agent's own
   * transcript does -- see "Turns", `docs/usage-dashboard.md`.
   */
  readonly deskTurnRuntimes?: ReadonlySet<RuntimeId>
  readonly databasePath?: string
  readonly onProgress?: (progress: ScanProgress) => void
  readonly log?: (message: string, details?: Record<string, unknown>) => void
  readonly now?: () => number
  readonly pricing?: Pricing
  /**
   * How much source data one Insight read may spend in total, tracked against
   * bytes a scanner actually read rather than a source's size at discovery.
   * Defaults to `INSIGHT_BYTE_LIMIT`; narrowed only in tests, to exercise the
   * bound without fixtures sized in tens of megabytes.
   */
  readonly insightByteLimit?: number
}

const DAY = 86_400_000
const HOUR = 3_600_000

const startOfDay = (at: number): number => {
  const date = new Date(at)
  date.setHours(0, 0, 0, 0)
  return date.getTime()
}

/** `day` stepped by whole local days — calendar arithmetic, since a DST day is 23 or 25 hours, never a fixed 86,400,000ms. */
const stepDay = (day: number, days: number): number => {
  const date = new Date(day)
  date.setDate(date.getDate() + days)
  return date.getTime()
}

/**
 * How far back a remote source's first sync reaches, or how much of a local
 * source is replaced on each scan. Ninety days rather than the account's billing
 * cycle: the cycle boundary is a second network call away and this ledger
 * already bounds an Insight read to the same ninety days
 * (`INSIGHT_BYTE_LIMIT`'s sibling rule, `Ledger.readInsight`), so a remote
 * source's history starts no further back than everything else here can
 * already promise to explain.
 */
const REMOTE_INITIAL_DAYS = 90

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
  /** Of `priced`, the requests whose cost the agent reported rather than we computed. */
  readonly vendor: number
}

/** What a set of priced requests is, said once for the card and the bands alike. */
const provenanceOf = (priced: number, vendor: number): SpendSummary['provenance'] => {
  if (priced === 0) return 'unknown'
  if (vendor === 0) return 'listPrice'
  return vendor === priced ? 'vendorMetered' : 'mixed'
}

const failedCorpusSource = (
  corpus: CorpusSpec | ScanTarget,
  checkedAt: number,
  problem: string,
): InsightSource => {
  const path = 'path' in corpus ? corpus.path : corpus.root
  return {
    id: `corpus:${corpus.kind}:${corpus.runtime}:${createHash('sha256').update(path).digest('hex').slice(0, 16)}`,
    runtime: corpus.runtime,
    kind: 'corpus',
    label: 'Recorded usage',
    observedAt: null,
    checkedAt,
    stale: false,
    problem,
  }
}

export class Ledger {
  readonly #options: LedgerOptions
  readonly #store: LedgerStore
  readonly #pricing: Pricing
  readonly #insightByteLimit: number
  readonly #turnRuntimes: ReadonlySet<string>
  readonly #deskTurnRuntimes: ReadonlySet<string>
  #progress: ScanProgress = IDLE
  #scanning: Promise<void> | null = null
  #warmed: Promise<void> | null = null
  readonly #insightCache = new InsightCache()
  #insightRead: Promise<unknown> = Promise.resolve()

  constructor(options: LedgerOptions) {
    this.#options = options
    this.#insightByteLimit = options.insightByteLimit ?? INSIGHT_BYTE_LIMIT
    // The live set itself, never a copy: a runtime bound after this ledger
    // was built (`host.ts`'s `bindUsage`, called any time an agent is added)
    // must be turn-known the moment it is added, not only after a restart
    // that rebuilds a fresh copy from what existed at construction time.
    this.#turnRuntimes = options.turnRuntimes ?? new Set()
    this.#deskTurnRuntimes = options.deskTurnRuntimes ?? new Set()
    this.#store = new LedgerStore(options.databasePath ?? join(options.stateDir, 'usage.sqlite'))
    const paths = defaultPricingPaths(options.stateDir)
    this.#pricing =
      options.pricing ??
      new Pricing({
        ...paths,
        ...(options.log ? { log: (message, details) => this.#log(message, details) } : {}),
        ...(options.now ? { now: options.now } : {}),
      })
    // Buckets move if the zone changes, so the zone the history was built in is
    // recorded. Rebucketing is not attempted: it would shift midnight-adjacent
    // turns between days and change totals nobody asked to have changed.
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone
    const pinned = this.#store.meta('timezone')
    if (pinned === null) this.#store.setMeta('timezone', zone)
    else if (pinned !== zone) {
      this.#log('usage history was bucketed in another timezone; days may straddle', {
        pinned,
        current: zone,
      })
    }
  }

  close(): void {
    this.#store.close()
  }

  /** Store one balance reading without exposing the ledger's SQLite store. */
  recordBalance(runtime: RuntimeId, account: string, at: number, remaining: number, unit: string, pruneAt: number): void {
    this.#store.recordBalance(runtime, account, at, remaining, unit, pruneAt)
  }

  /** Read recent balance readings for one account, oldest first. */
  balanceHistory(runtime: RuntimeId, account: string, since: number): ReturnType<LedgerStore['balanceHistory']> {
    return this.#store.balanceHistory(runtime, account, since)
  }

  #now(): number {
    return this.#options.now?.() ?? Date.now()
  }

  #log(message: string, details?: Record<string, unknown>): void {
    this.#options.log?.(message, safeLedgerDiagnostic(message, details))
  }

  get progress(): ScanProgress {
    return this.#progress
  }

  /**
   * Read the already-scanned ledger without changing it. Aggregated historical
   * rows deliberately retain no guessed session or turn identity; callers must
   * leave those amounts unattributed rather than manufacture a join.
   */
  async readInsight(query: InsightQuery, options: { readonly refresh?: boolean; readonly signal?: AbortSignal } = {}): Promise<UsageDetail> {
    const read = this.#insightRead.then(() => this.#readInsight(query, options))
    this.#insightRead = read.catch(() => undefined)
    return read
  }

  async #readInsight(query: InsightQuery, options: { readonly refresh?: boolean; readonly signal?: AbortSignal }): Promise<UsageDetail> {
    if (!Number.isFinite(query.from) || !Number.isFinite(query.to) || query.from >= query.to) {
      throw new Error('Choose a valid Insight time range.')
    }
    if (query.to - query.from > 90 * DAY) throw new Error('Insight reads at most 90 days at once.')
    if (options.signal?.aborted) throw new DOMException('Insight read cancelled.', 'AbortError')
    /* Insight caches source records at their native granularity.
       The SQLite ledger remains the fast aggregate dashboard, but has already
       discarded the call identity needed for conservative historical joins. */
    await this.warm()
    const detailSamples: UsageSample[] = []
    const detailSources: InsightSource[] = []
    const gaps: string[] = []
    let bytes = 0
    let targets: ScanTarget[] = []
    const corpora = query.runtime === undefined
      ? this.#options.corpora
      : this.#options.corpora.filter((corpus) => corpus.runtime === query.runtime)
    for (const corpus of corpora) {
      try {
        targets.push(...await listTargets([corpus], {
          unreadable: () => {
            // The source itself must say which runtime was unavailable, but
            // never expose the agent-owned corpus path or account details.
            detailSources.push(failedCorpusSource(corpus, this.#now(), 'Recorded usage source could not be discovered.'))
            gaps.push('A recorded usage source could not be discovered.')
          },
        }))
      }
      catch {
        // Discovery implementations can still fail outside their per-folder
        // callback. Preserve only the corpus identity and fixed public text;
        // their errors can include agent-owned paths or database details.
        detailSources.push(failedCorpusSource(corpus, this.#now(), 'Recorded usage source could not be discovered.'))
        gaps.push('Recorded usage source could not be discovered.')
      }
    }
    if (targets.length > 10_000) {
      gaps.push('Insight stopped before more than 10,000 source files. Choose a narrower range.')
      targets = targets.slice(0, 10_000)
    }
    for (const target of targets) {
      if (options.signal?.aborted) throw new DOMException('Insight read cancelled.', 'AbortError')
      // `bytes` is what scanners actually read, never a target's size at
      // discovery: a source rewritten or appended to after `listTargets` ran
      // can be larger now than that stale figure says, and trusting it here
      // would let such a source spend past what this read promises overall.
      if (target.mtime < query.from) continue
      try {
        const result = await this.#insightCache.read(target, this.#insightByteLimit - bytes, options.signal)
        detailSamples.push(...result.samples.map((sample) => ({ ...sample, source: { ...sample.source, checkedAt: this.#now() } })))
        if (result.limited && !gaps.includes(INSIGHT_BYTE_LIMIT_MESSAGE)) gaps.push(INSIGHT_BYTE_LIMIT_MESSAGE)
        // `bytesRead`, never `offset`: `offset` is the incremental-scan
        // cursor, advanced only for a line actually committed, and a line
        // `take()` rejects as not JSON was still read off disk before it
        // was rejected — `offset` alone said none of it had been (round 3
        // review).
        bytes += result.bytesRead
      } catch (error) {
        if ((error as { name?: string }).name === 'AbortError') throw error
        if (error instanceof InsightBudgetExceededError) { gaps.push(INSIGHT_BYTE_LIMIT_MESSAGE); break }
        // Read whole and then refused because it changed: what was read still counts.
        if (error instanceof InsightSourceChangedError) bytes += error.bytesRead
        detailSources.push(failedCorpusSource(target, this.#now(), 'Recorded usage source could not be read.'))
        // Database and filesystem errors often echo agent-owned paths. The
        // source carries the opaque identity; the rendered gap says only what
        // Insight can safely promise.
        gaps.push('A recorded usage source could not be read.')
      }
    }
    const selected = detailSamples.filter((sample) => sample.project === query.root && sample.from !== null && sample.from >= query.from && sample.from < query.to)
    const priced = selected.map((sample) => {
      if (sample.usd.value !== null || !sample.model) return sample
      const rates = this.#pricing.rateObservation(sample.model).rates
      if (!rates) return sample
      const parts = [sample.input, sample.output, sample.cacheRead, sample.cacheWrite]
      if (parts.some((part) => part.value === null)) return sample
      const value = sample.input.value! * rates.input + sample.output.value! * rates.output + sample.cacheRead.value! * rates.cacheRead + sample.cacheWrite.value! * rates.cacheWrite
      return { ...sample, usd: { value, quality: 'estimate' as const }, moneyBasis: 'listPrice' as const }
    })
    const readSources = [...new Map([
      ...detailSources,
      ...priced.map((sample) => sample.source),
    ].map((source) => [source.id, source])).values()]
    return {
      samples: priced, sources: readSources, gaps: [...gaps, ...(priced.some((sample) => sample.usd.value === null) ? ['Some recorded usage has no known USD rate.'] : [])],
      complete: priced.length > 0 && gaps.length === 0 && priced.every((sample) => sample.usd.value !== null),
    }
    /* c8 ignore next -- retained below as the aggregate implementation's
       reference for migrations; normal Insight reads return from source rows. */
    if (options.refresh) await this.scan()
    const checkedAt = this.#now()
    const rows = this.#store.since(startOfDay(query.from)).filter((row) => row.day < query.to && row.project === query.root)
    const sources = new Map<string, InsightSource>()
    const samples: UsageSample[] = rows.map((row, index) => {
      const sourceId = `ledger:${index}:${row.runtime}:${row.day}`
      const source: InsightSource = {
        id: sourceId,
        runtime: row.runtime,
        kind: 'corpus',
        label: 'Recorded agent usage',
        observedAt: row.day,
        checkedAt,
        stale: false,
        problem: null,
      }
      sources.set(sourceId, source)
      const tokens = row.input + row.output + row.cacheRead + row.cacheWrite
      const observed = this.#pricing.rateObservation(row.model)
      const vendor = typeof row.vendorCost === 'number'
      const priced = vendor
        ? { value: row.vendorCost!, quality: 'exact' as const }
        : observed.rates === null
          ? { value: null, quality: 'unknown' as const }
          : { value: row.input * observed.rates.input + row.output * observed.rates.output + row.cacheRead * observed.rates.cacheRead + row.cacheWrite * observed.rates.cacheWrite, quality: 'estimate' as const }
      return {
        key: `aggregate:${row.file}:${row.day}:${row.runtime}:${row.model}:${row.project}`,
        source,
        runtime: row.runtime,
        sessionId: null,
        turnId: null,
        requestId: null,
        project: row.project || null,
        model: row.model || null,
        from: row.day,
        to: row.day + DAY,
        scope: 'session',
        includesChildren: null,
        input: { value: row.input, quality: 'exact' },
        output: { value: row.output, quality: 'exact' },
        cacheRead: { value: row.cacheRead, quality: 'exact' },
        cacheWrite: { value: row.cacheWrite, quality: 'exact' },
        usd: priced,
        moneyBasis: vendor ? 'vendorMetered' : observed.rates ? 'listPrice' : 'unknown',
      }
    })
    return {
      samples,
      sources: [...sources.values()],
      gaps: samples.some((sample) => sample.usd.value === null) ? ['Some recorded usage has no known USD rate.'] : [],
      complete: samples.length > 0 && samples.every((sample) => sample.usd.value !== null),
    }
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

  /**
   * Every configured remote source, each at most once an hour and each
   * resuming from the day after its last successful sync (minus one day,
   * for events Cursor files a little after the fact). A source that fails —
   * signed out, a short read, the page cap, an envelope it cannot make sense
   * of — is left exactly as it was; nothing here ever publishes a partial
   * window as if it were complete.
   */
  async #syncRemote(): Promise<void> {
    for (const source of this.#options.remoteSources ?? []) {
      let file: string | null
      try {
        file = await source.resolveFile()
      } catch {
        file = null
      }
      if (file === null) continue // signed out, or its credential could not be read

      const now = this.#now()
      const syncedKey = `remote:${file}:syncedAt`
      const lastSyncedAt = Number(this.#store.meta(syncedKey) ?? '')
      if (source.syncEveryScan !== true && Number.isFinite(lastSyncedAt) && now - lastSyncedAt < HOUR) continue

      const dayKey = `remote:${file}:day`
      const lastDay = Number(this.#store.meta(dayKey) ?? '')
      const to = stepDay(startOfDay(now), 1) // tomorrow's local midnight: today is included, in progress or not
      // A local source can revise yesterday (an overnight turn may finish
      // after today's first scan), so each successful scan must replace the
      // whole recent window. Network sources keep their advancing cursor.
      const from = source.syncEveryScan === true || !Number.isFinite(lastDay) || lastDay <= 0
        ? stepDay(startOfDay(now), -REMOTE_INITIAL_DAYS)
        : stepDay(lastDay, -1)

      try {
        const result = await source.sync({ from, to }, file)
        if (!result) {
          this.#log('a remote usage source could not be read; its rows stand as they were', { source: source.runtime })
          continue
        }
        if (result.missing) {
          if (lastSyncedAt > 0) this.#log('a transcript runtime directory disappeared; its rows stand as they were', { source: source.runtime })
          continue
        }
        this.#store.replaceWindow(file, from, to, result.rows)
        this.#store.setMeta(dayKey, String(to))
        this.#store.setMeta(syncedKey, String(now))
      } catch (error) {
        this.#log('a remote usage source failed', { source: source.runtime, error })
      }
    }
  }

  async #doScan(full: boolean): Promise<void> {
    // Kicked off alongside the local scan, never awaited before it starts: a
    // cold 90-day Cursor sync (up to 200 pages x 15s) would otherwise delay
    // every local corpus's own progress for a source that isn't even the one
    // most scans are waiting on. The hourly throttle inside `#syncRemote`
    // still applies; only its own timing decides whether it does anything.
    const remoteSync = this.#syncRemote()
    const startedAt = this.#now()
    let targets: ScanTarget[] = []
    let discoveryFailures = 0
    try {
      for (const corpus of this.#options.corpora) {
        targets.push(...await listTargets([corpus], {
          unreadable: (_folder, error) => {
            discoveryFailures += 1
            this.#log('a folder of transcripts could not be read, so the usage in it was not counted', {
              kind: corpus.kind,
              failures: discoveryFailures,
              error,
            })
          },
        }))
      }
    } catch (error) {
      await remoteSync
      this.#report({
        ...IDLE,
        startedAt,
        finishedAt: this.#now(),
        error: 'Recorded usage source discovery failed.',
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
    let readFailures = 0
    for (const target of pending) {
      const cursor = full ? null : this.#store.cursor(target.path)
      // A file that shrank was rewritten, not appended to: its rows go and it
      // is read from the start, which the file-keyed rows make safe. A kind
      // that is always rewritten is always read that way.
      const rewritten = (cursor !== null && target.size < cursor.offset) || wholeFile(target.kind)
      const from = rewritten || cursor === null ? 0 : cursor.offset
      const tail = rewritten || cursor === null ? [] : cursor.tail
      try {
        const result = await scanFile(target, from, tail)
        this.#store.commit(
          { path: target.path, size: target.size, mtime: target.mtime, offset: result.offset, tail: result.tail },
          result.rows,
          this.#now(),
          full || rewritten,
          result.hours,
        )
      } catch (error) {
        readFailures += 1
        this.#log('a transcript could not be read', {
          kind: target.kind,
          failures: readFailures,
          error,
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

    await remoteSync
    this.#store.setMeta('scannedAt', String(this.#now()))
    // A scan just reached its own end, having read every pending target this
    // pass found (a fresh cursor for every file the migration's reset left
    // without one, among them) -- from here on, a turn-capable runtime's
    // count is trustworthy. See `LedgerStore.turnsReady`.
    this.#store.markTurnsReady()
    if (readFailures === 0 && discoveryFailures === 0) this.#store.markHoursReady()
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

  /**
   * `sum` when every runtime in `runtimes` is one this ledger was told has a
   * real turn count (`#turnRuntimes`); `undefined` otherwise — never a
   * partial number passed off as a whole one. `runtimes` empty (no row
   * contributed at all) is also undefined: there is nothing to know.
   */
  /**
   * Whether one runtime's turn count can be trusted at all: it has to be a
   * runtime this ledger was told has a real turn boundary, and the store
   * itself has to be past the gap a fresh `turns` column leaves — see
   * `LedgerStore.turnsReady`. A runtime that is turn-capable but asked for
   * before the first post-migration scan finishes is exactly as unknown as
   * one never configured at all, never a stale, too-low real count.
   */
  #turnKnown(runtime: string): boolean {
    return this.#turnRuntimes.has(runtime) && this.#store.turnsReady()
  }

  #turnsIfKnown(runtimes: ReadonlySet<string>, sum: number): number | undefined {
    if (runtimes.size === 0) return undefined
    for (const runtime of runtimes) {
      if (!this.#turnKnown(runtime)) return undefined
    }
    return sum
  }

  /**
   * How many turns one runtime ran since `sinceMs` — `null` when this ledger
   * was never told it has a real turn count at all (`LedgerOptions.turnRuntimes`),
   * or when the store has not finished a scan since the `turns` column was
   * added (`LedgerStore.turnsReady`) — both of which `UsageService` reads as
   * "unknown", never as zero. `since` is always local midnight of `sinceMs`,
   * the same rounding `#store.since` itself applies, so a caller cannot read
   * a window that starts earlier than what was actually counted.
   *
   * `source` says where the count came from: `'agent'` for a runtime whose
   * own transcript is the turn boundary (Codex, Claude Code, Gemini CLI,
   * Qwen Code — covering standalone use exactly as well as desk use),
   * `'desk'` for one that has no scanner of its own and is counted only from
   * what this desk itself recorded (Cursor, and any unrecognised ACP agent,
   * `ledger/desk-turns.ts`). The distinction matters because a desk-sourced
   * runtime's turns are desk-only while everything else a meter might report
   * about it is account-wide — see the owner's decision, "Turns",
   * `docs/usage-dashboard.md`.
   */
  turnsFor(runtime: RuntimeId, sinceMs: number): { readonly count: number; readonly since: number; readonly source: 'agent' | 'desk' } | null {
    if (!this.#turnKnown(runtime)) return null
    const since = startOfDay(sinceMs)
    const rows = this.#store.since(since, runtime)
    const count = rows.reduce((sum, row) => sum + (row.turns ?? 0), 0)
    return { count, since, source: this.#deskTurnRuntimes.has(runtime) ? 'desk' : 'agent' }
  }

  /** How many ledger requests (priced or not) one runtime logged since `sinceMs` — the same window `turnsFor` counted, for a per-turn rate. */
  requestsFor(runtime: RuntimeId, sinceMs: number): number {
    const rows = this.#store.since(startOfDay(sinceMs), runtime)
    return rows.reduce((sum, row) => sum + row.requests, 0)
  }

  /**
   * How much this runtime's ledger rows are worth since `sinceMs` — vendor
   * cost where a row carries one, list price otherwise, the same split
   * `#price` always applies — over exactly the window `requestsFor` and
   * `turnsFor` count, never `spendFor`'s own day-rounded window, which can
   * cover a different number of days for the same `sinceMs` (#1047 review).
   */
  valueFor(runtime: RuntimeId, sinceMs: number): number {
    const rows = this.#store.since(startOfDay(sinceMs), runtime)
    return rows.reduce((sum, row) => sum + this.#price(row).cost, 0)
  }

  #price(row: UsageRow): Priced {
    const tokens = row.input + row.output + row.cacheRead + row.cacheWrite
    // What the agent billed is what it cost, a free model's zero included.
    if (typeof row.vendorCost === 'number') {
      return { cost: row.vendorCost, tokens, priced: row.requests, unpriced: 0, vendor: row.requests }
    }
    // Nothing to price is not $0: a row with no tokens at all (Cursor's own
    // non-token completions, kept only for their request count) would
    // otherwise cost `0 x rates` on any catalogued model and be counted as
    // priced. Leave it unpriced instead.
    if (tokens === 0) return { cost: 0, tokens, priced: 0, unpriced: row.requests, vendor: 0 }
    const rates: ModelRates | null = this.#pricing.rateFor(row.model)
    if (!rates) return { cost: 0, tokens, priced: 0, unpriced: row.requests, vendor: 0 }
    const cost =
      row.input * rates.input +
      row.output * rates.output +
      row.cacheRead * rates.cacheRead +
      row.cacheWrite * rates.cacheWrite
    return { cost, tokens, priced: row.requests, unpriced: 0, vendor: 0 }
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
    let vendor = 0
    const byDay = new Map<number, { cost: number; tokens: number }>()
    for (const row of rows) {
      const cost = this.#price(row)
      windowCost += cost.cost
      windowTokens += cost.tokens
      priced += cost.priced
      unpriced += cost.unpriced
      vendor += cost.vendor
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
      provenance: provenanceOf(priced, vendor),
      coverage: {
        priced,
        unpriced,
        unmetered: 0,
        estimated: 0,
        daysCovered: this.#store.daysCovered(from, runtime),
        daysRequested: days,
        earliestDay: this.#store.earliestDay(runtime),
        turnsKnownFor: this.#turnKnown(runtime) ? [runtimeId(runtime)] : [],
      },
      daily: [...byDay.entries()]
        .sort(([a], [b]) => a - b)
        .map(([day, totals]) => ({ day, cost: anyPriced ? totals.cost : null, tokens: totals.tokens })),
    }
  }

  /** The Spend and *Where it went* bands. */
  query(request: LedgerQuery): LedgerReport {
    const days = Math.max(1, Math.min(365, Math.round(request.days)))
    const today = startOfDay(this.#now())
    const from = stepDay(today, 1 - days)
    const to = stepDay(today, 1)
    const rows = this.#store.since(from, request.runtime)

    let totalCost = 0
    let totalTokens = 0
    let priced = 0
    let unpriced = 0
    let vendor = 0
    // The split behind `totalTokens`, summed alongside it — never a second
    // pass over `rows`, and never a number that could disagree with the total
    // it is part of.
    const totals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, requests: 0, turns: 0 }
    // Every runtime any row in this window belongs to, so `totals.turns` can
    // be withheld the same way a mixed group's is — a window scanning one
    // turn-known agent and one that is not must not read as a real total.
    const allRuntimes = new Set<string>()
    interface Group {
      label: string
      /** Distinct paths behind one basename, so a collision can be told apart. */
      path: string
      runtimes: Set<string>
      cost: number
      tokens: number
      unpriced: boolean
      input: number
      output: number
      cacheRead: number
      cacheWrite: number
      reasoning: number
      requests: number
      turns: number
    }
    const groups = new Map<string, Group>()
    const daily = new Map<string, LedgerDay>()

    for (const row of rows) {
      const cost = this.#price(row)
      totalCost += cost.cost
      totalTokens += cost.tokens
      priced += cost.priced
      unpriced += cost.unpriced
      vendor += cost.vendor
      totals.input += row.input
      totals.output += row.output
      totals.cacheRead += row.cacheRead
      totals.cacheWrite += row.cacheWrite
      totals.reasoning += row.reasoning
      totals.requests += row.requests
      totals.turns += row.turns ?? 0
      allRuntimes.add(row.runtime)

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
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        reasoning: 0,
        requests: 0,
        turns: 0,
      }
      group.cost += cost.cost
      group.tokens += cost.tokens
      group.unpriced = group.unpriced || cost.unpriced > 0
      group.runtimes.add(row.runtime)
      group.input += row.input
      group.output += row.output
      group.cacheRead += row.cacheRead
      group.cacheWrite += row.cacheWrite
      group.reasoning += row.reasoning
      group.requests += row.requests
      group.turns += row.turns ?? 0
      groups.set(key, group)

      const dayKey = `${row.day}:${row.runtime}`
      const bucket = daily.get(dayKey) ?? {
        day: row.day,
        runtime: runtimeId(row.runtime),
        cost: 0,
        tokens: 0,
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        reasoning: 0,
        requests: 0,
        turns: 0,
      }
      const dayTurns = (bucket.turns ?? 0) + (row.turns ?? 0)
      daily.set(dayKey, {
        day: row.day,
        runtime: runtimeId(row.runtime),
        cost: bucket.cost + cost.cost,
        tokens: bucket.tokens + cost.tokens,
        input: (bucket.input ?? 0) + row.input,
        output: (bucket.output ?? 0) + row.output,
        cacheRead: (bucket.cacheRead ?? 0) + row.cacheRead,
        cacheWrite: (bucket.cacheWrite ?? 0) + row.cacheWrite,
        reasoning: (bucket.reasoning ?? 0) + row.reasoning,
        requests: (bucket.requests ?? 0) + row.requests,
        ...(this.#turnKnown(row.runtime) ? { turns: dayTurns } : {}),
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
      earliestDay: this.#store.earliestDay(request.runtime),
      turnsKnownFor: [...allRuntimes]
        .filter((runtime) => this.#turnKnown(runtime))
        .sort()
        .map((runtime) => runtimeId(runtime)),
      hoursKnownFor: this.#store.hoursReady()
        ? [...new Set(this.#options.corpora.filter((corpus) => HOUR_CAPABLE_KINDS.has(corpus.kind)).map((corpus) => corpus.runtime))]
          .filter((runtime) => request.runtime === undefined || runtime === request.runtime)
          .sort()
          .map((runtime) => runtimeId(runtime))
        : [],
    }
    const hoursKnown = coverage.hoursKnownFor ?? []
    const hourly: LedgerHour[] = hoursKnown.length > 0
      ? this.#store.hourly(from, to, request.runtime).map((bucket) => ({ ...bucket, runtime: runtimeId(bucket.runtime) }))
      : []
    const ordered: LedgerRow[] = [...groups.entries()]
      .map(([key, group]) => {
        const turnsKnown = this.#turnsIfKnown(group.runtimes, group.turns)
        return {
          key,
          label: group.label,
          // Named only when one agent owns the row; a shared project belongs
          // to no single mark, and showing one of them would be a lie.
          runtime:
            request.groupBy === 'runtime'
              ? null
              : group.runtimes.size === 1
                ? runtimeId([...group.runtimes][0] as string)
                : null,
          tokens: group.tokens,
          cost: anyPriced ? group.cost : null,
          hasUnpriced: group.unpriced,
          input: group.input,
          output: group.output,
          cacheRead: group.cacheRead,
          cacheWrite: group.cacheWrite,
          reasoning: group.reasoning,
          requests: group.requests,
          ...(turnsKnown !== undefined ? { turns: turnsKnown } : {}),
        }
      })
      .sort((a, b) => (b.cost ?? 0) - (a.cost ?? 0) || (b.tokens ?? 0) - (a.tokens ?? 0))

    const totalTurnsKnown = this.#turnsIfKnown(allRuntimes, totals.turns)
    const scannedAt = Number(this.#store.meta('scannedAt') ?? '')
    return {
      days,
      currency: 'USD',
      totalCost: anyPriced ? totalCost : null,
      totalTokens,
      // List price, the agents' own figures, or both. A request that could
      // not be priced either way is a hole in the coverage, not a third kind
      // of source, and the counts below are where that is said.
      provenance: provenanceOf(priced, vendor),
      coverage,
      rows: ordered,
      daily: [...daily.values()].sort((a, b) => a.day - b.day),
      ...(hoursKnown.length > 0 ? { hourly } : {}),
      scannedAt: Number.isFinite(scannedAt) && scannedAt > 0 ? scannedAt : null,
      totals: {
        input: totals.input,
        output: totals.output,
        cacheRead: totals.cacheRead,
        cacheWrite: totals.cacheWrite,
        reasoning: totals.reasoning,
        requests: totals.requests,
        ...(totalTurnsKnown !== undefined ? { turns: totalTurnsKnown } : {}),
      },
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
export type { RemoteEventsSource } from './remote.js'
export { corpusRoot, defaultCorpora, TURN_CAPABLE_KINDS, type CorpusKind, type CorpusSpec } from './scan.js'
export { LedgerStore } from './store.js'
export { DeskTranscriptTurnsSource, type DeskTranscriptExport, type DeskTranscriptReader } from './desk-turns.js'
