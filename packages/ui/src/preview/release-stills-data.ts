import { runtime } from './harness'

/** Runtime-authored presentation stand-ins for the public race's two providers. */
export const STILL_RUNTIMES = [runtime('codex', 'Codex'), runtime('claude', 'Claude Code')]

/** Fictional local-hour readings for two providers; the third remains unknown. */
export const STILL_HOURS = STILL_RUNTIMES.flatMap(runtime => Array.from({ length: 168 }, (_, index) => {
  const weekday = Math.floor(index / 24)
  const hour = index % 24
  const requests = weekday > 0 && weekday < 6 && hour >= 9 && hour <= 18 ? (hour - 8) * (weekday + 2) : 0
  return { runtime: runtime.id, weekday, hour, requests, tokens: requests * 2400 }
}))
