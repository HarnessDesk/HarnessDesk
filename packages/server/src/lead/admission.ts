import { leadReviewedResultSource, type LeadJournal, type LeadState } from '@harnessdesk/lead'
import type { HostParams, LeadProject, Intent } from '@harnessdesk/protocol'
import type { FlowPreviews } from '../flow-preview.js'
import type { FlowLeadBinding, StoredFlowExecution } from '../flow-execution.js'
import type { LeadBudgets } from './budgets.js'

const same = (left: unknown, right: unknown): boolean => JSON.stringify(left, (_key, value: unknown) =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))) : value) === JSON.stringify(right, (_key, value: unknown) =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))) : value)

/** Old checkpoints have no pin. Only the run's own admission binding may fill it. */
export const leadStepContractDigest = (step: LeadState['steps'][number] | undefined, run: StoredFlowExecution): string | null =>
  step?.contractDigest ?? (step && run.lead?.startId === step.attemptId ? run.lead.contractDigest : null)

/** One host-owned readiness table for pre-dispatch resolution and the door.
 * Each started step retains the contract binding under which its run was admitted.
 *
 * | predecessor | result |
 * | acceptance closed accepted, review and plan hold (any run state, including settled) | ready, with base |
 * | acceptance open awaiting the person, review and plan hold | ready, with base |
 * | acceptance closed and not accepted | terminal: lead-predecessor-unavailable |
 * | run stopped, or settled without an accepted acceptance | terminal: lead-predecessor-unavailable |
 * | binding, pin or reviewed revision cannot be confirmed | terminal: lead-predecessor-unverifiable |
 * | running or stalled (any other live state) | not yet: desk wait |
 */
export const leadPredecessorReadiness = (state: LeadState, stepId: string, runs: readonly StoredFlowExecution[],
  readIntents: LeadAdmissionOptions['readIntents']): { ready: boolean; terminal?: true; reason?: 'lead-predecessor-unavailable' | 'lead-predecessor-unverifiable'; base?: string } => {
  const unavailable = { ready: false, terminal: true, reason: 'lead-predecessor-unavailable' } as const
  const unverifiable = { ready: false, terminal: true, reason: 'lead-predecessor-unverifiable' } as const
  const index = state.contract?.steps.findIndex(step => step.id === stepId) ?? -1
  if (index === 0) return { ready: true }
  if (index < 0) return unverifiable
  const predecessor = state.contract!.steps[index - 1]!
  const recorded = state.steps.find(step => step.id === predecessor.id)
  const owned = state.runs.find(run => run.correlationId === recorded?.attemptId)
  const run = owned && runs.find(run => run.id === owned.runId && run.goal === owned.teamId)
  if (!run) return unverifiable
  const acceptance = run.rounds.at(-1)
  const cards = acceptance?.cards?.map(id => readIntents(run.goal).find(card => card.id === id)) ?? []
  const accepted = acceptance?.role === 'accept' && acceptance.state === 'closed' && cards.length > 0 &&
    cards.every(card => card?.state === 'done' && card.outcome === 'accepted')
  const open = acceptance?.role === 'accept' && acceptance.state === 'running' && cards.length > 0 &&
    cards.every(card => card?.state === 'open')
  // Acceptance decides before run state: a person decision settles the run.
  if (acceptance?.role === 'accept' && acceptance.state === 'closed' && cards.some(card => !card)) return unverifiable
  if (acceptance?.role === 'accept' && acceptance.state === 'closed' && !accepted) return unavailable
  if (!accepted && (run.state === 'stopped' || run.state === 'settled')) return unavailable
  if (recorded?.state !== 'started' || run.lead?.logicalGoalId !== state.budget?.logicalGoalId ||
    run.lead?.contractDigest !== leadStepContractDigest(recorded, run) || run.lead?.stepId !== predecessor.id ||
    run.lead?.startId !== owned!.correlationId) return unverifiable
  if (!accepted && !open) return { ready: false }
  const review = run.rounds.filter(round => round.role === 'review').at(-1)
  if (!review || review.state !== 'closed') return unverifiable
  const plan = run.seatPlans?.[String(review.n)]
  if (!plan?.base || !/^[a-f0-9]{40,64}$/.test(plan.base) || plan.handed.length !== 1 || plan.handed[0]!.at !== plan.base)
    return unverifiable
  return { ready: true, base: plan.base }
}

export interface LeadAdmissionOptions {
  readonly journal: LeadJournal
  readonly budgets: LeadBudgets
  readonly previews: FlowPreviews
  readonly project: LeadProject
  readonly now: () => number
  readonly readIntents: (goal: string) => readonly Pick<Intent, 'id' | 'state' | 'outcome'>[]
  readonly nextId: () => string
}
/** Installed by the trusted host on the private connection. Admission annotates
 * the held token, so even redemption through another door retains its guard. */
export class LeadAdmission {
  constructor(readonly options: LeadAdmissionOptions) {}
  readonly readOwned = () => this.options.journal.state.runs.map(run => ({ goal: run.teamId, run: run.runId }))
  readonly preview = async (params: HostParams<'flow/preview'>) => {
    if (params.source !== leadReviewedResultSource || params.retry || params.continues ||
      params.root !== this.options.project.path || !await this.options.budgets.port.member(this.options.project)) throw new Error('lead-preview-refused')
    return this.options.previews.preview(params.root, leadReviewedResultSource, params.vars, undefined, undefined,
      { seats: params.seats, attended: params.attended, requireHeld: true })
  }
  readonly authorizeStart = async (params: HostParams<'flow/start-goal'>): Promise<boolean> => {
    const { journal, project, now, previews, budgets } = this.options
    const state = journal.state, contract = state.contract, consent = state.consent, budget = state.budget
    const admitted = state.steps.find(step => step.state === 'admitted')
    const attempt = admitted?.attemptId ? state.attempts.get(admitted.attemptId) : null
    const step = contract?.steps.find(step => step.id === admitted?.id)
    if (!attempt || attempt.phase !== 'started' || !attempt.dispatched || attempt.method !== 'flow/start-goal' ||
      state.runs.some(run => run.correlationId === attempt.correlationId) || budgets.prepared(attempt.correlationId)) return false
    if (!contract || !consent || !budget || !step || contract.digest !== consent.contractDigest || consent.expiresAt <= now() ||
      ['stopped', 'accepted', 'declined', 'following', 'waiting-for-user', 'awaiting-plan'].includes(state.phase) || state.recoveryBlocked ||
      !same(contract.project, project) || params.root !== project.path || params.source !== leadReviewedResultSource ||
      params.sentence !== contract.goal || params.goal || params.continues || step.flow !== 'lead-reviewed-result' || step.sourceRevision !== 'recipe-1' ||
      !same(params.vars ?? {}, step.variables) || (params.attended !== false) !== (step.attendance === 'attended') ||
      !await budgets.port.member(project)) return false
    const seats = Object.fromEntries(step.assignments.map(assignment => [assignment.role, [assignment.seat]]))
    if (step.assignments.length !== 2 || new Set(step.assignments.map(assignment => assignment.role)).size !== 2 ||
      !same(params.seats ?? {}, seats) || step.assignments.some(assignment =>
      !((assignment.role === 'implement' && assignment.agent === 'implementer' && assignment.ceiling === 'edit') ||
        (assignment.role === 'review' && assignment.agent === 'code-reviewer' && assignment.ceiling === 'read')))) return false
    const projection = budgets.startBudget(journal, attempt.correlationId)
    if (projection.stop || projection.spend !== 'known' || projection.reservedUsdMicros > 0) return false
    // Array order is execution order. Only the host's frozen review seating can
    // supply the next step's base; a model-chosen ref or the project's current
    // HEAD cannot stand in for the work the previous independent reviewer saw.
    const { ready, base } = leadPredecessorReadiness(state, step.id, budgets.port.runs(), this.options.readIntents)
    if (!ready) return false
    const binding: FlowLeadBinding = { logicalGoalId: budget.logicalGoalId, contractDigest: contract.digest, stepId: step.id,
      startId: attempt.correlationId, ...(base ? { base } : {}) }
    if (budgets.prepared(binding.startId) || journal.state.steps.find(item => item.id === step.id)?.attemptId !== attempt.id ||
      journal.state.attempts.get(attempt.id)?.phase !== 'started' || !previews.bindLead(params, binding)) return false
    budgets.prepare(binding.startId, journal, step.id, params, project)
    return true
  }
}
