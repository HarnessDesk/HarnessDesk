import type { Approval, FindingRoundPublication, FlowExecution, GoalView, RuntimeId, SeatActivity, SessionId, TeamState } from '@harnessdesk/protocol'

/** Whole held subscription state, copied without transport or internal map references. */
export interface ClientSnapshot {
  teams: GoalView[]
  runs: FlowExecution[]
  boards: TeamState[]
  seats: SeatActivity[]
  approvals: { runtime: RuntimeId; sessionId: SessionId; approval: Approval }[]
  reviews: { run: string; rounds: FindingRoundPublication[] }[]
}
