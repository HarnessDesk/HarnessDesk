import { canBeginLeadGoal, type LeadJournal } from '@harnessdesk/lead'
import { parseLeadOrigin, type LeadOrigin, type LeadThreadSend } from '@harnessdesk/protocol'

export type AutomaticGoalDelivery = { readonly delivered: true } | { readonly delivered: false; readonly reason: string }
/** Schedule slots and armed project firings share one plan-only entry. The input's
 * durable send receipt acknowledges delivery; the intake journal retains pending
 * inputs, and scheduled tasks mark a slot only after its receipt exists. */
export class LeadAutomaticGoals {
  #tail: Promise<unknown> = Promise.resolve()
  constructor(private readonly port: {
    readonly journal: LeadJournal
    send(input: LeadThreadSend, origin: LeadOrigin, project?: string): Promise<unknown>
    enabled(): boolean
    quiet(): Promise<boolean>
  }) {}
  offer(input: { readonly key: string; readonly text: string; readonly origin: LeadOrigin; readonly project?: string }): Promise<AutomaticGoalDelivery> {
    const task = this.#tail.then(async (): Promise<AutomaticGoalDelivery> => {
      const { journal } = this.port, origin = parseLeadOrigin(input.origin)
      if (journal.state.sends.some(send => send.key === input.key)) return { delivered: true }
      if (!this.port.enabled()) return { delivered: false, reason: 'Lead is disabled; this firing waits.' }
      if (await this.port.quiet()) return { delivered: false, reason: 'Lead quiet hours hold this firing until they end.' }
      const state = journal.state
      if (!(canBeginLeadGoal(state) || state.phase === 'draft' && state.contract === null &&
        (state.originKey === input.key || state.origin === null && (state.messages.length === 0 || state.completedBudgets.length > 0))))
        return { delivered: false, reason: 'Lead is busy; this firing waits for the active goal.' }
      try {
        await this.port.send({ idempotencyKey: input.key, text: input.text }, origin, input.project)
        return { delivered: true }
      } catch (error) {
        const code = (error as { wireCode?: string }).wireCode
        return { delivered: false, reason: code === 'lead-key-missing' ? 'Lead credentials are missing; this firing waits.' :
          code === 'lead-request-in-flight' ? 'Lead is busy; this firing waits for the active goal.' :
          'Lead could not draft a plan; this firing remains pending.' }
      }
    })
    this.#tail = task.catch(() => {})
    return task
  }
}
