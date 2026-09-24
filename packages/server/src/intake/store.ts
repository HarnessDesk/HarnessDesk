import { randomUUID } from 'node:crypto'
import { open, rename, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { TRIGGER_SOURCES, type TriggerDefinition, type TriggerFact, type TriggerSource, type TriggerStopReason } from '@harnessdesk/protocol'

import { syncDirectory } from '../goals/store.js'
import type { ArmBinding } from './consent.js'
import { AGAIN_TITLE, labelName, TRIGGER_SLUG } from './definition.js'
import type { SessionMeter } from './spend.js'

/**
 * The admission journal: `intake.json` in the desk's state folder, one
 * versioned snapshot of everything a firing commits.
 *
 * - **What a firing is.** Every fact a trigger was offered and answered —
 *   fired or skipped — by its stable dedupe key, kept as a tombstone for
 *   good: a redelivery, a restart or a re-read answers `duplicate` from it
 *   and never fires twice. Nothing evicts one to make room.
 * - **What a firing committed to.** A fired fact's operation: the Goal and
 *   run ids it reserved, its group, the round intent (`start`, `again`,
 *   `record`), and the immutable payload it was decided on — definition,
 *   normalized fact, arm binding — until its effects are applied and its
 *   dispatch released. Each is written `prepared` before any Goal, fact,
 *   round or Seat exists, and `applied` once all of them do.
 * - **Which Goal a fact belongs to.** Per trigger, each group key's current
 *   Goal and run, whether it is open, and the last head it saw.
 * - **What each Goal may spend.** One budget per trigger Goal generation —
 *   its deadline, its USD limit and reservation, each Seat's spend meter,
 *   and why it stopped — the daily buckets of settled spend by UTC day, and
 *   a clock watermark that only moves forward.
 *
 * Every save is a complete synced temporary renamed over the file, then the
 * folder synced; a failed save refuses the admission that asked for it, and
 * what the desk believes is only ever what is on the disk. The file is read
 * whole at start and refused whole when any part of it cannot be read: an
 * unreadable journal refuses all new intake, rather than forgetting what
 * already fired. One writer — `Admission`, through its one queue.
 */

export const INTAKE_FILE = 'intake.json'
export const INTAKE_BYTES = 32 * 1024 * 1024
export const FIRING_LIMIT = 100_000
export const GROUP_LIMIT = 10_000
/** The share of a limit at which the journal starts saying it is filling. */
const WARN_AT = 0.9

const HEX = /^[0-9a-f]{64}$/
const SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/
const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/
const GOAL_ID = /^goal-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const RUN_ID = /^flow-trigger-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/** What a firing was decided on, frozen: the only input its effects ever read. */
export interface IntakePayload {
  readonly definition: TriggerDefinition
  readonly fact: TriggerFact
  readonly binding: ArmBinding
  /** The Goal's sentence, composed by the desk from validated scalars — never outside prose. */
  readonly sentence: string
}

export interface IntakeOperation {
  /** The firing: its stable dedupe key. */
  readonly key: string
  readonly group: string
  readonly trigger: string
  readonly project: string
  readonly goal: string
  readonly run: string
  /** What `again` compares: a pull request's head, an issue event's immutable id; never a Git SHA fabricated for an issue. */
  readonly head: string | null
  readonly roundKey: string
  readonly mode: 'start' | 'again' | 'record'
  readonly state: 'prepared' | 'applied'
  /** Its effects are applied and its dispatch was released: the payload is dropped, the tombstone stays in `firings`. */
  readonly dispatched: boolean
  readonly generation: number
  readonly payload: IntakePayload | null
  /** Why its round did not open or its dispatch waits, for a person: null when neither. */
  readonly attention: string | null
  /** What its round's own opening said, kept apart from a gate's passing refusal so a release restores it. */
  readonly roundAttention?: string | null
  readonly preparedAt: number
  /** How many times its effects failed for a reason that is not a refusal; bounded before it goes to the person. */
  readonly attempts?: number
  /** The last such failure, in its own words. */
  readonly failure?: string | null
}

export interface IntakeGroup {
  readonly trigger: string
  readonly project: string
  readonly goal: string
  readonly run: string
  readonly open: boolean
  readonly head: string | null
  readonly generation: number
}

export interface IntakeFiring {
  readonly trigger: string
  readonly project: string
  readonly at: number
  readonly outcome: 'fired' | 'skipped'
  readonly goal: string | null
  readonly reason: string | null
  /**
   * What history shows of the fact, from validated scalars only: its source,
   * its subject (a number, or a slot's instant), a pull request's head, the
   * repository the arm bound, the run and the round intent it took. Absent
   * on a journal written before history read them.
   */
  readonly source?: TriggerSource
  readonly subject?: string
  readonly head?: string | null
  readonly repository?: string | null
  readonly run?: string | null
  readonly mode?: 'start' | 'again' | 'record' | null
  /** Why its round did not open or its dispatch waited, kept once the operation itself is released. */
  readonly attention?: string | null
}

/** One trigger Goal generation's money and time: made with its first firing, never reset by a later one. */
export interface IntakeBudget {
  readonly trigger: string
  readonly project: string
  readonly startedAt: number
  /** Wall-clock deadline: start plus the budget's hours, read against the journal's forward-only clock. */
  readonly deadline: number
  /** The Goal's USD limit in micros, and the rounds and progress limits it was armed with. */
  readonly usdMicros: number
  readonly rounds: number
  readonly withoutProgress: number
  /** What this Goal holds against the daily cap until its final spend settles; 0 once settled. */
  readonly reservedMicros: number
  /** The UTC day the reservation was made. */
  readonly day: string
  readonly settled: boolean
  /** Each Seat's meter, by Seat id. */
  readonly meters: Readonly<Record<string, SessionMeter>>
  readonly stop: { readonly reason: TriggerStopReason; readonly detail: string; readonly at: number } | null
}

export interface IntakeSnapshot {
  readonly version: 1
  readonly revision: number
  /** The latest wall-clock instant the journal has seen: never moves back, so a clock rolled back extends nothing. */
  readonly clock: number
  readonly operations: readonly IntakeOperation[]
  readonly groups: Readonly<Record<string, IntakeGroup>>
  readonly firings: Readonly<Record<string, IntakeFiring>>
  readonly budgets: Readonly<Record<string, IntakeBudget>>
  /** Settled spend, in micros, by UTC day (`YYYY-MM-DD`). */
  readonly days: Readonly<Record<string, number>>
}

export const emptySnapshot = (): IntakeSnapshot => ({ version: 1, revision: 0, clock: 0, operations: [], groups: {}, firings: {}, budgets: {}, days: {} })

// ------------------------------------------------------------ validation

const isMap = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
const text = (value: unknown, limit = 4096): value is string => typeof value === 'string' && value.length <= limit
const filled = (value: unknown, limit = 4096): value is string => text(value, limit) && value.length > 0
const time = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0
const slug = (value: unknown): value is string => typeof value === 'string' && TRIGGER_SLUG.test(value)
const fieldsOf = (value: unknown): boolean =>
  Array.isArray(value) && value.length >= 1 && value.length <= 5 && value.every((one) => ['pr', 'head', 'event', 'issue', 'slot'].includes(one as string))

/** A stored definition, held to the parser's own shape: recovered text acquires no authority the parser would refuse. */
export const definitionOf = (value: unknown): TriggerDefinition | null => {
  if (!isMap(value) || !slug(value['id']) || !isMap(value['on'])) return null
  const on = value['on']
  if (!TRIGGER_SOURCES.includes(on['kind'] as never) || !Array.isArray(on['events']) || on['events'].length === 0) return null
  if (on['kind'] === 'schedule' && !(Number.isSafeInteger(on['everyMinutes']) && (on['everyMinutes'] as number) >= 1 && (on['everyMinutes'] as number) <= 10080)) return null
  const opens = value['opens']
  if (!isMap(opens) || Object.keys(opens).length !== 1 || !(slug(opens['flow']) || slug(opens['agent']))) return null
  const again = value['again']
  if (!(again === null || (isMap(again) && slug(again['role']) && again['title'] === AGAIN_TITLE && again['detail'] === null))) return null
  if (!fieldsOf(value['goal']) || !fieldsOf(value['dedupe'])) return null
  if (!(Number.isSafeInteger(value['concurrency']) && (value['concurrency'] as number) >= 1 && (value['concurrency'] as number) <= 32)) return null
  if (value['forks'] !== 'never' && value['forks'] !== 'allow') return null
  const budget = value['budget']
  if (!isMap(budget) || typeof budget['usd'] !== 'number' || !(budget['usd'] >= 0.01 && budget['usd'] <= 10000) ||
    typeof budget['hours'] !== 'number' || !(budget['hours'] >= 1 / 60 && budget['hours'] <= 168) ||
    !(Number.isSafeInteger(budget['rounds']) && (budget['rounds'] as number) >= 1 && (budget['rounds'] as number) <= 100) ||
    !(Number.isSafeInteger(budget['withoutProgress']) && (budget['withoutProgress'] as number) >= 1 && (budget['withoutProgress'] as number) <= 100)) return null
  const label = value['label']
  if (label !== undefined && !(Array.isArray(label) && label.length >= 1 && label.length <= 5 && label.every((one) => labelName(one) === one))) return null
  return value as unknown as TriggerDefinition
}

/** A stored fact, held to the monitor's own normalization: ids, commit ids, times and the bound repository, and bounded prose. */
export const factOf = (value: unknown): TriggerFact | null => {
  if (!isMap(value) || !TRIGGER_SOURCES.includes(value['source'] as never) || !filled(value['project'])) return null
  if (!(value['repository'] === null || (text(value['repository'], 200) && REPO.test(value['repository'] as string)))) return null
  if (typeof value['subject'] !== 'string' || !/^[1-9][0-9]{0,15}$/.test(value['subject']) || !HEX.test(String(value['event']))) return null
  if (!['opened', 'pushed', 'labelled', 'closed', 'commented', 'tick'].includes(value['action'] as string) || !time(value['at'])) return null
  if (!(value['head'] === null || SHA.test(String(value['head']))) || typeof value['fork'] !== 'boolean') return null
  if (!text(value['title'], 4096 * 4) || !text(value['body'], 16384 * 4 + 64) || !(value['url'] === null || text(value['url']))) return null
  if (!(value['trigger'] === null || slug(value['trigger']))) return null
  if (value['label'] !== undefined && labelName(value['label']) === null) return null
  return value as unknown as TriggerFact
}

const bindingOf = (value: unknown): ArmBinding | null => {
  if (!isMap(value)) return null
  const { project, incarnation, source, closure, account, repository } = value
  return filled(project) && text(incarnation, 128) && text(source, 128) && text(closure, 128) && text(account, 128) &&
    (repository === null || text(repository, 256)) ? value as unknown as ArmBinding : null
}

const payloadOf = (value: unknown): IntakePayload | null => {
  if (value === null) return null
  if (!isMap(value) || !filled(value['sentence'], 2000)) throw new Error('payload')
  if (!definitionOf(value['definition']) || !factOf(value['fact']) || !bindingOf(value['binding'])) throw new Error('payload')
  return value as unknown as IntakePayload
}

const STOPS = ['answered', 'crashed', 'timed out', 'lease expired', 'cancelled', 'out of budget', 'asked a question nobody can answer', 'needs a person']

const meterOf = (value: unknown): boolean => {
  if (!isMap(value)) return false
  const nullableTime = (one: unknown): boolean => one === null || time(one)
  return filled(value['seat'], 200) && filled(value['runtime'], 200) && filled(value['sessionId'], 4096) && filled(value['project']) &&
    time(value['openedAt']) && typeof value['fresh'] === 'boolean' && ['none', 'some', 'unknown'].includes(value['delegation'] as string) &&
    [null, 'call', 'session'].includes(value['scope'] as string | null) && [null, 'vendorMetered', 'listPrice'].includes(value['provenance'] as string | null) &&
    (value['model'] === null || text(value['model'], 200)) && nullableTime(value['baselineMicros']) && nullableTime(value['lastMicros']) &&
    time(value['callMicros']) && Array.isArray(value['calls']) && (value['calls'] as unknown[]).length <= 10_000 &&
    (value['calls'] as unknown[]).every((one) => text(one, 512)) && nullableTime(value['observedAt']) &&
    nullableTime(value['turnStartedAt']) && nullableTime(value['turnEndedAt']) && (value['unknown'] === null || text(value['unknown']))
}

const budgetOf = (value: unknown): boolean => {
  if (!isMap(value) || !slug(value['trigger']) || !filled(value['project']) || !time(value['startedAt']) || !time(value['deadline'])) return false
  if (!time(value['usdMicros']) || !time(value['reservedMicros']) || !/^\d{4}-\d{2}-\d{2}$/.test(String(value['day'])) || typeof value['settled'] !== 'boolean') return false
  if (!(Number.isSafeInteger(value['rounds']) && (value['rounds'] as number) >= 1) || !(Number.isSafeInteger(value['withoutProgress']) && (value['withoutProgress'] as number) >= 1)) return false
  const stop = value['stop']
  if (!(stop === null || (isMap(stop) && STOPS.includes(stop['reason'] as string) && text(stop['detail']) && time(stop['at'])))) return false
  const meters = value['meters']
  return isMap(meters) && Object.keys(meters).length <= 256 && Object.entries(meters).every(([seat, meter]) => meterOf(meter) && (meter as { seat: string }).seat === seat)
}

/** A firing's history fields, each optional and each held to what the monitor and admission write. */
const historyFits = (firing: Record<string, unknown>): boolean => {
  const absentOr = (key: string, check: (value: unknown) => boolean): boolean => firing[key] === undefined || check(firing[key])
  return absentOr('source', (value) => TRIGGER_SOURCES.includes(value as never)) &&
    absentOr('subject', (value) => typeof value === 'string' && /^[1-9][0-9]{0,15}$/.test(value)) &&
    absentOr('head', (value) => value === null || SHA.test(String(value))) &&
    absentOr('repository', (value) => value === null || (text(value, 200) && REPO.test(value as string))) &&
    absentOr('run', (value) => value === null || RUN_ID.test(String(value))) &&
    absentOr('mode', (value) => value === null || ['start', 'again', 'record'].includes(value as string)) &&
    absentOr('attention', (value) => value === null || text(value))
}

/** The whole snapshot, read strictly: any part it cannot read refuses all of it. */
export const snapshotOf = (value: unknown): IntakeSnapshot => {
  const bad = (why: string): never => { throw new Error(`The intake journal cannot be read (${why}). Its original bytes were kept.`) }
  if (!isMap(value) || value['version'] !== 1) return bad('unknown version')
  if (!time(value['revision']) || !time(value['clock']) || !Array.isArray(value['operations']) || !isMap(value['groups']) ||
    !isMap(value['firings']) || !isMap(value['budgets']) || !isMap(value['days'])) return bad('shape')
  for (const [day, spent] of Object.entries(value['days'] as Record<string, unknown>)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !time(spent)) bad('a day')
  }
  const budgets = value['budgets'] as Record<string, unknown>
  if (Object.keys(budgets).length > GROUP_LIMIT) bad('too many budgets')
  for (const [goal, budget] of Object.entries(budgets)) {
    if (!GOAL_ID.test(goal) || !budgetOf(budget)) bad('a budget')
  }
  const firings = value['firings'] as Record<string, unknown>
  if (Object.keys(firings).length > FIRING_LIMIT) bad('too many firings')
  for (const [key, firing] of Object.entries(firings)) {
    if (!HEX.test(key) || !isMap(firing) || !slug(firing['trigger']) || !filled(firing['project']) || !time(firing['at']) ||
      (firing['outcome'] !== 'fired' && firing['outcome'] !== 'skipped') ||
      !(firing['goal'] === null || GOAL_ID.test(String(firing['goal']))) || !(firing['reason'] === null || text(firing['reason'])) ||
      !historyFits(firing)) bad('a firing')
  }
  const groups = value['groups'] as Record<string, unknown>
  if (Object.keys(groups).length > GROUP_LIMIT) bad('too many groups')
  for (const [key, group] of Object.entries(groups)) {
    if (!HEX.test(key) || !isMap(group) || !slug(group['trigger']) || !filled(group['project']) || !GOAL_ID.test(String(group['goal'])) ||
      !RUN_ID.test(String(group['run'])) || typeof group['open'] !== 'boolean' || !(group['head'] === null || text(group['head'], 128)) ||
      !(Number.isSafeInteger(group['generation']) && (group['generation'] as number) >= 1)) bad('a group')
  }
  const keys = new Set<string>()
  for (const operation of value['operations'] as unknown[]) {
    if (!isMap(operation) || !HEX.test(String(operation['key'])) || keys.has(String(operation['key'])) || !HEX.test(String(operation['group'])) ||
      !slug(operation['trigger']) || !filled(operation['project']) || !GOAL_ID.test(String(operation['goal'])) || !RUN_ID.test(String(operation['run'])) ||
      !(operation['head'] === null || text(operation['head'], 128)) || !filled(operation['roundKey'], 256) ||
      !['start', 'again', 'record'].includes(operation['mode'] as string) || !['prepared', 'applied'].includes(operation['state'] as string) ||
      typeof operation['dispatched'] !== 'boolean' || !(Number.isSafeInteger(operation['generation']) && (operation['generation'] as number) >= 1) ||
      !(operation['attention'] === null || text(operation['attention'])) || !time(operation['preparedAt']) ||
      !(operation['roundAttention'] === undefined || operation['roundAttention'] === null || text(operation['roundAttention'])) ||
      !(operation['attempts'] === undefined || (Number.isSafeInteger(operation['attempts']) && (operation['attempts'] as number) >= 0)) ||
      !(operation['failure'] === undefined || operation['failure'] === null || text(operation['failure']))) bad('an operation')
    const op = operation as Record<string, unknown>
    let payload: IntakePayload | null
    try {
      payload = payloadOf(op['payload'])
    } catch {
      return bad('an operation’s payload')
    }
    // Until its dispatch is released an operation must still carry what it was decided on.
    if (payload === null && !op['dispatched']) bad('an operation without its payload')
    if (op['dispatched'] && op['state'] !== 'applied') bad('an operation released before it was applied')
    if (firings[String(op['key'])] === undefined) bad('an operation without its firing')
    keys.add(String(op['key']))
  }
  return value as unknown as IntakeSnapshot
}

/** How full the journal is, as a sentence, or null while it is comfortably within its limits. */
export const fullness = (snapshot: IntakeSnapshot): string | null => {
  const firings = Object.keys(snapshot.firings).length
  const groups = Object.keys(snapshot.groups).length
  if (firings >= FIRING_LIMIT * WARN_AT || groups >= GROUP_LIMIT * WARN_AT) {
    return 'The trigger history on this machine is nearly full. Disarm triggers that fire often; nothing already fired is forgotten.'
  }
  return null
}

// --------------------------------------------------------------- storage

/** A complete synced temporary renamed over the file, then the folder synced. */
export const writeSnapshot = async (file: string, text: string): Promise<void> => {
  const temporary = `${file}.${randomUUID()}.tmp`
  try {
    const handle = await open(temporary, 'wx', 0o600)
    try {
      await handle.writeFile(text)
      await handle.sync()
    } finally {
      await handle.close()
    }
    await rename(temporary, file)
    await syncDirectory(dirname(file))
  } finally {
    await rm(temporary, { force: true })
  }
}

export interface IntakeStoreOptions {
  /** How a snapshot's text reaches the disk; the real writer when absent. Tests stage failures here. */
  readonly write?: (file: string, text: string) => Promise<void>
}

export class IntakeStore {
  readonly #file: string
  readonly #write: (file: string, text: string) => Promise<void>
  #snapshot: IntakeSnapshot = emptySnapshot()
  #problem: string | null = 'The intake journal has not been read yet.'

  constructor(home: string, options: IntakeStoreOptions = {}) {
    this.#file = join(home, INTAKE_FILE)
    this.#write = options.write ?? writeSnapshot
  }

  /** Why no new intake is admitted: the journal is unread or unreadable. Null when it read. */
  get problem(): string | null { return this.#problem }

  /** Reads the whole journal once, at start. A missing file is an empty journal; anything unreadable refuses all intake. */
  async load(): Promise<void> {
    let handle
    try {
      handle = await open(this.#file, 'r')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        this.#snapshot = emptySnapshot()
        this.#problem = null
        return
      }
      this.#problem = 'The intake journal cannot be opened, so no trigger fires until it can.'
      return
    }
    try {
      const info = await handle.stat()
      if (!info.isFile() || info.size > INTAKE_BYTES) {
        this.#problem = 'The intake journal is larger than 32 MiB, so no trigger fires. Its original bytes were kept.'
        return
      }
      const raw = await handle.readFile('utf8')
      this.#snapshot = snapshotOf(JSON.parse(raw))
      this.#problem = null
    } catch (error) {
      this.#problem = error instanceof Error && error.message.startsWith('The intake journal')
        ? error.message
        : 'The intake journal cannot be read. Its original bytes were kept, and no trigger fires until it is repaired.'
    } finally {
      await handle.close()
    }
  }

  /** Whether any trigger Goal has a budget here, or any firing is still being applied: a read that copies nothing. */
  get busy(): boolean {
    return this.#problem === null && (this.#snapshot.operations.length > 0 || Object.keys(this.#snapshot.budgets).length > 0)
  }

  /** Whether a Goal has a budget, and — given one — whether that Seat has a meter on it: reads that copy nothing. */
  metered(goal: string, seat?: string): boolean {
    if (this.#problem !== null) return false
    const budget = this.#snapshot.budgets[goal]
    return budget !== undefined && (seat === undefined || budget.meters[seat] !== undefined)
  }

  /** The snapshot as it stands on the disk: a copy, so a caller's edits never change it. */
  read(): IntakeSnapshot {
    if (this.#problem) throw new Error(this.#problem)
    return structuredClone(this.#snapshot)
  }

  /**
   * Replaces the snapshot. Checked whole and bounded before anything is
   * written; installed in memory only once it is durable, so a failed save
   * leaves the desk believing exactly what the disk says.
   */
  async commit(next: IntakeSnapshot): Promise<void> {
    if (this.#problem) throw new Error(this.#problem)
    const numbered: IntakeSnapshot = { ...next, revision: this.#snapshot.revision + 1 }
    snapshotOf(JSON.parse(JSON.stringify(numbered)))
    if (Object.keys(numbered.firings).length >= FIRING_LIMIT) {
      throw new Error('The trigger history on this machine is full, so nothing more fires. Nothing already fired was forgotten.')
    }
    const text = JSON.stringify(numbered)
    if (Buffer.byteLength(text, 'utf8') > INTAKE_BYTES) {
      throw new Error('The intake journal would pass 32 MiB, so nothing more fires. Nothing already fired was forgotten.')
    }
    await this.#write(this.#file, text)
    this.#snapshot = numbered
  }
}
