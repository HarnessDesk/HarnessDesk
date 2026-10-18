import assert from 'node:assert/strict'
import { test } from 'node:test'
import { leadReviewedResultSource } from '@harnessdesk/lead'
import { LeadAdmission } from '../src/lead/admission.js'
import { sourceDigest } from '../src/flow-execution.js'
import { executionOf } from '../src/flow-recovery.js'
import { agent, goalRig } from './fixtures/flow-goal-rig.js'

const rig = () => {
  const project = { id: 'demo', path: '/workspace/demo' }, revision = 'a'.repeat(40)
  const assignments = [
    { role: 'implement', agent: 'implementer', seat: { runtime: 'alpha' }, ceiling: 'edit' },
    { role: 'review', agent: 'code-reviewer', seat: { runtime: 'beta' }, ceiling: 'read' },
  ]
  const steps = ['first', 'second'].map(id => ({ id, flow: 'lead-reviewed-result', sourceRevision: 'recipe-1',
    variables: {}, attendance: 'attended', assignments }))
  const state: any = { contract: { digest: 'digest', goal: 'Repair the check', project, steps },
    consent: { contractDigest: 'digest', expiresAt: 1000 }, budget: { logicalGoalId: 'logical' }, phase: 'running',
    steps: [{ id: 'first', state: 'started', attemptId: 'start-first' }, { id: 'second', state: 'admitted', attemptId: 'start-second' }],
    attempts: new Map([['start-second', { id: 'start-second', correlationId: 'start-second', phase: 'started', dispatched: true, method: 'flow/start-goal' }]]),
    runs: [{ runId: 'run-first', teamId: 'team-first', correlationId: 'start-first' }] }
  const previous: any = { id: 'run-first', goal: 'team-first', state: 'running',
    lead: { logicalGoalId: 'logical', contractDigest: 'digest', startId: 'start-first', stepId: 'first' },
    rounds: [{ n: 1, role: 'implement', state: 'closed' }, { n: 2, role: 'review', state: 'closed' }, { n: 3, role: 'accept', state: 'running' }],
    seatPlans: { '1': { base: null, handed: [] }, '2': { base: revision, handed: [{ card: 1, at: revision, cwd: '/workspace/lane-first', branch: 'first' }] } } }
  let binding: any = null, prepared = 0
  const admission = new LeadAdmission({ journal: { get state() { return state } }, project, now: () => 100, nextId: () => 'unused',
    previews: { bindLead(_params: unknown, value: unknown) { binding = value; return true } },
    budgets: { port: { member: async () => true, runs: () => [previous] }, prepared: () => false,
      startBudget: () => ({ stop: null, spend: 'known', reservedUsdMicros: 0 }), prepare() { prepared++ } },
  } as any)
  const params = { root: project.path, source: leadReviewedResultSource, token: 'preview-second', sentence: state.contract.goal,
    vars: {}, attended: true, seats: Object.fromEntries(assignments.map(one => [one.role, [one.seat]])) }
  return { admission, state, previous, params, revision, binding: () => binding, prepared: () => prepared }
}

test('a later Lead step freezes its predecessor reviewed revision as the Flow lane base', async () => {
  const s = rig()
  assert.equal(await s.admission.authorizeStart(s.params), true)
  assert.equal(s.binding().base, s.revision)
  assert.equal(s.prepared(), 1)
})

for (const changed of ['missing run', 'unreviewed', 'missing pin', 'wrong owner', 'wrong revision'] as const) {
  test(`a later Lead step refuses ${changed} instead of starting from the project checkout`, async () => {
    const s = rig()
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
