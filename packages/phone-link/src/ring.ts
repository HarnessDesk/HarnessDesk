import { randomUUID } from 'node:crypto'

export interface RingEvent {
  readonly seq: number
  readonly topic: string
  readonly data: unknown
  readonly bytes: number
}

export interface EventRingOptions {
  readonly epoch?: string
  readonly maxEvents?: number
  readonly maxBytes?: number
}

export type RingRead =
  | { readonly ok: true; readonly events: readonly RingEvent[] }
  | { readonly ok: false }

/**
 * What the desk remembers for a phone that dropped off: events numbered in order within one epoch.
 * A new epoch is minted whenever the numbering restarts (a new desk process), so a phone holding an old one
 * knows to read a fresh snapshot instead of trusting a gap.
 */
export class EventRing {
  readonly epoch: string
  #seq = 0
  #events: RingEvent[] = []
  #bytes = 0
  readonly #maxEvents: number
  readonly #maxBytes: number

  constructor(options: EventRingOptions = {}) {
    this.epoch = options.epoch ?? randomUUID()
    this.#maxEvents = options.maxEvents ?? 1024
    this.#maxBytes = options.maxBytes ?? 8 * 1024 * 1024
  }

  /** The number of the newest event; 0 before the first. */
  get seq(): number { return this.#seq }

  append(topic: string, data: unknown): RingEvent {
    const bytes = Buffer.byteLength(JSON.stringify(data) ?? 'null')
    const event: RingEvent = { seq: ++this.#seq, topic, data, bytes }
    this.#events.push(event)
    this.#bytes += bytes
    while (this.#events.length > this.#maxEvents || (this.#bytes > this.#maxBytes && this.#events.length > 1)) {
      this.#bytes -= this.#events.shift()!.bytes
    }
    return event
  }

  /** The events after `after` up to and including `through`, or a reset when they can no longer be given whole. */
  read(epoch: string, after: number, through = this.#seq): RingRead {
    if (epoch !== this.epoch || after > this.#seq) return { ok: false }
    const oldest = this.#events[0]?.seq ?? this.#seq + 1
    if (after + 1 < oldest) return { ok: false }
    return { ok: true, events: this.#events.filter(event => event.seq > after && event.seq <= through) }
  }
}
