/** Volatile scheduling only: it never changes a Goal's accounting or its reservation.
 * A later reading may settle later and hold daily capacity longer. State resets on restart,
 * so fairness is within a running host only. A blocked read can still hold the serial pass. */
export class BackgroundMeter {
  readonly #attempts = new Map<string, { count: number; next: number }>()
  #starts: number[] = []
  #cursor: string | null = null
  #lastClock = 0

  /** Select and reserve a read before it starts. A rolling window covers repeated meter passes. */
  take(held: readonly string[], clock: number): string | null {
    const now = this.#lastClock = Math.max(this.#lastClock, clock)
    const keys = [...new Set(held)].sort()
    const present = new Set(keys)
    for (const key of this.#attempts.keys()) if (!present.has(key)) this.#attempts.delete(key)
    this.#starts = this.#starts.filter(start => now - start < 30_000)
    if (this.#starts.length >= 8 || keys.length === 0) return null
    const index = this.#cursor === null ? 0 : keys.findIndex(key => key > this.#cursor!)
    const start = index < 0 ? 0 : index
    for (let i = 0; i < keys.length; i++) {
      const key = keys[(start + i) % keys.length]!
      const previous = this.#attempts.get(key)
      if (previous && now < previous.next) continue
      const count = (previous?.count ?? 0) + 1
      // Initial attempt and three normal opportunities, then 60s and 120s capped.
      const delay = count <= 3 ? 30_000 : count === 4 ? 60_000 : 120_000
      this.#attempts.set(key, { count, next: now + delay })
      this.#starts.push(now)
      this.#cursor = key
      return key
    }
    return null
  }
}
