import type { TeamState, WireNotification } from '@harnessdesk/protocol'

import { SeatBook } from './seats.js'
import { EvidenceStore } from './store.js'

/**
 * The evidence plane: the store, the Seats it indexes, and — as later tasks
 * add them — the checks it runs and the facts it observes.
 *
 * Held by the host for the reason the team plane is: the host owns every
 * conversation and every room, so it is the one place a fact can be observed
 * with the seat that produced it and the card it was for. Wire methods reach it
 * as `ctx.evidence`, never around it.
 */

/** What the plane may ask of the host. */
export interface EvidencePort {
  /** A room's board, or null when the desk has no such room. */
  board(room: string): TeamState | null
  /** The folder a conversation works in, when the desk holds it. */
  cwdOf(runtime: string, sessionId: string): string | null
  /** Tells every window. */
  push(notification: WireNotification): void
  log(message: string, details?: Readonly<Record<string, unknown>>): void
}

export interface EvidenceOptions {
  /** `evidence/` in the desk's state directory. */
  readonly dir: string
  readonly now?: () => number
}

export class EvidencePlane {
  readonly store: EvidenceStore
  readonly seats: SeatBook
  readonly #port: EvidencePort
  readonly #now: () => number

  constructor(options: EvidenceOptions, port: EvidencePort) {
    this.#port = port
    this.#now = options.now ?? Date.now
    this.store = new EvidenceStore(options.dir, (message, details) => port.log(message, details))
    this.seats = new SeatBook(this.store, options.now)
  }

  /** Reads what a previous launch recorded. Once, at start. */
  async load(): Promise<void> {
    await this.seats.load()
  }

  /** The desk is closing: this resolves once every record already asked for is on disk. */
  async close(): Promise<void> {
    await this.seats.settled()
    // A write that failed was refused to its caller already; the quit says so again, where it is read.
    await this.store.flush().catch((error: unknown) =>
      this.#port.log('some evidence records could not be written before the desk closed', {
        error: error instanceof Error ? error.message : String(error),
      }),
    )
  }
}
