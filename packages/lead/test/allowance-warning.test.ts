import assert from 'node:assert/strict'
import test from 'node:test'
import { createLeadJournal } from '../src/journal.js'
import { leadBudgetProjection } from '../src/budget.js'

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
