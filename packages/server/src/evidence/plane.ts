import type { BoardEvidence, EvidenceRecord, Intent, ProjectChecks, TeamState, WireNotification } from '@harnessdesk/protocol'

import type { CredentialCipher } from '../credentials.js'
import type { SeatedAs } from '../registry.js'
import { boardEvidence, RunningChecks } from './board.js'
import { CheckRuns } from './check-runs.js'
import { readChecks } from './checks-file.js'
import type { GhInCheckout } from './forge.js'
import { Observer, type Look } from './observe.js'
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
  /** How a branch's pull request is read; the person's own `gh` when absent. */
  readonly gh?: GhInCheckout
  /** Seals the key the approvals are signed with; the desktop app's is backed by the OS keychain. */
  readonly cipher?: CredentialCipher
  readonly now?: () => number
}

export class EvidencePlane {
  readonly store: EvidenceStore
  readonly seats: SeatBook
  readonly seen: CommandsSeen
  /** Named checks running now, by room and card. */
  readonly running = new RunningChecks()
  /** Runs a project's named checks, once a person has seen them (`check-runs.ts`). */
  readonly checks: CheckRuns
  /** Looks at a card's branch: its diff, its pull request and the forge's checks (`observe.ts`). */
  readonly observer: Observer
  readonly #port: EvidencePort
  readonly #now: () => number
  /** The last stamp a board read took: each is later than the one before, whatever the clock does. */
  #lastStamp = 0

  constructor(options: EvidenceOptions, port: EvidencePort) {
    this.#port = port
    this.#now = options.now ?? Date.now
    this.store = new EvidenceStore(options.dir, (message, details) => port.log(message, details))
    this.seats = new SeatBook(this.store, options.now)
    this.seen = new CommandsSeen(options.seenFile, {
      ...(options.cipher ? { cipher: options.cipher } : {}),
      ...(options.now ? { now: options.now } : {}),
    })
    this.checks = new CheckRuns({
      store: this.store,
      seen: this.seen,
      seats: this.seats,
      running: this.running,
      port: {
        board: (room) => port.board(room),
        cwdOf: (runtime, sessionId) => port.cwdOf(runtime, sessionId),
        changed: (room) => this.announce(room),
        log: (message, details) => port.log(message, details),
      },
      ...(options.now ? { now: options.now } : {}),
    })
    this.observer = new Observer({
      store: this.store,
      ...(options.gh ? { gh: options.gh } : {}),
      ...(options.now ? { now: options.now } : {}),
      log: (message, details) => port.log(message, details),
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

  /**
   * A room's evidence, read now: its project's facts for the room's cards, each
   * against its branch as it stands. Refuses a room the desk does not have.
   */
  async board(room: string): Promise<BoardEvidence> {
    // Taken first, so a read that began later always carries the later stamp.
    const stamp = this.#nextStamp()
    const board = this.#port.board(room)
    if (!board) throw new Error(`There is no room ${room} on this desk.`)
    const project = await projectOf(board.cwd ?? board.root)
    const { lines } = await this.store.read(project, 'evidence')
    const checks = await readChecks(project)
    const records = lines.flatMap((line) => (line.type === 'evidence' ? [line.record] : []))
    this.#lookAround(room, board, project, records)
    // One reason per check the file refuses — its first — and the file's own, when nothing in it can be read.
    const refused = new Map<string, string>()
    for (const problem of checks.problems) {
      if (problem.check !== undefined && !refused.has(problem.check)) refused.set(problem.check, problem.text)
    }
    return boardEvidence({
      room,
      stamp,
      project,
      records,
      checks: checks.checks.map((check) => check.name),
      refused: [...refused].map(([name, why]) => ({ name, why })),
      unreadable: checks.problems.find((problem) => problem.check === undefined)?.text ?? null,
      running: this.running.of(room),
      seatWords: (id) => {
        const seat = this.seats.byId(id)
        return seat ? { agent: seat.agent?.name ?? null, seat: seat.seatLabel } : null
      },
    })
  }

  /** Tells every window a room's evidence moved. Never throws: a fact is kept whether or not a window hears of it. */
  announce(room: string): void {
    void this.board(room).then(
      (evidence) => this.#port.push({ method: 'evidence/changed', params: { room, evidence } }),
      (error: unknown) =>
        this.#port.log("a room's evidence could not be read to tell the windows", {
          room,
          error: error instanceof Error ? error.message : String(error),
        }),
    )
  }

  /** A board read's stamp: now, and always later than the last one. */
  #nextStamp(): number {
    this.#lastStamp = Math.max(this.#now(), this.#lastStamp + 1)
    return this.#lastStamp
  }

  /**
   * A card was finished. While its holder is still on it, the desk looks at
   * the branch it was finished on, and tells every window when that recorded
   * something. Never awaited by the board.
   */
  settled(room: string, intent: Intent): void {
    if (intent.state !== 'done' || !intent.claim) return
    const cwd = this.#port.cwdOf(intent.claim.runtime, intent.claim.sessionId)
    const board = this.#port.board(room)
    if (!cwd || !board) return
    const seat = this.seats.latestKeptOf(intent.claim.runtime, intent.claim.sessionId)?.id ?? null
    void (async () => {
      const look: Look = { room, card: intent.id, project: await projectOf(board.cwd ?? board.root), cwd, seat }
      if (await this.observer.observe(look)) this.announce(room)
    })().catch((error: unknown) =>
      this.#port.log('a finished card could not be looked at', {
        room,
        card: intent.id,
        error: error instanceof Error ? error.message : String(error),
      }),
    )
  }

  /**
   * On a board read, the cards due another look — each at most once every few
   * minutes — are looked at in the background, one at a time: a claimed card in
   * its holder's checkout, a settled one where its latest fact was observed.
   * A card with neither is not looked at, since there is nowhere to look.
   */
  #lookAround(room: string, board: TeamState, project: string, records: readonly EvidenceRecord[]): void {
    const looks: Look[] = []
    for (const intent of board.intents) {
      const holder =
        intent.state === 'claimed' && intent.claim ? this.#port.cwdOf(intent.claim.runtime, intent.claim.sessionId) : null
      // Where this desk last observed it: a fact a backup brought never says where to look.
      const last = [...records]
        .reverse()
        .find((one) => !one.restored && one.card?.board === room && one.card.id === intent.id && one.checkout)
      const cwd = holder ?? last?.checkout?.cwd ?? null
      if (!cwd || !this.observer.take(room, intent.id)) continue
      const seat = holder && intent.claim ? (this.seats.latestKeptOf(intent.claim.runtime, intent.claim.sessionId)?.id ?? null) : null
      looks.push({ room, card: intent.id, project, cwd, seat })
    }
    if (looks.length === 0) return
    void (async () => {
      let recorded = false
      for (const look of looks) {
        try {
          recorded = (await this.observer.observe(look)) || recorded
        } catch (error) {
          this.#port.log('a card could not be looked at', {
            room,
            card: look.card,
            error: error instanceof Error ? error.message : String(error),
          })
        }
      }
      if (recorded) this.announce(room)
    })()
  }

  /**
   * The desk is closing: every check still running is stopped — it leaves no
   * fact, since nothing was observed — and this resolves once every record
   * already asked for is on disk.
   */
  async close(): Promise<void> {
    await this.checks.stop()
    await this.seats.settled()
    // A write that failed was refused to its caller already; the quit says so again, where it is read.
    await this.store.flush().catch((error: unknown) =>
      this.#port.log('some evidence records could not be written before the desk closed', {
        error: error instanceof Error ? error.message : String(error),
      }),
    )
  }
}
