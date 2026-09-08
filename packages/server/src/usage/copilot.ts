import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

import type { UsageLane, UsageSource } from '@harnessdesk/protocol'

import { WINDOW_MINUTES, type MeterReading, type UsageMeter } from './meter.js'

/**
 * What Copilot has left, from the token its own CLI already stored.
 *
 * The plugin writes an OAuth token to a JSON file in the user's config
 * directory; `/copilot_internal/user` answers with the quota snapshots the
 * Copilot UI itself shows. Read-only, and nothing is written back.
 *
 * Copilot reports two quotas — premium interactions and chat — and a plan that
 * may have neither, because token-based billing has no window to run out of.
 * A plan with no window is not a plan at 0%: it produces no lane at all.
 */

const CONFIG = ['.config/github-copilot/apps.json', '.config/github-copilot/hosts.json']
const ENDPOINT = 'https://api.github.com/copilot_internal/user'
const TIMEOUT_MS = 8_000
const STALE_AFTER_MS = 10 * 60_000

interface QuotaSnapshot {
  readonly entitlement?: number
  readonly remaining?: number
  readonly percent_remaining?: number
  readonly unlimited?: boolean
  readonly overage_permitted?: boolean
  readonly credits_used?: number
}

interface CopilotUser {
  readonly copilot_plan?: string
  readonly quota_reset_date?: string
  readonly token_based_billing?: boolean
  readonly quota_snapshots?: {
    readonly premium_interactions?: QuotaSnapshot
    readonly chat?: QuotaSnapshot
  }
}

/**
 * A quota GitHub reports as all zeros with no percentage is a slot it left
 * empty, not a quota that is spent. Rendering it would put a full red bar on
 * an account with nothing wrong with it.
 */
export const isPlaceholderQuota = (snapshot: QuotaSnapshot): boolean =>
  snapshot.unlimited !== true &&
  (snapshot.entitlement ?? 0) === 0 &&
  (snapshot.remaining ?? 0) === 0 &&
  snapshot.percent_remaining === undefined

const laneFrom = (
  id: string,
  label: string,
  snapshot: QuotaSnapshot | undefined,
  resetsAt: number | null,
): UsageLane | null => {
  if (!snapshot) return null
  if (snapshot.unlimited === true) return null
  if (isPlaceholderQuota(snapshot)) return null
  const remaining = typeof snapshot.percent_remaining === 'number' ? snapshot.percent_remaining : null
  const used =
    remaining !== null
      ? Math.min(100, Math.max(0, 100 - remaining))
      : typeof snapshot.entitlement === 'number' &&
          snapshot.entitlement > 0 &&
          typeof snapshot.remaining === 'number'
        ? Math.min(100, Math.max(0, ((snapshot.entitlement - snapshot.remaining) / snapshot.entitlement) * 100))
        : null
  if (used === null) return null
  return {
    id,
    label,
    usedPercent: used,
    windowMinutes: WINDOW_MINUTES.monthly,
    resetsAt,
    usageKnown: true,
  }
}

/** The plugin's own file holds `{ "github.com": { oauth_token } }`, keyed by host. */
export const copilotToken = (body: string): string | null => {
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) return null
  for (const value of Object.values(parsed as Record<string, unknown>)) {
    if (typeof value !== 'object' || value === null) continue
    const token = (value as { oauth_token?: unknown }).oauth_token
    if (typeof token === 'string' && token.trim() !== '') return token.trim()
  }
  return null
}

export interface CopilotMeterOptions {
  readonly configPaths?: readonly string[]
  readonly endpoint?: string
  readonly fetch?: typeof globalThis.fetch
  readonly now?: () => number
}

export class CopilotMeter implements UsageMeter {
  readonly id = 'copilot-account'
  readonly source: UsageSource = { kind: 'api', label: "from GitHub's own quota" }
  readonly #paths: readonly string[]
  readonly #endpoint: string
  readonly #fetch: typeof globalThis.fetch
  readonly #now: () => number

  constructor(options: CopilotMeterOptions = {}) {
    this.#paths = options.configPaths ?? CONFIG.map((path) => join(homedir(), path))
    this.#endpoint = options.endpoint ?? ENDPOINT
    this.#fetch = options.fetch ?? globalThis.fetch
    this.#now = options.now ?? Date.now
  }

  /** The token file changes when the user signs in or out — both worth a re-read. */
  watchPaths(): readonly string[] {
    return this.#paths
  }

  async read(): Promise<MeterReading | null> {
    const token = await this.#token()
    if (token === null) return null

    let user: CopilotUser
    try {
      const response = await this.#fetch(this.#endpoint, {
        headers: { Accept: 'application/json', Authorization: `token ${token}` },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      })
      if (response.status === 401 || response.status === 403) return null
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      user = (await response.json()) as CopilotUser
    } catch (cause) {
      throw new Error(`Copilot usage could not be read: ${cause instanceof Error ? cause.message : String(cause)}`)
    }

    const resetsAt = user.quota_reset_date ? Date.parse(`${user.quota_reset_date}T00:00:00Z`) : NaN
    const resets = Number.isFinite(resetsAt) ? resetsAt : null
    const lanes = [
      laneFrom('premium', 'Premium', user.quota_snapshots?.premium_interactions, resets),
      laneFrom('chat', 'Chat', user.quota_snapshots?.chat, resets),
    ].filter((entry): entry is UsageLane => entry !== null)

    if (lanes.length === 0) return null

    const spent = lanes.find((entry) => entry.usedPercent >= 100)
    return {
      account: null,
      plan: user.copilot_plan ? user.copilot_plan.charAt(0).toUpperCase() + user.copilot_plan.slice(1) : null,
      lanes,
      credits: null,
      reached: spent?.id ?? null,
      fetchedAt: this.#now(),
      staleAfterMs: STALE_AFTER_MS,
    }
  }

  async #token(): Promise<string | null> {
    for (const path of this.#paths) {
      try {
        const token = copilotToken(await readFile(path, 'utf8'))
        if (token !== null) return token
      } catch {
        // Absent is the common case, not an error.
      }
    }
    return null
  }
}
