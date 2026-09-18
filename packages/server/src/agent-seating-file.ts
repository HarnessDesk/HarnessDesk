import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

import { SEAT_PREFERENCE_LIMIT, type FlowSeat, type MachineSeating, type SeatingProblem } from '@harnessdesk/protocol'

import { asList, asRecord, asText, parseSeat, parseSeatList, seatSpec } from './flow.js'

/**
 * This machine's seats for its Agents: `seating.json` in the state directory.
 *
 * The brief travels with the code; the seating stays on the machine. Which
 * model is installed, signed in and unspent is a fact about one laptop, so an
 * Agent's `prefer` names what its author could expect anywhere, and this file
 * is where a person says "on this Mac, seat the reviewer on Opus".
 *
 * An entry **replaces** its Agent's `prefer` here and never merges with it:
 * two ordered lists merged have no order anyone chose.
 *
 * Validated on the way in, and an entry that fails is reported by its Agent's
 * id, never dropped — dropped, the Agent would be seated on the list the
 * person replaced, without a word. A file that is not JSON is one problem for
 * every Agent, and is never written over: it is hand-edited, and what is in it
 * is somebody's. An id no object can truly own — `__proto__` foremost — is
 * refused the same way: read back, it would be indistinguishable from a real
 * entry, and set to it directly it would not be a key at all.
 *
 * Seats are read by the same grammar a flow and an `AGENT.md` read them
 * with — the compact spec, or the long form for a model whose name the spec
 * cannot carry (`parseSeatList`, shared) — so one spec string means one seat
 * wherever it is written.
 *
 * Two things this file cannot promise. `JSON.parse` keeps the last of two
 * entries for the same Agent id, silently, the way any JSON reader does —
 * telling them apart would need a tokenizer, which this does not have, so a
 * duplicate key is not a problem this reports; the first is just not there to
 * find. And across processes the last writer wins: a hand-edit saved to disk
 * while a `set()` here is in flight can be lost under it, the same as two
 * editors saving one file. Within one process `set()` queues instead: two
 * calls started together both land, each atop what the one before it wrote.
 */

export const SEATING_FILE = 'seating.json'

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error))

/**
 * A file that could not be read at all, said as a sentence like every other
 * problem here ("it is not JSON: …") rather than as the bare error — and in
 * the same words wherever it is shown: `read()`'s problem, `set()`'s refusal.
 */
const unreadable = (error: unknown): string => `it could not be read: ${messageOf(error)}`

/**
 * Whether an id could never truly be its own key. Every object inherits it —
 * read back through `Object.entries`/`JSON.parse` it would sit beside real
 * entries as though it were one, and assigned with `raw[id] = …` it would not
 * set a field at all. The house rule `yaml.ts`'s `keyOf` already keeps for a
 * YAML map's `__proto__`; this file's keys come from `JSON.parse` instead, so
 * it keeps the same rule for itself, and for every other name every object
 * answers to on its own.
 */
const isReservedId = (id: string): boolean => id === '__proto__' || id in Object.prototype

const reservedIdText = (id: string): string =>
  `"${id}" is not read as an Agent id — every object answers to it on its own, so it is never truly this Agent's; rename it`

/** What one file's text says: the entries that read, in order, and why the others did not. Pure. */
export const parseSeating = (
  text: string,
): { entries: { id: string; seats: readonly FlowSeat[] }[]; problems: SeatingProblem[] } => {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    return { entries: [], problems: [{ id: null, at: '', text: `it is not JSON: ${messageOf(error)}` }] }
  }
  const file = asRecord(parsed)
  if (!file) {
    return { entries: [], problems: [{ id: null, at: '', text: 'it is not an object of Agent ids to lists of seats' }] }
  }
  const entries: { id: string; seats: readonly FlowSeat[] }[] = []
  const problems: SeatingProblem[] = []
  for (const [id, value] of Object.entries(file)) {
    if (isReservedId(id)) {
      problems.push({ id, at: '', text: reservedIdText(id) })
      continue
    }
    // A lone seat is one seat, the way `prefer` reads one.
    const listed = asList(value) ?? (asText(value) !== null || asRecord(value) ? [value] : null)
    if (listed === null) {
      problems.push({ id, at: '', text: 'its seats are written as a list, like ["claude-code=opus-5/high", "codex"]' })
      continue
    }
    if (listed.length === 0) {
      problems.push({ id, at: '', text: "it names no seat — remove the entry to seat this Agent on its own prefer" })
      continue
    }
    if (listed.length > SEAT_PREFERENCE_LIMIT) {
      problems.push({
        id,
        at: '',
        text: `it names ${listed.length} seats, and an Agent may name at most ${SEAT_PREFERENCE_LIMIT} — each seat that opens and is passed over costs a conversation`,
      })
      continue
    }
    // Refused whole: trying a shorter list than the file says would be the quiet kind of wrong.
    const { seats, broken } = parseSeatList(listed)
    if (broken.length > 0) {
      for (const one of broken) problems.push({ id, at: `[${one.index}]`, text: one.text })
      continue
    }
    entries.push({ id, seats })
  }
  return { entries, problems }
}

/** Whether two seats name the same thing — not whether they are the same object. */
const sameSeat = (a: FlowSeat, b: FlowSeat): boolean =>
  a.runtime === b.runtime &&
  (a.model ?? null) === (b.model ?? null) &&
  (a.effort ?? null) === (b.effort ?? null) &&
  (a.thinking ?? false) === (b.thinking ?? false)

/**
 * A seat as the file writes it: the compact spec, when reading it back gives
 * the same seat — the long form otherwise.
 *
 * The compact form splits a model off after `=` and an effort off after `/`,
 * switches on `+`, so a runtime, model or effort that itself contains one of
 * those characters would read back as a different seat while this call
 * reported success (`effort: 'high+thinking'` reads back as effort `high`
 * with thinking on; `runtime: 'cursor=m'` as runtime `cursor`, model `m`). A
 * regex naming the dangerous characters would have to be kept in step with
 * `parseSeat` by hand; asking `parseSeat` itself, on what `seatSpec` just
 * wrote, cannot drift from it.
 */
const written = (seat: FlowSeat): string | Record<string, unknown> => {
  const compact = seatSpec(seat)
  const reread = parseSeat(compact)
  if (typeof reread !== 'string' && sameSeat(seat, reread)) return compact
  return {
    runtime: seat.runtime,
    ...(seat.model ? { model: seat.model } : {}),
    ...(seat.effort ? { effort: seat.effort } : {}),
    ...(seat.thinking ? { thinking: true } : {}),
  }
}

/** Whether two JSON values read the same: an array in the order it is in, an object by its keys, never by theirs. */
const sameJson = (a: unknown, b: unknown): boolean => {
  if (a === b) return true
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((one, index) => sameJson(one, b[index]))
  }
  const left = asRecord(a)
  const right = asRecord(b)
  if (left && right) {
    return [...new Set([...Object.keys(left), ...Object.keys(right)])].every((key) => sameJson(left[key], right[key]))
  }
  return false
}

/** What one `set()` did: this machine's seats as they now read, and whether the file was written to get there. */
export interface SeatingSetOutcome {
  readonly seating: MachineSeating
  /**
   * Whether this call wrote the file. Decided inside the write queue, where
   * the writes are ordered, so it is true exactly once for every write,
   * whatever was queued beside it. False for a set that would change nothing:
   * clearing an entry that was never there, or setting the list already in it.
   */
  readonly wrote: boolean
}

export class MachineSeatingFile {
  #writes: Promise<unknown> = Promise.resolve()

  constructor(readonly path: string) {}

  async read(): Promise<MachineSeating> {
    let text: string
    try {
      text = await readFile(this.path, 'utf8')
    } catch (error) {
      // No file is no entries: nobody has chosen seats on this machine yet.
      if ((error as { code?: unknown }).code === 'ENOENT') return { path: this.path, entries: [], problems: [] }
      return { path: this.path, entries: [], problems: [{ id: null, at: '', text: unreadable(error) }] }
    }
    return { path: this.path, ...parseSeating(text) }
  }

  /**
   * Sets one Agent's seats here, or clears them (`null`) so its `prefer`
   * applies again. Every other entry is kept exactly as written — a broken one
   * included, because it is the person's to fix — and in its place. Refused
   * while the file cannot be read as a whole, so a hand-edit is never lost;
   * and a set that would change nothing writes nothing, so clearing an entry
   * that was never there, or setting the list already in it, does not disturb
   * the file's mtime or tell a window anything changed.
   *
   * Answers whether it wrote, because only this can say: a caller comparing a
   * reading of its own, taken outside the queue, with what this answers cannot
   * tell a write that put back what it had read from no write at all.
   */
  set(id: string, seats: readonly FlowSeat[] | null): Promise<SeatingSetOutcome> {
    const run = async (): Promise<SeatingSetOutcome> => {
      // Refused before anything is read or written: accepted, this id would
      // read back indistinguishably from a real entry (`parseSeating` above),
      // and a person could never remove what they cannot see is there.
      if (isReservedId(id)) throw new Error(reservedIdText(id))
      if (seats !== null && seats.length === 0) {
        throw new Error("An Agent's seats on this machine need at least one seat; clear them to seat it on its own prefer.")
      }
      // The wire holds a seating's own `seats` to this same limit
      // (`seatListValidator`); held here too, since `set()` is this class's
      // own contract and a caller inside the process does not cross the wire.
      if (seats !== null && seats.length > SEAT_PREFERENCE_LIMIT) {
        throw new Error(`An Agent's seats on this machine may name at most ${SEAT_PREFERENCE_LIMIT}, not ${seats.length}.`)
      }

      // The file's text, read once. What checks it as a whole and what is
      // kept from it below are the same text — not two separate reads, the
      // second behind a bare `catch {}` that turned not-JSON, non-object
      // JSON, EACCES and EISDIR alike into "empty", and then wrote the
      // person's file down to one entry.
      let text: string | null
      try {
        text = await readFile(this.path, 'utf8')
      } catch (error) {
        if ((error as { code?: unknown }).code !== 'ENOENT') {
          throw new Error(
            `${this.path} was not changed: ${unreadable(error)}. Fix it or remove it first, so what is in it is not lost.`,
          )
        }
        text = null // No file yet: the first entry makes it.
      }
      let raw: Record<string, unknown> = {}
      if (text !== null) {
        let parsed: unknown
        try {
          parsed = JSON.parse(text)
        } catch (error) {
          throw new Error(
            `${this.path} was not changed: it is not JSON: ${messageOf(error)}. Fix it or remove it first, so what is in it is not lost.`,
          )
        }
        const record = asRecord(parsed)
        if (!record) {
          throw new Error(
            `${this.path} was not changed: it is not an object of Agent ids to lists of seats. Fix it or remove it first, so what is in it is not lost.`,
          )
        }
        raw = record
      }

      // Pairs, then `fromEntries`: an Agent id is a folder name, and a folder
      // called `__proto__` assigned with `[]=` would set a prototype, not a key.
      const pairs: [string, unknown][] = []
      let placed = false
      for (const [key, value] of Object.entries(raw)) {
        if (key !== id) {
          pairs.push([key, value])
          continue
        }
        placed = true
        if (seats) pairs.push([key, seats.map(written)])
      }
      if (!placed && seats) pairs.push([id, seats.map(written)])

      const before = Object.hasOwn(raw, id) ? raw[id] : undefined
      const after = seats ? pairs.find(([key]) => key === id)?.[1] : undefined
      if (sameJson(before, after)) return { seating: await this.read(), wrote: false }

      await mkdir(dirname(this.path), { recursive: true })
      // Write-then-rename, like every file the host owns.
      const temp = `${this.path}.${process.pid}.tmp`
      await writeFile(temp, `${JSON.stringify(Object.fromEntries(pairs), null, 2)}\n`)
      await rename(temp, this.path)
      return { seating: await this.read(), wrote: true }
    }
    // One write at a time, so two quick edits cannot each read the file before the other wrote it.
    const current = this.#writes.then(run, run)
    this.#writes = current.catch(() => undefined)
    return current
  }
}
