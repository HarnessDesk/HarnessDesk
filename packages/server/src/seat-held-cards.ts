import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { Intent, SeatRecord, SessionPointer, TeamState } from '@harnessdesk/protocol'
import { Serial } from './goals/assignments.js'

type HeldCard = Pick<Intent, 'id' | 'state' | 'updatedAt'>
type Binding = (card: number) => SessionPointer | null | undefined

/** Host-owned rest bookkeeping; never changes cards or the durable Seat record. */
export class SeatHeldCards {
  readonly #held = new Map<string, Map<number, HeldCard>>()
  readonly #writes = new Serial()
  #snapshot = ''

  constructor(private readonly file: string) {}

  async load(): Promise<void> {
    let text: string
    try { text = await readFile(this.file, 'utf8') } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }
    const data = JSON.parse(text) as { version?: unknown; seats?: unknown }
    if (data.version !== 1 || !Array.isArray(data.seats)) throw new Error('The Seat held-card history cannot be read.')
    for (const row of data.seats) {
      if (typeof row?.seat !== 'string' || !Array.isArray(row.cards)) throw new Error('The Seat held-card history cannot be read.')
      const cards = new Map<number, HeldCard>()
      for (const card of row.cards) {
        if (!Number.isSafeInteger(card?.id) || card.id <= 0 || !['open', 'claimed', 'blocked', 'done', 'abandoned'].includes(card.state) ||
          !Number.isFinite(card.updatedAt) || card.updatedAt < 0) throw new Error('The Seat held-card history cannot be read.')
        cards.set(card.id, { id: card.id, state: card.state, updatedAt: card.updatedAt })
      }
      this.#held.set(row.seat, cards)
    }
    this.#snapshot = this.#text()
  }

  cardsFor(seat: SeatRecord, board: TeamState, binding: Binding): readonly HeldCard[] {
    const mine = (pointer: SessionPointer | null | undefined): boolean =>
      pointer?.runtime === seat.session.runtime && pointer.sessionId === seat.session.sessionId
    const held = this.#held.get(seat.id) ?? new Map<number, HeldCard>()
    for (const entry of board.channel) {
      if (entry.kind === 'signal' && entry.signal === 'claimed' && entry.by.kind === 'agent' && mine(entry.by) && !held.has(entry.intent)) {
        // A missing card without recorded completion is unknown, never done.
        held.set(entry.intent, { id: entry.intent, state: 'open', updatedAt: seat.openedAt })
      }
    }
    for (const card of board.intents) {
      if (held.has(card.id) || mine(card.claim) || mine(binding(card.id))) {
        held.set(card.id, { id: card.id, state: card.claim ? 'claimed' : card.state, updatedAt: card.updatedAt })
      }
    }
    this.#held.set(seat.id, held)
    return [...held.values()]
  }

  /** Awaited before a board save: no completion or trimmed card loses its prior holder. */
  async observe(seats: readonly SeatRecord[], board: TeamState, binding: Binding): Promise<void> {
    await this.#writes.run(async () => {
      for (const seat of seats) {
        if (seat.board === board.id && !seat.closed && !seat.restored) this.cardsFor(seat, board, binding)
      }
      const snapshot = this.#text()
      if (snapshot === this.#snapshot) return
      await mkdir(dirname(this.file), { recursive: true })
      const temp = `${this.file}.${process.pid}.tmp`
      await writeFile(temp, `${snapshot}\n`)
      await rename(temp, this.file)
      this.#snapshot = snapshot
    })
  }

  #text(): string {
    return JSON.stringify({ version: 1, seats: [...this.#held].map(([seat, cards]) => ({ seat, cards: [...cards.values()] })) })
  }
}
