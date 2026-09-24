import { createHash } from 'node:crypto'

import type {
  GoalCitation,
  GoalId,
  GoalMemoryIndex,
  MemoryBackup,
  MemoryBackupReport,
  MemorySnapshot,
  SeatAttachmentsRecord,
} from '@harnessdesk/protocol'

import { memoryIndexOf } from '../goals/store.js'
import { attachmentRecordOf } from '../attachments/receipts.js'
import { canonicalSnapshot, snapshotOf } from './plane.js'

/**
 * Task 6's own backup sidecar: bounded, additive import/export over Task 2's
 * retained citations and Task 3's frozen Seat attachment history — the two
 * subsystems `MemoryBackup` spans. Never trust files, staging directories,
 * gateway tokens or server processes; none of those are named here because
 * none of them are ever in this sidecar (decision 6, decision 16 of the
 * phase-12 plan).
 *
 * `export`/`import` compose two otherwise-separate planes (`GoalPlane`'s own
 * `MemoryPlane`, and the top-level `AttachmentsPlane`) behind one small port,
 * so `host.ts` is the only place that has to know both exist.
 */

export interface MemoryBackupPort {
  /** Every loaded Goal document's own `memory` field — never a live re-read per key. */
  documents(): readonly { readonly goal: GoalId; readonly memory: GoalMemoryIndex }[]
  /** One retained object's canonical bytes by its content-addressed key, or null when this desk holds nothing under it. */
  readObject(key: string): Promise<string | null>
  /** Writes one already-captured snapshot back verbatim, keyed by its own content hash — import only. */
  writeObject(snapshot: MemorySnapshot): Promise<string>
  /** Folds an already-validated index into the live registry, restored. False when no such Goal exists locally. */
  registerRestoredMemory(goal: GoalId, index: GoalMemoryIndex): boolean
  /** Whether this exact citation is already registered under this exact archive key — the duplicate check for an index link. */
  isRegistered(citation: GoalCitation, archive: string): boolean
  /** Every observation epoch of every Seat this desk has ever recorded. */
  attachmentHistory(): Promise<readonly SeatAttachmentsRecord[]>
  /** Appends one imported epoch: `'restored'` newly written, `'alreadyHere'` an identical duplicate, `'refused'` a gap or mismatch. */
  appendAttachment(record: SeatAttachmentsRecord): Promise<'restored' | 'alreadyHere' | 'refused'>
}

const MAX_OBJECTS = 256
const MAX_BYTES = 32 * 1024 * 1024
const MAX_ATTACHMENTS = 10_000

const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** A citation's complete tuple — the only identity an index link and an archive object may be matched on. */
const tupleOf = (citation: GoalCitation): string =>
  JSON.stringify([citation.goal, citation.receipt, citation.project, citation.path, citation.at])

/** The citation tuple an archive object this desk already holds carries, or null when it holds none (or holds damage). */
const carriedBy = async (port: MemoryBackupPort, key: string): Promise<string | null> => {
  const raw = await port.readObject(key)
  if (raw === null) return null
  try {
    const snapshot = snapshotOf(JSON.parse(raw))
    if (!snapshot || createHash('sha256').update(canonicalSnapshot(snapshot)).digest('hex') !== key) return null
    return tupleOf(snapshot.citation)
  } catch {
    return null
  }
}

/**
 * Assembles the sidecar from what this desk actually holds: every archive
 * key any loaded Goal document's own index still names, read back and
 * re-validated (never trusted merely because a filename matches), plus every
 * Seat's attachment history. Refuses outright — never truncates quietly —
 * once a bound is crossed, so a caller never mistakes a partial export for a
 * complete one (decision: "do not silently produce a complete-sounding
 * export with missing citations").
 */
export const exportMemory = async (port: MemoryBackupPort): Promise<MemoryBackup> => {
  const documents = port.documents()
  const keys = new Set<string>()
  for (const { memory } of documents) for (const one of memory.citations) keys.add(one.archive)
  if (keys.size > MAX_OBJECTS) {
    throw new Error('This desk has retained more citations than one backup file can hold.')
  }

  let bytes = 0
  const objects: { key: string; snapshot: MemorySnapshot }[] = []
  for (const key of [...keys].sort()) {
    const raw = await port.readObject(key)
    if (raw === null) continue // a reference with nothing behind it locally — left out, never invented
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      continue
    }
    const snapshot = snapshotOf(parsed)
    if (!snapshot) continue
    bytes += Buffer.byteLength(raw, 'utf8')
    if (bytes > MAX_BYTES) throw new Error('This desk’s retained memory is too large for one backup file.')
    objects.push({ key, snapshot })
  }

  const attachments = await port.attachmentHistory()
  if (attachments.length > MAX_ATTACHMENTS) {
    throw new Error('This desk has recorded more Seat attachment history than one backup file can hold.')
  }
  for (const record of attachments) {
    bytes += Buffer.byteLength(JSON.stringify(record), 'utf8')
    if (bytes > MAX_BYTES) throw new Error('This desk’s retained memory is too large for one backup file.')
  }

  return {
    version: 1,
    objects,
    indexes: documents.map(({ goal, memory }) => ({ goal, memory })),
    attachments,
  }
}

/**
 * Restores additively, one entry at a time, so one damaged object never
 * aborts the valid history around it. Three passes, in this exact order: an
 * object must be accepted (or already present) before any index that names
 * it can be trusted; an index is only ever folded into a Goal this desk
 * already has, never used to invent one; Seat attachment epochs are
 * independent of both and always land marked `restored: true`.
 */
export const importMemory = async (
  port: MemoryBackupPort,
  raw: unknown,
): Promise<MemoryBackupReport> => {
  const report = { restored: 0, alreadyHere: 0, refused: 0, failed: 0 }
  if (raw === undefined) return report
  if (
    !object(raw) ||
    raw.version !== 1 ||
    !Array.isArray(raw.objects) ||
    !Array.isArray(raw.indexes) ||
    !Array.isArray(raw.attachments) ||
    raw.objects.length > MAX_OBJECTS ||
    raw.attachments.length > MAX_ATTACHMENTS ||
    Buffer.byteLength(JSON.stringify(raw)) > MAX_BYTES
  ) {
    return { ...report, refused: 1 }
  }

  /** Archive key → the citation tuple its accepted object actually carries. */
  const accepted = new Map<string, string>()
  for (const entry of raw.objects) {
    if (!object(entry) || typeof entry.key !== 'string') {
      report.refused += 1
      continue
    }
    const snapshot = snapshotOf(entry.snapshot)
    if (!snapshot) {
      report.refused += 1
      continue
    }
    const canonical = canonicalSnapshot(snapshot)
    const realKey = createHash('sha256').update(canonical).digest('hex')
    if (realKey !== entry.key || Buffer.byteLength(canonical, 'utf8') > 9 * 1024 * 1024) {
      report.refused += 1 // a bad digest or an over-size snapshot — never trusted, never written
      continue
    }
    const existing = await port.readObject(entry.key)
    if (existing !== null) {
      if (existing === canonical) {
        report.alreadyHere += 1
        accepted.set(entry.key, tupleOf(snapshot.citation))
      } else {
        report.refused += 1 // same key, different bytes — a hash collision or local damage, never guessed at
      }
      continue
    }
    try {
      await port.writeObject(snapshot)
      report.restored += 1
      accepted.set(entry.key, tupleOf(snapshot.citation))
    } catch {
      report.failed += 1
    }
  }

  for (const entry of raw.indexes) {
    if (!object(entry) || typeof entry.goal !== 'string' || !memoryIndexOf(entry.memory)) {
      report.refused += 1
      continue
    }
    const validCitations: { citation: GoalCitation; archive: string }[] = []
    for (const one of entry.memory.citations) {
      // The object an index names must exist *and* carry the very citation
      // the index says it does: an index is a claim, and an archive that
      // holds some other citation's bytes would let a hostile backup point a
      // live citation at the wrong text — or collide with it on purpose.
      const carried = accepted.get(one.archive) ?? (await carriedBy(port, one.archive))
      if (carried === null) {
        report.refused += 1 // an orphan link — never accepted as a dangling history reference
        continue
      }
      if (carried !== tupleOf(one.citation)) {
        report.refused += 1 // the archive holds a different citation than this link claims
        continue
      }
      validCitations.push(one)
    }
    if (validCitations.length === 0) continue
    if (validCitations.every((one) => port.isRegistered(one.citation, one.archive))) {
      report.alreadyHere += 1 // every link this index carries is already registered under this exact archive
      continue
    }
    const survivingGoals = new Set(validCitations.map((one) => one.citation.goal))
    const satisfiedCitationSources = entry.memory.satisfiedCitationSources.filter((one) => survivingGoals.has(one.goal))
    const ok = port.registerRestoredMemory(entry.goal as GoalId, { citations: validCitations, satisfiedCitationSources })
    if (ok) report.restored += 1
    else report.refused += 1 // no such Goal here — history with nothing local to attach to
  }

  for (const entry of raw.attachments) {
    const record = attachmentRecordOf(entry)
    if (!record) {
      report.refused += 1
      continue
    }
    try {
      const outcome = await port.appendAttachment(record)
      report[outcome] += 1
    } catch {
      report.failed += 1
    }
  }

  return report
}
