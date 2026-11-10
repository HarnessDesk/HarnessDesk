import { randomUUID } from 'node:crypto'
import { mkdir, open, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { canonicalRepository } from './record.js'

interface ThreadState {
  readonly version: 1
  /** `repository#number#reviewer` → the distinct repair rounds that reviewer's threads were settled in. */
  readonly rounds: Record<string, string[]>
  /** `repository#number` → the threads the desk has answered. */
  readonly answered: Record<string, string[]>
}

const empty = (): ThreadState => ({ version: 1, rounds: {}, answered: {} })

/**
 * Host state for review threads settled by outcome: which repair rounds each
 * reviewer's threads were settled in, and which threads the desk answered.
 * One small JSON beside the other host state files, replaced atomically, so
 * a restart neither resets a bot reviewer's round count nor lets a thread be
 * answered twice.
 */
export class ReviewThreadLedger {
  #tail: Promise<unknown> = Promise.resolve()
  readonly #path: string
  constructor(private readonly stateDirectory: string) { this.#path = join(stateDirectory, 'review-threads.json') }

  static pullRequestKey(repository: string, number: number): string { return `${canonicalRepository(repository)}#${number}` }
  static reviewerKey(repository: string, number: number, reviewer: string): string {
    return `${ReviewThreadLedger.pullRequestKey(repository, number)}#${reviewer.toLowerCase()}`
  }

  async #read(): Promise<ThreadState> {
    try {
      const value = JSON.parse(await readFile(this.#path, 'utf8')) as Partial<ThreadState> | null
      if (!value || typeof value !== 'object' || value.version !== 1) return empty()
      const lists = (input: unknown): Record<string, string[]> => {
        if (!input || typeof input !== 'object' || Array.isArray(input)) return {}
        return Object.fromEntries(Object.entries(input as Record<string, unknown>)
          .filter((entry): entry is [string, string[]] => Array.isArray(entry[1]) && entry[1].every(item => typeof item === 'string')))
      }
      return { version: 1, rounds: lists(value.rounds), answered: lists(value.answered) }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return empty()
      throw error
    }
  }

  async #write(state: ThreadState): Promise<void> {
    await mkdir(this.stateDirectory, { recursive: true, mode: 0o700 })
    const temporary = `${this.#path}.${randomUUID()}.tmp`
    await writeFile(temporary, `${JSON.stringify(state)}\n`, { mode: 0o600 })
    const file = await open(temporary, 'r')
    try { await file.sync() } finally { await file.close() }
    await rename(temporary, this.#path)
    const directory = await open(this.stateDirectory, 'r')
    try { await directory.sync() } finally { await directory.close() }
  }

  #serial<T>(work: () => Promise<T>): Promise<T> {
    const result = this.#tail.then(work)
    this.#tail = result.catch(() => {})
    return result
  }

  /** The distinct rounds a reviewer's threads on one pull request were settled in. */
  rounds(repository: string, number: number, reviewer: string): Promise<readonly string[]> {
    return this.#serial(async () => (await this.#read()).rounds[ReviewThreadLedger.reviewerKey(repository, number, reviewer)] ?? [])
  }

  /** The threads on one pull request the desk has answered. */
  answered(repository: string, number: number): Promise<readonly string[]> {
    return this.#serial(async () => (await this.#read()).answered[ReviewThreadLedger.pullRequestKey(repository, number)] ?? [])
  }

  /**
   * Notes a settle before it is attempted, and returns how to take the note
   * back when the attempt never reached the forge. A note whose attempt may
   * have reached the forge stays: counting a round twice, or refusing a
   * second answer, is the safe side of not knowing.
   */
  note(entry: { readonly repository: string; readonly number: number; readonly reviewer?: string | null; readonly round?: string | null; readonly answered?: string | null }): Promise<() => Promise<void>> {
    return this.#serial(async () => {
      const state = await this.#read()
      const reviewer = entry.reviewer && entry.round ? ReviewThreadLedger.reviewerKey(entry.repository, entry.number, entry.reviewer) : null
      const pull = ReviewThreadLedger.pullRequestKey(entry.repository, entry.number)
      const addedRound = reviewer !== null && !(state.rounds[reviewer] ?? []).includes(entry.round!)
      const addedAnswer = !!entry.answered && !(state.answered[pull] ?? []).includes(entry.answered)
      if (addedRound) state.rounds[reviewer!] = [...(state.rounds[reviewer!] ?? []), entry.round!]
      if (addedAnswer) state.answered[pull] = [...(state.answered[pull] ?? []), entry.answered!]
      if (addedRound || addedAnswer) await this.#write(state)
      return () => this.#serial(async () => {
        const current = await this.#read()
        if (addedRound) current.rounds[reviewer!] = (current.rounds[reviewer!] ?? []).filter(round => round !== entry.round)
        if (addedAnswer) current.answered[pull] = (current.answered[pull] ?? []).filter(thread => thread !== entry.answered)
        if (addedRound || addedAnswer) await this.#write(current)
      })
    })
  }
}
