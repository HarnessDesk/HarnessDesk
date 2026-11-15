import type { LeadState } from '@harnessdesk/lead'
import type { StoredFlowExecution } from '../flow-execution.js'

/** Cancellation preserves settled work. Other stops may retry listeners whose
 * cleanup failed after the run ended. */
export const leadStopReachesRun = (run: Pick<StoredFlowExecution, 'state'> | undefined, reason: string): boolean =>
  !!run && (reason !== 'cancelled' || run.state === 'running' || run.state === 'stalled')

/** Only journal-owned bindings are eligible for a fresh person-authorized cleanup. */
export const personStopOwnedRuns = (state: LeadState, runs: readonly StoredFlowExecution[]): StoredFlowExecution[] => {
  const logicalGoalId = state.budget?.logicalGoalId, digest = state.contract?.digest
  if (!logicalGoalId || !digest) throw new Error('lead-stop-runs-unavailable')
  return state.runs.map(owned => {
    const run = runs.find(candidate => candidate.id === owned.runId)
    const attempt = state.attempts.get(owned.correlationId)
    if (!run || run.goal !== owned.teamId || run.lead?.logicalGoalId !== logicalGoalId || run.lead.contractDigest !== digest ||
      run.lead.startId !== owned.correlationId || !attempt?.stepId || run.lead.stepId !== attempt.stepId)
      throw new Error('lead-stop-runs-unavailable')
    return run
  })
}
