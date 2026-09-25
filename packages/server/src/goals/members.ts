import { membersOf, type SeatRecord, type SessionPointer, type TeamState } from '@harnessdesk/protocol'

import type { GoalDocument } from './store.js'

/** An imported document is history. A staged opening is hidden until its board commit. */
export function goalMembers(document: GoalDocument, seats: readonly SeatRecord[]): SeatRecord[] {
  if (document.restored) return []
  const pending = document.operation?.kind === 'assignment' ? document.operation.opening.id : null
  return membersOf(document.goal, seats).filter((seat) => seat.id !== pending)
}

/**
 * Stable, Goal-local addresses for Seats. Membership is supplied by the
 * caller: this helper only names the Seats it is handed and never makes a
 * historical or restored Seat current by itself.
 */
export function memberNames(
  seats: readonly SeatRecord[],
  legacy: Readonly<Record<string, string>> = {},
): Map<string, string> {
  const ordered = [...seats].sort((left, right) => left.openedAt - right.openedAt || String(left.id).localeCompare(String(right.id)))
  const bases = ordered.map((seat) => seat.agent?.name.trim() || legacy[String(seat.id)]?.trim() || seat.seatLabel)
  const counts = new Map<string, number>()
  for (const base of bases) counts.set(base, (counts.get(base) ?? 0) + 1)

  const used = new Set<string>()
  const names = new Map<string, string>()
  ordered.forEach((seat, index) => {
    const base = bases[index]!
    const candidate = (counts.get(base) ?? 0) > 1 ? `${base} · ${seat.seatLabel}` : base
    let name = candidate
    let suffix = 2
    while (used.has(name)) name = `${candidate} ${suffix++}`
    used.add(name)
    names.set(String(seat.id), name)
  })
  return names
}

export function goalOfSession(
  documents: readonly GoalDocument[],
  seats: readonly SeatRecord[],
  session: SessionPointer,
): string | null {
  const matches = documents.filter((document) => goalMembers(document, seats).some((seat) =>
    seat.session.runtime === session.runtime && seat.session.sessionId === session.sessionId,
  ))
  if (matches.length > 1) throw new Error('One conversation holds Seats in two Goals. Repair the membership before dispatching work.')
  return matches[0]?.goal.id ?? null
}

/** Team still owns nicknames and inbound policy; only Seats supply membership and roles. */
export function memberProjection(document: GoalDocument, seats: readonly SeatRecord[]): Pick<TeamState, 'members' | 'roles'> {
  const members = goalMembers(document, seats)
  const key = (seat: SeatRecord): TeamState['members'][number] =>
    `${seat.session.runtime}\u0000${seat.session.sessionId}` as TeamState['members'][number]
  return {
    members: members.map(key),
    roles: Object.fromEntries(members.flatMap((seat) => seat.role === null ? [] : [[key(seat), seat.role]])),
  }
}
