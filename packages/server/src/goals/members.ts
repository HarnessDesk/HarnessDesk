import { membersOf, type SeatRecord, type SessionPointer, type TeamState } from '@harnessdesk/protocol'

import type { GoalDocument } from './store.js'

/** An imported document is history. A staged opening is hidden until its board commit. */
export function goalMembers(document: GoalDocument, seats: readonly SeatRecord[]): SeatRecord[] {
  if (document.restored) return []
  const pending = document.operation?.kind === 'assignment' ? document.operation.opening.id : null
  return membersOf(document.goal, seats).filter((seat) => seat.id !== pending)
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
