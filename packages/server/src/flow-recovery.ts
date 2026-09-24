import { isCeilingLevel, type FlowRun, type FlowSeatRecord, type Intent, type SeatRecord } from '@harnessdesk/protocol'

import { parseFlowPolicy } from './flow-policy.js'
import { sourceDigest, type StoredFlowExecution } from './flow-execution.js'
import { findingJournalOf } from './findings/journal.js'
import { publicationOf } from './findings/publication.js'

/**
 * What a run read back at launch may do next, and why not when it may not.
 *
 * Every stored run is validated whole before any of this is asked. A run
 * that cannot be matched to its Goal, its Seats or the state of its last
 * check is kept exactly as it is on disk and shown with the reason; nothing
 * here rewrites an old run's file, and nothing here runs a check again.
 */

export type RecoveryInput = {
  terminal: boolean; goalExists: boolean; goalWritable: boolean
  seatsMapped: boolean; uncertainCheck: boolean
}

export function recoveryOf(input: RecoveryInput): 'history' | 'resume' | string {
  if (input.terminal) return 'history'
  if (!input.goalExists) return 'This run’s Goal is missing. Restore its Goal before continuing.'
  if (!input.goalWritable) return 'This Goal cannot run work. Resolve its migration or start a new Goal.'
  if (!input.seatsMapped) return 'This run’s Seats could not be matched. Its work is kept; start a new run.'
  if (input.uncertainCheck) return 'This check was interrupted. Inspect its effects, then choose Run again.'
  return 'resume'
}

// ------------------------------------------------------------ old runs

type StoredLegacyRun = FlowRun & { readonly version?: 1; readonly room: string }

const object = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
const text = (value: unknown): value is string => typeof value === 'string'
const texts = (value: unknown): value is string[] => Array.isArray(value) && value.every(text)
const integer = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value)
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)

/** An old run's file, checked whole. Throws with what is wrong; the file itself is never touched. */
export const legacyRunOf = (raw: unknown): StoredLegacyRun => {
  const bad = (why: string): never => { throw new Error(`run data ${why}`) }
  if (!object(raw)) return bad('is not an object')
  if (raw['version'] !== undefined && raw['version'] !== 1) bad('has an unknown version')
  if (!text(raw['id']) || !raw['id']) bad('has no id')
  if (!text(raw['room']) || !raw['room']) bad('names no room')
  const flow = raw['flow']
  if (!object(flow) || !text(flow['name']) || !Array.isArray(flow['roles']) || !Array.isArray(flow['rules']) || !Array.isArray(flow['inputs'])) {
    bad('is missing required fields or has non-array rounds, seats, or record')
  }
  if (!Array.isArray(raw['rounds']) || !Array.isArray(raw['seats']) || !Array.isArray(raw['record'])) {
    bad('is missing required fields or has non-array rounds, seats, or record')
  }
  if (!['running', 'stalled', 'settled', 'stopped'].includes(String(raw['state']))) bad('has an unknown state')
  for (const round of raw['rounds'] as unknown[]) {
    if (!object(round) || !text(round['role']) || !Array.isArray(round['intents']) || !(round['intents'] as unknown[]).every(integer)) {
      bad('has a round it cannot describe')
    }
  }
  for (const seat of raw['seats'] as unknown[]) {
    if (!object(seat) || !text(seat['key']) || !text(seat['role']) || !text(seat['runtime']) || !text(seat['sessionId'])) bad('has a seat it cannot describe')
  }
  return raw as unknown as StoredLegacyRun
}

/**
 * Each old seat, matched to exactly one open Seat kept on the same board with
 * the same conversation. Missing or ambiguous is a refusal, never a guess.
 */
export const legacySeatsMapped = (run: StoredLegacyRun, seats: readonly SeatRecord[]): boolean =>
  run.seats.every((seat: FlowSeatRecord) => seats.filter((record) =>
    record.board === run.room && record.closed === null && !record.restored &&
    record.session.runtime === seat.runtime && record.session.sessionId === seat.sessionId).length === 1)

/** An old run whose current round is a check with a card still open: old storage cannot say whether it ran. */
export const legacyCheckUncertain = (run: StoredLegacyRun, cards: readonly Intent[]): boolean => {
  const round = run.rounds.at(-1)
  if (!round) return false
  const role = run.flow.roles.find((one) => one.id === round.role)
  if (role?.kind !== 'check') return false
  return round.intents.some((id) => {
    const card = cards.find((one) => one.id === id)
    return card === undefined || (card.state !== 'done' && card.state !== 'abandoned')
  })
}

// ------------------------------------------------------------- new runs

const ROUND_STATES = ['opening', 'running', 'waiting-evidence', 'closed']
const OPERATION_KINDS = ['seat', 'turn', 'check', 'round']
const OPERATION_STATES = ['prepared', 'started', 'finished', 'uncertain']
const RUN_STATES = ['running', 'settled', 'stopped', 'stalled']

/**
 * A `flows-v2/` file, validated whole: every field, and the policy re-read
 * from the raw text it kept — never from the file it came from — and held to
 * the document and digest it was started with.
 */
export const executionOf = (raw: unknown): StoredFlowExecution => {
  const bad = (why: string): never => { throw new Error(`flow run ${why}`) }
  if (!object(raw)) return bad('is not an object')
  if (raw['version'] !== 2) bad('has an unknown version')
  if (!text(raw['id']) || !raw['id']) bad('has no id')
  if (!text(raw['goal'])) bad('names no Goal')
  if (!RUN_STATES.includes(String(raw['state']))) bad('has an unknown state')
  if (!(raw['reason'] === null || text(raw['reason']))) bad('has an unreadable reason')
  if (!text(raw['source']) || !(raw['sourcePath'] === null || text(raw['sourcePath']))) bad('has no source')
  if (!object(raw['vars']) || !Object.values(raw['vars']).every(text)) bad('has unreadable inputs')
  if (!finite(raw['startedAt']) || !finite(raw['updatedAt'])) bad('has unreadable times')
  const authorization = raw['authorization']
  if (!object(authorization) || !text(authorization['sourceDigest']) || !text(authorization['commandDigest']) || !finite(authorization['approvedAt'])) {
    bad('has no authorization')
  }
  if (!object(raw['operationTimes'])) bad('has unreadable operation times')
  for (const time of Object.values(raw['operationTimes'] as Record<string, unknown>)) {
    if (!object(time) || !finite(time['preparedAt']) || !(time['startedAt'] === null || finite(time['startedAt'])) ||
      !(time['finishedAt'] === null || finite(time['finishedAt']))) bad('has unreadable operation times')
  }
  if (!Array.isArray(raw['rounds'])) bad('has no rounds')
  const numbers = new Set<number>()
  for (const round of raw['rounds'] as unknown[]) {
    if (!object(round) || !integer(round['n']) || numbers.has(round['n'] as number) || !text(round['role']) ||
      !Array.isArray(round['cards']) || !(round['cards'] as unknown[]).every(integer) || !texts(round['seats']) ||
      !texts(round['evidence']) || !ROUND_STATES.includes(String(round['state'])) || !text(round['cause'])) bad('has a round it cannot describe')
    numbers.add((round as { n: number }).n)
  }
  if (!Array.isArray(raw['operations'])) bad('has no operations')
  const keys = new Set<string>()
  for (const operation of raw['operations'] as unknown[]) {
    if (!object(operation) || !text(operation['key']) || keys.has(operation['key'] as string) || !OPERATION_KINDS.includes(String(operation['kind'])) ||
      !OPERATION_STATES.includes(String(operation['state'])) || !(operation['card'] === null || integer(operation['card'])) ||
      !(operation['seat'] === null || text(operation['seat']))) bad('has an operation it cannot describe')
    keys.add((operation as { key: string }).key)
  }
  if (raw['checkPlans'] !== undefined) {
    if (!object(raw['checkPlans'])) bad('has unreadable check plans')
    for (const [round, plan] of Object.entries(raw['checkPlans'] as Record<string, unknown>)) {
      if (!/^[1-9][0-9]*$/.test(round) || !object(plan) || !text(plan['context']) || !(plan['refused'] === null || text(plan['refused'])) ||
        !Array.isArray(plan['targets']) || !(plan['targets'] as unknown[]).every((target) =>
          object(target) && text(target['cwd']) && (target['at'] === null || text(target['at'])))) bad('has a check plan it cannot describe')
    }
  }
  if (raw['reviewPackets'] !== undefined) {
    if (!object(raw['reviewPackets'])) bad('has unreadable review packets')
    for (const [round, pin] of Object.entries(raw['reviewPackets'] as Record<string, unknown>)) {
      if (!/^[1-9][0-9]*$/.test(round) || !object(pin) || !text(pin['text']) || !Array.isArray(pin['pinned']) ||
        !(pin['pinned'] as unknown[]).every((one) => object(one) && text(one['cwd']) && text(one['at']))) bad('has a review packet it cannot describe')
      // Absent on a packet pinned before repair leads existed; that packet still renders its text as it always did.
      const packet = pin as Record<string, unknown>
      if (packet['leads'] !== undefined && (!Array.isArray(packet['leads']) || !(packet['leads'] as unknown[]).every((one) =>
        object(one) && text(one['series']) && text(one['from']) && text(one['to']) && texts(one['claimed']) && texts(one['unresolved']))))
        bad('has a repair lead it cannot describe')
    }
  }
  if (raw['findings'] !== undefined) {
    const findings = raw['findings'] as Record<string, unknown>
    if (!object(findings) || findings['version'] !== 1 || !object(findings['budget']) || !integer((findings['budget'] as Record<string, unknown>)['rounds']) ||
      !integer((findings['budget'] as Record<string, unknown>)['withoutProgress']) || !Array.isArray(findings['closedRounds']) ||
      !(findings['closedRounds'] as unknown[]).every(integer) || !integer(findings['idleRounds']) || !texts(findings['progress']) ||
      !Array.isArray(findings['series']) || !(findings['stopped'] === null || object(findings['stopped'])) ||
      !(findings['extraRound'] === null || object(findings['extraRound'])) || !Array.isArray(findings['overrides']) ||
      // Absent on a run saved before this field existed; that run keeps its old behaviour, per phase 7 decision 7.
      !(findings['lastDecision'] === undefined || findings['lastDecision'] === null || object(findings['lastDecision'])))
      bad('has findings bookkeeping it cannot describe')
    for (const series of findings['series'] as unknown[]) {
      if (!object(series) || !text(series['id']) || !text(series['role']) || !object(series['checkout']) ||
        !(series['reviewedAt'] === null || text(series['reviewedAt'])) || !Array.isArray(series['reviewRounds']) ||
        !texts(series['initial']) || !texts(series['exceptions']) || !texts(series['pending'])) bad('has a review series it cannot describe')
    }
  }
  if (raw['publication'] !== undefined) {
    try {
      publicationOf(raw['publication'])
    } catch (error) {
      bad(error instanceof Error ? error.message : String(error))
    }
  }
  if (raw['findingOps'] !== undefined) {
    try {
      findingJournalOf(raw['findingOps'])
    } catch (error) {
      bad(error instanceof Error ? error.message : String(error))
    }
  }
  if (raw['intake'] !== undefined) {
    const intake = raw['intake']
    const again = object(intake) ? intake['again'] : undefined
    if (!object(intake) || !text(intake['key']) || !/^[0-9a-f]{64}$/.test(String(intake['key'])) || !text(intake['trigger']) ||
      !text(intake['closureDigest']) || typeof intake['dispatchHeld'] !== 'boolean' ||
      !(again === null || (object(again) && text(again['role']) && text(again['title'])))) bad('has trigger bookkeeping it cannot describe')
  }
  const compiled = raw['compiled']
  if (!object(compiled) || !Array.isArray(compiled['bindings']) || !Array.isArray(compiled['problems'])) bad('has no compiled policy')
  for (const binding of (compiled as { bindings: unknown[] }).bindings) {
    if (!object(binding) || !text(binding['role']) || !integer(binding['index']) || !object(binding['agent']) || !text(binding['digest']) ||
      !Array.isArray(binding['seats']) || !text(binding['grant']) || !isCeilingLevel(binding['grant'])) bad('has a binding it cannot describe')
  }
  if (raw['legacyRun'] !== null) {
    legacyRunOf(raw['legacyRun'])
    return raw as unknown as StoredFlowExecution
  }
  const reparsed = parseFlowPolicy(raw['source'] as string)
  if (!reparsed.document || reparsed.document.format !== 'agents') bad('source is no longer an Agent flow')
  if (JSON.stringify(reparsed.document) !== JSON.stringify(raw['document']) || JSON.stringify((compiled as { document: unknown }).document) !== JSON.stringify(raw['document'])) {
    bad('document does not match the text it was started from')
  }
  if ((authorization as { sourceDigest: string }).sourceDigest !== sourceDigest(raw['source'] as string)) bad('source does not match its authorization')
  return raw as unknown as StoredFlowExecution
}
