import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import type { UsageLane, UsageSource } from '@harnessdesk/protocol'

import { WINDOW_MINUTES, type MeterReading, type UsageMeter } from './meter.js'

/**
 * What Cursor has left, from Cursor's own session and Cursor's own API.
 *
 * The editor keeps its session token in a VS Code state database it owns. We
 * open that database **read-only**, take one key, and put it straight back —
 * HarnessDesk never writes another application's credential store, and the
 * token never leaves the machine except to the vendor that issued it.
 *
 * The account's own dashboard is the only place the figure exists, so unlike
 * the file meters this one costs a request. It is therefore cached hard and
 * asked for only when somebody is looking.
 */

const DB = 'Library/Application Support/Cursor/User/globalStorage/state.vscdb'
const KEY = 'cursorAuth/accessToken'
const ENDPOINT = 'https://cursor.com/api/usage-summary'
const TIMEOUT_MS = 8_000

/** Cursor bills a month at a time, so an hour-old reading is still a good one. */
const STALE_AFTER_MS = 10 * 60_000

interface PlanUsage {
  readonly enabled?: boolean
  /** Cents. */
  readonly used?: number
  readonly limit?: number
  readonly remaining?: number
  readonly autoPercentUsed?: number
  readonly apiPercentUsed?: number
  readonly totalPercentUsed?: number
}

interface UsageSummary {
  readonly billingCycleEnd?: string
  readonly membershipType?: string
  readonly isUnlimited?: boolean
  readonly individualUsage?: {
    readonly plan?: PlanUsage
    readonly onDemand?: PlanUsage
    readonly overall?: PlanUsage
  }
  readonly teamUsage?: { readonly pooled?: PlanUsage; readonly onDemand?: PlanUsage }
}

const clamp = (value: number): number => Math.min(100, Math.max(0, value))

const ratio = (used: number | undefined, limit: number | undefined): number | null =>
  typeof used === 'number' && typeof limit === 'number' && limit > 0 ? clamp((used / limit) * 100) : null

const percent = (value: number | undefined): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? clamp(value) : null

/**
 * Which of the several figures Cursor reports is *the* figure.
 *
 * Cursor's own dashboard reads `totalPercentUsed`, and the cents underneath it
 * do not agree with it — an account can be at $19.99 of a $20 "included"
 * allowance and still be told it has used 6%. Showing the ratio instead would
 * make the desk contradict the vendor's own screen, so the vendor's number
 * wins and the rest are fallbacks in the order Cursor itself falls back.
 */
export const cursorPercentUsed = (summary: UsageSummary): number | null => {
  const plan = summary.individualUsage?.plan
  const total = percent(plan?.totalPercentUsed)
  if (total !== null) return total
  const auto = percent(plan?.autoPercentUsed)
  const api = percent(plan?.apiPercentUsed)
  if (auto !== null && api !== null) return clamp((auto + api) / 2)
  if (api !== null) return api
  if (auto !== null) return auto
  return (
    ratio(plan?.used, plan?.limit) ??
    ratio(summary.individualUsage?.overall?.used, summary.individualUsage?.overall?.limit) ??
    ratio(summary.teamUsage?.pooled?.used, summary.teamUsage?.pooled?.limit)
  )
}

/** "pro" is how the API spells it; "Pro" is how a person does. */
const planName = (membership: string | undefined): string | null => {
  if (!membership) return null
  const trimmed = membership.trim()
  if (trimmed === '') return null
  return trimmed.charAt(0).toUpperCase() + trimmed.slice(1)
}

const parseDate = (value: string | undefined): number | null => {
  if (typeof value !== 'string') return null
  const at = Date.parse(value)
  return Number.isFinite(at) ? at : null
}

/** The user id is the tail of the JWT's subject, and the cookie needs both. */
export const cursorCookie = (token: string): string | null => {
  const payload = token.split('.')[1]
  if (payload === undefined) return null
  let claims: { sub?: string; exp?: number }
  try {
    claims = JSON.parse(Buffer.from(payload.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'))
  } catch {
    return null
  }
  if (typeof claims.exp === 'number' && claims.exp * 1000 <= Date.now()) return null
  const subject = typeof claims.sub === 'string' ? claims.sub.split('|').pop() : null
  if (!subject || !/^[A-Za-z0-9._-]+$/.test(subject)) return null
  return `WorkosCursorSessionToken=${subject}%3A%3A${token}`
}

export interface CursorMeterOptions {
  readonly databasePath?: string
  readonly endpoint?: string
  readonly fetch?: typeof globalThis.fetch
  readonly now?: () => number
}

export class CursorMeter implements UsageMeter {
  readonly id = 'cursor-account'
  readonly source: UsageSource = { kind: 'api', label: "from Cursor's dashboard" }
  readonly #path: string
  readonly #endpoint: string
  readonly #fetch: typeof globalThis.fetch
  readonly #now: () => number

  constructor(options: CursorMeterOptions = {}) {
    this.#path = options.databasePath ?? join(homedir(), DB)
    this.#endpoint = options.endpoint ?? ENDPOINT
    this.#fetch = options.fetch ?? globalThis.fetch
    this.#now = options.now ?? Date.now
  }

  /**
   * The editor rewrites its state database constantly — every window layout
   * change — so watching it would mean a request per keystroke. This meter is
   * refreshed on the interval and by hand, never by a file watch.
   */
  watchPaths(): readonly string[] {
    return []
  }

  async read(): Promise<MeterReading | null> {
    const cookie = this.#session()
    if (cookie === null) return null

    let summary: UsageSummary
    try {
      const response = await this.#fetch(this.#endpoint, {
        headers: { Accept: 'application/json', Cookie: cookie },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      })
      // Signed out, or the token expired between the read and the request:
      // silence, not an error. There is nothing the desk can do about it.
      if (response.status === 401 || response.status === 403) return null
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      summary = (await response.json()) as UsageSummary
    } catch (cause) {
      throw new Error(`Cursor usage could not be read: ${cause instanceof Error ? cause.message : String(cause)}`)
    }

    const usedPercent = cursorPercentUsed(summary)
    const resetsAt = parseDate(summary.billingCycleEnd)
    const unlimited = summary.isUnlimited === true

    const lanes: UsageLane[] = []
    if (usedPercent !== null && !unlimited) {
      lanes.push({
        id: 'plan',
        label: 'Plan',
        usedPercent,
        windowMinutes: WINDOW_MINUTES.monthly,
        resetsAt,
        usageKnown: true,
      })
    }

    // The on-demand budget is the one part of this payload whose cents are
    // self-consistent — used + remaining is the limit — so both halves of it
    // can be believed, unlike the included-allowance cents above.
    const onDemand = summary.individualUsage?.onDemand ?? summary.teamUsage?.onDemand
    const credits =
      onDemand?.enabled === true && typeof onDemand.remaining === 'number'
        ? {
            remaining: onDemand.remaining / 100,
            ...(typeof onDemand.used === 'number' ? { used: onDemand.used / 100 } : {}),
            unit: 'USD' as const,
            unlimited: false,
          }
        : unlimited
          ? { remaining: null, unit: 'credits' as const, unlimited: true }
          : null

    if (lanes.length === 0 && credits === null) return null

    return {
      account: null,
      plan: planName(summary.membershipType),
      lanes,
      credits,
      reached: usedPercent !== null && usedPercent >= 100 ? 'plan' : null,
      fetchedAt: this.#now(),
      staleAfterMs: STALE_AFTER_MS,
    }
  }

  /** One key out of a database another application owns, and nothing else. */
  #session(): string | null {
    if (!existsSync(this.#path)) return null
    let database: DatabaseSync
    try {
      database = new DatabaseSync(this.#path, { readOnly: true })
    } catch {
      // Locked, or mid-write. The next read finds it.
      return null
    }
    try {
      const row = database.prepare('SELECT value FROM ItemTable WHERE key = ? LIMIT 1').get(KEY) as
        | { value?: unknown }
        | undefined
      const token = typeof row?.value === 'string' ? row.value.trim() : null
      return token && token !== '' ? cursorCookie(token) : null
    } catch {
      return null
    } finally {
      database.close()
    }
  }
}
