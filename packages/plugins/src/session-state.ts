import type { ScopeQuery } from '@harnessdesk/protocol'

/**
 * Per-conversation state for a plugin.
 *
 * The extension kernel is one instance for the whole application, so a plugin
 * that keeps state in a bare closure variable shares it with every conversation
 * open at the same time: one turn clears another's counters, and one session's
 * work is reported to a session that never did it. Anything a plugin remembers
 * between calls belongs to the conversation that produced it.
 *
 * `todo.ts` has done this by hand since lists were split — a `Map`, a key, its
 * own eviction. This is the same idea named once, so the next plugin does not
 * have to reinvent it. That file is deliberately left alone: it is not broken,
 * and rewriting working code inside a fix is how a fix acquires a defect.
 */

/**
 * The key a conversation's state is held under.
 *
 * NUL rather than a space or a colon, because it cannot occur in either half —
 * a separator that *can* appear in what it separates makes two different
 * conversations share one key, and this repository has already shipped that bug
 * once, in `transcripts.ts`.
 *
 * A caller the host could not resolve to a session — a direct kernel call, an
 * expired correlation token — lands on one shared entry under the empty key,
 * which is exactly the behaviour every plugin had before state was split. It
 * degrades to the old shape rather than losing what it was holding.
 */
export const scopeKey = (scope: ScopeQuery | undefined): string =>
  `${scope?.runtime ?? ''}\u0000${scope?.sessionId ?? ''}`

/**
 * How many conversations are kept. The entries are small and live only as long
 * as the app, but keying by session in a desk left open for days is otherwise
 * an unbounded map with no lid on it. The least recently *used* entry goes; a
 * conversation still being worked in keeps moving back to the front.
 */
const MAX_SESSIONS = 50

export class PerSession<T> {
  readonly #values = new Map<string, T>()
  readonly #initial: () => T
  readonly #max: number

  constructor(initial: () => T, max: number = MAX_SESSIONS) {
    this.#initial = initial
    this.#max = max
  }

  /** This conversation's state, created on first use. */
  get(scope: ScopeQuery | undefined): T {
    const key = scopeKey(scope)
    const held = this.#values.get(key)
    if (held !== undefined) {
      // Re-inserting moves the key to the back of the Map's own order, so the
      // first key is always the least recently used.
      this.#values.delete(key)
      this.#values.set(key, held)
      return held
    }
    const made = this.#initial()
    this.#values.set(key, made)
    while (this.#values.size > this.#max) {
      const oldest = this.#values.keys().next().value
      if (oldest === undefined) break
      this.#values.delete(oldest)
    }
    return made
  }

  /** Puts this conversation back to its starting state. */
  reset(scope: ScopeQuery | undefined): void {
    this.#values.set(scopeKey(scope), this.#initial())
  }

  /** How many conversations are being held. For tests. */
  get size(): number {
    return this.#values.size
  }
}
