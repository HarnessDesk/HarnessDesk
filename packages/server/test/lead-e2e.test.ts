import assert from 'node:assert/strict'
import test, { describe } from 'node:test'
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { createLeadRig } from './fixtures/lead-rig.js'

// Every case owns the actual host, child, restricted door, journal and Flow engine.
// These assertions must also hold when guards are deliberately removed locally.
describe('Lead end-to-end', { concurrency: 1 }, () => {
test('plan approval is required before the full fixture starts a worker or Flow', async t => {
  const rig = await createLeadRig(); t.after(() => rig.dispose())
  await rig.sendGoal(); await rig.waitFor(() => rig.pending('plan') !== undefined, 'plan')
  assert.equal(rig.journal.state.runs.length, 0)
  assert.equal((await rig.workerCalls()).filter(one => one.method === 'turn/start').length, 0)
  assert.equal(rig.journal.state.cards.some(one => one.type === 'result'), false)
  await rig.decide(rig.pending('plan')!, 'decline')
  assert.equal((await rig.host.call('flow/executions', { project: rig.project.path })).length, 0)
  assert.equal((await rig.workerCalls()).length, 0, 'declining the plan starts no worker process')
  await rig.assertNoForbiddenEffects()
})

test('two-run reviewed result follows failed review and repair and retries a failed second gate save', async t => {
  const rig = await createLeadRig(); t.after(() => rig.dispose())
  await rig.sendGoal(); await rig.waitFor(() => !!rig.pending('plan'), 'plan')
  await rig.decide(rig.pending('plan')!, 'approve')
  await rig.waitFor(() => !!rig.pending('result'), 'reviewed two-run result')
  const runs = rig.journal.state.runs
  assert.equal(runs.length, 2)
  for (const run of runs) {
    const flow = await rig.host.call('flow/execution', { run: run.runId })
    assert.deepEqual(flow.rounds.map(one => one.role), ['implement', 'review', 'implement', 'review', 'accept'])
  }
  const heads = runs.map(run => {
    const flow = rig.host.flowsPlane.leadRuns().find(one => one.id === run.runId)!
    const review = flow.rounds.filter(one => one.role === 'review').at(-1)!
    const plan = flow.seatPlans![String(review.n)]!
    const checkout = plan.handed[0]!.cwd
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: checkout, encoding: 'utf8' }).trim()
  })
  execFileSync('git', ['merge-base', '--is-ancestor', heads[0]!, heads[1]!], { cwd: rig.project.path })
  for (const [index, run] of runs.entries()) {
    const evidence = await rig.host.call('evidence/board', { room: run.teamId })
    assert.ok(evidence.cards.flatMap(card => card.facts).some(one => one.record.fact.kind === 'review' &&
      one.record.fact.verdict === 'approve' && one.record.fact.at === heads[index] && one.freshness.state === 'fresh'))
  }
  const card = rig.pending('result')!
  rig.failSecondGateSave()
  await assert.rejects(rig.decide(card, 'accept'), { wireCode: 'lead-gate-save-failed' })
  assert.notEqual(rig.journal.state.phase, 'accepted')
  assert.equal(rig.personGates().filter(one => one.state === 'done').length, 1)
  await rig.decide(card, 'accept')
  assert.equal(rig.journal.state.phase, 'accepted')
  assert.equal(rig.personGates().filter(one => one.outcome === 'accepted').length, 2)
  await rig.assertAccounting(); await rig.assertNoForbiddenEffects()
})

test('gate decline preserves both worktrees and committed changes without forbidden effects', async t => {
  const rig = await createLeadRig(); t.after(() => rig.dispose())
  await rig.reviewed()
  const paths = rig.worktrees()
  assert.ok(paths.length >= 2)
  const contents = await Promise.all(paths.map(path => readFile(join(path, 'retry.txt'), 'utf8')))
  await rig.decide(rig.pending('result')!, 'decline')
  assert.equal(rig.journal.state.phase, 'declined')
  assert.deepEqual(await Promise.all(paths.map(path => readFile(join(path, 'retry.txt'), 'utf8'))), contents)
  await rig.assertNoForbiddenEffects()
})

for (const cap of ['dollars', 'rounds', 'unknown'] as const) test(`full fixture stops dispatch at ${cap} equality or unknown spend`, async t => {
  const rig = await createLeadRig({ holdWorkers: true, workerSpend: cap === 'dollars' }); t.after(() => rig.dispose())
  await rig.sendGoal(); await rig.waitFor(() => !!rig.pending('plan'), 'plan')
  await rig.decide(rig.pending('plan')!, 'approve')
  await rig.waitFor(() => rig.journal.state.runs.length > 0, 'first run')
  await rig.workerWaiting()
  await rig.reachCap(cap)
  const before = await rig.dispatchCounts()
  if (cap === 'rounds') await rig.postCapSend()
  if (cap === 'dollars') {
    assert.ok(rig.journal.state.budget!.workerUsdMicros > 0)
    assert.equal(rig.journal.state.budget!.caps.usdMicros, rig.journal.state.budget!.leadUsdMicros + rig.journal.state.budget!.workerUsdMicros)
  }
  await rig.releaseWorkers(); await rig.waitFor(() => !!rig.journal.state.budget!.stop, 'host stops the next round'); await rig.settle()
  assert.deepEqual(await rig.dispatchCounts(), before, 'no extra worker round or provider request past the cap')
  assert.ok(rig.journal.state.budget!.stop)
  await rig.assertAccounting(); await rig.assertNoForbiddenEffects()
})

for (const interruption of ['child-crash', 'host-restart', 'connection-gap'] as const) test(`full fixture ${interruption} during a running paid request preserves approval, caps and accounting`, async t => {
  const rig = await createLeadRig({ holdWorkers: true, holdRunning: true }); t.after(() => rig.dispose())
  await rig.sendGoal(); await rig.waitFor(() => !!rig.pending('plan'), 'plan')
  const plan = rig.pending('plan')!
  await rig.decide(plan, 'approve')
  await rig.waitFor(() => rig.journal.state.runs.length > 0 && rig.provider.pending, 'running Flow with a reserved paid request')
  await rig.workerWaiting()
  await rig.reachCap('rounds')
  const before = await rig.dispatchCounts()
  await rig.interruptAt(interruption)
  rig.provider.release(); await rig.releaseWorkers(); await rig.settle()
  await assert.rejects(rig.decide(plan, 'approve'), 'old plan clicks cannot grant another start')
  await rig.host.call('lead/resume', { expectedRevision: rig.journal.state.seq }).catch(() => {})
  await rig.settle()
  assert.deepEqual(await rig.dispatchCounts(), before, 'recovery cannot pay or dispatch another round at the cap')
  // Recovery removes terminal runs from live ownership; history still proves
  // exactly one real execution and one charged start, with no replacement.
  const executions = await rig.host.call('flow/executions', { project: rig.project.path, active: false })
  assert.equal(executions.length, 1)
  assert.deepEqual(rig.journal.state.budget!.executionIds, [executions[0]!.id])
  assert.equal(rig.journal.state.steps.filter(step => step.state === 'started').length, 1)
  await rig.assertAccounting(); await rig.assertNoForbiddenEffects()
})

test('worker approval reaches the window and no Lead answer frame reaches the worker', async t => {
  const rig = await createLeadRig({ scenario: 'worker-approval', eager: true }); t.after(() => rig.dispose())
  await rig.sendGoal(); await rig.waitFor(() => !!rig.pending('plan'), 'plan')
  await rig.assertEagerRefused('eager-start')
  await rig.decide(rig.pending('plan')!, 'approve')
  await rig.waitFor(() => rig.windowNotifications.some((one: any) => one.method === 'lead/changed' && one.params.thread?.cards.some((card: any) => card.kind === 'worker-approval')), 'worker approval card')
  const card = (await rig.host.call('lead/thread/read', {})).thread.cards.find(one => one.type === 'waiting')!
  assert.equal(card.type === 'waiting' && card.kind, 'worker-approval')
  await assert.rejects(rig.decide(card, 'accept'), { wireCode: 'lead-worker-approval' })
  await rig.eagerApprovalTurn()
  assert.equal((await rig.workerCalls()).filter(one => one.method === 'worker-approval-answer').length, 0)
  await rig.assertNoForbiddenEffects()
})

test('disabled full fixture creates no Lead capability, method, file or child', async t => {
  const rig = await createLeadRig({ enabled: false }); t.after(() => rig.dispose())
  const hello = await rig.host.call('host/hello', { clientVersion: 'test' })
  assert.equal(hello.capabilities?.lead, undefined)
  await assert.rejects(rig.host.call('lead/thread/read', {}))
  assert.deepEqual((await readdir(rig.home)).filter(name => /lead/i.test(name)), [])
  assert.equal(rig.provider.requests.length, 0)
  assert.equal(rig.children.length, 0)
  assert.equal((await rig.host.call('flow/catalog', { root: rig.project.path })).some(one => one.id === 'lead-reviewed-result'), false)
  await rig.assertNoForbiddenEffects()
})


test('full fixture refuses merge, publication, deletion, forge and push proposals without effects', async t => {
  const rig = await createLeadRig({ scenario: 'forbidden' }); t.after(() => rig.dispose())
  await rig.sendGoal(); await rig.waitFor(() => !!rig.pending('plan'), 'plan')
  await rig.decide(rig.pending('plan')!, 'approve')
  for (let attempt = 0; attempt < 5; attempt++) {
    await rig.waitFor(() => rig.journal.state.phase === 'waiting-for-user', 'forbidden proposal refused')
    assert.equal(rig.journal.state.runs.length, 0)
    await rig.assertNoForbiddenEffects()
    if (attempt < 4) {
      const before = rig.provider.requests.length
      await rig.sendGoal()
      await rig.waitFor(() => rig.provider.requests.length > before, 'next forbidden proposal')
    }
  }
  assert.equal((await rig.workerCalls()).length, 0)
  await rig.assertAccounting()
})

test('abrupt host-restart writes off the durable reservation before Resume or a new child', async t => {
  const rig = await createLeadRig({ holdPlanning: true }); t.after(() => rig.dispose())
  await rig.sendGoal(); await rig.waitFor(() => rig.provider.pending, 'durable paid reservation')
  const request = rig.journal.state.budget!.requests[0]!
  const children = rig.children.length
  await rig.abruptRestart()
  assert.equal(rig.children.length, children, 'recovery must not start a child')
  assert.equal(rig.journal.state.budget!.requests.length, 0, 'new host recovers before Resume')
  const charged = rig.journal.state.budget!.settled.find(one => one.id === request.reservation.requestId)
  assert.equal(charged?.digest, 'write-off')
  assert.equal(charged?.usdMicros, Math.ceil(request.reservation.inputTokens * request.reservation.inputUsdMicrosPerMillion / 1_000_000) +
    Math.ceil(request.reservation.maxOutputTokens * request.reservation.outputUsdMicrosPerMillion / 1_000_000))
  await rig.assertAccounting()
})

test('eager scripted model cannot start a Flow before plan consent', async t => {
  const rig = await createLeadRig({ eager: true }); t.after(() => rig.dispose())
  await rig.sendGoal(); await rig.waitFor(() => !!rig.pending('plan'), 'plan after eager refusal')
  await rig.assertEagerRefused('eager-start')
  assert.equal(rig.journal.state.runs.length, 0)
  assert.equal((await rig.workerCalls()).length, 0)
  await rig.assertNoForbiddenEffects()
})


test('a premature step 2 during review is cleanly refused and later starts without a person resume', async t => {
  const rig = await createLeadRig({ premature: true }); t.after(() => rig.dispose())
  await rig.sendGoal(); await rig.waitFor(() => !!rig.pending('plan'), 'plan')
  await rig.decide(rig.pending('plan')!, 'approve')
  await rig.waitFor(() => [...rig.journal.state.attempts.values()].some(attempt => attempt.stepId === 'second' && attempt.method === 'flow/start-goal' && attempt.outcome !== null), 'premature start decision')
  const refused = [...rig.journal.state.attempts.values()].find(attempt => attempt.stepId === 'second' && attempt.method === 'flow/start-goal')!
  assert.equal(refused.outcome, 'denied')
  assert.equal(refused.dispatched, false)
  assert.notEqual(rig.journal.state.phase, 'waiting-for-user')
  await rig.releaseWorkers()
  await rig.waitFor(() => rig.journal.state.runs.length === 2 && [...rig.journal.state.attempts.values()].some(attempt =>
    attempt.stepId === 'second' && attempt.method === 'flow/start-goal' && attempt.outcome === 'succeeded'), 'later successful second start')
  assert.ok([...rig.journal.state.attempts.values()].some(attempt => attempt.stepId === 'second' && attempt.method === 'flow/start-goal' && attempt.outcome === 'succeeded'))
  assert.equal(rig.windowNotifications.some((one: any) => one.method === 'lead/changed' && one.params.thread?.state === 'waiting-for-user'), false)
  await rig.assertNoForbiddenEffects()
})

test('the host door refuses an eager real preview when its admitted consent has expired', async t => {
  const rig = await createLeadRig({ holdPlanning: true }); t.after(() => rig.dispose())
  await rig.probeExpiredConsent()
  assert.equal(rig.journal.state.runs.length, 0)
  assert.equal((await rig.workerCalls()).filter(one => one.method === 'turn/start').length, 0)
  await rig.assertNoForbiddenEffects()
})

})


test('declining step 1 acceptance parks a model retry of step 2 as predecessor unavailable', async t => {
  const rig = await createLeadRig({ declinedPredecessor: true }); t.after(() => rig.dispose())
  await rig.sendGoal(); await rig.waitFor(() => !!rig.pending('plan'), 'plan')
  await rig.decide(rig.pending('plan')!, 'approve')
  await rig.waitFor(() => rig.journal.state.runs.length === 1 && rig.host.teamPlane.stateFor(rig.journal.state.runs[0]!.teamId).intents.some(card => card.role === 'accept' && card.state === 'open'), 'step 1 acceptance')
  const run = rig.journal.state.runs[0]!
  const acceptance = rig.host.teamPlane.stateFor(run.teamId).intents.find(card => card.role === 'accept' && card.state === 'open')!
  await rig.host.call('team/intent', { room: run.teamId, id: acceptance.id, action: 'done', outcome: 'declined' })
  await rig.waitFor(() => rig.journal.state.phase === 'waiting-for-user', 'terminal predecessor wait')
  assert.equal(rig.journal.state.managementReason, 'lead-predecessor-unavailable')
  const retry = [...rig.journal.state.attempts.values()].find(attempt => attempt.stepId === 'second' && attempt.method === 'flow/start-goal')!
  assert.equal(retry.outcome, 'denied'); assert.equal(retry.dispatched, false)
  assert.equal(rig.journal.state.runs.length, 1)
  await rig.assertNoForbiddenEffects()
})


test('accepting step 1 before the model starts step 2 seeds its reviewed revision', async t => {
  const rig = await createLeadRig({ acceptedPredecessor: true }); t.after(() => rig.dispose())
  await rig.sendGoal(); await rig.waitFor(() => !!rig.pending('plan'), 'plan')
  await rig.decide(rig.pending('plan')!, 'approve')
  await rig.waitFor(() => rig.journal.state.runs.length === 1 && rig.host.teamPlane.stateFor(rig.journal.state.runs[0]!.teamId).intents.some(intent => intent.role === 'accept' && intent.state === 'open'), 'step 1 acceptance')
  const first = rig.journal.state.runs[0]!
  const acceptance = rig.host.teamPlane.stateFor(first.teamId).intents.find(intent => intent.role === 'accept' && intent.state === 'open')!
  assert.equal(rig.journal.state.runs.length, 1)
  assert.equal([...rig.journal.state.attempts.values()].some(attempt => attempt.stepId === 'second' && attempt.method === 'flow/start-goal'), false)
  await rig.host.call('team/intent', { room: first.teamId, id: acceptance.id, action: 'done', outcome: 'accepted' })
  await rig.waitFor(() => rig.journal.state.runs.length === 2, 'step 2 after accepted step 1')
  const runs = rig.host.flowsPlane.leadRuns()
  const previous = runs.find(run => run.id === first.runId)!
  assert.equal(previous.state, 'settled')
  const review = previous.rounds.filter(round => round.role === 'review').at(-1)!
  const base = previous.seatPlans![String(review.n)]!.base!
  assert.match(base, /^[a-f0-9]{40,64}$/)
  const next = runs.find(run => run.id === rig.journal.state.runs[1]!.runId)!
  assert.equal(next.lead!.base, base)
  assert.equal(next.seatPlans!['1']!.base, base)
  await rig.assertNoForbiddenEffects()
})
