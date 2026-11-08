import assert from 'node:assert/strict'
import test from 'node:test'
import { leadBudgetProjection, parseLeadBudgetLedger, reduceLeadBudget, reopenLeadBudgetRound } from '../src/budget.js'

const terminal = () => {
  let state = reduceLeadBudget(null, { version: 1, type: 'initialize', now: 100, logicalGoalId: 'goal-1',
    caps: { usdMicros: 3_000_000, rounds: 3 }, freshnessMs: 60_000 })
  state = reduceLeadBudget(state, { version: 1, type: 'bind', now: 100, goalId: 'team-1', executionId: 'run-1' })
  state = reduceLeadBudget(state, { version: 1, type: 'observe', now: 100, at: 100, revision: 1,
    source: 'worker-samples', sourceIds: ['sample-1'], goalId: 'team-1', executionIds: ['run-1'], quality: 'known', usdMicros: 500_000 })
  state = reduceLeadBudget(state, { version: 1, type: 'round', now: 100, executionId: 'run-1', roundId: 'run-1:round:1' })
  return reduceLeadBudget(state, { version: 1, type: 'observe', now: 200, at: 200, revision: 2, terminal: true,
    source: 'worker-samples', sourceIds: ['sample-2'], goalId: 'team-1', executionIds: ['run-1'], quality: 'known', usdMicros: 600_000 })
}

test('reopening a stopped execution precharges one round without losing any known spend', () => {
  const before = terminal(), after = reopenLeadBudgetRound(before, 'run-1', 'run-1:round:2', 300)
  assert.equal(after.roundsAdmitted, 2)
  assert.equal(after.workerUsdMicros, 600_000)
  assert.equal(after.executionIds[0], before.executionIds[0])
  assert.equal(after.logicalGoalId, before.logicalGoalId)
  assert.equal(after.terminalObservations.length, 0)
  assert.notEqual(leadBudgetProjection(after, 300).spend, 'known')
  assert.equal(after.stop, null)
  assert.deepEqual(parseLeadBudgetLedger(after), after)
  assert.deepEqual(reopenLeadBudgetRound(after, 'run-1', 'run-1:round:2', 300), after)
})

test('fresh cumulative metering after reopening restores known spend and charges only the increment', () => {
  let state = reopenLeadBudgetRound(terminal(), 'run-1', 'run-1:round:2', 300)
  state = reduceLeadBudget(state, { version: 1, type: 'observe', now: 300, at: 300, revision: 3,
    source: 'worker-samples', sourceIds: ['sample-3'], goalId: 'team-1', executionIds: ['run-1'], quality: 'known', usdMicros: 700_000 })
  assert.equal(state.workerUsdMicros, 700_000)
  assert.equal(leadBudgetProjection(state, 300).spend, 'known')
  assert.deepEqual(reduceLeadBudget(state, { version: 1, type: 'round', now: 300, executionId: 'run-1', roundId: 'run-1:round:2' }), state)
})

test('reopening refuses exhausted rounds, missing dollars, latches, reservations and stale spend', () => {
  const state = terminal()
  for (const caps of [{ ...state.caps, rounds: 1 }, { ...state.caps, usdMicros: 600_000 }])
    assert.throws(() => reopenLeadBudgetRound({ ...state, caps }, 'run-1', 'run-1:round:2', 300))
  assert.throws(() => reopenLeadBudgetRound({ ...state, stop: { reason: 'budget', revision: 1 } }, 'run-1', 'run-1:round:2', 300))
  const reserved = reduceLeadBudget(state, { version: 1, type: 'reserve', now: 200, requestId: 'request-1', inputTokens: 1,
    maxOutputTokens: 1, inputUsdMicrosPerMillion: 1_000_000, outputUsdMicrosPerMillion: 1_000_000,
    cacheReadUsdMicrosPerMillion: 0, cacheWriteUsdMicrosPerMillion: 0 })
  assert.throws(() => reopenLeadBudgetRound(reserved, 'run-1', 'run-1:round:2', 300))
  const reopened = reopenLeadBudgetRound(state, 'run-1', 'run-1:round:2', 300)
  assert.throws(() => reopenLeadBudgetRound(reopened, 'run-1', 'run-1:round:3', 300))
  assert.throws(() => reopenLeadBudgetRound(state, 'other-run', 'other-run:round:2', 300))
})

test('reopening one execution preserves other terminal costs and requires aggregate coverage', () => {
  let state = terminal()
  state = reduceLeadBudget(state, { version: 1, type: 'bind', now: 200, goalId: 'team-1', executionId: 'run-2' })
  state = reduceLeadBudget(state, { version: 1, type: 'observe', now: 200, at: 200, revision: 3, terminal: true,
    source: 'worker-samples', sourceIds: ['sample-3'], goalId: 'team-1', executionIds: ['run-2'], quality: 'known', usdMicros: 200_000 })
  const reopened = reopenLeadBudgetRound(state, 'run-1', 'run-1:round:2', 300)
  assert.equal(reopened.workerUsdMicros, 800_000)
  assert.deepEqual(reopened.terminalObservations.map(row => row.executionIds), [['run-2']])
  assert.deepEqual(parseLeadBudgetLedger(reopened), reopened)
  const metered = reduceLeadBudget(reopened, { version: 1, type: 'observe', now: 300, at: 300, revision: 4,
    source: 'worker-samples', sourceIds: ['sample-4'], goalId: 'team-1', executionIds: ['run-1', 'run-2'], quality: 'known', usdMicros: 900_000 })
  assert.equal(metered.workerUsdMicros, 900_000)
  assert.equal(leadBudgetProjection(metered, 300).spend, 'known')
})
