import { LEAD_AUTOMATIC_RUNS, LEAD_HEADROOM_RESERVE_PERCENT, type LeadStartCause } from '@harnessdesk/protocol'

export { LEAD_AUTOMATIC_RUNS, LEAD_HEADROOM_RESERVE_PERCENT }

export interface LeadSlotsPorts {
  /** Runs the Lead started on its own (chats and Team runs) that are working right now, or about to. */
  readonly automaticLive: () => number
  /** Remembers that a run was started automatically, so it keeps counting until it ends, across a restart. */
  readonly mark: (id: string) => Promise<void>
  /** The share of its window the account a start would run on has left, 0 to 100; null when nobody can say. */
  readonly headroom?: () => Promise<number | null>
  /** Whether what the count is made of (the remembered ids and the chats on watch) has been read since the host started. */
  readonly ready?: () => boolean
  readonly limit?: number
  readonly reserve?: number
}

export type LeadSlotsVerdict =
  | { readonly ok: true; /** Said when a check could not be made and the start was let through: only headroom ever fails open, never the cap. */ readonly note?: string }
  | { readonly ok: false; readonly reason: string }

/** One slot held for a start that is being made, so two starts at the same moment cannot both pass the cap. */
export interface LeadSlotHold { release(): void }

export const LEAD_SLOTS_LOADING = 'The Lead is still reading which runs it started on its own, so automatic work waits a moment. Your own messages are never held back.'
export const LEAD_SLOTS_NO_REPORT = 'no usage report'

/**
 * The person's follow-up always has room. Every start is classified by what caused it, and only a start positively
 * identified as the person's is theirs and never refused here; any other start, including one that names no cause, is
 * automatic work: the host lets at most `limit` automatic runs work at once and starts none on an account with little
 * of its window left. The host decides this where a run starts, so no model turn can talk its way past it.
 */
export class LeadSlots {
  readonly #held = new Set<symbol>()
  constructor(private readonly ports: LeadSlotsPorts) {}
  get limits(): { readonly runs: number; readonly reserve: number } {
    return { runs: this.ports.limit ?? LEAD_AUTOMATIC_RUNS, reserve: this.ports.reserve ?? LEAD_HEADROOM_RESERVE_PERCENT }
  }
  get #atCap(): boolean { return this.ports.automaticLive() + this.#held.size >= this.limits.runs }
  #capReason(): string {
    return `The Lead already has ${this.limits.runs} runs it started on its own working; a new one waits for one to finish, so your next message keeps its room.`
  }
  /** Whether a start may go now. It reserves nothing: take a hold right before the run is made. */
  async admit(cause: LeadStartCause = 'automatic'): Promise<LeadSlotsVerdict> {
    if (cause === 'person') return { ok: true }
    // Until what the count is made of has been read it would say 0, which is not an answer.
    if (this.ports.ready && !this.ports.ready()) return { ok: false, reason: LEAD_SLOTS_LOADING }
    if (this.#atCap) return { ok: false, reason: this.#capReason() }
    const left = await this.ports.headroom?.().catch(() => null) ?? null
    if (left !== null && left < this.limits.reserve)
      return { ok: false, reason: 'The account a new run would use is close to its limit, so automatic work waits and your next message keeps its room.' }
    // No report is not a reason to stop: the cap above still holds. Headroom alone fails open.
    return left === null ? { ok: true, note: LEAD_SLOTS_NO_REPORT } : { ok: true }
  }
  /** Reserves a slot at once (no await between the count and the claim), or null when the cap is full. The person's start holds nothing. */
  hold(cause: LeadStartCause = 'automatic'): LeadSlotHold | null {
    if (cause === 'person') return { release: () => {} }
    if (this.ports.ready && !this.ports.ready()) return null
    if (this.#atCap) return null
    const token = Symbol('slot')
    this.#held.add(token)
    return { release: () => { this.#held.delete(token) } }
  }
  async assert(cause: LeadStartCause = 'automatic'): Promise<void> {
    const verdict = await this.admit(cause)
    if (!verdict.ok) throw Object.assign(new Error(verdict.reason), { wireCode: 'lead-slot-reserved' as const })
  }
  async mark(id: string, cause: LeadStartCause = 'automatic'): Promise<void> { if (cause === 'automatic') await this.ports.mark(id) }
  get reasons(): { readonly cap: string; readonly loading: string } { return { cap: this.#capReason(), loading: LEAD_SLOTS_LOADING } }
}
