/**
 * How long ago something happened, in whole units rounded down, so a time never reads as longer ago than it was:
 * 14 hours 50 minutes is 14 hours, on the desktop, in what the phone receives and in what the Lead is told. The phone
 * writes its own words, by this same rule. Null under a minute, which every surface says as "just now".
 */
export const elapsedParts = (at: number, now: number): { readonly count: number; readonly unit: 'm' | 'h' | 'd' } | null => {
  const minutes = Math.floor(Math.max(0, now - at) / 60_000)
  if (!Number.isFinite(minutes) || minutes < 1) return null
  if (minutes < 60) return { count: minutes, unit: 'm' }
  const hours = Math.floor(minutes / 60)
  return hours < 24 ? { count: hours, unit: 'h' } : { count: Math.floor(hours / 24), unit: 'd' }
}

/** Whole minutes since `at`, rounded down and never negative: the same rule as `elapsedParts`. */
export const elapsedMinutes = (at: number, now: number): number => Math.max(0, Math.floor((now - at) / 60_000))

/** The desktop's short words for `elapsedParts`: "just now", "5m ago", "14h ago", "3d ago". */
export const formatElapsed = (at: number, now: number): string => {
  const parts = elapsedParts(at, now)
  return parts === null ? 'just now' : `${parts.count}${parts.unit} ago`
}
