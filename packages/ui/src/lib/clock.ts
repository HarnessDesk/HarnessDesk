/**
 * Instants, only when they can be believed.
 *
 * Every time on screen is a number another program chose: Codex stamps turns
 * in seconds, ACP agents in milliseconds, a fixture in whatever was handy.
 * Take one on faith and a live turn reads "Working for 496541h 26m" — the
 * subtraction was right and the input was the number 1. So a stamp is used
 * only where it could be a wall-clock reading; anything older than the app
 * itself is a sentinel or a seconds-for-milliseconds slip, and the honest
 * rendering of that is nothing at all rather than a wrong number.
 */

/** Nothing HarnessDesk has to show happened before this. */
const EARLIEST = Date.UTC(2024, 0, 1)

/**
 * A stamp a moment ahead of the reader's clock is skew between the runtime's
 * process and this one, and reads as zero; one years ahead is a unit error.
 */
const SKEW = 60_000

/** The instant, or null when the number cannot be one. */
export const instant = (at: number | null | undefined): number | null =>
  typeof at === 'number' && Number.isFinite(at) && at >= EARLIEST ? at : null

/** How long since an instant, or null when the stamp cannot be believed. */
export const elapsedSince = (at: number | null | undefined, now: number): number | null => {
  const from = instant(at)
  if (from === null) return null
  const span = now - from
  return span < -SKEW ? null : Math.max(0, span)
}
