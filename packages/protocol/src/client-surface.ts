import type { FlowExecution } from './flow-policy.js'
import type { GoalId } from './goal.js'
import type { HostMethodName } from './wire.js'

export type ClientTier = 'read' | 'run' | 'answer'
export type ClientTopic = 'runs' | 'cards' | 'teams' | 'waiting' | 'notices' | 'seats' | 'reviews' | 'chats'

/** Classified private methods: available only on a host-policy client door.
 * The typed SDK uses them, while public discovery and the CLI exclude them. */
export const PRIVATE_CLIENT_METHODS = {
  'lead/desk/summary': 'read',
  'lead/usage/summary': 'read',
  'lead/chat/list': 'read',
  'lead/chat/read': 'read',
  'lead/chat/start': 'run',
  'lead/chat/send': 'run',
  'lead/chat/stop': 'run',
  // The Lead's own work ledger. A note only annotates an item the host owns; it starts, sends and spends nothing.
  'lead/work/list': 'read',
  'lead/work/read': 'read',
  'lead/work/note': 'read',
  // The Lead's memory: a proposal only reaches the person's inbox, and a search reads its own notes and conversation.
  'lead/memory/propose': 'read',
  'lead/memory/search': 'read',
  // How full its own conversation is: a figure, never the conversation or its summaries.
  'lead/context/use': 'read',
  // A reminder the person asked for: an entry on the work board the person can cancel. It starts, sends and spends nothing.
  'lead/reminder/set': 'read',
  'lead/reminder/cancel': 'read',
} as const satisfies Partial<Record<HostMethodName, ClientTier>>

/** The methods the client door answers, each with the tier it needs. */
export const CLIENT_METHODS = {
  ...PRIVATE_CLIENT_METHODS,
  'client/hello': 'read',
  'client/subscribe': 'read',
  'session/loadout': 'read',
  'attachment/seat': 'read',
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
  'finding/list': 'read',
  'evidence/board': 'read',
  'evidence/seat': 'read',
  'insight/goal': 'read',
  'library/read': 'read',
  'library/definition': 'read',
  'library/usage': 'read',
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

/**
 * Whether an MCP client may start work on this desk, and how much of today's
 * allowance it has used. Host-owned state, set only from the window: no method
 * on the client surface reads or changes it. The day is the desk's local
 * calendar day; `remaining` is what is left of it.
 */
export interface McpStartsView {
  readonly version: 1
  readonly revision: number
  readonly mayStart: boolean
  readonly dailyStarts: number
  /** The local day `started` counts, as `YYYY-MM-DD`. */
  readonly day: string
  readonly started: number
  readonly remaining: number
  /** `environment`: a scripted desk set `HARNESSDESK_MCP_MAY_START=1`, and the switch cannot turn it off. */
  readonly source: 'stored' | 'environment'
}

/** The most starts a day an MCP client can be allowed. */
export const MCP_DAILY_STARTS_MAX = 50

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
