import { sessionKey, type FlowSeatRecord, type SeatId, type SeatRecord } from '@harnessdesk/protocol'

import { foldSeats, mintId, type SeatOpening } from './records.js'
import { projectOf, revisionOf } from './revision.js'
import type { EvidenceStore } from './store.js'

/**
 * Every Seat this desk kept, durable, and each conversation's in the order it
 * was seated.
 *
 * The store is the truth and this is its index: read whole at start (`load`),
 * then kept current by the two writes a Seat ever gets — its opening, when the
 * seat is kept, and its closing, when the desk lets it go. Both are awaited, so
 * a Seat the desk answers with is a Seat already on disk.
 *
 * A Seat a backup brought (`restored`) is history. It is indexed and drawn,
 * but a Seat this desk kept always comes first for a conversation, and the
 * desk never closes a restored one: what it says about that conversation was
 * said somewhere else.
 */

/** What the desk knows when it keeps a seat. The checkout, the id and the time are read here. */
export type SeatOpeningInput = Omit<SeatOpening, 'id' | 'checkout' | 'openedAt'> & {
  /** The folder the conversation works in. */
  readonly cwd: string
}

/**
 * What a flow's seat records: a runtime on a seat in a role on a board, and no
 * Agent — a flow seats runtimes until phase 6 gives its roles Agents. Its
 * standing order is the role's `permission:`; `ceiling` is the one value
 * phase 3 changes here.
 */
export const flowSeatInput = (room: string, seat: FlowSeatRecord): SeatOpeningInput => ({
  agent: null,
  briefDigest: null,
  seat: seat.spec,
  seatLabel: seat.seat,
  passedOver: [],
  standing: { kind: 'permission', permission: seat.permission },
  ceiling: null,
  cwd: seat.cwd,
  session: { runtime: seat.runtime, sessionId: seat.sessionId },
  board: room,
  role: seat.role,
})

export class SeatBook {
  readonly #store: EvidenceStore
  readonly #now: () => number
  readonly #byId = new Map<SeatId, SeatRecord>()
  readonly #bySession = new Map<string, SeatId[]>()
  /** The project each Seat's record is kept under, so its closing goes beside its opening. */
  readonly #projects = new Map<SeatId, string>()
  /** Openings still reading git before they write: a quit waits for them too (`settled`). */
  readonly #inFlight = new Set<Promise<unknown>>()

  constructor(store: EvidenceStore, now: () => number = Date.now) {
    this.#store = store
    this.#now = now
  }

  /** Reads every project's Seats, whole: at start, and again after a restore. */
  async load(): Promise<void> {
    this.#byId.clear()
    this.#bySession.clear()
    this.#projects.clear()
    for (const project of await this.#store.projects()) {
      const { lines } = await this.#store.read(project, 'seats')
      for (const seat of foldSeats(lines)) this.#index(seat, project)
    }
  }

  /** Writes a kept seat's record, and answers it once it is on disk. */
  opened(input: SeatOpeningInput): Promise<SeatRecord> {
    const writing = this.#open(input)
    this.#inFlight.add(writing)
    const done = (): void => {
      this.#inFlight.delete(writing)
    }
    writing.then(done, done)
    return writing
  }

  /** Resolves once every opening already asked for has been written, or has failed. */
  async settled(): Promise<void> {
    await Promise.allSettled([...this.#inFlight])
  }

  async #open(input: SeatOpeningInput): Promise<SeatRecord> {
    const { cwd, ...rest } = input
    const project = await projectOf(cwd)
    const revision = await revisionOf(cwd)
    const opening: SeatOpening = {
      ...rest,
      id: mintId(),
      checkout: { cwd, project, branch: revision?.branch ?? null, head: revision?.head ?? null },
      openedAt: this.#now(),
    }
    await this.#store.append(project, 'seats', [{ type: 'seat', record: opening }])
    const record: SeatRecord = { ...opening, closed: null }
    this.#index(record, project)
    return record
  }

  /** Closes this desk's open records for a deleted conversation, once each. */
  async closed(runtime: string, sessionId: string, why: string): Promise<SeatRecord[]> {
    const open = this.of(runtime, sessionId).filter((seat) => seat.closed === null && !seat.restored)
    const out: SeatRecord[] = []
    for (const seat of open) out.push(await this.closeId(seat.id, why))
    return out
  }

  /** A conversation's Seats, oldest first. */
  of(runtime: string, sessionId: string): SeatRecord[] {
    return (this.#bySession.get(sessionKey(runtime, sessionId)) ?? [])
      .flatMap((id) => {
        const seat = this.#byId.get(id)
        return seat ? [seat] : []
      })
      .sort((a, b) => a.openedAt - b.openedAt)
  }

  /**
   * The Seat a conversation holds now: its latest one this desk kept — or,
   * when this desk kept none, the latest a backup brought, as history — or
   * null when it was never seated.
   */
  latestOf(runtime: string, sessionId: string): SeatRecord | null {
    const seats = this.of(runtime, sessionId)
    return seats.filter((seat) => !seat.restored).at(-1) ?? seats.at(-1) ?? null
  }

  /** The latest Seat this desk itself kept for a conversation, or null: only these say which Agent it is. */
  latestKeptOf(runtime: string, sessionId: string): SeatRecord | null {
    return this.of(runtime, sessionId).filter((seat) => !seat.restored).at(-1) ?? null
  }

  byId(id: SeatId): SeatRecord | null {
    return this.#byId.get(id) ?? null
  }

  all(): readonly SeatRecord[] {
    return [...this.#byId.values()]
  }

  async importOpening(project: string, opening: SeatOpening): Promise<SeatRecord> {
    const canonical = (value: unknown): string => {
      if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
      if (value !== null && typeof value === 'object') {
        return `{${Object.entries(value).filter(([, field]) => field !== undefined)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, field]) => `${JSON.stringify(key)}:${canonical(field)}`).join(',')}}`
      }
      return JSON.stringify(value) ?? 'null'
    }
    await this.#store.merge(project, 'seats', [{ type: 'seat', record: opening }], (line, here, added) => {
      const previous = [...here, ...added].find((one) => one.type === 'seat' && one.record.id === opening.id)
      if (!previous) return 'add'
      if (previous.type !== 'seat' || line.type !== 'seat' || canonical(previous.record) !== canonical(line.record)) {
        throw new Error('A different Seat already has this id. The existing evidence was kept.')
      }
      return 'duplicate'
    })
    const { lines } = await this.#store.read(project, 'seats')
    const record = foldSeats(lines).find((one) => one.id === opening.id)
    if (!record) throw new Error('The imported Seat could not be read back. Repair the evidence store and retry.')
    this.#index(record, project)
    this.#byId.set(record.id, record)
    return record
  }

  async closeId(id: SeatId, why: string): Promise<SeatRecord> {
    const seat = this.#byId.get(id)
    if (!seat) throw new Error('That Seat is not recorded on this desk.')
    if (seat.restored) throw new Error('A restored Seat is history and cannot be closed here.')
    const project = this.#projects.get(id) ?? seat.checkout.project
    await this.#store.merge(project, 'seats', [
      { type: 'seat-closed', closing: { seat: id, at: this.#now(), why } },
    ], (_line, here, added) =>
      [...here, ...added].some((line) => line.type === 'seat-closed' && line.closing.seat === id)
        ? 'duplicate'
        : 'add',
    )
    const { lines } = await this.#store.read(project, 'seats')
    const closed = foldSeats(lines).find((record) => record.id === id)
    if (!closed) throw new Error('The Seat closing could not be read back. Retry after fixing the evidence store.')
    this.#byId.set(id, closed)
    return closed
  }

  #index(seat: SeatRecord, project: string): void {
    if (this.#byId.has(seat.id)) return
    this.#byId.set(seat.id, seat)
    this.#projects.set(seat.id, project)
    const key = sessionKey(seat.session.runtime, seat.session.sessionId)
    this.#bySession.set(key, [...(this.#bySession.get(key) ?? []), seat.id])
  }
}
