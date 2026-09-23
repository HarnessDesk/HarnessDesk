import type {
  BoardEvidence,
  CardEvidence,
  EvidenceRecord,
  EvidenceView,
  Freshness,
  SeatId,
  Sha,
} from '@harnessdesk/protocol'

import { factKey } from './records.js'
import { freshnessOf } from './revision.js'

/**
 * A board's evidence, as a surface draws it: the latest fact of each kind on
 * each card — each named check apart — and how each stands now against its
 * branch. Read, never written: every fact here was recorded by the desk from
 * something it did.
 *
 * A fact a backup brought is history. A fact this desk observed always answers
 * its question first, whenever the restored one says it was observed; and a
 * restored fact that is still the only answer stands as unknown, because this
 * desk has not seen it — it is drawn, and it never makes a card *Ready*.
 */

/** Why a restored fact stands as unknown. */
export const RESTORED_WHY = 'it came from a backup, and this desk has not observed it'

/** Why a check whose run crossed a HEAD move can never be a passing fact. */
export const MOVED_CHECK_WHY = 'HEAD moved while this check ran, so its result is not counted for either revision.'

/**
 * The named check running on each card now. One at a time on a card, whatever
 * its name: two checks in one checkout at once would each be measuring the
 * other's work. In memory: a run does not outlive the desk that started it.
 */
export class RunningChecks {
  readonly #runs = new Map<string, { readonly room: string; readonly card: number; readonly name: string; readonly since: number }>()

  /** Marks a check running on a card, or answers the one already running there. */
  start(room: string, card: number, name: string, since: number): { readonly name: string } | null {
    const key = JSON.stringify([room, card])
    const running = this.#runs.get(key)
    if (running) return { name: running.name }
    this.#runs.set(key, { room, card, name, since })
    return null
  }

  end(room: string, card: number): void {
    this.#runs.delete(JSON.stringify([room, card]))
  }

  of(room: string): { readonly card: number; readonly name: string; readonly since: number }[] {
    return [...this.#runs.values()].filter((run) => run.room === room)
  }
}

/** The revision a fact is bound to, or null for one bound to none (`spend`). */
export const boundTo = (record: EvidenceRecord): Sha | null => {
  const fact = record.fact
  switch (fact.kind) {
    case 'check':
    case 'ci':
    case 'review':
    case 'finding':
      return fact.at
    case 'pr':
      return fact.head
    case 'diff':
      return fact.to
    case 'spend':
      return null
  }
}

/** The order a card's facts are listed in: its checks by name, then what the forge says, then the diff. */
const rank = (record: EvidenceRecord): string => {
  const order = ['check', 'ci', 'pr', 'diff', 'review', 'finding', 'spend']
  return `${order.indexOf(record.fact.kind)}:${record.fact.kind === 'check' ? record.fact.name : ''}`
}

/** Whether `record` answers its question over `before`: what this desk observed first, then the later one. */
const supersedes = (record: EvidenceRecord, before: EvidenceRecord): boolean => {
  const kept = !record.restored
  if (kept !== !before.restored) return kept
  // The latest observation of a question answers it; a tie goes to the one written later.
  return record.observedAt >= before.observedAt
}

export interface BoardEvidenceInput {
  readonly room: string
  /** When the read that makes this began: `BoardEvidence.stamp`. */
  readonly stamp: number
  /** The project the room's records are kept under. */
  readonly project: string
  /** Every fact the project's store holds, in the order written. */
  readonly records: readonly EvidenceRecord[]
  /** The names of the checks the project names that can run. */
  readonly checks: readonly string[]
  /** The checks it names that cannot run, with why. */
  readonly refused: readonly { readonly name: string; readonly why: string }[]
  /** Why its checks file cannot be read at all, or null. */
  readonly unreadable: string | null
  readonly running: readonly { readonly card: number; readonly name: string; readonly since: number }[]
  /** A Seat in words, or null when the desk knows no such Seat. */
  readonly seatWords: (id: SeatId) => { readonly agent: string | null; readonly seat: string } | null
}

/**
 * One record's freshness, against a project's checkouts. A backup's fact is
 * always unknown, a check whose HEAD moved mid-run is unknown for either
 * revision, and one bound to no revision at all (`spend`) is trivially fresh.
 *
 * Returns a reader that caches by checkout, branch, revision and kind of
 * question, so a caller judging many records that share one — every card of
 * a round sharing one checkout, say — reads that git state once.
 */
export const freshnessReader = (project: string): ((record: EvidenceRecord) => Promise<Freshness>) => {
  const standing = new Map<string, Promise<Freshness>>()
  return (record: EvidenceRecord): Promise<Freshness> => {
    if (record.restored) return Promise.resolve({ state: 'unknown', why: RESTORED_WHY })
    if (record.fact.kind === 'check' && record.fact.counted === false) {
      return Promise.resolve({ state: 'unknown', why: MOVED_CHECK_WHY })
    }
    const at = boundTo(record)
    if (at === null) return Promise.resolve({ state: 'fresh' })
    if (!record.checkout) return Promise.resolve({ state: 'unknown', why: 'where it was observed is not recorded' })
    const dirty = record.fact.kind === 'check' && record.fact.dirty
    const merged = record.fact.kind === 'pr' && record.fact.state === 'merged'
    const key = JSON.stringify([record.checkout.cwd, record.checkout.branch, at, dirty, merged])
    const known = standing.get(key)
    if (known) return known
    const reading = freshnessOf(record.checkout, at, { dirty, merged, project })
    standing.set(key, reading)
    return reading
  }
}

export const boardEvidence = async (input: BoardEvidenceInput): Promise<BoardEvidence> => {
  const latest = new Map<number, Map<string, EvidenceRecord>>()
  for (const record of input.records) {
    if (!record.card || record.card.board !== input.room) continue
    const card = latest.get(record.card.id) ?? new Map<string, EvidenceRecord>()
    const key = factKey(record.fact)
    const before = card.get(key)
    if (!before || supersedes(record, before)) card.set(key, record)
    latest.set(record.card.id, card)
  }

  // One read of git per checkout, branch, revision and kind of question, however many cards share them.
  const freshness = freshnessReader(input.project)

  const cards: CardEvidence[] = []
  const ids = new Set([...latest.keys(), ...input.running.map((run) => run.card)])
  for (const id of [...ids].sort((a, b) => a - b)) {
    const records = [...(latest.get(id)?.values() ?? [])].sort((a, b) => rank(a).localeCompare(rank(b)))
    const facts: EvidenceView[] = []
    for (const record of records) {
      facts.push({
        record,
        freshness: await freshness(record),
        by: record.seat ? input.seatWords(record.seat) : null,
      })
    }
    cards.push({
      card: id,
      facts,
      running: input.running
        .filter((run) => run.card === id)
        .map((run) => ({ name: run.name, since: run.since }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    })
  }
  return {
    room: input.room,
    stamp: input.stamp,
    checks: [...input.checks],
    refused: [...input.refused],
    unreadable: input.unreadable,
    cards,
  }
}
