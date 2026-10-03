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
