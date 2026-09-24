import type { SeatCeiling } from '@harnessdesk/protocol'

import type { TeamSender } from '../team.js'

/**
 * A turn a trigger's Goal dispatched: which trigger, which firing, which
 * Goal. Chosen by the host from the Goal's persisted origin, never claimed by
 * a request; it selects unattended seating and gates, and a message-started
 * turn keeps its own `message` cause and sender ceiling.
 */
export interface TriggerTurnCause {
  readonly kind: 'trigger'
  readonly trigger: string
  readonly firing: string
  readonly goal: string
}

export type TurnCause =
  | { readonly kind: 'person' }
  | { readonly kind: 'message'; readonly from: TeamSender; readonly ceiling: SeatCeiling | null }
  | TriggerTurnCause

export const PERSON: TurnCause = { kind: 'person' }
