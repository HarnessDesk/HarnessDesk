import type { StoredFlowExecution } from '../flow-execution.js'

/** Cancellation preserves settled work. Other stops may retry listeners whose
 * cleanup failed after the run ended. */
export const leadStopReachesRun = (run: Pick<StoredFlowExecution, 'state'> | undefined, reason: string): boolean =>
  !!run && (reason !== 'cancelled' || run.state === 'running' || run.state === 'stalled')
