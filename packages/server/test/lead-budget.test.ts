import assert from 'node:assert/strict'
import { test } from 'node:test'
import { canReplaceLeadPlan, createLeadJournal, leadBudgetProjection, type LeadJournalRecord } from '@harnessdesk/lead'
import { agent, goalRig } from './fixtures/flow-goal-rig.js'
import { sourceDigest } from '../src/flow-execution.js'
import { LeadBudgets } from '../src/lead/budgets.js'

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

test('host recovery refuses to run while a registered Lead child is live', async t => {
  const s = await leadRig(t)
  const before = structuredClone(s.records)
  const ended = s.budgets.childStarted(s.journal)
  await assert.rejects(s.budgets.recover(), /lead-child-live/)
  assert.deepEqual(s.records, before, 'refusal precedes every recovery write')
  ended()
  await s.budgets.recover()
})

test('a fresh person request observes its settled run without recovering a live management child', async t => {
  const s = await leadRig(t)
  await s.start()
  await s.journal.appendMessage('new-request', 'Propose a new attempt.')
  const end = s.budgets.childStarted(s.journal)
  t.after(async () => { end() })
  await s.budgets.meter(s.journal)
  assert.equal(canReplaceLeadPlan(s.journal.state), false, 'a live run keeps the plan locked')
  const runs = s.budgets.port.runs()
  t.mock.method(s.budgets.port, 'runs', () => runs.map(run => ({ ...run, state: 'settled' as const })))
  const { LeadControls } = await import('../src/lead/controls.js')
  let continuation = ''
  const controls = new LeadControls({ journal: s.journal, project: s.project, model: 'fixture', now: () => 100, nextId: () => 'new-plan', push() {},
    meterSpend: () => s.budgets.meter(s.journal), decidePerson: async () => {}, decideResult: async () => {},
    service: { async status() { return { configured: true, protection: 'encrypted' as const } }, async setKey() {}, async deleteKey() {}, async assertPublic() {},
      async send(request) { continuation = JSON.stringify(request.messages.at(-1)); return { status: 'completed' } } } })
  t.after(async () => { controls.close() })
  await controls.send({ idempotencyKey: 'after-settlement', text: 'Propose a new attempt now.' })
  await controls.idle()
  assert.match(continuation, /The desk has confirmed that every started step has settled/)
  assert.equal(canReplaceLeadPlan(s.journal.state), true, 'a settled run leaves a way to propose fresh work')
  assert.equal(s.journal.state.runs.length, 1)
  assert.equal(s.journal.state.steps[0]!.state, 'started')
})

test('approval of a replacement one-step plan binds its new Team while retaining the earlier spend', async t => {
  const s = await leadRig(t)
  await s.start(); await s.observe(7)
  const old = s.rig.flows.leadRuns()[0]!
  await s.journal.observeSettledRun(old.id, leadRoundId(old.id, 1))
  await s.journal.appendMessage('new-request', 'Try again with a new plan.')
  const contract = { ...s.contract, revision: 2, digest: 'b'.repeat(64), steps: [{ ...s.contract.steps[0]!, id: 'fresh-work' }] }
  await s.journal.offerCard({ version: 1, id: 'replacement', revision: 1, type: 'plan', contractDigest: contract.digest, contract })
  await s.journal.decideCard({ version: 1, cardId: 'replacement', cardType: 'plan', expectedRevision: 1, contractDigest: contract.digest, choice: 'approve' }, 1000)
  const params = await s.params(), step = contract.steps[0]!
  const result = await s.journal.execute({ id: 'replacement-start', stepId: step.id,
    request: { method: 'flow/start-goal', params, project: s.project, runId: null, start: step },
    context: { desk: s.journal.state.policy!, projectPolicy: null, project: s.project, approved: null, budget: null, now: 100, policyInterpretation: 'idle' } }, async () => {
      s.budgets.prepare('replacement-start', s.journal, step.id, params, s.project)
      await s.budgets.bind({ ...old, id: 'replacement-run', goal: 'replacement-team', lead: { ...old.lead!, contractDigest: contract.digest, startId: 'replacement-start', stepId: step.id } })
      return { value: null, identity: { correlationId: 'replacement-start', runId: 'replacement-run', teamId: 'replacement-team' } }
    })
  assert.equal(result.outcome, 'succeeded')
  assert.deepEqual(s.journal.state.budget!.executionIds, [old.id, 'replacement-run'])
  assert.equal(s.journal.state.budget!.workerUsdMicros, 7)
  assert.deepEqual(s.journal.state.runs.map(run => run.teamId), [old.goal, 'replacement-team'])
})

test('child exit unregisters its budget owner, live latch and pending retries', async t => {
  const s = await leadRig(t)
  await s.start()
  const scheduled = new Set<() => void>()
  Object.assign(s.budgets.port, { schedule: (callback: () => void) => {
    scheduled.add(callback)
    return () => { scheduled.delete(callback) }
  } })
  const ended = s.budgets.childStarted(s.journal)
  s.setStopFails(true)
  await s.observe(100_000).catch(() => {})
  await s.budgets.idle()
  assert.equal(scheduled.size, 1)
  s.unregister()
  assert.equal(scheduled.size, 0)
  await s.budgets.recover()
  await assert.rejects(s.budgets.update('logical-1', { version: 1, type: 'stop', now: 100, reason: 'budget' }), /lead-budget-owner/)
  assert.ok(ended, 'host must receive the child lifetime disposer')
  ended()
})
for (const scenario of ['delayed round transition', 'worker Seat crash', 'host restart']) {
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
    else if (scenario === 'worker Seat crash') {
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

for (const kind of ['observed worker cap', 'uncertain Messages request plus full reservation write-off', 'uncertain Messages settle']) {
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
      if (kind === 'uncertain Messages request plus full reservation write-off') await s.journal.updateBudget({ version: 1, type: 'write-off', now: 100, requestId: 'paid' })
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

test('a worker turn that ends while the usage read is in flight is metered again, not latched as unknown spend', async t => {
  const s = await leadRig(t), run = await s.start()
  await s.observe(0)
  const seat = [...s.rig.seats.values()][0]!
  s.setNow(1000)
  await s.observe(0)
  const exact = (value: number) => ({ value, quality: 'exact' })
  let reads = 0, release!: () => void, entered!: () => void
  const held = new Promise<void>(resolve => { release = resolve }), reading = new Promise<void>(resolve => { entered = resolve })
  const sample = (at: number) => ({ key: 'worker-cost', source: { id: 'synthetic', kind: 'corpus', label: 'Synthetic', observedAt: at, checkedAt: at, stale: false, problem: null },
    runtime: seat.session.runtime, sessionId: seat.session.sessionId, turnId: null, requestId: null, project: seat.checkout.project,
    model: 'fixture/model', from: seat.openedAt, to: at, scope: 'session', includesChildren: false,
    input: exact(1), output: exact(1), cacheRead: exact(0), cacheWrite: exact(0), usd: exact(0.00001), moneyBasis: 'vendorMetered' })
  let named: readonly { readonly runtime: string; readonly sessionId: string }[] = []
  Object.assign(s.budgets.port, { seats: () => [...s.rig.seats.values()], delegation: () => 'none', usage: async (_project: string, _from: number, to: number,
    sessions: readonly { readonly runtime: string; readonly sessionId: string }[]) => {
    named = sessions
    if (++reads === 1) { entered(); await held }
    return { complete: true, samples: [sample(to)] }
  } })
  const verdict = s.budgets.gate(s.rig.flows.leadRuns()[0]!)
  await reading
  s.setNow(1500)
  s.budgets.turn(seat, 'ended')
  release()
  await verdict
  await s.budgets.idle()
  assert.equal(s.journal.state.budget!.stop, null, 'a turn ending mid-read must not stop the Lead')
  assert.equal(s.journal.state.budget!.workerUsdMicros, 10)
  assert.ok(reads >= 2, 'the host read again after the turn ended')
  assert.deepEqual(named, [{ runtime: String(seat.session.runtime), sessionId: String(seat.session.sessionId) }], 'the meter reads its own Seat, not the machine')
  assert.notEqual(s.rig.flows.executionOf(run.id)!.state, 'stopped')
})

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


test('host retries failed cleanup on its scheduler without child tools or manual cleanup', async t => {
  const s = await leadRig(t), run = await s.start()
  const scheduled = new Map<number, () => void>()
  const delays: number[] = []
  let next = 0
  Object.assign(s.budgets.port, { schedule: (callback: () => void, delay: number) => {
    const id = ++next; scheduled.set(id, callback); delays.push(delay)
    return () => { scheduled.delete(id) }
  } })
  s.setStopFails(true)
  const before = s.rig.events.filter(event => event.startsWith('open:') || event.startsWith('order:')).length
  await s.observe(100_000).catch(() => {})
  await s.budgets.idle()
  assert.equal(scheduled.size, 1)
  for (let attempt = 0; attempt < 8; attempt++) {
    const [id, retry] = [...scheduled][0]!
    scheduled.delete(id); retry(); await s.budgets.idle()
    assert.equal(scheduled.size, 1)
  }
  assert.ok(delays.every(delay => delay > 0 && delay <= 5000))
  assert.ok(delays[1]! > delays[0]!)
  s.setStopFails(false)
  const [id, retry] = [...scheduled][0]!
  scheduled.delete(id); retry(); await s.budgets.idle()
  assert.equal(s.journal.state.stopEffectsPending, null)
  assert.equal(scheduled.size, 0)
  assert.equal(s.rig.flows.executionOf(run.id)!.state, 'stopped')
  assert.equal(s.rig.events.filter(event => event.startsWith('open:') || event.startsWith('order:')).length, before)
})

test('unregister cancels a pending cleanup retry', async t => {
  const s = await leadRig(t)
  await s.start()
  const scheduled = new Map<number, () => void>()
  let next = 0, stops = 0
  Object.assign(s.budgets.port, { schedule: (callback: () => void) => {
    const id = ++next; scheduled.set(id, callback)
    return () => { scheduled.delete(id) }
  } })
  const stop = s.budgets.port.stop
  t.mock.method(s.budgets.port, 'stop', async (run: string, reason: string) => {
    if (++stops === 1) throw new Error('synthetic cleanup failure')
    return stop(run, reason)
  })
  const cleanup = t.mock.method(s.budgets, 'cleanup')
  await s.journal.updateBudget({ version: 1, type: 'stop', now: 100, reason: 'budget' })
  await s.budgets.idle()
  assert.equal(cleanup.mock.callCount(), 1)
  assert.equal(stops, 1)
  assert.ok(s.journal.state.stopEffectsPending)
  assert.equal(scheduled.size, 1)
  s.unregister()
  assert.equal(scheduled.size, 0)
  for (const [id, retry] of [...scheduled]) {
    scheduled.delete(id); retry()
  }
  await s.budgets.idle()
  assert.equal(cleanup.mock.callCount(), 1)
  assert.equal(stops, 1)
})

for (const cause of ['rounds', 'budget', 'unknown-spend', 'reservation', 'terminal']) {
  test(`round refusal reports ${cause} and does not mislabel a rounds cap`, async t => {
    const s = await leadRig(t), run = await s.start()
    await s.observe(0)
    if (cause === 'rounds') await s.journal.updateBudget({ version: 1, type: 'tighten', now: 100, caps: { usdMicros: 100_000, rounds: 1 } })
    if (cause === 'budget') await s.observe(100_000)
    if (cause === 'unknown-spend') s.setNow(2000)
    if (cause === 'reservation') await s.journal.updateBudget({ version: 1, type: 'reserve', now: 100, requestId: 'outstanding', inputTokens: 50_000, maxOutputTokens: 50_000,
      inputUsdMicrosPerMillion: 1_000_000, outputUsdMicrosPerMillion: 1_000_000, cacheReadUsdMicrosPerMillion: 1_000_000, cacheWriteUsdMicrosPerMillion: 1_000_000 })
    if (cause === 'terminal') await s.journal.updateBudget({ version: 1, type: 'observe', now: 100, at: 100, revision: s.journal.state.budget!.revision + 1,
      source: 'worker-samples', sourceIds: ['terminal'], goalId: run.goal, executionIds: [run.id], quality: 'known', usdMicros: 0, terminal: true })
    await assert.rejects(s.budgets.round(s.rig.flows.leadRuns()[0]!, leadRoundId(run.id, 2)), /lead-round-refused/)
    assert.equal(s.journal.state.budget!.stop?.reason ?? null, cause === 'reservation' || cause === 'terminal' ? null : cause)
    assert.equal(s.journal.state.budget!.rounds.length, 1)
    if (cause === 'reservation') {
      await s.journal.updateBudget({ version: 1, type: 'settle', now: 100, requestId: 'outstanding', inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 })
      await s.budgets.round(s.rig.flows.leadRuns()[0]!, leadRoundId(run.id, 2))
      assert.equal(s.journal.state.budget!.rounds.length, 2)
    }
  })
}

test('recovery processes the next journal after an earlier cleanup fails', async t => {
  const first = await leadRig(t), second = await leadRig(t)
  await first.start(); await second.start()
  const records: LeadJournalRecord[] = []
  const storage = { async read() { return structuredClone(records) }, async append(record: LeadJournalRecord) { records.push(structuredClone(record)) } }
  // Distinct logical goals share the same host recovery owner, never a writer.
  const checkpoint = second.journal.state
  Object.assign(checkpoint.budget!, { logicalGoalId: 'logical-2' })
  const other = await createLeadJournal({ ...storage, async read() { return [] }, checkpoint: () => checkpoint })
  const close = first.budgets.register(other)
  t.after(async () => { close() })
  const runs = first.budgets.port.runs
  const secondRuns = second.budgets.port.runs().map(run => ({ ...run, lead: { ...run.lead!, logicalGoalId: 'logical-2' } }))
  t.mock.method(first.budgets.port, 'runs', () => [...runs(), ...secondRuns])
  first.setStopFails(true)
  await first.observe(100_000).catch(() => {}); await first.budgets.idle()
  const startId = secondRuns[0]!.lead!.startId
  assert.equal(other.state.attempts.get(startId)!.evidence, null)
  await assert.rejects(first.budgets.recover(), AggregateError)
  assert.ok(other.state.attempts.get(startId)!.evidence)
})

test('with the Lead child absent the registered host owner still refuses dispatch after a cap latch', async t => {
  const s = await leadRig(t), run = await s.start()
  // No Lead tools or management loop is running. Only the host journal remains.
  s.setStopFails(true)
  await s.observe(100_000).catch(() => {}); await s.budgets.idle()
  const before = s.rig.events.filter(event => event.startsWith('open:') || event.startsWith('order:')).length
  assert.equal((await s.budgets.gate(s.rig.flows.leadRuns()[0]!)).ok, false)
  const card = s.rig.board(run.goal).intents[0]!
  await s.rig.team.complete(card.id, { outcome: 'committed' }, s.rig.sessionOf(String(run.rounds[0]!.seats[0]!)))
  await s.rig.flows.flush(); await s.budgets.idle()
  assert.equal(s.rig.events.filter(event => event.startsWith('open:') || event.startsWith('order:')).length, before)
})

for (const multi of [false, true]) test(`host bind ${multi ? 'permits' : 'refuses'} a new Goal for a ${multi ? 'multi' : 'single'}-step contract`, async t => {
  const s = await leadRig(t), run = await s.start()
  const state = s.journal.state, stored = s.rig.flows.leadRuns().find(item => item.id === run.id)!
  // The existing anchor represents an earlier bound Goal. The host still has
  // exact ownership proof for this run and must apply the contract's Goal limit.
  let writes = 0
  const bound = new Proxy(s.journal, { get(target, key) {
    if (key === 'state') return { ...state, budget: { ...state.budget!, goalId: 'previous-goal' },
      contract: { ...state.contract!, steps: multi ? [...state.contract!.steps, { ...state.contract!.steps[0]!, id: 'next' }] : state.contract!.steps } }
    if (key === 'updateBudget') return async (event: Parameters<typeof target.updateBudget>[0]) => { writes++; await target.updateBudget(event) }
    const value = Reflect.get(target, key)
    return typeof value === 'function' ? value.bind(target) : value
  } })
  const budgets = new LeadBudgets({ now: () => 100, runs: () => [stored], member: async () => true, interruptChecks() {}, stop: async () => {} })
  const unregister = budgets.register(bound)
  t.after(unregister)
  const before = s.journal.state.seq
  if (multi) { await budgets.bind(stored); assert.equal(writes, 1) }
  else {
    await assert.rejects(budgets.bind(stored), /lead-start-not-approved/)
    assert.equal(writes, 0)
    assert.equal(s.journal.state.seq, before)
  }
})


test('a run keeps its admission contract binding after a plan revision is approved and replayed', async t => {
  const s = await leadRig(t), run = await s.start()
  const contract = { ...s.contract, revision: 2, digest: 'b'.repeat(64), goal: 'Revised repair goal' }
  await s.journal.offerCard({ version: 1, id: 'revision', revision: 1, type: 'plan', contractDigest: contract.digest, contract })
  await s.journal.decideCard({ version: 1, cardId: 'revision', cardType: 'plan', expectedRevision: 1, contractDigest: contract.digest, choice: 'approve' }, 1000)
  const stored = s.rig.flows.leadRuns().find(item => item.id === run.id)!
  await s.observe(0)
  assert.deepEqual(await s.budgets.gate(stored), { ok: true })
  const reopened = await reopenJournal(s.storage)
  const budgets = new LeadBudgets({ ...s.budgets.port })
  const unregister = budgets.register(reopened); t.after(unregister)
  assert.deepEqual(await budgets.gate(stored), { ok: true })
  assert.deepEqual(await budgets.gate({ ...stored, lead: { ...stored.lead!, contractDigest: contract.digest } }),
    { ok: false, reason: 'lead-guard-unavailable' })
})

test('a Lead request meters its workers again even before its child registers, so a finished run stays known', async t => {
  const s = await leadRig(t)
  await s.start()
  await s.observe(0)
  const seat = [...s.rig.seats.values()][0]!
  const exact = (value: number) => ({ value, quality: 'exact' })
  Object.assign(s.budgets.port, { seats: () => [...s.rig.seats.values()], delegation: () => 'none', usage: async (_project: string, _from: number, to: number) => ({ complete: true, samples: [{
    key: 'worker-cost', source: { id: 'synthetic', kind: 'corpus', label: 'Synthetic', observedAt: to, checkedAt: to, stale: false, problem: null },
    runtime: seat.session.runtime, sessionId: seat.session.sessionId, turnId: null, requestId: null, project: seat.checkout.project,
    model: 'fixture/model', from: seat.openedAt, to, scope: 'session', includesChildren: false,
    input: exact(1), output: exact(1), cacheRead: exact(0), cacheWrite: exact(0), usd: exact(0.00001), moneyBasis: 'vendorMetered' }] }) })
  s.setNow(10_000_000)
  assert.notEqual(leadBudgetProjection(s.journal.state.budget!, 10_000_000).spend, 'known', 'the old reading has aged out')
  // A desk restart: a fresh owner that has not registered this journal yet.
  const restarted = new LeadBudgets({ ...s.budgets.port })
  await restarted.meter(s.journal)
  assert.equal(leadBudgetProjection(s.journal.state.budget!, 10_000_000).spend, 'known')
  assert.equal(s.journal.state.budget!.stop, null)
})

test('a live goal whose workers have gone quiet is metered again before its reading ages out', async t => {
  const s = await leadRig(t)
  await s.start()
  await s.observe(0)
  const seat = [...s.rig.seats.values()][0]!
  const exact = (value: number) => ({ value, quality: 'exact' })
  Object.assign(s.budgets.port, { seats: () => [...s.rig.seats.values()], delegation: () => 'none', usage: async (_project: string, _from: number, to: number) => ({ complete: true, samples: [{
    key: 'worker-cost', source: { id: 'synthetic', kind: 'corpus', label: 'Synthetic', observedAt: to, checkedAt: to, stale: false, problem: null },
    runtime: seat.session.runtime, sessionId: seat.session.sessionId, turnId: null, requestId: null, project: seat.checkout.project,
    model: 'fixture/model', from: seat.openedAt, to, scope: 'session', includesChildren: false,
    input: exact(1), output: exact(1), cacheRead: exact(0), cacheWrite: exact(0), usd: exact(0.00001), moneyBasis: 'vendorMetered' }] }) })
  // No Seat starts or ends a turn from here on, so no turn meters the goal.
  s.setNow(10_000_000)
  assert.notEqual(leadBudgetProjection(s.journal.state.budget!, 10_000_000).spend, 'known', 'the old reading has aged out')
  s.fireTimers()
  await s.budgets.idle()
  assert.equal(leadBudgetProjection(s.journal.state.budget!, 10_000_000).spend, 'known', 'the host read the quiet workers again on its own')
  assert.equal(s.journal.state.budget!.stop, null)
})

test('an incomplete reading after every run has ended leaves spend unknown without stopping the goal', async t => {
  const s = await leadRig(t)
  await s.start()
  await s.observe(0)
  const live = s.budgets.port.runs
  Object.assign(s.budgets.port, { runs: () => live().map(run => ({ ...run, state: 'stopped' })), seats: () => [...s.rig.seats.values()], delegation: () => 'none',
    usage: async () => ({ complete: false, samples: [] }) })
  s.setNow(10_000_000)
  await s.budgets.meter(s.journal)
  assert.equal(s.journal.state.budget!.stop, null, 'no worker can spend any more, so nothing needs stopping')
  assert.notEqual(leadBudgetProjection(s.journal.state.budget!, 10_000_000).spend, 'known', 'and the Lead still may not spend on a guess')
})
