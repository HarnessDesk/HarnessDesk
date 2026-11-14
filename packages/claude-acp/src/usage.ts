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

const text = (value: unknown): string | null => typeof value === 'string' && value.trim() ? value.trim() : null
const scopeName = (value: unknown): string | null => {
  const scope = object(value), model = object(scope['model']), surface = object(scope['surface'])
  return text(model['display_name']) ?? text(model['id']) ?? text(scope['surface']) ?? text(surface['display_name']) ?? text(surface['id'])
}
const slug = (value: string): string => value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')

/** The same complete active rows and stable identities the file meter exposes. */
const modernLanes = (limits: Record<string, unknown>): UsageLane[] | null => {
  if (!Array.isArray(limits['limits']) || limits['limits'].length === 0) return null
  return limits['limits'].flatMap((value, index) => {
    const row = object(value), used = row['percent']
    if (row['is_active'] === false || typeof used !== 'number' || !Number.isFinite(used)) return []
    const kind = text(row['kind']), group = text(row['group']), scope = scopeName(row['scope'])
    const base = kind ?? group ?? `lane-${index}`
    const label = kind === 'session' || group === 'session' ? 'Session'
      : kind === 'weekly_all' || kind === 'weekly_scoped' || group === 'weekly' ? 'Weekly'
        : kind ? kind.replace(/_/g, ' ').replace(/^./, first => first.toUpperCase()) : 'Usage'
    const minutes = group === 'session' || kind === 'session' ? 300
      : group === 'weekly' || kind?.startsWith('weekly') ? 10_080
        : group === 'daily' || kind?.startsWith('daily') ? 1_440
          : group === 'monthly' || kind?.startsWith('monthly') ? 43_200 : null
    const reset = typeof row['resets_at'] === 'string' ? Date.parse(row['resets_at']) : NaN
    const severity = row['severity'] === 'warn' ? 'warning' : row['severity']
    return [{ id: scope ? `${base}:${slug(scope)}` : base, label, usedPercent: used, windowMinutes: minutes,
      resetsAt: Number.isFinite(reset) ? reset : null, scope,
      severity: severity === 'normal' || severity === 'warning' || severity === 'critical' ? severity : null }]
  })
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
  const limits = object(raw['rate_limits'])
  const modern = modernLanes(limits)
  const lanes: UsageLane[] = modern ?? []
  const add = (id: string, label: string, minutes: number, value: unknown, scope?: string) => {
    const window = object(value)
    const used = window['utilization']
    if (typeof used !== 'number' || !Number.isFinite(used)) return
    const reset = typeof window['resets_at'] === 'string' ? Date.parse(window['resets_at']) : NaN
    lanes.push({ id, label, usedPercent: used, windowMinutes: minutes,
      resetsAt: Number.isFinite(reset) ? reset : null, ...(scope ? { scope } : {}) })
  }
  if (modern === null) {
    add('session', 'Session', 300, limits['five_hour'])
    add('weekly', 'Weekly', 10_080, limits['seven_day'])
    if (Array.isArray(limits['model_scoped'])) {
      for (const raw of limits['model_scoped']) {
        const entry = object(raw)
        const scope = entry['display_name']
        if (typeof scope === 'string' && scope.trim()) {
          add(`weekly:${scope}`, 'Weekly', 10_080, entry, scope)
        }
      }
    } else {
      for (const [key, scope] of [['seven_day_opus', 'Opus'], ['seven_day_sonnet', 'Sonnet']] as const) {
        add(key, 'Weekly', 10_080, limits[key], scope)
      }
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
    fetchedAt: at, staleAfterMs: 2 * MINUTE,
    reached: extra['spend_limit_reached'] === true ? 'spend_limit_reached'
      : lanes.find(lane => lane.severity === 'critical' && lane.usedPercent >= 100)?.id ?? null,
    ...(credits ? { credits } : {}), billing: { kinds: credits ? ['windows', 'metered'] : ['windows'] } }
}

const cacheIdentity = (file: Record<string, unknown>): string => {
  const account = object(file['oauthAccount'])
  return JSON.stringify([account['accountUuid'], account['emailAddress'], account['organizationUuid']])
}

const sameReading = (limits: RateLimits, own: RateLimits | null): boolean =>
  limits.lanes?.length === own?.lanes?.length && limits.reached === own?.reached &&
  limits.credits?.remaining === own?.credits?.remaining && limits.credits?.unit === own?.credits?.unit &&
  Boolean(limits.lanes?.every(lane => own?.lanes?.some(source => source.id === lane.id && source.scope === lane.scope &&
    source.usedPercent === lane.usedPercent && source.resetsAt === lane.resetsAt &&
    source.windowMinutes === lane.windowMinutes && (source.severity ?? null) === (lane.severity ?? null))))

/** The SDK silently serves cached data on failure. Only matching CLI-owned evidence can date its answer. */
const corroboratedReading = (before: Record<string, unknown>, after: Record<string, unknown>, limits: RateLimits,
  response: unknown, email: string, now: number): RateLimits => {
  const account = object(after['oauthAccount'])
  const cached = object(after['cachedUsageUtilization'])
  const at = cached['fetchedAtMs']
  if (cacheIdentity(before) !== cacheIdentity(after) || account['emailAddress'] !== email ||
      typeof account['accountUuid'] !== 'string' || cached['accountUuid'] !== account['accountUuid'] ||
      typeof at !== 'number' || !Number.isFinite(at) || at <= 0 || at > now) return limits
  const utilization = object(cached['utilization'])
  try {
    const own = parse({ rate_limits_available: true, rate_limits: utilization }, at)
    if (sameReading(limits, own)) return { ...limits, fetchedAt: at }
    const raw = object(object(response)['rate_limits'])
    // The CLI's seeded reply omits modern rows but retains its legacy aliases,
    // and may add model projections from those rows. Corroborate that complete
    // projection, then keep the cache's richer rows, IDs and original clock.
    if (own && !Object.hasOwn(raw, 'limits') && modernLanes(utilization) !== null) {
      const { limits: _modern, ...projection } = utilization
      if (Array.isArray(raw['model_scoped'])) {
        const scoped = limits.lanes?.filter(lane => lane.scope) ?? []
        if (!scoped.every(lane => own.lanes?.some(source => source.scope === lane.scope &&
          source.usedPercent === lane.usedPercent && source.resetsAt === lane.resetsAt &&
          source.windowMinutes === lane.windowMinutes))) return limits
        projection['model_scoped'] = raw['model_scoped']
      }
      if (sameReading(limits, parse({ rate_limits_available: true, rate_limits: projection }, at))) {
        return { ...limits, ...own, planType: limits.planType, fetchedAt: at }
      }
    }
  } catch { /* A partial or incompatible cache cannot corroborate the reply. */ }
  return limits
}

/** One budget per isolated bridge/account. No poller, credentials or model request. */
export class UsageReader {
  #cached: RateLimits | null = null
  #nextRead = 0
  #failures = 0
  #error: Error | null = null
  #inFlight: Promise<RateLimits | null> | null = null
  #pending: { readonly query: UsageQuery; readonly work: Promise<unknown> } | null = null
  readonly #metadata = new WeakMap<UsageQuery, Promise<Record<string, unknown>>>()
  #key: string | null = null
  constructor(readonly now = Date.now, readonly random = Math.random, readonly timeoutMs = 8_000,
    readonly cachePath = join(process.env['CLAUDE_CONFIG_DIR'] ?? homedir(), '.claude.json')) {}

  async #file(): Promise<Record<string, unknown>> {
    try { return object(JSON.parse(await readFile(this.cachePath, 'utf8'))) } catch { return {} }
  }

  async #info(query: UsageQuery): Promise<Record<string, unknown>> {
    // accountInfo is initialization metadata. Keep its underlying request shared even
    // after a timeout, so a stalled initialization cannot accumulate control requests.
    let pending = this.#metadata.get(query)
    if (!pending) {
      pending = Promise.resolve().then(() => query.accountInfo?.()).then(object, () => ({}))
      this.#metadata.set(query, pending)
    }
    let timer: ReturnType<typeof setTimeout> | undefined
    const deadline = new Promise<Record<string, unknown>>(resolve => {
      timer = setTimeout(() => resolve({}), Math.min(1_000, this.timeoutMs))
    })
    try { return await Promise.race([pending, deadline]) } finally { clearTimeout(timer) }
  }

  async read(queries: readonly UsageQuery[]): Promise<RateLimits | null> {
    if (!queries.length) return null
    const before = await this.#file()
    const diskEmail = object(before['oauthAccount'])['emailAddress']
    const candidates = await Promise.all(queries.map(async query => ({ query, info: await this.#info(query) })))
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
      return candidates.every(({ info }) => {
        const provider = info['apiProvider']
        if (typeof provider !== 'string' || !provider) return false
        if (provider !== 'firstParty') return true
        const plan = info['subscriptionType']
        const key = info['apiKeySource']
        return !(typeof plan === 'string' && plan.trim()) && typeof key === 'string' &&
          key.trim().length > 0 && !/^(none|unknown)$/i.test(key.trim())
      })
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
    if (this.#pending?.query === query) return Promise.reject(new Error('Usage read is still pending.'))
    // A replacement for an ended query can recover; the same query cannot stack a
    // second request, and the old request finishing cannot retire its replacement.
    const pending = { query, work: Promise.resolve().then(() => read.call(query, { skipBehaviors: true })) }
    this.#pending = pending
    const settled = () => { if (this.#pending === pending) this.#pending = null }
    void pending.work.then(settled, settled)
    let timer: ReturnType<typeof setTimeout>
    const deadline = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Usage read timed out.')), this.timeoutMs) })
    this.#inFlight = Promise.race([pending.work, deadline]).then(async value => {
      const parsed = parse(value, 0)
      const after = await this.#file()
      if (cacheIdentity(before) !== cacheIdentity(after)) throw new Error('Usage identity changed while reading.')
      const result: RateLimits = parsed ? { ...corroboratedReading(before, after, parsed, value, email, this.now()),
        account: email } : { lanes: [], account: email, planLimitsUnavailable: true }
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
