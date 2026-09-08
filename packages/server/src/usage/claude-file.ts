import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

import type { UsageLane } from '@harnessdesk/protocol'

import { DEFAULT_STALE_AFTER_MS, WINDOW_MINUTES, type MeterReading, type UsageMeter } from './meter.js'

/**
 * The agent's own cache, read where it already sits.
 *
 * Claude Code writes the whole utilization payload it gets from its provider —
 * every lane, each with the provider's own severity, plus the account and the
 * plan tier — into a plain JSON file it rewrites as it runs. There is no
 * keychain prompt, no token, and no network call in reading it, and because
 * HarnessDesk is what runs the agent, the cache stays warm on its own.
 *
 * This file belongs to another application. It is read, never written, and the
 * `fetchedAtMs` it carries is reported as-is: a cache from an hour ago is an
 * hour old whatever time we read it at.
 */

interface RawScope {
  readonly model?: { readonly id?: string | null; readonly display_name?: string | null } | null
  readonly surface?: string | null
}

interface RawLimit {
  readonly kind?: string
  readonly group?: string
  readonly percent?: number
  readonly severity?: string
  readonly resets_at?: string | null
  readonly scope?: RawScope | null
  readonly is_active?: boolean
}

interface RawWindow {
  readonly utilization?: number | null
  readonly resets_at?: string | null
}

interface RawExtraUsage {
  readonly is_enabled?: boolean
  readonly utilization?: number | null
  readonly monthly_limit?: number | null
  readonly used_credits?: number | null
  readonly currency?: string | null
  readonly spend_limit_reached?: boolean
}

interface RawFile {
  readonly cachedUsageUtilization?: {
    readonly fetchedAtMs?: number
    readonly utilization?: {
      readonly limits?: readonly RawLimit[]
      readonly five_hour?: RawWindow | null
      readonly seven_day?: RawWindow | null
      readonly extra_usage?: RawExtraUsage | null
    } | null
  } | null
  readonly oauthAccount?: {
    readonly emailAddress?: string | null
    readonly organizationRateLimitTier?: string | null
    readonly organizationType?: string | null
  } | null
}

const parseTime = (value: string | null | undefined): number | null => {
  if (typeof value !== 'string') return null
  const at = Date.parse(value)
  return Number.isFinite(at) ? at : null
}

const windowFor = (group: string | undefined, kind: string | undefined): number | null => {
  if (group === 'session' || kind === 'session') return WINDOW_MINUTES.session
  if (group === 'weekly' || kind?.startsWith('weekly')) return WINDOW_MINUTES.weekly
  if (group === 'daily' || kind?.startsWith('daily')) return WINDOW_MINUTES.daily
  if (group === 'monthly' || kind?.startsWith('monthly')) return WINDOW_MINUTES.monthly
  return null
}

/** "weekly_all" is the plan's own weekly; the rest keep the source's wording. */
const labelFor = (kind: string | undefined, group: string | undefined): string => {
  if (kind === 'session' || group === 'session') return 'Session'
  if (kind === 'weekly_all') return 'Weekly'
  if (kind === 'weekly_scoped') return 'Weekly'
  if (group === 'weekly') return 'Weekly'
  if (!kind) return 'Usage'
  return kind.replace(/_/g, ' ').replace(/^./, (first) => first.toUpperCase())
}

const severityFor = (value: string | undefined): UsageLane['severity'] => {
  if (value === 'critical') return 'critical'
  if (value === 'warning' || value === 'warn') return 'warning'
  if (value === 'normal') return 'normal'
  return null
}

const slug = (value: string): string =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')

/**
 * A lane id has to survive a refresh, and two model-scoped weeklies differ only
 * by their scope — so the scope is part of the id rather than a display detail.
 */
const idFor = (limit: RawLimit, index: number): string => {
  const scope = limit.scope?.model?.display_name ?? limit.scope?.model?.id ?? limit.scope?.surface
  const base = limit.kind ?? limit.group ?? `lane-${index}`
  return scope ? `${base}:${slug(scope)}` : base
}

/** `default_claude_max_20x` is a tier id, not something to show a person. */
const planFor = (tier: string | null | undefined, type: string | null | undefined): string | null => {
  const raw = tier ?? type
  if (!raw) return null
  const trimmed = raw.replace(/^default_/, '').replace(/^claude_/, '')
  if (!trimmed) return null
  return trimmed
    .split('_')
    .map((part) => (/^\d/.test(part) ? part : part.charAt(0).toUpperCase() + part.slice(1)))
    .join(' ')
}

export class ClaudeFileMeter implements UsageMeter {
  readonly id = 'claude-code'
  readonly source = { kind: 'file', label: 'from its own cache' } as const

  readonly #path: string

  constructor(path?: string) {
    this.#path = path ?? join(process.env['CLAUDE_CONFIG_DIR'] ?? homedir(), '.claude.json')
  }

  watchPaths(): readonly string[] {
    return [this.#path]
  }

  async read(): Promise<MeterReading | null> {
    let raw: string
    try {
      raw = await readFile(this.#path, 'utf8')
    } catch {
      return null // Not installed, or signed out. Neither is an error worth showing.
    }
    let file: RawFile
    try {
      file = JSON.parse(raw) as RawFile
    } catch {
      return null
    }

    const cached = file.cachedUsageUtilization
    const utilization = cached?.utilization
    if (!utilization) return null

    const lanes: UsageLane[] = []
    const limits = Array.isArray(utilization.limits) ? utilization.limits : []
    for (const [index, limit] of limits.entries()) {
      if (typeof limit.percent !== 'number') continue
      const scope = limit.scope?.model?.display_name ?? limit.scope?.surface ?? null
      lanes.push({
        id: idFor(limit, index),
        label: labelFor(limit.kind, limit.group),
        usedPercent: limit.percent,
        windowMinutes: windowFor(limit.group, limit.kind),
        resetsAt: parseTime(limit.resets_at),
        scope,
        severity: severityFor(limit.severity),
      })
    }

    // Older builds wrote only the two named windows. Used as a fallback rather
    // than a supplement, so one release cannot report a lane twice.
    if (lanes.length === 0) {
      const named: readonly [string, string, number, RawWindow | null | undefined][] = [
        ['session', 'Session', WINDOW_MINUTES.session, utilization.five_hour],
        ['weekly', 'Weekly', WINDOW_MINUTES.weekly, utilization.seven_day],
      ]
      for (const [id, label, minutes, window] of named) {
        if (!window || typeof window.utilization !== 'number') continue
        lanes.push({
          id,
          label,
          usedPercent: window.utilization,
          windowMinutes: minutes,
          resetsAt: parseTime(window.resets_at),
        })
      }
    }

    // Extra usage is a monthly spend allowance, not a rolling window; it earns
    // a lane only once the user has actually turned it on.
    const extra = utilization.extra_usage
    if (extra?.is_enabled === true && typeof extra.utilization === 'number') {
      lanes.push({
        id: 'extra-usage',
        label: 'Extra usage',
        usedPercent: extra.utilization,
        windowMinutes: WINDOW_MINUTES.monthly,
        resetsAt: null,
      })
    }

    if (lanes.length === 0) return null

    const account = file.oauthAccount?.emailAddress?.trim() || null
    return {
      account,
      plan: planFor(
        file.oauthAccount?.organizationRateLimitTier,
        file.oauthAccount?.organizationType,
      ),
      lanes,
      credits:
        extra?.is_enabled === true && typeof extra.monthly_limit === 'number'
          ? {
              remaining: Math.max(0, extra.monthly_limit - (extra.used_credits ?? 0)),
              unit: extra.currency ?? 'USD',
            }
          : null,
      reached: extra?.spend_limit_reached === true ? 'spend_limit_reached' : reachedFrom(lanes),
      fetchedAt:
        typeof cached?.fetchedAtMs === 'number' && cached.fetchedAtMs > 0
          ? cached.fetchedAtMs
          : Date.now(),
      staleAfterMs: DEFAULT_STALE_AFTER_MS,
    }
  }
}

/**
 * A spent lane is not the same as a *reached* limit: only a lane the source
 * itself calls critical means turns will actually fail.
 */
const reachedFrom = (lanes: readonly UsageLane[]): string | null => {
  const blocking = lanes.find((entry) => entry.severity === 'critical' && entry.usedPercent >= 100)
  return blocking ? blocking.id : null
}
