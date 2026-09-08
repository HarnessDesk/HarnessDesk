import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

import type { UsageLane, UsageSource } from '@harnessdesk/protocol'

import { WINDOW_MINUTES, type MeterReading, type UsageMeter } from './meter.js'

/**
 * What Gemini Code Assist has left, from the credentials its CLI already holds.
 *
 * The CLI writes an OAuth result to `~/.gemini/oauth_creds.json` and refreshes
 * it whenever it runs. This meter **uses that access token while it is valid
 * and does nothing when it is not**: refreshing would mean holding Google's
 * client secret, which HarnessDesk has no business carrying and which is not
 * ours to lift out of another application. A user who has run the CLI in the
 * last hour has a meter; one who has not gets silence until they do.
 *
 * Two calls: `loadCodeAssist` names the tier and the project, and
 * `retrieveUserQuota` returns a bucket per model. An account without a Code
 * Assist licence is answered with `SUBSCRIPTION_REQUIRED`, which is a fact
 * about the account and not an error worth showing.
 */

const CREDENTIALS = '.gemini/oauth_creds.json'
const LOAD = 'https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist'
const QUOTA = 'https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota'
const TIMEOUT_MS = 8_000
const STALE_AFTER_MS = 5 * 60_000

interface Credentials {
  readonly access_token?: string
  readonly id_token?: string
  readonly expiry_date?: number
}

interface QuotaBucket {
  readonly remainingFraction?: number
  readonly resetTime?: string
  readonly modelId?: string
  readonly tokenType?: string
}

interface CodeAssist {
  readonly cloudaicompanionProject?: string
  readonly currentTier?: { readonly id?: string; readonly name?: string }
}

const parseDate = (value: string | undefined): number | null => {
  if (typeof value !== 'string') return null
  const at = Date.parse(value)
  return Number.isFinite(at) ? at : null
}

/**
 * One lane per model, at its tightest bucket.
 *
 * Google reports a bucket per model *and* token type; input and output tokens
 * for the same model are one allowance as far as a person is concerned, so the
 * one with least left speaks for the model.
 */
export const geminiLanes = (buckets: readonly QuotaBucket[]): UsageLane[] => {
  const tightest = new Map<string, QuotaBucket>()
  for (const bucket of buckets) {
    const model = bucket.modelId
    if (typeof model !== 'string' || model === '') continue
    if (typeof bucket.remainingFraction !== 'number' || !Number.isFinite(bucket.remainingFraction)) continue
    const known = tightest.get(model)
    if (!known || bucket.remainingFraction < (known.remainingFraction ?? 1)) tightest.set(model, bucket)
  }
  return [...tightest.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([model, bucket]) => ({
      id: `model:${model}`,
      label: 'Daily',
      scope: model,
      usedPercent: Math.min(100, Math.max(0, 100 - (bucket.remainingFraction ?? 0) * 100)),
      windowMinutes: WINDOW_MINUTES.daily,
      resetsAt: parseDate(bucket.resetTime),
      usageKnown: true,
    }))
}

/** The id token carries the address; the access token does not. */
export const geminiAccount = (idToken: string | undefined): string | null => {
  const payload = typeof idToken === 'string' ? idToken.split('.')[1] : undefined
  if (payload === undefined) return null
  try {
    const claims = JSON.parse(
      Buffer.from(payload.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'),
    ) as { email?: string }
    return typeof claims.email === 'string' && claims.email !== '' ? claims.email : null
  } catch {
    return null
  }
}

export interface GeminiMeterOptions {
  readonly credentialsPath?: string
  readonly loadEndpoint?: string
  readonly quotaEndpoint?: string
  readonly fetch?: typeof globalThis.fetch
  readonly now?: () => number
}

export class GeminiMeter implements UsageMeter {
  readonly id = 'gemini-account'
  readonly source: UsageSource = { kind: 'api', label: "from Google's quota API" }
  readonly #path: string
  readonly #load: string
  readonly #quota: string
  readonly #fetch: typeof globalThis.fetch
  readonly #now: () => number

  constructor(options: GeminiMeterOptions = {}) {
    this.#path = options.credentialsPath ?? join(homedir(), CREDENTIALS)
    this.#load = options.loadEndpoint ?? LOAD
    this.#quota = options.quotaEndpoint ?? QUOTA
    this.#fetch = options.fetch ?? globalThis.fetch
    this.#now = options.now ?? Date.now
  }

  /** The CLI rewrites this file on every refresh, which is exactly our cue. */
  watchPaths(): readonly string[] {
    return [this.#path]
  }

  async read(): Promise<MeterReading | null> {
    const credentials = await this.#credentials()
    if (credentials === null) return null
    const token = credentials.access_token
    if (typeof token !== 'string' || token === '') return null
    // An expired token is not a failure; the CLI will refresh it next time it
    // runs, and until then this meter has nothing it can honestly say.
    if (typeof credentials.expiry_date === 'number' && credentials.expiry_date <= this.#now()) return null

    const assist = await this.#post<CodeAssist>(this.#load, token, { metadata: { pluginType: 'GEMINI' } })
    if (assist === null) return null
    const project = typeof assist.cloudaicompanionProject === 'string' ? assist.cloudaicompanionProject : null

    const quota = await this.#post<{ buckets?: QuotaBucket[] }>(
      this.#quota,
      token,
      project ? { project } : {},
    )
    if (quota === null) return null

    const lanes = geminiLanes(quota.buckets ?? [])
    if (lanes.length === 0) return null

    const spent = lanes.find((entry) => entry.usedPercent >= 100)
    return {
      account: geminiAccount(credentials.id_token),
      plan: assist.currentTier?.name ?? null,
      lanes,
      credits: null,
      reached: spent?.id ?? null,
      fetchedAt: this.#now(),
      staleAfterMs: STALE_AFTER_MS,
    }
  }

  async #credentials(): Promise<Credentials | null> {
    try {
      return JSON.parse(await readFile(this.#path, 'utf8')) as Credentials
    } catch {
      return null
    }
  }

  /**
   * Null for every answer that means "this account has no quota to report" —
   * signed out, no licence, endpoint unavailable. Only a genuinely unexpected
   * status is worth putting on a card.
   */
  async #post<T>(url: string, token: string, body: unknown): Promise<T | null> {
    let response: Response
    try {
      response = await this.#fetch(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      })
    } catch (cause) {
      throw new Error(`Gemini usage could not be read: ${cause instanceof Error ? cause.message : String(cause)}`)
    }
    if (response.status === 401 || response.status === 403) return null
    if (!response.ok) throw new Error(`Gemini usage could not be read: HTTP ${response.status}`)
    try {
      return (await response.json()) as T
    } catch {
      return null
    }
  }
}
