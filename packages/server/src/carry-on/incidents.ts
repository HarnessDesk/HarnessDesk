import { createHash, randomInt, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open } from 'node:fs/promises'
import { isDeepStrictEqual } from 'node:util'
import {
  CARRY_ON_OWNERS,
  CARRY_ON_PHASES,
  CARRY_ON_STATES,
  type CarryOnCause,
  type CarryOnMode,
  type CarryOnOwner,
  type CarryOnPhase,
  type CarryOnScope,
  type CarryOnSide,
  type CarryOnState,
} from '@harnessdesk/protocol'
import { readBoundedJsonResult, writeAtomicJson } from '../lead/bounded-json.js'

/**
 * The durable half of recovering from a usage limit, shared by the Lead's chat
 * recovery and by carry-on: a bounded, atomically written ledger of records,
 * the backoff for a throttle, and the jitter that keeps a retry just after a
 * reset rather than on it.
 *
 * Claim before sending is the rule both callers keep: a record is on disk
 * before anything leaves, so a crash after a claim asks the person rather than
 * replaying a send nobody can vouch for.
 */

/** How many automatic retries a throttle gets on the same account before it is treated as a limit. */
export const RETRY_ATTEMPTS = 2
/** The backoff for those retries: one minute, then five. */
export const BACKOFF_MS = [60_000, 300_000] as const
/** Records a ledger keeps; the oldest goes first. */
export const INCIDENT_LIMIT = 64
const RESET_JITTER_MIN_MS = 250, RESET_JITTER_MAX_MS = 1250
const MAX_FILE_BYTES = 256 * 1024

/** A moment just after a reset, so a retry does not arrive while the window is still closing. */
export const afterReset = (resetsAt: number): number => resetsAt + randomInt(RESET_JITTER_MIN_MS, RESET_JITTER_MAX_MS + 1)

/** A timer that never keeps the process alive, clamped to what `setTimeout` can hold. */
export const scheduleTimer = (run: () => void, delay: number): (() => void) => {
  const timer = setTimeout(run, Math.min(Math.max(0, delay), 2_147_483_647)); timer.unref()
  return () => clearTimeout(timer)
}

export const isTimestamp = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0

export interface IncidentLedgerOptions<T> {
  readonly file: string
  readonly keyOf: (record: T) => string
  readonly valid: (value: unknown) => value is T
  /** Extra fields the file carries beside `version` and `records`, written as given. */
  readonly header?: () => Readonly<Record<string, unknown>>
  /** Whether a well-formed file's header belongs here; one that does not is ignored, not reported. */
  readonly accepts?: (file: Readonly<Record<string, unknown>>) => boolean
  /** Shapes a record as it is read, after validation. */
  readonly adopt?: (record: T) => T
  /** Called for a record the cap pushes out, so its timers and claims go with it. */
  readonly evicted?: (key: string) => void
  readonly problem?: (reason: string) => void
  /** How the problems name this ledger, "Lead incidents", and one record of it, "Lead incident". */
  readonly label: string
  readonly recordLabel: string
  readonly limit?: number
}

/**
 * The records, keyed, in insertion order, and the file they live in. Not
 * serialised: each caller runs its writes through its own queue.
 */
export class IncidentLedger<T> {
  #records = new Map<string, T>()
  #loaded = false
  constructor(private readonly options: IncidentLedgerOptions<T>) {}

  get loaded(): boolean { return this.#loaded }
  get(key: string): T | undefined { return this.#records.get(key) }
  has(key: string): boolean { return this.#records.has(key) }
  values(): IterableIterator<T> { return this.#records.values() }
  get size(): number { return this.#records.size }

  async load(): Promise<void> {
    if (this.#loaded) return
    const { file, label, recordLabel, problem, keyOf, valid, accepts, adopt } = this.options
    const limit = this.options.limit ?? INCIDENT_LIMIT
    const read = await readBoundedJsonResult(file, MAX_FILE_BYTES)
    if (read.kind === 'missing') { this.#loaded = true; return }
    if (read.kind !== 'value') { problem?.(`${label} could not be read; starting empty.`); this.#loaded = true; return }
    const value = read.value as Record<string, unknown> | null
    const headerOk = !!value && typeof value === 'object' && value['version'] === 1 && Array.isArray(value['records']) &&
      Object.entries(this.options.header?.() ?? {}).every(([key, expected]) => typeof value[key] === typeof expected)
    if (!headerOk) {
      problem?.(`${label} were invalid; starting empty.`)
    } else if (!accepts || accepts(value!)) {
      let dropped = false
      for (const record of value!['records'] as unknown[]) {
        if (!valid(record) || this.#records.has(keyOf(record))) { dropped = true; continue }
        this.#records.set(keyOf(record), adopt ? adopt(record) : record)
        if (this.#records.size > limit) { this.#records.delete(this.#records.keys().next().value!); dropped = true }
      }
      if (dropped) problem?.(`Invalid or excess ${recordLabel} records were dropped.`)
    }
    this.#loaded = true
  }

  /** Writes the record as the newest, evicting the oldest past the cap; memory follows only a write that landed. */
  async save(record: T, replaces?: string): Promise<void> {
    const key = this.options.keyOf(record), limit = this.options.limit ?? INCIDENT_LIMIT
    const next = new Map(this.#records)
    if (replaces !== undefined && replaces !== key) next.delete(replaces)
    next.delete(key); next.set(key, record)
    const evicted: string[] = []
    while (next.size > limit) { const oldest = next.keys().next().value!; next.delete(oldest); evicted.push(oldest) }
    await writeAtomicJson(this.options.file, { version: 1, ...this.options.header?.(), records: [...next.values()] }, async () => {})
    this.#records = next
    for (const key of evicted) this.options.evicted?.(key)
  }
}

// ------------------------------------------------------------------ carry-on

/** One conversation, as the carry-on ledger keys it. */
export const carryOnKey = (runtime: string, sessionId: string): string => `${runtime}\u0000${sessionId}`

/**
 * A transcript marker the conversation could not take when it was written — its body released, or its turn not
 * started yet — kept with the incident until it can (`CarryOnService.reachable`).
 */
export interface CarryOnUnwritten {
  /** Stable across an insert followed by a failed ledger write; absent on older records. */
  readonly id?: string
  readonly runtime: string
  readonly sessionId: string
  readonly phase: CarryOnPhase
  readonly anchor?: { readonly kind: 'turn'; readonly turnId: string } | { readonly kind: 'continuation'; readonly operationId: string }
  readonly prospective?: true
  readonly snapshot?: { readonly cause: CarryOnCause; readonly from: CarryOnSide; readonly resetsAt: number | null }
  /** Reservation materialized into this one protected pending marker. */
  readonly receipt?: { readonly operationId: string; readonly incidentId: string; readonly incarnation: string; readonly ceilingBytes: number; readonly uncertain?: true }
  readonly to?: CarryOnSide
  readonly mode?: CarryOnMode
  readonly note?: string
  readonly link?: { readonly runtime: string; readonly sessionId: string }
}
/** Markers one record keeps waiting: more than one move writes. */
export const UNWRITTEN_LIMIT = 16
export const PENDING_GLOBAL_LIMIT = 64
export const CARRY_ON_LEDGER_BYTES = 240 * 1024
export class CarryOnCapacityError extends Error {}

/** The live states: an incident in one of these is still the conversation's. */
export const LIVE_STATES: ReadonlySet<CarryOnState> = new Set(['deciding', 'asked', 'waiting-reset', 'sending'])

export interface CarryOnRecord {
  readonly incidentId: string
  readonly runtime: string
  readonly sessionId: string
  readonly owner: CarryOnOwner
  readonly state: CarryOnState
  readonly cause: CarryOnCause
  /** The turn that failed; a second ended event for it opens nothing. */
  readonly turnId: string
  /** The agent (`slot.agent`, else the runtime) the stuck account belongs to. */
  readonly agent: string
  readonly from: CarryOnSide
  /** The model the conversation was on, by id. */
  readonly model?: string
  readonly resetsAt: number | null
  /** When a timer is due: a retry while `waiting-reset`, the reset fallback while `asked`. */
  readonly nextAt: number | null
  readonly openedAt: number
  readonly lastAt: number
  /** Runtimes already tried and refused for this incident. */
  readonly tried: readonly string[]
  readonly hops: number
  /** Throttle retries spent on the same account before this became an incident. */
  readonly backoff?: number
  /** Set while a throttle is being backed off: no card, no marker. */
  readonly throttle?: true
  readonly alwaysScope: CarryOnScope
  readonly to?: CarryOnSide
  readonly toRuntime?: string
  readonly mode?: CarryOnMode
  /** The other conversation of a handoff. */
  readonly link?: { readonly runtime: string; readonly sessionId: string }
  /** The conversation whose next turn decides whether the move held. */
  /**
   * The conversation whose next turn says whether a move held. `pending` until the continuation is actually sent
   * (a replacement Seat's packet waits behind its brief); `skip` the turns it already had then, never the continuation.
   */
  readonly watch?: { readonly runtime: string; readonly sessionId: string; readonly pending?: true; readonly skip?: readonly string[]; readonly turnId?: string }
  /** When the continuing turn was being sent; a restart after it never resends. */
  readonly turnStartedAt?: number
  readonly note?: string
  /**
   * Every failed turn this incident has answered, as `carryOnTurnKey`s. Kept with the record wherever it moves, so a
   * late second completion of a turn on the account it left still finds it answered.
   */
  readonly handled?: readonly string[]
  /** A send a restart could not confirm: it waits for the person's answer, never for a timer, across later restarts too. */
  readonly uncertain?: true
  /** Markers still to be written, oldest first. */
  readonly unwritten?: readonly CarryOnUnwritten[]
  readonly reservation?: { readonly id: string; readonly slots: number; readonly ceilingBytes: number; readonly action: 'move' | 'retry' | 'wait' | 'stop'; readonly stage: 'reserved' | 'effect' | 'awaitingReceipt'; readonly markerIds: readonly string[]; readonly incarnation?: string; readonly baseFileIdentity: string | null; readonly baseVersion: 1 }
}

/** Records whose outstanding work must survive a collision or eviction. */
export const protectedCarryOnRecord = (record: CarryOnRecord): boolean =>
  !!record.unwritten?.length || !!record.reservation || !!record.uncertain || !!record.watch || LIVE_STATES.has(record.state)

/** One failed turn of one conversation, as `CarryOnRecord.handled` fences it. */
export const carryOnTurnKey = (runtime: string, sessionId: string, turnId: string): string => `${runtime}\u0000${sessionId}\u0000${turnId}`
/** How many answered turns a record remembers: more than the hops it may take. */
export const HANDLED_LIMIT = 8

const short = (value: unknown, limit = 300): boolean => typeof value === 'string' && value.length > 0 && value.length <= limit
const optionalShort = (value: unknown, limit = 300): boolean => value === undefined || short(value, limit)
const side = (value: unknown): boolean => {
  const v = value as Record<string, unknown> | null
  return !!v && typeof v === 'object' && short(v['name'], 120) && optionalShort(v['model'], 200) && optionalShort(v['account'], 120)
}
const pointer = (value: unknown): boolean => {
  const v = value as Record<string, unknown> | null
  return !!v && typeof v === 'object' && short(v['runtime']) && short(v['sessionId'])
}
const WATCH_SKIP_LIMIT = 32
const watchOk = (value: unknown): boolean => {
  const v = value as Record<string, unknown> | null
  return pointer(value) && (v!['pending'] === undefined || v!['pending'] === true) &&
    optionalShort(v!['turnId']) && (v!['skip'] === undefined || Array.isArray(v!['skip']) && (v!['skip'] as unknown[]).length <= WATCH_SKIP_LIMIT && (v!['skip'] as unknown[]).every(entry => short(entry)))
}
const unwritten = (value: unknown): boolean => {
  const v = value as Record<string, unknown> | null
  return pointer(v) && optionalShort(v!['id'], 100) && (CARRY_ON_PHASES as readonly unknown[]).includes(v!['phase']) && (v!['to'] === undefined || side(v!['to'])) &&
    (v!['mode'] === undefined || v!['mode'] === 'sameThread' || v!['mode'] === 'handoff') && optionalShort(v!['note'], 300) &&
    (v!['link'] === undefined || pointer(v!['link'])) && anchorOk(v!['anchor']) && (v!['prospective'] === undefined || v!['prospective'] === true) && receiptOk(v!['receipt']) && snapshotOk(v!['snapshot'])
}
const anchorOk = (value: unknown): boolean => {
  if (value === undefined) return true
  const v = value as Record<string, unknown> | null
  return !!v && typeof v === 'object' && (v['kind'] === 'turn' && short(v['turnId']) || v['kind'] === 'continuation' && short(v['operationId'], 100))
}
const snapshotOk = (value: unknown): boolean => {
  if (value === undefined) return true
  const v = value as Record<string, unknown> | null
  return !!v && typeof v === 'object' && ['credits', 'rateLimit', 'blocked'].includes(v['cause'] as string) &&
    side(v['from']) && (v['resetsAt'] === null || isTimestamp(v['resetsAt']))
}
const receiptOk = (value: unknown): boolean => {
  if (value === undefined) return true
  const v = value as Record<string, unknown> | null
  return !!v && typeof v === 'object' && short(v['operationId'], 100) && short(v['incidentId'], 100) && short(v['incarnation']) &&
    Number.isInteger(v['ceilingBytes']) && (v['ceilingBytes'] as number) > 0 && (v['ceilingBytes'] as number) <= CARRY_ON_LEDGER_BYTES &&
    (v['uncertain'] === undefined || v['uncertain'] === true)
}
const reservationOk = (value: unknown): boolean => {
  if (value === undefined) return true
  const v = value as Record<string, unknown> | null
  return !!v && typeof v === 'object' && short(v['id'], 100) && ['move', 'retry', 'wait', 'stop'].includes(v['action'] as string) &&
    Number.isInteger(v['slots']) && (v['slots'] as number) >= 0 && (v['slots'] as number) <= 2 &&
    Number.isInteger(v['ceilingBytes']) && (v['ceilingBytes'] as number) > 0 && (v['ceilingBytes'] as number) <= CARRY_ON_LEDGER_BYTES &&
    ['reserved', 'effect', 'awaitingReceipt'].includes(v['stage'] as string) && Array.isArray(v['markerIds']) &&
    (v['markerIds'] as unknown[]).length >= (v['slots'] as number) && (v['markerIds'] as unknown[]).length <= 2 &&
    (v['markerIds'] as unknown[]).every(id => short(id, 100)) && new Set(v['markerIds'] as string[]).size === (v['markerIds'] as unknown[]).length &&
    optionalShort(v['incarnation']) && v['baseVersion'] === 1 && (v['baseFileIdentity'] === null || typeof v['baseFileIdentity'] === 'string' && /^[0-9a-f]{64}$/.test(v['baseFileIdentity']))
}

export const validCarryOnRecord = (value: unknown): value is CarryOnRecord => {
  const v = value as Record<string, unknown> | null
  return !!v && typeof v === 'object' &&
    short(v['incidentId'], 100) && short(v['runtime']) && short(v['sessionId']) && short(v['turnId']) && short(v['agent']) &&
    (CARRY_ON_OWNERS as readonly unknown[]).includes(v['owner']) && (CARRY_ON_STATES as readonly unknown[]).includes(v['state']) &&
    ['credits', 'rateLimit', 'blocked'].includes(v['cause'] as string) && side(v['from']) && optionalShort(v['model'], 200) &&
    (v['resetsAt'] === null || isTimestamp(v['resetsAt'])) && (v['nextAt'] === null || isTimestamp(v['nextAt'])) &&
    isTimestamp(v['openedAt']) && isTimestamp(v['lastAt']) &&
    Array.isArray(v['tried']) && (v['tried'] as unknown[]).length <= 16 && (v['tried'] as unknown[]).every(entry => short(entry)) &&
    Number.isInteger(v['hops']) && (v['hops'] as number) >= 0 && (v['hops'] as number) <= 16 &&
    (v['backoff'] === undefined || Number.isInteger(v['backoff']) && (v['backoff'] as number) >= 0 && (v['backoff'] as number) <= RETRY_ATTEMPTS) &&
    (v['throttle'] === undefined || v['throttle'] === true) &&
    (v['alwaysScope'] === 'desk' || v['alwaysScope'] === 'agent') &&
    (v['to'] === undefined || side(v['to'])) && optionalShort(v['toRuntime']) &&
    (v['mode'] === undefined || v['mode'] === 'sameThread' || v['mode'] === 'handoff') &&
    (v['link'] === undefined || pointer(v['link'])) && (v['watch'] === undefined || watchOk(v['watch'])) &&
    (v['turnStartedAt'] === undefined || isTimestamp(v['turnStartedAt'])) && optionalShort(v['note'], 300) &&
    (v['handled'] === undefined || Array.isArray(v['handled']) && (v['handled'] as unknown[]).length <= HANDLED_LIMIT &&
      (v['handled'] as unknown[]).every(entry => short(entry, 1000))) &&
    (v['uncertain'] === undefined || v['uncertain'] === true) && reservationOk(v['reservation']) &&
    (v['unwritten'] === undefined || Array.isArray(v['unwritten']) && (v['unwritten'] as unknown[]).length <= UNWRITTEN_LIMIT &&
      (v['unwritten'] as unknown[]).every(unwritten))
}

type CarryReservation = NonNullable<CarryOnRecord['reservation']>
const encodedBytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value), 'utf8')
const worstString = (length: number): string => '\0'.repeat(length)
const worstSide = { name: worstString(120), account: worstString(120), model: worstString(200) }
const worstPointer = { runtime: worstString(300), sessionId: worstString(300) }
const worstMarker = {
  id: worstString(100), ...worstPointer, phase: 'exhausted', to: worstSide, mode: 'sameThread', note: worstString(300),
  link: worstPointer, anchor: { kind: 'turn', turnId: worstString(300), operationId: worstString(100) }, prospective: true,
  receipt: { operationId: worstString(100), incidentId: worstString(100), incarnation: worstString(300), ceilingBytes: CARRY_ON_LEDGER_BYTES, uncertain: true },
  snapshot: { cause: 'rateLimit', from: worstSide, resetsAt: Number.MAX_SAFE_INTEGER },
}

/** Bound a pending receipt including its largest future turn ID and uncertainty flag. */
export const markerReceiptCeiling = (marker: CarryOnUnwritten): number => {
  if (!marker.receipt) return encodedBytes(marker)
  return encodedBytes({ ...marker, prospective: true, anchor: { ...marker.anchor, kind: 'turn', turnId: worstString(300) },
    receipt: { ...marker.receipt, ceilingBytes: CARRY_ON_LEDGER_BYTES, uncertain: true } })
}

/** Maximum complete record the active action may settle, preserving all already-accepted unknown fields. */
const projectedCeiling = (record: CarryOnRecord, reservation: CarryReservation): number => {
  const extra = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
  const projection = {
    ...record,
    incidentId: worstString(100), ...worstPointer, owner: 'seat', state: 'waiting-reset', cause: 'rateLimit', turnId: worstString(300),
    agent: worstString(300), from: { ...extra(record.from), ...worstSide }, model: worstString(200),
    resetsAt: Number.MAX_SAFE_INTEGER, nextAt: Number.MAX_SAFE_INTEGER, openedAt: Number.MAX_SAFE_INTEGER, lastAt: Number.MAX_SAFE_INTEGER,
    tried: Array(16).fill(worstString(300)), hops: 16, backoff: 2, throttle: true, alwaysScope: 'agent',
    to: { ...extra(record.to), ...worstSide }, toRuntime: worstString(300), mode: 'sameThread',
    link: { ...extra(record.link), ...worstPointer },
    watch: { ...extra(record.watch), ...worstPointer, pending: true, skip: Array(32).fill(worstString(300)), turnId: worstString(300) },
    turnStartedAt: Number.MAX_SAFE_INTEGER, note: worstString(300), handled: Array(8).fill(worstString(1000)), uncertain: true,
    reservation: { ...extra(reservation), id: worstString(100), action: 'retry', slots: 2, ceilingBytes: CARRY_ON_LEDGER_BYTES,
      stage: 'awaitingReceipt', markerIds: [worstString(100), worstString(100)], incarnation: worstString(300),
      baseFileIdentity: worstString(64), baseVersion: 1 },
    unwritten: [...(record.unwritten ?? []), ...Array(reservation.slots).fill(worstMarker)],
  }
  return encodedBytes(projection) + (record.unwritten ?? []).reduce((sum, marker) => sum + Math.max(0, (marker.receipt?.ceilingBytes ?? 0) - encodedBytes(marker)), 0)
}

/** Read and identify exactly the bytes we parsed; neither links nor non-files are writable history. */
const readCarryFile = async (file: string): Promise<{ readonly kind: 'missing' } | { readonly kind: 'bad' } | { readonly kind: 'value'; readonly value: unknown; readonly identity: string }> => {
  let existed = false
  try {
    const before = await lstat(file)
    existed = true
    if (!before.isFile() || before.isSymbolicLink()) return { kind: 'bad' }
    const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0))
    try {
      const stat = await handle.stat()
      const after = await lstat(file)
      if (!stat.isFile() || !after.isFile() || after.isSymbolicLink() || stat.size > MAX_FILE_BYTES ||
          (stat.ino && before.ino && stat.ino !== before.ino) || (stat.ino && after.ino && stat.ino !== after.ino) ||
          (stat.dev && before.dev && stat.dev !== before.dev) || (stat.dev && after.dev && stat.dev !== after.dev)) return { kind: 'bad' }
      const buffer = Buffer.alloc(MAX_FILE_BYTES + 1)
      let length = 0
      while (length < buffer.length) {
        const result = await handle.read(buffer, length, buffer.length - length, length)
        if (result.bytesRead === 0) break
        length += result.bytesRead
      }
      if (length > MAX_FILE_BYTES) return { kind: 'bad' }
      const final = await lstat(file)
      if (!final.isFile() || final.isSymbolicLink() || (stat.ino && final.ino && stat.ino !== final.ino) || (stat.dev && final.dev && stat.dev !== final.dev)) return { kind: 'bad' }
      const bytes = buffer.subarray(0, length)
      return { kind: 'value', value: JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)), identity: createHash('sha256').update(bytes).digest('hex') }
    } finally { await handle.close() }
  } catch (error) {
    return !existed && (error as NodeJS.ErrnoException).code === 'ENOENT' ? { kind: 'missing' } : { kind: 'bad' }
  }
}

/** Carry-on never discards a pending marker or an outstanding reservation. */
class CarryOnLedger {
  #records = new Map<string, CarryOnRecord>()
  #loaded = false
  #frozen = false
  #header: Record<string, unknown> = {}
  #identity: string | null = null
  constructor(private readonly options: { readonly file: string; readonly problem?: (reason: string) => void; readonly evicted?: (key: string) => void }) {}
  get loaded(): boolean { return this.#loaded }
  get(key: string): CarryOnRecord | undefined { return this.#records.get(key) }
  values(): IterableIterator<CarryOnRecord> { return this.#records.values() }
  get size(): number { return this.#records.size }
  async reserve(record: CarryOnRecord, slots: 1 | 2, action: CarryReservation['action']): Promise<CarryOnRecord> {
    if (record.reservation) throw new Error('Carry-on already has an uncertain reservation.')
    const reservation: CarryReservation = { id: randomUUID(), action, slots, ceilingBytes: CARRY_ON_LEDGER_BYTES, stage: 'reserved',
      markerIds: Array.from({ length: slots }, () => `carry-on-${randomUUID()}`), baseFileIdentity: this.#identity, baseVersion: 1 }
    const ceilingBytes = projectedCeiling(record, reservation)
    if (ceilingBytes > CARRY_ON_LEDGER_BYTES) throw new CarryOnCapacityError('Carry-on marker capacity is full.')
    const next = { ...record, reservation: { ...reservation, ceilingBytes } }
    await this.save(next)
    return next
  }
  async load(): Promise<void> {
    if (this.#loaded) return
    const read = await readCarryFile(this.options.file)
    this.#loaded = true
    if (read.kind === 'missing') return
    if (read.kind !== 'value' || !read.value || typeof read.value !== 'object' || Array.isArray(read.value)) {
      this.#frozen = true
      this.options.problem?.('Carry-on incidents could not be read; existing history was preserved.')
      return
    }
    const value = read.value as Record<string, unknown>
    if (value['version'] !== 1 || !Array.isArray(value['records']) || value['records'].length > INCIDENT_LIMIT) {
      this.#frozen = true
      this.options.problem?.('Carry-on incidents were invalid; existing history was preserved.')
      return
    }
    const records = new Map<string, CarryOnRecord>()
    for (const record of value['records']) {
      if (!validCarryOnRecord(record) || records.has(carryOnKey(record.runtime, record.sessionId))) {
        this.#frozen = true
        this.options.problem?.('Carry-on incidents were invalid or ambiguous; existing history was preserved.')
        return
      }
      if ((record.unwritten?.length ?? 0) + (record.reservation?.slots ?? 0) > UNWRITTEN_LIMIT ||
          (record.unwritten ?? []).some(marker => marker.receipt && marker.receipt.ceilingBytes < markerReceiptCeiling(marker)) ||
          record.reservation && record.reservation.ceilingBytes < projectedCeiling(record, record.reservation)) {
        this.#frozen = true
        this.options.problem?.('Carry-on reservations were inconsistent; existing history was preserved.')
        return
      }
      records.set(carryOnKey(record.runtime, record.sessionId), record)
    }
    const { version: _version, records: _records, ...header } = value
    this.#header = header
    this.#records = records
    this.#identity = read.identity
  }

  async save(record: CarryOnRecord, replaces?: string, authority: { readonly clearedIds?: readonly string[]; readonly releaseReservation?: string; readonly receiptOperation?: string; readonly bindMarkerId?: string; readonly cancelOperation?: string; readonly cancelledIds?: readonly string[] } = {}): Promise<void> {
    if (this.#frozen) throw new CarryOnCapacityError('Carry-on history is unavailable; existing history was preserved.')
    if (!validCarryOnRecord(record) || (record.unwritten?.length ?? 0) + (record.reservation?.slots ?? 0) > UNWRITTEN_LIMIT) throw new CarryOnCapacityError('Carry-on marker capacity or record validation was exceeded.')
    const key = carryOnKey(record.runtime, record.sessionId)
    const previous = this.#records.get(replaces ?? key)
    const preservesUnknown = (old: unknown, next: unknown, known: readonly string[]): boolean => {
      if (!old || typeof old !== 'object' || Array.isArray(old)) return true
      const value = next && typeof next === 'object' && !Array.isArray(next) ? next as Record<string, unknown> : {}
      return Object.entries(old as Record<string, unknown>).every(([field, data]) => known.includes(field) || isDeepStrictEqual(data, value[field]))
    }
    if (previous && (!preservesUnknown(previous, record, ['incidentId','runtime','sessionId','owner','state','cause','turnId','agent','from','model','resetsAt','nextAt','openedAt','lastAt','tried','hops','backoff','throttle','alwaysScope','to','toRuntime','mode','link','watch','turnStartedAt','note','handled','uncertain','unwritten','reservation']) ||
      !preservesUnknown(previous.from, record.from, ['name','account','model']) || !preservesUnknown(previous.to, record.to, ['name','account','model']) ||
      !preservesUnknown(previous.link, record.link, ['runtime','sessionId']) || !preservesUnknown(previous.watch, record.watch, ['runtime','sessionId','pending','skip','turnId']))) {
      throw new CarryOnCapacityError('Unknown carry-on history must be preserved.')
    }
    if (previous?.reservation && previous.reservation.id !== record.reservation?.id && authority.releaseReservation !== previous.reservation.id) {
      throw new Error('A protected carry-on reservation cannot be removed.')
    }
    if (previous?.reservation && record.reservation?.id === previous.reservation.id) {
      const old = previous.reservation, next = record.reservation
      if (old.action !== next.action || old.ceilingBytes !== next.ceilingBytes || old.baseVersion !== next.baseVersion ||
          old.baseFileIdentity !== next.baseFileIdentity || !isDeepStrictEqual(old.markerIds, next.markerIds) ||
          old.incarnation !== undefined && old.incarnation !== next.incarnation) throw new Error('A protected carry-on reservation cannot be changed.')
      if (next.slots < old.slots) {
        const needed = old.markerIds.slice(old.markerIds.length - old.slots, old.markerIds.length - next.slots)
        const oldIds = new Set((previous.unwritten ?? []).map(one => one.id))
        if (needed.some(id => oldIds.has(id) || !record.unwritten?.some(one => one.id === id))) throw new Error('A reserved marker slot cannot be released without materializing it.')
      }
      if (next.slots > old.slots && (authority.cancelOperation !== old.id || (authority.cancelledIds?.length ?? 0) !== next.slots - old.slots)) {
        throw new Error('A carry-on reservation cannot reclaim its marker slots.')
      }
    }
    const unmatched = [...(record.unwritten ?? [])]
    for (const old of previous?.unwritten ?? []) {
      const index = unmatched.findIndex(next => {
        if (old.id) return old.id === next.id
        const { id: _id, ...withoutId } = next
        return isDeepStrictEqual(old, withoutId)
      })
      if (index >= 0) {
        const next = unmatched.splice(index, 1)[0]!
        const expected: CarryOnUnwritten = { ...old, ...(!old.id && next.id ? { id: next.id } : {}) }
        if (old.receipt && authority.receiptOperation === old.receipt.operationId) {
          if (old.prospective && next.prospective === undefined) delete (expected as { prospective?: true }).prospective
          if (old.id === authority.bindMarkerId && old.anchor?.kind === 'continuation' && next.anchor?.kind === 'turn') {
            const { kind: _kind, operationId: _operationId, ...unknownAnchor } = old.anchor
            ;(expected as { anchor?: CarryOnUnwritten['anchor'] }).anchor = { ...unknownAnchor, kind: 'turn', turnId: next.anchor.turnId }
          }
          if (next.receipt?.uncertain && !old.receipt.uncertain) {
            ;(expected as { receipt?: CarryOnUnwritten['receipt'] }).receipt = { ...old.receipt, uncertain: true }
          }
        }
        if (!isDeepStrictEqual(expected, next)) throw new Error('A protected carry-on marker cannot be changed without its receipt.')
      } else if (!old.id || !authority.clearedIds?.includes(old.id) && !(old.prospective && old.receipt?.operationId === authority.cancelOperation && authority.cancelledIds?.includes(old.id))) throw new Error('A protected carry-on marker cannot be removed.')
    }
    const existing = this.#records.get(key)
    if (replaces !== undefined && replaces !== key && existing && existing.incidentId !== record.incidentId && protectedCarryOnRecord(existing)) {
      throw new CarryOnCapacityError('Carry-on capacity prevents replacing another protected incident.')
    }
    const next = new Map(this.#records)
    if (replaces !== undefined && replaces !== key) next.delete(replaces)
    next.delete(key); next.set(key, record)
    const evicted: string[] = []
    while (next.size > INCIDENT_LIMIT) {
      const removable = [...next].find(([candidate, value]) => candidate !== key && !protectedCarryOnRecord(value))
      if (!removable) throw new CarryOnCapacityError('Carry-on marker capacity is full.')
      next.delete(removable[0]); evicted.push(removable[0])
    }
    const pending = (records: Iterable<CarryOnRecord>) => [...records].reduce((sum, value) => sum + (value.unwritten?.length ?? 0) + (value.reservation?.slots ?? 0), 0)
    const beforePending = pending(this.#records.values()), afterPending = pending(next.values())
    if (afterPending > PENDING_GLOBAL_LIMIT && afterPending >= beforePending) throw new CarryOnCapacityError('Carry-on marker capacity is full.')
    const payload = { version: 1, ...this.#header, records: [...next.values()] }
    const charge = (records: Iterable<CarryOnRecord>) => {
      const values = [...records], payload = { version: 1, ...this.#header, records: values }
      return encodedBytes(payload) + values.reduce((sum, value) => {
        if (value.reservation) return sum + Math.max(0, value.reservation.ceilingBytes - encodedBytes(value))
        return sum + (value.unwritten ?? []).reduce((extra, marker) => extra + Math.max(0, (marker.receipt?.ceilingBytes ?? 0) - encodedBytes(marker)), 0)
      }, 0)
    }
    if (record.reservation && encodedBytes(record) > record.reservation.ceilingBytes) throw new CarryOnCapacityError('Carry-on reservation capacity was exceeded.')
    if (record.unwritten?.some(marker => marker.receipt && encodedBytes(marker) > marker.receipt.ceilingBytes)) throw new CarryOnCapacityError('Carry-on marker receipt capacity was exceeded.')
    const bytes = charge(next.values()), previousBytes = charge(this.#records.values())
    const physical = encodedBytes(payload), previousPhysical = encodedBytes({ version: 1, ...this.#header, records: [...this.#records.values()] })
    if (physical > MAX_FILE_BYTES || bytes > CARRY_ON_LEDGER_BYTES && (bytes >= previousBytes || physical >= previousPhysical)) {
      throw new CarryOnCapacityError('Carry-on ledger size exceeds capacity.')
    }
    try {
      await writeAtomicJson(this.options.file, payload, async () => {
        const current = await readCarryFile(this.options.file)
        const identity = current.kind === 'missing' ? null : current.kind === 'value' ? current.identity : undefined
        if (identity !== this.#identity) throw new CarryOnCapacityError('Carry-on history changed; existing history was preserved.')
      })
    } catch (error) { this.#frozen = true; throw error }
    this.#identity = createHash('sha256').update(JSON.stringify(payload)).digest('hex')
    this.#records = next
    for (const removed of evicted) this.options.evicted?.(removed)
  }
}

/**
 * Carry-on's ledger: one record per conversation, at
 * `<state>/carry-on/incidents.json`. Writes are serialised here, so the
 * service can claim, read and settle without racing itself.
 */
export class CarryOnIncidents {
  readonly #ledger: CarryOnLedger
  #tail: Promise<unknown> = Promise.resolve()
  readonly #writes = new Set<Promise<unknown>>()
  constructor(options: { readonly file: string; readonly problem?: (reason: string) => void; readonly evicted?: (key: string) => void }) {
    this.#ledger = new CarryOnLedger(options)
  }

  #loading: Promise<void> | null = null
  /** The ledger read from disk, once: what a reader outside the queue waits for, never the queue itself. */
  loaded(): Promise<void> { return this.#loading ??= this.#ledger.load() }

  /** Runs `work` after every earlier write, so a read inside it sees them all. */
  serial<T>(work: () => Promise<T>): Promise<T> {
    const task = this.#tail.then(async () => { await this.loaded(); return work() })
    this.#tail = task.catch(() => {})
    return task
  }
  async idle(): Promise<void> {
    for (;;) { const current = this.#tail; await current; if (current === this.#tail) return }
  }

  get(runtime: string, sessionId: string): CarryOnRecord | undefined { return this.#ledger.get(carryOnKey(runtime, sessionId)) }
  byId(incidentId: string): CarryOnRecord | undefined {
    for (const record of this.#ledger.values()) if (record.incidentId === incidentId) return record
    return undefined
  }
  /** The record whose move is waiting on this conversation's next turn. */
  watching(runtime: string, sessionId: string): CarryOnRecord | undefined {
    for (const record of this.#ledger.values()) if (record.watch?.runtime === runtime && record.watch.sessionId === sessionId) return record
    return undefined
  }
  /** Whether some incident has already answered this failed turn, wherever that incident lives now. */
  handled(runtime: string, sessionId: string, turnId: string): boolean {
    const key = carryOnTurnKey(runtime, sessionId, turnId)
    for (const record of this.#ledger.values()) {
      if (record.handled?.includes(key) || record.runtime === runtime && record.sessionId === sessionId && record.turnId === turnId) return true
    }
    return false
  }
  all(): readonly CarryOnRecord[] { return [...this.#ledger.values()] }
  /** Only inside `serial`. `replaces` names the key a record moved from, when a same-thread move re-keys it. */
  put(record: CarryOnRecord, replaces?: { readonly runtime: string; readonly sessionId: string }, authority?: { readonly clearedIds?: readonly string[]; readonly releaseReservation?: string; readonly receiptOperation?: string; readonly bindMarkerId?: string; readonly cancelOperation?: string; readonly cancelledIds?: readonly string[] }): Promise<void> {
    return this.#observe(this.#ledger.save(record, replaces ? carryOnKey(replaces.runtime, replaces.sessionId) : undefined, authority))
  }
  #observe<T>(write: Promise<T>): Promise<T> {
    this.#writes.add(write)
    void write.finally(() => this.#writes.delete(write)).catch(() => {})
    return write
  }
  async storageIdle(): Promise<void> {
    while (this.#writes.size) await Promise.allSettled([...this.#writes])
  }
  /** Call only inside the incident serialization queue. */
  reserve(record: CarryOnRecord, slots: 1 | 2, action: CarryReservation['action']): Promise<CarryOnRecord> { return this.#observe(this.#ledger.reserve(record, slots, action)) }
  load(): Promise<void> { return this.serial(async () => {}) }
}
