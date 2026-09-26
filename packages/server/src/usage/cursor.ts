import { createHash } from 'node:crypto'
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
 *
 * **A legacy, request-based plan.** `usage-summary`'s cents and percents are
 * one pool — the dollar-denominated "included total usage" — and on an
 * account still on Cursor's older request-quota tier that pool is not the
 * account's real ceiling at all: the old `GET /api/usage?user=<id>` counter
 * (`numRequests` of `maxRequestUsage`) is the one the account is actually
 * billed against, and it can be spent while `usage-summary` still reads as
 * mostly left. So the legacy endpoint is asked whenever the account is not
 * unlimited, never only when `usage-summary` has nothing to say, and its
 * counter is trusted only when it is plainly *this* cycle: `startOfMonth`
 * has to equal the summary's `billingCycleStart` (or, lacking one, fall
 * within the last 31 days) — otherwise it is the genuinely vestigial case, a
 * retired quota left behind on a dollar account (see
 * `docs/usage-dashboard.md`, "A request counter can outlive its plan"), and
 * is skipped. When it is live, the request lane is the primary one — the
 * card's headline and `reached` come from it alone — and the summary's plan
 * percent rides after it as the comparable scale, never the driver. The
 * subject the endpoint needs is the same one `cursorCookie` already reads out
 * of the session token, so no extra round trip fetches it.
 */

const DB = 'Library/Application Support/Cursor/User/globalStorage/state.vscdb'
const KEY = 'cursorAuth/accessToken'
const ENDPOINT = 'https://cursor.com/api/usage-summary'
const LEGACY_ENDPOINT = 'https://cursor.com/api/usage'
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
  readonly billingCycleStart?: string
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

/**
 * A calendar-safe month added to an epoch, in UTC throughout so no local
 * clock's DST shift can move it: the billing cycle a legacy account's
 * `startOfMonth` opens is exactly one calendar month, not a fixed count of
 * milliseconds. A start day the target month does not have — the 31st into a
 * 30- or 28-day month — clamps to that month's last day rather than rolling
 * into the one after, the way a billing cycle actually behaves.
 */
export const addCalendarMonth = (epochMs: number): number => {
  const start = new Date(epochMs)
  const year = start.getUTCFullYear()
  const month = start.getUTCMonth()
  const day = start.getUTCDate()
  const daysInTarget = new Date(Date.UTC(year, month + 2, 0)).getUTCDate()
  return Date.UTC(
    year,
    month + 1,
    Math.min(day, daysInTarget),
    start.getUTCHours(),
    start.getUTCMinutes(),
    start.getUTCSeconds(),
    start.getUTCMilliseconds(),
  )
}

/** The legacy endpoint's own cycle marker, one calendar month wide. */
const cursorCycleEnd = (startOfMonth: string | undefined): number | null => {
  const start = parseDate(startOfMonth)
  return start === null ? null : addCalendarMonth(start)
}

const THIRTY_ONE_DAYS_MS = 31 * 24 * 60 * 60 * 1_000

/**
 * A legacy bucket is only trusted for the cycle it claims: its own
 * `startOfMonth` has to equal the summary's `billingCycleStart` exactly, or,
 * when the summary carries no cycle start at all, fall within the last 31
 * days of `now`. Anything else is the genuinely vestigial case — a retired
 * quota left behind on an account that has since moved on — and is skipped
 * rather than shown as though it were the current cycle.
 */
const legacyBucketIsLive = (
  startOfMonth: string | undefined,
  billingCycleStart: string | undefined,
  now: number,
): boolean => {
  const start = parseDate(startOfMonth)
  if (start === null) return false
  const cycleStart = parseDate(billingCycleStart)
  if (cycleStart !== null) return start === cycleStart
  const age = now - start
  return age >= 0 && age <= THIRTY_ONE_DAYS_MS
}

/** One model bucket from `GET /api/usage?user=<id>` — field names as measured. */
interface LegacyModelUsage {
  readonly numRequests?: number
  readonly numRequestsTotal?: number
  readonly numTokens?: number
  readonly maxRequestUsage?: number | null
  readonly maxTokenUsage?: number | null
}

/** `gpt-4` → `Gpt 4`; there is no vendor wording to prefer over this yet. */
const modelLabel = (key: string): string =>
  key
    .replace(/[-_]+/g, ' ')
    .trim()
    .replace(/\b\w/g, (letter) => letter.toUpperCase()) || key

/**
 * The legacy response's per-model buckets turned into lanes — one lane with
 * the total when only one model carries a limit, a lane per model, scoped,
 * when more than one does. A bucket with no `maxRequestUsage` (or a request
 * count in some other shape) is not a usable limit and is skipped.
 */
export const legacyRequestLanes = (
  usage: Readonly<Record<string, unknown>>,
  resetsAt: number | null,
): UsageLane[] => {
  const models = Object.entries(usage).filter(
    (entry): entry is [string, LegacyModelUsage] => {
      if (entry[0] === 'startOfMonth') return false
      const value = entry[1]
      if (typeof value !== 'object' || value === null) return false
      const bucket = value as LegacyModelUsage
      return (
        typeof bucket.maxRequestUsage === 'number' &&
        bucket.maxRequestUsage > 0 &&
        typeof bucket.numRequests === 'number'
      )
    },
  )
  const single = models.length === 1
  return models.map(([key, bucket]) => {
    const used = bucket.numRequests as number
    const limit = bucket.maxRequestUsage as number
    return {
      id: single ? 'requests' : `requests:${key}`,
      label: 'Requests',
      unit: 'requests',
      used,
      limit,
      // Deliberately not clamped — see `UsageLane.usedPercent`.
      usedPercent: (used / limit) * 100,
      windowMinutes: WINDOW_MINUTES.monthly,
      resetsAt,
      layer: 'plan',
      ...(single ? {} : { scope: modelLabel(key) }),
    }
  })
}

/**
 * The stable user id out of the JWT's own subject — the tail after its
 * issuer prefix. Both the session cookie and the legacy endpoint's `?user=`
 * need it, so this is the one place that reads it out of the token.
 */
const jwtSubject = (token: string): string | null => {
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
  return subject && /^[A-Za-z0-9._-]+$/.test(subject) ? subject : null
}

/** The user id is the tail of the JWT's subject, and the cookie needs both. */
export const cursorCookie = (token: string): string | null => {
  const subject = jwtSubject(token)
  return subject === null ? null : `WorkosCursorSessionToken=${subject}%3A%3A${token}`
}

/**
 * A stable, anonymous stand-in for the account's own subject — SHA-256,
 * truncated — never the subject itself. The events reader keys its ledger
 * rows on this rather than on the account's own id or email.
 */
export const cursorAccountHash = (token: string): string | null => {
  const subject = jwtSubject(token)
  return subject === null ? null : createHash('sha256').update(subject).digest('hex').slice(0, 16)
}

/** One key out of a database another application owns, and nothing else. */
export const readCursorToken = (path: string): string | null => {
  if (!existsSync(path)) return null
  let database: DatabaseSync
  try {
    database = new DatabaseSync(path, { readOnly: true })
  } catch {
    // Locked, or mid-write. The next read finds it.
    return null
  }
  try {
    const row = database.prepare('SELECT value FROM ItemTable WHERE key = ? LIMIT 1').get(KEY) as
      | { value?: unknown }
      | undefined
    const token = typeof row?.value === 'string' ? row.value.trim() : null
    return token && token !== '' ? token : null
  } catch {
    return null
  } finally {
    database.close()
  }
}

export interface CursorMeterOptions {
  readonly databasePath?: string
  readonly endpoint?: string
  /** `GET /api/usage?user=<id>` — a legacy request-based plan's real figure. */
  readonly legacyEndpoint?: string
  readonly fetch?: typeof globalThis.fetch
  readonly now?: () => number
}

export class CursorMeter implements UsageMeter {
  readonly id = 'cursor-account'
  readonly source: UsageSource = { kind: 'api', label: "from Cursor's dashboard" }
  readonly #path: string
  readonly #endpoint: string
  readonly #legacyEndpoint: string
  readonly #fetch: typeof globalThis.fetch
  readonly #now: () => number

  constructor(options: CursorMeterOptions = {}) {
    this.#path = options.databasePath ?? join(homedir(), DB)
    this.#endpoint = options.endpoint ?? ENDPOINT
    this.#legacyEndpoint = options.legacyEndpoint ?? LEGACY_ENDPOINT
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
    const session = this.#session()
    if (session === null) return null
    const { cookie, subject } = session

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

    // The on-demand budget is the one part of this payload whose cents are
    // self-consistent — used + remaining is the limit — so both halves of it
    // can be believed, unlike the included-allowance cents above.
    const onDemand = summary.individualUsage?.onDemand ?? summary.teamUsage?.onDemand
    const onDemandEnabled =
      onDemand?.enabled === true && typeof onDemand.limit === 'number' && onDemand.limit > 0

    // Whenever the account is not unlimited, the legacy endpoint might carry
    // this account's real, primary figure — see the module comment. A
    // failure past this point must not blank a summary that already
    // succeeded, so it is caught here rather than left to throw: the reading
    // simply falls back to the summary alone, same as before this existed.
    let legacy: { readonly requestLanes: readonly UsageLane[]; readonly resetsAt: number | null } | null = null
    if (!unlimited) {
      try {
        legacy = await this.#legacy(cookie, subject, summary.billingCycleStart, resetsAt)
      } catch {
        legacy = null
      }
    }

    const lanes: UsageLane[] = []
    let credits: MeterReading['credits'] = null
    let reached: string | null = null

    if (legacy !== null && legacy.requestLanes.length > 0) {
      // The request lane is live and goes first: it is the primary lane, in
      // the vendor's own unit, and `reached` derives from it alone. The
      // summary's plan percent — a different pool entirely — rides after it
      // only as the comparable scale, never the headline or the driver.
      lanes.push(...legacy.requestLanes)
      const spent = legacy.requestLanes.find((lane) => lane.usedPercent >= 100)
      reached = spent?.id ?? null
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
      // On a request-based plan the on-demand budget is drawn as its own
      // lane beside the request quota, never folded into `credits` — the
      // two would otherwise say the same thing two different ways.
      if (onDemandEnabled) {
        lanes.push({
          id: 'overage',
          label: 'On-demand usage',
          unit: 'usd',
          used: (onDemand!.used ?? 0) / 100,
          limit: (onDemand!.limit as number) / 100,
          usedPercent: ((onDemand!.used ?? 0) / (onDemand!.limit as number)) * 100,
          windowMinutes: WINDOW_MINUTES.monthly,
          // The same `resetsAt` the requests lane above just used — never a
          // second date for the one account (NIT 1).
          resetsAt: legacy.resetsAt,
          layer: 'overage',
        })
      }
    } else {
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
      reached = usedPercent !== null && usedPercent >= 100 ? 'plan' : null
      credits =
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
    }

    if (lanes.length === 0 && credits === null) return null

    // The overage the plan actually metered, on top of its included
    // allowance — the same figure `credits.used` reads on a non-legacy
    // account, restated as `billing.overage.spent` so a card that reads
    // billing rather than credits (the shape every other reader already
    // expects) sees it too.
    const overage =
      onDemand?.enabled === true && typeof onDemand.used === 'number'
        ? { enabled: true, spent: onDemand.used / 100, currency: 'USD' }
        : null

    return {
      account: null,
      plan: planName(summary.membershipType),
      lanes,
      credits,
      reached,
      billing: {
        kinds: onDemandEnabled ? (['allowance', 'metered'] as const) : (['allowance'] as const),
        ...(overage ? { overage } : {}),
      },
      fetchedAt: this.#now(),
      staleAfterMs: STALE_AFTER_MS,
    }
  }

  /**
   * The legacy request quota, when it is live for this cycle — see
   * `legacyBucketIsLive`. `null` for "not usable" (nothing lined up, or
   * nothing with a limit at all) — never for a genuine transport failure,
   * which throws instead so the caller can fall back to the summary alone
   * rather than mistake a flaky call for an account with no legacy figure.
   */
  async #legacy(
    cookie: string,
    subject: string,
    billingCycleStart: string | undefined,
    summaryResetsAt: number | null,
  ): Promise<{ readonly requestLanes: readonly UsageLane[]; readonly resetsAt: number | null } | null> {
    let body: Readonly<Record<string, unknown>>
    try {
      const response = await this.#fetch(`${this.#legacyEndpoint}?user=${encodeURIComponent(subject)}`, {
        headers: { Accept: 'application/json', Cookie: cookie },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      })
      if (response.status === 401 || response.status === 403) return null
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      body = (await response.json()) as Readonly<Record<string, unknown>>
    } catch (cause) {
      throw new Error(
        `Cursor request usage could not be read: ${cause instanceof Error ? cause.message : String(cause)}`,
      )
    }

    const startOfMonth = typeof body['startOfMonth'] === 'string' ? (body['startOfMonth'] as string) : undefined
    if (!legacyBucketIsLive(startOfMonth, billingCycleStart, this.#now())) return { requestLanes: [], resetsAt: null }

    // The vendor's own cycle end, when the summary carries one, beats a
    // computed one — a computed end can drift for an anchor day the target
    // month does not have (the 29th–31st) — and this one `resetsAt` is what
    // goes on both the requests and the overage lane, never two different
    // dates for one account.
    const resetsAt = summaryResetsAt ?? cursorCycleEnd(startOfMonth)
    return { requestLanes: legacyRequestLanes(body, resetsAt), resetsAt }
  }

  /** One key out of a database another application owns, and nothing else. */
  #session(): { readonly cookie: string; readonly subject: string } | null {
    const token = readCursorToken(this.#path)
    if (token === null) return null
    const subject = jwtSubject(token)
    const cookie = cursorCookie(token)
    return subject === null || cookie === null ? null : { cookie, subject }
  }
}
