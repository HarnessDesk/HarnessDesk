import { sessionKey, splitSessionKey, type FlowExecution, type GoalView, type SeatRecord, type SessionKey, type TeamState } from '@harnessdesk/protocol'

/** A retained Seat and its conversation, shared by the rail, Overview, tree and Run inspector. */
export interface LinkedTeamSeat {
  key: SessionKey
  record: Pick<SeatRecord, 'id' | 'session' | 'role' | 'openedAt' | 'closed'>
  role: string | null
  name: string
}

export type TeamSeat = LinkedTeamSeat | {
  key: null
  record: Pick<SeatRecord, 'id' | 'role' | 'openedAt' | 'closed'> & { session: null }
  role: string | null
  name: string
}
export const hasConversation = (seat: TeamSeat): seat is LinkedTeamSeat => seat.key !== null

/** Keep open Team membership in sync with teamNewsSessions in packages/server/src/goals/members.ts. */
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
      const role = [...rounds].reverse().find(round => round.seats.includes(id))?.role ?? member?.role ?? null
      const name = member?.agent ?? member?.seatLabel ?? 'Agent'
      const record = { id, session, role, openedAt: goal.goal.createdAt, closed: null }
      if (!session) { seats.push({ key: null, record: { ...record, session: null }, role, name }); continue }
      const key = sessionKey(session.runtime, session.sessionId)
      const seat: LinkedTeamSeat = { key, record: { ...record, session }, role, name }
      // Run detail is keyed by Seat ID; only conversation navigation shares a row.
      const at = receiptIdentity === 'seat' ? undefined : placed.get(key)
      if (at === undefined) { placed.set(key, seats.length); seats.push(seat) } else seats[at] = seat
    }
    return seats
  }
  for (const record of [...(goal?.members ?? []), ...(goal?.pastMembers ?? [])]) {
    if (!record.session.runtime || !record.session.sessionId) continue
    const key = sessionKey(record.session.runtime, record.session.sessionId)
    const role = [...rounds].reverse().find(round => round.seats.includes(record.id))?.role ?? record.role
    const held = result.get(key)
    if (held && record.closed != null && held.record.closed == null) continue
    result.set(key, { key, record, role, name: team?.nicknames?.[key] ?? record.agent?.name ?? record.seatLabel ?? 'Agent' })
  }
  for (const key of team?.members ?? []) {
    if (result.has(key) || !String(key).includes('\0')) continue
    const { runtime, id } = splitSessionKey(key)
    if (!runtime || !id) continue
    const role = team?.roles?.[key] ?? null
    result.set(key, { key, record: { id: String(key), session: { runtime, sessionId: id }, role, openedAt: 0, closed: null }, role, name: team?.nicknames?.[key] ?? 'Agent' })
  }
  return [...result.values()]
}

/** Display the model first only for the host's generated duplicate address; custom names stay whole. */
const shortenedSeatName = (
  record: { readonly agent?: { readonly name: string } | null; readonly seatLabel?: string } | undefined,
  nickname: string,
  runtimeName: string | undefined,
): string => {
  const prefix = record?.agent?.name ? `${record.agent.name} · ` : null
  if (!prefix || !record?.seatLabel || !nickname.startsWith(prefix) || !nickname.slice(prefix.length).startsWith(record.seatLabel)) return nickname
  const label = nickname.slice(prefix.length)
  if (!runtimeName) return label
  for (const runtimePrefix of [`${runtimeName} · `, `${runtimeName} `]) {
    if (label.startsWith(runtimePrefix)) return label.slice(runtimePrefix.length)
  }
  return label
}

/** Shorten only when the visible name remains unique across all Team members. */
export const seatDisplayName = (
  record: Parameters<typeof shortenedSeatName>[0], nickname: string, runtimeName: string | undefined,
  members: readonly { record?: Parameters<typeof shortenedSeatName>[0]; nickname: string; runtimeName?: string }[] = [],
): string => {
  const short = shortenedSeatName(record, nickname, runtimeName)
  return short !== nickname && members.some(one => one.nickname !== nickname && shortenedSeatName(one.record, one.nickname, one.runtimeName) === short)
    ? nickname : short
}

/** Generated Seat addresses use stable Agent ordinals; deliberate nicknames stay whole. */
export const compactTeamSeatName = (
  seat: TeamSeat,
  seats: readonly TeamSeat[],
  goal: GoalView | null | undefined,
  nameOf: (seat: TeamSeat) => string = one => one.name,
): string => {
  const identities = [...(goal?.members ?? []), ...(goal?.pastMembers ?? [])]
  const generated = new Map([...seats].sort((a, b) => a.record.openedAt - b.record.openedAt || a.record.id.localeCompare(b.record.id)).flatMap(one => {
    const identity = identities.find(record => record.id === one.record.id)
    return identity?.agent?.name && identity.seatLabel && nameOf(one).startsWith(`${identity.agent.name} · ${identity.seatLabel}`)
      ? [[one.record.id, identity.agent.name] as const] : []
  }))
  const name = generated.get(seat.record.id)
  if (!name) return nameOf(seat)
  // User names and other Agents' base names own their spelling before generated
  // ordinals are assigned. Allocate the whole list in chronological order so
  // caller sorting cannot change a recipient's visible address.
  const used = new Set(seats.filter(one => !generated.has(one.record.id)).map(nameOf))
  const bases = new Set(generated.values())
  const counts = new Map<string, number>()
  for (const base of generated.values()) counts.set(base, (counts.get(base) ?? 0) + 1)
  const next = new Map<string, number>()
  const labels = new Map<string, string>()
  for (const [id, base] of generated) {
    let ordinal = counts.get(base)! > 1 ? next.get(base) ?? 1 : 0
    let label = ordinal ? `${base} ${ordinal}` : base
    while (used.has(label) || (label !== base && bases.has(label))) label = `${base} ${++ordinal}`
    labels.set(id, label)
    used.add(label)
    next.set(base, ordinal + 1)
  }
  return labels.get(seat.record.id)!
}

/**
 * Seats that read the same in one list are told apart by the order they were opened: "Implementer 1",
 * "Implementer 2". A Flow opens a fresh seat for each round, so one Team lists the same job once per round, and
 * a list of identical rows says nothing about which is which. A name that is already unique stays whole.
 */
export const numberRepeatedSeatLabels = (
  seats: readonly { readonly id: string; readonly label: string; readonly openedAt: number }[],
): ReadonlyMap<string, string> => {
  const total = new Map<string, number>()
  for (const { label } of seats) total.set(label, (total.get(label) ?? 0) + 1)
  const seen = new Map<string, number>()
  const result = new Map<string, string>()
  for (const seat of [...seats].sort((a, b) => a.openedAt - b.openedAt || a.id.localeCompare(b.id))) {
    const ordinal = (seen.get(seat.label) ?? 0) + 1
    seen.set(seat.label, ordinal)
    result.set(seat.id, total.get(seat.label)! > 1 ? `${seat.label} ${ordinal}` : seat.label)
  }
  return result
}
