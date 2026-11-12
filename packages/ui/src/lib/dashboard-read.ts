import { formatAge } from './usage'

/**
 * A source observation predating this window must not look like a read made by this desk, and still says when it
 * was made: the day, or the time when it was today, as the phone's "Read Nov 3" does.
 */
export const dashboardReadLabel = (fetchedAt: number, now: number, startedAt: number): string =>
  fetchedAt < startedAt ? `From a cached read · ${readDay(fetchedAt, now)}` : `Read ${formatAge(fetchedAt, now)}`

const readDay = (at: number, now: number): string => {
  const read = new Date(at), today = new Date(now)
  return read.toDateString() === today.toDateString()
    ? read.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
    : read.toLocaleDateString('en-US', { month: 'short', day: 'numeric', ...(read.getFullYear() !== today.getFullYear() ? { year: 'numeric' as const } : {}) })
}
