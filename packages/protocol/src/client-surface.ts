import type { FlowExecution } from './flow-policy.js'
import type { GoalId } from './goal.js'
import type { HostMethodName } from './wire.js'

export type ClientTier = 'read' | 'run' | 'answer'
export type ClientTopic = 'runs' | 'cards' | 'teams' | 'waiting' | 'notices' | 'seats' | 'reviews'

/** The methods the client door answers, each with the tier it needs. */
export const CLIENT_METHODS = {
  'client/hello': 'read',
  'client/subscribe': 'read',
  'goal/list': 'read',
  'goal/read': 'read',
  'team/intent': 'answer',
  'flow/catalog': 'read',
  'flow/source': 'read',
  'flow/preview': 'read',
  'flow/start-goal': 'run',
  'workspace/open': 'run',
  'flow/execution': 'read',
  'flow/execution/stop': 'run',
  'flow/executions': 'read',
  'finding/run': 'read',
  'insight/goal': 'read',
} as const satisfies Partial<Record<HostMethodName, ClientTier>>

/** The action, not the broad method name, grants the verb. Omitted and
 * unknown actions stay off the surface, before ordinary params validation. */
export const CLIENT_ACTION_TIERS = {
  'team/intent': { abandon: 'run', done: 'answer' },
} as const satisfies Partial<Record<HostMethodName, Readonly<Record<string, ClientTier>>>>

export function clientTierFor(method: string, params?: unknown): ClientTier | null {
  if (!Object.hasOwn(CLIENT_METHODS, method)) return null
  if (method === 'team/intent') {
    const action = typeof params === 'object' && params !== null && 'action' in params ? params.action : undefined
    return typeof action === 'string' && Object.hasOwn(CLIENT_ACTION_TIERS['team/intent'], action)
      ? CLIENT_ACTION_TIERS['team/intent'][action as 'done' | 'abandon'] : null
  }
  return CLIENT_METHODS[method as keyof typeof CLIENT_METHODS]
}

export type ClientMethodName = keyof typeof CLIENT_METHODS
/** The local user's private socket is the authority to spend. Tiers restrict
 * verbs, not that user's processes; no caller-supplied pid proves a Seat.
 * Answering remains a separate, ungranted capability. */
export const CLIENT_TIERS_GRANTED_BY_DEFAULT: readonly ClientTier[] = ['read', 'run']
export const CLIENT_PROTOCOL = 1

export interface FlowExecutionSummary {
  readonly id: string
  readonly team: GoalId
  readonly flow: string
  readonly state: FlowExecution['state']
  readonly round: number | null
  readonly role: string | null
  readonly reason: string | null
  readonly startedAt: number
}
