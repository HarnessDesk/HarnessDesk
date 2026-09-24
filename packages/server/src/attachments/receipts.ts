import { constants } from 'node:fs'
import { mkdir, open, readdir, rename, rm } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'

import type {
  AttachmentDeclaration,
  AttachmentLoadResult,
  SeatAttachmentsRecord,
  SeatId,
} from '@harnessdesk/protocol'

/**
 * Append-only, per-Seat attachment history.
 *
 * One file per Seat, one JSON line per observation epoch — never rewritten,
 * only appended to, under the desk's own single-writer lease. Epoch 0 is the
 * Seat's initial loading; a reconnect or a resume appends a new epoch rather
 * than editing the one already on disk, so a historical "loaded" can never
 * quietly become a "not-loaded" (or the reverse) after the fact. A missing
 * file answers "not recorded" — every Seat opened before this phase shipped
 * — and is never confused with a Seat that loaded nothing on purpose (an
 * empty `results` list, in an epoch that exists).
 */

const MAX_LINE_BYTES = 256 * 1024
const MAX_DECLARATIONS_PER_KIND = 64

const object = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every((one) => typeof one === 'string')

const isIdentity = (value: unknown): boolean =>
  object(value) &&
  ['skill', 'mcp', 'notes'].includes(String(value.kind)) &&
  typeof value.name === 'string' &&
  typeof value.digest === 'string' &&
  ['agent', 'library'].includes(String(value.source)) &&
  typeof value.pathLabel === 'string'

const isDeclaration = (value: unknown): value is AttachmentDeclaration =>
  object(value) &&
  ['skill', 'mcp', 'notes'].includes(String(value.kind)) &&
  typeof value.name === 'string' &&
  (value.identity === null || isIdentity(value.identity)) &&
  (value.problem === null || typeof value.problem === 'string')

const isLoadResult = (value: unknown): value is AttachmentLoadResult =>
  object(value) &&
  isIdentity(value.identity) &&
  ['loaded', 'not-loaded'].includes(String(value.status)) &&
  (value.reason === null || typeof value.reason === 'string')

/** Refuse a partial or malformed line rather than guess at what it meant. */
const recordOf = (value: unknown): SeatAttachmentsRecord | null => {
  if (
    !object(value) ||
    value.version !== 1 ||
    typeof value.seat !== 'string' ||
    typeof value.agentDigest !== 'string' ||
    typeof value.runtime !== 'string' ||
    typeof value.build !== 'string' ||
    !Number.isSafeInteger(value.epoch) ||
    Number(value.epoch) < 0 ||
    !Number.isFinite(value.observedAt) ||
    !['runtime-defaults', 'allowlist'].includes(String(value.skillsMode)) ||
    !['runtime-defaults', 'allowlist'].includes(String(value.mcpMode)) ||
    !Array.isArray(value.declarations) ||
    !value.declarations.every(isDeclaration) ||
    !Array.isArray(value.results) ||
    !value.results.every(isLoadResult) ||
    typeof value.restored !== 'boolean'
  ) {
    return null
  }
  return value as unknown as SeatAttachmentsRecord
}

/** A filesystem-safe file name for a Seat id — the same rule the Goal store's own `goalFile` uses. */
const seatFile = (seat: SeatId): string => {
  const encoded = `${encodeURIComponent(seat)}.ndjson`
  return Buffer.byteLength(encoded) <= 255 ? encoded : `h-${Buffer.from(seat).toString('base64url').slice(0, 200)}.ndjson`
}

export class AttachmentReceipts {
  #tail: Promise<void> = Promise.resolve()

  constructor(private readonly folder: string) {}

  /**
   * Appends one epoch. Refuses (without writing) a record whose epoch is not
   * exactly one past the last one on disk (or 0 for a brand new file), a
   * line over the byte bound, or a declaration list over the per-kind count
   * — bounds a hostile or malformed caller must never be able to grow past.
   */
  async append(record: SeatAttachmentsRecord): Promise<void> {
    const perKind = (kind: 'skill' | 'mcp' | 'notes'): number => record.declarations.filter((one) => one.kind === kind).length
    if (perKind('skill') > MAX_DECLARATIONS_PER_KIND || perKind('mcp') > MAX_DECLARATIONS_PER_KIND) {
      throw new Error(`A Seat may declare at most ${MAX_DECLARATIONS_PER_KIND} attachments per kind.`)
    }
    const line = `${JSON.stringify(record)}\n`
    if (Buffer.byteLength(line, 'utf8') > MAX_LINE_BYTES) {
      throw new Error(`This Seat's attachment record is larger than ${MAX_LINE_BYTES / 1024} KiB.`)
    }
    const run = this.#tail.then(async () => {
      await mkdir(this.folder, { recursive: true, mode: 0o700 })
      const path = join(this.folder, seatFile(record.seat))
      const existing = await this.#historyOf(path)
      const nextEpoch = existing.length === 0 ? 0 : existing[existing.length - 1]!.epoch + 1
      if (record.epoch !== nextEpoch) {
        throw new Error(`This Seat's attachment epoch must increase by exactly one (expected ${nextEpoch}, got ${record.epoch}).`)
      }
      // Append via read-whole/rewrite-whole under the folder's own write
      // queue: at Seat-open volumes an NDJSON O_APPEND would also serve, but
      // rewriting through the same atomic temp-then-rename path every other
      // durable file in this codebase uses means one failure mode to reason
      // about, not two.
      const text = `${existing.map((one) => JSON.stringify(one)).join('\n')}${existing.length > 0 ? '\n' : ''}${line}`
      const temporary = `${path}.${randomUUID()}.tmp`
      const handle = await open(temporary, 'wx', 0o600)
      try {
        await handle.writeFile(text, 'utf8')
        await handle.sync()
      } finally {
        await handle.close()
      }
      try {
        await rename(temporary, path)
      } finally {
        await rm(temporary, { force: true })
      }
    })
    this.#tail = run.then(
      () => undefined,
      () => undefined,
    )
    await run
  }

  /** The latest epoch, or `null` when nothing was ever recorded for this Seat. */
  async read(seat: SeatId): Promise<SeatAttachmentsRecord | null> {
    const history = await this.history(seat)
    return history.length === 0 ? null : history[history.length - 1]!
  }

  /** Every epoch, oldest first — history a restored or legacy Seat still shows even though it can mint no live token. */
  async history(seat: SeatId): Promise<readonly SeatAttachmentsRecord[]> {
    return this.#historyOf(join(this.folder, seatFile(seat)))
  }

  /**
   * Every observation epoch of every Seat this desk has ever recorded,
   * flattened — Task 6's own backup export. Reads each sidecar file's own
   * records rather than decoding a Seat id back out of its (sometimes
   * shortened) file name: every line already names its own `seat`, which is
   * the only identity that matters here.
   */
  async allHistories(): Promise<readonly SeatAttachmentsRecord[]> {
    let names: string[]
    try {
      names = await readdir(this.folder)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
    const all: SeatAttachmentsRecord[] = []
    for (const name of names) {
      if (!name.endsWith('.ndjson')) continue
      all.push(...(await this.#historyOf(join(this.folder, name))))
    }
    return all
  }

  async #historyOf(path: string): Promise<readonly SeatAttachmentsRecord[]> {
    let text: string
    try {
      const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
      try {
        text = await handle.readFile('utf8')
      } finally {
        await handle.close()
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT' || (error as NodeJS.ErrnoException).code === 'ELOOP') return []
      throw error
    }
    const records: SeatAttachmentsRecord[] = []
    let lastEpoch = -1
    for (const line of text.split('\n')) {
      if (!line.trim()) continue
      let parsed: unknown
      try {
        parsed = JSON.parse(line)
      } catch {
        break // a line that does not parse is where trust ends, exactly like one that does not validate
      }
      const record = recordOf(parsed)
      // A line that does not parse, or whose epoch does not strictly
      // increase, stops the read rather than silently reordering history —
      // a truncated or corrupted tail is a reason to trust nothing past it.
      if (!record || record.epoch <= lastEpoch) break
      lastEpoch = record.epoch
      records.push(record)
    }
    return records
  }
}

export { seatFile as attachmentSeatFileFor, recordOf as attachmentRecordOf }
