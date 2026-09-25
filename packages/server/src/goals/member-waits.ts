export interface MemberStatus {
  readonly exists: boolean
  readonly turn: string | null
  readonly stopped: string | null
}

interface Wait {
  readonly caller: string
  readonly member: string
  readonly turn: string
  readonly cycle: number
  readonly resolve: (answer: string) => void
  readonly timer: ReturnType<typeof setTimeout>
  readonly cleanup: () => void
}

/** Event-driven waits for one Goal. The captured turn, not the current one, owns completion. */
export class MemberWaits {
  readonly #waits = new Set<Wait>()

  constructor(private readonly read: (member: string) => MemberStatus) {}

  get size(): number {
    return this.#waits.size
  }

  wait(
    caller: string,
    member: string,
    cycle = 0,
    blockMs = 50_000,
    signal?: AbortSignal,
  ): Promise<string> {
    if (!Number.isSafeInteger(cycle) || cycle < 0 || cycle >= Number.MAX_SAFE_INTEGER) {
      return Promise.reject(new Error('Use a nonnegative safe cycle below the maximum safe integer.'))
    }
    if (!Number.isSafeInteger(blockMs) || blockMs < 1_000 || blockMs > 50_000) {
      return Promise.reject(new Error('Wait for between 1000 and 50000 milliseconds.'))
    }
    if (caller === member) {
      return Promise.reject(new Error('Choose another member; a turn cannot wait for itself.'))
    }
    if (signal?.aborted) return Promise.resolve(this.#answer('stopped: the calling turn ended', cycle))

    const status = this.read(member)
    if (!status.exists) return Promise.resolve(this.#answer('gone', cycle))
    if (status.turn === null) {
      return Promise.resolve(this.#answer(status.stopped ? `stopped: ${status.stopped}` : 'idle', cycle))
    }
    if (this.#waits.size >= 128) {
      return Promise.reject(new Error('This Goal already has 128 member waits'))
    }

    return new Promise((resolve) => {
      const abort = (): void => this.#finish(waiting, 'stopped: the calling turn ended')
      const waiting: Wait = {
        caller,
        member,
        turn: status.turn!,
        cycle,
        resolve,
        cleanup: () => signal?.removeEventListener('abort', abort),
        timer: setTimeout(() => this.#finish(waiting, 'still working'), blockMs),
      }
      this.#waits.add(waiting)
      signal?.addEventListener('abort', abort, { once: true })
    })
  }

  ended(member: string, turn: string, reason: string | null): void {
    for (const waiting of [...this.#waits]) {
      if (waiting.member === member && waiting.turn === turn) {
        this.#finish(waiting, reason ? `stopped: ${reason}` : 'idle')
      }
    }
  }

  gone(member: string): void {
    for (const waiting of [...this.#waits]) {
      if (waiting.member === member || waiting.caller === member) this.#finish(waiting, 'gone')
    }
  }

  cancel(caller: string): void {
    for (const waiting of [...this.#waits]) {
      if (waiting.caller === caller) this.#finish(waiting, 'stopped: the calling turn ended')
    }
  }

  close(reason = 'the desk closed'): void {
    for (const waiting of [...this.#waits]) this.#finish(waiting, `stopped: ${reason}`)
  }

  #answer(text: string, cycle: number): string {
    return `${text.replace(/[\r\n]+/g, ' ').slice(0, 2_000)}; cycle: ${cycle + 1}`
  }

  #finish(waiting: Wait, answer: string): void {
    if (!this.#waits.delete(waiting)) return
    clearTimeout(waiting.timer)
    waiting.cleanup()
    waiting.resolve(this.#answer(answer, waiting.cycle))
  }
}
