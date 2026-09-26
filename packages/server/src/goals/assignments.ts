import type { Goal, SeatRecord, SessionPointer } from '@harnessdesk/protocol'

/** Shared by assignment, release, seating and wrap. Acquire it once per operation. */
export class Serial {
  #tail: Promise<unknown> = Promise.resolve()

  run<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.#tail.then(fn)
    this.#tail = result.catch(() => {})
    return result
  }
}

export async function dispatchAfter<T>(
  allowed: () => { ok: true } | { ok: false; reason: string },
  prepare: () => Promise<T>,
  dispatch: (ready: T) => Promise<void>,
): Promise<void> {
  const before = allowed()
  if (!before.ok) throw new Error(before.reason)
  const ready = await prepare()
  const after = allowed()
  if (!after.ok) throw new Error(after.reason)
  await dispatch(ready)
}

export interface AssignmentPort {
  goal(id: string): Goal
  seats(): readonly SeatRecord[]
  known(runtime: string, session: string): Promise<{ project: string; busy: boolean } | null>
  claimable(goal: string, card: number, session: SessionPointer): boolean
  /** Why this card is not claimable when its files overlap a live claim: the paths and the card holding them. */
  overlap?(goal: string, card: number, session: SessionPointer): string | null
  commit(goal: string, card: number, session: SessionPointer): Promise<SeatRecord>
  /**
   * Whether this already-live conversation's attachment loading was ever
   * observed — a prior Seat on this exact session whose sidecar this desk
   * actually wrote. A "loose" session assigned straight into a Goal's card
   * never went through the prepare/open/read transaction at all, so its
   * native load set is opaque; adopting it into a Seat would let whatever it
   * happened to load on its own stand in for what this Agent's declarations
   * would have approved. Optional so a caller with nothing to say about
   * attachments (a host not yet wired for phase 12) keeps today's behavior.
   */
  attachmentsObserved?(session: SessionPointer): Promise<boolean>
}

export const UNOBSERVED_LOADING_REFUSAL = 'Start a new Seat to apply this Agent’s attachments.'

export class Assignments {
  constructor(private readonly port: AssignmentPort, private readonly serial = new Serial()) {}

  assign(id: string, card: number, session: SessionPointer): Promise<SeatRecord> {
    return this.serial.run(async () => {
      const goal = this.port.goal(id)
      if (goal.state !== 'open') {
        throw new Error('This Goal is closing or wrapped. Start another Goal for new work.')
      }
      if (!Number.isSafeInteger(card) || card < 1) throw new Error('Choose an existing card.')
      const known = await this.port.known(session.runtime, session.sessionId)
      if (!known || known.project !== goal.root) {
        throw new Error('Choose a conversation from this project that its runtime can still open.')
      }
      if (known.busy) {
        throw new Error('Wait for this conversation to finish its turn before giving it a card.')
      }
      const active = this.port.seats().find((seat) =>
        !seat.closed && !seat.restored && seat.board !== null &&
        seat.session.runtime === session.runtime && seat.session.sessionId === session.sessionId,
      )
      if (active) {
        throw new Error('This conversation already holds a Seat. Release it before assigning it elsewhere.')
      }
      if (!this.port.claimable(id, card, session)) {
        const overlap = this.port.overlap?.(id, card, session) ?? null
        if (overlap) throw new Error(`Refused: ${overlap}`)
        throw new Error('This card cannot be assigned now. Resolve its dependency, role or file conflict first.')
      }
      if (this.port.attachmentsObserved && !(await this.port.attachmentsObserved(session))) {
        throw new Error(UNOBSERVED_LOADING_REFUSAL)
      }
      return this.port.commit(id, card, session)
    })
  }
}
