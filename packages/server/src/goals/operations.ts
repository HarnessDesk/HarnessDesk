import type { EvidenceRecord, GoalReceipt, SeatId } from '@harnessdesk/protocol'

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
  /**
   * A person carrying unresolved findings into this Goal: the dependency it
   * gains on the wrapped source and the carry events, fixed together before
   * either is applied, so a stop part-way finishes both once.
   */
  | {
      kind: 'carry'
      id: string
      goal: string
      source: string
      receipt: string
      dependsOn: readonly string[]
      records: readonly EvidenceRecord[]
    }

export interface GoalOperationPort {
  importOpening(project: string, opening: SeatOpening): Promise<void>
  closeId(seat: SeatId, reason: string): Promise<void>
  claim(goal: string, card: number, seat: SeatOpening): Promise<void>
  releaseClaim(goal: string, seat: SeatId): Promise<void>
  refuseMail(goal: string, seat: SeatId): Promise<void>
  retainLane(seat: SeatId): Promise<void>
  wake(goal: string): void
  finish(goal: string, operation: string): Promise<void>
  finishWrap(operation: Extract<GoalOperation, { kind: 'wrap' }>): Promise<void>
}

/** A carry's two sides: its events, appended once each, and the Goal's own finish. */
export interface CarryPort {
  append(records: readonly EvidenceRecord[]): Promise<void>
  finish(operation: Extract<GoalOperation, { kind: 'carry' }>): Promise<void>
}

/** All effects are idempotent. The operation stays in the document until the last write. */
export async function recoverOperation(operation: GoalOperation, port: GoalOperationPort, carry?: CarryPort | null): Promise<void> {
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
      for (const seat of operation.receipt.seats) {
        await port.closeId(seat, 'wrapped')
        await port.releaseClaim(operation.goal, seat)
        await port.refuseMail(operation.goal, seat)
        await port.retainLane(seat)
      }
      await port.finishWrap(operation)
      return
    case 'carry':
      if (!carry) throw new Error('This desk cannot finish carrying findings. Restart it to retry recovery.')
      await carry.append(operation.records)
      await carry.finish(operation)
      port.wake(operation.goal)
  }
}
