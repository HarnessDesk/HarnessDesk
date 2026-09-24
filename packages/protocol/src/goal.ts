import type { CeilingLevel, EvidenceRecord, SeatId, SeatRecord, Sha } from './evidence.js'
import type { FlowPermission, FlowSeat } from './flow.js'
import type { Intent, TeamEntry, TeamState } from './team.js'

export type GoalId = string
export type GoalState = 'open' | 'wrapping' | 'wrapped'
export type GoalActivity = 'working' | 'needs-you' | 'ready-to-wrap'

export type GoalOrigin =
  | { kind: 'person' }
  | { kind: 'legacy'; source: string }
  | { kind: 'flow'; run: string }
  | { kind: 'trigger'; trigger: string; event: string }

/** A Seat's name, captured once into a receipt rather than looked up later. */
export interface GoalReceiptMember {
  readonly seat: SeatId
  readonly agent: string | null
  readonly seatLabel: string
}

/**
 * One `GoalReceipt['evidence']` id, and the Seat (if any) that produced it.
 *
 * `seatLabel` is captured directly from that Seat's own record, rather than
 * left to a `members` lookup by `seat`: a restored Seat — history a backup
 * brought, never one this Goal held — can still produce evidence for it, and
 * `GoalReceipt['members']` excludes a restored Seat the same way `seats`
 * does. Without its own copy here, that evidence would have nowhere left to
 * learn a name from once the receipt is read back. Null when the Seat could
 * not be resolved, or the entry predates this field.
 */
export interface GoalReceiptEvidenceSeat {
  readonly id: string
  readonly seat: SeatId | null
  readonly seatLabel?: string | null
}

/** A finishable effort. Its Seats, rather than this document, say who belongs. */
export interface Goal {
  readonly id: GoalId
  readonly root: string
  readonly cwd: string
  readonly sentence: string
  readonly state: GoalState
  readonly revision: number
  readonly checkout: 'shared' | 'isolated'
  readonly dependsOn: readonly GoalId[]
  readonly origin: GoalOrigin
  readonly createdAt: number
  readonly updatedAt: number
  readonly receipt: string | null
}

export interface GoalCitation {
  readonly goal: GoalId
  readonly receipt: string
  readonly project: string
  readonly path: string
  readonly at: Sha
}

export interface GoalReceipt {
  readonly version: 1
  readonly id: string
  readonly goal: GoalId
  readonly sentence: string
  readonly wrappedAt: number
  readonly summary: string
  readonly cards: readonly {
    id: number
    resolution: 'finished' | 'dropped'
    reason: string | null
  }[]
  readonly seats: readonly SeatId[]
  /**
   * Who held each Seat named in `seats` and `answers`, in the receipt's own
   * words — an Agent's name where it had one, and always what it ran. A live
   * lookup cannot stand in for this: `GoalView.members` answers `[]` the
   * moment a Goal wraps, and a receipt is read later, by someone who was
   * never there to look anything up elsewhere. Optional because a receipt
   * wrapped before this field existed has none; a reader falls back to the
   * bare Seat id it always showed.
   */
  readonly members?: readonly GoalReceiptMember[]
  readonly evidence: readonly string[]
  /**
   * Which Seat produced each entry of `evidence`, by id — null when the desk
   * observed it unattended. Optional for the same reason `members` is.
   */
  readonly evidenceSeats?: readonly GoalReceiptEvidenceSeat[]
  readonly answers: readonly {
    seat: SeatId
    session: SeatRecord['session']
    turn: string | null
    text: string
    partial: boolean
    stopReason: string | null
  }[]
  readonly lanes: readonly {
    lane: string
    cwd: string
    dirty: boolean | null
    retained: true
  }[]
  readonly revisions: readonly {
    cwd: string
    head: Sha | null
    dirty: boolean | null
  }[]
  readonly citations: readonly GoalCitation[]
  readonly gaps: readonly string[]
}

/** The mutable board payload contains neither members nor a second Plan API. */
export interface GoalBoard {
  readonly nextIntent: number
  readonly messaging: boolean
  readonly intents: readonly Intent[]
  readonly channel: readonly TeamEntry[]
}

export interface GoalView {
  readonly goal: Goal
  readonly activity: GoalActivity | null
  readonly waitingOn: readonly { id: GoalId; sentence: string }[]
  readonly members: readonly SeatRecord[]
  readonly board: TeamState
  readonly receipt: GoalReceipt | null
  readonly problem: string | null
}

export interface GoalCreateInput {
  root: string
  cwd?: string
  sentence: string
  checkout?: 'shared' | 'isolated'
  dependsOn?: readonly GoalId[]
  origin?: GoalOrigin
}

export type SeatGrant =
  | { kind: 'permission'; permission: FlowPermission }
  | { kind: 'ceiling'; level: CeilingLevel }

export interface GoalSeatRequest {
  goal: GoalId
  agent: string
  seats?: readonly FlowSeat[]
  grant?: SeatGrant
  card?: number
  isolate?: boolean
}

export interface WrapChoices {
  summary: string
  cards: GoalReceipt['cards']
}

export interface WrapPreview {
  stamp: string
  receipt: Omit<GoalReceipt, 'id' | 'wrappedAt'>
}

export const membersOf = (goal: Goal, seats: readonly SeatRecord[]): SeatRecord[] =>
  goal.state === 'wrapped'
    ? []
    : seats.filter((seat) => seat.board === goal.id && seat.closed === null && !seat.restored)

/** Validate the proposed graph without changing the caller's array or any Goal. */
export function checkedDependencies(
  goal: Pick<Goal, 'id' | 'root'>,
  ids: readonly string[],
  all: readonly Goal[],
): string[] {
  if (new Set(ids).size !== ids.length || ids.length > 128) {
    throw new Error('Choose each dependency once, up to 128 Goals.')
  }
  const byId = new Map(all.map((one) => [one.id, one]))
  const visited = new Set<string>()
  const visiting = new Set<string>([goal.id])
  const visit = (id: string): void => {
    if (visiting.has(id)) {
      throw new Error('These Goals would wait on each other. Remove the circular dependency.')
    }
    if (visited.has(id)) return
    const target = byId.get(id)
    if (!target || target.root !== goal.root) {
      throw new Error('Choose an existing Goal in this project.')
    }
    visiting.add(id)
    target.dependsOn.forEach(visit)
    visiting.delete(id)
    visited.add(id)
  }
  ids.forEach(visit)
  return [...ids]
}

/** Evidence placement supplies needsYou and busy; a done note supplies neither. */
export function activityOf(
  goal: Goal,
  input: {
    needsYou: boolean
    busy: boolean
    liveFlow: boolean
    cards: readonly { state: string }[]
    dependencies: readonly Goal[]
  },
): GoalActivity | null {
  if (goal.state === 'wrapped') return null
  if (input.needsYou) return 'needs-you'
  const waiting = goal.dependsOn.some(
    (id) => input.dependencies.find((one) => one.id === id)?.state !== 'wrapped',
  )
  const settled = input.cards.length > 0 && input.cards.every(
    (card) => card.state === 'done' || card.state === 'abandoned',
  )
  return goal.state === 'open' && !input.busy && !input.liveFlow && !waiting && settled
    ? 'ready-to-wrap'
    : 'working'
}

/** Attribution includes closed Seats. It never spreads an unscoped fact across Goals. */
export function factsOfGoal(
  goal: string,
  seats: readonly SeatRecord[],
  facts: readonly EvidenceRecord[],
): EvidenceRecord[] {
  const ids = new Set(seats.filter((seat) => seat.board === goal).map((seat) => seat.id))
  return facts.filter((fact) => fact.card?.board === goal || (fact.seat != null && ids.has(fact.seat)))
}

export interface LanePreferences {
  readonly start: number
  readonly width: number
  readonly browserProfile: boolean
}

export interface Lane {
  readonly id: string
  readonly goal: string
  readonly seat: string | null
  readonly cwd: string
  readonly branch: string
  readonly ports: { readonly start: number; readonly end: number }
  readonly browserProfile: string | null
  readonly state: 'reserved' | 'active' | 'retained' | 'released'
  readonly createdAt: number
}

export const DEFAULT_LANE_PREFERENCES: LanePreferences = { start: 30000, width: 20, browserProfile: true }

export function lanePreferences(value: unknown): LanePreferences {
  const bad = (): never => { throw new Error('Use a starting port from 1024 to 65535 and a width from 1 to 1000 that fits below 65536.') }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return bad()
  const raw = value as Record<string, unknown>
  if (Object.keys(raw).length !== 3 || typeof raw.start !== 'number' || !Number.isSafeInteger(raw.start) ||
      typeof raw.width !== 'number' || !Number.isSafeInteger(raw.width) || raw.start < 1024 || raw.start > 65535 ||
      raw.width < 1 || raw.width > 1000 || raw.start + raw.width - 1 > 65535 || typeof raw.browserProfile !== 'boolean') return bad()
  return { start: raw.start, width: raw.width, browserProfile: raw.browserProfile }
}
