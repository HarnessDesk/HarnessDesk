import { setImmediate } from 'node:timers/promises'

/** Clock and yield injection lets tests count work without loading the shared machine. */
export interface SliceOptions {
  readonly now?: () => number
  readonly yield?: () => Promise<void>
  readonly items?: number
}

/** Yield after 100 items or 20 ms, whichever comes first. An item is bounded by its caller. */
export class WorkSlices {
  readonly #now: () => number
  readonly #yield: () => Promise<void>
  readonly #items: number
  #count = 0
  #began: number

  constructor(options: SliceOptions = {}) {
    this.#now = options.now ?? (() => performance.now())
    this.#yield = options.yield ?? setImmediate
    this.#items = options.items ?? 100
    this.#began = this.#now()
  }

  async step(): Promise<void> {
    if (++this.#count < this.#items && this.#now() - this.#began < 20) return
    await this.#yield()
    this.#count = 0
    this.#began = this.#now()
  }
}
