import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createLeadJournal, type LeadJournalRecord } from '@harnessdesk/lead'
import { agent, goalRig } from './fixtures/flow-goal-rig.js'
import { sourceDigest } from '../src/flow-execution.js'

const SOURCE = `version: 2
name: Guarded work
roles:
  write: { kind: agent, uses: writer, grant: edit, independentOf: [] }
  review: { kind: agent, uses: reviewer, grant: read, independentOf: [] }
seed: { role: write, title: Write }
rules:
  - { id: next, on: write, when: { every: [done] }, then: { role: review, title: Review } }
`
const AGENTS = [agent('writer', ['done']), agent('reviewer', ['approve'])]
const binding = { logicalGoalId: 'logical-1', contractDigest: 'a'.repeat(64), startId: 'host-start', stepId: 'work' }
const journal = async () => {
  const records: LeadJournalRecord[] = []
  const value = await createLeadJournal({ async read() { return records }, async append(record) { records.push(record) } })
  await value.updateBudget({ version: 1, type: 'initialize', now: 100, logicalGoalId: 'logical-1', caps: { usdMicros: 100, rounds: 10 }, freshnessMs: 1000 })
  return value
}
for (const scenario of ['delayed round transition', 'child crash', 'host restart']) {
  test(`${scenario} cannot dispatch after a host cap latch`, async t => {
    const ledger = await journal()
    const guard = { bind: async () => {}, round: async () => {}, gate: async () => ledger.state.budget?.stop ? { ok: false, reason: 'Lead budget stopped' } : { ok: true } }
    const rig = await goalRig(t, { executionOptions: { lead: guard } })
    const run = await rig.flows.startGoal({ root: '/repo', sentence: 'Work', source: SOURCE, sourcePath: null,
      compiled: rig.compile(SOURCE, AGENTS), lead: binding, requireHeld: true,
      authorization: { sourceDigest: sourceDigest(SOURCE), commandDigest: sourceDigest(''), approvedAt: 100, start: 'front-door' } } as any)
    const before = rig.events.filter(event => event.startsWith('open:') || event.startsWith('order:')).length
    await ledger.updateBudget({ version: 1, type: 'stop', now: 101, reason: 'budget' })
    if (scenario === 'host restart') { await rig.restart(); await rig.flows.resume() }
    else if (scenario === 'child crash') {
      const seat = rig.seats.values().next().value!
      rig.kill(String(seat.id)); await rig.executions.reArm(seat.session.runtime, seat.session.sessionId)
    } else {
      const card = rig.board(run.goal).intents[0]!
      await rig.team.complete(card.id, { outcome: 'done' }, rig.sessionOf(String(run.rounds[0]!.seats[0]!)))
    }
    await rig.flows.flush()
    assert.equal(rig.events.filter(event => event.startsWith('open:') || event.startsWith('order:')).length, before)
    assert.ok(rig.board(run.goal).intents.length > 0, 'work stays on the board')
  })
}

// These exercise the real host owner rather than the isolated Flow guard above.
import { leadRig } from './fixtures/lead.js'
import { createLeadJournal as reopenJournal } from '@harnessdesk/lead'
import { leadRoundId } from '../src/flow-execution.js'

for (const kind of ['observed worker cap', 'full reservation write-off', 'uncertain Messages settle']) {
  test(`${kind} records its latch before interrupting checks and Seats`, async t => {
    const s = await leadRig(t), run = await s.start()
    let interrupts = 0
    const interrupt = s.budgets.port.interruptChecks
    t.mock.method(s.budgets.port, 'interruptChecks', (goal: string) => {
      assert.ok(s.journal.state.budget!.stop, 'stop precedes effects')
      assert.ok(s.journal.state.stopEffectsPending)
      interrupts++; interrupt(goal)
    })
    if (kind === 'observed worker cap') await s.observe(100_000)
    else {
      await s.observe(0)
      await s.journal.updateBudget({ version: 1, type: 'reserve', now: 100, requestId: 'paid', inputTokens: 50_000, maxOutputTokens: 50_000,
        inputUsdMicrosPerMillion: 1_000_000, outputUsdMicrosPerMillion: 1_000_000, cacheReadUsdMicrosPerMillion: 1_000_000, cacheWriteUsdMicrosPerMillion: 1_000_000 })
      await s.journal.updateBudget({ version: 1, type: 'uncertain', now: 100, requestId: 'paid' })
      if (kind === 'full reservation write-off') await s.journal.updateBudget({ version: 1, type: 'write-off', now: 100, requestId: 'paid' })
    }
    await s.budgets.idle()
    assert.ok(s.journal.state.budget!.stop)
    assert.ok(interrupts > 0)
    assert.equal(s.rig.flows.executionOf(run.id)!.state, 'stopped')
    assert.equal(s.journal.state.stopEffectsPending, null)
    assert.ok(s.rig.board(run.goal).intents.length)
  })
}

test('failed stop cleanup retries without reopening dispatch, including after journal reopen', async t => {
  const s = await leadRig(t), run = await s.start()
  s.setStopFails(true)
  await s.observe(100_000).catch(() => {})
  await s.budgets.idle()
  assert.ok(s.journal.state.stopEffectsPending)
  assert.equal((await s.budgets.gate(s.rig.flows.leadRuns()[0]!)).ok, false)
  const reopened = await reopenJournal(s.storage)
  assert.ok(reopened.state.stopEffectsPending)
  s.setStopFails(false)
  await s.budgets.cleanup('logical-1')
  assert.equal(s.journal.state.stopEffectsPending, null)
  assert.equal(s.rig.flows.executionOf(run.id)!.state, 'stopped')
})

test('host round identities are stable and retries never debit the same round twice', async t => {
  const s = await leadRig(t), run = await s.start()
  await s.observe()
  const stored = s.rig.flows.leadRuns()[0]!
  await s.budgets.round(stored, leadRoundId(run.id, 2))
  await s.budgets.round(stored, leadRoundId(run.id, 2))
  assert.equal(s.journal.state.budget!.rounds.length, 2)
  await s.rig.restart()
  await s.budgets.round(s.rig.flows.leadRuns()[0]!, leadRoundId(run.id, 2))
  assert.equal(s.journal.state.budget!.rounds.length, 2)
  assert.notEqual(leadRoundId('another-run', 2), leadRoundId(run.id, 2))
})

for (const complete of [true, false]) {
  test(`the host reads ${complete ? 'attributed worker cost' : 'incomplete worker usage'} before dispatch`, async t => {
    const s = await leadRig(t), run = await s.start()
    await s.observe(0)
    const seat = [...s.rig.seats.values()][0]!
    const at = 1000
    s.setNow(at)
    // Keep the prior observation fresh; it must still be replaced by the host read.
    await s.observe(0)
    const exact = (value: number) => ({ value, quality: 'exact' })
    Object.assign(s.budgets.port, { seats: () => [...s.rig.seats.values()], delegation: () => 'none', usage: async () => ({ complete, samples: [{
      key: 'worker-cost', source: { id: 'synthetic', kind: 'corpus', label: 'Synthetic', observedAt: at, checkedAt: at, stale: false, problem: null },
      runtime: seat.session.runtime, sessionId: seat.session.sessionId, turnId: null, requestId: null, project: seat.checkout.project,
      model: 'fixture/model', from: seat.openedAt, to: at, scope: 'session', includesChildren: false,
      input: exact(1), output: exact(1), cacheRead: exact(0), cacheWrite: exact(0), usd: exact(complete ? 0.1 : 0.01), moneyBasis: 'vendorMetered',
    }] }) })
    const verdict = await s.budgets.gate(s.rig.flows.leadRuns()[0]!)
    assert.equal(verdict.ok, false)
    assert.equal(s.journal.state.budget!.stop?.reason, complete ? 'budget' : 'unknown-spend')
    if (complete) assert.equal(s.journal.state.budget!.workerUsdMicros, 100_000)
    await s.budgets.idle()
    assert.equal(s.rig.flows.executionOf(run.id)!.state, 'stopped')
  })
}

test('a recovered Lead Seat must hold its ceiling again before another turn', async t => {
  const s = await leadRig(t), run = await s.start()
  await s.observe(0)
  const before = s.rig.events.filter(event => event.startsWith('order:')).length
  s.rig.holdsCeilings = false
  const seat = [...s.rig.seats.values()][0]!
  s.rig.kill(String(seat.id))
  await s.rig.executions.reArm(seat.session.runtime, seat.session.sessionId)
  await s.rig.flows.flush()
  assert.equal(s.rig.events.filter(event => event.startsWith('order:')).length, before)
  assert.equal(s.rig.flows.executionOf(run.id)!.state, 'stalled')
})

test('host recovery supplies exact journal evidence with stable first-round identity', async t => {
  const s = await leadRig(t), run = await s.start()
  await s.observe(0)
  const start = s.rig.flows.leadRuns()[0]!.lead!.startId
  assert.equal(s.journal.state.attempts.get(start)!.evidence, null)
  await s.budgets.recover()
  const evidence = s.journal.state.attempts.get(start)!.evidence
  assert.ok(evidence)
  assert.deepEqual(JSON.parse(evidence), [{ correlationId: start, runId: run.id, teamId: run.goal,
    firstRoundId: leadRoundId(run.id, 1), terminal: false }])
  assert.equal(s.journal.state.budget!.rounds.length, 1)
})

test('recovery cannot acknowledge stop cleanup before owned Flow files load', async t => {
  const s = await leadRig(t); await s.start()
  s.setStopFails(true)
  await s.observe(100_000).catch(() => {}); await s.budgets.idle()
  const runs = s.budgets.port.runs
  const unavailable = t.mock.method(s.budgets.port, 'runs', () => [])
  await assert.rejects(s.budgets.cleanup('logical-1'), /lead-stop-effects-failed/)
  assert.ok(s.journal.state.stopEffectsPending)
  unavailable.mock.restore()
  assert.ok(runs().length)
  s.setStopFails(false)
  await s.budgets.cleanup('logical-1')
  assert.equal(s.journal.state.stopEffectsPending, null)
})
