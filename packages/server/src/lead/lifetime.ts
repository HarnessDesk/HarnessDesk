/** Work admitted by one Lead lifetime cannot outlive its journal lease or enter its replacement. */
export class LeadLifetime {
  #closed = false
  readonly #work = new Set<Promise<unknown>>()
  constructor(private readonly enabled: () => boolean) {}
  available = (): boolean => !this.#closed && this.enabled()
  seal(): void { this.#closed = true }
  run<T>(operation: () => Promise<T>): Promise<T | undefined> {
    if (!this.available()) return Promise.resolve(undefined)
    const work = Promise.resolve().then(() => this.available() ? operation() : undefined)
    this.#work.add(work)
    void work.finally(() => this.#work.delete(work)).catch(() => {})
    return work
  }
  async drain(): Promise<void> {
    this.seal()
    while (this.#work.size) await Promise.allSettled([...this.#work])
  }
}
