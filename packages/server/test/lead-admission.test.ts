import assert from 'node:assert/strict'
import { test, type TestContext } from 'node:test'
import { parseClientMessage } from '@harnessdesk/protocol'
import { evaluateLeadAcceptance, leadReviewedResultSource, type LeadAcceptanceEvidence, type LeadAcceptanceResult } from '@harnessdesk/lead'
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


const reviewedRun = async (t: TestContext, acceptance: () => Promise<LeadAcceptanceResult>, head = 'a'.repeat(40), owned = true, canRerunChecks = async () => false) => {
  const { agent, goalRig } = await import('./fixtures/flow-goal-rig.js')
  const rig = await goalRig(t, { executionOptions: { lead: {
    bind: async () => {}, round: async () => {}, gate: async () => ({ ok: true as const }),
    acceptance, canRerunChecks,
  } } })
  rig.providers.set('alpha', 'writer-vendor'); rig.providers.set('beta', 'review-vendor')
  const reviewer = agent('code-reviewer', ['approve', 'request-changes'], 'beta')
  const agents = [agent('implementer', ['committed']), { ...reviewer, definition: { ...reviewer.definition!, ceiling: 'read' as const } }]
  rig.beforeClaim = n => {
    const seat = rig.seats.get(`seat-${n}`)!
    Object.assign(seat.checkout, { head })
    rig.heads.set(seat.checkout.cwd, { at: head, dirty: false })
  }
  const run = await rig.flows.startGoal({ root: '/repo', sentence: 'Verify the repair brief', source: leadReviewedResultSource,
    sourcePath: null, compiled: rig.compile(leadReviewedResultSource, agents), requireHeld: true,
    ...(owned ? { lead: { logicalGoalId: 'logical', contractDigest: 'a'.repeat(64), startId: 'start', stepId: 'work' } } : {}),
    authorization: { sourceDigest: (await import('../src/flow-execution.js')).sourceDigest(leadReviewedResultSource), commandDigest: '', approvedAt: 1, start: 'front-door' },
  })
  const implement = run.rounds[0]!
  await rig.team.complete(implement.cards[0]!, { outcome: 'committed' }, rig.sessionOf(implement.seats[0]!))
  await rig.flows.flush()
  const review = rig.flows.executionOf(run.id)!.rounds.at(-1)!
  assert.equal(review.role, 'review')
  assert.ok(review.seats.length, rig.flows.executionOf(run.id)!.reason ?? 'review must seat')
  return { rig, run, review }
}

const verdict = (assertionId: string, status: LeadAcceptanceResult['assertions'][number]['status'], reason: string | null = null) =>
  ({ assertionId, status, reason, revision: 1, contractRevision: 1, evidence: [] })

test('repair scheduling carries exactly the failed assertions and separate runner errors', async t => {
  const acceptance: LeadAcceptanceResult = { status: 'failed', assertions: [verdict('unit', 'failed', 'Unit check found a defect'),
    verdict('lint', 'passed'), verdict('runner', 'errored')], erroredChecks: ['runner'] }
  const { rig, run, review } = await reviewedRun(t, async () => acceptance)
  await rig.team.complete(review.cards[0]!, { outcome: 'request-changes' }, rig.sessionOf(review.seats[0]!))
  await rig.flows.flush()
  const after = rig.flows.executionOf(run.id)!
  assert.equal(after.state, 'running')
  assert.equal(after.rounds.length, 3)
  const repair = rig.board(run.goal).intents.find(card => card.id === after.rounds[2]!.cards[0])!
  const input = JSON.parse(repair.detail!.split('Repair input: ')[1]!.split('\n')[0]!)
  assert.deepEqual(input, { failed: [{ assertionId: 'unit', reason: 'Unit check found a defect' }], errored: ['runner'] })
  assert.doesNotMatch(repair.detail!, /"assertionId":"lint"/)
  assert.equal([...repair.detail!.matchAll(/Fix only the failed assertions listed/g)].length, 1)
  assert.match(repair.detail!, /After a new commit, run all declared required checks again at that revision/)
})

for (const scenario of ['stale rejection', 'failed check with missing sibling'] as const) test(`a repair opens for ${scenario} even without a complete failed assertion`, async t => {
  const { contract } = await leadRig(t)
  const plan = { ...contract, assertions: [{ id: 'checks', kind: 'check' as const, description: 'Required checks' }, ...contract.assertions] }
  const evidence: LeadAcceptanceEvidence = { project: plan.project, runId: 'run', contractDigest: plan.digest, revision: 'a'.repeat(40),
    observedAt: 100, complete: true, spendComplete: true, findingsComplete: true, findings: [], diffs: [],
    checks: scenario === 'stale rejection' ? [] : [{ assertionId: 'checks', id: 'unit-failed', name: 'Unit tests', revision: 'a'.repeat(40),
      observedAt: 100, complete: false, exit: 1, counted: true, timedOut: false, dirty: false }],
    reviews: [{ assertionId: 'review', id: 'review', revision: 'a'.repeat(40), observedAt: scenario === 'stale rejection' ? 0 : 100,
      complete: false, verdict: 'request-changes', text: 'Fix the missing migration check.' }] }
  const acceptance = evaluateLeadAcceptance(plan, evidence, { now: 100, freshnessMs: 50, revision: 1 })
  assert.equal(acceptance.status, 'unknown')
  assert.equal(acceptance.assertions.some(assertion => assertion.status === 'failed'), false)
  const { rig, run, review } = await reviewedRun(t, async () => acceptance)
  await rig.team.complete(review.cards[0]!, { outcome: 'request-changes', note: 'Fix the missing migration check.' }, rig.sessionOf(review.seats[0]!))
  await rig.flows.flush()
  const after = rig.flows.executionOf(run.id)!
  assert.equal(after.rounds.length, 3)
  assert.equal(after.rounds[2]!.role, 'implement')
  const repair = rig.board(run.goal).intents.find(card => card.id === after.rounds[2]!.cards[0])!
  assert.match(repair.detail!, /"failed":\[\]/)
  assert.match(repair.detail!, /Fix the missing migration check/)
  assert.deepEqual(repair.dependsOn, review.cards)
})

test('an external round opener always returns the new round, even with runner trouble', async t => {
  const result: LeadAcceptanceResult = { status: 'unknown', assertions: [verdict('checks', 'errored')],
    checksCouldNotRun: true, checksToRerun: ['Unit tests'] }
  const { rig, run } = await reviewedRun(t, async () => result)
  const opened = await rig.executions.openRound(run.id, { role: 'implement', title: 'Retry the checks' }, { key: 'runner-trouble', evidence: [] })
  assert.equal(opened.n, 3)
  assert.equal(opened.cause, 'cause:runner-trouble')
  assert.equal(rig.flows.executionOf(run.id)!.rounds.length, 3)
})

test('a hedged approval reopens review on the same commit, then a verified approval reaches acceptance', async t => {
  const { contract: approved } = await leadRig(t)
  const contract = { ...approved, assertions: [...approved.assertions,
    { id: 'checks', kind: 'check' as const, description: 'Required checks' },
    { id: 'findings', kind: 'blocking-findings' as const, description: 'No blockers' }] }
  let observedReview: { id: string; card: number; revision: string; verdict: string } | null = null
  const { rig, run, review } = await reviewedRun(t, async () => {
    assert.ok(observedReview)
    const card = rig.board(run.goal).intents.find(card => card.id === observedReview!.card)!
    return evaluateLeadAcceptance(contract, { project: contract.project, runId: run.id, contractDigest: contract.digest,
      revision: observedReview.revision, observedAt: 100, complete: true, spendComplete: true, findingsComplete: true, findings: [], diffs: [],
      checks: [{ id: 'check', name: 'Unit tests', assertionId: 'checks', revision: observedReview.revision, observedAt: 100,
        exit: 0, counted: true, timedOut: false, dirty: false }],
      reviews: [{ ...observedReview, assertionId: 'review', observedAt: 100, complete: card.state === 'done', text: card.note ?? '' }],
    }, { now: 100, freshnessMs: 50, revision: 1 })
  })
  const reviewAt = async (round: typeof review, note: string) => {
    const scope = rig.sessionOf(round.seats[0]!)
    const candidates = await rig.review.candidates(round.cards[0]!, scope)
    assert.equal(candidates.length, 1)
    assert.equal(candidates[0]!.at, 'a'.repeat(40))
    const record = await rig.review.record({ intent: round.cards[0]!, candidate: candidates[0]!.id, verdict: 'approve' }, scope)
    assert.equal(record.fact.kind, 'review')
    if (record.fact.kind !== 'review') throw new Error('Expected a structured review')
    observedReview = { id: record.id, card: round.cards[0]!, revision: record.fact.at, verdict: record.fact.verdict }
    await rig.team.complete(round.cards[0]!, { outcome: 'approve', note }, scope)
    await rig.flows.flush()
  }
  await reviewAt(review, 'This should work.')
  const again = rig.flows.executionOf(run.id)!.rounds.at(-1)!
  assert.equal(again.n, 3)
  assert.equal(again.role, 'review')
  const card = rig.board(run.goal).intents.find(card => card.id === again.cards[0])!
  assert.match(card.detail!, /Review the same committed revision again, without editing code/)
  assert.equal(rig.flows.executionOf(run.id)!.rounds.filter(round => round.role === 'implement').length, 1)
  await reviewAt(again, 'Verified the checks and committed diff.')
  assert.equal(rig.flows.executionOf(run.id)!.rounds.at(-1)!.role, 'accept')
})


for (const outcome of ['request-changes', 'approve']) test(`an acceptance read error preserves the existing ${outcome} transition`, async t => {
  const { rig, run, review } = await reviewedRun(t, async () => { throw new Error('Synthetic evidence read failed') })
  const scope = rig.sessionOf(review.seats[0]!)
  const candidates = await rig.review.candidates(review.cards[0]!, scope)
  await rig.review.record({ intent: review.cards[0]!, candidate: candidates[0]!.id, verdict: outcome }, scope)
  await rig.team.complete(review.cards[0]!, { outcome }, scope)
  await rig.flows.flush()
  const after = rig.flows.executionOf(run.id)!
  assert.equal(after.state, 'running')
  assert.equal(after.rounds.length, 3)
  assert.equal(after.rounds[2]!.role, outcome === 'approve' ? 'accept' : 'implement')
  assert.ok(rig.logs.some(message => /acceptance evidence/.test(message)))
  if (outcome === 'request-changes') {
    const card = rig.board(run.goal).intents.find(card => card.id === after.rounds[2]!.cards[0])!
    assert.equal([...card.detail!.matchAll(/Fix only the failed assertions listed/g)].length, 1)
    assert.match(card.detail!, /After a new commit, run all declared required checks again at that revision/)
    assert.doesNotMatch(card.detail!, /Re-run only the failed and errored checks/)
  }
})

test('a completed review that only lacks runnable checks holds for the existing check action', async t => {
  const { contract: approved } = await leadRig(t)
  const contract = { ...approved, assertions: [...approved.assertions,
    { id: 'checks', kind: 'check' as const, description: 'Required checks' },
    { id: 'blockers', kind: 'blocking-findings' as const, description: 'No blockers' }] }
  let exit: number | null = null
  const acceptance = () => evaluateLeadAcceptance(contract, { project: contract.project, runId: 'run', contractDigest: contract.digest,
    revision: 'a'.repeat(40), observedAt: 100, complete: true, spendComplete: true, findingsComplete: true, findings: [], diffs: [],
    checks: [{ id: 'timed-out', name: 'Unit tests', assertionId: 'checks', revision: 'a'.repeat(40), observedAt: 100,
      exit, timedOut: exit === null, counted: true, dirty: false }],
    reviews: [{ id: 'request', assertionId: 'review', revision: 'a'.repeat(40), observedAt: 100, complete: true,
      verdict: 'request-changes', text: 'The required check timed out, so I could not verify it.' }],
  }, { now: 100, freshnessMs: 50, revision: 1 })
  const { rig, run, review } = await reviewedRun(t, async () => acceptance(), 'a'.repeat(40), true, async () => true)
  await rig.team.complete(review.cards[0]!, { outcome: 'request-changes' }, rig.sessionOf(review.seats[0]!))
  await rig.flows.flush()
  const after = rig.flows.executionOf(run.id)!
  assert.equal(after.state, 'running')
  assert.equal(after.rounds.length, 2)
  assert.equal(rig.board(run.goal).intents.length, 2)
  assert.equal(after.reason, 'Waiting for the required checks to run again.')
  assert.doesNotMatch(after.reason!, /Assertion verdicts|[{}]/)
  exit = 0
  rig.files.dieWhen = saved => saved.rounds.at(-1)?.n === 3 && saved.rounds.at(-1)?.state === 'opening' && saved.rounds.at(-1)!.cards.length > 0
  await rig.flows.wakeEvidence(run.goal)
  await rig.flows.flush()
  assert.equal(rig.files.dead, true, 'crash after the re-review round is journaled, before its cards are saved')
  await rig.restart()
  await rig.flows.resume()
  await rig.flows.flush()
  const resumed = rig.flows.executionOf(run.id)!
  assert.equal(resumed.state, 'running')
  assert.ok(resumed.rounds.at(-1)!.seats.length, resumed.reason ?? 're-review must seat after recovery')
  assert.equal(rig.seats.get(resumed.rounds.at(-1)!.seats[0]!)!.agent?.id, 'code-reviewer')
  assert.equal(resumed.rounds.at(-1)!.role, 'review', 'after a successful check, revisit the review rather than changing code')
  assert.equal(resumed.rounds.filter(round => round.role === 'implement').length, 1)
})


test('ordinary Flow repairs retain their own brief without Lead instructions', async t => {
  const { rig, run, review } = await reviewedRun(t, async () => ({ status: 'unknown', assertions: [] }), 'a'.repeat(40), false)
  await rig.team.complete(review.cards[0]!, { outcome: 'request-changes' }, rig.sessionOf(review.seats[0]!))
  await rig.flows.flush()
  const last = rig.flows.executionOf(run.id)!.rounds.at(-1)!
  const card = rig.board(run.goal).intents.find(card => card.id === last.cards[0])!
  assert.equal(last.role, 'implement')
  assert.doesNotMatch(card.detail!, /After a new commit, run all declared required checks again/)
  assert.equal([...card.detail!.matchAll(/Fix only the failed assertions listed/g)].length, 1)
})


for (const scenario of ['missing file', 'withheld commands', 'errored check'] as const) test(`runner-trouble routing uses offered checks: ${scenario}`, async t => {
  const { mkdir, writeFile } = await import('node:fs/promises')
  const { join } = await import('node:path')
  const { makeRepo } = await import('./fixtures/evidence-desk.js')
  const { readChecks } = await import('../src/evidence/checks-file.js')
  const { readLeadEvidence } = await import('../src/lead/assembly.js')
  const { LeadPersonActions } = await import('../src/lead/person-actions.js')
  const repo = await makeRepo('lead-actionable-hold-')
  const command = scenario === 'withheld commands' ? 'printf "Authorization: Bearer demo-value"' : 'node unit.mjs'
  if (scenario !== 'missing file') {
    await mkdir(join(repo.dir, '.harnessdesk'))
    await writeFile(join(repo.dir, '.harnessdesk/checks.yml'), `unit: { run: ${JSON.stringify(command)} }\n`)
    await repo.git('add', '.harnessdesk'); await repo.git('commit', '-qm', 'Declare fixture check')
  }
  const head = await repo.git('rev-parse', 'HEAD'), file = await readChecks(repo.dir), owner = await leadRig(t)
  const contract = { ...owner.contract, project: { ...owner.project, path: repo.dir }, assertions: [...owner.contract.assertions,
    { id: 'checks', kind: 'check' as const, description: 'Required checks' }, { id: 'blockers', kind: 'blocking-findings' as const, description: 'No blockers' }] }
  const { rig, run, review } = await reviewedRun(t, async () => {
    const evidence = await readLeadEvidence(journal, run.id, call => host.call(call.method, call.params), () => 100)
    const acceptance = evaluateLeadAcceptance(contract, evidence, { now: 100, freshnessMs: 1000, revision: 1 })
    assert.equal(acceptance.checksCouldNotRun, true)
    return acceptance
  }, head, true, async () => actions.canRerunChecks(run.id))
  const journal = { state: { ...owner.journal.state, contract,
    runs: [{ runId: run.id, teamId: run.goal, correlationId: 'start' }], steps: [{ state: 'started', attemptId: 'start' }] } } as any
  const host = {
    registry: { all: () => [] }, flowsPlane: rig.flows, teamPlane: rig.team,
    call: async (method: string, _params: unknown): Promise<any> => {
      if (method === 'flow/execution') return rig.flows.executionOf(run.id)
      if (method === 'goal/read') return { board: rig.board(run.goal) }
      if (method === 'finding/run') return { embargoed: false, blocking: false }
      assert.equal(method, 'evidence/board')
      return { cards: rig.board(run.goal).intents.map(card => ({ card: card.id, running: [], facts: [
        ...(rig.facts.get(run.goal) ?? []).filter(record => record.card?.id === card.id).map(record => ({ record, freshness: { state: 'fresh' } })),
        ...(card.role === 'implement' && file.digest ? [{ record: { id: 'errored', fact: { kind: 'check', at: head, name: 'unit', run: command,
          digest: file.digest, counted: true, exit: null, timedOut: true } }, freshness: { state: 'fresh' } }] : []),
      ] })) }
    },
  }
  const actions = new LeadPersonActions(journal, host as never, { seats: { all: () => [] } } as never, async () => {})
  const scope = rig.sessionOf(review.seats[0]!), candidates = await rig.review.candidates(review.cards[0]!, scope)
  await rig.review.record({ intent: review.cards[0]!, candidate: candidates[0]!.id, verdict: 'request-changes' }, scope)
  await rig.team.complete(review.cards[0]!, { outcome: 'request-changes', note: 'Could not verify the required checks.' }, scope)
  await rig.flows.flush()
  const after = rig.flows.executionOf(run.id)!, offered = await actions.read()
  if (scenario === 'errored check') {
    assert.equal(after.rounds.length, 2)
    assert.equal(after.reason, 'Waiting for the required checks to run again.')
    assert.deepEqual(offered.map(action => action.kind === 'check' ? action.name : action.kind), ['unit'])
  } else {
    assert.equal(after.rounds.length, 3, 'the repair can fix a missing or unusable checks file')
    assert.equal(after.rounds.at(-1)!.role, 'implement')
    assert.equal(offered.length, 0)
    assert.equal(after.operations.some(op => op.key.startsWith('lead-check-wait:')), false)
  }
})
