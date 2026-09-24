import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

import type {
  GoalCitation,
  GoalId,
  GoalMemoryIndex,
  GoalReceipt,
  MemoryFile,
  MemoryResolution,
  MemorySnapshot,
  SeatId,
  SeatRecord,
} from '@harnessdesk/protocol'

import { citationOf, receiptOf } from '../goals/store.js'
import { CitationArchive } from './archive.js'
import { admitMemoryRoot, listMemoryFiles, memoryPath, readMemoryBlob } from './git.js'

const exec = promisify(execFile)

/** Whether a commit is still reachable in this repository — existence only, never its content. */
const commitExists = async (root: string, at: string): Promise<boolean> => {
  try {
    await exec('git', ['--no-replace-objects', '-C', root, 'cat-file', '-e', `${at}^{commit}`], {
      timeout: 5000,
      env: { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_NO_LAZY_FETCH: '1' },
    })
    return true
  } catch {
    return false
  }
}

const tupleKey = (citation: GoalCitation): string =>
  JSON.stringify([citation.goal, citation.receipt, citation.project, citation.path, citation.at])

/** Fixed top-level field order — the canonical form every retained snapshot is written in. */
export const canonicalSnapshot = (snapshot: MemorySnapshot): string =>
  JSON.stringify({
    version: snapshot.version,
    citation: {
      goal: snapshot.citation.goal,
      receipt: snapshot.citation.receipt,
      project: snapshot.citation.project,
      path: snapshot.citation.path,
      at: snapshot.citation.at,
    },
    text: snapshot.text,
    receipt: snapshot.receipt,
    seats: snapshot.seats,
    capturedAt: snapshot.capturedAt,
    missingSeatIds: snapshot.missingSeatIds,
  })

const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every((one) => typeof one === 'string')

/** A light shape check: a Seat's identity fields, never a re-verification of its full history. */
const looksLikeSeat = (value: unknown): value is SeatRecord =>
  object(value) && typeof value.id === 'string' && object(value.session) &&
  typeof (value.session as { runtime?: unknown }).runtime === 'string'

/** Reads a snapshot back exactly as strictly as `capture` could have written one — never more permissively. */
export const snapshotOf = (value: unknown): MemorySnapshot | null => {
  if (!object(value) || value.version !== 1) return null
  if (!citationOf(value.citation)) return null
  if (typeof value.text !== 'string') return null
  if (!Number.isFinite(value.capturedAt)) return null
  if (!strings(value.missingSeatIds)) return null
  if (!Array.isArray(value.seats) || !value.seats.every(looksLikeSeat)) return null
  const citation = value.citation
  if (!receiptOf(value.receipt, citation.goal, citation.receipt)) return null
  return value as unknown as MemorySnapshot
}

export interface MemoryPlanePort {
  /** The current receipt for a Goal that still exists and is wrapped; null once it is gone or never was. */
  receiptOf(goal: GoalId): GoalReceipt | null
  seats: { byId(id: SeatId): SeatRecord | null }
}

export interface GoalMemoryPort {
  capture(citation: GoalCitation): Promise<string>
  resolve(citation: GoalCitation): Promise<MemoryResolution>
}

/**
 * Retention, resolution and listing for project memory citations.
 *
 * Two separate trust levels live here on purpose. `capture`/`resolve` answer
 * from an in-memory registry built only by `register` — never by scanning
 * the archive folder — so a file that merely *exists* there, planted rather
 * than referenced by any Goal document this desk has actually loaded, is
 * never treated as available. `register` itself distinguishes a citation
 * registered from a live, currently-open Goal document from one registered
 * because the document that named it arrived from a restore: only the first
 * kind can ever satisfy a missing citation-created dependency.
 */
export class MemoryPlane implements GoalMemoryPort {
  private readonly archive: CitationArchive
  /** tuple -> archive key, from every `register` call regardless of provenance. */
  private readonly registered = new Map<string, string>()
  /** tuple -> true only when every registration seen for it came from a restored document. */
  private readonly restoredOnly = new Map<string, boolean>()
  /** tuples with two different archive keys registered — an integrity problem, never resolved by guessing. */
  private readonly poisoned = new Set<string>()
  /** In-flight or completed captures this process made, keyed by tuple, so concurrent callers converge on one key. */
  private readonly capturing = new Map<string, Promise<string>>()

  constructor(
    folder: string,
    private readonly port: MemoryPlanePort,
    private readonly now: () => number = Date.now,
  ) {
    this.archive = new CitationArchive(folder)
  }

  capture(citation: GoalCitation): Promise<string> {
    const tuple = tupleKey(citation)
    const existing = this.capturing.get(tuple)
    if (existing) return existing
    const operation = this.#captureOnce(citation).catch((error: unknown) => {
      this.capturing.delete(tuple)
      throw error
    })
    this.capturing.set(tuple, operation)
    return operation
  }

  async #captureOnce(citation: GoalCitation): Promise<string> {
    memoryPath(citation.path)
    if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(citation.at)) throw new Error('Choose a full commit revision.')
    const root = await admitMemoryRoot(citation.project)
    const text = await readMemoryBlob(root, citation.at, citation.path)
    const receipt = this.port.receiptOf(citation.goal)
    if (!receipt || receipt.id !== citation.receipt) {
      throw new Error('Choose an existing wrapped receipt.')
    }
    const missingSeatIds: string[] = []
    const seats: SeatRecord[] = []
    for (const id of receipt.seats) {
      const seat = this.port.seats.byId(id)
      if (seat) seats.push(seat)
      else missingSeatIds.push(id)
    }
    const snapshot: MemorySnapshot = {
      version: 1,
      citation,
      text,
      receipt,
      seats,
      capturedAt: this.now(),
      missingSeatIds,
    }
    const serialized = canonicalSnapshot(snapshot)
    if (Buffer.byteLength(serialized, 'utf8') > 9 * 1024 * 1024) {
      throw new Error('This citation is too large to retain: 9 MiB includes its receipt and Seat context.')
    }
    // The reference callback is a no-op by design (decision 12 of the phase-12
    // plan): the Goal mutation that actually references this key happens in
    // the caller, after this returns, inside the Goal's own transaction —
    // never while this archive's own write queue is held, which is what
    // keeps the two queues from ever deadlocking against each other.
    return this.archive.retain(serialized, async () => {})
  }

  async resolve(citation: GoalCitation): Promise<MemoryResolution> {
    const tuple = tupleKey(citation)
    if (this.poisoned.has(tuple)) {
      return { state: 'unavailable', citation, reason: 'Two different archives are registered for this citation — an integrity problem.' }
    }
    const key = this.registered.get(tuple)
    if (!key) return { state: 'unavailable', citation, reason: 'The original source was not retained.' }
    const text = await this.archive.read(key)
    if (text === null) return { state: 'unavailable', citation, reason: 'The retained copy could not be read back.' }
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      return { state: 'unavailable', citation, reason: 'The retained copy is damaged.' }
    }
    const snapshot = snapshotOf(parsed)
    if (!snapshot || tupleKey(snapshot.citation) !== tuple) {
      return { state: 'unavailable', citation, reason: 'The retained copy is damaged.' }
    }
    const receipt = this.port.receiptOf(citation.goal)
    const sourceAvailable = receipt !== null && receipt.id === citation.receipt
    let revisionAvailable = false
    try {
      const root = await admitMemoryRoot(citation.project)
      revisionAvailable = await commitExists(root, citation.at)
    } catch {
      revisionAvailable = false
    }
    return {
      state: 'retained',
      snapshot,
      sourceAvailable,
      revisionAvailable,
      restored: this.restoredOnly.get(tuple) ?? false,
    }
  }

  /** Whether this exact tuple is already registered under this exact archive key — backup import's own duplicate check, never an I/O read. */
  isRegistered(citation: GoalCitation, archive: string): boolean {
    return this.registered.get(tupleKey(citation)) === archive
  }

  /**
   * A synchronous, in-memory-only answer for a caller (`GoalPlane`'s
   * citation-created dependency check) that cannot await one more I/O round
   * trip: true whenever this tuple was never registered live at all, or has
   * an integrity problem, or was registered only from a restored document —
   * every case in which retained history must not be trusted to authorize
   * new work.
   */
  isKnownRestored(citation: GoalCitation): boolean {
    const tuple = tupleKey(citation)
    if (this.poisoned.has(tuple)) return true
    if (!this.registered.has(tuple)) return true
    return this.restoredOnly.get(tuple) === true
  }

  /**
   * The exact bytes filed under one content-addressed key, with no citation
   * shape check at all — Task 6's own backup export, which reads by key
   * because that is what a Goal document's own index names, never by tuple.
   */
  readRaw(key: string): Promise<string | null> {
    return this.archive.read(key)
  }

  /**
   * Writes an already-captured snapshot back verbatim — the same canonical
   * form and size bound `capture` itself uses, so an imported object is
   * refiled under the exact key it was exported with. Import-only: a live
   * capture always goes through `capture`, never this.
   */
  writeSnapshot(snapshot: MemorySnapshot): Promise<string> {
    const serialized = canonicalSnapshot(snapshot)
    if (Buffer.byteLength(serialized, 'utf8') > 9 * 1024 * 1024) {
      throw new Error('This citation is too large to retain: 9 MiB includes its receipt and Seat context.')
    }
    return this.archive.retain(serialized, async () => {})
  }

  async list(root: string, at: string): Promise<readonly MemoryFile[]> {
    const admitted = await admitMemoryRoot(root)
    const found = await listMemoryFiles(admitted, at)
    return found.map((one) => ({ path: one.path, at, problem: one.problem }))
  }

  /**
   * Folds one Goal document's citation index into the live lookup. Called
   * once per durable Goal mutation that changes it, and once per Goal loaded
   * at startup — `restored` distinguishes the two only in the second case
   * (`GoalDocument.restored !== undefined`); a citation registered even once
   * from a live document is never downgraded back to restored-only by a
   * later restored registration of the same tuple, but a tuple seen only
   * from restored documents stays marked restored until a live one
   * registers it.
   */
  register(index: GoalMemoryIndex, restored = false): void {
    for (const one of index.citations) {
      const tuple = tupleKey(one.citation)
      if (this.poisoned.has(tuple)) continue
      const current = this.registered.get(tuple)
      if (current !== undefined && current !== one.archive) {
        this.poisoned.add(tuple)
        this.registered.delete(tuple)
        this.restoredOnly.delete(tuple)
        continue
      }
      this.registered.set(tuple, one.archive)
      if (!restored) this.restoredOnly.set(tuple, false)
      else if (!this.restoredOnly.has(tuple)) this.restoredOnly.set(tuple, true)
    }
  }
}
