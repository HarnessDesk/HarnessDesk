import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { Goal, GoalBoard, GoalReceipt, GoalSeatRequest, SeatRecord, WrapPreview } from '../src/index.js'

test('Goal and its mutable board have no authored membership or live Plans', () => {
  const goalMembers: 'members' extends keyof Goal ? true : false = false
  const boardMembers: 'members' extends keyof GoalBoard ? true : false = false
  const boardPlans: 'plans' extends keyof GoalBoard ? true : false = false
  const id: Goal['id'] = 'room-retained'
  const board: SeatRecord['board'] = id
  assert.deepEqual([goalMembers, boardMembers, boardPlans], [false, false, false])
  assert.equal(board, id)
})

test('both grant generations and the receipt preview retain their exact shapes', () => {
  const permission: GoalSeatRequest['grant'] = { kind: 'permission', permission: 'read' }
  const ceiling: GoalSeatRequest['grant'] = { kind: 'ceiling', level: 'edit' }
  const previewHasId: 'id' extends keyof WrapPreview['receipt'] ? true : false = false
  const receiptHasId: 'id' extends keyof GoalReceipt ? true : false = true
  assert.equal(permission.kind, 'permission')
  assert.equal(ceiling.kind, 'ceiling')
  assert.deepEqual([previewHasId, receiptHasId], [false, true])
})
