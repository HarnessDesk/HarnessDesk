import type { FlowExecution } from '@harnessdesk/protocol'

/** A retained wait stops needing attention once this Run ends or resumes routing. */
export const waitingForEvidence = (execution: FlowExecution): boolean =>
  execution.state === 'running' && execution.rounds.some(round => round.state === 'waiting-evidence')

/** Overview and Timeline report the same execution and publication attention. */
export const runNeedsAttention = (execution: FlowExecution, publicationNeedsYou: boolean): boolean =>
  publicationNeedsYou || waitingForEvidence(execution) || execution.state === 'stalled' ||
  execution.end?.kind === 'unrouted' || execution.end?.kind === 'budget'
