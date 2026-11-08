import type { LeadOrigin } from '@harnessdesk/protocol'

export const formatLeadRunTime = (date: Date | null): string => date ? new Intl.DateTimeFormat(undefined, {
  weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
  ...(date.getFullYear() !== new Date().getFullYear() ? { year: 'numeric' as const } : {})
}).format(date) : 'Not scheduled'

export const leadOriginText = (origin: LeadOrigin): string => {
  if (origin.source !== 'schedule') return `From: ${origin.event.replace(/-/g, ' ')} on ${origin.subject}`
  const date = new Date(Number(origin.subject))
  return Number.isFinite(date.getTime()) ? `From: scheduled run, ${formatLeadRunTime(date)}` : 'From: scheduled run'
}
