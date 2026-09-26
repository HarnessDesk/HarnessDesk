import { createHash } from 'node:crypto'
import { join } from 'node:path'

import { runtimeId, type LedgerDay,
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
import { listTargets, scanFile, wholeFile, type CorpusSpec, type ScanTarget } from './scan.js'
import { LedgerStore, type UsageRow } from './store.js'
import { INSIGHT_BYTE_LIMIT, INSIGHT_BYTE_LIMIT_MESSAGE, InsightBudgetExceededError, InsightSourceChangedError, type UsageDetail, type UsageSample } from './insight.js'

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
 * How far back a remote source's *first* sync reaches, absent any earlier
 * one to resume from. Ninety days rather than the account's own billing
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
  #progress: ScanProgress = IDLE
  #scanning: Promise<void> | null = null
  #warmed: Promise<void> | null = null

  constructor(options: LedgerOptions) {
    this.#options = options
    this.#insightByteLimit = options.insightByteLimit ?? INSIGHT_BYTE_LIMIT
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
    if (!Number.isFinite(query.from) || !Number.isFinite(query.to) || query.from >= query.to) {
      throw new Error('Choose a valid Insight time range.')
    }
    if (query.to - query.from > 90 * DAY) throw new Error('Insight reads at most 90 days at once.')
    if (options.signal?.aborted) throw new DOMException('Insight read cancelled.', 'AbortError')
    /* Insight deliberately reads the source records once at their native granularity.
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
      if (bytes >= this.#insightByteLimit) { gaps.push(INSIGHT_BYTE_LIMIT_MESSAGE); break }
      try {
        const result = await scanFile(target, 0, [], { emit: (sample) => detailSamples.push(sample), signal: options.signal, byteLimit: this.#insightByteLimit - bytes })
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
      if (Number.isFinite(lastSyncedAt) && now - lastSyncedAt < HOUR) continue

      const dayKey = `remote:${file}:day`
      const lastDay = Number(this.#store.meta(dayKey) ?? '')
      const to = stepDay(startOfDay(now), 1) // tomorrow's local midnight: today is included, in progress or not
      const from = Number.isFinite(lastDay) && lastDay > 0 ? stepDay(lastDay, -1) : stepDay(startOfDay(now), -REMOTE_INITIAL_DAYS)

      try {
        const result = await source.sync({ from, to }, file)
        if (!result) {
          this.#log('a remote usage source could not be read; its rows stand as they were', { source: source.runtime })
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
    let vendor = 0
    // The split behind `totalTokens`, summed alongside it — never a second
    // pass over `rows`, and never a number that could disagree with the total
    // it is part of.
    const totals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, requests: 0 }
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
      }
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
        input: group.input,
        output: group.output,
        cacheRead: group.cacheRead,
        cacheWrite: group.cacheWrite,
        reasoning: group.reasoning,
        requests: group.requests,
      }))
      .sort((a, b) => (b.cost ?? 0) - (a.cost ?? 0) || (b.tokens ?? 0) - (a.tokens ?? 0))

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
      scannedAt: Number.isFinite(scannedAt) && scannedAt > 0 ? scannedAt : null,
      totals,
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
export { corpusRoot, defaultCorpora, type CorpusKind, type CorpusSpec } from './scan.js'
export { LedgerStore } from './store.js'
