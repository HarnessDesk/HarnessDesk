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

export interface GoalOperationPort {
  importOpening(project: string, opening: SeatOpening): Promise<void>
  closeId(seat: SeatId, reason: string): Promise<void>
  claim(goal: string, card: number, seat: SeatOpening): Promise<void>
  releaseClaim(goal: string, seat: SeatId): Promise<void>
  refuseMail(goal: string, seat: SeatId): Promise<void>
  wake(goal: string): void
  finish(goal: string, operation: string): Promise<void>
  finishWrap(operation: Extract<GoalOperation, { kind: 'wrap' }>): Promise<void>
}

/** All effects are idempotent. The operation stays in the document until the last write. */
export async function recoverOperation(operation: GoalOperation, port: GoalOperationPort): Promise<void> {
  switch (operation.kind) {
    case 'assignment':
      for (const id of operation.close) await port.closeId(id, 'assigned')
      await port.importOpening(operation.opening.checkout.project, operation.opening)
      if (operation.card !== null) await port.claim(operation.goal, operation.card, operation.opening)
      await port.finish(operation.goal, operation.id)
      port.wake(operation.goal)
      return
    case 'release':
      await port.closeId(operation.seat, operation.reason)
      await port.releaseClaim(operation.goal, operation.seat)
      await port.refuseMail(operation.goal, operation.seat)
      await port.finish(operation.goal, operation.id)
      port.wake(operation.goal)
      return
    case 'wrap':
      await port.finishWrap(operation)
  }
}
