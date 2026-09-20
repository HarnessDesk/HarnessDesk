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
  commit(goal: string, card: number, session: SessionPointer): Promise<SeatRecord>
}

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
        throw new Error('This card cannot be assigned now. Resolve its dependency, role or file conflict first.')
      }
      return this.port.commit(id, card, session)
    })
  }
}
