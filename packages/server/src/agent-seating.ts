import type { FlowSeat } from '@harnessdesk/protocol'

import { seatSpec } from './flow.js'

/**
 * Which seat an Agent takes here, and why not the ones above it.
 *
 * Pure: the caller builds the offers from the runtime registry, the accounts
 * plane and the limits it already reads. Every branch below is therefore
 * reachable from a test, which matters because the expensive failure of this
 * feature is silent: seating a different model than the one asked for.
 *
 * So there is no fallback that guesses. A candidate either matches an offer
 * exactly or is passed over with a reason a person can act on — and the five
 * reasons are five different sentences because they ask for five different
 * fixes: install it, sign in, wait for the window, or change the model or the
 * effort the Agent asks for.
 */

/**
 * What this machine can seat on one runtime, right now. One per runtime — the
 * first that names a runtime is the one read — with that runtime's accounts
 * folded into it by the caller.
 */
export interface SeatOffer {
  /** The runtime's id, as a seat spec names it: `cursor`, `claude`. */
  readonly runtime: string
  /**
   * Models this runtime currently offers, by the id a seat spec writes, not
   * the label a picker shows. Empty means it does not take a model, so a
   * candidate that names one is passed over. Empty never means "not known":
   * build an offer from a list that was read.
   */
  readonly models: readonly string[]
  /** Efforts, on the same terms as `models`: `high`, not `High`. */
  readonly efforts: readonly string[]
  readonly signedIn: boolean
  /**
   * Its window is exhausted; seating it now would fail or queue. A window that
   * binds one model only is not this: the runtime still answers on the others.
   */
  readonly spent: boolean
}

export interface PassedOver {
  readonly seat: FlowSeat
  /** A sentence for a person: the runtime, and what it lacks. */
  readonly why: string
}

/**
 * The seat taken and the candidates above it, or no seat and every candidate.
 * A candidate below the one taken was never tried, so it is not in `passed`.
 */
export type Seating =
  | { readonly seat: FlowSeat; readonly passed: readonly PassedOver[] }
  | { readonly seat: null; readonly passed: readonly PassedOver[] }

/** Why this candidate cannot be taken, or null when it can. */
const whyNot = (seat: FlowSeat, offers: readonly SeatOffer[]): string | null => {
  const offer = offers.find((one) => one.runtime === seat.runtime)
  if (!offer) return `${seat.runtime} is not installed`
  /* Before anything the candidate asked for: signed out, a runtime may list no
     models at all, and "does not offer" would then send the reader to change a
     spec that was right. */
  if (!offer.signedIn) return `${seat.runtime} is signed out`
  if (offer.spent) return `${seat.runtime}'s window is spent`
  /* A model or effort left out, or written as null, is not asked for, so there
     is nothing to check it against. */
  if (seat.model && !offer.models.includes(seat.model)) {
    return `${seat.runtime} does not offer ${seat.model}`
  }
  if (seat.effort && !offer.efforts.includes(seat.effort)) {
    return `${seat.runtime} does not offer ${seat.effort} effort`
  }
  return null
}

/**
 * The first candidate this machine can seat, exactly as it was written, and
 * each one above it with the reason it was passed over.
 */
export const chooseSeat = (candidates: readonly FlowSeat[], offers: readonly SeatOffer[]): Seating => {
  const passed: PassedOver[] = []
  for (const seat of candidates) {
    const why = whyNot(seat, offers)
    if (why === null) return { seat, passed }
    passed.push({ seat, why })
  }
  return { seat: null, passed }
}

/**
 * The refusal, a line per candidate. Each is quoted by `seatSpec`, in the
 * grammar `prefer` is written in, because that is the text a person can find
 * in an `AGENT.md` and change.
 */
export const explainRefusal = (passed: readonly PassedOver[]): string => {
  if (passed.length === 0) {
    return 'No seat could be opened for this Agent: it has no seat to try — add one to the prefer list in its AGENT.md.'
  }
  const lines = passed.map((one) => `  ${seatSpec(one.seat)} — ${one.why}`)
  return `No seat could be opened for this Agent:\n${lines.join('\n')}`
}
