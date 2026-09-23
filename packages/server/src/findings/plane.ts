import { createHash, randomUUID } from 'node:crypto'

import type {
  CarryFindingsInput,
  DecideFindingInput,
  EvidenceRecord,
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
import type { GoalDocument } from '../goals/store.js'
import type { TeamCallScope } from '../team.js'
import type { FindingJournal, FindingJournalEntry } from './journal.js'
import { canonical, foldFindings, isResolved, liveBlockers } from './model.js'

/**
 * The findings plane: the one writer of the findings ledger.
 *
 * Every finding event — a Seat's raise, repair claim or verdict, a person's
 * carry — is appended here and nowhere else, one project at a time. The
 * order a command takes its queues is fixed: the flow run's own queue (whose
 * journal records the command before it takes effect), then this plane's
 * project queue, never the other way round, and nothing holding the project
 * queue ever asks for a run or a Goal. A carry takes the Goal queue, then
 * the project queue. So no two writers ever read-modify-write one finding.
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
  /** The project a Goal's facts are kept under. */
  projectOf(goal: string): Promise<string>
  /** A checkout's committed head now, and whether it holds uncommitted changes. */
  headOf(cwd: string): Promise<{ readonly at: string | null; readonly dirty: boolean }>
  now(): number
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
const STALE = (now: number) => `This finding changed since you read it; it is at sequence ${now}. Read it again before recording this.`

export class FindingsPlane {
  readonly #port: FindingsPort
  readonly #tails = new Map<string, Promise<unknown>>()

  constructor(port: FindingsPort) {
    this.#port = port
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
    readonly operation: string
    readonly kind: FindingJournalEntry['kind']
    readonly meaning: string
    readonly prepare: (ledger: Ledger, journaled: EvidenceRecord | null) => Promise<EvidenceRecord>
  }): Promise<FindingView> {
    const project = await this.#port.projectOf(input.goal)
    const hash = hashOf(input.meaning)
    const view = await this.#port.flows.journal(input.run, (journal) => this.#serial(project, async () => {
      const entry = journal.entry(input.operation)
      if (entry && entry.hash !== hash) throw new Error('This request was already used for different content. Use a new request token for a new claim.')
      const ledger = await this.#ledger(project)
      const durable = ledger.records.find((record) => record.finding?.operation === input.operation)
      if (durable) {
        // The same request, already on the disk: the same event, whatever has happened since.
        if (hashOf(meaningOf(durable)) !== hash) throw new Error('This request was already used for different content. Use a new request token for a new claim.')
        if (entry && entry.state !== 'finished') await journal.put({ ...entry, state: 'finished', reason: null })
        return this.#viewOf(ledger.records, durable)
      }
      const record = await input.prepare(ledger, entry?.record ?? null)
      if (hashOf(meaningOf(record)) !== hash) throw new Error('This request could not be recorded as it was asked.')
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
      return this.#viewOf([...ledger.records, appended], appended)
    }))
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
      run: bound.run, goal: caller.goal, operation, kind: 'raise', meaning,
      prepare: async (ledger, journaled) => {
        const held = await this.#port.flows.candidate(input.candidate, input.intent, scope)
        if (!held || held.goal !== caller.goal || held.seat !== String(caller.seat.id)) {
          throw new Error('That candidate is no longer being offered. Ask for review candidates again.')
        }
        if (!isSha(held.candidate.at)) throw new Error('That candidate has no committed revision to raise a finding against.')
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
      run: bound.run, goal: caller.goal, operation, kind: 'repair',
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
      run: bound.run, goal: caller.goal, operation, kind: 'verdict',
      meaning: canonical({ kind: 'verdict', finding: input.finding, state: input.state, note: input.note, by: 'seat' }),
      prepare: async (ledger, journaled) => {
        const view = this.#owned(ledger, input.finding, caller.goal)
        const raiser = this.#port.seats.byId(view.origin.seat)
        if (!raiser?.agent) throw new Error('This finding was raised by a Seat with no Agent, so no later Seat can speak for it. A person decides it.')
        if (caller.seat.agent?.id !== raiser.agent.id) throw new Error('Only the Agent that raised this finding may decide it, from a later review.')
        if (String(caller.seat.id) === view.origin.seat || (view.origin.run === bound.run && bound.round <= view.origin.round)) {
          throw new Error('Decide a finding from a later review card, not the one that raised it.')
        }
        if (view.origin.run !== bound.run && view.origin.goal === caller.goal) throw new Error('This finding belongs to another run on this Goal.')
        if (view.sequence !== input.expected && !journaled) throw new Error(STALE(view.sequence))
        const held = await this.#port.flows.candidate(input.candidate, input.intent, scope)
        if (!held || held.goal !== caller.goal || held.seat !== String(caller.seat.id)) {
          throw new Error('That candidate is no longer being offered. Ask for review candidates again.')
        }
        if (!isSha(held.candidate.at)) throw new Error('That candidate has no committed revision to judge.')
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
    const ledger = await this.#serial(project, () => this.#ledger(project))
    const owned = ledger.views.filter((one) => one.ownerGoal === caller.goal)
    const rows = input.filter === 'blocking' ? liveBlockers(owned) : input.filter === 'open' ? owned.filter((one) => !isResolved(one)) : owned
    if (rows.length > READ_LIMIT) throw new Error('Narrow this review before continuing: it has more findings than one card may read.')
    if (ledger.unreadable > 0 && input.filter !== 'all') {
      throw new Error('Some evidence records could not be read, so the open findings cannot be listed as complete. A person has to look.')
    }
    return rows
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
    return {
      receipt: { version: 1, evidence: findings.flatMap((one) => one.evidence), findings, overrides: [] },
      gaps: ledger.unreadable > 0 ? ['Some evidence records could not be read, so this receipt’s findings may be incomplete.'] : [],
    }
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
