import type { EvidenceRecord } from '@harnessdesk/protocol'

import { evidenceRecordOf } from '../evidence/records.js'

/**
 * A Seat's finding command, as its flow run journals it.
 *
 * Written into the run's own file — the flow operation journal, whose one
 * writer is `FlowExecutions` — before the record it describes is appended,
 * and marked finished once the append is synced. The prepared record carries
 * every id the command minted, so a retry after a lost answer, or a restart
 * between the two writes, appends exactly this record or finds it already
 * there: never a second raise, never a new id.
 */
export interface FindingJournalEntry {
  /** The operation key: the command kind, the calling Seat, its card and its request token, hashed. */
  readonly operation: string
  readonly kind: 'raise' | 'repair' | 'verdict'
  /** The hash of what the command meant, excluding minted ids and times: the same request with other content is refused. */
  readonly hash: string
  /** The record the command prepared, with its minted ids. */
  readonly record: EvidenceRecord
  /** `abandoned`: it could not be appended when the desk came back, and `reason` says why. */
  readonly state: 'prepared' | 'finished' | 'abandoned'
  readonly reason: string | null
}

/** One run's journal, as a finding command reads and writes it inside that run's queue. */
export interface FindingJournal {
  entry(operation: string): FindingJournalEntry | null
  /** Persists one entry; resolves only once the run's file is synced. */
  put(entry: FindingJournalEntry): Promise<void>
}

const STATES = new Set(['prepared', 'finished', 'abandoned'])
const KINDS = new Set(['raise', 'repair', 'verdict'])

/** A journal read back from a run file, checked whole; throws with what is wrong. */
export const findingJournalOf = (value: unknown): Readonly<Record<string, FindingJournalEntry>> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('has an unreadable finding journal')
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    const one = entry as Record<string, unknown> | null
    if (typeof one !== 'object' || one === null || one['operation'] !== key || !KINDS.has(String(one['kind'])) ||
      typeof one['hash'] !== 'string' || !STATES.has(String(one['state'])) ||
      !(one['reason'] === null || typeof one['reason'] === 'string') ||
      evidenceRecordOf(one['record']) === null || (one['record'] as EvidenceRecord).finding?.operation !== key) {
      throw new Error('has a finding command it cannot describe')
    }
  }
  return value as Readonly<Record<string, FindingJournalEntry>>
}
