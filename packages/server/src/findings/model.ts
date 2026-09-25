import type {
  EvidenceRecord,
  FindingDetail,
  FindingEvent,
  FindingOrigin,
  FindingPost,
  FindingRecord,
  FindingState,
  FindingView,
} from '@harnessdesk/protocol'

/**
 * The findings ledger, folded.
 *
 * A finding is the sequence of evidence records that name it — a raise, then
 * repair claims, verdicts, carries and postings — read in the store's append
 * order, never by timestamp. Nothing here writes: the fold is how every
 * reader, the Goal rail and a flow's guard alike, learns where a finding
 * stands, and it is conservative in one direction only. A history it cannot
 * read whole — a gap in the sequence, two events disagreeing about one
 * number, an origin that changed, a transition the lifecycle refuses, a fact
 * that carries no details — is reported as the finding's `problem`, and a
 * finding with a problem is never resolved. So damage can make the ledger
 * say *more* is blocking, never less.
 */

export type { FindingState } from '@harnessdesk/protocol'

/** A private reducer input: what one repair or verdict event does to a lifecycle. Not a wire command. */
export type FindingChange =
  | { readonly kind: 'repair'; readonly at: string }
  | { readonly kind: 'verdict'; readonly state: 'open' | 'repaired' | 'withdrawn' }

/**
 * The one lifecycle rule. A repair is a claim — `repaired` but never
 * confirmed — and the same revision claimed twice is one attempt. A verdict
 * of `repaired` confirms a claimed repair and needs one; `withdrawn` confirms
 * a withdrawal; `open` rejects a claimed repair. Once confirmed, a finding
 * never changes again: a regression is a new, linked finding.
 */
export function changeFinding(current: FindingState, change: FindingChange): FindingState {
  if (current.confirmed) throw new Error('This finding is resolved. Record a new linked finding.')
  if (change.kind === 'repair') {
    if (current.repairs.includes(change.at)) return current
    return { state: 'repaired', confirmed: false, repairs: [...current.repairs, change.at] }
  }
  if (change.state === 'repaired' && current.repairs.length === 0) {
    throw new Error('No repair has been recorded for this finding.')
  }
  return { ...current, state: change.state, confirmed: change.state !== 'open' }
}

export const NO_DETAILS = 'Details were not recorded.'
const SEQUENCE_DAMAGE = 'Part of this finding’s history is missing or conflicting, so it stays blocking until it is repaired.'

const OPENED: FindingState = { state: 'open', confirmed: false, repairs: [] }

/** Whether a record is one event of a finding, with its metadata. */
export const isFindingRecord = (record: EvidenceRecord): record is FindingRecord =>
  record.fact.kind === 'finding' && record.finding !== undefined && record.finding !== null

/** Key-sorted JSON: two records are the same bytes when this agrees, whatever order their keys were written in. */
export const canonical = (value: unknown): string =>
  JSON.stringify(value, (_key, inner: unknown) =>
    inner !== null && typeof inner === 'object' && !Array.isArray(inner)
      ? Object.fromEntries(Object.entries(inner as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)))
      : inner)

const sameOrigin = (left: FindingOrigin, right: FindingOrigin): boolean =>
  left.goal === right.goal && left.run === right.run && left.round === right.round &&
  left.card === right.card && left.seat === right.seat && left.at === right.at

interface Folding {
  readonly id: string
  origin: FindingOrigin | null
  raise: Extract<FindingEvent, { kind: 'raise' }> | null
  ownerGoal: string
  lifecycle: FindingState
  sequence: number
  at: string | null
  evidence: string[]
  posted: FindingPost[]
  restored: boolean
  problem: string | null
  bare: EvidenceRecord | null
}

/**
 * One event applied to a finding being folded, or the reason it cannot be.
 * Sequence, origin, actor and state are all checked here: the reader checked
 * each record alone, and only the fold sees them in order.
 */
const apply = (folding: Folding, record: FindingRecord): string | null => {
  const detail: FindingDetail = record.finding
  const event = detail.event
  if (detail.sequence !== folding.sequence + 1) return SEQUENCE_DAMAGE
  if (event.kind === 'raise') {
    if (folding.raise) return SEQUENCE_DAMAGE
    if (record.seat == null || record.seat !== detail.origin.seat) return 'This finding’s raise is not attributed to the Seat that raised it.'
    folding.origin = detail.origin
    folding.raise = event
    folding.ownerGoal = detail.origin.goal
    folding.lifecycle = OPENED
  } else {
    if (!folding.raise || !folding.origin) return SEQUENCE_DAMAGE
    if (!sameOrigin(folding.origin, detail.origin)) return 'A later event of this finding names another origin. Its history cannot be trusted.'
    try {
      if (event.kind === 'repair') {
        if (record.seat == null) return 'A repair claim has no Seat behind it.'
        folding.lifecycle = changeFinding(folding.lifecycle, { kind: 'repair', at: record.fact.at })
      } else if (event.kind === 'verdict') {
        if (event.by === 'person' ? record.seat != null : record.seat == null) {
          return 'A verdict’s recorded actor does not match who it says gave it.'
        }
        folding.lifecycle = changeFinding(folding.lifecycle, { kind: 'verdict', state: event.state })
      } else {
        // Bookkeeping: neither lifecycle nor revision moves, and no Seat speaks.
        if (record.seat != null) return 'A carry or posting names a Seat; only the host records those.'
        if (record.fact.at !== folding.at) return 'A carry or posting moved this finding’s revision.'
        if (event.kind === 'carry') {
          if (event.from !== folding.ownerGoal) return 'This finding was carried from a Goal that did not own it.'
          folding.ownerGoal = event.to
        } else {
          folding.posted.push(event.location)
        }
      }
    } catch (error) {
      return error instanceof Error ? error.message : String(error)
    }
  }
  if (record.fact.state !== folding.lifecycle.state) return 'This finding’s recorded state does not follow from its events.'
  folding.sequence = detail.sequence
  folding.at = record.fact.at
  folding.evidence.push(record.id)
  if (record.restored) folding.restored = true
  return null
}

/**
 * Every finding the records name, in the order each was first seen. `records`
 * are validated evidence records (the store's `lineOf` read them) in append
 * order. A record that repeats one already folded, byte for byte, is a replay
 * and changes nothing; the same id with other bytes is damage.
 */
export function foldFindings(records: readonly EvidenceRecord[]): readonly FindingView[] {
  const byId = new Map<string, Folding>()
  const seen = new Map<string, string>()
  for (const record of records) {
    if (record.fact.kind !== 'finding') continue
    const id = record.fact.id
    let folding = byId.get(id)
    if (!folding) {
      folding = {
        id, origin: null, raise: null, ownerGoal: '', lifecycle: OPENED, sequence: 0, at: null,
        evidence: [], posted: [], restored: false, problem: null, bare: null,
      }
      byId.set(id, folding)
    }
    const bytes = canonical(record)
    const before = seen.get(record.id)
    if (before !== undefined) {
      if (before !== bytes) folding.problem ??= SEQUENCE_DAMAGE
      continue
    }
    seen.set(record.id, bytes)
    if (folding.problem !== null) {
      if (record.restored) folding.restored = true
      continue
    }
    if (!isFindingRecord(record)) {
      // A bare fact — phase 4's shape, before findings had details. History, never a cleared row.
      if (folding.raise) folding.problem = 'A record without details names this finding. Its history cannot be trusted.'
      else {
        folding.bare = record
        folding.lifecycle = { state: record.fact.state, confirmed: false, repairs: [] }
        folding.at = record.fact.at
        folding.evidence.push(record.id)
        if (record.restored) folding.restored = true
      }
      continue
    }
    if (folding.bare) {
      folding.problem = 'A record without details names this finding. Its history cannot be trusted.'
      continue
    }
    folding.problem = apply(folding, record)
    if (record.restored) folding.restored = true
  }
  return [...byId.values()].map(viewOf)
}

const viewOf = (folding: Folding): FindingView => {
  const raise = folding.raise
  const bare = folding.bare
  const origin: FindingOrigin = folding.origin ?? {
    goal: bare?.card?.board ?? '', run: '', round: bare?.round ?? 0, card: bare?.card?.id ?? 0, seat: '', at: bare?.fact.kind === 'finding' ? bare.fact.at : '',
  }
  const problem = folding.problem ?? (raise ? null : bare ? NO_DETAILS : SEQUENCE_DAMAGE)
  return {
    id: folding.id,
    origin,
    ownerGoal: folding.ownerGoal || origin.goal,
    title: raise?.title ?? '',
    body: raise?.body ?? '',
    category: raise?.category ?? 'ordinary',
    // A finding whose details are missing blocks: it is never assumed advisory.
    blocking: raise?.blocking ?? true,
    related: raise?.related ?? null,
    anchor: raise?.anchor ?? null,
    lifecycle: folding.lifecycle,
    sequence: folding.sequence,
    evidence: folding.evidence,
    posted: folding.posted,
    restored: folding.restored,
    problem,
  }
}

/**
 * Whether a finding is settled for any live decision here: confirmed, read
 * whole, and observed on this desk. A restored confirmation is history — it
 * clears nothing until this desk sees it again.
 */
export const isResolved = (view: FindingView): boolean =>
  view.problem === null && !view.restored && view.lifecycle.confirmed

/** The findings that still block: every blocking one not resolved, and every one whose history is damaged. */
export const liveBlockers = (views: readonly FindingView[]): readonly FindingView[] =>
  views.filter((view) => !isResolved(view) && (view.blocking || view.problem !== null))
