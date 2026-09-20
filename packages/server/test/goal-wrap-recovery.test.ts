import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { GoalReceipt } from '@harnessdesk/protocol'

import type { SeatOpening } from '../src/evidence/records.js'
import { SeatBook } from '../src/evidence/seats.js'
import { EvidenceStore } from '../src/evidence/store.js'
import { migrateDesk } from '../src/goals/migration.js'
import { recoverOperation, type GoalOperation, type GoalOperationPort } from '../src/goals/operations.js'
import { GoalStore } from '../src/goals/store.js'
import { goal, intent, seat } from './fixtures/goals.js'
import { tempDir } from './scratch.js'

const opening = (id: string): SeatOpening => {
  const { closed: _closed, ...record } = seat(id)
  return record
}

const receipt = (): GoalReceipt => ({
  version: 1,
  id: 'receipt-fixed',
  goal: 'g1',
  sentence: 'Finish the change',
  wrappedAt: 20,
  summary: 'Finished and reviewed.',
  cards: [{ id: 1, resolution: 'finished', reason: null }],
  seats: ['one', 'two'],
  evidence: ['fact-1'],
  answers: [],
  lanes: [{ lane: 'lane-1', cwd: '/work/lane', dirty: false, retained: true }],
  revisions: [{ cwd: '/work/repo', head: 'a'.repeat(40), dirty: false }],
  citations: [],
  gaps: ['No transcript answer was recorded.'],
})

const finalise = async (store: GoalStore, operation: Extract<GoalOperation, { kind: 'wrap' }>): Promise<void> => {
  const document = store.read(operation.goal)
  if (document.operation === null && document.receipt?.id === operation.receipt.id) return
  assert.equal(document.operation?.id, operation.id)
  await store.save({
    ...document,
    receipt: operation.receipt,
    operation: null,
    board: { ...document.board, intents: document.board.intents.map((card) => ({ ...card, state: 'done' as const, claim: null })) },
    goal: {
      ...document.goal,
      state: 'wrapped',
      receipt: operation.receipt.id,
      revision: document.goal.revision + 1,
      updatedAt: operation.receipt.wrappedAt,
    },
  }, document.goal.revision)
}

test('a staged receipt closes each real Seat once and replays the same bytes after restart', async () => {
  const home = tempDir('hd-goal-wrap-recovery-')
  await migrateDesk(home, async () => {})
  const store = new GoalStore(home)
  await store.load()
  const evidence = new EvidenceStore(`${home}/evidence`)
  const seats = new SeatBook(evidence, () => 30)
  await seats.importOpening('/work/repo', opening('one'))
  await seats.importOpening('/work/repo', opening('two'))
  const operation: Extract<GoalOperation, { kind: 'wrap' }> = {
    kind: 'wrap', id: 'wrap-fixed', goal: 'g1', stamp: 'b'.repeat(64), receipt: receipt(),
  }
  await store.save({
    version: 1,
    goal: goal('g1'),
    board: { nextIntent: 2, messaging: true, intents: [intent(1)], channel: [] },
    citations: [], receipt: null, operation: null,
  }, null)
  await store.save({
    version: 1,
    goal: goal('g1', { state: 'wrapping', revision: 1 }),
    board: { nextIntent: 2, messaging: true, intents: [intent(1)], channel: [] },
    citations: [], receipt: null, operation,
  }, 0)

  let finishFailures = 1
  const retained: string[] = []
  const port = (goalStore: GoalStore, book: SeatBook): GoalOperationPort => ({
    importOpening: async () => {},
    closeId: async (id, why) => { await book.closeId(id, why) },
    claim: async () => {},
    releaseClaim: async () => {},
    refuseMail: async () => {},
    retainLane: async (id) => { retained.push(id) },
    wake: () => {},
    finish: async () => {},
    finishWrap: async (staged) => {
      if (finishFailures-- > 0) throw new Error('final rename failed')
      await finalise(goalStore, staged)
    },
  })
  await assert.rejects(recoverOperation(operation, port(store, seats)), /final rename failed/)
  assert.equal(store.read('g1').goal.state, 'wrapping')

  const reopenedStore = new GoalStore(home)
  await reopenedStore.load()
  const reopenedSeats = new SeatBook(new EvidenceStore(`${home}/evidence`), () => 40)
  await reopenedSeats.load()
  await recoverOperation(reopenedStore.read('g1').operation!, port(reopenedStore, reopenedSeats))
  const wrapped = reopenedStore.read('g1')
  assert.equal(wrapped.goal.state, 'wrapped')
  assert.deepEqual(wrapped.receipt, receipt())
  assert.equal(reopenedSeats.byId('one')?.closed?.why, 'wrapped')
  assert.equal(reopenedSeats.byId('two')?.closed?.why, 'wrapped')
  assert.deepEqual(retained, ['one', 'two', 'one', 'two'])
  const lines = (await evidence.read('/work/repo', 'seats')).lines
  assert.equal(lines.filter((line) => line.type === 'seat-closed').length, 2)

  await recoverOperation(operation, port(reopenedStore, reopenedSeats))
  assert.deepEqual(reopenedStore.read('g1').receipt, receipt())
  assert.equal((await evidence.read('/work/repo', 'seats')).lines.filter((line) => line.type === 'seat-closed').length, 2)
})
