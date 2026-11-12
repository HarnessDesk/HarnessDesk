/**
 * How long until something happens, as the Dashboard says it. The desktop, what the phone receives and what the Lead
 * is told all use these, so the Lead never words a reset its own way (#2174). Elapsed time is `elapsed.ts`.
 */
const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/**
 * Rounds to the nearest whole unit rather than truncating: 47h59m reads as two
 * days to a person, not the one day flooring produces.
 */
export const formatCountdown = (ms: number): string | null => {
  if (!Number.isFinite(ms) || ms <= 0) return null
  if (ms < HOUR) {
    // Rounding can carry into the next unit at every boundary — 59½ minutes
    // is 60, 23 hours and 59½ minutes is 24 — and each carry is said in the
    // unit above it, never as "60m" or "24h".
    const minutes = Math.max(1, Math.round(ms / MINUTE))
    return minutes === 60 ? '1h' : `${minutes}m`
  }
  if (ms < DAY) {
    const hours = Math.floor(ms / HOUR)
    const minutes = Math.round((ms % HOUR) / MINUTE)
    if (minutes === 60) {
      const nextHours = hours + 1
      return nextHours === 24 ? '1d' : `${nextHours}h`
    }
    return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`
  }
  const days = Math.floor(ms / DAY)
  const hours = Math.round((ms % DAY) / HOUR)
  if (hours === 24) return `${days + 1}d`
  return hours > 0 ? `${days}d ${hours}h` : `${days}d`
}

/** The words of a usage meter's reset, "21 d 3 h"; null when the reset is due or past. */
export const formatResetIn = (ms: number): string | null => formatCountdown(ms)?.replace(/(\d)([dhm])/g, '$1 $2') ?? null

/** The reset reading shared by every usage meter list. */
export const formatResetCountdown = (ms: number | null): string => {
  const value = ms === null ? null : formatResetIn(ms)
  return value === null ? '—' : `in ${value}`
}

/** One unit only, for a row that has no space for two. */
export const formatCountdownShort = (ms: number): string | null => {
  if (!Number.isFinite(ms) || ms <= 0) return null
  if (ms < HOUR) {
    const minutes = Math.max(1, Math.round(ms / MINUTE))
    return minutes === 60 ? '1h' : `${minutes}m`
  }
  if (ms < DAY) {
    const hours = Math.round(ms / HOUR)
    return hours >= 24 ? '1d' : `${Math.max(1, hours)}h`
  }
  return `${Math.max(1, Math.round(ms / DAY))}d`
}
