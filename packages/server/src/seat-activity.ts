import { currentTurn, inFlightItem, isBusy, seatDoing, type Approval, type Intent, type SeatActivity, type SeatRecord, type Session } from '@harnessdesk/protocol'

interface RecordView { readonly session: Session; readonly approvals: ReadonlyMap<string, Approval> }
interface Timer { unref(): void }
interface Clock { now(): number; setTimeout(callback: () => void, delay: number): Timer; clearTimeout(handle: Timer): void }
interface Port { record(runtime: string, session: string): RecordView | undefined; send(activity: SeatActivity): void }
const systemClock: Clock = { now: Date.now, setTimeout, clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout) }
const WINDOW_MS = 2_500
const identity = (runtime: string, session: string): string => `${runtime}\u0000${session}`

/** Only held facts enter the snapshot; transcript text stays in its own plane. */
export function deriveSeatActivity(goal: string, seat: SeatRecord, cards: readonly Intent[], record: RecordView | undefined): SeatActivity {
  const card = cards.find((card) => card.state !== 'done' && card.state !== 'abandoned' &&
    card.claim?.runtime === seat.session.runtime && card.claim.sessionId === seat.session.sessionId)
  const approval = [...record?.approvals.values() ?? []].sort((left, right) => left.requestedAt - right.requestedAt)[0]
  const state = approval ? 'waiting' : record && isBusy(record.session) || card?.state === 'claimed' ? 'working' : 'idle'
  const current = record ? currentTurn(record.session) : undefined
  const turn = current?.status === 'inProgress' ? current : undefined
  const item = record && state === 'working' ? inFlightItem(record.session) : undefined
  const since = state === 'waiting' ? approval?.requestedAt : state === 'working' ? turn?.startedAt ?? card?.claim?.at : undefined
  return {
    goal, seat: `${seat.session.runtime}:${seat.session.sessionId}`, role: card?.role ?? seat.role,
    card: card?.id ?? null, state, doing: state === 'working' ? item ? seatDoing(item) : { kind: 'thinking' } : null,
    ...(since == null ? {} : { since }),
  }
}
const same = (left: SeatActivity, right: SeatActivity): boolean => left.state === right.state && left.role === right.role &&
  left.card === right.card && left.doing?.kind === right.doing?.kind &&
  (left.doing?.kind !== 'tool' || right.doing?.kind === 'tool' && left.doing.tool === right.doing.tool && left.doing.target === right.doing.target)
interface Held { sent: SeatActivity; at: number; latest: SeatActivity; timer?: Timer }

/** A leading and trailing throttle per Team/Seat, with a session-local recompute index. */
export class SeatActivities {
  readonly #teams = new Map<string, { seats: readonly SeatRecord[]; cards: readonly Intent[] }>()
  readonly #sessions = new Map<string, Set<string>>()
  readonly #held = new Map<string, Map<string, Held>>()
  #disposed = false
  constructor(readonly port: Port, readonly clock: Clock = systemClock) {}

  team(goal: string, seats: readonly SeatRecord[], cards: readonly Intent[]): void {
    if (this.#disposed) return
    const previous = this.#teams.get(goal)
    for (const seat of previous?.seats ?? []) {
      const id = identity(seat.session.runtime, seat.session.sessionId)
      const goals = this.#sessions.get(id)
      goals?.delete(goal)
      if (goals?.size === 0) this.#sessions.delete(id)
    }
    const retained = new Set(seats.map((seat) => identity(seat.session.runtime, seat.session.sessionId)))
    const held = this.#held.get(goal)
    for (const [id, pending] of held ?? []) if (!retained.has(id)) {
      if (pending.timer) this.clock.clearTimeout(pending.timer)
      held!.delete(id)
    }
    if (!seats.length) { this.#teams.delete(goal); this.#held.delete(goal); return }
    this.#teams.set(goal, { seats, cards })
    for (const seat of seats) {
      const id = identity(seat.session.runtime, seat.session.sessionId)
      const goals = this.#sessions.get(id) ?? new Set<string>()
      goals.add(goal); this.#sessions.set(id, goals)
      this.#recompute(goal, seat, cards)
    }
  }

  session(runtime: string, session: string): void {
    if (this.#disposed) return
    const id = identity(runtime, session)
    for (const goal of this.#sessions.get(id) ?? []) {
      const team = this.#teams.get(goal)!
      for (const seat of team.seats) if (identity(seat.session.runtime, seat.session.sessionId) === id) this.#recompute(goal, seat, team.cards)
    }
  }

  /** A runtime loss settles sessions without an AgentEvent for each one. */
  runtime(runtime: string): void {
    const prefix = `${runtime}\u0000`
    for (const id of this.#sessions.keys()) if (id.startsWith(prefix)) this.session(runtime, id.slice(prefix.length))
  }

  all(): readonly SeatActivity[] {
    return [...this.#teams].flatMap(([goal, team]) => team.seats.map((seat) =>
      deriveSeatActivity(goal, seat, team.cards, this.port.record(seat.session.runtime, seat.session.sessionId))))
  }

  #recompute(goal: string, seat: SeatRecord, cards: readonly Intent[]): void {
    const activity = deriveSeatActivity(goal, seat, cards, this.port.record(seat.session.runtime, seat.session.sessionId))
    const id = identity(seat.session.runtime, seat.session.sessionId)
    const seats = this.#held.get(goal) ?? new Map<string, Held>()
    this.#held.set(goal, seats)
    let pending = seats.get(id)
    if (!pending) {
      seats.set(id, { sent: activity, latest: activity, at: this.clock.now() }); this.port.send(activity); return
    }
    pending.latest = activity
    if (same(pending.sent, activity)) {
      if (pending.timer) { this.clock.clearTimeout(pending.timer); delete pending.timer }
      return
    }
    if (pending.timer) return
    const remaining = WINDOW_MS - (this.clock.now() - pending.at)
    if (remaining <= 0) { pending.sent = activity; pending.at = this.clock.now(); this.port.send(activity); return }
    pending.timer = this.clock.setTimeout(() => {
      delete pending.timer
      pending.sent = pending.latest; pending.at = this.clock.now(); this.port.send(pending.latest)
    }, remaining)
    pending.timer.unref()
  }

  dispose(): void {
    this.#disposed = true
    for (const seats of this.#held.values()) for (const pending of seats.values()) if (pending.timer) this.clock.clearTimeout(pending.timer)
    this.#held.clear(); this.#teams.clear(); this.#sessions.clear()
  }
}
