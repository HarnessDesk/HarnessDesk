import type { CeilingLevel, SeatCeiling } from '@harnessdesk/protocol'

/**
 * Held-only admission, inside the existing seating path.
 *
 * A front-door start requires every Seat to hold its ceiling: the runtime's
 * own control set and read back, at exactly the level the preview showed.
 * `open` is provisional — no brief and no work has been sent — and the
 * candidate is kept (its Seat durably recorded) only once its readback says
 * held at that level. Anything else — asked, a different level, no reading at
 * all — closes the candidate before anything is sent to it. A close that fails
 * is raised with the refusal inside it, so the person learns there is a
 * conversation to stop before retrying.
 *
 * This consumes phase 3's hold readback; it does not claim to prove what a
 * runtime's sandbox does.
 */

export interface HeldSeatPort<T> {
  open(): Promise<T>
  ceiling(seat: T): SeatCeiling | null
  close(seat: T): Promise<void>
  keep(seat: T): Promise<void>
}

export const NOT_HELD = 'This seat cannot hold the previewed ceiling. Choose a seat that can.'
export const CLEANUP_FAILED = 'The seat was refused and cleanup failed. Stop it before retrying.'

/** The refusal of one candidate: passed over, not a failure of the seating. */
export class HeldRefusal extends Error {
  constructor(readonly actual: SeatCeiling | null) {
    super(NOT_HELD)
    this.name = 'HeldRefusal'
  }
}

export async function keepHeldSeat<T>(port: HeldSeatPort<T>, expected: CeilingLevel): Promise<T> {
  const seat = await port.open()
  try {
    const actual = port.ceiling(seat)
    if (actual === null || actual.hold !== 'held' || actual.level !== expected) {
      throw new HeldRefusal(actual)
    }
    await port.keep(seat)
    return seat
  } catch (error) {
    try {
      await port.close(seat)
    } catch {
      throw new AggregateError([error], CLEANUP_FAILED)
    }
    throw error
  }
}
