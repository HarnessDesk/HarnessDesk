import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createLeadJournal, leadCheckpoint, parseLeadCheckpoint, leadReviewedResultSource, type LeadJournalRecord } from '@harnessdesk/lead'
import { parseLeadAcceptanceContract } from '@harnessdesk/protocol'
import { LeadAdmission, leadPredecessorReadiness } from '../src/lead/admission.js'
import { LeadBudgets } from '../src/lead/budgets.js'
import { sourceDigest } from '../src/flow-execution.js'
import { executionOf } from '../src/flow-recovery.js'
import { agent, goalRig } from './fixtures/flow-goal-rig.js'

const rig = () => {
  const project = { id: 'demo', path: '/workspace/demo' }, revision = 'a'.repeat(40)
  const assignments = [
    { role: 'implement', agent: 'implementer', seat: { runtime: 'alpha' }, ceiling: 'edit' },
    { role: 'review', agent: 'code-reviewer', seat: { runtime: 'beta' }, ceiling: 'read' },
  ]
  const steps = ['first', 'second'].map(id => ({ id, title: `Review ${id}`, flow: 'lead-reviewed-result', sourceRevision: 'recipe-1',
    variables: {}, attendance: 'attended', assignments }))
  const state: any = { contract: { digest: 'digest', goal: 'Repair the check', project, steps },
    consent: { contractDigest: 'digest', expiresAt: 1000 }, budget: { logicalGoalId: 'logical' }, phase: 'running',
    steps: [{ id: 'first', state: 'started', attemptId: 'start-first', contractDigest: 'digest' }, { id: 'second', state: 'admitted', attemptId: 'start-second' }],
    attempts: new Map([['start-second', { id: 'start-second', correlationId: 'start-second', phase: 'started', dispatched: true, method: 'flow/start-goal' }]]),
    runs: [{ runId: 'run-first', teamId: 'team-first', correlationId: 'start-first' }] }
  const previous: any = { id: 'run-first', goal: 'team-first', state: 'running',
    lead: { logicalGoalId: 'logical', contractDigest: 'digest', startId: 'start-first', stepId: 'first' },
    rounds: [{ n: 1, role: 'implement', state: 'closed' }, { n: 2, role: 'review', state: 'closed' }, { n: 3, role: 'accept', state: 'running', cards: [3] }],
    seatPlans: { '1': { base: null, handed: [] }, '2': { base: revision, handed: [{ card: 1, at: revision, cwd: '/workspace/lane-first', branch: 'first' }] } } }
  const acceptance = { id: 3, state: 'open', outcome: null as string | null }
  let binding: any = null, prepared = 0
  const admission = new LeadAdmission({ journal: { get state() { return state } }, project, now: () => 100, nextId: () => 'unused',
    readIntents: () => [acceptance],
    previews: { bindLead(_params: unknown, value: unknown) { binding = value; return true } },
    budgets: { port: { member: async () => true, runs: () => [previous] }, prepared: () => false,
      startBudget: () => ({ stop: null, spend: 'known', reservedUsdMicros: 0 }), prepare() { prepared++ } },
  } as any)
  const params = { root: project.path, source: leadReviewedResultSource, token: 'preview-second', sentence: state.contract.goal,
    vars: {}, attended: true, seats: Object.fromEntries(assignments.map(one => [one.role, [one.seat]])) }
  return { admission, state, previous, acceptance, params, revision, binding: () => binding, prepared: () => prepared }
}

test('a later Lead step freezes its predecessor reviewed revision as the Flow lane base', async () => {
  const s = rig()
  assert.equal(await s.admission.authorizeStart(s.params), true)
  assert.equal(s.binding().base, s.revision)
  assert.equal(s.prepared(), 1)
})

for (const changed of ['missing run', 'unreviewed', 'missing pin', 'wrong owner', 'wrong revision', 'declined acceptance'] as const) {
  test(`a later Lead step refuses ${changed} instead of starting from the project checkout`, async () => {
    const s = rig()
    if (changed === 'declined acceptance') { s.previous.rounds.at(-1).state = 'closed'; s.acceptance.state = 'done'; s.acceptance.outcome = 'declined' }
    if (changed === 'missing run') s.state.runs = []
    if (changed === 'unreviewed') s.previous.rounds.pop()
    if (changed === 'missing pin') s.previous.seatPlans['2'].base = null
    if (changed === 'wrong owner') s.previous.lead.contractDigest = 'other'
    if (changed === 'wrong revision') s.previous.seatPlans['2'].handed[0].at = 'b'.repeat(40)
    assert.equal(await s.admission.authorizeStart(s.params), false)
    assert.equal(s.binding(), null)
    assert.equal(s.prepared(), 0)
  })
}

test('a frozen Lead base reaches the existing isolated Flow seed lane and survives restart', async t => {
  const revision = 'c'.repeat(40)
  const s = await goalRig(t, { executionOptions: { lead: {
    bind: async () => {}, round: async () => {}, gate: async () => ({ ok: true }),
  } } })
  const agents = [agent('implementer', ['committed']), agent('code-reviewer', ['approve', 'request-changes'], 'beta')]
  s.beforeClaim = n => { s.heads.set(`/repo/.lanes/${n}`, { at: revision, dirty: false }) }
  const run = await s.flows.startGoal({ root: '/repo', sentence: 'Build on the approved result', source: leadReviewedResultSource,
    sourcePath: null, compiled: s.compile(leadReviewedResultSource, agents), requireHeld: true,
    authorization: { sourceDigest: sourceDigest(leadReviewedResultSource), commandDigest: sourceDigest(''), approvedAt: 1, start: 'front-door' },
    lead: { logicalGoalId: 'logical', contractDigest: 'd'.repeat(64), startId: 'start-second', stepId: 'second', base: revision } })
  assert.equal(run.state, 'running', run.reason ?? 'seed did not start')
  const stored = s.flows.leadRuns().find(one => one.id === run.id)!
  assert.equal(stored.seatPlans!['1']!.base, revision)
  assert.equal(stored.lead!.base, revision)
  assert.notEqual(s.seats.get(run.rounds[0]!.seats[0]!)!.checkout.cwd, '/repo')
  const restarted = await s.restart()
  const recovered = restarted.flows.leadRuns().find(one => one.id === run.id)!
  assert.equal(recovered.seatPlans!['1']!.base, revision)
  assert.equal(recovered.lead!.base, revision)
  for (const base of ['', 'HEAD', 'main', 12]) {
    assert.throws(() => executionOf({ ...recovered, lead: { ...recovered.lead, base } }), /unreadable Lead authority/)
  }
})

test('a closed accepted predecessor can seed the next Lead step', async () => {
  const s = rig()
  s.previous.rounds.at(-1).state = 'closed'; s.acceptance.state = 'done'; s.acceptance.outcome = 'accepted'
  assert.equal(await s.admission.authorizeStart(s.params), true)
  assert.equal(s.binding().base, s.revision)
})


for (const legacy of [false, true]) test(`an approved plan revision starts step 2 from step 1 reviewed revision${legacy ? ' with an old-shape checkpoint' : ''}`, async () => {
  const s = rig(), records: LeadJournalRecord[] = []
  const storage = { async read() { return structuredClone(records) }, async append(record: LeadJournalRecord) { records.push(record) } }
  const journal = await createLeadJournal(storage)
  const contract = parseLeadAcceptanceContract({ ...s.state.contract, version: 1, revision: 1, digest: 'a'.repeat(64),
    policyRevision: 1, assertions: [{ id: 'review', kind: 'review', description: 'Reviewed' }], caps: { usdMicros: 1000, rounds: 10 } })
  const policy = { version: 1 as const, revision: 1, mode: 'manage' as const, rules: [] }
  const context = { desk: policy, projectPolicy: null, project: contract.project, approved: null, budget: null, now: 100, policyInterpretation: 'idle' as const }
  await journal.setPolicy(policy)
  await journal.updateBudget({ version: 1, type: 'initialize', now: 100, logicalGoalId: 'logical', caps: contract.caps, freshnessMs: 1000 })
  const approve = async (value: typeof contract) => {
    await journal.offerCard({ version: 1, id: 'plan', revision: value.revision, type: 'plan', contractDigest: value.digest, contract: value })
    await journal.decideCard({ version: 1, cardId: 'plan', cardType: 'plan', expectedRevision: value.revision, contractDigest: value.digest, choice: 'approve' }, 1000)
  }
  await approve(contract)
  const started = await journal.execute({ id: 'start-first', stepId: 'first', context,
    request: { method: 'flow/start-goal', params: s.params, project: contract.project, runId: null, start: contract.steps[0]! } },
    async () => ({ value: null, identity: { correlationId: 'start-first', runId: 'run-first', teamId: 'team-first' } }))
  assert.equal(started.outcome, 'succeeded')
  await journal.updateBudget({ version: 1, type: 'bind', now: 100, startId: 'start-first', goalId: 'team-first', executionId: 'run-first', firstRoundId: '1' })
  await journal.updateBudget({ version: 1, type: 'observe', now: 100, at: 100, revision: 1, source: 'worker-samples',
    sourceIds: ['sample'], goalId: 'team-first', executionIds: ['run-first'], quality: 'known', usdMicros: 0 })
  s.previous.lead.contractDigest = contract.digest
  assert.equal(s.previous.rounds.at(-1).role, 'accept')
  assert.equal(s.acceptance.state, 'open')
  const revised = { ...contract, revision: 2, digest: 'b'.repeat(64), goal: 'Revised repair' }
  await approve(revised)
  const replayed = await createLeadJournal(storage)
  const checkpoint: any = leadCheckpoint(replayed.state, 'c'.repeat(64))
  if (legacy) for (const step of checkpoint.state.steps) delete step.contractDigest
  const { state } = parseLeadCheckpoint(checkpoint)
  assert.equal(state.steps[0]!.contractDigest, legacy ? null : contract.digest)
  const reopened = await createLeadJournal({ async read() { return [] }, async append() {}, checkpoint() { return state } })
  Object.assign(s.admission.options, { journal: reopened })
  s.previous.source = leadReviewedResultSource; s.previous.requireHeld = true; s.previous.operations = []
  const budgets = new LeadBudgets({ now: () => 100, runs: () => [s.previous], member: async () => true,
    interruptChecks() {}, stop: async () => {} })
  const unregister = budgets.register(reopened)
  try { assert.deepEqual(await budgets.gate(s.previous), { ok: true }, 'step 1 keeps dispatching under its original binding') }
  finally { unregister() }
  s.previous.rounds.at(-1).state = 'closed'; s.acceptance.state = 'done'; s.acceptance.outcome = 'accepted'

  const params = { ...s.params, sentence: revised.goal }
  const predecessor = leadPredecessorReadiness(reopened.state, 'second', [s.previous], () => [s.acceptance] as any)
  const result = await reopened.execute({ id: 'start-second', stepId: 'second', context,
    predecessor: { runId: 'run-first', ready: predecessor.ready },
    request: { method: 'flow/start-goal', params, project: contract.project, runId: null, start: revised.steps[1]! } }, async () => {
      if (!await s.admission.authorizeStart(params)) throw new Error('lead-start-not-approved')
      return { value: null, identity: { correlationId: 'start-second', runId: 'run-second', teamId: 'team-second' } }
    })
  assert.equal(result.outcome, 'succeeded')
  assert.equal(reopened.state.phase, 'running')
  assert.equal(s.binding().base, s.revision)
  assert.equal(s.binding().contractDigest, revised.digest)
})

for (const changed of ['finished run', 'declined acceptance', 'wrong binding', 'missing pin', 'wrong revision'] as const) {
  test(`predecessor readiness is terminal for ${changed}`, () => {
    const s = rig()
    if (changed === 'finished run') s.previous.state = 'settled'
    if (changed === 'declined acceptance') { s.previous.rounds.at(-1).state = 'closed'; s.acceptance.state = 'done'; s.acceptance.outcome = 'declined' }
    if (changed === 'wrong binding') s.previous.lead.contractDigest = 'other'
    if (changed === 'missing pin') s.previous.seatPlans['2'].base = null
    if (changed === 'wrong revision') s.previous.seatPlans['2'].handed[0].at = 'b'.repeat(40)
    assert.deepEqual(leadPredecessorReadiness(s.state, 'second', [s.previous], () => [s.acceptance] as any), { ready: false, terminal: true })
  })
}
