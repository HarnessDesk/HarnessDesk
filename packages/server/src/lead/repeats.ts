import { leadRefusal } from './controls.js'
import { canBeginLeadGoal, type LeadJournal } from '@harnessdesk/lead'
import type { LeadScheduledTask } from '@harnessdesk/protocol'
import { leadDueTask, leadQuietAt, type LeadPlanner } from './planner.js'

/** One serialized host owner consumes schedule slots even when busy or paused.
 * A slot is never a pending queue item. Quiet hours hold it until they end. */
export class LeadRepeats {
  #tail: Promise<unknown> = Promise.resolve()
  constructor(private readonly port: {
    planner: LeadPlanner; journal: LeadJournal; now(): number
    start(task: LeadScheduledTask, slot: number): Promise<{ logicalGoalId: string; approved: boolean; reason?: string }>
  }) {}
  #queue<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.#tail.then(operation); this.#tail = next.catch(() => {}); return next
  }
  #idle(): boolean {
    const state = this.port.journal.state
    return canBeginLeadGoal(state) || state.phase === 'draft' && !state.messages.length
  }
  tick(): Promise<void> { return this.#queue(async () => {
    const schedule = await this.port.planner.readSchedule(), now = this.port.now(), due = leadDueTask(schedule, new Date(now))
    if (!due) return
    const reason = due.task.paused ? 'Paused' : !this.#idle() ? 'The previous goal is still open' : null
    if (reason) { await this.port.planner.recordRun(due.task.id, { slot: due.slot, at: now, state: 'skipped', reason }); return }
    await this.#start(due.task, due.slot)
  }) }
  async #start(task: LeadScheduledTask, slot: number): Promise<void> {
    const result = await this.port.start(task, slot)
    await this.port.planner.recordRun(task.id, { slot, at: this.port.now(), state: result.approved ? 'started' : 'needs-approval',
      logicalGoalId: result.logicalGoalId, ...(result.reason ? { reason: result.reason } : {}) })
  }
  runNow(id: string): Promise<void> { return this.#queue(async () => {
    if (!this.#idle()) throw leadRefusal('lead-request-in-flight')
    const schedule = await this.port.planner.readSchedule(), task = schedule.tasks.find(task => task.id === id)
    if (!task || !task.enabled) throw leadRefusal('lead-repeat-missing')
    if (leadQuietAt(schedule, new Date(this.port.now()))) throw leadRefusal('lead-repeat-quiet')
    await this.#start(task, this.port.now())
  }) }
}
