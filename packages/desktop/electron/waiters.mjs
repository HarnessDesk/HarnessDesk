/**
 * Callers waiting on one event, each with a deadline of its own.
 *
 * A waiter that runs out of time leaves the queue. The inline browser's
 * timeout filtered its queue for `resolve` when what it had queued was a
 * wrapper around it, so a timed-out waiter stayed, and the next ready handed
 * a guest to a promise that had already rejected (#49).
 *
 * @template T
 */
export const createWaiters = () => {
  /** @type {((value: T) => void)[]} */
  let waiting = []
  return {
    /**
     * Resolves with what `settle` hands over, or rejects with `message` once
     * `timeoutMs` has passed without it.
     * @param {number} timeoutMs
     * @param {string} message
     * @returns {Promise<T>}
     */
    wait: (timeoutMs, message) =>
      new Promise((resolve, reject) => {
        /** @type {ReturnType<typeof setTimeout> | undefined} */
        let timer
        /** @param {T} value */
        const waiter = (value) => {
          clearTimeout(timer)
          resolve(value)
        }
        timer = setTimeout(() => {
          waiting = waiting.filter((entry) => entry !== waiter)
          reject(new Error(message))
        }, timeoutMs)
        waiting.push(waiter)
      }),
    /**
     * Hands `value` to everyone still waiting.
     * @param {T} value
     */
    settle: (value) => {
      const settled = waiting
      waiting = []
      for (const waiter of settled) waiter(value)
    },
    /** How many are still waiting. */
    get pending() {
      return waiting.length
    },
  }
}
