import { leadReviewedResultSource, type LeadJournal } from '@harnessdesk/lead'
import type { HostParams, LeadProject, Intent } from '@harnessdesk/protocol'
import type { FlowPreviews } from '../flow-preview.js'
import type { FlowLeadBinding } from '../flow-execution.js'
import type { LeadBudgets } from './budgets.js'

const same = (left: unknown, right: unknown): boolean => JSON.stringify(left, (_key, value: unknown) =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))) : value) === JSON.stringify(right, (_key, value: unknown) =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))) : value)

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
      ['stopped', 'accepted', 'declined', 'waiting-for-user', 'awaiting-plan'].includes(state.phase) || state.recoveryBlocked ||
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
    const index = contract.steps.findIndex(one => one.id === step.id)
    let base: string | undefined
    if (index > 0) {
      const predecessor = contract.steps[index - 1]!
      const recorded = state.steps.find(one => one.id === predecessor.id)
      const owned = state.runs.find(one => one.correlationId === recorded?.attemptId)
      const run = owned && budgets.port.runs().find(one => one.id === owned.runId && one.goal === owned.teamId &&
        one.lead?.logicalGoalId === budget.logicalGoalId && one.lead.contractDigest === contract.digest &&
        one.lead.stepId === predecessor.id && one.lead.startId === owned.correlationId)
      const review = run?.rounds.filter(one => one.role === 'review').at(-1)
      const acceptance = run?.rounds.at(-1)
      const cards = acceptance?.cards?.map(id => this.options.readIntents(run!.goal).find(card => card.id === id)) ?? []
      const ready = cards.length > 0 && cards.every(card => acceptance?.state === 'running' && card?.state === 'open' ||
        acceptance?.state === 'closed' && card?.state === 'done' && card.outcome === 'accepted')
      const plan = review && run?.seatPlans?.[String(review.n)]
      if (recorded?.state !== 'started' || !run || !review || review.state !== 'closed' || acceptance?.role !== 'accept' || !ready ||
        !plan?.base || !/^[a-f0-9]{40,64}$/.test(plan.base) || plan.handed.length !== 1 || plan.handed[0]!.at !== plan.base) return false
      base = plan.base
    }
    const binding: FlowLeadBinding = { logicalGoalId: budget.logicalGoalId, contractDigest: contract.digest, stepId: step.id,
      startId: attempt.correlationId, ...(base ? { base } : {}) }
    if (budgets.prepared(binding.startId) || journal.state.steps.find(item => item.id === step.id)?.attemptId !== attempt.id ||
      journal.state.attempts.get(attempt.id)?.phase !== 'started' || !previews.bindLead(params, binding)) return false
    budgets.prepare(binding.startId, journal, step.id, params, project)
    return true
  }
}
