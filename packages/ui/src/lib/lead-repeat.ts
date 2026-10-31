import type { LeadAcceptanceContract, LeadOrigin, LeadSchedule, LeadScheduledTask, LeadTaskRepeat } from '@harnessdesk/protocol'

export const leadRepeatWords: Record<LeadTaskRepeat, string> = { day: 'Every day', weekdays: 'Weekdays', mondays: 'Mondays', fridays: 'Fridays' }
/** Historical cards keep their own repeat; only the current card can borrow the current origin. */
export const leadRepeatTaskFor = (schedule: LeadSchedule, scope: LeadAcceptanceContract, currentDigest?: string, origin?: LeadOrigin | null): LeadScheduledTask | undefined =>
  schedule.tasks.find(task => task.approved?.contractDigest === scope.digest)
  ?? (scope.digest === currentDigest && origin?.source === 'schedule' ? schedule.tasks.find(task => origin.event === `schedule-${task.id}-${origin.subject}`) : undefined)
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
