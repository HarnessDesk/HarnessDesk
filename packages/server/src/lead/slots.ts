import { LEAD_AUTOMATIC_RUNS, LEAD_HEADROOM_RESERVE_PERCENT, type LeadStartCause } from '@harnessdesk/protocol'

export { LEAD_AUTOMATIC_RUNS, LEAD_HEADROOM_RESERVE_PERCENT }

export interface LeadSlotsPorts {
  /** Runs the Lead started on its own (chats and Team runs) that are working right now. */
  readonly automaticLive: () => number
  /** Remembers that a run was started automatically, so it keeps counting until it ends, across a restart. */
  readonly mark: (id: string) => Promise<void>
  /** The share of its window the account a start would run on has left, 0 to 100; null when nobody can say. */
  readonly headroom?: () => Promise<number | null>
  readonly limit?: number
  readonly reserve?: number
}

export type LeadSlotsVerdict = { readonly ok: true } | { readonly ok: false; readonly reason: string }

/**
 * The person's follow-up always has room. Every start is classified by what caused it: a turn the person woke (or a
 * tool continuation of it) is theirs and is never refused here; any other wake is automatic work, and the host lets at
 * most `limit` automatic runs work at once and starts none on an account with little of its window left. The host
 * decides this where a run starts, so no model turn can talk its way past it.
 */
export class LeadSlots {
  constructor(private readonly ports: LeadSlotsPorts) {}
  get limits(): { readonly runs: number; readonly reserve: number } {
    return { runs: this.ports.limit ?? LEAD_AUTOMATIC_RUNS, reserve: this.ports.reserve ?? LEAD_HEADROOM_RESERVE_PERCENT }
  }
  async admit(cause: LeadStartCause = 'person'): Promise<LeadSlotsVerdict> {
    if (cause === 'person') return { ok: true }
    const { runs, reserve } = this.limits
    if (this.ports.automaticLive() >= runs)
      return { ok: false, reason: `The Lead already has ${runs} runs it started on its own working; a new one waits for one to finish, so your next message keeps its room.` }
    const left = await this.ports.headroom?.().catch(() => null) ?? null
    if (left !== null && left < reserve)
      return { ok: false, reason: 'The account a new run would use is close to its limit, so automatic work waits and your next message keeps its room.' }
    return { ok: true }
  }
  async assert(cause: LeadStartCause = 'person'): Promise<void> {
    const verdict = await this.admit(cause)
    if (!verdict.ok) throw Object.assign(new Error(verdict.reason), { wireCode: 'lead-slot-reserved' as const })
  }
  async mark(id: string, cause: LeadStartCause = 'person'): Promise<void> { if (cause === 'automatic') await this.ports.mark(id) }
}
