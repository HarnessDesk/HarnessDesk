import type { RateLimits, UsageLane } from '@harnessdesk/protocol'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

// Copied in transport-acp; the client negotiates this, never a vendor id.
export const USAGE_READ = '_harnessdesk/usage/read'
export const USAGE_CAPABILITY = 'accountUsage'
const MINUTE = 60_000
const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}

/** Prefer the provider's active rows: legacy aliases can carry placeholders and different reset precision. */
const normalizeLimits = (value: unknown): Record<string, unknown> => {
  const limits = object(value)
  if (!Array.isArray(limits['limits']) || limits['limits'].length === 0) return limits
  const rows = limits['limits'].map(object).filter(row => row['is_active'] !== false)
  const window = (kind: string) => {
    const row = rows.find(entry => entry['kind'] === kind)
    return row ? { utilization: row['percent'], resets_at: row['resets_at'] } : null
  }
  return { ...limits, five_hour: window('session'), seven_day: window('weekly_all'),
    model_scoped: rows.filter(row => row['kind'] === 'weekly_scoped').map(row => ({
      display_name: object(object(row['scope'])['model'])['display_name'],
      utilization: row['percent'], resets_at: row['resets_at'],
    })) }
}

/** Only the unstable SDK seam lives here. Older CLIs may have no such control. */
export interface UsageQuery {
  usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET?: (options: { skipBehaviors: boolean }) => Promise<unknown>
  accountInfo?: () => Promise<unknown>
}

const parse = (value: unknown, at: number): RateLimits | null => {
  const raw = object(value)
  if (raw['rate_limits_available'] === false) return null
  if (raw['rate_limits_available'] !== true || !raw['rate_limits']) throw new Error('Usage response was incompatible.')
  const limits = normalizeLimits(raw['rate_limits'])
  const structured = Array.isArray(limits['limits']) && limits['limits'].length > 0
  const lanes: UsageLane[] = []
  const add = (id: string, label: string, minutes: number, value: unknown, scope?: string) => {
    const window = object(value)
    const used = window['utilization']
    if (typeof used !== 'number' || !Number.isFinite(used) || used < 0 || used > 100) return
    const reset = typeof window['resets_at'] === 'string' ? Date.parse(window['resets_at']) : NaN
    lanes.push({ id, label, usedPercent: used, windowMinutes: minutes,
      resetsAt: Number.isFinite(reset) ? reset : null, ...(scope ? { scope } : {}) })
  }
  add('session', 'Session', 300, limits['five_hour'])
  // Keep the file meter's stable ids so saved pins survive the live/cache hand-off.
  add(structured ? 'weekly_all' : 'weekly', 'Weekly', 10_080, limits['seven_day'])
  if (Array.isArray(limits['model_scoped'])) {
    for (const raw of limits['model_scoped']) {
      const entry = object(raw)
      const scope = entry['display_name']
      if (typeof scope === 'string' && scope.trim()) {
        const id = structured ? `weekly_scoped:${scope.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}` : `weekly:${scope}`
        add(id, 'Weekly', 10_080, entry, scope)
      }
    }
  } else {
    for (const [key, scope] of [['seven_day_opus', 'Opus'], ['seven_day_sonnet', 'Sonnet']] as const) {
      add(key, 'Weekly', 10_080, limits[key], scope)
    }
  }
  const extra = object(limits['extra_usage'])
  if (extra['is_enabled'] === true) add('extra-usage', 'Extra usage', 43_200, extra)
  if (lanes.length === 0) throw new Error('Usage response contained no measured allowance.')
  const remaining = typeof extra['monthly_limit'] === 'number' && typeof extra['used_credits'] === 'number'
    ? Math.max(0, extra['monthly_limit'] - extra['used_credits']) : null
  const credits = extra['is_enabled'] === true && remaining !== null && Number.isFinite(remaining)
    ? { remaining, unit: typeof extra['currency'] === 'string' ? extra['currency'] : 'USD' } : undefined
  return { lanes, planType: typeof raw['subscription_type'] === 'string' ? raw['subscription_type'] : null,
    fetchedAt: at, staleAfterMs: 2 * MINUTE, reached: null,
    ...(credits ? { credits } : {}), billing: { kinds: credits ? ['windows', 'metered'] : ['windows'] } }
}

const cacheIdentity = (file: Record<string, unknown>): string => {
  const account = object(file['oauthAccount'])
  return JSON.stringify([account['accountUuid'], account['emailAddress'], account['organizationUuid']])
}

/** The SDK silently serves cached data on failure. Only matching CLI-owned evidence can date its answer. */
const observationTime = (before: Record<string, unknown>, after: Record<string, unknown>, limits: RateLimits, email: string, now: number): number => {
  const account = object(after['oauthAccount'])
  const cached = object(after['cachedUsageUtilization'])
  const at = cached['fetchedAtMs']
  if (cacheIdentity(before) !== cacheIdentity(after) || account['emailAddress'] !== email ||
      typeof account['accountUuid'] !== 'string' || cached['accountUuid'] !== account['accountUuid'] ||
      typeof at !== 'number' || !Number.isFinite(at) || at <= 0 || at > now) return 0
  const utilization = object(cached['utilization'])
  try {
    const own = parse({ rate_limits_available: true, rate_limits: utilization }, at)
    return limits.lanes?.every(lane => own?.lanes?.some(source => source.id === lane.id && source.scope === lane.scope &&
      source.usedPercent === lane.usedPercent && source.resetsAt === lane.resetsAt)) ? at : 0
  } catch { return 0 }
}

/** One budget per isolated bridge/account. No poller, credentials or model request. */
export class UsageReader {
  #cached: RateLimits | null = null
  #nextRead = 0
  #failures = 0
  #error: Error | null = null
  #inFlight: Promise<RateLimits | null> | null = null
  #pending: Promise<unknown> | null = null
  #key: string | null = null
  constructor(readonly now = Date.now, readonly random = Math.random, readonly timeoutMs = 8_000,
    readonly cachePath = join(process.env['CLAUDE_CONFIG_DIR'] ?? homedir(), '.claude.json')) {}

  async #file(): Promise<Record<string, unknown>> {
    try { return object(JSON.parse(await readFile(this.cachePath, 'utf8'))) } catch { return {} }
  }

  async read(queries: readonly UsageQuery[]): Promise<RateLimits | null> {
    if (!queries.length) return null
    const before = await this.#file()
    const diskEmail = object(before['oauthAccount'])['emailAddress']
    const candidates = await Promise.all(queries.map(async query => ({ query, info: object(await query.accountInfo?.().catch(() => null)) })))
    // subscriptionType is the CLI's display label, not a stable enum. The usage control
    // itself is authoritative about whether that first-party sign-in has plan limits.
    const subscribers = candidates.filter(({ info }) => info['apiProvider'] === 'firstParty' &&
      typeof info['subscriptionType'] === 'string' && info['subscriptionType'].trim().length > 0 &&
      typeof info['email'] === 'string')
    const subscriber = subscribers.find(({ info }) => diskEmail === undefined || info['email'] === diskEmail)
    if (!subscriber) {
      // accountInfo is initialization metadata. A subscriber initialized before a login switch is not evidence
      // that the new login has no quota; let its own file answer until a matching live query is available.
      if (subscribers.length) return null
      // A known provider/key session is authoritative about which credential it uses. An unknown old CLI still
      // gets the file fallback; it has not supplied evidence either way.
      return candidates.every(({ info }) => info['apiProvider'] !== undefined)
        ? { lanes: [], planLimitsUnavailable: true } : null
    }
    const { query, info } = subscriber
    const email = info['email'] as string
    const key = JSON.stringify([cacheIdentity(before), email, info['organization'], info['tokenSource']])
    if (this.#inFlight) {
      if (key === this.#key) return this.#inFlight
      await this.#inFlight.catch(() => null)
      return this.read(queries)
    }
    if (key !== this.#key) {
      this.#key = key
      this.#cached = null
      this.#nextRead = 0
      this.#failures = 0
      this.#error = null
    }
    if (this.now() < this.#nextRead) {
      if (this.#error) throw this.#error
      return this.#cached
    }
    const read = query.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET
    if (!read) return Promise.resolve(null)
    if (this.#pending) return Promise.reject(new Error('Usage read is still pending.'))
    // Keep the underlying request tracked after a timeout: another caller must not stack a second on it.
    const pending = Promise.resolve().then(() => read.call(query, { skipBehaviors: true }))
    this.#pending = pending
    void pending.then(() => { this.#pending = null }, () => { this.#pending = null })
    let timer: ReturnType<typeof setTimeout>
    const deadline = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Usage read timed out.')), this.timeoutMs) })
    this.#inFlight = Promise.race([pending, deadline]).then(async value => {
      const parsed = parse(value, 0)
      const after = await this.#file()
      if (cacheIdentity(before) !== cacheIdentity(after)) throw new Error('Usage identity changed while reading.')
      const result: RateLimits = parsed ? { ...parsed, account: email,
        fetchedAt: observationTime(before, after, parsed, email, this.now()) } : { lanes: [], account: email, planLimitsUnavailable: true }
      this.#cached = result
      this.#error = null
      this.#failures = 0
      this.#nextRead = this.now() + MINUTE
      return result
    }).catch(() => {
      // Do not forward provider errors, which can contain account/transport details.
      this.#error = new Error('Could not refresh usage from the running agent.')
      this.#failures++
      this.#nextRead = this.now() + Math.min(15 * MINUTE, MINUTE * 2 ** Math.min(this.#failures - 1, 4) * (1 + this.random() * 0.1))
      throw this.#error
    }).finally(() => { clearTimeout(timer); this.#inFlight = null })
    return this.#inFlight
  }
}
