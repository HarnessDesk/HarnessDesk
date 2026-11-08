import { commitDate } from '../lib/git-refs'

/** Consent may expire weeks away; identify its calendar date rather than a weekday. */
export const formatLeadConsentTime = (at: number | null, now = Date.now()): string | null => {
  if (at === null) return null
  const date = new Date(at)
  const time = date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
  return date.toDateString() === new Date(now).toDateString() ? time : `${commitDate(at, now)} ${time}`
}
