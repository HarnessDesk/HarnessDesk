import type { RateLimits, UsageLane } from '@harnessdesk/protocol'

const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}

/** Extension frames are untrusted. Missing/invalid figures never become zero. */
export const usageLimits = (value: unknown): RateLimits | null => {
  const raw = object(object(value)['limits'])
  const account = typeof raw['account'] === 'string' ? raw['account'] : null
  if (raw['planLimitsUnavailable'] === true) return { lanes: [], account, planLimitsUnavailable: true }
  if (!Array.isArray(raw['lanes'])) return null
  const lanes: UsageLane[] = []
  for (const value of raw['lanes']) {
    const lane = object(value)
    if (typeof lane['id'] !== 'string' || typeof lane['label'] !== 'string' ||
        typeof lane['usedPercent'] !== 'number' || !Number.isFinite(lane['usedPercent'])) continue
    lanes.push({ id: lane['id'], label: lane['label'], usedPercent: lane['usedPercent'],
      resetsAt: typeof lane['resetsAt'] === 'number' && Number.isFinite(lane['resetsAt']) ? lane['resetsAt'] : null,
      windowMinutes: typeof lane['windowMinutes'] === 'number' && Number.isFinite(lane['windowMinutes']) && lane['windowMinutes'] > 0 ? lane['windowMinutes'] : null,
      ...(typeof lane['scope'] === 'string' ? { scope: lane['scope'] } : {}),
      ...(lane['severity'] === 'normal' || lane['severity'] === 'warning' || lane['severity'] === 'critical' ? { severity: lane['severity'] } : {}) })
  }
  if (!lanes.length) return null
  const at = raw['fetchedAt']
  const credits = object(raw['credits'])
  const money = typeof credits['remaining'] === 'number' && Number.isFinite(credits['remaining']) && typeof credits['unit'] === 'string'
    ? { remaining: credits['remaining'], unit: credits['unit'] } : undefined
  const plan = typeof raw['planType'] === 'string' ? raw['planType'] : null
  return { lanes, windows: lanes.map(lane => ({ label: lane.scope ? `${lane.label} · ${lane.scope}` : lane.label,
    usedPercent: Math.min(100, Math.max(0, lane.usedPercent)), windowMinutes: lane.windowMinutes, resetsAt: lane.resetsAt })),
    account, planType: plan, ...(plan ? { planLabel: plan.charAt(0).toUpperCase() + plan.slice(1) } : {}),
    fetchedAt: typeof at === 'number' && Number.isFinite(at) && at > 0 ? at : 0,
    staleAfterMs: 120_000, reached: typeof raw['reached'] === 'string' ? raw['reached'] : null,
    ...(money ? { credits: money } : {}), billing: { kinds: money ? ['windows', 'metered'] : ['windows'] },
    source: { kind: 'runtime', label: 'from its own usage command' } }
}
