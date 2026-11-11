import { randomUUID } from 'node:crypto'
import { open, readFile, rename, rm } from 'node:fs/promises'

import { MCP_DAILY_STARTS_MAX, type McpStartsView } from '@harnessdesk/protocol'

/**
 * Whether an MCP client may start work on this desk, and how many starts it
 * has had today.
 *
 * Starting work is off until the person turns it on, and then it is a count
 * of starts per local day, not money: money is known only after a run, and a
 * subscription seat reports none, so a cap in dollars would admit work it
 * cannot price. A count is exact at the one moment a gate can act, admission.
 *
 * The gate belongs to the host, never to the command line, because a switch
 * the caller holds is the caller's to flip. It is consent, not security: the
 * surface is stated by the client, and the socket's permissions remain the
 * authority (`docs/decisions.md`).
 */
export interface McpStartsState {
  readonly version: 1
  readonly revision: number
  readonly mayStart: boolean
  readonly dailyStarts: number
  /** The local day `started` counts, `YYYY-MM-DD`. It never moves backward. */
  readonly day: string
  readonly started: number
}

/** What an admission hands back, for a refund if the start then fails. */
export interface McpStartTicket { readonly day: string }

export type McpAdmission =
  | { readonly ok: true; readonly ticket: McpStartTicket }
  | { readonly ok: false; readonly code: 'mcpStartsOff' | 'mcpDailyCap'; readonly detail: string }

export interface McpStartsClock {
  now(): number
  /** The desk's local calendar day for an instant, `YYYY-MM-DD`. */
  localDay(ms: number): string
}

/** The person's own day, not UTC: "5 a day" is read in their day. */
export const localDay = (ms: number): string => {
  const date = new Date(ms)
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

export const MCP_DAILY_STARTS_DEFAULT = 5
const systemClock: McpStartsClock = { now: () => Date.now(), localDay }
const coded = (message: string, code: string): Error => Object.assign(new Error(message), { code })

export class McpStarts {
  readonly #path: string
  readonly #clock: McpStartsClock
  readonly #environment: () => boolean
  #state: McpStartsState | null = null
  /** Every read and change goes through one chain, so two admissions never see the same count. */
  #chain: Promise<unknown> = Promise.resolve()

  constructor(path: string, clock: McpStartsClock = systemClock, environment: () => boolean = () => process.env['HARNESSDESK_MCP_MAY_START'] === '1') {
    this.#path = path
    this.#clock = clock
    this.#environment = environment
  }

  view(): Promise<McpStartsView> {
    return this.#transact(state => ({ next: null, value: this.#viewOf(state) }))
  }

  set(revision: number, patch: { readonly mayStart?: boolean; readonly dailyStarts?: number }): Promise<McpStartsView> {
    return this.#transact(state => {
      if (revision !== state.revision) throw coded('These MCP client settings changed. Read them again before saving.', 'HD_MCP_STARTS_STALE')
      if (patch.dailyStarts !== undefined && (!Number.isSafeInteger(patch.dailyStarts) || patch.dailyStarts < 1 || patch.dailyStarts > MCP_DAILY_STARTS_MAX)) {
        throw Object.assign(new Error(`Starts a day must be a whole number from 1 to ${MCP_DAILY_STARTS_MAX}.`), { wireCode: 'badRequest' })
      }
      // Lowering the number below what today has used is allowed: the rest of the day is refused.
      const next: McpStartsState = {
        ...state,
        revision: state.revision + 1,
        ...(patch.mayStart !== undefined ? { mayStart: patch.mayStart } : {}),
        ...(patch.dailyStarts !== undefined ? { dailyStarts: patch.dailyStarts } : {}),
      }
      return { next, value: this.#viewOf(next) }
    })
  }

  admit(now = this.#clock.now()): Promise<McpAdmission> {
    return this.#transact<McpAdmission>(state => {
      if (!state.mayStart && !this.#environment()) {
        return { next: null, value: { ok: false, code: 'mcpStartsOff', detail: 'Starting work from MCP clients is off. Turn on "Let MCP clients start work" in Settings › Local clients.' } }
      }
      if (state.started >= state.dailyStarts) {
        return { next: null, value: { ok: false, code: 'mcpDailyCap', detail: `Today's ${state.dailyStarts} starts from MCP clients are used. They reset at midnight.` } }
      }
      return { next: { ...state, started: state.started + 1 }, value: { ok: true, ticket: { day: state.day } } }
    }, now)
  }

  /** A start that failed costs nothing. One that began and then stopped still counts, and so does yesterday's. */
  refund(ticket: McpStartTicket): Promise<void> {
    return this.#transact(state => ({
      next: state.day === ticket.day && state.started > 0 ? { ...state, started: state.started - 1 } : null,
      value: undefined,
    }))
  }

  #viewOf(state: McpStartsState): McpStartsView {
    const environment = this.#environment()
    return {
      ...state,
      mayStart: state.mayStart || environment,
      remaining: Math.max(0, state.dailyStarts - state.started),
      source: environment ? 'environment' : 'stored',
    }
  }

  #transact<T>(change: (state: McpStartsState) => { readonly next: McpStartsState | null; readonly value: T }, now?: number): Promise<T> {
    const run = this.#chain.then(async () => {
      const at = now ?? this.#clock.now()
      const loaded = this.#state ?? await this.#load(at)
      // A new local day starts the count again. A clock set back keeps the
      // stored day and its count, so changing the clock cannot reset the cap.
      const today = this.#clock.localDay(at)
      const current = today > loaded.day ? { ...loaded, day: today, started: 0 } : loaded
      this.#state = current
      const { next, value } = change(current)
      if (next) {
        await this.#write(next)
        this.#state = next
      }
      return value
    })
    this.#chain = run.catch(() => {})
    return run
  }

  async #load(now: number): Promise<McpStartsState> {
    const fresh: McpStartsState = { version: 1, revision: 0, mayStart: false, dailyStarts: MCP_DAILY_STARTS_DEFAULT, day: this.#clock.localDay(now), started: 0 }
    let text: string
    try { text = await readFile(this.#path, 'utf8') }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return fresh
      throw error
    }
    // A file this desk cannot read is no grant: it reads as off.
    try {
      const raw = JSON.parse(text) as Partial<McpStartsState>
      const integer = (value: unknown, minimum: number, maximum = Number.MAX_SAFE_INTEGER): value is number =>
        Number.isSafeInteger(value) && (value as number) >= minimum && (value as number) <= maximum
      if (raw.version === 1 && integer(raw.revision, 0) && typeof raw.mayStart === 'boolean' && integer(raw.dailyStarts, 1, MCP_DAILY_STARTS_MAX) &&
          typeof raw.day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(raw.day) && integer(raw.started, 0)) {
        return { version: 1, revision: raw.revision, mayStart: raw.mayStart, dailyStarts: raw.dailyStarts, day: raw.day, started: raw.started }
      }
    } catch { /* an unreadable file reads as the defaults */ }
    return fresh
  }

  async #write(state: McpStartsState): Promise<void> {
    const temporary = `${this.#path}.${randomUUID()}.tmp`
    try {
      const handle = await open(temporary, 'wx', 0o600)
      try {
        await handle.writeFile(JSON.stringify(state))
        await handle.sync()
      } finally { await handle.close() }
      await rename(temporary, this.#path)
    } finally {
      await rm(temporary, { force: true })
    }
  }
}
