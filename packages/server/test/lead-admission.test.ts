import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseClientMessage } from '@harnessdesk/protocol'
import { leadReviewedResultSource } from '@harnessdesk/lead'
import { leadRig } from './fixtures/lead.js'
import { flowMethods } from '../src/methods/flows.js'

for (const changed of ['source', 'token', 'seats', 'vars', 'sentence', 'attendance']) {
  test(`the step 7 hook refuses a substituted ${changed} before effects`, async t => {
    const s = await leadRig(t), params: any = await s.params()
    await s.admit(params)
    if (changed === 'source') params.source = 'version: 2\nname: Unsafe'
    if (changed === 'token') params.token = 'substituted'
    if (changed === 'seats') params.seats.implement[0].model = 'different'
    if (changed === 'vars') params.vars = { extra: 'work' }
    if (changed === 'sentence') params.sentence = 'Another goal'
    if (changed === 'attendance') params.attended = false
    assert.equal(await s.authority.authorize({ id: 1, method: 'flow/start-goal', params }), 'leadStartNotApproved')
    assert.equal(s.rig.events.length, 0)
  })
}

test('host-derived admission journals ownership and the first stable round before worker dispatch', async t => {
  const s = await leadRig(t)
  s.rig.beforeOpen = () => {
    assert.equal(s.journal.state.runs.length, 1)
    assert.equal(s.journal.state.budget!.rounds[0]!.roundId, `${s.journal.state.runs[0]!.runId}:round:1`)
    assert.equal(s.journal.state.budget!.rounds.length, 1)
  }
  const run = await s.start()
  assert.ok(s.rig.events.some(event => event.startsWith('open:')))
  assert.deepEqual(s.admission.readOwned(), [{ goal: run.goal, run: run.id }])
  assert.ok(s.rig.strictAsks.every(Boolean))
  assert.equal(s.rig.flows.leadRuns()[0]!.lead!.contractDigest, s.contract.digest)
})

test('target membership is rechecked between authorization and every start effect', async t => {
  const s = await leadRig(t), params = await s.params()
  await s.admit(params)
  assert.equal(await s.authority.authorize({ id: 1, method: 'flow/start-goal', params }), null)
  s.setMember(false)
  await assert.rejects(flowMethods['flow/start-goal'](s.ctx, params), /lead-start-not-approved/)
  assert.equal(s.admitted(), 0)
  assert.equal(s.rig.events.length, 0)
})

test('unsupported held worker ceilings cannot be admitted', async t => {
  const s = await leadRig(t); s.setHeld(false)
  const params = await s.params()
  await s.admit(params)
  assert.equal(await s.admission.authorizeStart(params), false)
  assert.equal(s.rig.events.length, 0)
})

for (const forbidden of ['merge', 'publish', 'delete']) {
  test(`Lead cannot delegate a forbidden ${forbidden} step through a Flow`, async t => {
    const s = await leadRig(t)
    const source = leadReviewedResultSource.replace('grant: edit', `grant: ${forbidden}`).replace('Implement the approved goal', `Perform ${forbidden}`)
    await assert.rejects(s.admission.preview({ root: s.project.path, source }), /lead-preview-refused/)
    const params = await s.params()
    await s.admit(params)
    assert.equal(await s.admission.authorizeStart({ ...params, source }), false)
    assert.equal(s.rig.events.length, 0)
  })
}


for (const field of ['approved', 'ceiling', 'lead']) {
  test(`the wire rejects caller-supplied ${field} authority`, async t => {
    const s = await leadRig(t), params = await s.params()
    assert.throws(() => parseClientMessage({ id: 1, method: 'flow/start-goal', params: { ...params, [field]: true } }))
    assert.equal(s.rig.events.length, 0)
  })
}

// Exercise the child port, private door hook and real Flow methods on one writer.
import { createLeadJournal, createLeadTools } from '@harnessdesk/lead'
const childTools = (s: Awaited<ReturnType<typeof leadRig>>, params: Awaited<ReturnType<Awaited<ReturnType<typeof leadRig>>['params']>>) => {
  let next = 0
  return createLeadTools({ journal: s.journal, project: s.project, now: () => 100, nextId: () => `child-${++next}`, synchronized: () => true,
    desk: { call: async (method: any, args: any) => {
      const refused = await s.authority.authorize({ id: 1, method, params: args })
      if (refused) throw new Error(refused)
      return (flowMethods as any)[method](s.ctx, args)
    } } as any,
    resolveTool: async () => ({ project: s.project, runId: null, start: s.contract.steps[0]!, stepId: 'work',
      preview: { token: params.token, source: params.source, expiresAt: 1000 },
      context: { desk: s.journal.state.policy!, projectPolicy: null, project: s.project, approved: null, budget: null, now: 100, policyInterpretation: 'idle' } }) })
}

test('shared writer starts through child tools and the door, then reopens coherently', { timeout: 3000 }, async t => {
  const s = await leadRig(t), params = await s.params()
  await s.journal.updateBudget({ version: 1, type: 'tighten', now: 100, caps: { usdMicros: 100_000, rounds: 1 } })
  s.rig.beforeOpen = () => {
    assert.equal(s.journal.state.runs.length, 1)
    assert.equal(s.journal.state.steps[0]!.state, 'admitted', 'in-flight step remains reserved until its result')
    assert.equal(s.journal.state.budget!.rounds[0]!.roundId, `${s.journal.state.runs[0]!.runId}:round:1`)
  }
  const result = await childTools(s, params).execute({ method: 'flow/start-goal', params })
  assert.equal(result.outcome, 'succeeded')
  assert.equal(s.journal.state.steps[0]!.state, 'started')
  assert.equal(s.journal.state.runs.length, 1)
  assert.equal(s.journal.state.runs[0]!.correlationId, 'child-1')
  assert.equal([...s.journal.state.attempts.values()].filter(attempt => attempt.method === 'flow/start-goal' && attempt.dispatched).length, 1)
  assert.equal(s.journal.state.budget!.rounds.length, 1)
  assert.ok(s.rig.events.some(event => event.startsWith('order:')))
  const reopened = await createLeadJournal(s.storage)
  assert.deepEqual(reopened.state, s.journal.state)
})

test('a start with no in-flight journal attempt is refused before prepare', async t => {
  const s = await leadRig(t), params = await s.params()
  let prepares = 0
  t.mock.method(s.budgets, 'prepare', () => { prepares++ })
  assert.equal(await s.authority.authorize({ id: 1, method: 'flow/start-goal', params }), 'leadStartNotApproved')
  assert.equal(prepares, 0)
  assert.equal(s.rig.flows.leadRuns().length, 0)
})

test('two concurrent tokens for one in-flight attempt create exactly one owned run', { timeout: 3000 }, async t => {
  const s = await leadRig(t), a = await s.params(), b = await s.params()
  let refused: string | null = null
  const step = s.contract.steps[0]!
  const result = await s.journal.execute({ id: 'concurrent-start', stepId: step.id,
    request: { method: 'flow/start-goal', params: a, project: s.project, runId: null, start: step },
    context: { desk: s.journal.state.policy!, projectPolicy: null, project: s.project, approved: null, budget: null, now: 100, policyInterpretation: 'idle' } }, async () => {
      const approvals = await Promise.all([a, b].map(params => s.authority.authorize({ id: 1, method: 'flow/start-goal', params })))
      assert.equal(approvals.filter(value => value === null).length, 1)
      refused = approvals.find(value => value !== null) ?? null
      const run = await flowMethods['flow/start-goal'](s.ctx, approvals[0] === null ? a : b)
      return { value: run, identity: { correlationId: 'concurrent-start', runId: run.id, teamId: run.goal } }
    })
  assert.equal(refused, 'leadStartNotApproved')
  assert.equal(result.outcome, 'succeeded')
  assert.equal(s.rig.flows.leadRuns().length, 1)
  assert.equal(s.journal.state.runs.length, 1)
})

test('separate reviewed-result runs keep implementation changes in distinct lanes', async t => {
  const { agent, goalRig } = await import('./fixtures/flow-goal-rig.js')
  const rig = await goalRig(t)
  rig.providers.set('alpha', 'synthetic-writer'); rig.providers.set('beta', 'synthetic-reviewer')
  const agents = [agent('implementer', ['committed']), agent('code-reviewer', ['approve', 'request-changes'], 'beta')]
  const first = await rig.start(leadReviewedResultSource, agents)
  const second = await rig.start(leadReviewedResultSource, agents)
  const firstSeat = rig.seats.get(first.rounds[0]!.seats[0]!)!
  const secondSeat = rig.seats.get(second.rounds[0]!.seats[0]!)!
  assert.notEqual(firstSeat.checkout.cwd, secondSeat.checkout.cwd, 'later approved work must not move the earlier reviewed checkout')
  assert.equal(rig.lanes.size, 2)
  assert.ok([...rig.lanes.values()].every(lane => lane.cwd !== '/repo'))
})

test('a previously admitted start cannot dispatch while the logical goal is following a PR', async t => {
  const s = await leadRig(t), params = await s.params()
  await s.admit(params)
  const state = s.journal.state
  t.mock.getter(s.journal, 'state', () => ({ ...state, phase: 'following' as const }))
  assert.equal(await s.authority.authorize({ id: 1, method: 'flow/start-goal', params }), 'leadStartNotApproved')
  assert.equal(s.rig.events.length, 0)
})

test('an admitted start stays authorized while an automatic worker answer is in flight', async t => {
  const s = await leadRig(t), params = await s.params()
  await s.journal.saveWorkerApproval({ id: 'rule', contractDigest: s.contract.digest, goalStartedSeq: s.journal.state.goalStartedSeq,
    key: { kind: 'tool', tool: 'get_team_status' }, target: 'get_team_status', count: 0 }, () => true, async () => {})
  await s.admit(params)
  await s.journal.useWorkerApproval('rule', () => true, async () => {
    assert.equal(await s.admission.authorizeStart(params), true)
    const attempt = [...s.journal.state.attempts.values()].find(attempt => attempt.method === 'flow/start-goal')!
    await s.budgets.validateStart({ logicalGoalId: 'logical-1', contractDigest: s.contract.digest, stepId: 'work', startId: attempt.correlationId })
  })
  assert.equal(s.journal.state.phase, 'running')
})


test('a stored recipe-1 plan starts and keeps its host guard after recovery', async t => {
  const s = await leadRig(t, 'recipe-1'), run = await s.start()
  await s.observe(0)
  const stored = s.rig.flows.leadRuns().find(one => one.id === run.id)!
  assert.equal(s.contract.steps[0]!.sourceRevision, 'recipe-1')
  assert.deepEqual(await s.budgets.gate(stored), { ok: true })
  await s.rig.restart()
  const recovered = s.rig.flows.leadRuns().find(one => one.id === run.id)!
  assert.equal(recovered.source, stored.source)
  assert.deepEqual(await s.budgets.gate(recovered), { ok: true })
})


for (const failed of [true, false]) test(`repair scheduling carries actual failed assertions and preserves error-only checks (failed=${failed})`, async t => {
  const { agent, goalRig } = await import('./fixtures/flow-goal-rig.js')
  const assertions = [
    { assertionId: 'unit', status: failed ? 'failed' as const : 'passed' as const, reason: failed ? 'Unit check found a defect' : null },
    { assertionId: 'lint', status: 'passed' as const, reason: null },
    { assertionId: 'runner', status: 'errored' as const, reason: 'The check could not produce a verdict' },
  ].map(assertion => ({ ...assertion, revision: 1, contractRevision: 1, evidence: [] }))
  const rig = await goalRig(t, { executionOptions: { lead: {
    bind: async () => {}, round: async () => {}, gate: async () => ({ ok: true as const }),
    acceptance: async () => ({ status: failed ? 'failed' as const : 'unknown' as const, assertions, erroredChecks: ['runner'] }),
  } } })
  rig.providers.set('alpha', 'writer-vendor'); rig.providers.set('beta', 'review-vendor')
  const reviewer = agent('code-reviewer', ['approve', 'request-changes'], 'beta')
  const agents = [agent('implementer', ['committed']), { ...reviewer, definition: { ...reviewer.definition!, ceiling: 'read' as const } }]
  rig.beforeClaim = n => {
    const seat = rig.seats.get(`seat-${n}`)!
    Object.assign(seat.checkout, { head: 'a'.repeat(40) })
    rig.heads.set(seat.checkout.cwd, { at: 'a'.repeat(40), dirty: false })
  }
  const run = await rig.flows.startGoal({ root: '/repo', sentence: 'Verify the repair brief', source: leadReviewedResultSource,
    sourcePath: null, compiled: rig.compile(leadReviewedResultSource, agents), requireHeld: true,
    lead: { logicalGoalId: 'logical', contractDigest: 'a'.repeat(64), startId: 'start', stepId: 'work' },
    authorization: { sourceDigest: (await import('../src/flow-execution.js')).sourceDigest(leadReviewedResultSource), commandDigest: '', approvedAt: 1, start: 'front-door' },
  })
  const implement = run.rounds[0]!
  await rig.team.complete(implement.cards[0]!, { outcome: 'committed' }, rig.sessionOf(implement.seats[0]!))
  await rig.flows.flush()
  const review = rig.flows.executionOf(run.id)!.rounds.at(-1)!
  assert.equal(review.role, 'review')
  assert.ok(review.seats.length, rig.flows.executionOf(run.id)!.reason ?? 'review must seat')
  await rig.team.complete(review.cards[0]!, { outcome: 'request-changes' }, rig.sessionOf(review.seats[0]!))
  await rig.flows.flush()
  const after = rig.flows.executionOf(run.id)!
  assert.equal(after.state, 'running')
  assert.equal(after.rounds.length, failed ? 3 : 2)
  if (failed) {
    const repair = rig.board(run.goal).intents.find(card => card.id === after.rounds[2]!.cards[0])!
    const input = JSON.parse(repair.detail!.split('Repair input: ')[1]!.split('\n')[0]!)
    assert.deepEqual(input, { failed: [{ assertionId: 'unit', reason: 'Unit check found a defect' }], errored: ['runner'] })
    assert.doesNotMatch(repair.detail!, /"assertionId":"lint"/)
  } else {
    assert.equal(rig.board(run.goal).intents.length, 2)
    assert.match(after.reason!, /Re-run these checks; they did not fail, they could not run/)
  }
})
