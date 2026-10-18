import { leadBudgetProjection, leadReviewedResultSource, type LeadJournal } from '@harnessdesk/lead'
import type { HostParams, LeadProject } from '@harnessdesk/protocol'
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
    const { journal, project, now, previews, budgets, nextId } = this.options
    const state = journal.state, contract = state.contract, consent = state.consent, budget = state.budget
    const step = contract?.steps.find(step => state.steps.find(item => item.id === step.id)?.state === 'pending')
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
    const projection = leadBudgetProjection(journal.state.budget!, now())
    if (projection.stop || projection.spend !== 'known' || projection.reservedUsdMicros > 0) return false
    const binding: FlowLeadBinding = { logicalGoalId: budget.logicalGoalId, contractDigest: contract.digest, stepId: step.id, startId: nextId() }
    if (!previews.bindLead(params, binding)) return false
    budgets.prepare(binding.startId, journal, step.id, params, project)
    return true
  }
}
