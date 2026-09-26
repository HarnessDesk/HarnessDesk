import { homedir } from 'node:os'
import { join } from 'node:path'

import type { UsageRow } from '../ledger/store.js'
import type { RemoteEventsSource } from '../ledger/remote.js'
import { cursorAccountHash, cursorCookie, readCursorToken } from './cursor.js'

/**
 * Cursor's own per-request usage events, folded into the ledger.
 *
 * Cursor keeps no local transcript we can read (rule 3), and its live meter
 * (`usage-summary`) carries no tokens at all — see `docs/usage-dashboard.md`.
 * `POST /api/dashboard/get-filtered-usage-events` is the one surface that
 * does, account-wide and covering every machine signed in to it, so this is
 * the only scanner in the ledger whose source is a network call rather than
 * a file this machine already holds.
 *
 * The endpoint enforces a CSRF origin check the meter's plain GET never
 * needed; an `Origin: https://cursor.com` header on the POST is what makes it
 * answer instead of "Invalid origin for state-changing request".
 *
 * **Confirmed against the real endpoint, 2026-09-26, read-only, for a 90-day
 * window** (never against a wider one — this file records the shape, never a
 * real reading): the envelope is `{ totalUsageEventsCount, usageEventsDisplay
 * }`; an empty query returns `{}`; a terminal page short of a full page omits
 * `usageEventsDisplay` but keeps the count. A small share of events carry no
 * `tokenUsage` at all — a non-token completion Cursor still bills — and
 * `kind: 'USAGE_EVENT_KIND_ABORTED_NOT_CHARGED'` events carry neither tokens
 * nor a cost; an event with neither tokens nor a `requestsCosts` weight above
 * zero is skipped rather than counted as zero-cost usage.
 * `tokenUsage.totalCents` was present on every event that had `tokenUsage` at
 * all in that window, but is read as optional regardless, since a wrong
 * price is worse than none (`ledger/pricing.ts`'s own rule) and Cursor does
 * not promise the field.
 *
 * **Cursor's input excludes cache.** `tokenUsage` carries `inputTokens`,
 * `outputTokens`, `cacheReadTokens` and `cacheWriteTokens` as four disjoint
 * counters — confirmed by the same read: a call with heavy cache reuse had
 * `cacheReadTokens` several orders of magnitude above `inputTokens`, which is
 * only possible when the cache share was never inside it to begin with. That
 * makes Cursor's shape Claude's, not Codex's: a cache-hit rate for `cursor`
 * is `cacheRead / (input + cacheRead)`, the same rule `ledger/scan.ts`
 * documents for the other four disjoint-counter scanners.
 *
 * **`requests`.** `requestsCosts` is Cursor's own accounting of how many
 * "requests" of a request-based plan's quota one event consumed — a plain
 * model call reads `1`, a cheap one can read a fraction of that, and a
 * max-mode or otherwise expensive call reads several (the read above saw
 * values past 300 on one event). That is the meter's unit, not the ledger's:
 * it is the same figure the legacy request counter reads live (#999's
 * `numRequests`), and it is a float, never an integer count. `LedgerRow.requests`
 * promises a call count — the same count `SpendCoverage.priced` / `unpriced`
 * partition — so every kept event counts as exactly one request here,
 * whatever `requestsCosts` said its quota weight was. An event with neither
 * tokens nor a nonzero `requestsCosts` is dropped rather than kept as a
 * zero-weighted call; one that is dropped for tokens alone but still carries
 * a weight is kept, still counted as one request.
 *
 * **Value, never Paid.** `tokenUsage.totalCents / 100` is Cursor's own
 * API-rate estimate for the tokens — the agent's own price, i.e. `vendorCost`
 * — and never `chargedCents`, which is what the plan actually deducted and
 * belongs only to `billing.overage.spent` on the meter's report (#992's
 * rule: an agent's own price for its tokens is Value, not necessarily cash
 * that left the account). A row with no tokens at all is never priced from
 * the catalogue — `Ledger.#price` treats zero tokens as nothing to price,
 * never as a free $0 call — and a token-bearing event with no usable
 * `totalCents` falls through to the catalogue's own list-price rate, an
 * estimate rather than a true unpriced row.
 */

const ENDPOINT = 'https://cursor.com/api/dashboard/get-filtered-usage-events'
const PAGE_SIZE = 1000
const MAX_PAGES = 200
const TIMEOUT_MS = 15_000
const DB = 'Library/Application Support/Cursor/User/globalStorage/state.vscdb'

interface CursorEventTokenUsage {
  readonly inputTokens?: unknown
  readonly outputTokens?: unknown
  readonly cacheWriteTokens?: unknown
  readonly cacheReadTokens?: unknown
  readonly totalCents?: unknown
}

interface CursorUsageEvent {
  readonly timestamp?: unknown
  readonly model?: unknown
  readonly kind?: unknown
  readonly requestsCosts?: unknown
  readonly tokenUsage?: CursorEventTokenUsage
}

interface CursorUsageEventsPage {
  readonly totalUsageEventsCount?: unknown
  readonly usageEventsDisplay?: unknown
}

/** A parsed, still-per-event record — the aggregator's own input. */
export interface CursorEvent {
  readonly at: number
  readonly model: string
  readonly input: number
  readonly output: number
  readonly cacheRead: number
  readonly cacheWrite: number
  readonly requests: number
  /** null when Cursor's own estimate is absent or not a usable number. */
  readonly cents: number | null
}

const nonNegativeFinite = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null

const positiveInt = (value: unknown): number => {
  const n = nonNegativeFinite(value)
  return n === null ? 0 : Math.round(n)
}

const ABORTED = 'USAGE_EVENT_KIND_ABORTED_NOT_CHARGED'

/**
 * One event, or null when it carries nothing worth a row: an aborted call
 * Cursor never charged for, or one with neither tokens nor a request cost.
 */
const parseEvent = (raw: unknown): CursorEvent | null => {
  if (typeof raw !== 'object' || raw === null) return null
  const event = raw as CursorUsageEvent
  if (event.kind === ABORTED) return null
  const at = typeof event.timestamp === 'string' && /^\d+$/.test(event.timestamp) ? Number(event.timestamp) : null
  if (at === null || at <= 0) return null
  const model = typeof event.model === 'string' && event.model !== '' ? event.model : 'unknown'
  const usage = event.tokenUsage
  const input = positiveInt(usage?.inputTokens)
  const output = positiveInt(usage?.outputTokens)
  const cacheRead = positiveInt(usage?.cacheReadTokens)
  const cacheWrite = positiveInt(usage?.cacheWriteTokens)
  const cents = usage ? nonNegativeFinite(usage.totalCents) : null
  // `requestsCosts` is Cursor's own quota weight for the meter (#999's
  // legacy `numRequests`) — not a call count, so it is never stored in
  // `requests`. A kept event is always exactly one request.
  if (input + output + cacheRead + cacheWrite === 0 && nonNegativeFinite(event.requestsCosts) === 0) return null
  const requests = 1
  return { at, model, input, output, cacheRead, cacheWrite, requests, cents }
}

export interface FetchCursorEventsOptions {
  readonly cookie: string
  /** Inclusive, epoch ms. */
  readonly since: number
  /** Exclusive, epoch ms. */
  readonly until: number
  readonly endpoint?: string
  readonly fetch?: typeof globalThis.fetch
  readonly pageSize?: number
  readonly maxPages?: number
}

/**
 * Pages `get-filtered-usage-events` for one window, dedups exact rows at
 * page boundaries, and fails closed: a short read, the page cap, or an
 * envelope this cannot make sense of returns `null` rather than a partial
 * window a caller might mistake for a complete one.
 */
export const fetchCursorEvents = async (options: FetchCursorEventsOptions): Promise<readonly CursorEvent[] | null> => {
  const endpoint = options.endpoint ?? ENDPOINT
  const fetchImpl = options.fetch ?? globalThis.fetch
  const pageSize = options.pageSize ?? PAGE_SIZE
  const maxPages = options.maxPages ?? MAX_PAGES

  const pages: unknown[][] = []
  let expectedTotal: number | null = null
  let completed = false

  for (let page = 1; page <= maxPages; page += 1) {
    let response: Response
    try {
      response = await fetchImpl(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json', Cookie: options.cookie, Origin: 'https://cursor.com' },
        body: JSON.stringify({ page, pageSize, startDate: String(options.since), endDate: String(options.until) }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      })
    } catch {
      return null
    }
    if (response.status === 401 || response.status === 403) return null
    if (!response.ok) return null
    let body: unknown
    try {
      body = await response.json()
    } catch {
      return null
    }
    if (typeof body !== 'object' || body === null) return null
    const envelope = body as CursorUsageEventsPage
    // An empty query returns `{}`. Nothing to page, and nothing wrong.
    if (envelope.totalUsageEventsCount === undefined && envelope.usageEventsDisplay === undefined) {
      completed = true
      break
    }
    if (envelope.totalUsageEventsCount !== undefined) {
      if (typeof envelope.totalUsageEventsCount !== 'number' || envelope.totalUsageEventsCount < 0) return null
      if (expectedTotal !== null && expectedTotal !== envelope.totalUsageEventsCount) return null
      expectedTotal = envelope.totalUsageEventsCount
    }
    // A terminal page can omit the events array while keeping the count.
    const events = envelope.usageEventsDisplay
    if (events === undefined) {
      completed = true
      break
    }
    if (!Array.isArray(events)) return null
    if (events.length === 0) {
      completed = true
      break
    }
    pages.push(events)
    if (events.length < pageSize) {
      completed = true
      break
    }
  }

  if (!completed) return null // the page cap was reached before an empty or short page proved completion

  const raw = pages.flat()
  if (expectedTotal === null) return raw.map(parseEvent).filter((event): event is CursorEvent => event !== null)
  if (raw.length < expectedTotal) return null // a short read: fewer rows than Cursor says exist

  // Reconcile exact duplicates at adjacent page boundaries only, and only the
  // exact number the authoritative count proves are duplicates — two events
  // that happen to be identical are not necessarily the same event twice.
  let removalsRemaining = raw.length - expectedTotal
  let reconciled = pages[0] ?? []
  for (let i = 1; i < pages.length; i += 1) {
    const previous = pages[i - 1]!
    const current = pages[i]!
    const overlap = boundaryOverlap(previous, current)
    const remove = Math.min(overlap, removalsRemaining)
    reconciled = [...reconciled, ...current.slice(remove)]
    removalsRemaining -= remove
  }
  if (removalsRemaining !== 0 || reconciled.length !== expectedTotal) return null // ambiguous: cannot prove which rows were duplicates

  return reconciled.map(parseEvent).filter((event): event is CursorEvent => event !== null)
}

/** How many of `previous`'s trailing rows exactly match `current`'s leading ones. */
const boundaryOverlap = (previous: readonly unknown[], current: readonly unknown[]): number => {
  const limit = Math.min(previous.length, current.length)
  for (let count = limit; count >= 1; count -= 1) {
    let equal = true
    for (let i = 0; i < count; i += 1) {
      if (JSON.stringify(previous[previous.length - count + i]) !== JSON.stringify(current[i])) {
        equal = false
        break
      }
    }
    if (equal) return count
  }
  return 0
}

const startOfLocalDay = (at: number): number => {
  const date = new Date(at)
  date.setHours(0, 0, 0, 0)
  return date.getTime()
}

/** `at` stepped by whole local days — calendar arithmetic, never a fixed 86,400,000ms step (a DST day is 23 or 25 hours). */
export const stepLocalDay = (at: number, days: number): number => {
  const date = new Date(at)
  date.setDate(date.getDate() + days)
  return date.getTime()
}

/**
 * Folds parsed events into ledger rows, one per local day and model, split
 * further by whether the event carried a usable price — the same split
 * every other scanner keeps (`scan.ts`'s `add`), so a sum of priced and
 * unpriced requests never happens under one row.
 */
export const aggregateCursorEvents = (
  events: readonly CursorEvent[],
  runtime: string,
  file: string,
): readonly UsageRow[] => {
  const rows = new Map<string, UsageRow>()
  for (const event of events) {
    const day = startOfLocalDay(event.at)
    const priced = event.cents !== null
    const key = `${day}\u0000${event.model}\u0000${priced ? 1 : 0}`
    const existing = rows.get(key)
    if (existing) {
      rows.set(key, {
        ...existing,
        input: existing.input + event.input,
        output: existing.output + event.output,
        cacheRead: existing.cacheRead + event.cacheRead,
        cacheWrite: existing.cacheWrite + event.cacheWrite,
        requests: existing.requests + event.requests,
        vendorCost: priced ? (existing.vendorCost ?? 0) + event.cents! / 100 : existing.vendorCost,
      })
      continue
    }
    rows.set(key, {
      file,
      day,
      runtime,
      model: event.model,
      project: '',
      input: event.input,
      output: event.output,
      cacheRead: event.cacheRead,
      cacheWrite: event.cacheWrite,
      reasoning: 0,
      requests: event.requests,
      vendorCost: priced ? event.cents! / 100 : null,
    })
  }
  return [...rows.values()]
}

export interface CursorEventsSourceOptions {
  readonly databasePath?: string
  readonly endpoint?: string
  readonly fetch?: typeof globalThis.fetch
}

/**
 * The ledger's own source for Cursor: one account's events, folded into
 * rows keyed on that account's own (hashed) identity rather than on the
 * runtime a person happened to name it.
 */
export class CursorEventsSource implements RemoteEventsSource {
  readonly runtime: string
  readonly #path: string
  readonly #endpoint: string | undefined
  readonly #fetch: typeof globalThis.fetch | undefined

  constructor(runtime: string, options: CursorEventsSourceOptions = {}) {
    this.runtime = runtime
    this.#path = options.databasePath ?? join(homedir(), DB)
    this.#endpoint = options.endpoint
    this.#fetch = options.fetch
  }

  async resolveFile(): Promise<string | null> {
    const hash = this.#accountHash()
    return hash ? `cursor-events:${hash}` : null
  }

  async sync(range: { readonly from: number; readonly to: number }): Promise<{ readonly rows: readonly UsageRow[] } | null> {
    const token = readCursorToken(this.#path)
    if (token === null) return null
    const cookie = cursorCookie(token)
    const hash = cursorAccountHash(token)
    if (cookie === null || hash === null) return null
    const events = await fetchCursorEvents({
      cookie,
      since: range.from,
      until: range.to,
      ...(this.#endpoint ? { endpoint: this.#endpoint } : {}),
      ...(this.#fetch ? { fetch: this.#fetch } : {}),
    })
    if (events === null) return null
    const file = `cursor-events:${hash}`
    return { rows: aggregateCursorEvents(events, this.runtime, file) }
  }

  #accountHash(): string | null {
    const token = readCursorToken(this.#path)
    return token ? cursorAccountHash(token) : null
  }
}
