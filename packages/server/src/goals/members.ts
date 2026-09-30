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

  /* Seats that share a base only because they share a seat label ("Cursor ·
     Gemini 3.8 Flash" three times) cannot be told apart by appending that
     label again — that is how "X · X 2" happened (#1115). They are told apart
     by role instead, the way the sidebar already titles them: "reviewer 1",
     "reviewer 2", and a lone "fixer" plain. Ordinals run across the room, so
     two same-model groups never both claim "reviewer 1". */
  const byRole = (seat: SeatRecord, index: number): string | null =>
    (counts.get(bases[index]!) ?? 0) > 1 && bases[index] === seat.seatLabel ? seat.role?.trim() || null : null
  const roleTotals = new Map<string, number>()
  ordered.forEach((seat, index) => {
    const role = byRole(seat, index)
    if (role) roleTotals.set(role, (roleTotals.get(role) ?? 0) + 1)
  })

  const used = new Set<string>()
  const roleOrdinals = new Map<string, number>()
  const names = new Map<string, string>()
  ordered.forEach((seat, index) => {
    const base = bases[index]!
    const role = byRole(seat, index)
    let candidate = base
    if ((counts.get(base) ?? 0) > 1 && base !== seat.seatLabel) candidate = `${base} · ${seat.seatLabel}`
    else if (role) {
      const ordinal = (roleOrdinals.get(role) ?? 0) + 1
      roleOrdinals.set(role, ordinal)
      candidate = (roleTotals.get(role) ?? 0) > 1 ? `${role} ${ordinal}` : role
    }
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
