import { randomInt } from 'node:crypto'
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
  readonly runtime: string
  readonly sessionId: string
  readonly phase: CarryOnPhase
  readonly to?: CarryOnSide
  readonly mode?: CarryOnMode
  readonly note?: string
  readonly link?: { readonly runtime: string; readonly sessionId: string }
}
/** Markers one record keeps waiting: more than one move writes. */
export const UNWRITTEN_LIMIT = 4

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
  readonly watch?: { readonly runtime: string; readonly sessionId: string; readonly pending?: true; readonly skip?: readonly string[] }
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
}

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
    (v!['skip'] === undefined || Array.isArray(v!['skip']) && (v!['skip'] as unknown[]).length <= WATCH_SKIP_LIMIT && (v!['skip'] as unknown[]).every(entry => short(entry)))
}
const unwritten = (value: unknown): boolean => {
  const v = value as Record<string, unknown> | null
  return pointer(v) && (CARRY_ON_PHASES as readonly unknown[]).includes(v!['phase']) && (v!['to'] === undefined || side(v!['to'])) &&
    (v!['mode'] === undefined || v!['mode'] === 'sameThread' || v!['mode'] === 'handoff') && optionalShort(v!['note'], 300) &&
    (v!['link'] === undefined || pointer(v!['link']))
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
    (v['uncertain'] === undefined || v['uncertain'] === true) &&
    (v['unwritten'] === undefined || Array.isArray(v['unwritten']) && (v['unwritten'] as unknown[]).length <= UNWRITTEN_LIMIT &&
      (v['unwritten'] as unknown[]).every(unwritten))
}

/**
 * Carry-on's ledger: one record per conversation, at
 * `<state>/carry-on/incidents.json`. Writes are serialised here, so the
 * service can claim, read and settle without racing itself.
 */
export class CarryOnIncidents {
  readonly #ledger: IncidentLedger<CarryOnRecord>
  #tail: Promise<unknown> = Promise.resolve()
  constructor(options: { readonly file: string; readonly problem?: (reason: string) => void; readonly evicted?: (key: string) => void }) {
    this.#ledger = new IncidentLedger<CarryOnRecord>({
      file: options.file, label: 'Carry-on incidents', recordLabel: 'carry-on incident', keyOf: record => carryOnKey(record.runtime, record.sessionId),
      valid: validCarryOnRecord, ...(options.problem ? { problem: options.problem } : {}), ...(options.evicted ? { evicted: options.evicted } : {}),
    })
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
  async idle(): Promise<void> { await this.#tail }

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
  put(record: CarryOnRecord, replaces?: { readonly runtime: string; readonly sessionId: string }): Promise<void> {
    return this.#ledger.save(record, replaces ? carryOnKey(replaces.runtime, replaces.sessionId) : undefined)
  }
  load(): Promise<void> { return this.serial(async () => {}) }
}
