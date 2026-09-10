import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

/**
 * What a model costs, per token.
 *
 * No rates are bundled. A wrong price is worse than no price — it produces a
 * confident figure nobody can audit — so a model we have no rate for stays
 * *unpriced*, is counted as such, and never contributes a zero to a total.
 *
 * Two sources, in order: the user's own overlay, then models.dev, which
 * publishes a keyless catalogue of public list prices. The catalogue is
 * fetched at most once a day, carries no account data in either direction, and
 * a failure leaves the last good copy in place.
 */

export interface ModelRates {
  /** USD per token. */
  readonly input: number
  readonly output: number
  readonly cacheRead: number
  readonly cacheWrite: number
}

export interface PricingOptions {
  readonly cachePath: string
  readonly overlayPath: string
  /** Injectable for tests, and the seam where a user could turn the fetch off. */
  readonly fetchCatalogue?: () => Promise<unknown>
  readonly ttlMs?: number
  readonly now?: () => number
  readonly log?: (message: string, details?: Record<string, unknown>) => void
}

const CATALOGUE_URL = 'https://models.dev/api.json'

/** What a dated id adds to its undated name: `-20251001`, `-2024-11-20`, `@20240620`, `-latest`. */
const DATED = /^[-@](?:\d{8}|\d{4}-\d{2}-\d{2}|latest)$/

/** Whether `long` is `short` with nothing added but a date. */
const datedFormOf = (long: string, short: string): boolean =>
  long.length > short.length && long.startsWith(short) && DATED.test(long.slice(short.length))
const DAY = 86_400_000
const PER_MILLION = 1_000_000

/**
 * Which vendor's catalogue a bare model id belongs to.
 *
 * Deliberately narrow: an id we cannot attribute with confidence is left
 * unpriced rather than matched against whichever vendor happens to publish a
 * model of the same name.
 */
const vendorFor = (model: string): string | null => {
  const id = model.toLowerCase()
  if (id.startsWith('claude-')) return 'anthropic'
  if (id.startsWith('gpt-') || id.startsWith('o1') || id.startsWith('o3') || id.startsWith('codex-')) {
    return 'openai'
  }
  if (id.startsWith('gemini-')) return 'google'
  if (id.startsWith('deepseek')) return 'deepseek'
  if (id.startsWith('grok-')) return 'xai'
  if (id.startsWith('kimi-') || id.startsWith('moonshot')) return 'moonshotai'
  if (id.startsWith('qwen')) return 'alibaba'
  return null
}

interface RawCost {
  readonly input?: number
  readonly output?: number
  readonly cache_read?: number
  readonly cache_write?: number
}

interface RawModel {
  readonly id?: string
  readonly cost?: RawCost
}

interface RawProvider {
  readonly models?: Record<string, RawModel>
}

type RawCatalogue = Record<string, RawProvider>

interface CachedCatalogue {
  readonly fetchedAt: number
  readonly catalogue: RawCatalogue
}

/** models.dev publishes USD per million tokens; everything here is per token. */
const ratesFrom = (cost: RawCost | undefined): ModelRates | null => {
  if (!cost) return null
  const input = cost.input
  const output = cost.output
  if (typeof input !== 'number' || typeof output !== 'number') return null
  if (!Number.isFinite(input) || !Number.isFinite(output) || input < 0 || output < 0) return null
  const read = typeof cost.cache_read === 'number' && cost.cache_read >= 0 ? cost.cache_read : input
  const write = typeof cost.cache_write === 'number' && cost.cache_write >= 0 ? cost.cache_write : input
  return {
    input: input / PER_MILLION,
    output: output / PER_MILLION,
    cacheRead: read / PER_MILLION,
    cacheWrite: write / PER_MILLION,
  }
}

/** An overlay row is USD per million too, so one number means one thing everywhere. */
const ratesFromOverlay = (value: unknown): ModelRates | null => {
  if (typeof value !== 'object' || value === null) return null
  const row = value as Record<string, unknown>
  const num = (...keys: string[]): number | undefined => {
    for (const key of keys) {
      const found = row[key]
      if (typeof found === 'number' && Number.isFinite(found) && found >= 0) return found
    }
    return undefined
  }
  const input = num('input')
  const output = num('output')
  if (input === undefined || output === undefined) return null
  return {
    input: input / PER_MILLION,
    output: output / PER_MILLION,
    cacheRead: (num('cacheRead', 'cache_read') ?? input) / PER_MILLION,
    cacheWrite: (num('cacheWrite', 'cache_write', 'cacheCreation', 'cache_creation') ?? input) / PER_MILLION,
  }
}

export class Pricing {
  readonly #options: PricingOptions
  readonly #overlay = new Map<string, ModelRates>()
  #catalogue: RawCatalogue | null = null
  #fetchedAt = 0
  #refreshing: Promise<void> | null = null

  constructor(options: PricingOptions) {
    this.#options = options
  }

  #now(): number {
    return this.#options.now?.() ?? Date.now()
  }

  /** Loads the overlay and the cached catalogue; refreshes the catalogue if it is stale. */
  async warm(): Promise<void> {
    await this.#loadOverlay()
    await this.#loadCache()
    const ttl = this.#options.ttlMs ?? DAY
    if (this.#catalogue === null || this.#now() - this.#fetchedAt > ttl) await this.refresh()
  }

  async refresh(): Promise<void> {
    if (this.#refreshing) return this.#refreshing
    this.#refreshing = this.#doRefresh().finally(() => {
      this.#refreshing = null
    })
    return this.#refreshing
  }

  async #doRefresh(): Promise<void> {
    const fetcher = this.#options.fetchCatalogue ?? defaultFetch
    try {
      const raw = await fetcher()
      if (typeof raw !== 'object' || raw === null) return
      this.#catalogue = raw as RawCatalogue
      this.#fetchedAt = this.#now()
      const payload: CachedCatalogue = { fetchedAt: this.#fetchedAt, catalogue: this.#catalogue }
      await mkdir(dirname(this.#options.cachePath), { recursive: true })
      await writeFile(this.#options.cachePath, JSON.stringify(payload), 'utf8')
    } catch (error) {
      // The last good copy stays usable; prices are advisory, not load-bearing.
      this.#options.log?.('the model price catalogue could not be refreshed', {
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  /** Null when we have no rate for this model — the caller counts it as unpriced. */
  rateFor(model: string): ModelRates | null {
    const key = model.trim().toLowerCase()
    if (key === '') return null
    const vendor = vendorFor(key)
    // A bare key wins over a qualified one, matching the overlay's documented rule.
    const overlaid = this.#overlay.get(key) ?? (vendor ? this.#overlay.get(`${vendor}/${key}`) : undefined)
    if (overlaid) return overlaid
    if (!this.#catalogue || !vendor) return null
    const models = this.#catalogue[vendor]?.models
    if (!models) return null
    const exact = models[key] ?? models[model]
    if (exact) return ratesFrom(exact.cost)
    /* A dated id and its undated name are one model, and nothing else is.
       Providers date their ids (`claude-haiku-4-5-20251001`) where the
       catalogue usually carries the undated one; the catalogue sometimes
       carries only dated ids for a name a runtime reports undated. Either
       way round, the longer must be the shorter plus a date. Prefix matches
       priced a model the catalogue lacks as a variant of it — the other way
       round as a longer variant (#32), this way round as the base (review,
       round one) — and a wrong price is worse than none. */
    let best: RawModel | null = null
    let newest = ''
    for (const [id, entry] of Object.entries(models)) {
      const candidate = id.toLowerCase()
      // The asked id is a dated form of this one: its price, and only one can be.
      if (datedFormOf(key, candidate)) return ratesFrom(entry.cost)
      // This one is a dated form of the asked id: the newest, and `-latest` over any date.
      if (datedFormOf(candidate, key)) {
        // One with no price gives way to an older one that has one (review, round 2).
        if (!ratesFrom(entry.cost)) continue
        const suffix = candidate.slice(key.length)
        const rank = suffix.endsWith('latest') ? '\uffff' : suffix.replace(/\D/g, '')
        if (rank > newest) {
          best = entry
          newest = rank
        }
      }
    }
    return best ? ratesFrom(best.cost) : null
  }

  async #loadOverlay(): Promise<void> {
    this.#overlay.clear()
    let raw: string
    try {
      raw = await readFile(this.#options.overlayPath, 'utf8')
    } catch {
      return
    }
    try {
      const parsed: unknown = JSON.parse(raw)
      if (typeof parsed !== 'object' || parsed === null) return
      for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
        const rates = ratesFromOverlay(value)
        if (rates) this.#overlay.set(key.trim().toLowerCase(), rates)
      }
    } catch (error) {
      this.#options.log?.('the price overlay could not be read', {
        path: this.#options.overlayPath,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  async #loadCache(): Promise<void> {
    try {
      const raw = await readFile(this.#options.cachePath, 'utf8')
      const parsed = JSON.parse(raw) as CachedCatalogue
      if (typeof parsed.fetchedAt === 'number' && typeof parsed.catalogue === 'object') {
        this.#catalogue = parsed.catalogue
        this.#fetchedAt = parsed.fetchedAt
      }
    } catch {
      // No cache yet.
    }
  }
}

const defaultFetch = async (): Promise<unknown> => {
  const response = await fetch(CATALOGUE_URL, {
    signal: AbortSignal.timeout(15_000),
    headers: { accept: 'application/json' },
  })
  if (!response.ok) throw new Error(`models.dev answered ${response.status}`)
  return response.json()
}

export const defaultPricingPaths = (stateDir: string): { cachePath: string; overlayPath: string } => ({
  cachePath: join(stateDir, 'cache', 'model-pricing.json'),
  overlayPath: join(stateDir, 'pricing.json'),
})
