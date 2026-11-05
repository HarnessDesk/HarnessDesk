import assert from 'node:assert/strict'
import test from 'node:test'
import { LEAD_LIMITS, parseLeadAcceptanceContract, parseLeadPermissionPolicy } from '@harnessdesk/protocol'
import { createLeadJournal } from '../src/journal.js'
import { leadCheckpoint, parseLeadCheckpoint } from '../src/checkpoint.js'
import { leadDraftCaps, leadLimitedCaps } from '../src/state.js'
import { leadInstructions } from '../src/instructions.js'

const max = LEAD_LIMITS.maxUsdMicros
const contract = (caps: { usdMicros: number; rounds: number }) => parseLeadAcceptanceContract({ version: 1, revision: 1, digest: 'a'.repeat(64), goal: 'Repair check',
  project: { id: 'project-demo', path: '/workspace/demo' }, policyRevision: 1,
  steps: [{ id: 'implement', title: 'Implement', flow: 'lead-reviewed-result', sourceRevision: 'source-1',
    variables: {}, attendance: 'attended', assignments: [{ role: 'implement', agent: 'builder', seat: { runtime: 'fixture' }, ceiling: 'edit' }] }],
  assertions: [{ id: 'check', kind: 'check', description: 'Checks pass' }], caps })
const rig = async (caps = { usdMicros: 5_000_000, rounds: 2 }) => {
  const records: any[] = [], storage = { async read() { return structuredClone(records) }, async append(record: any) { records.push(structuredClone(record)) } }
  const journal = await createLeadJournal(storage)
  await journal.setPolicy(parseLeadPermissionPolicy({ version: 1, revision: 1, mode: 'manage', rules: [] }))
  await journal.updateBudget({ version: 1, type: 'initialize', now: 100, logicalGoalId: 'goal-1', caps, freshnessMs: 60_000 })
  const worker = async (usdMicros: number, revision = 1) => {
    if (revision === 1) await journal.updateBudget({ version: 1, type: 'bind', now: 100, goalId: 'team-1', executionId: 'run-1' })
    await journal.updateBudget({ version: 1, type: 'observe', now: 100, at: 100, revision, source: 'worker-samples', sourceIds: [`sample-${revision}`],
      goalId: 'team-1', executionIds: ['run-1'], quality: 'known', usdMicros })
  }
  const round = (roundId: string) => journal.updateBudget({ version: 1, type: 'round', now: 100, executionId: 'run-1', roundId })
  const approve = async (caps: { usdMicros: number; rounds: number }) => {
    const plan = contract(caps)
    await journal.offerCard({ version: 1, id: 'plan-1', revision: 1, type: 'plan', contractDigest: plan.digest, contract: plan })
    await journal.decideCard({ version: 1, cardId: 'plan-1', cardType: 'plan', expectedRevision: 1, contractDigest: plan.digest, choice: 'approve' }, 200)
  }
  return { journal, records, storage, worker, round, approve,
    warnings: () => journal.state.cards.filter(card => card.type === 'allowance-warning') }
}

test('Off never stops for money, but rounds and the overflow ceiling still stop the goal', async () => {
  const s = await rig()
  await s.journal.setSpendLimit(null, s.journal.state.seq, 100)
  assert.deepEqual(s.journal.state.budget!.caps, { usdMicros: max, rounds: 2 })
  await s.worker(900_000_000_000)
  assert.equal(s.journal.state.budget!.stop, null, 'spend far past any old cap does not stop it')
  assert.equal(s.warnings().length, 0, 'no allowance warning with no limit')
  await s.round('round-1'); await s.round('round-2')
  await assert.rejects(s.round('round-3'), 'the round cap still refuses another round')
  const overflow = await rig({ usdMicros: 5_000_000, rounds: 4 })
  await overflow.journal.setSpendLimit(null, overflow.journal.state.seq, 100)
  await overflow.worker(max)
  assert.equal(overflow.journal.state.budget!.stop?.reason, 'budget', 'spend at the portable ceiling is an overflow stop')
})

test('a set limit is enforced as before, latches a stop when set below spend and warns at eighty percent', async () => {
  const s = await rig({ usdMicros: max, rounds: 4 })
  await s.journal.setSpendLimit(10_000_000, s.journal.state.seq, 100)
  assert.deepEqual(s.journal.state.budget!.caps, { usdMicros: 10_000_000, rounds: 4 })
  await s.worker(8_000_000)
  assert.equal(s.warnings().length, 1)
  assert.equal(s.journal.state.budget!.stop === null, true)
  await s.journal.setSpendLimit(7_000_000, s.journal.state.seq, 100)
  assert.equal(s.journal.state.budget!.stop?.reason, 'budget')
  assert.equal(s.journal.state.phase, 'stopped')
  await s.journal.setSpendLimit(null, s.journal.state.seq, 100)
  assert.equal(s.journal.state.budget!.stop?.reason, 'budget', 'turning it Off never clears a stop')
  const reached = await rig({ usdMicros: max, rounds: 4 })
  await reached.journal.setSpendLimit(3_000_000, reached.journal.state.seq, 100)
  await reached.worker(3_000_000)
  assert.equal(reached.journal.state.budget!.stop?.reason, 'budget', 'spend reaching the limit stops the goal')
})

test('the setting changes only dollars, is revision fenced and refuses amounts outside 1..max', async () => {
  const s = await rig()
  const before = { policy: s.journal.state.policy, rounds: s.journal.state.budget!.caps.rounds }
  await assert.rejects(s.journal.setSpendLimit(null, s.journal.state.seq - 1, 100), (error: any) => error.wireCode === 'lead-revision-stale')
  for (const usdMicros of [0, -1, 1.5, max, max + 1]) await assert.rejects(s.journal.setSpendLimit(usdMicros, s.journal.state.seq, 100), String(usdMicros))
  await assert.rejects(s.journal.setSpendLimit(2_000_000, s.journal.state.seq, 50), 'a clock behind the ledger is refused')
  assert.equal(s.journal.state.spendLimit, null)
  await s.journal.setSpendLimit(2_000_000, s.journal.state.seq, 100)
  assert.deepEqual({ policy: s.journal.state.policy, rounds: s.journal.state.budget!.caps.rounds }, before)
  const seq = s.journal.state.seq
  await s.journal.setSpendLimit(2_000_000, seq, 100)
  assert.equal(s.journal.state.seq, seq, 'an unchanged setting writes nothing')
})

test('Off never lifts an approved figure, a set limit caps one, and a Lead draft is lifted only before approval', async () => {
  const off = await rig()
  await off.journal.setSpendLimit(null, off.journal.state.seq, 100)
  await off.approve({ usdMicros: 5_000_000, rounds: 2 })
  assert.deepEqual(off.journal.state.budget!.caps, { usdMicros: 5_000_000, rounds: 2 }, 'a $5 card approved after Off stays $5')
  await off.journal.setSpendLimit(2_000_000, off.journal.state.seq, 100)
  assert.equal(off.journal.state.budget!.caps.usdMicros, 2_000_000, 'a limit lowers an approved goal')
  await off.journal.setSpendLimit(null, off.journal.state.seq, 100)
  assert.equal(off.journal.state.budget!.caps.usdMicros, 5_000_000, 'Off goes back to the approved figure, never past it')
  assert.deepEqual(leadDraftCaps({ usdMicros: null }, { usdMicros: 5_000_000, rounds: 2 }), { usdMicros: max, rounds: 2 }, 'a draft frozen while Off carries the ceiling')
  assert.deepEqual(leadLimitedCaps({ usdMicros: null }, { usdMicros: 2_000_000, rounds: 1 }), { usdMicros: 2_000_000, rounds: 1 }, 'a $2 repeat stays $2 after Off')
  assert.deepEqual(leadLimitedCaps({ usdMicros: 3_000_000 }, { usdMicros: 5_000_000, rounds: 1 }), { usdMicros: 3_000_000, rounds: 1 }, 'a $5 repeat runs at $3 under a $3 limit')
  const on = await rig()
  await on.journal.setSpendLimit(3_000_000, on.journal.state.seq, 100)
  await on.approve({ usdMicros: 9_000_000, rounds: 2 })
  assert.deepEqual(on.journal.state.budget!.caps, { usdMicros: 3_000_000, rounds: 2 }, 'clamped to the limit')
  const under = await rig()
  await under.journal.setSpendLimit(3_000_000, under.journal.state.seq, 100)
  await under.approve({ usdMicros: 1_000_000, rounds: 2 })
  assert.deepEqual(under.journal.state.budget!.caps, { usdMicros: 1_000_000, rounds: 2 }, 'a tighter plan keeps its own cap')
  assert.deepEqual(leadLimitedCaps(null, { usdMicros: 7, rounds: 1 }), { usdMicros: 7, rounds: 1 }, 'an unrecorded setting leaves the plan as drafted')
})

test('the next goal takes its dollars from the setting and its rounds from what stood, and the setting survives a checkpoint', async () => {
  const s = await rig({ usdMicros: 5_000_000, rounds: 3 })
  await s.journal.setSpendLimit(null, s.journal.state.seq, 100)
  await s.journal.raiseBudget('goal-1', { usdMicros: max, rounds: 6 }, s.journal.state.seq, 100)
  await s.journal.stop(async () => {})
  await s.journal.beginGoal('goal-2', 200)
  assert.deepEqual(s.journal.state.budget!.caps, { usdMicros: max, rounds: 3 })
  assert.deepEqual(s.journal.state.spendLimit, { usdMicros: null })
  const restored = parseLeadCheckpoint(leadCheckpoint(s.journal.state, 'a'.repeat(64))).state
  assert.deepEqual(restored.spendLimit, { usdMicros: null })
  assert.throws(() => parseLeadCheckpoint(leadCheckpoint({ ...s.journal.state, spendLimit: { usdMicros: max + 1 } }, 'a'.repeat(64))))
  assert.throws(() => parseLeadCheckpoint(leadCheckpoint({ ...s.journal.state, spendLimit: { usdMicros: 1, rounds: 2 } as any }, 'a'.repeat(64))))
  const replayed = await createLeadJournal(s.storage)
  assert.deepEqual(replayed.state.budget, s.journal.state.budget, 'replay reaches the same ledger')
  await s.journal.setSpendLimit(4_000_000, s.journal.state.seq, 200)
  await s.journal.stop(async () => {})
  await s.journal.beginGoal('goal-3', 300)
  assert.deepEqual(s.journal.state.budget!.caps, { usdMicros: 4_000_000, rounds: 3 })
})

test('the host migration record is written once and widens the goal in hand only when asked', async () => {
  const s = await rig({ usdMicros: 1_000_000, rounds: 3 })
  await s.journal.recordSpendLimit(null, true, 100)
  assert.deepEqual(s.journal.state.budget!.caps, { usdMicros: max, rounds: 3 })
  const seq = s.journal.state.seq
  await s.journal.recordSpendLimit(2_000_000, true, 100)
  assert.equal(s.journal.state.seq, seq, 'a recorded setting is never migrated again')
  const kept = await rig({ usdMicros: 1_000_000, rounds: 3 })
  await kept.journal.recordSpendLimit(null, false, 100)
  assert.deepEqual(kept.journal.state.budget!.caps, { usdMicros: 1_000_000, rounds: 3 }, 'a goal whose cap is not widened keeps it to its end')
  assert.deepEqual(kept.journal.state.spendLimit, { usdMicros: null })
})

test('the Lead is told there is no dollar limit when Off and the figure when one is set', () => {
  const facts = { name: 'Dex', project: { id: 'project-demo', path: '/workspace/demo' }, policyRevision: 1 } as const
  assert.match(leadInstructions({ ...facts, caps: { usdMicros: max, rounds: 4 } }), /spending limit off: no dollar limit/)
  assert.doesNotMatch(leadInstructions({ ...facts, caps: { usdMicros: 2_000_000, rounds: 4 } }), /spending limit off/)
})
