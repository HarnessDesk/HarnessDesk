/**
 * The desk clock as one line of desk context. Every request carries it after the cache mark, so the model reads the
 * date and the time in the person's zone as a fact ("N hours ago" is a subtraction, not a guess) without the cached
 * prefix changing from one request to the next. Built from parts, so it reads the same on every ICU build.
 */
export const LEAD_CLOCK_PREFIX = 'Desk clock: '
export const leadClockLine = (now: number, timeZone?: string): string => {
  let zone = timeZone
  try { zone ??= Intl.DateTimeFormat().resolvedOptions().timeZone } catch { /* The host's zone stays unnamed. */ }
  let format: Intl.DateTimeFormat
  try {
    format = new Intl.DateTimeFormat('en-GB', { timeZone: zone, weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZoneName: 'longOffset' })
  } catch {
    zone = 'UTC'
    format = new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZoneName: 'longOffset' })
  }
  const part = (type: Intl.DateTimeFormatPartTypes) => format.formatToParts(new Date(now)).find(one => one.type === type)?.value ?? ''
  const offset = part('timeZoneName').replace(/^GMT$/, 'UTC').replace(/^GMT/, 'UTC')
  return `${LEAD_CLOCK_PREFIX}${part('weekday')} ${part('day')} ${part('month')} ${part('year')}, ${part('hour')}:${part('minute')} (${zone ?? 'local time'}, ${offset}). ` +
    'This is now, in the person\'s time zone: work out any "how long ago" or "when" from it, never from a guess.'
}
