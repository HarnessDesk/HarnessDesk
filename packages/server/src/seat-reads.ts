/**
 * The reads a seating makes before it chooses, held to a deadline.
 *
 * A seating asks each runtime it names whether it is signed in and what it
 * offers, and asks the desk what is left of each plan. Any of those can fail
 * to answer at all — a bridge wedged on a login shell, an agent that swallowed
 * a request — and a read nobody bounds holds the seating, and every menu drawn
 * from a dry run of it, open for as long as that runtime stays silent.
 *
 * None of these calls takes a signal, so a late read is not cancelled. It is
 * only no longer waited for; whatever it answers afterwards is dropped.
 */

/** How long one read before choosing may take: long enough for a CLI that shells out, short enough for a menu. */
export const SEAT_READ_DEADLINE_MS = 10_000

/** What became of one read: its answer, its failure, or the deadline first. */
export type Within<T> =
  | { readonly settled: 'value'; readonly value: T }
  | { readonly settled: 'error'; readonly error: unknown }
  | { readonly settled: 'late' }

export const within = async <T>(read: () => Promise<T>, ms: number): Promise<Within<T>> => {
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<Within<T>>((resolve) => {
    timer = setTimeout(() => resolve({ settled: 'late' }), ms)
  })
  // Started inside a promise, so a read that throws before it is one is a failure like any other.
  const answered = Promise.resolve()
    .then(read)
    .then(
      (value): Within<T> => ({ settled: 'value', value }),
      (error: unknown): Within<T> => ({ settled: 'error', error }),
    )
  try {
    return await Promise.race([answered, late])
  } finally {
    clearTimeout(timer)
  }
}
