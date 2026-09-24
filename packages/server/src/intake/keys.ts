import { createHash } from 'node:crypto'

/**
 * A firing's identity, and when a schedule is due.
 *
 * `eventKey` hashes the JSON of a typed tuple, never a delimiter join: `a:b`
 * then `c` and `a` then `b:c` are different facts, and so are the number 1 and
 * the string "1". The caller builds the tuple from host-validated scalars in
 * a fixed order; outside text is never a path, a key segment or a delimiter.
 *
 * `scheduleSlot` answers the one slot due now: the newest UTC-epoch-aligned
 * slot after the watermark, or nothing. A desk that was off for five slots
 * catches the latest one only, and a clock rolled back never replays a slot
 * it has already passed.
 */

export function eventKey(parts: readonly (string | number)[]): string {
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex')
}

export const SCHEDULE_MINUTES_MAX = 10080

export function scheduleSlot(now: number, since: number, everyMinutes: number): number | null {
  if (!Number.isSafeInteger(now) || !Number.isSafeInteger(since) || now < 0 || since < 0) {
    throw new Error('The schedule clock is invalid.')
  }
  if (!Number.isSafeInteger(everyMinutes) || everyMinutes < 1 || everyMinutes > SCHEDULE_MINUTES_MAX) {
    throw new Error('A schedule interval must be 1–10080 minutes.')
  }
  const width = everyMinutes * 60000
  const slot = Math.floor(now / width) * width
  return slot > since ? slot : null
}

/** How many slots elapsed after `since` before `slot`, the one being fired: the skipped count a catch-up reports. */
export function skippedSlots(slot: number, since: number, everyMinutes: number): number {
  const width = everyMinutes * 60000
  const first = Math.floor(since / width) * width + width
  return slot > first ? Math.floor((slot - first) / width) : 0
}
