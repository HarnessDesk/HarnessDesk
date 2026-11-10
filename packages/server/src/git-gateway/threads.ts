import { randomUUID } from 'node:crypto'
import { mkdir, open, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { canonicalRepository } from './record.js'

interface ThreadState {
  readonly version: 1
  /** `repository#number#reviewer` → the distinct repair rounds that reviewer's threads were settled in. */
  readonly rounds: Record<string, string[]>
  /** `repository#number` → the threads the desk has answered. */
  readonly answered: Record<string, string[]>
  /**
   * Set when an earlier record could not be read and was moved aside: what
   * it held is unknown, so agents settle nothing on the pull requests it
   * named (`pulls`; every pull request when it named none) until the person
   * settles one there (`cleared`), removes the moved-aside file, or a day
   * has passed.
   */
  readonly unreadable?: { readonly at: number; readonly file: string; readonly cleared: string[]; readonly pulls?: string[] }
}

/** How long a set-aside record holds agents back at most. */
export const UNREADABLE_HOLD_MS = 24 * 60 * 60_000

const empty = (): ThreadState => ({ version: 1, rounds: {}, answered: {} })

const isLists = (input: unknown): input is Record<string, string[]> =>
  !!input && typeof input === 'object' && !Array.isArray(input)
  && Object.values(input).every(list => Array.isArray(list) && list.every(item => typeof item === 'string'))

const isUnreadable = (input: unknown): input is ThreadState['unreadable'] => {
  if (input === undefined) return true
  const value = input as { at?: unknown; file?: unknown; cleared?: unknown; pulls?: unknown } | null
  return !!value && typeof value === 'object' && Number.isSafeInteger(value.at) && typeof value.file === 'string'
    && /^review-threads\.json\.corrupt-\d+$/.test(value.file)
    && Array.isArray(value.cleared) && value.cleared.every(item => typeof item === 'string')
    && (value.pulls === undefined || (Array.isArray(value.pulls) && value.pulls.every(item => typeof item === 'string')))
}

/** The pull requests a broken record still names, by key, so a hold covers those and no others. */
const namedPulls = (text: string): string[] => {
  const pulls = new Set<string>()
  for (const match of text.matchAll(/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)#(\d{1,9})/g)) {
    try { pulls.add(ReviewThreadLedger.pullRequestKey(match[1]!, Number(match[2]))) } catch { /* not a repository name */ }
  }
  return [...pulls]
}

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

  /**
   * The record as it stands. One that cannot be parsed, or is not exactly
   * this shape, is never read as empty — that would reset every count and
   * answered note. It is moved aside as `review-threads.json.corrupt-<time>`
   * and replaced by a record that holds agents back until the person acts.
   */
  async #read(): Promise<ThreadState> {
    let text: string
    try { text = await readFile(this.#path, 'utf8') }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return empty()
      throw error
    }
    let value: Partial<ThreadState> | null = null
    try { value = JSON.parse(text) as Partial<ThreadState> | null } catch { value = null }
    if (value && typeof value === 'object' && value.version === 1 && isLists(value.rounds) && isLists(value.answered) && isUnreadable(value.unreadable)) {
      return { version: 1, rounds: value.rounds, answered: value.answered, ...(value.unreadable ? { unreadable: value.unreadable } : {}) }
    }
    const at = Date.now(), file = `review-threads.json.corrupt-${at}`
    await rename(this.#path, join(this.stateDirectory, file))
    const state: ThreadState = { ...empty(), unreadable: { at, file, cleared: [], pulls: namedPulls(text) } }
    await this.#write(state)
    return state
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

  /**
   * Why agents may settle nothing on this pull request right now, or null:
   * an earlier record that named it (or named nothing readable) was set
   * aside, under a day ago, its file is still there, and the person has not
   * settled a thread here since.
   */
  held(repository: string, number: number, now = Date.now()): Promise<string | null> {
    return this.#serial(async () => {
      const { unreadable } = await this.#read()
      const key = ReviewThreadLedger.pullRequestKey(repository, number)
      if (!unreadable || now - unreadable.at >= UNREADABLE_HOLD_MS || unreadable.cleared.includes(key)) return null
      if (unreadable.pulls?.length && !unreadable.pulls.includes(key)) return null
      try { await stat(join(this.stateDirectory, unreadable.file)) }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error }
      return `The review-thread record could not be read and was set aside as ${unreadable.file} in the host state folder, so its round counts and answers for pull request #${number} are unknown. Settle a thread there yourself, or remove ${unreadable.file} once you have looked at it, and agents may settle again; the hold also ends a day after it began. Nothing was written.`
    })
  }

  /** The person settled a thread on this pull request: agents may settle it again. */
  clear(repository: string, number: number): Promise<void> {
    return this.#serial(async () => {
      const state = await this.#read()
      const key = ReviewThreadLedger.pullRequestKey(repository, number)
      if (!state.unreadable || state.unreadable.cleared.includes(key)) return
      await this.#write({ ...state, unreadable: { ...state.unreadable, cleared: [...state.unreadable.cleared, key] } })
    })
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
