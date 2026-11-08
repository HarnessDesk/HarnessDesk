import { leadRefusal } from './controls.js'
import { canBeginLeadGoal, type LeadJournal } from '@harnessdesk/lead'
import type { LeadSchedule, LeadScheduledTask } from '@harnessdesk/protocol'
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
    let result: Awaited<ReturnType<typeof this.port.start>>
    try { result = await this.port.start(due.task, due.slot) }
    catch {
      await this.port.planner.recordRun(due.task.id, { slot: due.slot, at: now, state: 'skipped', reason: 'The Lead could not start' })
      return
    }
    await this.#recordStart(due.task, due.slot, result)
  }) }
  async #recordStart(task: LeadScheduledTask, slot: number, result: Awaited<ReturnType<typeof this.port.start>>): Promise<void> {
    await this.port.planner.recordRun(task.id, { slot, at: this.port.now(), state: result.approved ? 'started' : 'needs-approval',
      logicalGoalId: result.logicalGoalId, ...(result.reason ? { reason: result.reason } : {}) })
  }
  /** Person edits and pause/stop wait behind a start in progress, so a start
   * never redeems an approval the person withdrew while it was being admitted. */
  control(id: string, action: 'pause' | 'resume' | 'stop'): Promise<LeadSchedule> { return this.#queue(() => this.port.planner.control(id, action)) }
  write(schedule: LeadSchedule): Promise<LeadSchedule> { return this.#queue(() => this.port.planner.writeSchedule(schedule)) }
  runNow(id: string): Promise<void> { return this.#queue(async () => {
    if (!this.#idle()) throw leadRefusal('lead-request-in-flight')
    const schedule = await this.port.planner.readSchedule(), task = schedule.tasks.find(task => task.id === id)
    if (!task || !task.enabled) throw leadRefusal('lead-repeat-missing')
    if (leadQuietAt(schedule, new Date(this.port.now()))) throw leadRefusal('lead-repeat-quiet')
    const slot = this.port.now()
    await this.#recordStart(task, slot, await this.port.start(task, slot))
  }) }
}
