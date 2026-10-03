import { sessionKey, splitSessionKey, type FlowExecution, type GoalView, type SeatRecord, type SessionKey, type TeamState } from '@harnessdesk/protocol'

/** One durable conversation identity, shared by the rail, Overview and tree. */
export interface TeamSeat {
  key: SessionKey
  record: Pick<SeatRecord, 'id' | 'session' | 'role' | 'openedAt'>
  role: string | null
  name: string
}

export const teamSeats = (
  goal: GoalView | null | undefined,
  team: TeamState | null | undefined,
  execution: FlowExecution | null,
): TeamSeat[] => {
  const result = new Map<SessionKey, TeamSeat>()
  const rounds = execution && execution.goal === team?.id ? execution.rounds : []
  // Wrapping closes membership. Receipt conversation links belong to PR 18.
  for (const record of goal?.goal.state === 'wrapped' ? [] : goal?.members ?? []) {
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
