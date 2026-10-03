import type { Approval, FindingRoundPublication, FlowExecution, GoalView, RuntimeId, SeatActivity, SessionId, TeamState } from '@harnessdesk/protocol'

/** Whole held subscription state, copied without transport or internal map references. */
export interface ClientSnapshot {
  waiting?: ClientWaitingItem[]
  teams: GoalView[]
  runs: FlowExecution[]
  boards: TeamState[]
  seats: SeatActivity[]
  approvals: { runtime: RuntimeId; sessionId: SessionId; approval: Approval }[]
  reviews: { run: string; rounds: FindingRoundPublication[] }[]
}


/** Stable ids use the same vocabulary as waiting and waiting.cleared events. */
export interface ClientWaitingItem {
  readonly id: string
  readonly team: string | null
  readonly kind: 'card' | 'question' | 'approval'
  readonly card?: number
  readonly seat?: string
  readonly summary: string
}
