import type { UsageBilling, UsageCredits, UsageLane, UsageSource } from '@harnessdesk/protocol'

import { MeterAuthError, type MeterReading, type UsageMeter } from './meter.js'

/**
 * What an OpenRouter-backed account has left — a key's own limit (a metered
 * allowance) and the account's prepaid credit balance — for any agent this
 * desk starts with an `OPENROUTER_API_KEY` in the environment it launches
 * with. Which agents that is is decided by the key's presence, never by
 * which CLI is running: any row can point itself at OpenRouter, and the
 * moment it does, this is where its money is.
 *
 * `GET https://openrouter.ai/api/v1/key`
 * (https://openrouter.ai/docs/api-reference/limits), `Authorization: Bearer
 * <key>`: `{ data: { label, limit, limit_reset, limit_remaining, usage,
 * usage_daily, usage_weekly, usage_monthly, … } }`. A key with a `limit` is
 * a metered allowance against that ceiling — `unit: 'usd'`, `used: usage`,
 * `limit`, `layer: 'plan'`, `billing.kinds: ['metered']` — reset per the
 * key's own `limit_reset` ("daily" | "weekly" | "monthly" | null), which
 * names a period, not a date, so it is carried as `resetText`, never
 * invented as a timestamp. A key with no limit (`limit: null`) gets no lane
 * at all: spend is shown through the credit balance instead, and a ceiling
 * is never invented for a key that has none.
 *
 * `GET https://openrouter.ai/api/v1/credits`
 * (https://openrouter.ai/docs/api-reference/credits), the same header:
 * `{ data: { total_credits, total_usage } }` — the account-wide prepaid
 * balance, `remaining: total_credits - total_usage`, `unit: 'USD'`,
 * `billing.kinds` gains `'balance'`.
 *
 * The key itself is read once, used only in the `Authorization` header of
 * these two requests, and never logged, stored beyond this read, or echoed
 * into a report: the account label this meter reports is built from its own
 * last four characters, never OpenRouter's own `label` field, which can
 * itself be shaped like the key.
 */

const KEY_API = 'https://openrouter.ai/api/v1/key'
const CREDITS_API = 'https://openrouter.ai/api/v1/credits'
const TIMEOUT_MS = 8_000
const STALE_AFTER_MS = 5 * 60_000
const SECRET_ENV = 'OPENROUTER_API_KEY'

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
}

interface OpenRouterCreditsData {
  readonly total_credits?: number
  readonly total_usage?: number
}

/** `null` when the key carries no limit — never a lane with an invented ceiling. */
export const openRouterLane = (data: OpenRouterKeyData): UsageLane | null => {
  const limit = data.limit
  if (limit == null || !Number.isFinite(limit)) return null
  const used = typeof data.usage === 'number' && Number.isFinite(data.usage) ? data.usage : 0
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
  readonly env?: NodeJS.ProcessEnv
  readonly fetch?: typeof globalThis.fetch
  readonly now?: () => number
}

export class OpenRouterMeter implements UsageMeter {
  readonly id = 'openrouter-key'
  readonly source: UsageSource = { kind: 'api', label: 'from OpenRouter' }
  readonly #env: NodeJS.ProcessEnv
  readonly #fetch: typeof globalThis.fetch
  readonly #now: () => number

  constructor(options: OpenRouterMeterOptions = {}) {
    this.#env = options.env ?? process.env
    this.#fetch = options.fetch ?? globalThis.fetch
    this.#now = options.now ?? Date.now
  }

  /** The key and its balance live only on OpenRouter's server. */
  watchPaths(): readonly string[] {
    return []
  }

  async read(): Promise<MeterReading | null> {
    const key = this.#env[SECRET_ENV]?.trim()
    if (!key) return null

    const [keyBody, creditsBody] = await Promise.all([
      this.#get<{ data: OpenRouterKeyData }>(KEY_API, key),
      this.#get<{ data: OpenRouterCreditsData }>(CREDITS_API, key),
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
   * all); a 401/403 is the key being wrong, not silence — `MeterAuthError`
   * says so, never a message that repeats the key that failed.
   */
  async #get<T extends object>(url: string, key: string): Promise<T | null> {
    let response: Response
    try {
      response = await this.#fetch(url, {
        headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      })
    } catch (cause) {
      throw new Error(`OpenRouter usage could not be read: ${cause instanceof Error ? cause.message : String(cause)}`)
    }
    if (response.status === 401 || response.status === 403) {
      throw new MeterAuthError('OpenRouter usage: sign in, or check the API key')
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
