import { createHash } from 'node:crypto'

import type {
  EvidenceRecord, EvidenceView, FindingAnchor, FindingId, FindingPost, FindingView, SeatRecord,
} from '@harnessdesk/protocol'
import { renderSignature } from '@harnessdesk/plugins'

/**
 * Publishing a closed round: one durable batch, then one comment at a time.
 *
 * Nothing here is a second copy of a finding. A publication is an operation
 * in its flow run's own journal (`FlowExecutions` writes that file and
 * nothing else does): which event it posts, where, the marker it carries and
 * the hash of the body it renders from the event's immutable evidence. The
 * finding itself is only ever the ledger's; once a comment lands, the ledger
 * gains a `post` event saying where, and the operation says it is done.
 *
 * Posting to a forge is not idempotent, so the order is fixed and every step
 * is on disk before the next: a round's whole batch is decided and journaled
 * before the first remote call; an operation is `started` before its send; a
 * send whose answer is lost is `uncertain`, and nothing is ever sent twice to
 * find out. What the forge holds is read back — the exact marker, body and
 * target — and only one exact copy counts as posted. None, several, or a read
 * that could not finish is the person's to look at.
 */

// --------------------------------------------------------------- the journal

/** One finding event's publication, as the plan's contract names it. */
export interface FindingPublication {
  readonly key: string
  readonly run: string
  readonly round: number
  readonly project: string
  readonly repo: string
  readonly pr: number
  /** The revision the claim was made at: the pull request's head must still be this when it is sent. */
  readonly at: string
  readonly finding: FindingId
  /** The evidence it renders from, the event's own record first. */
  readonly evidence: readonly string[]
  /** The Seat that made the claim. */
  readonly actor: string
  /** Where this finding's thread is: its first posting, read when the operation starts. */
  readonly parent: FindingPost | null
  readonly marker: string
  /** The hash of the body, fixed when the round closed. */
  readonly digest: string
  readonly state: 'prepared' | 'started' | 'posted' | 'uncertain' | 'skipped'
  readonly location: FindingPost | null
  readonly reason: string | null
}

/** A review's own summary — a zero-findings review is posted too — keyed by its review evidence id. */
export type ReviewPublication = Omit<FindingPublication, 'finding' | 'parent'> & { readonly review: string }

/** Where an operation goes, decided just before it starts. */
export type Placement = 'inline' | 'reply' | 'general' | 'append'

/** A journaled operation: either kind, with what was decided around its send. */
export type PublicationEntry = (FindingPublication | ReviewPublication) & {
  readonly placement: Placement | null
  /** For an append: the comment's content chain as the desk last wrote it, compared before the update. */
  readonly expected: string | null
  /** The comment's content chain once this write lands: the next append's `expected`. Null for a review comment. */
  readonly wrote: string | null
  /** The last thing a person decided about this operation — post it again, or skip it — and why. Absent until one does. */
  readonly person?: { readonly action: 'post-again' | 'skip'; readonly reason: string | null; readonly at: number }
}

/** A closed round's release decision: posted as one batch, kept on the desk, or refused before any send. */
export interface PublicationRound {
  readonly round: number
  readonly mode: 'batch' | 'local' | 'refused'
  readonly reason: string | null
  readonly repo: string | null
  readonly pr: number | null
  /** Every operation of the batch, keyed before the first remote call, in posting order. */
  readonly keys: readonly string[]
  readonly decidedAt: number
  /** A round first kept on the desk, posted later because a person previewed it and asked: when, and why it was kept. */
  readonly backfilled?: { readonly at: number; readonly from: string | null }
}

/** A run's publications, in its own file. */
export interface StoredPublication {
  readonly rounds: Readonly<Record<string, PublicationRound>>
  readonly ops: Readonly<Record<string, PublicationEntry>>
}

/** A run's publication journal, as one step inside that run's queue reads and writes it. */
export interface PublicationJournal {
  round(round: number): PublicationRound | null
  entry(key: string): PublicationEntry | null
  entries(): readonly PublicationEntry[]
  /** Journals a round's decision and its operations once; a second decision for the round changes nothing. */
  decide(round: PublicationRound, entries: readonly PublicationEntry[]): Promise<void>
  /** Persists one operation; resolves only once the run's file is synced. */
  put(entry: PublicationEntry): Promise<void>
  /**
   * Replaces a round kept on the desk with the batch a person previewed and
   * asked for, its operations journaled with it; a round already posted
   * that way changes nothing, and any other round refuses.
   */
  backfill(round: PublicationRound, entries: readonly PublicationEntry[]): Promise<void>
}

export const isFindingPublication = (entry: PublicationEntry): entry is FindingPublication & PublicationEntry =>
  Object.hasOwn(entry, 'finding')

const STATES = new Set(['prepared', 'started', 'posted', 'uncertain', 'skipped'])
const PLACEMENTS = new Set(['inline', 'reply', 'general', 'append'])
const MODES = new Set(['batch', 'local', 'refused'])
const object = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
const text = (value: unknown): value is string => typeof value === 'string' && value !== ''
const orNull = (value: unknown, check: (value: unknown) => boolean): boolean => value === null || check(value)
const positive = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) > 0
const isPost = (value: unknown): boolean => object(value) && text(value['repo']) && positive(value['pr']) && positive(value['comment']) &&
  (value['kind'] === 'review-comment' || value['kind'] === 'issue-comment') && text(value['url']) && text(value['operation'])

/** A run file's publications, checked whole; throws with what is wrong. */
export const publicationOf = (value: unknown): StoredPublication => {
  if (!object(value) || !object(value['rounds']) || !object(value['ops'])) throw new Error('has unreadable publications')
  for (const [key, round] of Object.entries(value['rounds'])) {
    if (!object(round) || String(round['round']) !== key || !MODES.has(String(round['mode'])) || !orNull(round['reason'], text) ||
      !orNull(round['repo'], text) || !orNull(round['pr'], positive) || !Array.isArray(round['keys']) ||
      !(round['keys'] as unknown[]).every(text) || !Number.isSafeInteger(round['decidedAt'])) throw new Error('has a publication round it cannot describe')
  }
  for (const [key, entry] of Object.entries(value['ops'])) {
    if (!object(entry) || entry['key'] !== key || !text(entry['run']) || !positive(entry['round']) || !text(entry['project']) ||
      !text(entry['repo']) || !positive(entry['pr']) || !text(entry['at']) || !Array.isArray(entry['evidence']) ||
      !(entry['evidence'] as unknown[]).every(text) || !text(entry['actor']) || !text(entry['marker']) || !text(entry['digest']) ||
      !STATES.has(String(entry['state'])) || !orNull(entry['location'], isPost) || !orNull(entry['reason'], text) ||
      !orNull(entry['placement'], (one) => PLACEMENTS.has(String(one))) || !orNull(entry['expected'], text) || !orNull(entry['wrote'], text) ||
      (Object.hasOwn(entry, 'finding') ? !text(entry['finding']) || !orNull(entry['parent'], isPost) : !text(entry['review']))) {
      throw new Error('has a publication it cannot describe')
    }
    if (entry['state'] === 'posted' && entry['location'] === null) throw new Error('has a publication marked posted with no location')
    const person = entry['person']
    if (person !== undefined && (!object(person) || (person['action'] !== 'post-again' && person['action'] !== 'skip') ||
      !orNull(person['reason'], text) || !Number.isSafeInteger(person['at']))) throw new Error('has a person’s publication decision it cannot describe')
  }
  return value as unknown as StoredPublication
}

// ------------------------------------------------------------ the one helper

/** The steps of one publication, each idempotent by its operation key. */
export interface PostingPort {
  closed(): Promise<boolean>
  phase(): Promise<'new' | 'started' | 'posted'>
  start(): Promise<void>
  find(): Promise<readonly number[]>
  send(): Promise<number>
  finish(comment: number): Promise<void>
}

/**
 * One operation, once: never before its round closed; a started operation is
 * read back, never sent again; one exact copy is posted, anything else is
 * uncertain. `start` is on disk before `send`; `finish` appends the ledger's
 * post event, then marks the operation posted.
 */
export async function publishOnce(port: PostingPort): Promise<'posted' | 'uncertain' | 'embargoed'> {
  if (!await port.closed()) return 'embargoed'
  const phase = await port.phase()
  if (phase === 'posted') return 'posted'
  if (phase === 'started') {
    const found = await port.find()
    if (found.length !== 1) return 'uncertain'
    await port.finish(found[0]!)
    return 'posted'
  }
  await port.start()
  const comment = await port.send()
  await port.finish(comment)
  return 'posted'
}

// ------------------------------------------------------------------ the forge

/** The pull request as the forge says it is now, read through the canonical project. */
export interface ObservedTarget {
  readonly repo: string
  readonly number: number
  readonly head: string
  readonly state: 'open' | 'merged' | 'closed'
}

/**
 * The host-owned forge adapter a closed round's batch posts through: never a
 * plugin, never an agent's tool. Every read is bounded; a read that could not
 * finish throws, and throwing is never "not found".
 */
export interface FindingForgePort {
  observeTarget(project: string, pr: number): Promise<ObservedTarget>
  /** Whether an anchor is a line this pull request's change touches, on that side, at its current head. */
  anchorable(operation: PublicationEntry, anchor: FindingAnchor): Promise<boolean>
  /** Every exact copy of this operation the forge holds: marker, body and target, with validated locations. */
  find(operation: PublicationEntry): Promise<readonly FindingPost[]>
  send(operation: PublicationEntry, body: string, anchor: FindingAnchor | null): Promise<FindingPost>
}

/** Thrown by an append that found the comment edited since the desk wrote it: nothing was sent. */
export class PublicationConflict extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PublicationConflict'
  }
}

/** One posting a person has to look at: paused, started and never confirmed, or uncertain. */
export interface PersonItem {
  readonly key: string
  readonly round: number
  /** The finding it posts; null for a review's own summary. */
  readonly finding: FindingId | null
  readonly pr: number
  readonly state: 'prepared' | 'started' | 'uncertain'
  readonly reason: string | null
}

export interface FindingPublisher {
  close(run: string, round: number): Promise<void>
  reconcile(run: string, round: number): Promise<void>
  settleForWrap(goal: string): Promise<void>
}

// -------------------------------------------------------------------- bodies

/** One body at most, and one batch at most: more refuses before any send. */
export const BODY_LIMIT = 32 * 1024
export const BATCH_LIMIT = 200

export const MARKER_PREFIX = '<!-- harnessdesk:finding-op '
export const markerOf = (key: string): string => `${MARKER_PREFIX}${key} -->`
export const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex')

/** An operation key: the run, its round, the entry's kind and the evidence it posts. The same close always makes the same keys. */
export const publicationKey = (run: string, round: number, kind: 'finding' | 'review', id: string): string =>
  `pub-${sha256([run, String(round), kind, id].join('\u0000')).slice(0, 48)}`

/** Agent text, as data: it can never forge a desk marker, a signature mark, or a segment of a desk comment. */
const inert = (value: string): string => value.replace(/<!--(\s*)harnessdesk:/gi, '&lt;!--$1harnessdesk:')

/**
 * A general comment the desk keeps for a finding is its segments — the first
 * post, then each appended event — each opening with its marker. Its chain
 * is what the desk last wrote, computable without the text: an append
 * compares it before it writes, and the next append starts from it.
 */
export const segmentsOf = (body: string): readonly string[] => body.split(/\n\n(?=<!-- harnessdesk:finding-op )/)
export const chainOf = (segments: readonly string[], from = ''): string =>
  segments.reduce((chain, segment) => sha256(`${chain}\u0000${segment}`), from)
export const APPEND_JOIN = '\n\n'

/** The signature seat a Seat record makes: its immutable readback, never the conversation's current options. */
export const forgeSeatOf = (seat: SeatRecord): Parameters<typeof renderSignature>[1] => ({
  agent: seat.agent?.name ?? seat.seatLabel.split(' · ')[0] ?? seat.seat.runtime,
  version: null,
  model: seat.seat.model ?? null,
  effort: seat.seat.effort ?? null,
  thinking: seat.seat.thinking ?? false,
  label: seat.seatLabel,
})

/** Who made a claim, in words, from the Seat record; never an id, never the agent's own text. */
const whoOf = (seat: SeatRecord | null): string =>
  seat ? `${inert(seat.agent?.name ?? 'A flow Seat')} (${inert(seat.seatLabel)})` : 'A Seat this desk no longer has a record of'

/** What a body is rendered from: records by id, Seats by id, and the person's review signature template. */
export interface BodySources {
  readonly records: ReadonlyMap<string, EvidenceRecord>
  seat(id: string): SeatRecord | null
  readonly template: string
}

const short = (sha: string): string => sha.slice(0, 12)

/** The opening lines every desk comment carries: its marker, then the person's signature line when there is one. */
const opening = (key: string, seat: SeatRecord | null, template: string): string[] => {
  const signature = seat && template.trim() !== '' ? renderSignature(template, forgeSeatOf(seat)) : ''
  return [markerOf(key), ...(signature !== '' ? [signature] : [])]
}

const STATE_WORDS: Readonly<Record<'open' | 'repaired' | 'withdrawn', string>> = {
  open: 'Still open',
  repaired: 'Repair confirmed',
  withdrawn: 'Withdrawn',
}

/**
 * An operation's body, rendered from the immutable evidence it names; null
 * when that evidence cannot be read, which refuses rather than posting
 * something else. The same evidence always renders the same body.
 */
export const renderBody = (entry: Pick<PublicationEntry, 'key' | 'evidence'> & { readonly finding?: string; readonly review?: string }, sources: BodySources): string | null => {
  const event = sources.records.get(entry.evidence[0] ?? '')
  if (!event) return null
  const seat = event.seat ? sources.seat(event.seat) : null
  const lines = opening(entry.key, seat, sources.template)
  const where = event.fact.kind === 'finding' || event.fact.kind === 'review' ? event.fact.at : null
  if (!where) return null
  if (entry.review !== undefined) {
    if (event.fact.kind !== 'review') return null
    const raised = entry.evidence.slice(1).map((id) => sources.records.get(id))
    if (raised.some((one) => !one || one.fact.kind !== 'finding')) return null
    const count = raised.length
    lines.push(
      `**Review** · ${inert(event.fact.verdict)}`,
      '',
      `${whoOf(seat)} reviewed ${short(where)} in round ${event.round ?? '?'} and raised ${count === 0 ? 'no findings' : count === 1 ? 'one finding' : `${count} findings`}.`,
      ...(count > 0 ? ['', ...raised.map((one) => `- ${one!.fact.kind === 'finding' ? one!.fact.id : ''}`)] : []),
    )
    return lines.join('\n')
  }
  const detail = event.finding
  if (!detail || event.fact.kind !== 'finding' || event.fact.id !== entry.finding) return null
  const round = detail.origin.round
  switch (detail.event.kind) {
    case 'raise': {
      const raise = detail.event
      lines.push(
        `**${inert(raise.title)}** · ${raise.category} · ${raise.blocking ? 'blocking' : 'advisory'}`,
        ...(raise.body.trim() !== '' ? ['', inert(raise.body)] : []),
        ...(raise.anchor ? ['', `\`${inert(raise.anchor.path)}\` line ${raise.anchor.line}, ${raise.anchor.side === 'LEFT' ? 'before' : 'after'} the change`] : []),
        '',
        `Raised by ${whoOf(seat)} at ${short(where)} · round ${round} · ${event.fact.id}`,
      )
      return lines.join('\n')
    }
    case 'repair':
      lines.push(
        `**Repair claimed** · ${event.fact.id}`,
        ...(detail.event.note.trim() !== '' ? ['', inert(detail.event.note)] : []),
        '',
        `Claimed by ${whoOf(seat)} at ${short(where)} · round ${event.round ?? '?'}. Not confirmed until the reviewer that raised it says so.`,
      )
      return lines.join('\n')
    case 'verdict':
      lines.push(
        `**${STATE_WORDS[detail.event.state]}** · ${event.fact.id}`,
        ...(detail.event.note.trim() !== '' ? ['', inert(detail.event.note)] : []),
        '',
        `Decided by ${detail.event.by === 'person' ? 'a person' : whoOf(seat)} at ${short(where)} · round ${event.round ?? '?'}`,
      )
      return lines.join('\n')
    default:
      return null
  }
}

// ------------------------------------------------------------------- binding

/** The pull request a Goal is bound to: host-observed `pr` evidence, never text anyone typed. */
export type BoundPullRequest =
  | { readonly kind: 'bound'; readonly repo: string; readonly pr: number }
  | { readonly kind: 'none'; readonly reason: string }

const PULL_URL = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/pull\/([1-9][0-9]*)$/

/** A pull request address as the forge reported it, confined to one repository's pull request. */
export const repositoryOf = (url: string | null, number: number): string | null => {
  const matched = url ? PULL_URL.exec(url) : null
  return matched && Number(matched[2]) === number ? matched[1]! : null
}

/** The Goal's bound pull request: the one open pull request its fresh `pr` evidence names, or why there is none. */
export const boundPullRequest = (facts: readonly EvidenceView[]): BoundPullRequest => {
  const open = facts.filter((view) => !view.record.restored && view.record.fact.kind === 'pr' && view.record.fact.state === 'open')
  const found = new Map<string, { repo: string; pr: number }>()
  for (const view of open) {
    const fact = view.record.fact as Extract<EvidenceRecord['fact'], { kind: 'pr' }>
    const repo = repositoryOf(fact.url, fact.number)
    if (!repo) return { kind: 'none', reason: 'The pull request the desk observed has an address it cannot confine to one repository, so this round stays on the desk.' }
    found.set(`${repo}#${fact.number}`, { repo, pr: fact.number })
  }
  if (found.size === 0) return { kind: 'none', reason: 'No open pull request is bound to this Goal, so this round stays on the desk.' }
  if (found.size > 1) return { kind: 'none', reason: 'This Goal’s evidence names more than one open pull request, so this round stays on the desk until a person picks one.' }
  const [only] = [...found.values()]
  return { kind: 'bound', ...only! }
}

// ------------------------------------------------------------------ planning

/** What a closed round's batch is planned from, read when the close is processed. */
export interface RoundPlanInput {
  readonly run: string
  readonly round: number
  readonly goal: string
  readonly project: string
  readonly cards: readonly number[]
  /** Every finding record of the project, in append order. */
  readonly findings: readonly EvidenceRecord[]
  /** The Goal's facts, each with its freshness now. */
  readonly facts: readonly EvidenceView[]
  /** The person's preference: false is off; absent is on for a bound pull request. */
  readonly preference: boolean | undefined
  readonly sources: BodySources
  readonly now: number
}

/**
 * A closed round's decision and every operation it releases, keyed before
 * anything is sent. Local when posting is off or no pull request is bound;
 * refused, whole, when one body or the batch is over its bound.
 */
export const planRound = (input: RoundPlanInput): { readonly round: PublicationRound; readonly entries: readonly PublicationEntry[] } => {
  const decided = (mode: PublicationRound['mode'], reason: string | null, bound: { repo: string; pr: number } | null, keys: readonly string[] = []): PublicationRound =>
    ({ round: input.round, mode, reason, repo: bound?.repo ?? null, pr: bound?.pr ?? null, keys, decidedAt: input.now })
  if (input.preference === false) return { round: decided('local', 'Posting is off for this Goal, so this round stays on the desk.', null), entries: [] }
  const bound = boundPullRequest(input.facts)
  if (bound.kind === 'none') return { round: decided('local', bound.reason, null), entries: [] }
  const inRound = (record: EvidenceRecord): boolean =>
    !record.restored && record.card?.board === input.goal && input.cards.includes(record.card.id)
  const events = input.findings.filter((record) => inRound(record) && record.fact.kind === 'finding' &&
    ['raise', 'repair', 'verdict'].includes(record.finding?.event.kind ?? ''))
  const reviews = input.facts.map((view) => view.record).filter((record) => inRound(record) && record.fact.kind === 'review')
  const entries: PublicationEntry[] = []
  const base = (key: string, record: EvidenceRecord, at: string) => ({
    key, run: input.run, round: input.round, project: input.project, repo: bound.repo, pr: bound.pr, at,
    actor: String(record.seat ?? ''), marker: markerOf(key), state: 'prepared' as const, location: null, reason: null,
    placement: null, expected: null, wrote: null,
  })
  for (const record of events) {
    const fact = record.fact
    if (fact.kind !== 'finding' || !record.seat) continue
    const key = publicationKey(input.run, input.round, 'finding', record.id)
    const raise = input.findings.find((one) => one.fact.kind === 'finding' && one.fact.id === fact.id && one.finding?.event.kind === 'raise')
    const evidence = raise && raise.id !== record.id ? [record.id, raise.id] : [record.id]
    const body = renderBody({ key, evidence, finding: fact.id }, input.sources)
    if (body === null) return { round: decided('refused', `A finding event of this round (${fact.id}) could not be read back, so nothing of it is posted.`, bound), entries: [] }
    entries.push({ ...base(key, record, fact.at), finding: fact.id, evidence, parent: null, digest: sha256(body) })
  }
  for (const record of reviews) {
    if (record.fact.kind !== 'review' || !record.seat) continue
    const key = publicationKey(input.run, input.round, 'review', record.id)
    const raised = events.filter((one) => one.card?.id === record.card?.id && one.finding?.event.kind === 'raise').map((one) => one.id)
    const evidence = [record.id, ...raised]
    const body = renderBody({ key, evidence, review: record.id }, input.sources)
    if (body === null) return { round: decided('refused', 'A review of this round could not be read back, so nothing of it is posted.', bound), entries: [] }
    entries.push({ ...base(key, record, record.fact.at), review: record.id, evidence, digest: sha256(body) })
  }
  const findings = entries.filter(isFindingPublication).length
  if (findings > BATCH_LIMIT) {
    return { round: decided('refused', `This round has ${findings} findings to post, more than the ${BATCH_LIMIT} one batch may carry. Split the work into smaller reviews.`, bound), entries: [] }
  }
  for (const entry of entries) {
    const body = renderBody(entry as never, input.sources)!
    if (Buffer.byteLength(body, 'utf8') > BODY_LIMIT) {
      return { round: decided('refused', `One comment of this round would be over ${BODY_LIMIT / 1024} KiB. Split the finding into smaller ones.`, bound), entries: [] }
    }
  }
  if (entries.length === 0) return { round: decided('batch', null, bound), entries: [] }
  return { round: decided('batch', null, bound, entries.map((entry) => entry.key)), entries }
}

/** A finding view's first posting: the thread every later event of it goes to. */
export const rootOf = (view: FindingView | undefined): FindingPost | null => view?.posted[0] ?? null

// ---------------------------------------------------------------- publishing

/** A run as publishing reads it: its Goal, its rounds' cards, and finding commands still being saved. */
export interface PublishingRun {
  readonly goal: string
  readonly rounds: readonly { readonly n: number; readonly cards: readonly number[] }[]
  readonly pendingFindings: number
}

export interface PublicationsPort {
  /** One step inside `run`'s own queue, with its publication journal. */
  journal<T>(run: string, step: (journal: PublicationJournal) => Promise<T>): Promise<T>
  /** Every run with a publication journaled, and the Goal it is on. */
  runs(): readonly { readonly run: string; readonly goal: string }[]
  run(run: string): PublishingRun | null
  /** An operation by key, in whichever run journaled it: a snapshot read. */
  entry(key: string): PublicationEntry | null
  /**
   * A run's whole publication journal as it stands: a snapshot read that
   * takes no queue. What the Goal queue may read while it is held (a wrap
   * preview's gaps), and what a decision already inside the run's own queue
   * reads (its status), without waiting on that queue — see "Lock order" in
   * host.ts.
   */
  snapshot(run: string): StoredPublication | null
  /** True only once every card of the round is finished and its close is on disk. */
  roundClosed(run: string, round: number): boolean
  /** A Goal as posting reads it now; null when there is no such Goal. */
  goal(goal: string): { readonly open: boolean; readonly preference: boolean | undefined } | null
  projectOf(goal: string): Promise<string>
  facts(goal: string): Promise<readonly EvidenceView[]>
  /** The project's finding records and views, read under the ledger's own queue. */
  ledger(project: string): Promise<{ readonly records: readonly EvidenceRecord[]; readonly views: readonly FindingView[]; readonly unreadable: number }>
  seat(id: string): SeatRecord | null
  /** The person's review signature template, as the Git plugin's settings hold it. */
  template(): string
  /** The ledger's post event: idempotent by the operation key. */
  appendPost(input: { readonly goal: string; readonly finding: string; readonly operation: string; readonly location: FindingPost }): Promise<void>
  readonly forge: FindingForgePort
  now(): number
  log(message: string, details?: Readonly<Record<string, unknown>>): void
}

/** Stopped, or taken by another writer, between its check and its start: nothing was sent. */
class NotStarted extends Error {}

type Ready =
  | { readonly kind: 'skip' | 'pause'; readonly reason: string }
  | {
      readonly kind: 'go'
      readonly body: string
      readonly anchor: FindingAnchor | null
      readonly placement: Placement
      readonly parent: FindingPost | null
      readonly expected: string | null
      readonly wrote: string | null
    }

const UNSETTLED = new Set(['prepared', 'started', 'uncertain'])

/** What a person reads about an operation that did not end posted or skipped. */
export const gapOf = (entry: PublicationEntry): string => {
  const what = isFindingPublication(entry) ? `finding ${entry.finding}` : 'a review summary'
  const state = entry.state === 'uncertain' ? 'uncertain' : entry.state === 'started' ? 'unconfirmed' : 'not posted'
  return `Posting ${what} to pull request #${entry.pr} is ${state}${entry.reason ? `: ${entry.reason}` : '.'}`
}

/**
 * The publication queue: one operation at a time, desk-wide. Its durable
 * transitions take the run's queue (and the ledger's, for the post event)
 * only for the write itself, and hold neither across a remote call.
 */
export class Publications implements FindingPublisher {
  readonly #port: PublicationsPort
  #tail: Promise<unknown> = Promise.resolve()
  #pending = 0
  /** A failure that could not itself be written down, by run: said until the next attempt. */
  readonly #problems = new Map<string, string>()

  constructor(port: PublicationsPort) {
    this.#port = port
  }

  #enqueue<T>(work: () => Promise<T>): Promise<T> {
    this.#pending += 1
    const result = this.#tail.then(work)
    this.#tail = result.then(() => undefined, () => undefined).finally(() => { this.#pending -= 1 })
    return result
  }

  /** Resolves once every queued operation has settled. */
  async idle(): Promise<void> {
    while (this.#pending > 0) await this.#tail
  }

  /**
   * A round closed: journal its whole release decision and every operation
   * key, then queue the sends. Answers once the decision is on disk — the run
   * goes on without waiting for any forge. Before the round's close is on
   * disk, nothing is decided and nothing is sent.
   */
  async close(run: string, round: number): Promise<void> {
    const decision = await this.prepare(run, round)
    if (decision?.mode === 'batch' && decision.keys.length > 0) {
      void this.#enqueue(() => this.#drain(run, round)).catch((error: unknown) => this.#failed(run, error))
    }
  }

  /** The round's decision, journaled once; a replayed close finds it and plans nothing new. */
  async prepare(run: string, round: number): Promise<PublicationRound | null> {
    if (!this.#port.roundClosed(run, round)) return null
    const snapshot = this.#port.run(run)
    if (!snapshot) throw new Error(`There is no flow run ${run}.`)
    return this.#port.journal(run, async (journal) => {
      const existing = journal.round(round)
      if (existing) return existing
      // Read when the write runs: the run's queue is held, the ledger read under its own.
      const now = this.#port.run(run)
      if (!now) throw new Error(`There is no flow run ${run}.`)
      if (now.pendingFindings > 0) throw new Error('A finding of this run is still being saved, so its round cannot be released.')
      const closing = now.rounds.find((one) => one.n === round)
      if (!closing) throw new Error(`Run ${run} has no round ${round}.`)
      const project = await this.#port.projectOf(now.goal)
      const ledger = await this.#port.ledger(project)
      const facts = await this.#port.facts(now.goal)
      const goal = this.#port.goal(now.goal)
      const plan = planRound({
        run, round, goal: now.goal, project, cards: closing.cards, findings: ledger.records, facts,
        preference: goal?.preference, sources: this.#sources(ledger.records, facts), now: this.#port.now(),
      })
      await journal.decide(plan.round, plan.entries)
      return plan.round
    })
  }

  reconcile(run: string, round: number): Promise<void> {
    return this.#enqueue(() => this.#drain(run, round))
  }

  /** Every round of every run on this Goal worked to its end: posted, skipped, or left a stated gap. */
  async settleForWrap(goal: string): Promise<void> {
    for (const { run } of this.#port.runs().filter((one) => one.goal === goal)) {
      const rounds = await this.#port.journal(run, async (journal) =>
        [...new Set(journal.entries().map((entry) => entry.round))].sort((a, b) => a - b))
      for (const round of rounds) await this.reconcile(run, round)
    }
  }

  /**
   * What a wrap's receipt cannot vouch for: every operation on this Goal still
   * unsettled, said as a sentence. A snapshot read that takes no queue: the
   * Goal queue is held while it runs, and a run holding its own queue may be
   * waiting for that Goal queue to seat a card.
   */
  async gaps(goal: string): Promise<readonly string[]> {
    const out: string[] = []
    for (const { run } of this.#port.runs().filter((one) => one.goal === goal)) {
      const entries = Object.values(this.#port.snapshot(run)?.ops ?? {})
      out.push(...entries.filter((entry) => UNSETTLED.has(entry.state)).map(gapOf))
    }
    return out
  }

  /** A person's Stop: operations not yet sent are skipped; one already started is still read back, never rolled back. */
  async cancel(run: string, reason: string): Promise<void> {
    await this.#port.journal(run, async (journal) => {
      for (const entry of journal.entries()) {
        if (entry.state === 'prepared') await journal.put({ ...entry, state: 'skipped', reason })
      }
    })
  }

  // ------------------------------------------------------------ a person

  /**
   * What a person has to look at on this run's postings — each one paused,
   * started and never confirmed, or uncertain, with the desk's reason — and
   * what posting the rounds this run kept on the desk would release now,
   * keyed and stamped so a backfill posts exactly what was previewed.
   * Nothing here writes, and the postings are a snapshot read.
   */
  async needs(run: string): Promise<{
    readonly items: readonly PersonItem[]
    readonly backfill: { readonly pr: number; readonly rounds: readonly { readonly round: number; readonly findings: number; readonly reviews: number }[]; readonly stamp: string } | null
    readonly backfillRefusal: string | null
  }> {
    const stored = this.#port.snapshot(run)
    const items = Object.values(stored?.ops ?? {})
      .filter((entry) => entry.state === 'started' || entry.state === 'uncertain' || (entry.state === 'prepared' && entry.reason !== null))
      .sort((a, b) => a.round - b.round || (stored!.rounds[String(a.round)]?.keys.indexOf(a.key) ?? 0) - (stored!.rounds[String(b.round)]?.keys.indexOf(b.key) ?? 0))
      .map((entry): PersonItem => ({
        key: entry.key, round: entry.round, finding: isFindingPublication(entry) ? entry.finding : null,
        pr: entry.pr, state: entry.state as PersonItem['state'], reason: entry.reason,
      }))
    const plan = await this.#backfillPlan(run)
    if ('refusal' in plan) return { items, backfill: null, backfillRefusal: plan.refusal }
    return {
      items,
      backfill: {
        pr: plan.pr,
        rounds: plan.rounds.map((one) => ({
          round: one.round.round,
          findings: one.entries.filter(isFindingPublication).length,
          reviews: one.entries.filter((entry) => !isFindingPublication(entry)).length,
        })),
        stamp: plan.stamp,
      },
      backfillRefusal: null,
    }
  }

  /**
   * A person's "Post again". One that may have reached the pull request is
   * read back first: one exact copy is recorded where it is and never sent
   * again, several are refused for the person to look at, and none — with a
   * person having asked — is the one fresh attempt. One paused before any
   * send is checked again from the start and sent only if it now may be.
   * Journaled on the operation, in the publication queue.
   */
  postAgain(run: string, key: string): Promise<void> {
    return this.#enqueue(async () => {
      const entry = await this.#personal(run, key)
      if (!entry) return
      const at = this.#port.now()
      const person = { action: 'post-again' as const, reason: null, at }
      if (entry.state !== 'prepared' || entry.placement !== null) {
        const found = await this.#readBack(run, entry)
        if (found.length === 1) {
          await this.#land(run, entry, found[0]!, person)
          return
        }
        if (found.length > 1) {
          const reason = `The pull request shows ${found.length} copies of this. Look at them before deciding which one stands.`
          await this.#transition(run, key, ['prepared', 'started', 'uncertain'], (one) => ({ ...one, state: one.state === 'prepared' ? 'prepared' : 'uncertain', reason, person }))
          throw new Error(reason)
        }
      }
      // Never sent, or read back and not there: the person asked, so it starts again from its checks.
      await this.#transition(run, key, ['prepared', 'started', 'uncertain'], (one) => ({
        ...one, state: 'prepared', reason: null, placement: null, expected: null, wrote: null,
        ...(isFindingPublication(one) ? { parent: null } : {}), person,
      }))
      await this.#one(run, entry.round, key)
    })
  }

  /**
   * A person's "Skip": the operation is not posted, and the Goal's receipt
   * says so (`recordedGaps`). One that may have reached the pull request is
   * read back first — a copy there is recorded where it is, never dropped.
   */
  skip(run: string, key: string, reason: string): Promise<void> {
    const why = reason.trim()
    if (why === '' || why.length > 4096) return Promise.reject(new Error('Say why, in 1 to 4096 characters.'))
    return this.#enqueue(async () => {
      const entry = await this.#personal(run, key)
      if (!entry) return
      const person = { action: 'skip' as const, reason: why, at: this.#port.now() }
      let unknown = false
      if (entry.state !== 'prepared' || entry.placement !== null) {
        let found: readonly FindingPost[] = []
        try {
          found = await this.#readBack(run, entry)
        } catch {
          unknown = true
        }
        if (found.length === 1) {
          await this.#land(run, entry, found[0]!, person)
          return
        }
        if (found.length > 1 || entry.state !== 'prepared') unknown = true
      }
      await this.#transition(run, key, ['prepared', 'started', 'uncertain'], (one) => ({
        ...one, state: 'skipped', person,
        reason: `A person skipped this: ${why}${unknown ? ' It may or may not be on the pull request.' : ''}`,
      }))
    })
  }

  /**
   * Posts the rounds this run kept on the desk, exactly as a person
   * previewed them (`needs`): refused if anything that preview read has
   * changed since. Journaled before the first send; sent like any batch.
   */
  async backfill(run: string, stamp: string): Promise<void> {
    const plan = await this.#backfillPlan(run)
    if ('refusal' in plan) throw new Error(plan.refusal)
    if (plan.stamp !== stamp) throw new Error('What these rounds would post changed since you previewed them. Preview them again.')
    await this.#port.journal(run, async (journal) => {
      for (const one of plan.rounds) await journal.backfill(one.round, one.entries)
    })
    for (const one of plan.rounds) void this.#enqueue(() => this.#drain(run, one.round.round)).catch((error: unknown) => this.#failed(run, error))
  }

  /**
   * What a wrap records without asking again: every operation on this Goal a
   * person skipped, said as a sentence. A snapshot read, like `gaps`.
   */
  recordedGaps(goal: string): readonly string[] {
    const out: string[] = []
    for (const { run } of this.#port.runs().filter((one) => one.goal === goal)) {
      for (const entry of Object.values(this.#port.snapshot(run)?.ops ?? {})) {
        if (entry.state !== 'skipped' || entry.person?.action !== 'skip') continue
        const what = isFindingPublication(entry) ? `finding ${entry.finding}` : 'a review summary'
        out.push(`Posting ${what} to pull request #${entry.pr} was skipped. ${entry.reason ?? ''}`.trim())
      }
    }
    return out
  }

  /** The operation a person acts on, on a Goal still open; null when it is already posted or skipped. */
  async #personal(run: string, key: string): Promise<PublicationEntry | null> {
    const entry = await this.#read(run, key)
    if (!entry) throw new Error('There is no such posting on this run.')
    if (entry.state === 'posted' || entry.state === 'skipped') return null
    const snapshot = this.#port.run(run)
    if (!snapshot) throw new Error(`There is no flow run ${run}.`)
    if (!this.#port.goal(snapshot.goal)?.open) throw new Error('This Goal is wrapped. Its receipt froze what was posted; nothing more is sent for it.')
    return entry
  }

  /** Every exact copy of an operation the pull request holds; a read that could not finish is left uncertain, with why. */
  async #readBack(run: string, entry: PublicationEntry): Promise<readonly FindingPost[]> {
    try {
      return await this.#port.forge.find(entry)
    } catch (error) {
      const reason = `The desk could not read the pull request back to see whether this was posted (${error instanceof Error ? error.message : String(error)}).`
      if (entry.state !== 'prepared') await this.#transition(run, entry.key, ['started', 'uncertain'], (one) => ({ ...one, state: 'uncertain', reason }))
      throw new Error(reason)
    }
  }

  /** A copy found on the pull request: its post event first, then the operation posted where it is. */
  async #land(run: string, entry: PublicationEntry, location: FindingPost, person: NonNullable<PublicationEntry['person']>): Promise<void> {
    const snapshot = this.#port.run(run)
    if (snapshot && isFindingPublication(entry)) {
      await this.#port.appendPost({ goal: snapshot.goal, finding: entry.finding, operation: entry.key, location })
    }
    await this.#transition(run, entry.key, ['prepared', 'started', 'uncertain'], (one) => ({ ...one, state: 'posted', location, reason: null, person }))
  }

  /** The batch each round this run kept on the desk would post now, keyed and stamped; or why none may. */
  async #backfillPlan(run: string): Promise<
    | { readonly pr: number; readonly rounds: readonly { readonly round: PublicationRound; readonly entries: readonly PublicationEntry[] }[]; readonly stamp: string }
    | { readonly refusal: string }
  > {
    const snapshot = this.#port.run(run)
    if (!snapshot) return { refusal: `There is no flow run ${run}.` }
    const stored = this.#port.snapshot(run)
    const local = Object.values(stored?.rounds ?? {}).filter((one) => one.mode === 'local').sort((a, b) => a.round - b.round)
    if (local.length === 0) return { refusal: 'Every closed round of this run was posted or refused when it closed; none is kept on the desk.' }
    const goal = this.#port.goal(snapshot.goal)
    if (!goal?.open) return { refusal: 'This Goal is wrapped. Its receipt froze what was posted; nothing more is sent for it.' }
    const project = await this.#port.projectOf(snapshot.goal)
    const ledger = await this.#port.ledger(project)
    const facts = await this.#port.facts(snapshot.goal)
    const rounds: { round: PublicationRound; entries: readonly PublicationEntry[] }[] = []
    for (const kept of local) {
      const closing = snapshot.rounds.find((one) => one.n === kept.round)
      if (!closing) continue
      const plan = planRound({
        run, round: kept.round, goal: snapshot.goal, project, cards: closing.cards, findings: ledger.records, facts,
        preference: goal.preference, sources: this.#sources(ledger.records, facts), now: this.#port.now(),
      })
      if (plan.round.mode !== 'batch') return { refusal: plan.round.reason ?? 'These rounds cannot be posted now.' }
      if (plan.entries.length === 0) continue
      rounds.push({ round: { ...plan.round, backfilled: { at: plan.round.decidedAt, from: kept.reason } }, entries: plan.entries })
    }
    if (rounds.length === 0) return { refusal: 'The rounds kept on the desk have nothing to post.' }
    const pr = rounds[0]!.round.pr!
    const stamp = sha256(JSON.stringify(rounds.map((one) => [one.round.round, one.round.repo, one.round.pr, one.entries.map((entry) => [entry.key, entry.digest])])))
    return { pr, rounds, stamp }
  }

  /** After a restart: every round with work left is queued again — a started send is read back, never repeated. */
  async recover(): Promise<void> {
    for (const { run } of this.#port.runs()) {
      const rounds = await this.#port.journal(run, async (journal) => [...new Set(journal.entries()
        .filter((entry) => entry.state === 'started' || entry.state === 'uncertain' || (entry.state === 'prepared' && entry.reason === null))
        .map((entry) => entry.round))].sort((a, b) => a - b))
      for (const round of rounds) void this.#enqueue(() => this.#drain(run, round)).catch((error: unknown) => this.#failed(run, error))
    }
  }

  /** Where a run's publications stand, for the person, and the first reason one needs them. */
  async status(run: string): Promise<{ readonly publication: 'local' | 'pending' | 'posted' | 'partial' | 'uncertain'; readonly reason: string | null }> {
    if (!this.#port.runs().some((one) => one.run === run)) return { publication: 'local', reason: this.#problems.get(run) ?? null }
    // A snapshot: a person's decision reads this from inside the run's own queue.
    const stored = this.#port.snapshot(run)
    const rounds = this.#port.run(run)?.rounds.map((one) => stored?.rounds[String(one.n)] ?? null)
      .filter((one): one is PublicationRound => one !== null) ?? []
    const entries = Object.values(stored?.ops ?? {})
    const problem = this.#problems.get(run) ?? entries.find((entry) => entry.reason !== null && entry.state !== 'posted')?.reason ??
      rounds.find((one) => one.mode === 'refused')?.reason ?? null
    if (entries.length === 0) return { publication: 'local', reason: problem }
    if (entries.some((entry) => entry.state === 'uncertain')) return { publication: 'uncertain', reason: problem }
    if (entries.some((entry) => entry.state === 'started' || (entry.state === 'prepared' && entry.reason === null))) return { publication: 'pending', reason: problem }
    if (entries.every((entry) => entry.state === 'posted')) return { publication: 'posted', reason: problem }
    return { publication: 'partial', reason: problem }
  }

  #failed(run: string, error: unknown): void {
    const why = error instanceof Error ? error.message : String(error)
    this.#problems.set(run, `Posting this run's findings stopped: ${why}`)
    this.#port.log('posting a closed round stopped', { run, error: why })
  }

  #sources(records: readonly EvidenceRecord[], facts: readonly EvidenceView[]): BodySources {
    const byId = new Map<string, EvidenceRecord>()
    for (const record of records) byId.set(record.id, record)
    for (const view of facts) byId.set(view.record.id, view.record)
    return { records: byId, seat: (id) => this.#port.seat(id), template: this.#port.template() }
  }

  async #read(run: string, key: string): Promise<PublicationEntry | null> {
    return this.#port.journal(run, async (journal) => journal.entry(key))
  }

  /** Writes `next` only if the operation is still in `from`; answers whether it did. */
  async #transition(run: string, key: string, from: readonly PublicationEntry['state'][], next: (entry: PublicationEntry) => PublicationEntry): Promise<boolean> {
    return this.#port.journal(run, async (journal) => {
      const entry = journal.entry(key)
      if (!entry || !from.includes(entry.state)) return false
      await journal.put(next(entry))
      return true
    })
  }

  async #drain(run: string, round: number): Promise<void> {
    const decision = await this.#port.journal(run, async (journal) => journal.round(round))
    if (!decision || decision.mode !== 'batch') return
    this.#problems.delete(run)
    for (const key of decision.keys) await this.#one(run, round, key)
  }

  async #one(run: string, round: number, key: string): Promise<void> {
    const first = await this.#read(run, key)
    if (!first || first.state === 'posted' || first.state === 'skipped') return
    // Paused for a person — a moved head, an edited comment, an unreadable target: never resumed on its own.
    if (first.state === 'prepared' && first.reason !== null) return
    const snapshot = this.#port.run(run)
    if (!snapshot) return
    // A wrapped Goal's receipt froze what was known: no automatic writer appends to it afterwards, not even a read-back.
    if (first.state !== 'prepared' && !this.#port.goal(snapshot.goal)?.open) return
    let ready: Extract<Ready, { kind: 'go' }> | null = null
    if (first.state === 'prepared') {
      const decided = await this.#ready(first, snapshot.goal)
      if (decided.kind !== 'go') {
        await this.#transition(run, key, ['prepared'], (entry) => ({ ...entry, state: decided.kind === 'skip' ? 'skipped' : 'prepared', reason: decided.reason }))
        return
      }
      ready = decided
    }
    let stage: 'find' | 'send' | 'finish' | null = null
    let found: readonly FindingPost[] = []
    let sent: FindingPost | null = null
    const current = async (): Promise<PublicationEntry> => {
      const entry = await this.#read(run, key)
      if (!entry) throw new NotStarted()
      return entry
    }
    try {
      const result = await publishOnce({
        closed: async () => this.#port.roundClosed(run, round),
        phase: async () => {
          const entry = await current()
          return entry.state === 'posted' ? 'posted' : entry.state === 'prepared' ? 'new' : 'started'
        },
        start: async () => {
          if (!ready) throw new NotStarted()
          const go = ready
          // On disk before the send; taken only if nobody stopped it since it was checked.
          const started = await this.#transition(run, key, ['prepared'], (entry) => entry.reason !== null ? entry : ({
            ...entry, state: 'started', reason: null, placement: go.placement, expected: go.expected, wrote: go.wrote,
            ...(isFindingPublication(entry) ? { parent: go.parent } : {}),
          }))
          const now = await current()
          if (!started || now.state !== 'started') throw new NotStarted()
        },
        find: async () => {
          stage = 'find'
          found = await this.#port.forge.find(await current())
          return found.map((post) => post.comment)
        },
        send: async () => {
          stage = 'send'
          sent = await this.#port.forge.send(await current(), ready!.body, ready!.placement === 'inline' ? ready!.anchor : null)
          return sent.comment
        },
        finish: async (comment) => {
          stage = 'finish'
          const entry = await current()
          const location = sent?.comment === comment ? sent : found.find((post) => post.comment === comment)
          if (!location) throw new Error('The posted comment could not be matched to what the forge answered.')
          if (isFindingPublication(entry)) {
            await this.#port.appendPost({ goal: snapshot.goal, finding: entry.finding, operation: entry.key, location })
          }
          await this.#transition(run, key, ['started', 'uncertain'], (one) => ({ ...one, state: 'posted', location, reason: null }))
        },
      })
      if (result === 'uncertain') {
        const reason = found.length === 0
          ? 'The desk may have posted this before it was interrupted, and the pull request shows no copy of it. Look at the pull request before posting it again.'
          : `The pull request shows ${found.length} copies of this. Look at them before deciding which one stands.`
        await this.#transition(run, key, ['started', 'uncertain'], (entry) => ({ ...entry, state: 'uncertain', reason }))
      }
    } catch (error) {
      if (error instanceof NotStarted) return
      const why = error instanceof Error ? error.message : String(error)
      if (stage === 'send' && error instanceof PublicationConflict) {
        // Refused before anything was written: the comment is as the person left it.
        await this.#transition(run, key, ['started'], (entry) => ({ ...entry, state: 'prepared', reason: why }))
        return
      }
      if (stage === 'send' || stage === 'find') {
        const reason = stage === 'send'
          ? `Posting this may or may not have reached the pull request (${why}). Look at the pull request before posting it again.`
          : `The desk could not read the pull request back to see whether this was posted (${why}).`
        await this.#transition(run, key, ['started', 'uncertain'], (entry) => ({ ...entry, state: 'uncertain', reason }))
          .catch((stuck: unknown) => this.#failed(run, stuck))
        return
      }
      // The comment is on the forge, and recording where failed: the next reconcile reads it back and records it once.
      this.#failed(run, new Error(`a posted comment could not be recorded yet (${why}); it will be read back`))
    }
  }

  /** Everything an operation needs checked before it starts, read now; nothing here writes to the forge. */
  async #ready(entry: PublicationEntry, goal: string): Promise<Ready> {
    const pause = (reason: string): Ready => ({ kind: 'pause', reason })
    const skip = (reason: string): Ready => ({ kind: 'skip', reason })
    const state = this.#port.goal(goal)
    if (!state?.open) return skip('The Goal was wrapped before this was posted, so it stays on the desk.')
    if (state.preference === false) return skip('Posting was turned off for this Goal before this was sent.')
    const ledger = await this.#port.ledger(entry.project)
    const facts = await this.#port.facts(goal)
    const body = renderBody(entry as never, this.#sources(ledger.records, facts))
    if (body === null || sha256(body) !== entry.digest) {
      return pause('What this would post changed since its round closed, so it was not sent. A person has to post it again.')
    }
    let target: ObservedTarget
    try {
      target = await this.#port.forge.observeTarget(entry.project, entry.pr)
    } catch (error) {
      return pause(`The pull request could not be read, so nothing was sent (${error instanceof Error ? error.message : String(error)}).`)
    }
    if (target.repo !== entry.repo || target.number !== entry.pr) {
      return pause('The forge answered with another pull request than the one this Goal is bound to, so nothing was sent.')
    }
    if (target.state !== 'open') return skip(`Pull request #${entry.pr} is ${target.state}, so this stays on the desk.`)
    if (target.head !== entry.at) {
      return pause(`Pull request #${entry.pr} moved from ${short(entry.at)} to ${short(target.head)} since this was reviewed, so it was not posted. A person has to look at it at the new head.`)
    }
    const general = { kind: 'go', body, anchor: null, placement: 'general', parent: null, expected: null, wrote: chainOf([body]) } as const
    if (!isFindingPublication(entry)) return general
    const view = ledger.views.find((one) => one.id === entry.finding)
    if (!view) return pause('This finding could not be read back, so nothing was sent.')
    const event = ledger.records.find((record) => record.id === entry.evidence[0])?.finding?.event
    if (event?.kind === 'raise') {
      if (!view.anchor) return general
      let inline: boolean
      try {
        inline = await this.#port.forge.anchorable(entry, view.anchor)
      } catch (error) {
        return pause(`The pull request's change could not be read to place this finding, so nothing was sent (${error instanceof Error ? error.message : String(error)}).`)
      }
      return inline ? { kind: 'go', body, anchor: view.anchor, placement: 'inline', parent: null, expected: null, wrote: null } : general
    }
    /* A later event goes to its finding's thread, which an earlier posting of
       it may still be settling — in an earlier round, or earlier in this same
       batch. Sent anyway, it would start a second thread, or append against
       a comment whose last write the desk cannot see yet and take its own
       landing for a person's edit. */
    const waiting = await this.#port.journal(entry.run, async (journal) => {
      const order = journal.round(entry.round)?.keys ?? []
      const earlier = (one: PublicationEntry): boolean => one.round < entry.round ||
        (one.round === entry.round && order.indexOf(one.key) >= 0 && order.indexOf(one.key) < order.indexOf(entry.key))
      return journal.entries().some((one) =>
        one.key !== entry.key && isFindingPublication(one) && one.finding === entry.finding && earlier(one) && UNSETTLED.has(one.state))
    })
    if (waiting) return pause('An earlier posting of this finding has not settled, so this waits for a person rather than starting a second thread.')
    const root = rootOf(view)
    if (!root || root.repo !== entry.repo || root.pr !== entry.pr) return general
    if (root.kind === 'review-comment') return { kind: 'go', body, anchor: null, placement: 'reply', parent: root, expected: null, wrote: null }
    const last = [...view.posted].reverse().find((post) => post.comment === root.comment)
    const expected = last ? this.#port.entry(last.operation)?.wrote ?? null : null
    if (!expected) return pause('The desk cannot tell what it last wrote to this finding’s comment, so it was not changed. A person has to look at it.')
    return { kind: 'go', body, anchor: null, placement: 'append', parent: root, expected, wrote: sha256(`${expected}\u0000${body}`) }
  }
}
