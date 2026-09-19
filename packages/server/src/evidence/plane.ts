import type { ProjectChecks, TeamState, WireNotification } from '@harnessdesk/protocol'

import type { CredentialCipher } from '../credentials.js'
import type { SeatedAs } from '../registry.js'
import { readChecks } from './checks-file.js'
import { projectOf } from './revision.js'
import { SeatBook } from './seats.js'
import { CommandsSeen, incarnationOf } from './seen.js'
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
  /** `commands-seen.json` in the desk's state directory: what a person has approved on this machine. */
  readonly seenFile: string
  /** Seals the key the approvals are signed with; the desktop app's is backed by the OS keychain. */
  readonly cipher?: CredentialCipher
  readonly now?: () => number
}

export class EvidencePlane {
  readonly store: EvidenceStore
  readonly seats: SeatBook
  readonly seen: CommandsSeen
  readonly #port: EvidencePort
  readonly #now: () => number

  constructor(options: EvidenceOptions, port: EvidencePort) {
    this.#port = port
    this.#now = options.now ?? Date.now
    this.store = new EvidenceStore(options.dir, (message, details) => port.log(message, details))
    this.seats = new SeatBook(this.store, options.now)
    this.seen = new CommandsSeen(options.seenFile, {
      ...(options.cipher ? { cipher: options.cipher } : {}),
      ...(options.now ? { now: options.now } : {}),
    })
  }

  /** Reads what a previous launch recorded. Once, at start. */
  async load(): Promise<void> {
    await this.seats.load()
  }

  /**
   * A project's checks, each with whether this machine has approved its
   * command as the file is now: `changed` when it approved another command
   * under that name before the file changed. `folder` may be anywhere in the
   * project; the file is read as committed at the top of its main checkout,
   * and nowhere else. Reading it drops every approval the file no longer
   * holds (`CommandsSeen.reconcile`).
   */
  async projectChecks(folder: string): Promise<ProjectChecks> {
    const project = await projectOf(folder)
    const read = await readChecks(project)
    const checks: ProjectChecks['checks'][number][] = []
    if (read.digest !== null) {
      const scope = { project, incarnation: await incarnationOf(project), digest: read.digest }
      await this.seen.reconcile(
        scope,
        read.checks.map((check) => check.name),
      )
      for (const check of read.checks) {
        const seen = (await this.seen.approved(scope, check))
          ? 'yes'
          : (await this.seen.previous(scope, check.name, check.run)) !== null
            ? 'changed'
            : 'no'
        checks.push({ ...check, seen })
      }
    }
    return {
      project,
      file: read.file,
      exists: read.exists,
      at: read.at,
      uncommitted: read.uncommitted,
      checks,
      problems: read.problems,
    }
  }

  /**
   * The Agent a conversation was seated as, from the latest Seat this desk
   * kept for it, in the shape the registry keeps it — or null when that Seat
   * was no Agent's (a flow's runtime seat), or this desk never seated it.
   * Closed or not: a conversation seated as an Agent is that Agent's for as
   * long as it lasts. A Seat a backup brought never answers this: it is history,
   * and it does not say what a conversation on this desk is.
   *
   * `SeatedAs` speaks today's generation of standing order; a Seat whose order
   * was a `ceiling:` is restored by phase 3, which adds that arm here when it
   * adds Agents that say only `ceiling:`.
   */
  seatedAs(runtime: string, sessionId: string): SeatedAs | null {
    const seat = this.seats.latestKeptOf(runtime, sessionId)
    if (!seat?.agent || seat.briefDigest === null || seat.standing.kind !== 'permission') return null
    return {
      agent: seat.agent.id,
      name: seat.agent.name,
      briefDigest: seat.briefDigest,
      permission: seat.standing.permission,
      seatLabel: seat.seatLabel,
      passedOver: seat.passedOver,
      ceiling: seat.ceiling,
    }
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
