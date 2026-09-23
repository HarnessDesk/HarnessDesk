import type { SeatRecord } from '@harnessdesk/protocol'

export interface SeatWindow {
  readonly id: string
  readonly runtime: string
  readonly sessionId: string
  readonly project: string
  readonly openedAt: number
  readonly closedAt: number | null
  readonly restored: boolean
}

export interface UsageWindow {
  readonly runtime: string
  readonly sessionId: string | null
  readonly project: string | null
  readonly from: number | null
  readonly to: number | null
}

/**
 * Joins only one complete, local Seat lifetime.  A boundary or overlap is
 * intentionally unknown: attributing it to whichever record is first would
 * transfer spend when a session is reassigned.
 */
export function seatFor(sample: UsageWindow, seats: readonly SeatWindow[]): string | null {
  if (sample.sessionId === null || sample.project === null || sample.from === null || sample.to === null) return null
  if (!Number.isFinite(sample.from) || !Number.isFinite(sample.to) || sample.to < sample.from) return null
  const matches = seats.filter((seat) => !seat.restored
    && seat.runtime === sample.runtime && seat.sessionId === sample.sessionId
    && seat.project === sample.project && sample.from! >= seat.openedAt
    && (seat.closedAt === null || sample.to! < seat.closedAt))
  return matches.length === 1 ? matches[0]!.id : null
}

export const seatWindowOf = (seat: SeatRecord): SeatWindow => ({
  id: seat.id,
  runtime: seat.session.runtime,
  sessionId: seat.session.sessionId,
  project: seat.checkout.project,
  openedAt: seat.openedAt,
  closedAt: seat.closed?.at ?? null,
  restored: seat.restored !== null && seat.restored !== undefined,
})
