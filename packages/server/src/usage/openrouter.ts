import type { UsageBilling, UsageCredits, UsageLane, UsageSource } from '@harnessdesk/protocol'

import { MeterAuthError, type MeterReading, type UsageMeter } from './meter.js'

/**
 * What an OpenRouter-backed account has left — a key's own limit (a metered
 * allowance) and the account's prepaid credit balance — for any agent whose
 * *own* configuration (never HarnessDesk's own shell environment) names an
 * `OPENROUTER_API_KEY`. Which agents that is is decided by the row's own key,
 * never the desk's: a key exported where the desk itself launched from is
 * not a row's, and qualifying every row on it would attribute one account's
 * spend to agents that never asked for it. Any row can point itself at
 * OpenRouter with a key of its own, and the moment it does, this is where
 * its money is.
 *
 * `GET https://openrouter.ai/api/v1/key`
 * (https://openrouter.ai/docs/api-reference/limits), `Authorization: Bearer
 * <key>`: `{ data: { label, limit, limit_reset, limit_remaining, usage,
 * usage_daily, usage_weekly, usage_monthly, … } }`. A key with a `limit` is
 * a metered allowance against that ceiling — `unit: 'usd'`, `limit`,
 * `layer: 'plan'`, `billing.kinds: ['metered']` — reset per the key's own
 * `limit_reset` ("daily" | "weekly" | "monthly" | null), which names a
 * period, not a date, so it is carried as `resetText`, never invented as a
 * timestamp. `used` prefers `limit - limit_remaining` — the figure actually
 * measured against the current period's ceiling — over the lifetime
 * `usage` total, which keeps growing past a period that has already reset;
 * failing that, the `usage_daily`/`usage_weekly`/`usage_monthly` figure that
 * matches `limit_reset` is the next best period-scoped number, and only
 * the all-time `usage` is a last resort. A key with no limit (`limit:
 * null`) gets no lane at all: spend is shown through the credit balance
 * instead, and a ceiling is never invented for a key that has none.
 *
 * `GET https://openrouter.ai/api/v1/credits`
 * (https://openrouter.ai/docs/api-reference/credits), the same header:
 * `{ data: { total_credits, total_usage } }` — the account-wide prepaid
 * balance, `remaining: total_credits - total_usage`, `unit: 'USD'`,
 * `billing.kinds` gains `'balance'`. Unlike `/key`, this route needs a
 * *management* key (OpenRouter's docs list it under "Routes That Require a
 * Management Key"); an ordinary inference key reads it as a 401/403, which
 * is silence for this route alone — `null`, not `MeterAuthError` — never
 * discarding a `/key` lane that answered fine.
 *
 * The key itself is read fresh on every `read()` — never resolved once and
 * kept, the same way a spawn resolves a stored secret at the moment it
 * builds a process's environment — used only in the `Authorization` header
 * of these two requests, and never logged, stored beyond this read, or
 * echoed into a report: the account label this meter reports is built from
 * its own last four characters, never OpenRouter's own `label` field, which
 * can itself be shaped like the key.
 */

const KEY_API = 'https://openrouter.ai/api/v1/key'
const CREDITS_API = 'https://openrouter.ai/api/v1/credits'
const TIMEOUT_MS = 8_000
const STALE_AFTER_MS = 5 * 60_000
/** RFC 7230 `token` characters — what a header value can carry at all. */
const PRINTABLE_ASCII = /^[\x21-\x7e]+$/

/** How long a `limit_reset` period is, in minutes — for `UsageLane.windowMinutes`. Anything else is unknown, not invented. */
const RESET_WINDOW_MINUTES: Readonly<Record<string, number>> = {
  daily: 24 * 60,
  weekly: 7 * 24 * 60,
  monthly: 30 * 24 * 60,
}

interface OpenRouterKeyData {
  readonly limit?: number | null
  readonly limit_reset?: string | null
  readonly usage?: number
  readonly limit_remaining?: number | null
  readonly usage_daily?: number
  readonly usage_weekly?: number
  readonly usage_monthly?: number
}

interface OpenRouterCreditsData {
  readonly total_credits?: number
  readonly total_usage?: number
}

/**
 * What has actually been spent against the current period's ceiling —
 * `limit - limit_remaining` when OpenRouter reports one, else the
 * `usage_*` figure for the period `limit_reset` names, else the lifetime
 * `usage` total.
 */
const usedFor = (data: OpenRouterKeyData, limit: number): number => {
  if (typeof data.limit_remaining === 'number' && Number.isFinite(data.limit_remaining)) {
    return Math.max(0, limit - data.limit_remaining)
  }
  const byWindow = ({ daily: data.usage_daily, weekly: data.usage_weekly, monthly: data.usage_monthly } as Record<
    string,
    number | undefined
  >)[data.limit_reset ?? '']
  if (typeof byWindow === 'number' && Number.isFinite(byWindow)) return byWindow
  return typeof data.usage === 'number' && Number.isFinite(data.usage) ? data.usage : 0
}

/** `null` when the key carries no limit — never a lane with an invented ceiling. */
export const openRouterLane = (data: OpenRouterKeyData): UsageLane | null => {
  const limit = data.limit
  if (limit == null || !Number.isFinite(limit)) return null
  const used = usedFor(data, limit)
  return {
    id: 'key-limit',
    label: 'Key limit',
    unit: 'usd',
    used,
    limit,
    layer: 'plan',
    usedPercent: limit > 0 ? (used / limit) * 100 : 0,
    windowMinutes: data.limit_reset ? (RESET_WINDOW_MINUTES[data.limit_reset] ?? null) : null,
    resetsAt: null,
    resetText: data.limit_reset ?? null,
  }
}

/** `null` when the response does not carry both totals. */
export const openRouterCredits = (data: OpenRouterCreditsData): UsageCredits | null => {
  if (typeof data.total_credits !== 'number' || typeof data.total_usage !== 'number') return null
  if (!Number.isFinite(data.total_credits) || !Number.isFinite(data.total_usage)) return null
  return { remaining: data.total_credits - data.total_usage, unit: 'USD', unlimited: false }
}

export interface OpenRouterMeterOptions {
  /**
   * The row's own key, asked fresh on every `read()` rather than resolved
   * once at construction — the desk's broker, then the row's own
   * configured environment, never HarnessDesk's own shell. `undefined`
   * when this row has none, which makes `read()` silent rather than a
   * request with nothing to send.
   */
  readonly key?: () => string | undefined
  readonly fetch?: typeof globalThis.fetch
  readonly now?: () => number
}

export class OpenRouterMeter implements UsageMeter {
  readonly id = 'openrouter-key'
  readonly source: UsageSource = { kind: 'api', label: 'from OpenRouter' }
  readonly #keyFn: (() => string | undefined) | undefined
  readonly #fetch: typeof globalThis.fetch
  readonly #now: () => number

  constructor(options: OpenRouterMeterOptions = {}) {
    this.#keyFn = options.key
    this.#fetch = options.fetch ?? globalThis.fetch
    this.#now = options.now ?? Date.now
  }

  /** The key and its balance live only on OpenRouter's server. */
  watchPaths(): readonly string[] {
    return []
  }

  async read(): Promise<MeterReading | null> {
    const key = this.#keyFn?.()?.trim()
    if (!key) return null
    if (!PRINTABLE_ASCII.test(key)) {
      throw new Error('OpenRouter usage could not be read: the stored key is not a usable value.')
    }

    const [keyBody, creditsBody] = await Promise.all([
      this.#get<{ data: OpenRouterKeyData }>(KEY_API, key, { authMeansBadKey: true }),
      this.#get<{ data: OpenRouterCreditsData }>(CREDITS_API, key, { authMeansBadKey: false }),
    ])

    const lane = keyBody ? openRouterLane(keyBody.data) : null
    const credits = creditsBody ? openRouterCredits(creditsBody.data) : null
    if (!lane && !credits) return null

    const kinds: UsageBilling['kinds'] = credits ? (lane ? ['metered', 'balance'] : ['balance']) : ['metered']
    const laneSpent = lane && lane.limit != null && lane.used != null ? lane.used >= lane.limit : false
    const reached = credits && credits.remaining !== null && credits.remaining <= 0 ? 'credits' : laneSpent ? 'key limit' : null

    return {
      // The last four characters of the key itself, never OpenRouter's own
      // `label` field — which can be shaped like the key it names.
      account: `•••· ${key.slice(-4)}`,
      plan: null,
      lanes: lane ? [lane] : [],
      credits,
      reached,
      billing: { kinds },
      fetchedAt: this.#now(),
      staleAfterMs: STALE_AFTER_MS,
    }
  }

  /**
   * `null` on a shape this cannot use (a JSON body with no `data`, or none at
   * all) — and, for `/credits` alone, on a 401/403 too: that route needs a
   * management key no ordinary agent key carries, so a rejection there is
   * silence, never the whole read failing. `/key`'s own 401/403 is the key
   * being wrong, not silence — `authMeansBadKey` says which is which, and
   * `MeterAuthError` never repeats the key that failed.
   */
  async #get<T extends object>(url: string, key: string, options: { readonly authMeansBadKey: boolean }): Promise<T | null> {
    let response: Response
    try {
      response = await this.#fetch(url, {
        headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' },
        signal: AbortSignal.timeout(TIMEOUT_MS),
        redirect: 'error',
      })
    } catch (cause) {
      throw new Error(`OpenRouter usage could not be read: network error (${cause instanceof Error ? cause.name : 'unknown'})`)
    }
    if (response.status === 401 || response.status === 403) {
      if (options.authMeansBadKey) throw new MeterAuthError('OpenRouter usage: sign in, or check the API key')
      return null
    }
    if (!response.ok) throw new Error(`OpenRouter usage could not be read: HTTP ${response.status}`)
    try {
      const body = (await response.json()) as { data?: unknown }
      return typeof body?.data === 'object' && body.data !== null ? (body as T) : null
    } catch {
      return null
    }
  }
}
