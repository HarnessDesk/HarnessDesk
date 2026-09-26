import { createHash, randomUUID } from 'node:crypto'

import type {
  CarryFindingsInput,
  DecideFindingInput,
  EvidenceRecord,
  EvidenceView,
  FindingDecisionAction,
  FindingDetailPage,
  FindingId,
  FindingOverride,
  FindingPage,
  FindingPost,
  FindingPublicationsView,
  FindingPublishAction,
  FindingRecord,
  FindingRunState,
  FindingRunView,
  FindingSeries,
  RepairPacket,
  FlowExecution,
  FlowRoundState,
  FindingAnchor,
  FindingCategory,
  FindingReadInput,
  FindingReceipt,
  FindingView,
  RaiseFindingInput,
  RepairFindingInput,
  ReviewCandidate,
  SeatRecord,
} from '@harnessdesk/protocol'

import {
  evidenceRecordOf, FINDING_TEXT_LIMIT, FINDING_TITLE_LIMIT, isRelativePath, isSha, mintId, type StoredLine,
} from '../evidence/records.js'
import type { StoreRead } from '../evidence/store.js'
import type { FindingsGate, FlowSubject } from '../flow-evidence.js'
import type { FindingRunSnapshot, ReviewPacketPin, RunDecisionOps } from '../flow-execution.js'
import type { GoalDocument } from '../goals/store.js'
import type { TeamCallScope } from '../team.js'
import type { FindingJournal, FindingJournalEntry } from './journal.js'
import { canonical, foldFindings, isResolved, liveBlockers } from './model.js'
import { repairPacket } from './packet.js'
import { boundPullRequest } from './publication.js'
import type { Publications } from './publication.js'
import { admittedOf, advanceProgress, closeSeries, decideLoop, pendingOf, progressKeys, rejectedRepairs } from './rounds.js'

/**
 * The findings plane: the one writer of the findings ledger.
 *
 * Every finding event — a Seat's raise, repair claim or verdict, a person's
 * carry — is appended here and nowhere else, one project at a time. The
 * order a command takes its queues is the desk's one lock order ("Lock
 * order" in host.ts): the flow run's own queue (whose journal records the
 * command before it takes effect), then this plane's project queue, never
 * the other way round, and nothing holding the project queue ever asks for a
 * run or a Goal. A carry takes the Goal queue, then the project queue. So no
 * two writers ever read-modify-write one finding.
 *
 * Every command reads the ledger inside the project queue, validates the
 * caller's live authority against what it read — the Seat the calling
 * conversation is, the card it holds, the candidate it was offered — and
 * answers only after the record is synced. Nothing a request says names a
 * Seat, an Agent, an origin, a revision or a permission; a request that
 * tries is refused before anything is written.
 */

// ------------------------------------------------------------------ appending

/** What one append in an already-held queue needs. */
export interface AppendPort<T> {
  read(): Promise<readonly T[]>
  key(record: T): string
  equal(left: T, right: T): boolean
  validate(records: readonly T[], next: T): void
  append(record: T): Promise<void>
}

/**
 * Appends `next` once: a record already there under its key is returned as
 * it is when it means the same, and refused when it does not. The caller
 * holds the queue; this takes none.
 */
export async function appendOnce<T>(port: AppendPort<T>, next: T): Promise<T> {
  const records = await port.read()
  const previous = records.find(record => port.key(record) === port.key(next))
  if (previous) {
    if (!port.equal(previous, next)) throw new Error('This operation was already used for different content.')
    return previous
  }
  port.validate(records, next)
  await port.append(next)
  return next
}

// ----------------------------------------------------------------------- port

/** The flow engine's side of a finding command. */
export interface FindingFlows {
  /** The card a caller holds on a Goal, as its run bound it; null for a card no run bound to this caller. */
  binding(goal: string, card: number, caller: { readonly runtime: string; readonly sessionId: string }): {
    readonly run: string
    readonly round: number
    readonly role: string
    readonly seat: string
    readonly reviews: boolean
    readonly writer: boolean
    readonly held: boolean
  } | null
  /** A candidate this process minted for this caller's card, still current; null otherwise. */
  candidate(id: string, card: number, scope: TeamCallScope): Promise<{
    readonly candidate: ReviewCandidate
    readonly checkout: { readonly cwd: string; readonly branch: string | null }
    readonly goal: string
    readonly round: number
    readonly seat: string
  } | null>
  /** Runs `step` inside `run`'s own queue with its finding journal. */
  journal<T>(run: string, step: (journal: FindingJournal) => Promise<T>): Promise<T>
  /** Runs with finding commands a restart has to settle. */
  pending(): readonly { readonly run: string; readonly entries: readonly FindingJournalEntry[] }[]
  /** A run as its round closes: its rounds, which review, each review Seat's slot and its findings bookkeeping. */
  run?(run: string): FindingRunSnapshot | null
  /** A round's subjects, read now: the revisions its reviewers judged. */
  subjects?(goal: string, round: FlowRoundState): Promise<readonly FlowSubject[]>
  /**
   * Records a closed round's bookkeeping and lets the run go on. Idempotent
   * on the round. `close` is applied inside the run's queue to its current
   * bookkeeping; only the fields a close owns are taken from what it answers.
   */
  recordClose?(run: string, round: number, close: ((current: FindingRunState) => FindingRunState) | null): Promise<void>
  /**
   * Every open review round with several reviewers, blind or sighted: none of
   * them posts until it closes. Absent, the blind rounds stand in for it.
   */
  embargoedRounds?(goal: string): readonly {
    readonly run: string
    readonly round: number
    readonly holders: readonly { readonly card: number; readonly runtime: string; readonly sessionId: string }[]
  }[]
  /** Open blind review rounds on a Goal: their cards, and who holds each. A sighted round (`blind: false`) is not one. */
  blindRounds?(goal: string): readonly {
    readonly run: string
    readonly round: number
    readonly cards?: readonly number[]
    readonly holders: readonly { readonly card: number; readonly runtime: string; readonly sessionId: string }[]
  }[]
  /** A Goal's facts in append order, each with its freshness now. */
  facts?(goal: string): Promise<readonly EvidenceView[]>
  /** Every review series this Goal has had, across every run: what "currently blocking" reads against. */
  seriesOfGoal?(goal: string): readonly FindingSeries[]
  /** Every person override this Goal has recorded, across every run: what a wrap freezes into its receipt. */
  overridesOfGoal?(goal: string): readonly FindingOverride[]
  /** A person's "Another round": one further transition past a recorded stop. */
  authorizeExtraRound?(run: string, round: number, reason: string): Promise<FlowExecution>
  /** A person admitting or declining a pending regression or security exception. */
  recordExceptionDecision?(run: string, findings: readonly FindingId[], admit: boolean): Promise<FlowExecution>
  /** A person's recorded merge-anyway disagreement. */
  recordOverride?(run: string, override: FindingOverride): Promise<FlowExecution>
  /** A person's Stop, handed off to the existing run-stop action; never a Goal wrap. */
  stopRun?(run: string, reason: string): Promise<FlowExecution>
  /** The last `finding/decide` this run actually applied: what makes a resubmitted stamp replay rather than refuse. */
  recordDecisionStamp?(run: string, stamp: string, key: string): Promise<FlowExecution>
  /**
   * One person decision, whole, inside the run's own queue: the stamp check
   * and the action are one step there. `step` uses only the actions it is
   * handed, never the queued ones above, and asks for no run queue itself.
   */
  decide?<T>(run: string, step: (ops: RunDecisionOps) => Promise<T>): Promise<T>
}

/** The Goal plane's side of a carry: its own transaction, which asks this plane for the records under its queue. */
export interface FindingGoals {
  carry(
    input: CarryFindingsInput,
    prepare: (target: GoalDocument, source: GoalDocument) => Promise<readonly EvidenceRecord[]>,
  ): Promise<void>
}

export interface FindingsPort {
  /** The one evidence store: read in append order, appended once synced. */
  readonly store: {
    read(project: string, file: 'evidence'): Promise<StoreRead>
    append(project: string, file: 'evidence', lines: readonly StoredLine[]): Promise<void>
  }
  readonly seats: {
    byId(id: string): SeatRecord | null
    latestKeptOf(runtime: string, sessionId: string): SeatRecord | null
  }
  readonly flows: FindingFlows
  readonly goals?: FindingGoals
  /** Why a Goal takes no person decision now — wrapped, closing, from a backup, or gone — or null while it is open. A snapshot read. */
  goalClosed?(goal: string): string | null
  /** The project a Goal's facts are kept under. */
  projectOf(goal: string): Promise<string>
  /** A checkout's committed head now, and whether it holds uncommitted changes. */
  headOf(cwd: string): Promise<{ readonly at: string | null; readonly dirty: boolean }>
  now(): number
  /** How a later review's delta is read; the real repository reader unless a test supplies its own. */
  readonly repairPacket?: typeof repairPacket
  /** Findings on this Goal moved: tell whoever draws them. Never awaited. */
  changed?(goal: string): void
  log(message: string, details?: Readonly<Record<string, unknown>>): void
}

// ----------------------------------------------------------------- the inputs

/** The most rows one card may read at once; more stops for a person rather than truncating blockers. */
export const READ_LIMIT = 200
const REQUEST_LIMIT = 200

const NOT_TAKEN = 'is not something a finding takes: the desk works out who you are, which card and which revision'

const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** Only these keys, each once: a key the request may not carry — a Seat, a revision, an authority — refuses it whole. */
const onlyKeys = (value: Record<string, unknown>, allowed: readonly string[]): void => {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw new Error(`"${key}" ${NOT_TAKEN}.`)
  }
}
const card = (value: unknown): number => {
  if (!Number.isSafeInteger(value) || (value as number) < 1) throw new Error('Name the card you hold by its number.')
  return value as number
}
const request = (value: unknown): string => {
  if (typeof value !== 'string' || value.trim() === '' || value.length > REQUEST_LIMIT || /[\u0000-\u001f]/.test(value)) {
    throw new Error(`Give this request a token of 1 to ${REQUEST_LIMIT} printable characters, and reuse it only to retry the same request.`)
  }
  return value
}
const text = (value: unknown, what: string, limit: number, filled = false): string => {
  if (typeof value !== 'string' || value.length > limit || (filled && value.trim() === '')) {
    throw new Error(`Write ${what} in ${filled ? 1 : 0} to ${limit} characters.`)
  }
  return value
}
const findingId = (value: unknown): string => {
  if (typeof value !== 'string' || !/^finding-[0-9a-f-]{1,190}$/.test(value)) throw new Error('Name a finding by the id the ledger gave it.')
  return value
}
const expected = (value: unknown): number => {
  if (!Number.isSafeInteger(value) || (value as number) < 1) throw new Error('Say which sequence of this finding you last read.')
  return value as number
}
const CATEGORIES: readonly FindingCategory[] = ['ordinary', 'regression', 'security']
const anchorOf = (value: unknown): FindingAnchor => {
  if (!object(value)) throw new Error('An anchor is a path, a line and a side.')
  onlyKeys(value, ['path', 'line', 'side'])
  if (!isRelativePath(value['path']) || !Number.isSafeInteger(value['line']) || (value['line'] as number) < 1 ||
    (value['side'] !== 'LEFT' && value['side'] !== 'RIGHT')) {
    throw new Error('An anchor names a changed file by its path inside the project, a line from 1, and LEFT or RIGHT.')
  }
  return { path: value['path'] as string, line: value['line'] as number, side: value['side'] }
}

export const raiseInputOf = (value: unknown): RaiseFindingInput => {
  if (!object(value)) throw new Error('A finding is an object.')
  onlyKeys(value, ['intent', 'candidate', 'request', 'title', 'body', 'category', 'blocking', 'related', 'anchor'])
  if (typeof value['candidate'] !== 'string' || value['candidate'] === '') throw new Error('Name the candidate review_candidates offered you.')
  if (!CATEGORIES.includes(value['category'] as FindingCategory)) throw new Error('A finding is ordinary, a regression, or security.')
  if (typeof value['blocking'] !== 'boolean') throw new Error('Say whether this finding blocks.')
  return {
    intent: card(value['intent']),
    candidate: value['candidate'],
    request: request(value['request']),
    title: text(value['title'], 'a title', FINDING_TITLE_LIMIT, true),
    body: text(value['body'], 'what you found', FINDING_TEXT_LIMIT),
    category: value['category'] as FindingCategory,
    blocking: value['blocking'],
    ...(value['related'] !== undefined ? { related: findingId(value['related']) } : {}),
    ...(value['anchor'] !== undefined ? { anchor: anchorOf(value['anchor']) } : {}),
  }
}

export const repairInputOf = (value: unknown): RepairFindingInput => {
  if (!object(value)) throw new Error('A repair claim is an object.')
  onlyKeys(value, ['intent', 'finding', 'request', 'expected', 'note'])
  return {
    intent: card(value['intent']), finding: findingId(value['finding']), request: request(value['request']),
    expected: expected(value['expected']), note: text(value['note'], 'what you changed', FINDING_TEXT_LIMIT),
  }
}

export const decideInputOf = (value: unknown): DecideFindingInput => {
  if (!object(value)) throw new Error('A verdict is an object.')
  onlyKeys(value, ['intent', 'candidate', 'finding', 'request', 'expected', 'state', 'note'])
  if (typeof value['candidate'] !== 'string' || value['candidate'] === '') throw new Error('Name the candidate review_candidates offered you.')
  if (!['open', 'repaired', 'withdrawn'].includes(value['state'] as string)) throw new Error('A verdict is open, repaired or withdrawn.')
  const state = value['state'] as DecideFindingInput['state']
  return {
    intent: card(value['intent']), candidate: value['candidate'], finding: findingId(value['finding']),
    request: request(value['request']), expected: expected(value['expected']), state,
    note: text(value['note'], state === 'withdrawn' ? 'why it is withdrawn' : 'your verdict', FINDING_TEXT_LIMIT, state === 'withdrawn'),
  }
}

export const readInputOf = (value: unknown): FindingReadInput => {
  if (!object(value)) throw new Error('A read is an object.')
  onlyKeys(value, ['intent', 'filter'])
  const filter = value['filter']
  if (filter !== undefined && !['all', 'open', 'blocking'].includes(filter as string)) throw new Error('Read all, open or blocking findings.')
  return { intent: card(value['intent']), ...(filter !== undefined ? { filter: filter as 'all' | 'open' | 'blocking' } : {}) }
}

export const carryInputOf = (value: unknown): CarryFindingsInput => {
  if (!object(value)) throw new Error('A carry is an object.')
  onlyKeys(value, ['goal', 'revision', 'source', 'receipt', 'findings', 'request'])
  const findings = value['findings']
  if (!Array.isArray(findings) || findings.length < 1 || findings.length > 200 || new Set(findings).size !== findings.length) {
    throw new Error('Carry 1 to 200 different findings.')
  }
  for (const key of ['goal', 'source', 'receipt'] as const) {
    if (typeof value[key] !== 'string' || value[key] === '') throw new Error('Name the Goal, the wrapped Goal and its receipt.')
  }
  if (!Number.isSafeInteger(value['revision']) || (value['revision'] as number) < 0) throw new Error('Say which revision of the Goal you saw.')
  return {
    goal: value['goal'] as string, revision: value['revision'] as number, source: value['source'] as string,
    receipt: value['receipt'] as string, findings: findings.map(findingId), request: request(value['request']),
  }
}

// ------------------------------------------------------------------ the plane

/** The operation key: a command kind, the Seat or person asking, the card, and the caller's own request token. */
export const operationKey = (kind: string, actor: string, card: number | string, token: string): string =>
  `op-${createHash('sha256').update([kind, actor, String(card), token].join('\u0000')).digest('hex').slice(0, 48)}`

/**
 * What a record means, as a command's meaning is compared: the event's own
 * words, never its minted ids, times or the revision a candidate named. The
 * same request token asking for the same meaning is the same event.
 */
export const meaningOf = (record: EvidenceRecord): string => {
  const event = record.finding?.event
  if (!event || record.fact.kind !== 'finding') return canonical(record)
  switch (event.kind) {
    case 'raise':
      return canonical({ kind: 'raise', title: event.title, body: event.body, category: event.category, blocking: event.blocking, related: event.related, anchor: event.anchor })
    case 'repair':
      return canonical({ kind: 'repair', finding: record.fact.id, note: event.note })
    case 'verdict':
      return canonical({ kind: 'verdict', finding: record.fact.id, state: event.state, note: event.note, by: event.by })
    default:
      return canonical({ fact: record.fact, card: record.card ?? null, checkout: record.checkout ?? null, seat: record.seat ?? null, finding: record.finding })
  }
}
const hashOf = (meaning: string): string => createHash('sha256').update(meaning).digest('hex')

interface Ledger {
  readonly records: readonly EvidenceRecord[]
  readonly views: readonly FindingView[]
  /** Lines this build could not read: a ledger with any is never read as holding nothing. */
  readonly unreadable: number
}

const NOT_SEATED = 'This conversation holds no Seat on a Goal, so it cannot record findings.'

interface Caller {
  readonly seat: SeatRecord
  readonly runtime: string
  readonly sessionId: string
  readonly goal: string
}
const IN_ROUND = 'This finding is being decided in a review round that is still open. Record this once that round closes.'
const STALE = (now: number) => `This finding changed since you read it; it is at sequence ${now}. Read it again before recording this.`

/** The most rows or event records a person's page reads at once. */
export const READ_PAGE_LIMIT = 100
/** A list snapshot is read fresh again after this long, even with no new evidence. */
const SNAPSHOT_TTL_MS = 5 * 60 * 1000
/** How many list snapshots this desk keeps waiting for their next page at once. */
const MAX_SNAPSHOTS = 32
const SNAPSHOT_STALE = 'The findings changed. Reload the list.'

interface ListSnapshot {
  readonly goal: string
  readonly filter: 'all' | 'open' | 'blocking'
  readonly rows: readonly FindingView[]
  readonly totals: { readonly all: number; readonly open: number; readonly blocking: number } | null
  readonly problem: string | null
  readonly at: number
}

export class FindingsPlane {
  readonly #port: FindingsPort
  readonly #tails = new Map<string, Promise<unknown>>()
  /** The closed-round publisher, once the host composed one; absent, every round stays on the desk. */
  #publisher: Publications | null = null
  /** `finding/list`'s read snapshots, oldest-inserted first, bounded and goal-invalidated. */
  readonly #snapshots = new Map<string, ListSnapshot>()

  constructor(port: FindingsPort) {
    this.#port = port
  }

  /** Attaches the publisher a closed round's batch is released to. Set once. */
  attachPublisher(publisher: Publications | null): void {
    this.#publisher = publisher
  }

  /** The project's finding records and views, read under its queue: what the publisher plans and checks against. */
  async ledgerOf(project: string): Promise<{ readonly records: readonly EvidenceRecord[]; readonly views: readonly FindingView[]; readonly unreadable: number }> {
    return this.#serial(project, () => this.#ledger(project))
  }

  /** One queue per canonical project. Nothing running inside it ever asks for a run or a Goal. */
  #serial<T>(project: string, work: () => Promise<T>): Promise<T> {
    const result = (this.#tails.get(project) ?? Promise.resolve()).then(work)
    const tail = result.then(() => undefined, () => undefined)
    this.#tails.set(project, tail)
    void tail.then(() => { if (this.#tails.get(project) === tail) this.#tails.delete(project) })
    return result
  }

  async #ledger(project: string): Promise<Ledger> {
    const read = await this.#port.store.read(project, 'evidence')
    const records = read.lines.flatMap((line) => (line.type === 'evidence' && line.record.fact.kind === 'finding' ? [line.record] : []))
    return { records, views: foldFindings(records), unreadable: read.skipped }
  }

  #appender(project: string): AppendPort<EvidenceRecord> {
    return {
      read: async () => (await this.#ledger(project)).records,
      key: (record) => record.finding?.operation ?? record.id,
      equal: (left, right) => meaningOf(left) === meaningOf(right),
      validate: (records, next) => {
        if (next.fact.kind !== 'finding' || !next.finding) throw new Error('Only a finding event is appended here.')
        // What the reader would skip is never written.
        if (evidenceRecordOf(JSON.parse(JSON.stringify(next))) === null) throw new Error('This finding could not be recorded in a form the ledger reads.')
        const id = next.fact.id
        const before = foldFindings(records).find((one) => one.id === id)
        if (next.finding.event.kind === 'raise') {
          if (before) throw new Error('This finding already exists.')
        } else if (!before || before.sequence + 1 !== next.finding.sequence) {
          throw new Error(STALE(before?.sequence ?? 0))
        }
        const after = foldFindings([...records, next]).find((one) => one.id === id)
        if (!after || after.problem !== null) throw new Error(after?.problem ?? 'This finding could not be recorded.')
      },
      append: (record) => this.#port.store.append(project, 'evidence', [{ type: 'evidence', record }]),
    }
  }

  /** The caller's own kept Seat, open, on a Goal: resolved from the calling conversation, never named. */
  #caller(scope: TeamCallScope): Caller {
    if (!scope.runtime || !scope.sessionId) throw new Error(NOT_SEATED)
    const seat = this.#port.seats.latestKeptOf(scope.runtime, scope.sessionId)
    if (!seat || seat.closed || seat.restored || !seat.board) throw new Error(NOT_SEATED)
    return { seat, runtime: scope.runtime, sessionId: scope.sessionId, goal: seat.board }
  }

  #bound(caller: Caller, intent: number): NonNullable<ReturnType<FindingFlows['binding']>> {
    const bound = this.#port.flows.binding(caller.goal, intent, caller)
    if (!bound || bound.seat !== String(caller.seat.id) || !bound.held) {
      throw new Error(`You do not hold card #${intent}, so no finding can be recorded against it.`)
    }
    return bound
  }

  /**
   * One Seat command, end to end: inside its run's queue and then its
   * project's, the ledger read now, the request compared with any earlier one
   * under the same key, the caller's live authority checked by `prepare`, the
   * record journaled, appended and synced, and only then the answer.
   */
  async #command(input: {
    readonly run: string
    readonly goal: string
    readonly caller: Caller
    readonly operation: string
    readonly kind: FindingJournalEntry['kind']
    readonly meaning: string
    /** Handed the ledger as the caller may read it (`#unblinded`): every check it makes answers the same whatever an open blind round holds. */
    readonly prepare: (ledger: Ledger, journaled: EvidenceRecord | null) => Promise<EvidenceRecord>
  }): Promise<FindingView> {
    const project = await this.#port.projectOf(input.goal)
    const hash = hashOf(input.meaning)
    const view = await this.#port.flows.journal(input.run, (journal) => this.#serial(project, async () => {
      const entry = journal.entry(input.operation)
      if (entry && entry.hash !== hash) throw new Error('This request was already used for different content. Use a new request token for a new claim.')
      const ledger = await this.#ledger(project)
      // What the caller may read: every answer below is folded from this, never from what an open blind round holds.
      const seen = this.#unblinded(ledger, input.goal, input.caller)
      const durable = ledger.records.find((record) => record.finding?.operation === input.operation)
      if (durable) {
        // The same request, already on the disk: the same event, whatever has happened since.
        if (hashOf(meaningOf(durable)) !== hash) throw new Error('This request was already used for different content. Use a new request token for a new claim.')
        if (entry && entry.state !== 'finished') await journal.put({ ...entry, state: 'finished', reason: null })
        return this.#viewOf(seen.records, durable)
      }
      const record = await input.prepare(seen, entry?.record ?? null)
      if (hashOf(meaningOf(record)) !== hash) throw new Error('This request could not be recorded as it was asked.')
      /* A finding with events the caller may not read yet — recorded in an
         open blind round by another holder — takes nothing from the caller
         until that round closes; said the same way whatever those events
         were, and never with the sequence they reached. */
      if (record.finding?.event.kind !== 'raise' && record.fact.kind === 'finding') {
        const id = record.fact.id
        const full = ledger.views.find((one) => one.id === id)
        const mine = seen.views.find((one) => one.id === id)
        if (full && mine && full.sequence !== mine.sequence) throw new Error(IN_ROUND)
      }
      if (!entry || entry.state !== 'prepared') {
        await journal.put({ operation: input.operation, kind: input.kind, hash, record, state: 'prepared', reason: null })
      }
      let appended: EvidenceRecord
      try {
        appended = await appendOnce(this.#appender(project), record)
      } catch (error) {
        // Refused visibly, and only this command's own step is rolled back: its journal entry says so.
        await journal.put({ operation: input.operation, kind: input.kind, hash, record, state: 'abandoned', reason: error instanceof Error ? error.message : String(error) })
          .catch((stuck: unknown) => this.#port.log('a refused finding command could not be marked in its journal', {
            run: input.run, error: stuck instanceof Error ? stuck.message : String(stuck),
          }))
        throw error
      }
      await journal.put({ operation: input.operation, kind: input.kind, hash, record: appended, state: 'finished', reason: null })
      return this.#viewOf([...seen.records, appended], appended)
    }))
    this.#invalidateList(input.goal)
    this.#port.changed?.(input.goal)
    return view
  }

  #viewOf(records: readonly EvidenceRecord[], record: EvidenceRecord): FindingView {
    const id = record.fact.kind === 'finding' ? record.fact.id : ''
    const view = foldFindings(records).find((one) => one.id === id)
    if (!view) throw new Error('This finding could not be read back.')
    return view
  }

  /** The live, owned, readable finding a repair or verdict is about; refused with the reason otherwise. */
  #owned(ledger: Ledger, finding: string, goal: string): FindingView {
    const view = ledger.views.find((one) => one.id === finding)
    if (!view || view.ownerGoal !== goal) throw new Error('There is no such finding on this Goal.')
    if (view.restored) throw new Error('This finding came from a backup. It is history here; ask for a new review instead.')
    if (view.problem !== null) throw new Error(`This finding cannot be changed until its history is repaired: ${view.problem}`)
    if (view.lifecycle.confirmed) throw new Error('This finding is resolved. Record a new linked finding.')
    return view
  }

  /** A later review judges exactly the revisions its packet was pinned to: a subject that moved since is not what it was handed. */
  #pinned(run: string, round: number, at: string): void {
    const pinned = this.#port.flows.run?.(run)?.pinned[String(round)]
    if (pinned && !pinned.some((one) => one.at === at)) {
      throw new Error('The subject moved since this review was handed its packet. A person has to reopen the review.')
    }
  }

  #reuse(journaled: EvidenceRecord | null, record: EvidenceRecord): EvidenceRecord {
    if (!journaled) return record
    // A retry keeps what was minted, and only what was minted.
    return { ...record, id: journaled.id, observedAt: journaled.observedAt, fact: { ...record.fact, ...(journaled.fact.kind === 'finding' && record.fact.kind === 'finding' ? { id: journaled.fact.id } : {}) } as EvidenceRecord['fact'] }
  }

  async raise(value: unknown, scope: TeamCallScope): Promise<FindingView> {
    const input = raiseInputOf(value)
    const caller = this.#caller(scope)
    const bound = this.#bound(caller, input.intent)
    if (!bound.reviews) throw new Error(`Card #${input.intent} is not a review card. Findings are raised from a review.`)
    const operation = operationKey('raise', String(caller.seat.id), input.intent, input.request)
    const meaning = canonical({
      kind: 'raise', title: input.title, body: input.body, category: input.category, blocking: input.blocking,
      related: input.related ?? null, anchor: input.anchor ?? null,
    })
    return this.#command({
      run: bound.run, goal: caller.goal, caller, operation, kind: 'raise', meaning,
      prepare: async (ledger, journaled) => {
        const held = await this.#port.flows.candidate(input.candidate, input.intent, scope)
        if (!held || held.goal !== caller.goal || held.seat !== String(caller.seat.id)) {
          throw new Error('That candidate is no longer being offered. Ask for review candidates again.')
        }
        if (!isSha(held.candidate.at)) throw new Error('That candidate has no committed revision to raise a finding against.')
        this.#pinned(bound.run, bound.round, held.candidate.at)
        if (input.related !== undefined && !ledger.views.some((one) => one.id === input.related && one.ownerGoal === caller.goal)) {
          throw new Error('The related finding is not one on this Goal.')
        }
        if (journaled && journaled.fact.kind === 'finding' && journaled.fact.at !== held.candidate.at) {
          throw new Error('The candidate moved since this was first asked. Raise it again with a new request token.')
        }
        const at = held.candidate.at
        const id = journaled?.fact.kind === 'finding' ? journaled.fact.id : `finding-${randomUUID()}`
        const seat = String(caller.seat.id)
        return this.#reuse(journaled, {
          id: mintId(),
          fact: { kind: 'finding', id, state: 'open', at },
          card: { board: caller.goal, id: input.intent },
          checkout: { cwd: held.checkout.cwd, branch: held.checkout.branch },
          seat, round: bound.round, observedAt: this.#port.now(), posted: null,
          finding: {
            version: 1, sequence: 1, operation,
            origin: { goal: caller.goal, run: bound.run, round: bound.round, card: input.intent, seat, at },
            event: {
              kind: 'raise', title: input.title, body: input.body, category: input.category, blocking: input.blocking,
              related: input.related ?? null, anchor: input.anchor ?? null,
            },
          },
        })
      },
    })
  }

  async repair(value: unknown, scope: TeamCallScope): Promise<FindingView> {
    const input = repairInputOf(value)
    const caller = this.#caller(scope)
    const bound = this.#bound(caller, input.intent)
    if (!bound.writer) throw new Error(`Card #${input.intent} does not change files, so it cannot record a repair.`)
    const operation = operationKey('repair', String(caller.seat.id), input.intent, input.request)
    return this.#command({
      run: bound.run, goal: caller.goal, caller, operation, kind: 'repair',
      meaning: canonical({ kind: 'repair', finding: input.finding, note: input.note }),
      prepare: async (ledger, journaled) => {
        const view = this.#owned(ledger, input.finding, caller.goal)
        if (view.origin.run !== bound.run && view.origin.goal === caller.goal) throw new Error('This finding belongs to another run on this Goal.')
        if (view.sequence !== input.expected && !journaled) throw new Error(STALE(view.sequence))
        const head = await this.#port.headOf(caller.seat.checkout.cwd)
        if (!head.at || head.dirty || !isSha(head.at)) throw new Error('Commit the repair before recording it.')
        const last = ledger.records.filter((record) => record.fact.kind === 'finding' && record.fact.id === view.id).at(-1)!
        return this.#reuse(journaled, {
          id: mintId(),
          fact: { kind: 'finding', id: view.id, state: 'repaired', at: head.at },
          card: { board: caller.goal, id: input.intent },
          checkout: { cwd: caller.seat.checkout.cwd, branch: caller.seat.checkout.branch },
          seat: String(caller.seat.id), round: bound.round, observedAt: this.#port.now(), posted: null,
          finding: { version: 1, sequence: (journaled?.finding?.sequence ?? view.sequence + 1), operation, origin: last.finding!.origin, event: { kind: 'repair', note: input.note } },
        })
      },
    })
  }

  async decide(value: unknown, scope: TeamCallScope): Promise<FindingView> {
    const input = decideInputOf(value)
    const caller = this.#caller(scope)
    const bound = this.#bound(caller, input.intent)
    if (!bound.reviews) throw new Error(`Card #${input.intent} is not a review card. Only a later review of the raising Agent decides a finding.`)
    const operation = operationKey('verdict', String(caller.seat.id), input.intent, input.request)
    return this.#command({
      run: bound.run, goal: caller.goal, caller, operation, kind: 'verdict',
      meaning: canonical({ kind: 'verdict', finding: input.finding, state: input.state, note: input.note, by: 'seat' }),
      prepare: async (ledger, journaled) => {
        /* Who may decide it is read from the finding's origin, which no later
           event changes, and is checked before anything about its state: a
           refusal a sibling can reach says the same thing whatever the round
           has recorded since. */
        const found = ledger.views.find((one) => one.id === input.finding && one.ownerGoal === caller.goal)
        if (!found) throw new Error('There is no such finding on this Goal.')
        const raiser = this.#port.seats.byId(found.origin.seat)
        if (!raiser?.agent) throw new Error('This finding was raised by a Seat with no Agent, so no later Seat can speak for it. A person decides it.')
        if (caller.seat.agent?.id !== raiser.agent.id) throw new Error('Only the Agent that raised this finding may decide it, from a later review.')
        if (String(caller.seat.id) === found.origin.seat || (found.origin.run === bound.run && bound.round <= found.origin.round)) {
          throw new Error('Decide a finding from a later review card, not the one that raised it.')
        }
        if (found.origin.run !== bound.run && found.origin.goal === caller.goal) throw new Error('This finding belongs to another run on this Goal.')
        const view = this.#owned(ledger, input.finding, caller.goal)
        if (view.sequence !== input.expected && !journaled) throw new Error(STALE(view.sequence))
        const held = await this.#port.flows.candidate(input.candidate, input.intent, scope)
        if (!held || held.goal !== caller.goal || held.seat !== String(caller.seat.id)) {
          throw new Error('That candidate is no longer being offered. Ask for review candidates again.')
        }
        if (!isSha(held.candidate.at)) throw new Error('That candidate has no committed revision to judge.')
        this.#pinned(bound.run, bound.round, held.candidate.at)
        const last = ledger.records.filter((record) => record.fact.kind === 'finding' && record.fact.id === view.id).at(-1)!
        return this.#reuse(journaled, {
          id: mintId(),
          fact: { kind: 'finding', id: view.id, state: input.state, at: held.candidate.at },
          card: { board: caller.goal, id: input.intent },
          checkout: { cwd: held.checkout.cwd, branch: held.checkout.branch },
          seat: String(caller.seat.id), round: bound.round, observedAt: this.#port.now(), posted: null,
          finding: {
            version: 1, sequence: (journaled?.finding?.sequence ?? view.sequence + 1), operation, origin: last.finding!.origin,
            event: { kind: 'verdict', state: input.state, note: input.note, by: 'seat' },
          },
        })
      },
    })
  }

  /** A Seat's read of its own Goal's findings: bounded, never truncated. */
  async readForSeat(value: unknown, scope: TeamCallScope): Promise<readonly FindingView[]> {
    const input = readInputOf(value)
    const caller = this.#caller(scope)
    const bound = this.#port.flows.binding(caller.goal, input.intent, caller)
    if (!bound || bound.seat !== String(caller.seat.id)) throw new Error(`You do not hold card #${input.intent}, so its findings are not yours to read.`)
    const project = await this.#port.projectOf(caller.goal)
    const read = await this.#serial(project, () => this.#ledger(project))
    // What a holder of an open blind round recorded in it is its own until the round closes: raises, repairs and verdicts alike.
    const ledger = this.#unblinded(read, caller.goal, caller)
    const owned = ledger.views.filter((one) => one.ownerGoal === caller.goal)
    const rows = input.filter === 'blocking' ? liveBlockers(owned) : input.filter === 'open' ? owned.filter((one) => !isResolved(one)) : owned
    if (rows.length > READ_LIMIT) throw new Error('Narrow this review before continuing: it has more findings than one card may read.')
    if (ledger.unreadable > 0 && input.filter !== 'all') {
      throw new Error('Some evidence records could not be read, so the open findings cannot be listed as complete. A person has to look.')
    }
    return rows
  }

  /**
   * The ledger as someone outside an open blind round may read it: every
   * event recorded on a card of such a round — a raise, a repair claim, a
   * verdict — is left out, except on the reader's own cards, and so is every
   * later event of a finding whose raise was left out. The views are folded
   * again from what is left, so a verdict a sibling recorded in the round
   * reads as though it has not happened yet; nothing about it — not its
   * state, its sequence or its note — shows through until the round closes.
   * `reader` null leaves out every such event (a packet for a round that has
   * no holder yet).
   */
  #unblinded(ledger: Ledger, goal: string, reader: { readonly runtime: string; readonly sessionId: string } | null): Ledger {
    const hidden = this.#blindCards(goal, reader)
    if (hidden.size === 0) return ledger
    const inRound = (record: EvidenceRecord): boolean => record.card?.board === goal && hidden.has(record.card.id)
    const unraised = new Set(ledger.records.filter((record) => inRound(record) && record.finding?.event.kind === 'raise' && record.fact.kind === 'finding')
      .map((record) => (record.fact as { readonly id: string }).id))
    const records = ledger.records.filter((record) => !inRound(record) &&
      !(record.fact.kind === 'finding' && unraised.has(record.fact.id)))
    return { records, views: foldFindings(records), unreadable: ledger.unreadable }
  }

  /** The cards of this Goal's open blind rounds that are not the reader's own. */
  #blindCards(goal: string, reader: { readonly runtime: string; readonly sessionId: string } | null): ReadonlySet<number> {
    const hidden = new Set<number>()
    for (const round of this.#port.flows.blindRounds?.(goal) ?? []) {
      const cards = round.cards ?? round.holders.map((one) => one.card)
      for (const card of cards) {
        const holder = round.holders.find((one) => one.card === card)
        if (!reader || holder?.runtime !== reader.runtime || holder.sessionId !== reader.sessionId) hidden.add(card)
      }
    }
    return hidden
  }

  // ------------------------------------------------------------------- reads

  /** Drops every list snapshot of `goal`: new evidence is never read through a page taken before it. */
  #invalidateList(goal: string): void {
    for (const [id, snapshot] of this.#snapshots) if (snapshot.goal === goal) this.#snapshots.delete(id)
  }

  #putSnapshot(id: string, snapshot: ListSnapshot): void {
    const now = this.#port.now()
    for (const [key, one] of this.#snapshots) if (now - one.at > SNAPSHOT_TTL_MS) this.#snapshots.delete(key)
    while (this.#snapshots.size >= MAX_SNAPSHOTS) {
      const oldest = this.#snapshots.keys().next().value
      if (oldest === undefined) break
      this.#snapshots.delete(oldest)
    }
    this.#snapshots.set(id, snapshot)
  }

  #pageOf(id: string, snapshot: ListSnapshot, offset: number): FindingPage {
    const rows = snapshot.rows.slice(offset, offset + READ_PAGE_LIMIT)
    const nextOffset = offset + rows.length
    return {
      goal: snapshot.goal, stamp: id, rows,
      next: nextOffset < snapshot.rows.length ? `${id}.${nextOffset}` : null,
      totals: snapshot.totals, problem: snapshot.problem,
    }
  }

  /**
   * A page of a Goal's findings, as a person reads them. With no cursor, the
   * ledger is read fresh and frozen into a new snapshot — the frame no row
   * moves inside while its later pages are read. A cursor names that exact
   * snapshot and an offset into it; it goes stale five minutes after it was
   * taken, when the snapshot has aged out under the cap, or the instant any
   * new evidence lands on this Goal, whichever comes first.
   */
  async list(input: { readonly goal: string; readonly cursor?: string; readonly filter?: 'all' | 'open' | 'blocking' }): Promise<FindingPage> {
    const filter = input.filter ?? 'all'
    if (input.cursor !== undefined) {
      const match = /^([0-9a-f]{32})\.(\d+)$/.exec(input.cursor)
      const snapshot = match ? this.#snapshots.get(match[1]!) : undefined
      const offset = match ? Number(match[2]) : NaN
      if (!match || !snapshot || snapshot.goal !== input.goal || snapshot.filter !== filter ||
        !Number.isSafeInteger(offset) || offset < 0 || offset > snapshot.rows.length ||
        this.#port.now() - snapshot.at > SNAPSHOT_TTL_MS) {
        throw new Error(SNAPSHOT_STALE)
      }
      return this.#pageOf(match[1]!, snapshot, offset)
    }
    const project = await this.#port.projectOf(input.goal)
    const ledger = await this.#serial(project, () => this.#ledger(project))
    const owned = ledger.views.filter((one) => one.ownerGoal === input.goal)
    const series = this.#port.flows.seriesOfGoal?.(input.goal) ?? []
    const admitted = admittedOf(series)
    const activeBlocking = (view: FindingView): boolean => (admitted.has(view.id) && !isResolved(view)) || view.problem !== null
    const selected = filter === 'blocking' ? owned.filter(activeBlocking)
      : filter === 'open' ? owned.filter((one) => !isResolved(one))
      : owned
    // Stamped per row, not left to `blocking`'s raw raise-time claim: a carried finding starts outside the
    // admitted set until its own first round closes, and a row that still said "Blocking" there would
    // disagree with this same page's own totals below.
    const rows = selected.map((view) => ({ ...view, activeBlocking: activeBlocking(view) }))
    const problem = ledger.unreadable > 0
      ? 'Some evidence records could not be read, so this ledger cannot be shown as complete. A person has to look.'
      : null
    const totals = problem !== null ? null : {
      all: owned.length,
      open: owned.filter((one) => !isResolved(one)).length,
      blocking: owned.filter(activeBlocking).length,
    }
    const id = randomUUID().replace(/-/g, '')
    this.#putSnapshot(id, { goal: input.goal, filter, rows, totals, problem, at: this.#port.now() })
    return this.#pageOf(id, this.#snapshots.get(id)!, 0)
  }

  /**
   * One finding's full history, as a person reads it: the exact historical
   * raise, then its later events in append order — the origin Seat's own
   * permanent record, never the latest Seat of a reused session. Events are
   * append-only, so a plain offset into a fresh read is stable on its own; a
   * cursor from before a new event still names the same rows it did.
   */
  async read(input: { readonly goal: string; readonly finding: string; readonly cursor?: string }): Promise<FindingDetailPage> {
    const project = await this.#port.projectOf(input.goal)
    const ledger = await this.#serial(project, () => this.#ledger(project))
    const view = ledger.views.find((one) => one.id === input.finding && one.ownerGoal === input.goal)
    if (!view) throw new Error('There is no such finding on this Goal.')
    const records = ledger.records.filter((record): record is FindingRecord =>
      record.fact.kind === 'finding' && record.fact.id === input.finding && record.finding !== undefined && record.finding !== null)
    let offset = 0
    if (input.cursor !== undefined) {
      if (!/^\d+$/.test(input.cursor)) throw new Error(SNAPSHOT_STALE)
      offset = Number(input.cursor)
      if (!Number.isSafeInteger(offset) || offset < 0 || offset > records.length) throw new Error(SNAPSHOT_STALE)
    }
    const page = records.slice(offset, offset + READ_PAGE_LIMIT)
    const nextOffset = offset + page.length
    const seat = view.origin.seat ? this.#port.seats.byId(view.origin.seat) : null
    return {
      finding: view, records: page, seat,
      next: nextOffset < records.length ? String(nextOffset) : null,
      problem: ledger.unreadable > 0
        ? 'Some evidence records could not be read, so this history cannot be shown as complete. A person has to look.'
        : null,
    }
  }

  // ------------------------------------------------------------------ carry

  /**
   * A person carries unresolved findings from a wrapped receipt into an open
   * Goal of the same project. The Goal plane journals the carry as one
   * operation — the target's new dependency and the carry events together —
   * before either is applied; this plane builds those events under the
   * project queue and appends them, once each, when the operation runs.
   */
  async carry(value: unknown): Promise<readonly FindingView[]> {
    const input = carryInputOf(value)
    const goals = this.#port.goals
    if (!goals) throw new Error('Findings cannot be carried on this desk.')
    const project = await this.#port.projectOf(input.goal)
    const keys = new Map(input.findings.map((id) => [id, operationKey('carry', `person:${input.goal}`, id, input.request)]))
    // The same carry asked again, already done: the same answer.
    const done = await this.#serial(project, async () => {
      const ledger = await this.#ledger(project)
      const carried = input.findings.every((id) => ledger.records.some((record) => record.finding?.operation === keys.get(id)))
      return carried ? input.findings.map((id) => ledger.views.find((one) => one.id === id)!) : null
    })
    if (done) return done
    await goals.carry(input, (target, source) => this.#serial(project, async () => {
      const frozen = source.receipt?.findings
      if (!frozen) throw new Error('That receipt did not record findings, so there is nothing to carry from it.')
      const ledger = await this.#ledger(project)
      if (ledger.unreadable > 0) throw new Error('Some evidence records could not be read, so these findings cannot be carried safely. A person has to look.')
      return input.findings.map((id) => {
        const was = frozen.findings.find((one) => one.id === id)
        if (!was) throw new Error('That receipt did not name this finding.')
        if (isResolved(was) || was.lifecycle.confirmed) throw new Error('This finding was resolved when its Goal wrapped. Only unresolved findings are carried.')
        const now = ledger.views.find((one) => one.id === id)
        if (!now) throw new Error('This finding is missing from the ledger. Restore its evidence before carrying it.')
        if (now.restored) throw new Error('This finding came from a backup. It is history here; ask for a new review instead.')
        if (now.problem !== null) throw new Error(`This finding cannot be carried until its history is repaired: ${now.problem}`)
        if (now.ownerGoal !== source.goal.id) throw new Error('This finding was already carried to another Goal. It has one active owner.')
        if (now.lifecycle.confirmed) throw new Error('This finding is resolved. Only unresolved findings are carried.')
        const last = ledger.records.filter((record) => record.fact.kind === 'finding' && record.fact.id === id).at(-1)!
        return {
          id: mintId(),
          fact: { kind: 'finding', id, state: now.lifecycle.state, at: last.fact.kind === 'finding' ? last.fact.at : now.origin.at },
          card: null,
          checkout: last.checkout ?? null,
          seat: null, round: null, observedAt: this.#port.now(), posted: null,
          finding: {
            version: 1, sequence: now.sequence + 1, operation: keys.get(id)!, origin: now.origin,
            event: { kind: 'carry', from: source.goal.id, receipt: input.receipt, to: target.goal.id },
          },
        } satisfies EvidenceRecord
      })
    }))
    const ledger = await this.#serial(project, () => this.#ledger(project))
    this.#invalidateList(input.goal)
    this.#port.changed?.(input.goal)
    return input.findings.map((id) => ledger.views.find((one) => one.id === id)!)
  }

  /** A carry operation's events, appended once each — the Goal plane's journal replays this after a stop. */
  async appendCarry(records: readonly EvidenceRecord[]): Promise<void> {
    for (const record of records) {
      if (record.finding?.event.kind !== 'carry') throw new Error('Only carry events are appended by a carry.')
      const project = await this.#port.projectOf(record.finding.event.to)
      await this.#serial(project, () => appendOnce(this.#appender(project), record))
    }
  }

  // --------------------------------------------------------------- postings

  /**
   * Where a publication landed, as the finding's `post` event: appended once
   * for its operation key, at the finding's next sequence read now, carrying
   * the phase-4 `posted` that agrees with it. Never a Seat's: the host posted.
   */
  async appendPost(input: { readonly goal: string; readonly finding: string; readonly operation: string; readonly location: FindingPost }): Promise<void> {
    if (input.location.operation !== input.operation) throw new Error('A posting names another operation than the one that sent it.')
    const project = await this.#port.projectOf(input.goal)
    await this.#serial(project, async () => {
      const ledger = await this.#ledger(project)
      if (ledger.records.some((record) => record.finding?.operation === input.operation)) return
      const view = ledger.views.find((one) => one.id === input.finding)
      if (!view) throw new Error('This finding could not be read back to record where it was posted.')
      const last = ledger.records.filter((record) => record.fact.kind === 'finding' && record.fact.id === view.id).at(-1)!
      await appendOnce(this.#appender(project), {
        id: mintId(),
        fact: { kind: 'finding', id: view.id, state: view.lifecycle.state, at: last.fact.kind === 'finding' ? last.fact.at : view.origin.at },
        card: null,
        checkout: last.checkout ?? null,
        seat: null, round: null, observedAt: this.#port.now(),
        posted: { pr: input.location.pr, comment: input.location.comment },
        finding: { version: 1, sequence: view.sequence + 1, operation: input.operation, origin: view.origin, event: { kind: 'post', location: input.location } },
      })
    })
    this.#invalidateList(input.goal)
    this.#port.changed?.(input.goal)
  }

  /**
   * Why a conversation may not publish to a forge right now, or null: it
   * holds a card in a review round that is still blind. Asked by every desk
   * publication path — the tool gate, and each forge mutation a plugin makes
   * — for the caller and for a delegated call's root alike.
   */
  embargoOf(runtime: string, sessionId: string): string | null {
    const seat = this.#port.seats.latestKeptOf(runtime, sessionId)
    if (!seat || seat.restored || !seat.board) return null
    // Blind or sighted, a reviewer of an open round posts nothing: publication waits for the round to close either way.
    const rounds = this.#port.flows.embargoedRounds?.(seat.board) ?? this.#port.flows.blindRounds?.(seat.board) ?? []
    const blind = rounds.some((round) => round.holders.some((holder) => holder.runtime === runtime && holder.sessionId === sessionId))
    return blind
      ? 'Refused: this Seat is reviewing in a blind round that has not closed. Its findings are posted with the round, together, once every reviewer has finished.'
      : null
  }

  // ---------------------------------------------------------------- receipts

  /**
   * The findings a Goal owns, as a wrap freezes them: the views and every
   * event id they fold from. `gaps` says what a receipt cannot vouch for.
   */
  async receipt(goal: string): Promise<FindingReceipt> {
    return (await this.receiptWithGaps(goal)).receipt
  }

  async receiptWithGaps(goal: string): Promise<{ readonly receipt: FindingReceipt; readonly gaps: readonly string[] }> {
    const project = await this.#port.projectOf(goal)
    const ledger = await this.#serial(project, () => this.#ledger(project))
    const findings = ledger.views.filter((one) => one.ownerGoal === goal)
    const overrides = this.#port.flows.overridesOfGoal?.(goal) ?? []
    return {
      receipt: { version: 1, evidence: findings.flatMap((one) => one.evidence), findings, overrides },
      gaps: ledger.unreadable > 0 ? ['Some evidence records could not be read, so this receipt’s findings may be incomplete.'] : [],
    }
  }

  // ------------------------------------------------------------------ rounds

  /**
   * A flow round closed: count it once, update its review series, and decide
   * whether the run may go on — then record that, with the round's close
   * operation, in the run's own journal. Keyed by run and round: a replay
   * after a restart, or a second call, records nothing twice. Called
   * outside the run's queue; `recordClose` takes it.
   */
  async roundClosed(run: string, round: number): Promise<void> {
    const flows = this.#port.flows
    if (!flows.run || !flows.recordClose || !flows.subjects || !flows.facts) throw new Error('This desk cannot close review rounds.')
    const snapshot = flows.run(run)
    if (!snapshot?.findings) return
    if (snapshot.findings.closedRounds.includes(round)) {
      // A replayed close: the batch was decided the first time and is found, never planned again.
      await this.#publisher?.close(run, round)
      await flows.recordClose(run, round, null)
      return
    }
    const closing = snapshot.rounds.find((one) => one.n === round)
    if (!closing) throw new Error(`Run ${run} has no round ${round}.`)
    const project = await this.#port.projectOf(snapshot.goal)
    const ledger = await this.#serial(project, () => this.#ledger(project))
    const facts = await flows.facts(snapshot.goal)
    const subjects = closing.reviews ? await flows.subjects(snapshot.goal, closing) : []
    // Computed from what this close read, applied to the run as it stands when the write runs.
    const close = (current: FindingRunState): FindingRunState => closeRound({ snapshot, state: current, round: closing, ledger, facts, subjects })
    /* The round's release is decided and journaled before the run goes on;
       its comments are sent afterwards, one at a time, and the run never
       waits on a forge. A decision that cannot be written stops the run. */
    await this.#publisher?.close(run, round)
    await flows.recordClose(run, round, close)
  }

  /**
   * A later review round's packet, for each subject whose series was
   * reviewed before: the delta since that review, the findings still in
   * question, and the evidence the review must still honour, rendered for
   * the reviewers' orders and pinned to the heads read now. Null for a first
   * review, which reads the change whole. Throws — and the round is not
   * seated — when a delta cannot be read in full.
   */
  async packetFor(run: string, round: number, role: string, subjects: readonly FlowSubject[]): Promise<ReviewPacketPin | null> {
    const snapshot = this.#port.flows.run?.(run)
    if (!snapshot?.findings) return null
    const later = subjects.flatMap((subject) => {
      const series = snapshot.findings!.series.find((one) => one.id === `${role}@${subject.checkout.cwd}` && one.reviewedAt !== null)
      return series ? [{ subject, series }] : []
    })
    if (later.length === 0) return null
    const project = await this.#port.projectOf(snapshot.goal)
    // Its reviewers are not seated yet: nothing any open blind round holds is theirs to be handed.
    const ledger = this.#unblinded(await this.#serial(project, () => this.#ledger(project)), snapshot.goal, null)
    const facts = (await this.#port.flows.facts?.(snapshot.goal)) ?? []
    const blind = this.#blindCards(snapshot.goal, null)
    const owned = ledger.views.filter((one) => one.ownerGoal === snapshot.goal)
    const raisedAt = (view: FindingView): string | null =>
      ledger.records.find((record) => record.fact.kind === 'finding' && record.fact.id === view.id && record.finding?.event.kind === 'raise')?.checkout?.cwd ?? null
    const read = this.#port.repairPacket ?? repairPacket
    const packets: RepairPacket[] = []
    for (const { subject, series } of later) {
      const evidence = facts.filter((view) => !view.record.restored && view.freshness.state === 'fresh' &&
        !(view.record.card?.board === snapshot.goal && blind.has(view.record.card.id)) && (
        (view.record.card?.board === snapshot.goal && view.record.card.id === subject.card &&
          ['check', 'ci', 'pr', 'diff'].includes(view.record.fact.kind)) ||
        (view.record.fact.kind === 'review' && (view.record.fact.against?.length ?? 0) > 0)))
        .map((view) => view.record.id)
      packets.push(await read({
        run, round, series, to: subject.at,
        findings: owned.filter((one) => one.origin.goal !== snapshot.goal || raisedAt(one) === series.checkout.cwd),
        evidence,
      }))
    }
    return {
      text: packets.map(renderPacket).join('\n\n'),
      pinned: later.map(({ subject }) => ({ cwd: subject.checkout.cwd, at: subject.at })),
      // Ids and revisions only, the same frozen reference the rendered text carries — never a finding's own body.
      leads: packets.map((packet) => ({
        series: packet.series, from: packet.from, to: packet.to, claimed: packet.claimed, unresolved: packet.unresolved,
      })),
    }
  }

  /** What a ready rule of this run also needs: its admitted blockers, a pending exception, a readable ledger. */
  async gate(run: string): Promise<FindingsGate | null> {
    const snapshot = this.#port.flows.run?.(run)
    if (!snapshot?.findings) return null
    const project = await this.#port.projectOf(snapshot.goal)
    const ledger = await this.#serial(project, () => this.#ledger(project))
    const admitted = admittedOf(snapshot.findings.series)
    const owned = ledger.views.filter((one) => one.ownerGoal === snapshot.goal)
    const blockers = owned.filter((one) => (admitted.has(one.id) && !isResolved(one)) || one.problem !== null).length
    return {
      blockers,
      pending: snapshot.findings.series.some((one) => one.pending.length > 0) || snapshot.pendingFindings > 0,
      unreadable: ledger.unreadable > 0,
    }
  }

  /**
   * A run's findings, as a person reads them. `stamp` is the one-use
   * operation token a decision is bound to: it folds in the view, every
   * owned finding's evidence, the review series (initial/exceptions/pending),
   * the run's extra-round and override bookkeeping, and — because none of
   * that moves when a writer simply commits — the live head of each series's
   * checkout. A commit between a preview and a decision changes none of the
   * ledger, so only that last part makes the stamp go stale for it.
   */
  async runView(run: string): Promise<FindingRunView> {
    const snapshot = this.#port.flows.run?.(run)
    if (!snapshot) throw new Error(`There is no flow run ${run}.`)
    const project = await this.#port.projectOf(snapshot.goal)
    const ledger = await this.#serial(project, () => this.#ledger(project))
    const owned = ledger.views.filter((one) => one.ownerGoal === snapshot.goal)
    const series = this.#port.flows.seriesOfGoal?.(snapshot.goal) ?? snapshot.findings?.series ?? []
    const admitted = admittedOf(series)
    const last = snapshot.rounds.at(-1)
    const blind = (this.#port.flows.embargoedRounds?.(snapshot.goal) ?? this.#port.flows.blindRounds?.(snapshot.goal) ?? []).some((one) => one.run === run)
    const publication = this.#publisher ? await this.#publisher.status(run) : { publication: 'local' as const, reason: null }
    const facts = (await this.#port.flows.facts?.(snapshot.goal)) ?? []
    // What "merge anyway" needs: a pull request the desk observed and bound, whatever posting is set to.
    const bound = boundPullRequest(facts)
    let reviewersFinished: number | null = null
    let reviewersTotal: number | null = null
    if (last?.reviews) {
      reviewersTotal = last.cards.length
      reviewersFinished = new Set(facts.filter((view) =>
        !view.record.restored && view.record.fact.kind === 'review' &&
        view.record.card?.board === snapshot.goal && last.cards.includes(view.record.card.id))
        .map((view) => view.record.card!.id)).size
    }
    // The Goal's own closure comes first; failing that, this run's own conclusion — stopped or settled — leaves
    // nothing more to decide either, whatever the round's own ceiling reason still says below.
    const goalReason = this.#port.goalClosed?.(snapshot.goal) ?? null
    const runConcluded = snapshot.state === 'stopped' || snapshot.state === 'settled'
    const lastOverride = (snapshot.findings?.overrides ?? []).at(-1) ?? null
    const view = {
      run, goal: snapshot.goal, round: last?.n ?? 0,
      finished: snapshot.findings?.closedRounds.length ?? 0,
      total: snapshot.findings?.budget.rounds ?? 0,
      embargoed: blind,
      open: owned.filter((one) => !isResolved(one)).length,
      blocking: owned.filter((one) => (admitted.has(one.id) && !isResolved(one)) || one.problem !== null).length,
      reason: snapshot.findings?.stopped?.reason ?? publication.reason,
      publication: publication.publication,
      reviewersFinished, reviewersTotal,
      pendingExceptions: [...pendingOf(series)],
      repair: last ? (snapshot.leads[String(last.n)] ?? null) : null,
      boundPr: bound.kind === 'bound' ? { repo: bound.repo, pr: bound.pr } : null,
      unbound: bound.kind === 'none' ? bound.reason : null,
      undecidable: goalReason ?? (runConcluded ? (snapshot.reason ?? 'This run already stopped. Nothing more is decided here.') : null),
      override: lastOverride ? { reason: lastOverride.reason, decidedAt: lastOverride.decidedAt } : null,
    }
    const cwds = [...new Set(series.map((one) => one.checkout.cwd))].sort()
    const heads = await Promise.all(cwds.map(async (cwd) => ({ cwd, ...(await this.#port.headOf(cwd)) })))
    const stamp = createHash('sha256').update(canonical({
      view, evidence: owned.flatMap((one) => one.evidence), series,
      extraRound: snapshot.findings?.extraRound ?? null, overrides: snapshot.findings?.overrides ?? [], heads,
    })).digest('hex')
    return { ...view, stamp }
  }

  // ---------------------------------------------------------------- decide

  /**
   * A person's bounded decision on a run, `finding/decide`. Every action is
   * bound to the run/round/stamp the person actually read: a stamp that does
   * not match — because the round moved on, a commit landed, a finding
   * changed — refuses before anything is touched. Applying a decision is
   * itself what moves the stamp (the action's own effect is folded into
   * `runView`), so a lost answer's retry is told apart by the run's own
   * `lastDecision` record: the *same* stamp with the *same* action and reason
   * replays the outcome already reached; the same stamp with anything else is
   * a genuine conflict. Only `adjudicate` writes a finding event; the rest
   * are the run's own bookkeeping, or a hand-off to an existing action
   * (merge, drop) this never performs itself.
   */
  async decideRun(input: {
    readonly goal: string
    readonly run: string
    readonly round: number
    readonly stamp: string
    readonly action: FindingDecisionAction
    readonly reason: string
  }): Promise<FindingRunView> {
    const reason = input.reason.trim()
    if (reason === '' || input.reason.length > 4096) throw new Error('Say why, in 1 to 4096 characters.')
    const first = this.#port.flows.run?.(input.run)
    if (!first) throw new Error(`There is no flow run ${input.run}.`)
    if (first.goal !== input.goal) throw new Error('That run does not belong to this Goal.')
    if (!first.findings) throw new Error('This run keeps no findings bookkeeping to decide.')
    const closed = this.#port.goalClosed?.(input.goal) ?? null
    if (closed) throw new Error(closed)
    const decide = this.#port.flows.decide
    if (!decide) throw new Error('This desk cannot record a decision on this run.')
    const key = canonical({ action: input.action, reason })
    /* The stamp check and the action are one step inside the run's queue:
       a second submission of the same read waits for the first, then finds
       it recorded — the same action replays, anything else is refused. */
    const replayed = await decide(input.run, async (ops) => {
      const snapshot = this.#port.flows.run?.(input.run)
      if (!snapshot?.findings) throw new Error('This run keeps no findings bookkeeping to decide.')
      const last = snapshot.findings.lastDecision
      if (last && last.stamp === input.stamp) {
        if (last.key !== key) throw new Error('This exact read was already used for a different decision. Read the run again.')
        return true
      }
      const stillClosed = this.#port.goalClosed?.(input.goal) ?? null
      if (stillClosed) throw new Error(stillClosed)
      const current = await this.runView(input.run)
      if (current.stamp !== input.stamp || current.round !== input.round) {
        throw new Error('This run changed since you read it. Read it again before deciding.')
      }
      const project = await this.#port.projectOf(input.goal)
      const series = this.#port.flows.seriesOfGoal?.(input.goal) ?? snapshot.findings.series
      switch (input.action.kind) {
        case 'another-round':
          await ops.authorizeExtraRound(input.round, reason)
          break
        case 'admit-exceptions':
        case 'decline-exceptions': {
          const known = pendingOf(series)
          if (input.action.findings.length === 0 || input.action.findings.some((id) => !known.has(id))) {
            throw new Error('One or more of these findings are no longer a pending exception. Read the run again.')
          }
          await ops.recordExceptionDecision(input.action.findings, input.action.kind === 'admit-exceptions')
          break
        }
        case 'merge-anyway': {
          const facts = (await this.#port.flows.facts?.(input.goal)) ?? []
          const bound = boundPullRequest(facts)
          if (bound.kind === 'none') throw new Error('Publish a pull request before merging here.')
          const ledger = await this.#serial(project, () => this.#ledger(project))
          const owned = ledger.views.filter((one) => one.ownerGoal === input.goal)
          const admitted = admittedOf(series)
          const unresolved = owned.filter((one) => (admitted.has(one.id) && !isResolved(one)) || one.problem !== null).map((one) => one.id)
          const cwd = series[0]?.checkout.cwd
          const at = cwd ? (await this.#port.headOf(cwd)).at ?? '' : ''
          await ops.recordOverride({
            by: 'person', run: input.run, round: input.round, at, findings: unresolved, reason, decidedAt: this.#port.now(),
          })
          break
        }
        case 'drop':
          await ops.stop(reason)
          break
        case 'adjudicate':
          await this.#adjudicate(input.goal, input.run, input.round, input.action.finding, input.action.state, reason, input.stamp)
          break
      }
      await ops.recordDecisionStamp(input.stamp, key)
      return false
    })
    if (!replayed) {
      this.#invalidateList(input.goal)
      this.#port.changed?.(input.goal)
    }
    return this.runView(input.run)
  }

  /**
   * A person's verdict on a finding — the same lifecycle event a raising
   * Agent's own `decide` would record, with actor Seat null and `by:
   * 'person'` instead. Appended through the same idempotent ledger writer as
   * every other finding event: the operation key is the stamp the person
   * read, so a duplicate submission finds the same record rather than a
   * second one, and a stamp reused after the finding moved on is refused by
   * the sequence check already enforced there.
   */
  async #adjudicate(
    goal: string, run: string, round: number, finding: string,
    state: 'open' | 'repaired' | 'withdrawn', reason: string, stamp: string,
  ): Promise<void> {
    const closed = this.#port.goalClosed?.(goal) ?? null
    if (closed) throw new Error(closed)
    const project = await this.#port.projectOf(goal)
    const operation = operationKey('verdict', `person:${goal}`, round, stamp)
    await this.#serial(project, async () => {
      const ledger = await this.#ledger(project)
      if (ledger.records.some((record) => record.finding?.operation === operation)) return
      const view = ledger.views.find((one) => one.id === finding && one.ownerGoal === goal)
      if (!view) throw new Error('There is no such finding on this Goal.')
      if (view.restored) throw new Error('This finding came from a backup. It is history here; ask for a new review instead.')
      if (view.problem !== null) throw new Error(`This finding cannot be changed until its history is repaired: ${view.problem}`)
      if (view.lifecycle.confirmed) throw new Error('This finding is resolved. Record a new linked finding.')
      if (view.origin.run !== run && view.origin.goal === goal) throw new Error('This finding belongs to another run on this Goal.')
      const last = ledger.records.filter((record) => record.fact.kind === 'finding' && record.fact.id === view.id).at(-1)!
      await appendOnce(this.#appender(project), {
        id: mintId(),
        fact: { kind: 'finding', id: view.id, state, at: last.fact.kind === 'finding' ? last.fact.at : view.origin.at },
        card: null,
        checkout: last.checkout ?? null,
        seat: null, round, observedAt: this.#port.now(), posted: null,
        finding: { version: 1, sequence: view.sequence + 1, operation, origin: view.origin, event: { kind: 'verdict', state, note: reason, by: 'person' } },
      })
    })
  }

  // ------------------------------------------------------------- postings

  /**
   * A run's postings as a person decides them: each one paused, started and
   * never confirmed, or uncertain, and what posting the rounds this run kept
   * on the desk would release now (`Publications.needs`).
   */
  async publications(input: { readonly goal: string; readonly run: string }): Promise<FindingPublicationsView> {
    const snapshot = this.#port.flows.run?.(input.run)
    if (!snapshot || snapshot.goal !== input.goal) throw new Error('That run does not belong to this Goal.')
    if (!this.#publisher) return { goal: input.goal, run: input.run, items: [], backfill: null, backfillRefusal: 'This desk posts nothing to a pull request.' }
    return { goal: input.goal, run: input.run, ...await this.#publisher.needs(input.run) }
  }

  /** A person's "Post again", "Skip" or backfill, on a run of an open Goal; answered with the postings as they stand after. */
  async publish(input: { readonly goal: string; readonly run: string; readonly action: FindingPublishAction }): Promise<FindingPublicationsView> {
    const snapshot = this.#port.flows.run?.(input.run)
    if (!snapshot || snapshot.goal !== input.goal) throw new Error('That run does not belong to this Goal.')
    const closed = this.#port.goalClosed?.(input.goal) ?? null
    if (closed) throw new Error(closed)
    const publisher = this.#publisher
    if (!publisher) throw new Error('This desk posts nothing to a pull request.')
    try {
      switch (input.action.kind) {
        case 'post-again':
          await publisher.postAgain(input.run, input.action.key)
          break
        case 'skip':
          await publisher.skip(input.run, input.action.key, input.action.reason)
          break
        case 'backfill':
          await publisher.backfill(input.run, input.action.stamp)
          break
      }
    } finally {
      this.#invalidateList(input.goal)
      this.#port.changed?.(input.goal)
    }
    return this.publications(input)
  }

  // ----------------------------------------------------------------- restart

  /**
   * Settles every command a stop left `prepared`: one whose record is on the
   * disk is finished; one whose record is not is stopped with a reason, and
   * nothing is appended for a caller who is not there to be answered. A
   * retry of the same request reuses what that command minted.
   */
  async recover(): Promise<void> {
    for (const { run, entries } of this.#port.flows.pending()) {
      try {
        await this.#port.flows.journal(run, async (journal) => {
          for (const entry of entries) {
            const current = journal.entry(entry.operation)
            if (current?.state !== 'prepared') continue
            const goal = current.record.card?.board ?? current.record.finding?.origin.goal
            if (!goal) continue
            const project = await this.#port.projectOf(goal)
            const ledger = await this.#serial(project, () => this.#ledger(project))
            const durable = ledger.records.find((record) => record.finding?.operation === entry.operation)
            await journal.put(durable
              ? { ...current, record: durable, state: 'finished', reason: null }
              : { ...current, state: 'abandoned', reason: 'The desk stopped before this finding was saved. Record it again.' })
          }
        })
      } catch (error) {
        this.#port.log('finding commands a stop left part-way could not be settled', { run, error: error instanceof Error ? error.message : String(error) })
      }
    }
  }

  /** Resolves once every queued write has settled. */
  async close(): Promise<void> {
    while (this.#tails.size > 0) await Promise.all([...this.#tails.values()])
  }
}

// ------------------------------------------------------------- closing a round

/**
 * A closed round's bookkeeping, computed from what the ledger, the facts and
 * the subjects say now. The first closed round is the progress baseline; a
 * review round closes its series (freezing the first review's blocking set);
 * the loop decision stops at a person or lets the run go on.
 */
export function closeRound(input: {
  readonly snapshot: FindingRunSnapshot
  /** The run's bookkeeping to close onto: the current one, read inside the run's queue. The snapshot's when absent. */
  readonly state?: FindingRunState
  readonly round: FindingRunSnapshot['rounds'][number]
  readonly ledger: { readonly records: readonly EvidenceRecord[]; readonly views: readonly FindingView[]; readonly unreadable: number }
  readonly facts: readonly EvidenceView[]
  readonly subjects: readonly FlowSubject[]
}): FindingRunState {
  const { snapshot, round, ledger } = input
  const state = input.state ?? snapshot.findings!
  const goal = snapshot.goal
  const owned = ledger.views.filter((one) => one.ownerGoal === goal)
  // Series: the round's reviews, by role and subject checkout.
  let series = [...state.series]
  if (round.reviews) {
    const raisedHere = owned.filter((one) => one.origin.run === snapshot.id && one.origin.round === round.n)
    const carried = owned.filter((one) => one.origin.goal !== goal)
    const checkouts = new Map<string, { cwd: string; branch: string | null; at: string | null }>()
    for (const subject of input.subjects) checkouts.set(subject.checkout.cwd, { ...subject.checkout, at: subject.at })
    const raiseCheckout = (view: FindingView): string | null =>
      ledger.records.find((record) => record.fact.kind === 'finding' && record.fact.id === view.id && record.finding?.event.kind === 'raise')?.checkout?.cwd ?? null
    for (const one of raisedHere) {
      const cwd = raiseCheckout(one)
      if (cwd && !checkouts.has(cwd)) checkouts.set(cwd, { cwd, branch: null, at: one.origin.at })
    }
    for (const [cwd, checkout] of checkouts) {
      const id = `${round.role}@${cwd}`
      const existing: FindingSeries = series.find((one) => one.id === id) ?? {
        id, role: round.role, checkout: { cwd, branch: checkout.branch }, reviewedAt: null, reviewRounds: [], initial: [], exceptions: [], pending: [],
      }
      const next = closeSeries(existing, {
        round: round.n,
        at: checkout.at,
        raised: raisedHere.filter((one) => raiseCheckout(one) === cwd),
        carried: existing.reviewRounds.length === 0 ? carried : [],
      })
      series = [...series.filter((one) => one.id !== id), next]
    }
  }
  const admitted = admittedOf(series)
  const active = owned.filter((one) => (admitted.has(one.id) && !isResolved(one)) || one.problem !== null)
  // Progress: the run's own facts, as tuples it has not seen before.
  const cards = new Set(snapshot.rounds.flatMap((one) => one.cards))
  const facts = input.facts.filter((view) => view.record.card?.board === goal && cards.has(view.record.card.id))
  const keys = progressKeys({
    facts,
    slotOf: (seat) => snapshot.slots[seat] ?? null,
    confirmed: owned.filter((one) => isResolved(one)).map((one) => one.id),
  })
  const progress = advanceProgress(state.progress, keys, state.closedRounds.length === 0)
  const closed = state.closedRounds.length + 1
  const decision = decideLoop({
    closed,
    limit: Math.max(state.budget.rounds, state.extraRound ? state.extraRound.after + 1 : 0),
    idle: state.idleRounds,
    idleLimit: state.budget.withoutProgress,
    newProgress: progress.newProgress,
    unresolvedRepairs: active.map((one) => rejectedRepairs(ledger.records, one.id)),
    unresolved: active.length,
    // The flow's own rules route a ready round; this decides only whether to stop.
    reviewComplete: false,
    freshGuards: false,
    pendingException: series.some((one) => one.pending.length > 0),
  })
  /* An unreadable ledger stops only the review series's own rounds. A plain
     round — a debate, a build — raises and decides no findings, so its stop,
     when there is one, names the run's own budget instead (#1014). What
     could not be read is an evidence record, not necessarily a finding. */
  const unreadable = round.reviews && ledger.unreadable > 0 ? 'Some evidence records could not be read, so the open findings cannot be counted. A person has to look.' : null
  const reason = unreadable ?? decision.reason
  return {
    ...state,
    closedRounds: [...state.closedRounds, round.n],
    idleRounds: decision.idle,
    progress: progress.progress,
    series,
    stopped: reason !== null && (unreadable !== null || decision.next === 'person') ? { round: round.n, reason } : null,
  }
}

/** A packet as a reviewer's order carries it: the findings in question first, then the delta, then the contract. */
export const renderPacket = (packet: RepairPacket): string => {
  const line = (view: FindingView): string =>
    `- ${view.id} · ${view.lifecycle.state === 'repaired' ? 'repair claimed, not yet confirmed' : view.lifecycle.state} · sequence ${view.sequence}: ${view.title}\n  ${view.body.replace(/\n/g, '\n  ')}`
  return [
    `This review continues an earlier one of ${packet.series}. Judge the change since ${packet.from.slice(0, 12)}, up to ${packet.to.slice(0, 12)}, and the findings still in question — nothing else.`,
    packet.warning,
    `Repairs claimed since the last review: ${packet.claimed.length > 0 ? packet.claimed.join(', ') : 'none'}.`,
    `Still unresolved: ${packet.unresolved.length > 0 ? packet.unresolved.join(', ') : 'none'}.`,
    packet.findings.length > 0 ? `Findings in question:\n${packet.findings.map(line).join('\n')}` : null,
    `The change:\n\`\`\`diff\n${packet.diff}\`\`\``,
    packet.evidence.length > 0 ? `Evidence this review must still honour: ${packet.evidence.join(', ')}.` : null,
    'Decide each finding you raised with decide_finding, and raise anything new with raise_finding.',
  ].filter((one): one is string => Boolean(one)).join('\n\n')
}
