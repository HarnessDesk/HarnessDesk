import type { LeadAcceptanceContract, LeadOrigin, LeadSchedule, LeadScheduledTask, LeadTaskRepeat } from '@harnessdesk/protocol'

export const leadRepeatWords: Record<LeadTaskRepeat, string> = { day: 'Every day', weekdays: 'Weekdays', mondays: 'Mondays', fridays: 'Fridays' }
/** A scheduled origin names its slot, and the host records that slot in the
 * task's runs when it starts one; two tasks sharing a slot are not guessed at. */
const leadTaskForSlot = (schedule: LeadSchedule, origin: LeadOrigin): LeadScheduledTask | undefined => {
  const slot = Number(origin.subject)
  if (origin.event !== 'scheduled-run' || !Number.isSafeInteger(slot)) return undefined
  const matches = schedule.tasks.filter(task => task.runs?.some(run => run.slot === slot))
  return matches.length === 1 ? matches[0] : undefined
}
/** Historical cards keep their own repeat; only the current card can borrow the current origin. */
export const leadRepeatTaskFor = (schedule: LeadSchedule, scope: LeadAcceptanceContract, currentDigest?: string, origin?: LeadOrigin | null): LeadScheduledTask | undefined =>
  schedule.tasks.find(task => task.approved?.contractDigest === scope.digest)
  ?? (scope.digest === currentDigest && origin?.source === 'schedule' ? leadTaskForSlot(schedule, origin) : undefined)
  ?? schedule.tasks.find(task => task.approved?.contract.goal === scope.goal && task.project === scope.project.path && task.every === scope.repeat?.every && task.at === scope.repeat?.at)
/** Local calendar arithmetic preserves the person's clock time across offset changes. */
export const leadNextSlot = (task: LeadScheduledTask, now = new Date()): Date | null => {
  if (!task.enabled || task.paused) return null
  for (let offset = 0; offset <= 7; offset++) {
    const slot = new Date(now)
    slot.setDate(slot.getDate() + offset)
    slot.setHours(Number(task.at.slice(0, 2)), Number(task.at.slice(3, 5)), 0, 0)
    const day = slot.getDay()
    if (slot.getTime() > Math.max(now.getTime(), task.lastRunAt ?? 0) && (task.every === 'day' || task.every === 'weekdays' && day > 0 && day < 6 || task.every === 'mondays' && day === 1 || task.every === 'fridays' && day === 5)) return slot
  }
  return null
}
