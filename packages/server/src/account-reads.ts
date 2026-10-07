import type { AccountStatus } from '@harnessdesk/protocol'

export const ACCOUNT_READ_DEADLINE_MS = 10_000

/** One account read per registration, including after callers stop waiting. */
export class AccountReads {
  #pending: Promise<AccountStatus> | null = null
  #changed: (() => void) | null = null

  invalidate(): void {
    this.#changed?.()
  }

  read(read: () => Promise<AccountStatus>): Promise<AccountStatus> {
    if (this.#pending) return this.#pending

    let timer: ReturnType<typeof setTimeout>
    const deadline = new Promise<AccountStatus>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`Account read timed out after ${ACCOUNT_READ_DEADLINE_MS}ms.`)), ACCOUNT_READ_DEADLINE_MS)
      this.#changed = () => {
        clearTimeout(timer)
        reject(new Error('Account changed during a read. Try again.'))
      }
    })
    // Includes lifecycle waits and synchronous adapter failures in the bound.
    const attempt = Promise.resolve().then(read)
    this.#pending = Promise.race([attempt, deadline])
    const settled = (): void => {
      clearTimeout(timer)
      this.#pending = null
      this.#changed = null
    }
    // A deadline does not cancel an adapter. Keep the expired result until
    // the actual read settles, so retries neither queue nor start more work.
    // Both handlers consume late settlement; no successful answer is cached.
    void attempt.then(settled, settled)
    return this.#pending
  }
}
