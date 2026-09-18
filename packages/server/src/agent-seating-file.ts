import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

import { SEAT_PREFERENCE_LIMIT, type FlowSeat, type MachineSeating, type SeatingProblem } from '@harnessdesk/protocol'

import { asList, asRecord, asText, parseSeat, seatFromMap, seatSpec } from './flow.js'

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
 * is somebody's.
 *
 * Seats are read by the same two functions a flow and an `AGENT.md` read
 * them with — the compact spec, or the long form for a model whose name the
 * spec cannot carry — so one spec string means one seat wherever it is written.
 */

export const SEATING_FILE = 'seating.json'

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error))

/** What one file's text says: the entries that read, in order, and why the others did not. Pure. */
export const parseSeating = (
  text: string,
): { entries: { id: string; seats: FlowSeat[] }[]; problems: SeatingProblem[] } => {
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
  const entries: { id: string; seats: FlowSeat[] }[] = []
  const problems: SeatingProblem[] = []
  for (const [id, value] of Object.entries(file)) {
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
    const seats: FlowSeat[] = []
    let broken = false
    listed.forEach((one, index) => {
      const map = asRecord(one)
      const seat = map ? seatFromMap(map) : parseSeat(asText(one) ?? '')
      if (typeof seat === 'string') {
        problems.push({ id, at: `[${index}]`, text: seat })
        broken = true
        return
      }
      seats.push(seat)
    })
    // Refused whole: trying a shorter list than the file says would be the quiet kind of wrong.
    if (!broken) entries.push({ id, seats })
  }
  return { entries, problems }
}

/** A seat as the file writes it: the compact spec, or the long form when the model's name would not survive the spec. */
const written = (seat: FlowSeat): string | Record<string, unknown> =>
  seat.model && /[=/+]/.test(seat.model)
    ? {
        runtime: seat.runtime,
        model: seat.model,
        ...(seat.effort ? { effort: seat.effort } : {}),
        ...(seat.thinking ? { thinking: true } : {}),
      }
    : seatSpec(seat)

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
      return { path: this.path, entries: [], problems: [{ id: null, at: '', text: `it could not be read — ${messageOf(error)}` }] }
    }
    return { path: this.path, ...parseSeating(text) }
  }

  /**
   * Sets one Agent's seats here, or clears them (`null`) so its `prefer`
   * applies again. Every other entry is kept exactly as written — a broken one
   * included, because it is the person's to fix — and in its place. Refused
   * while the file cannot be read as a whole, so a hand-edit is never lost.
   */
  set(id: string, seats: readonly FlowSeat[] | null): Promise<MachineSeating> {
    const run = async (): Promise<MachineSeating> => {
      if (seats !== null && seats.length === 0) {
        throw new Error("An Agent's seats on this Mac need at least one seat; clear them to seat it on its own prefer.")
      }
      const now = await this.read()
      const whole = now.problems.find((one) => one.id === null)
      if (whole) {
        throw new Error(`${this.path} was not changed: ${whole.text}. Fix it or remove it first, so what is in it is not lost.`)
      }
      let raw: Record<string, unknown> = {}
      try {
        raw = asRecord(JSON.parse(await readFile(this.path, 'utf8'))) ?? {}
      } catch {
        // No file yet: the first entry makes it.
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
      await mkdir(dirname(this.path), { recursive: true })
      // Write-then-rename, like every file the host owns.
      const temp = `${this.path}.${process.pid}.tmp`
      await writeFile(temp, `${JSON.stringify(Object.fromEntries(pairs), null, 2)}\n`)
      await rename(temp, this.path)
      return this.read()
    }
    // One write at a time, so two quick edits cannot each read the file before the other wrote it.
    const current = this.#writes.then(run, run)
    this.#writes = current.catch(() => undefined)
    return current
  }
}
