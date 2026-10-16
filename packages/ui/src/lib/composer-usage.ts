import type { AppSnapshot } from '../state/snapshot'
import { bindingLane, remainingOf } from './usage'

/** Owner pick #1675 D3: a pace forecast earns composer space below 15% remaining. */
export const COMPOSER_PACE_REMAINING_PERCENT = 15

export const composerPaceVisible = (snapshot: AppSnapshot, runtime: string): boolean => {
  const started = [...snapshot.sessions].some(([key, session]) => !snapshot.previewSessions.has(key) && session.turns.length > 0)
  const report = snapshot.usage.find(one => one.runtime === runtime)
  const lane = report && bindingLane(report.lanes)
  const left = lane ? remainingOf(lane) : null
  return started && left !== null && left < COMPOSER_PACE_REMAINING_PERCENT
}
