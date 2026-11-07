import type { SessionGoal } from '@harnessdesk/protocol'

export const ACP_STEER = '_session/steering'
export const ACP_GOAL = '_session/goal'
const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
const air = (meta: unknown) => record(record(record(meta)['jetbrains'])['air'])

// These extensions live in initialize's _meta, not agentCapabilities. Read
// their negotiated contracts, never an agent name or a package version.
export const supportsSteering = (meta: unknown): boolean => record(record(meta)['steering'])['supported'] === true
export const supportsGoals = (meta: unknown): boolean => {
  const goal = record(air(meta)['goal'])
  const actions = goal['actions']
  return goal['version'] === 1 && goal['controlMethod'] === ACP_GOAL &&
    Array.isArray(actions) && ['set', 'clear'].every(action => actions.includes(action))
}

export const goalUpdate = (meta: unknown): SessionGoal | null | undefined => {
  const raw = air(meta)['goal']
  if (raw === null) return null
  const goal = record(raw)
  const status = goal['status']
  if (typeof goal['objective'] !== 'string' || !goal['objective'].trim() || goal['controlMethod'] !== ACP_GOAL ||
    typeof status !== 'string' || !['active', 'paused', 'blocked', 'limited', 'complete'].includes(status)) return undefined
  const count = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0
  return {
    objective: goal['objective'],
    status: status === 'limited' ? 'usageLimited' : status as SessionGoal['status'],
    tokensUsed: count(goal['tokensUsed']), timeUsedSeconds: count(goal['timeUsedSeconds']),
    ...(goal['tokenBudget'] === null || typeof goal['tokenBudget'] === 'number' && Number.isFinite(goal['tokenBudget']) && goal['tokenBudget'] >= 0
      ? { tokenBudget: goal['tokenBudget'] as number | null } : {}),
  }
}
