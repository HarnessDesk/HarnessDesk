import { sessionKey, splitSessionKey, type FlowExecution, type GoalView, type SeatRecord, type SessionKey, type TeamState } from '@harnessdesk/protocol'

/** A retained Seat and its conversation, shared by the rail, Overview, tree and Run inspector. */
export interface LinkedTeamSeat {
  key: SessionKey
  record: Pick<SeatRecord, 'id' | 'session' | 'role' | 'openedAt'>
  role: string | null
  name: string
}

export type TeamSeat = LinkedTeamSeat | {
  key: null
  record: Pick<SeatRecord, 'id' | 'role' | 'openedAt'> & { session: null }
  role: string | null
  name: string
}
export const hasConversation = (seat: TeamSeat): seat is LinkedTeamSeat => seat.key !== null

export const teamSeats = (
  goal: GoalView | null | undefined,
  team: TeamState | null | undefined,
  execution: FlowExecution | null,
  receiptIdentity: 'conversation' | 'seat' = 'conversation',
): TeamSeat[] => {
  const result = new Map<SessionKey, LinkedTeamSeat>()
  const rounds = execution && execution.goal === team?.id ? execution.rounds : []
  if (goal?.goal.state === 'wrapped') {
    const receipt = goal.receipt
    /* A receipt keeps every Seat that was retained, and one conversation can have been seated more than once. The
       list is of conversations — rail rows, tree rows, counts and React keys are all by the session — so each is
       named once, where its first Seat put it and by the last Seat that held it, exactly as an open Team's list is
       (#1317). A Seat with no conversation is its own entry: there is no key to share. */
    const seats: TeamSeat[] = []
    const placed = new Map<SessionKey, number>()
    for (const id of new Set([...(receipt?.seats ?? []), ...(receipt?.members?.map(one => one.seat) ?? [])])) {
      const member = receipt?.members?.find(one => one.seat === id)
      const session = member?.session ?? receipt?.answers.find(one => one.seat === id)?.session ?? null
      const role = [...rounds].reverse().find(round => round.seats.includes(id))?.role ?? null
      const name = member?.agent ?? member?.seatLabel ?? 'Agent'
      const record = { id, session, role, openedAt: goal.goal.createdAt }
      if (!session) { seats.push({ key: null, record: { ...record, session: null }, role, name }); continue }
      const key = sessionKey(session.runtime, session.sessionId)
      const seat: LinkedTeamSeat = { key, record: { ...record, session }, role, name }
      // Run detail is keyed by Seat ID; only conversation navigation shares a row.
      const at = receiptIdentity === 'seat' ? undefined : placed.get(key)
      if (at === undefined) { placed.set(key, seats.length); seats.push(seat) } else seats[at] = seat
    }
    return seats
  }
  for (const record of goal?.members ?? []) {
    if (!record.session.runtime || !record.session.sessionId) continue
    const key = sessionKey(record.session.runtime, record.session.sessionId)
    const role = [...rounds].reverse().find(round => round.seats.includes(record.id))?.role ?? record.role
    result.set(key, { key, record, role, name: team?.nicknames?.[key] ?? record.agent?.name ?? record.seatLabel ?? 'Agent' })
  }
  for (const key of team?.members ?? []) {
    if (result.has(key) || !String(key).includes('\0')) continue
    const { runtime, id } = splitSessionKey(key)
    if (!runtime || !id) continue
    const role = team?.roles?.[key] ?? null
    result.set(key, { key, record: { id: String(key), session: { runtime, sessionId: id }, role, openedAt: 0 }, role, name: team?.nicknames?.[key] ?? 'Agent' })
  }
  return [...result.values()]
}
