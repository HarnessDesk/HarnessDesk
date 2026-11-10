import type { LeadState } from '@harnessdesk/lead'

/** How many runs the Lead may have live at once, chats and Team runs together. */
export const LEAD_RUN_SLOTS = 4
/** Slots only the person's own work can fill. */
export const LEAD_RESERVED_SLOTS = 1

export interface LeadSlotsPorts {
  readonly state: () => Pick<LeadState, 'origin'>
  /** Runs the Lead holds that are working right now. */
  readonly live: () => number
  readonly slots?: number
  readonly reserved?: number
}

/**
 * One run admission always stays free for the person's own follow-up. A goal that came from a schedule, an issue or a
 * pull request (it has an origin) is automatic work and may fill all but the reserved slot; a goal the person began
 * may use every slot. The host decides this where a run starts, so no model turn can talk its way past it.
 */
export class LeadSlots {
  constructor(private readonly ports: LeadSlotsPorts) {}
  get limits(): { readonly slots: number; readonly reserved: number } {
    return { slots: this.ports.slots ?? LEAD_RUN_SLOTS, reserved: this.ports.reserved ?? LEAD_RESERVED_SLOTS }
  }
  /** True when the current goal is automatic work, not the person's own. */
  automatic(): boolean { return this.ports.state().origin !== null }
  admit(): { readonly ok: true } | { readonly ok: false; readonly reason: string } {
    const { slots, reserved } = this.limits, live = this.ports.live()
    const room = this.automatic() ? slots - reserved : slots
    if (live < room) return { ok: true }
    return { ok: false, reason: this.automatic() && live < slots
      ? 'The last run is kept for your own follow-up, so automatic work waits.' : 'Every run the Lead may have at once is working; this waits for one to finish.' }
  }
  assert(): void {
    const verdict = this.admit()
    if (!verdict.ok) throw Object.assign(new Error(verdict.reason), { wireCode: 'lead-slot-reserved' as const })
  }
}
