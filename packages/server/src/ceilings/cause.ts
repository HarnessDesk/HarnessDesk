import type { SeatCeiling } from '@harnessdesk/protocol'

import type { TeamSender } from '../team.js'

export type TurnCause =
  | { readonly kind: 'person' }
  | { readonly kind: 'message'; readonly from: TeamSender; readonly ceiling: SeatCeiling | null }

export const PERSON: TurnCause = { kind: 'person' }
