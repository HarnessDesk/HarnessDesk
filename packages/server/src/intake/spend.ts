import type { IntakeSpend, IntakeSpendProvenance } from '@harnessdesk/protocol'

import { seatFor, type SeatWindow } from '../insight/attribution.js'
import type { UsageSample } from '../ledger/insight.js'

/**
 * What a trigger's Goal has spent, Seat by Seat, from Insight's
 * source-qualified usage samples.
 *
 * - **Attributed, never divided.** A sample counts only when it belongs to
 *   exactly one of this desk's Seats — its runtime, session, project and a
 *   window inside that Seat's life (`insight/attribution.ts`). A
 *   runtime-wide total, an ambiguous window or an unrelated session counts
 *   for no Goal; nothing is shared out between Goals.
 * - **Counted once.** A cumulative session total is read as a delta from the
 *   Seat's own baseline, and moves only forward; a per-call sample counts
 *   once by its key. A replay is nothing; a session's two kinds of total are
 *   never added together.
 * - **Unknown is not zero.** No USD cost, a floor rather than a total, an
 *   unknown money basis, a list-price total whose model changed inside one
 *   cumulative figure, delegated work whose inclusion the desk cannot tell,
 *   a total that went down, or a session read without a baseline: each makes
 *   that Seat's spend unknown — and a Goal with one unknown Seat has unknown
 *   spend — until a person looks. A Seat that has had no turn has spent
 *   nothing; one that had a turn after its last reading has not been metered
 *   yet, which is unknown too.
 */

/** How stale a reading may be while its Seat is inside a turn. */
export const SPEND_FRESH_MS = 60_000
const CALL_KEYS = 10_000

export interface SessionMeter {
  readonly seat: string
  readonly runtime: string
  readonly sessionId: string
  readonly project: string
  readonly openedAt: number
  /** The desk opened this session for the Seat, so its cumulative totals start at zero. */
  readonly fresh: boolean
  /** Whether the Seat handed work to other sessions, as the host knows it. */
  readonly delegation: 'none' | 'some' | 'unknown'
  readonly scope: 'call' | 'session' | null
  readonly provenance: 'vendorMetered' | 'listPrice' | null
  readonly model: string | null
  readonly baselineMicros: number | null
  readonly lastMicros: number | null
  readonly callMicros: number
  readonly calls: readonly string[]
  readonly observedAt: number | null
  readonly turnStartedAt: number | null
  readonly turnEndedAt: number | null
  /** Why this Seat's spend cannot be vouched for; null while it can. */
  readonly unknown: string | null
}

export const openMeter = (input: {
  readonly seat: string; readonly runtime: string; readonly sessionId: string; readonly project: string
  readonly openedAt: number; readonly fresh: boolean; readonly delegation: SessionMeter['delegation']
}): SessionMeter => ({
  ...input, scope: null, provenance: null, model: null, baselineMicros: input.fresh ? 0 : null, lastMicros: null,
  callMicros: 0, calls: [], observedAt: null, turnStartedAt: null, turnEndedAt: null, unknown: null,
})

/** Dollars to integer micros; a non-finite or negative figure is no figure. */
const micros = (usd: number): number | null => (Number.isFinite(usd) && usd >= 0 ? Math.round(usd * 1_000_000) : null)

/** The Seat a sample belongs to, or null: exactly one Seat's window, never a runtime-wide or shared total. */
export const attributeSample = (sample: UsageSample, seats: readonly SeatWindow[]): string | null => seatFor(sample, seats)

/**
 * One sample, folded into one Seat's meter. A sample for another session
 * changes nothing; anything the meter cannot vouch for makes it unknown, and
 * an unknown meter stays unknown — nothing later refunds or repairs it.
 */
export function meterSample(meter: SessionMeter, sample: UsageSample): SessionMeter {
  if (sample.runtime !== meter.runtime || sample.sessionId !== meter.sessionId) return meter
  if (meter.unknown !== null) return meter
  const unknown = (why: string): SessionMeter => ({ ...meter, unknown: why })
  const at = sample.to ?? sample.from ?? meter.observedAt ?? 0
  if (sample.usd.value === null || sample.usd.quality === 'unknown') return unknown('This session reported no cost in dollars.')
  if (sample.usd.quality === 'floor') return unknown('This session reported only part of its cost.')
  if (sample.moneyBasis === 'unknown') return unknown('This session’s cost has no known basis.')
  const value = micros(sample.usd.value)
  if (value === null) return unknown('This session reported a cost that is not a number.')
  if (meter.delegation === 'unknown' || (meter.delegation === 'some' && sample.includesChildren !== true)) {
    return unknown('This Seat handed work to other sessions, and its cost cannot be told apart from theirs.')
  }
  if (meter.scope !== null && meter.scope !== sample.scope) return unknown('This session reported its cost two ways at once.')
  if (meter.provenance !== null && meter.provenance !== sample.moneyBasis) return unknown('This session’s cost changed basis part-way.')
  if (sample.scope === 'session') {
    if (sample.moneyBasis === 'listPrice' && meter.model !== null && sample.model !== meter.model) {
      return unknown('The model changed inside one cumulative total, so its list price cannot be split.')
    }
    if (meter.baselineMicros === null) return unknown('This session was not new when it was seated, and no starting total was captured.')
    if (meter.lastMicros !== null && value < meter.lastMicros) return unknown('This session’s total went down, so what it spent is no longer known.')
    return {
      ...meter, scope: 'session', provenance: sample.moneyBasis, model: sample.model,
      lastMicros: value, observedAt: Math.max(meter.observedAt ?? 0, at),
    }
  }
  if (meter.calls.includes(sample.key)) return meter
  if (meter.calls.length >= CALL_KEYS) return unknown('This session reported more separate costs than the desk keeps.')
  return {
    ...meter, scope: 'call', provenance: sample.moneyBasis, model: sample.model,
    callMicros: meter.callMicros + value, calls: [...meter.calls, sample.key], observedAt: Math.max(meter.observedAt ?? 0, at),
  }
}

/** A turn the host saw start or end on this Seat's session. */
export const meterTurn = (meter: SessionMeter, turn: { readonly started?: number; readonly ended?: number }): SessionMeter => ({
  ...meter,
  ...(turn.started !== undefined ? { turnStartedAt: Math.max(meter.turnStartedAt ?? 0, turn.started) } : {}),
  ...(turn.ended !== undefined ? { turnEndedAt: Math.max(meter.turnEndedAt ?? 0, turn.ended) } : {}),
})

/** What one Seat has spent now, or null with why. */
export function meterTotal(meter: SessionMeter, now: number): { readonly micros: number | null; readonly why: string | null } {
  if (meter.unknown !== null) return { micros: null, why: meter.unknown }
  const turned = meter.turnStartedAt !== null || meter.turnEndedAt !== null
  if (meter.observedAt === null) {
    // Known zero only when the desk saw no turn at all.
    return turned ? { micros: null, why: 'This Seat has worked, and its cost has not been read yet.' } : { micros: 0, why: null }
  }
  if (meter.turnEndedAt !== null && meter.observedAt < meter.turnEndedAt) {
    return { micros: null, why: 'This Seat’s last turn has not been metered yet.' }
  }
  const inTurn = meter.turnStartedAt !== null && (meter.turnEndedAt === null || meter.turnStartedAt > meter.turnEndedAt)
  if (inTurn && now - meter.observedAt > SPEND_FRESH_MS) return { micros: null, why: 'This Seat’s cost was last read more than a minute ago.' }
  const total = meter.scope === 'call' ? meter.callMicros : (meter.lastMicros ?? 0) - (meter.baselineMicros ?? 0)
  return { micros: total, why: null }
}

/** One Seat's spend as the protocol says it. */
export const spendOf = (meter: SessionMeter, now: number): IntakeSpend => {
  const total = meterTotal(meter, now)
  const provenance: IntakeSpendProvenance = total.micros === null || meter.provenance === null ? 'unknown' : meter.provenance
  return {
    seat: meter.seat, session: { runtime: meter.runtime, sessionId: meter.sessionId }, turn: null,
    observedAt: meter.observedAt ?? meter.openedAt, totalMicros: total.micros, provenance, complete: total.micros !== null,
  }
}

/** A Goal's spend: every Seat's, or unknown with the first reason; and where the money figure came from. */
export function goalSpend(meters: readonly SessionMeter[], now: number): {
  readonly spentMicros: number | null
  readonly provenance: 'vendorMetered' | 'listPrice' | 'mixed' | 'unknown'
  readonly why: string | null
} {
  let spent = 0
  const kinds = new Set<string>()
  for (const meter of meters) {
    const total = meterTotal(meter, now)
    if (total.micros === null) return { spentMicros: null, provenance: 'unknown', why: total.why }
    spent += total.micros
    if (meter.provenance !== null) kinds.add(meter.provenance)
  }
  // Nothing read yet is a known zero with no basis to name: never labelled as metered.
  const provenance = kinds.size === 0 ? 'unknown' : kinds.size === 1 ? [...kinds][0] as 'vendorMetered' | 'listPrice' : 'mixed'
  return { spentMicros: spent, provenance, why: null }
}
