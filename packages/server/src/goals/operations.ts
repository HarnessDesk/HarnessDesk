import type { GoalReceipt, SeatId } from '@harnessdesk/protocol'

import type { SeatOpening } from '../evidence/records.js'

/** Written before any cross-store mutation. A retry keeps these ids. */
export type GoalOperation =
  | {
      kind: 'assignment'
      id: string
      goal: string
      card: number | null
      opening: SeatOpening
      close: readonly SeatId[]
    }
  | { kind: 'release'; id: string; goal: string; seat: SeatId; reason: 'released' }
  | { kind: 'wrap'; id: string; goal: string; stamp: string; receipt: GoalReceipt }
