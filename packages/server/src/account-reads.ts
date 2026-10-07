import type { AccountStatus, RuntimeId } from '@harnessdesk/protocol'

import type { Logger } from './log.js'

export const ACCOUNT_READ_DEADLINE_MS = 10_000

/** One read per account generation, including after callers stop waiting. */
export class AccountReads {
  #pending: Promise<AccountStatus> | null = null
  #changed: ((error: Error) => void) | null = null
  #closed = false

  constructor(private readonly runtime: RuntimeId, private readonly logger: Logger) {}

  invalidate(): void {
    this.#changed?.(new Error('Account changed during a read. Try again.'))
    this.#pending = null
    this.#changed = null
  }

  dispose(): void {
    this.#closed = true
    this.#changed?.(new Error('Account read stopped because its runtime registration closed.'))
    this.#pending = null
    this.#changed = null
  }

  read(read: () => Promise<AccountStatus>): Promise<AccountStatus> {
    if (this.#closed) return Promise.reject(new Error('Account read stopped because its runtime registration closed.'))
    if (this.#pending) return this.#pending

    let timer: ReturnType<typeof setTimeout>
    const deadline = new Promise<AccountStatus>((_resolve, reject) => {
      timer = setTimeout(() => {
        this.logger.warn('account read timed out', { runtime: this.runtime, afterMs: ACCOUNT_READ_DEADLINE_MS })
        reject(new Error(`Account read timed out after ${ACCOUNT_READ_DEADLINE_MS}ms.`))
      }, ACCOUNT_READ_DEADLINE_MS)
      this.#changed = (error) => {
        clearTimeout(timer)
        reject(error)
      }
    })
    // Includes lifecycle waits and synchronous adapter failures in the bound.
    const attempt = Promise.resolve().then(read)
    const pending = Promise.race([attempt, deadline])
    this.#pending = pending
    const settled = (): void => {
      clearTimeout(timer)
      // An account change can already have started a newer shared read.
      if (this.#pending === pending) {
        this.#pending = null
        this.#changed = null
      }
    }
    // A deadline does not cancel an adapter. Keep the expired result until
    // the actual read settles, so retries neither queue nor start more work.
    // Both handlers consume late settlement; no successful answer is cached.
    void attempt.then(settled, settled)
    return pending
  }
}
