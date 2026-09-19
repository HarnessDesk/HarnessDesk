import { randomUUID } from 'node:crypto'

import type {
  CheckRun,
  Evidence,
  EvidenceRecord,
  Restored,
  SeatCandidate,
  SeatCeiling,
  SeatRecord,
  StandingOrder,
} from '@harnessdesk/protocol'

/**
 * What a stored line may say, and the one set of rules that reads one.
 *
 * The evidence store is append-only NDJSON, and every reader of it — the store
 * reading its own files, a backup being restored — goes through `lineOf`, with
 * where the line is being read: which of a project's two files, and whose.
 * One rule, used everywhere: a restore that admitted a line the store would
 * then skip, or the other way round, is two desks that disagree about what was
 * observed. So the rule is contextual — a Seat line read from the facts file,
 * or a Seat kept under another project than the one reading it, is no line at
 * all — and bounded: every string, list and line has a limit, so a record
 * cannot cost more to read than a record is worth.
 *
 * A line this build cannot read — damaged, too large, in the wrong file, or
 * written by a newer build in a shape it does not know — is skipped, and
 * counted by whoever read it. It is never rewritten: the store is
 * append-only, and a later build may read it.
 */

/** The only version of a line this build writes and reads. */
export const LINE_VERSION = 1

/** A project's two files: every Seat's opening and closing, and every fact. */
export type StoreFile = 'seats' | 'evidence'

/** Where a line is being read: which file, of which project. */
export interface LineWhere {
  readonly file: StoreFile
  readonly project: string
}

/** The most one written line may weigh, in bytes: one record, never a document. */
export const LINE_LIMIT = 64 * 1024

/** The most of what a check printed that a record keeps: enough to say why it failed. */
export const TAIL_LIMIT = 4_000

/** The longest command a record keeps. A flow's check step may say more than a checks file allows. */
const RUN_LIMIT = 8_192

/** Any other string a record holds — a name, a label, a path, a link. */
const TEXT_LIMIT = 4_096

/** The longest id: a UUID, with room to spare. */
const ID_LIMIT = 200

/** The most candidates one Seat may have passed over, checks one CI run may report, and revisions a review may name. */
const PASSED_OVER_LIMIT = 64
const CI_LIMIT = 500
const AGAINST_LIMIT = 64

/** The opening of a Seat: everything its record says but how it ended. */
export type SeatOpening = Omit<SeatRecord, 'closed'>

/** The one closing a Seat gets. */
export interface SeatClosing {
  readonly seat: string
  readonly at: number
  readonly why: string
}

/** One line of a store, as this build reads it. */
export type StoredLine =
  | { readonly type: 'seat'; readonly record: SeatOpening }
  | { readonly type: 'seat-closed'; readonly closing: SeatClosing }
  | { readonly type: 'evidence'; readonly record: EvidenceRecord }

/** A new record's id. */
export const mintId = (): string => randomUUID()

/** A full commit id: 40 hex characters, or 64 in a SHA-256 repository. Lower case, as git prints it. */
export const isSha = (value: unknown): value is string =>
  typeof value === 'string' && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value)

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
const isText = (value: unknown): value is string => typeof value === 'string' && value.length <= TEXT_LIMIT
const isFilled = (value: unknown): value is string => isText(value) && value.trim() !== ''
const isId = (value: unknown): value is string => isFilled(value) && value.length <= ID_LIMIT
const isListOf = (value: unknown, limit: number, read: (value: unknown) => boolean): boolean =>
  Array.isArray(value) && value.length <= limit && value.every(read)
const isInteger = (value: unknown): value is number => Number.isInteger(value)
const isCount = (value: unknown): value is number => isInteger(value) && value >= 0
const isTime = (value: unknown): value is number => Number.isFinite(value) && (value as number) >= 0
const orNull = <T>(value: unknown, read: (value: unknown) => value is T): value is T | null =>
  value === null || read(value)
const optionalNull = <T>(value: unknown, read: (value: unknown) => value is T): value is T | null | undefined =>
  value === undefined || value === null || read(value)

const LEVELS = new Set(['read', 'edit', 'publish', 'merge'])
const HOLDS = new Set(['held', 'asked'])
const PERMISSIONS = new Set(['read', 'publish', 'merge'])
const ORIGINS = new Set(['project', 'user', 'builtin'])

const isCeiling = (value: unknown): value is SeatCeiling =>
  isRecord(value) && LEVELS.has(value['level'] as string) && HOLDS.has(value['hold'] as string)

/** Either generation of a standing order, as it said itself — and nothing that is neither. */
const isStanding = (value: unknown): value is StandingOrder =>
  isRecord(value) &&
  ((value['kind'] === 'permission' && PERMISSIONS.has(value['permission'] as string)) ||
    (value['kind'] === 'ceiling' && LEVELS.has(value['level'] as string)))

const isRestored = (value: unknown): value is Restored => isRecord(value) && isTime(value['at'])

const isSeat = (value: unknown): boolean =>
  isRecord(value) &&
  isFilled(value['runtime']) &&
  optionalNull(value['model'], isText) &&
  optionalNull(value['effort'], isText) &&
  (value['thinking'] === undefined || typeof value['thinking'] === 'boolean')

/**
 * A candidate passed over, as far as a record needs to trust it: the words a
 * surface shows and the state. Its reason and fix are drawn only after a
 * surface reads them by kind, so a kind this build does not know is shown as
 * no reason rather than refused.
 */
const isCandidate = (value: unknown): value is SeatCandidate =>
  isRecord(value) && isSeat(value['seat']) && isText(value['label']) && isText(value['runtimeName']) && isText(value['state'])

/** The opening of a Seat, or null when the line does not hold one this build can read. */
export const seatOpeningOf = (value: unknown): SeatOpening | null => {
  if (!isRecord(value)) return null
  const agent = value['agent']
  const checkout = value['checkout']
  const session = value['session']
  const ok =
    isId(value['id']) &&
    (agent === null ||
      (isRecord(agent) && isId(agent['id']) && isText(agent['name']) && ORIGINS.has(agent['origin'] as string))) &&
    orNull(value['briefDigest'], isId) &&
    isSeat(value['seat']) &&
    isText(value['seatLabel']) &&
    isListOf(value['passedOver'], PASSED_OVER_LIMIT, isCandidate) &&
    // The seam with phase 3: the standing order in either generation's words,
    // and the ceiling it ran under — present on every record, null until phase 3.
    isStanding(value['standing']) &&
    'ceiling' in value &&
    orNull(value['ceiling'], isCeiling) &&
    isRecord(checkout) &&
    isFilled(checkout['cwd']) &&
    isFilled(checkout['project']) &&
    orNull(checkout['branch'], isFilled) &&
    orNull(checkout['head'], isSha) &&
    isRecord(session) &&
    isFilled(session['runtime']) &&
    isFilled(session['sessionId']) &&
    orNull(value['board'], isFilled) &&
    orNull(value['role'], isFilled) &&
    isTime(value['openedAt']) &&
    optionalNull(value['restored'], isRestored)
  return ok ? (value as unknown as SeatOpening) : null
}

export const seatClosingOf = (value: unknown): SeatClosing | null =>
  isRecord(value) && isId(value['seat']) && isTime(value['at']) && isFilled(value['why'])
    ? (value as unknown as SeatClosing)
    : null

const CHECK_STATES = new Set(['pending', 'passed', 'failed', 'skipped', 'cancelled'])
const isCheckRun = (value: unknown): value is CheckRun =>
  isRecord(value) && isText(value['name']) && CHECK_STATES.has(value['state'] as string) && orNull(value['url'], isText)

/** One fact, by kind. A kind this build does not know is not a fact it can read. */
export const factOf = (value: unknown): Evidence | null => {
  if (!isRecord(value)) return null
  const ok = (() => {
    switch (value['kind']) {
      case 'check':
        return (
          isFilled(value['name']) &&
          typeof value['run'] === 'string' &&
          value['run'].trim() !== '' &&
          value['run'].length <= RUN_LIMIT &&
          orNull(value['exit'], isInteger) &&
          typeof value['timedOut'] === 'boolean' &&
          isSha(value['at']) &&
          typeof value['dirty'] === 'boolean' &&
          typeof value['tail'] === 'string' &&
          value['tail'].length <= TAIL_LIMIT
        )
      case 'ci':
        return isListOf(value['checks'], CI_LIMIT, isCheckRun) && isSha(value['at'])
      case 'review':
        return (
          isFilled(value['verdict']) &&
          isId(value['by']) &&
          isSha(value['at']) &&
          (value['against'] === undefined || isListOf(value['against'], AGAINST_LIMIT, isSha))
        )
      case 'pr':
        return (
          isCount(value['number']) &&
          isSha(value['head']) &&
          ['open', 'merged', 'closed'].includes(value['state'] as string) &&
          orNull(value['url'], isText)
        )
      case 'diff':
        return (
          isCount(value['files']) &&
          isCount(value['added']) &&
          isCount(value['removed']) &&
          isSha(value['from']) &&
          isSha(value['to'])
        )
      case 'finding':
        return (
          isId(value['id']) && ['open', 'repaired', 'withdrawn'].includes(value['state'] as string) && isSha(value['at'])
        )
      case 'spend':
        return Number.isFinite(value['usd']) && isCount(value['turns']) && typeof value['exact'] === 'boolean'
      default:
        return false
    }
  })()
  return ok ? (value as unknown as Evidence) : null
}

export const evidenceRecordOf = (value: unknown): EvidenceRecord | null => {
  if (!isRecord(value)) return null
  const card = value['card']
  const checkout = value['checkout']
  const posted = value['posted']
  const ok =
    isId(value['id']) &&
    factOf(value['fact']) !== null &&
    (card === undefined || card === null || (isRecord(card) && isId(card['board']) && isCount(card['id']))) &&
    (checkout === undefined ||
      checkout === null ||
      (isRecord(checkout) && isFilled(checkout['cwd']) && orNull(checkout['branch'], isFilled))) &&
    optionalNull(value['seat'], isId) &&
    optionalNull(value['round'], isCount) &&
    isTime(value['observedAt']) &&
    (posted === undefined || posted === null || (isRecord(posted) && isCount(posted['pr']) && isCount(posted['comment']))) &&
    optionalNull(value['restored'], isRestored)
  return ok ? (value as unknown as EvidenceRecord) : null
}

/**
 * One stored line, parsed and checked where it is read, or null when this
 * build cannot read it there: a Seat's lines belong to the seats file, facts
 * to the evidence file, and a Seat's opening to the project its checkout
 * belongs to. The store reads with this, and so does a restore.
 */
export const lineOf = (value: unknown, where: LineWhere): StoredLine | null => {
  if (!isRecord(value) || value['v'] !== LINE_VERSION) return null
  switch (value['type']) {
    case 'seat': {
      if (where.file !== 'seats') return null
      const record = seatOpeningOf(value['record'])
      return record && record.checkout.project === where.project ? { type: 'seat', record } : null
    }
    case 'seat-closed': {
      if (where.file !== 'seats') return null
      const closing = seatClosingOf(value['closing'])
      return closing ? { type: 'seat-closed', closing } : null
    }
    case 'evidence': {
      if (where.file !== 'evidence') return null
      const record = evidenceRecordOf(value['record'])
      return record ? { type: 'evidence', record } : null
    }
    default:
      return null
  }
}

/** A line as it is written: one JSON object and a line feed. */
export const lineText = (line: StoredLine): string => `${JSON.stringify({ v: LINE_VERSION, ...line })}\n`

/** The id a stored line is known by, for a restore that must not write one twice. */
export const idOfLine = (line: StoredLine): string =>
  line.type === 'seat-closed' ? `closed:${line.closing.seat}` : line.record.id

/**
 * Every Seat, with how it ended. A second closing of the same seat changes
 * nothing: the first one is when the desk let it go.
 */
export const foldSeats = (lines: readonly StoredLine[]): SeatRecord[] => {
  const closings = new Map<string, SeatClosing>()
  for (const line of lines) {
    if (line.type === 'seat-closed' && !closings.has(line.closing.seat)) closings.set(line.closing.seat, line.closing)
  }
  const seen = new Set<string>()
  const out: SeatRecord[] = []
  for (const line of lines) {
    if (line.type !== 'seat' || seen.has(line.record.id)) continue
    seen.add(line.record.id)
    const closing = closings.get(line.record.id)
    out.push({ ...line.record, closed: closing ? { at: closing.at, why: closing.why } : null })
  }
  return out
}

/**
 * What makes two facts about one card the same question: a named check is its
 * own question, and every other kind is one question per card.
 */
export const factKey = (fact: Evidence): string => {
  switch (fact.kind) {
    case 'check':
      return `check:${fact.name}`
    case 'review':
      return `review:${fact.by}`
    case 'finding':
      return `finding:${fact.id}`
    default:
      return fact.kind
  }
}
