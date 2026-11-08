import assert from 'node:assert/strict'
import test from 'node:test'
import { createLeadJournal } from '../src/journal.js'
import { leadBudgetProjection } from '../src/budget.js'
import { canBeginLeadGoal } from '../src/state.js'
import { leadCheckpoint, parseLeadCheckpoint } from '../src/checkpoint.js'

const rig = async () => {
  const records: any[] = [], journal = await createLeadJournal({ async read() { return records }, async append(record) { records.push(record) } })
  await journal.updateBudget({ version: 1, type: 'initialize', now: 100, logicalGoalId: 'goal-1', caps: { usdMicros: 5_000_000, rounds: 3 }, freshnessMs: 60_000 })
  const spend = async (id: string, usdMicros: number) => {
    await journal.updateBudget({ version: 1, type: 'reserve', now: 100, requestId: id, inputTokens: usdMicros, maxOutputTokens: 0,
      inputUsdMicrosPerMillion: 1_000_000, outputUsdMicrosPerMillion: 1_000_000, cacheReadUsdMicrosPerMillion: 0, cacheWriteUsdMicrosPerMillion: 0 })
    await journal.updateBudget({ version: 1, type: 'settle', now: 100, requestId: id, inputTokens: usdMicros, outputTokens: 0 })
  }
  return { journal, spend, warnings: () => journal.state.cards.filter(card => card.type === 'allowance-warning') }
}

test('known spend crossing eighty percent emits one durable warning per dollar cap', async () => {
  const s = await rig()
  await s.spend('first', 3_999_999); assert.equal(s.warnings().length, 0)
  await s.spend('cross', 1); assert.equal(s.warnings().length, 1)
  await s.spend('after', 1); assert.equal(s.warnings().length, 1)
  await s.journal.raiseBudget('goal-1', { usdMicros: 6_000_000, rounds: 3 }, s.journal.state.seq, 100)
  assert.equal(s.warnings().length, 1, 'raising above current eighty percent re-arms without warning immediately')
  await s.spend('second-cross', 800_000); assert.equal(s.warnings().length, 2)
  assert.deepEqual(s.warnings().map(card => card.usdMicros), [4_000_000, 4_800_001])
})

test('unknown spend never produces a warning or an invented amount', async () => {
  for (const quality of ['unknown', 'partial', 'ambiguous'] as const) {
  const s = await rig()
  await s.journal.updateBudget({ version: 1, type: 'bind', now: 100, goalId: 'team-1', executionId: 'run-1' })
  await s.journal.updateBudget({ version: 1, type: 'observe', now: 100, at: 100, revision: 1, source: 'worker-samples', sourceIds: ['sample-1'],
    goalId: 'team-1', executionIds: ['run-1'], quality, usdMicros: 4_000_000 })
  assert.notEqual(leadBudgetProjection(s.journal.state.budget!, 100).spend, 'known')
  assert.equal(s.warnings().length, 0)
  }
})

test('direct person raises are revision and goal fenced and preserve a stop latch', async () => {
  const s = await rig()
  await s.journal.updateBudget({ version: 1, type: 'stop', now: 100, reason: 'budget' })
  const latch = s.journal.state.budget!.stop
  await assert.rejects(s.journal.raiseBudget('other', { usdMicros: 6_000_000, rounds: 3 }, s.journal.state.seq, 100))
  await assert.rejects(s.journal.raiseBudget('goal-1', { usdMicros: 6_000_000, rounds: 3 }, 0, 100))
  await s.journal.raiseBudget('goal-1', { usdMicros: 6_000_000, rounds: 4 }, s.journal.state.seq, 100)
  assert.deepEqual(s.journal.state.budget!.stop, latch)
  assert.equal(s.journal.state.phase, 'stopped')
})

test('a raise applies to its own goal; the next goal starts from the caps in force before it', async () => {
  const s = await rig()
  await s.journal.raiseBudget('goal-1', { usdMicros: 6_000_000, rounds: 3 }, s.journal.state.seq, 100)
  await s.journal.raiseBudget('goal-1', { usdMicros: 7_000_000, rounds: 4 }, s.journal.state.seq, 100)
  assert.deepEqual(s.journal.state.budget!.caps, { usdMicros: 7_000_000, rounds: 4 })
  assert.deepEqual(parseLeadCheckpoint(leadCheckpoint(s.journal.state, 'a'.repeat(64))).state.raisedFrom, { usdMicros: 5_000_000, rounds: 3 })
  await s.journal.updateBudget({ version: 1, type: 'tighten', now: 100, caps: { usdMicros: 6_500_000, rounds: 2 } })
  await s.journal.stop(async () => {})
  assert.ok(canBeginLeadGoal(s.journal.state))
  await s.journal.beginGoal('goal-2', 200)
  assert.deepEqual(s.journal.state.budget!.caps, { usdMicros: 5_000_000, rounds: 2 }, 'a tightening still lowers the next goal')
  assert.equal(s.journal.state.raisedFrom, null)
})

test('an approved allowance after a raise is standing; the next goal starts from it', async () => {
  const s = await rig()
  await s.journal.raiseBudget('goal-1', { usdMicros: 7_000_000, rounds: 3 }, s.journal.state.seq, 100)
  const declined = await s.journal.changeBudgetCaps({ usdMicros: 9_000_000, rounds: 4 }, { id: 'caps-1', revision: 1 }, 100)
  await s.journal.decideCard({ version: 1, cardId: declined!.id, cardType: 'budget-change', expectedRevision: declined!.revision, contractDigest: null, choice: 'decline' })
  assert.deepEqual(s.journal.state.raisedFrom, { usdMicros: 5_000_000, rounds: 3 }, 'a declined change leaves the raise to its goal')
  const card = await s.journal.changeBudgetCaps({ usdMicros: 10_000_000, rounds: 4 }, { id: 'caps-2', revision: 1 }, 100)
  await s.journal.decideCard({ version: 1, cardId: card!.id, cardType: 'budget-change', expectedRevision: card!.revision, contractDigest: null, choice: 'approve' })
  assert.equal(s.journal.state.raisedFrom, null)
  const saved = structuredClone(s.journal.state)
  assert.throws(() => parseLeadCheckpoint(leadCheckpoint({ ...saved, raisedFrom: { usdMicros: 11_000_000, rounds: 4 } }, 'a'.repeat(64))), 'a stored floor above the caps is refused')
  await s.journal.stop(async () => {})
  await s.journal.beginGoal('goal-2', 200)
  assert.deepEqual(s.journal.state.budget!.caps, { usdMicros: 10_000_000, rounds: 4 })
})
