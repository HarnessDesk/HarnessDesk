import type { AccountStatus, RuntimeId } from '@harnessdesk/protocol'

import type { Logger } from './log.js'

export const ACCOUNT_READ_DEADLINE_MS = 10_000

/** One read per account generation, including after callers stop waiting. */
export class AccountReads {
  #pending: Promise<AccountStatus> | null = null
  /** How the read in flight is ended early: its callers handed on, or refused. */
  #ending: { readonly handOver: () => void; readonly refuse: (error: Error) => void } | null = null
  #closed = false

  constructor(private readonly runtime: RuntimeId, private readonly logger: Logger) {}

  /**
   * The account changed. A read that began before the notice may report what
   * the account was before it, so callers waiting on one are handed to a fresh
   * read that begins now: not answered by the older adapter whenever it
   * speaks, and not failed for a change that was never theirs to retry.
   *
   * They used to be failed ("Account changed during a read. Try again."), and
   * every caller reported that as an account that could not be read. A
   * signed-in Codex says `account/updated` on its own about 0.6 s after it is
   * up (`script/probe/account-notice.mjs`), which is exactly when a desk that
   * has just started it first reads the account to resolve a seat: that seat,
   * and each one resolved in the same instant, was refused with nothing wrong
   * with the account.
   *
   * Nothing in flight, nothing started. The older adapter's read is not
   * cancelled, as a deadline does not cancel one: it is only no longer anybody's.
   */
  invalidate(): void {
    const ending = this.#ending
    this.#pending = null
    this.#ending = null
    ending?.handOver()
  }

  dispose(): void {
    this.#closed = true
    const ending = this.#ending
    this.#pending = null
    this.#ending = null
    ending?.refuse(new Error('Account read stopped because its runtime registration closed.'))
  }

  read(read: () => Promise<AccountStatus>): Promise<AccountStatus> {
    if (this.#closed) return Promise.reject(new Error('Account read stopped because its runtime registration closed.'))
    return this.#pending ?? this.#begin(read)
  }

  #begin(read: () => Promise<AccountStatus>): Promise<AccountStatus> {
    let timer: ReturnType<typeof setTimeout> | undefined
    let ended = false
    // Includes lifecycle waits and synchronous adapter failures in the bound.
    const attempt = Promise.resolve().then(read)
    const pending = new Promise<AccountStatus>((resolve, reject) => {
      // One way out, whichever comes first: the adapter, the deadline, a change, a teardown.
      const end = (settle: () => void): void => {
        if (ended) return
        ended = true
        clearTimeout(timer)
        settle()
      }
      timer = setTimeout(() => end(() => {
        this.logger.warn('account read timed out', { runtime: this.runtime, afterMs: ACCOUNT_READ_DEADLINE_MS })
        reject(new Error(`Account read timed out after ${ACCOUNT_READ_DEADLINE_MS}ms.`))
      }), ACCOUNT_READ_DEADLINE_MS)
      this.#ending = {
        handOver: () => end(() => resolve(this.#begin(read))),
        refuse: (error) => end(() => reject(error)),
      }
      void attempt.then((status) => end(() => resolve(status)), (error: unknown) => end(() => reject(error)))
    })
    this.#pending = pending
    const release = (): void => {
      // A change can already have started a newer shared read.
      if (this.#pending === pending) {
        this.#pending = null
        this.#ending = null
      }
    }
    // A deadline does not cancel an adapter. Keep the expired result until
    // the actual read settles, so retries neither queue nor start more work.
    // Both handlers consume late settlement; no successful answer is cached.
    void attempt.then(release, release)
    return pending
  }
}
