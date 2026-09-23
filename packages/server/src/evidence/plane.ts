import { isAbsolute, normalize } from 'node:path'

import { factsOfGoal, type BackupFile, type BoardEvidence, type EvidenceRecord, type EvidenceView, type Intent, type ProjectChecks, type TeamState, type WireNotification } from '@harnessdesk/protocol'

import type { ReviewAppendOutcome } from '../flow-evidence.js'
import type { CredentialCipher } from '../credentials.js'
import type { SeatedAs } from '../registry.js'
import { boardEvidence, freshnessReader, RunningChecks } from './board.js'
import { CheckRuns } from './check-runs.js'
import { readChecks } from './checks-file.js'
import type { GhInCheckout } from './forge.js'
import { Observer, type Look } from './observe.js'
import { idOfLine, LINE_LIMIT, lineOf, LINE_VERSION, mintId, type StoreFile, type StoredLine } from './records.js'
import { projectOf, revisionOf } from './revision.js'
import { runCommand, type CommandRun } from './run.js'
import { SeatBook } from './seats.js'
import { CommandsSeen, incarnationOf } from './seen.js'
import { EvidenceMergeError, EvidenceStore, type Admit } from './store.js'

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
  canMutateBoard?(board: string): boolean
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
  readonly #settling = new Map<string, Set<Promise<void>>>()
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
        canMutateBoard: (room) => port.canMutateBoard?.(room) ?? true,
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
    if (!seat?.agent || seat.briefDigest === null) return null
    return {
      agent: seat.agent.id,
      name: seat.agent.name,
      briefDigest: seat.briefDigest,
      standing: seat.standing,
      seatLabel: seat.seatLabel,
      passedOver: seat.passedOver,
      ceiling: seat.ceiling,
      ceilingNote: null,
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

  /** Every fact attributable to a Goal, including Seat-scoped facts without a card. */
  async factIdsOfGoal(goal: string, project: string): Promise<string[]> {
    const { lines } = await this.store.read(project, 'evidence')
    const records = lines.flatMap((line) => line.type === 'evidence' ? [line.record] : [])
    return factsOfGoal(goal, this.seats.all(), records).map((record) => record.id).sort()
  }

  /**
   * Every fact attributable to a Goal, in the order they were appended, each
   * carrying its own freshly computed freshness. Unlike `board()`, this is
   * never folded to one winner per card and kind: a flow's evidence guard
   * reads the whole append-only sequence itself, so a later failure can
   * defeat an earlier pass at the exact revision it names.
   */
  async factsForGoal(goal: string, project: string): Promise<readonly EvidenceView[]> {
    const { lines } = await this.store.read(project, 'evidence')
    const records = lines.flatMap((line) => (line.type === 'evidence' ? [line.record] : []))
    const scoped = factsOfGoal(goal, this.seats.all(), records)
    const freshness = freshnessReader(project)
    const out: EvidenceView[] = []
    for (const record of scoped) {
      const seat = record.seat ? this.seats.byId(record.seat) : null
      out.push({ record, freshness: await freshness(record), by: seat ? { agent: seat.agent?.name ?? null, seat: seat.seatLabel } : null })
    }
    return out
  }

  /**
   * Appends one structured review through the store's own compare-and-swap
   * merge, so two callers racing the same verdict can never both write, and
   * a caller naming a different one for the same question is told so rather
   * than silently dropped or silently overwritten.
   */
  async appendReview(project: string, record: EvidenceRecord): Promise<ReviewAppendOutcome> {
    const fact = record.fact
    if (fact.kind !== 'review') throw new Error('appendReview only appends review facts.')
    const sameQuestion = (candidate: EvidenceRecord): candidate is EvidenceRecord & { fact: typeof fact } =>
      candidate.fact.kind === 'review' &&
      candidate.fact.by === fact.by &&
      candidate.fact.at === fact.at &&
      candidate.card?.id === record.card?.id &&
      candidate.round === record.round
    let outcome: ReviewAppendOutcome = { outcome: 'added', record }
    await this.store.merge(project, 'evidence', [{ type: 'evidence', record }], (line, here, added) => {
      if (line.type !== 'evidence') return 'refused'
      const existing = [...here, ...added].flatMap((one) => (one.type === 'evidence' && sameQuestion(one.record) ? [one.record] : []))
      const matching = existing.find((one) => one.fact.verdict === fact.verdict)
      if (matching) {
        outcome = { outcome: 'duplicate', record: matching }
        return 'duplicate'
      }
      if (existing.length > 0) {
        outcome = { outcome: 'conflict' }
        return 'refused'
      }
      return 'add'
    })
    if (outcome.outcome === 'added' && record.card) this.announce(record.card.board)
    return outcome
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
    const work = (async () => {
      const look: Look = { room, card: intent.id, project: await projectOf(board.cwd ?? board.root), cwd, seat }
      if (await this.observer.observe(look)) this.announce(room)
    })()
    let pending = this.#settling.get(room)
    if (!pending) {
      pending = new Set()
      this.#settling.set(room, pending)
    }
    pending.add(work)
    void work.finally(() => {
      pending!.delete(work)
      if (pending!.size === 0) this.#settling.delete(room)
    }).catch(() => undefined)
    void work.catch((error: unknown) =>
      this.#port.log('a finished card could not be looked at', {
        room,
        card: intent.id,
        error: error instanceof Error ? error.message : String(error),
      }),
    )
  }

  /** Drains evidence work already attached to one board; it never starts a look or check. */
  async settledFor(room: string): Promise<void> {
    await this.seats.settled()
    await Promise.all([...(this.#settling.get(room) ?? [])])
    await this.checks.settledFor(room)
    await this.store.flush()
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
   * A flow's check step, run as the flow engine always runs one — its command
   * was shown verbatim in the flow's dry run and named in its start dialog
   * before anything was seated — and, when it is for a card, recorded as that
   * card's check evidence, bound to the commit it started at, in its round.
   * The flow's runner keeps no output and does not tell a timeout from a
   * command that never started; phase 6 moves flows onto `run.ts`.
   */
  async flowCheck(
    command: string,
    where: {
      readonly cwd: string
      readonly timeoutSec: number
      readonly card?: { readonly room: string; readonly intent: number; readonly name: string; readonly round: number }
    },
    run: (command: string, where: { readonly cwd: string; readonly timeoutSec: number }) => Promise<{ readonly status: number | null }>,
  ): Promise<{ readonly status: number | null }> {
    const card = where.card
    const revision = card ? await revisionOf(where.cwd) : null
    const result = await run(command, { cwd: where.cwd, timeoutSec: where.timeoutSec })
    const board = card ? this.#port.board(card.room) : null
    if (!card || !revision || !board) return result
    const project = await projectOf(board.cwd ?? board.root)
    await this.store
      .append(project, 'evidence', [
        {
          type: 'evidence',
          record: {
            id: mintId(),
            fact: {
              kind: 'check',
              name: card.name,
              run: command,
              exit: result.status,
              timedOut: result.status === null,
              at: revision.head,
              dirty: revision.dirty,
              tail: '',
            },
            card: { board: card.room, id: card.intent },
            checkout: { cwd: where.cwd, branch: revision.branch },
            seat: null,
            round: card.round,
            observedAt: this.#now(),
            posted: null,
          },
        },
      ])
      .then(
        () => this.announce(card.room),
        (error: unknown) =>
          this.#port.log("a flow check's result could not be recorded", {
            room: card.room,
            card: card.intent,
            error: error instanceof Error ? error.message : String(error),
          }),
      )
    return result
  }

  /**
   * The v2 flow check path: runs through the same bounded `runCommand` a
   * person's own check uses, and — unlike the legacy `flowCheck` above —
   * awaits its evidence append before answering, so a card is never marked
   * done on an unsaved fact. One append, never two: the caller consumes
   * `FlowCheckResult` directly rather than the compatibility `{status}` the
   * legacy path still returns.
   */
  async runFlowCheck(
    command: string,
    where: { readonly cwd: string; readonly timeoutSec: number; readonly flowContext?: string; readonly signal?: AbortSignal },
    card: { readonly goal: string; readonly card: number; readonly name: string; readonly round: number },
  ): Promise<{ readonly result: CommandRun; readonly evidence: string | null; readonly problem: string | null }> {
    const revision = await revisionOf(where.cwd)
    const result = await runCommand(command, {
      cwd: where.cwd, timeoutSec: where.timeoutSec,
      ...(where.flowContext !== undefined ? { flowContext: where.flowContext } : {}),
      ...(where.signal ? { signal: where.signal } : {}),
    })
    if (!revision) return { result, evidence: null, problem: null }
    const board = this.#port.board(card.goal)
    if (!board) return { result, evidence: null, problem: null }
    const project = await projectOf(board.cwd ?? board.root)
    const record: EvidenceRecord = {
      id: mintId(),
      fact: { kind: 'check', name: card.name, run: command, exit: result.exit, timedOut: result.timedOut, at: revision.head, dirty: revision.dirty, tail: result.tail },
      card: { board: card.goal, id: card.card },
      checkout: { cwd: where.cwd, branch: revision.branch },
      seat: null,
      round: card.round,
      observedAt: this.#now(),
      posted: null,
    }
    try {
      await this.store.append(project, 'evidence', [{ type: 'evidence', record }])
    } catch (error) {
      this.#port.log("a flow check's result could not be recorded", {
        goal: card.goal, card: card.card, error: error instanceof Error ? error.message : String(error),
      })
      return { result, evidence: null, problem: 'The check finished, but its evidence could not be saved. Fix storage before continuing.' }
    }
    this.announce(card.goal)
    return { result, evidence: record.id, problem: null }
  }

  /**
   * Every project's store, for a backup: each line this build can read, as it
   * is written, and how many it could not — left out, and counted, so an
   * export says it is not whole. Never the commands this machine approved
   * (`seen.ts`), nor its key.
   */
  async backup(): Promise<NonNullable<BackupFile['evidence']>> {
    const out: { project: string; seats: unknown[]; facts: unknown[]; unreadable: number }[] = []
    for (const project of await this.store.projects()) {
      const written = (line: StoredLine): unknown => ({ v: LINE_VERSION, ...line })
      const seats = await this.store.read(project, 'seats')
      const facts = await this.store.read(project, 'evidence')
      out.push({
        project,
        seats: seats.lines.map(written),
        facts: facts.lines.map(written),
        unreadable: seats.skipped + facts.skipped,
      })
    }
    return out
  }

  /**
   * Adds a backup's records to this desk's stores, and counts what became of
   * each. Additive, as every restore is, and **what this desk wrote wins**:
   *
   * - Every line is read by the one rule the store reads with (`lineOf`, where
   *   it is going), and past `RESTORE_PROJECT_LIMIT` projects or
   *   `RESTORE_LINE_LIMIT` lines, or a line over `LINE_LIMIT`, nothing is read.
   * - A record already here, by id, is a duplicate, and left as it is.
   * - A restored record is marked `restored`, and stays history: a restored
   *   fact stands as unknown until the desk observes the question itself, and
   *   never makes a card *Ready*; a restored Seat never says which Agent a
   *   conversation here is (`seatedAs` reads only Seats this desk kept).
   * - A Seat is refused for a conversation this desk already keeps a Seat for.
   * - A closing is admitted only for a Seat opened in the same entry of the
   *   same backup and restored beside it: a backup can never close a Seat this
   *   desk kept.
   *
   * Each file is read, judged and appended as one queued step of the store's
   * (`merge`), so two restores at once cannot both add a record. One line, or
   * one project, that cannot be restored never stops the rest.
   */
  async restore(entries: unknown): Promise<{
    readonly restored: number
    readonly duplicate: number
    readonly refused: number
    readonly failed: number
  }> {
    const count = { restored: 0, duplicate: 0, refused: 0, failed: 0 }
    const at = this.#now()
    let budget = RESTORE_LINE_LIMIT
    const list = Array.isArray(entries) ? entries : []
    for (const [index, entry] of list.entries()) {
      const one = (entry ?? {}) as { project?: unknown; seats?: unknown; facts?: unknown }
      const seats = Array.isArray(one.seats) ? one.seats : []
      const facts = Array.isArray(one.facts) ? one.facts : []
      const project = one.project
      if (
        index >= RESTORE_PROJECT_LIMIT ||
        typeof project !== 'string' ||
        !isAbsolute(project) ||
        normalize(project) !== project ||
        project.length > 4_096
      ) {
        count.refused += seats.length + facts.length
        continue
      }
      // The openings this entry brings: a closing is admitted beside its own opening, and no other.
      const opened = new Set<string>()
      for (const [file, raw] of [['seats', seats], ['evidence', facts]] as const) {
        const lines: StoredLine[] = []
        for (const value of raw) {
          if (budget <= 0) {
            count.refused += 1
            continue
          }
          budget -= 1
          const line = readRestored(value, { file, project })
          if (!line) {
            count.refused += 1
            continue
          }
          if (line.type === 'seat') opened.add(line.record.id)
          lines.push(markRestored(line, at))
        }
        try {
          const merged = await this.store.merge(project, file, lines, admitRestored(opened))
          count.restored += merged.added
          count.duplicate += merged.duplicate
          count.refused += merged.refused
        } catch (error) {
          if (error instanceof EvidenceMergeError) {
            count.restored += error.count.added
            count.duplicate += error.count.duplicate
            count.refused += error.count.refused
            count.failed += error.count.failed
          } else {
            count.failed += lines.length
          }
          this.#port.log("a project's records from a backup could not be restored", {
            project,
            file,
            error: error instanceof Error ? error.message : String(error),
          })
        }
      }
    }
    if (count.refused > 0 || count.failed > 0) this.#port.log('a backup was restored in part', { ...count })
    if (count.restored > 0) await this.seats.load()
    return count
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

/** The most projects, and lines across them, one restore reads; the rest are refused and counted. */
export const RESTORE_PROJECT_LIMIT = 200
export const RESTORE_LINE_LIMIT = 100_000

/** A backup's line, read by the store's own rule for where it is going — and refused whole when it is over the line limit. */
const readRestored = (value: unknown, where: { readonly file: StoreFile; readonly project: string }): StoredLine | null => {
  let size: number
  try {
    size = Buffer.byteLength(JSON.stringify(value) ?? '')
  } catch {
    return null
  }
  return size > LINE_LIMIT ? null : lineOf(value, where)
}

/** A restored line carries when it came, or keeps the mark it came with: it was never observed here. */
const markRestored = (line: StoredLine, at: number): StoredLine => {
  if (line.type === 'seat') return { type: 'seat', record: { ...line.record, restored: line.record.restored ?? { at } } }
  if (line.type === 'evidence') return { type: 'evidence', record: { ...line.record, restored: line.record.restored ?? { at } } }
  return line
}

/** What a backup may add to a file here: nothing already here, no Seat for a conversation this desk seated, no closing but its own. */
const admitRestored =
  (opened: ReadonlySet<string>): Admit =>
  (line, here, added) => {
    const all = [...here, ...added]
    if (all.some((one) => idOfLine(one) === idOfLine(line))) return 'duplicate'
    if (line.type === 'seat') {
      const { runtime, sessionId } = line.record.session
      const kept = here.some(
        (one) =>
          one.type === 'seat' &&
          !one.record.restored &&
          one.record.session.runtime === runtime &&
          one.record.session.sessionId === sessionId,
      )
      return kept ? 'refused' : 'add'
    }
    if (line.type === 'seat-closed') {
      if (!opened.has(line.closing.seat)) return 'refused'
      const opening = all.find((one) => one.type === 'seat' && one.record.id === line.closing.seat)
      return opening?.type === 'seat' && opening.record.restored ? 'add' : 'refused'
    }
    return 'add'
  }
