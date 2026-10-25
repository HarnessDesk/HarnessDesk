import assert from 'node:assert/strict'
import test, { describe, type TestContext } from 'node:test'
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { PhoneSim } from '@harnessdesk/phone-link/sim'
import { startPhoneLink } from '../src/phone-link.js'
import { EvidenceStore } from '../src/evidence/store.js'
import { createLeadRig } from './fixtures/lead-rig.js'

const personSurface = async (rig: Awaited<ReturnType<typeof createLeadRig>>, surface: string, t: TestContext) => {
  if (surface === 'window') return (params: any) => rig.host.call('lead/action/perform', params)
  const link = await startPhoneLink(rig.host, rig.logger, { home: rig.home, host: '127.0.0.1', includeLoopback: true, name: 'Test desk' })
  const phone = await PhoneSim.fromCode(link.control.pairing().url)
  t.after(async () => { phone.close(); await link.close() })
  await phone.open(link.service.port, phone.offer!.deskPub)
  await phone.enroll(phone.offer!.enroll, 'Jane’s phone')
  await rig.waitFor(() => link.control.state().pending.length > 0, 'phone enrollment')
  link.control.allow(link.control.state().pending[0]!.id)
  await phone.next(message => message.t === 'enroll.ok')
  return async (params: any) => {
    // Running a required check includes its checkout and process lifetime.
    // Use the same budget as the rig rather than the simulator's 3s read default.
    const id = Math.random().toString(36).slice(2)
    await phone.send({ t: 'req', id, method: 'lead/action/perform', params })
    const reply = await phone.next(message => message.t === 'res' && message.id === id, 240_000)
    assert.equal(reply.ok, true, JSON.stringify(reply))
    return reply.result
  }
}

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

test('a Flow preview token survives provider continuations through an owned start', async t => {
  const rig = await createLeadRig({ holdWorkers: true, manualChecks: true }); t.after(() => rig.dispose())
  await rig.sendGoal(); await rig.waitFor(() => !!rig.pending('plan'), 'plan')
  await rig.decide(rig.pending('plan')!, 'approve')
  const continued = () => rig.provider.requests.some(request => {
    const blocks = request.body.messages.flatMap((turn: any) => turn.content)
    const start = blocks.find((block: any) => block.type === 'tool_use' && block.name === 'flow_start_goal')
    return start && blocks.some((block: any) => block.type === 'tool_result' && block.tool_use_id === start.id && !block.is_error)
  })
  await rig.waitFor(() => continued() || ['waiting-for-user', 'stopped'].includes(rig.journal.state.phase), 'preview-to-start continuation')
  assert.equal(continued(), true, `the provider must receive the successful start result; reason=${rig.journal.state.managementReason}`)
  assert.equal(rig.journal.state.runs.length, 1)
  const blocks = rig.provider.requests.at(-1)!.body.messages.flatMap((turn: any) => turn.content)
  const preview = blocks.find((block: any) => block.type === 'tool_use' && block.name === 'flow_preview')
  const result = blocks.find((block: any) => block.type === 'tool_result' && block.tool_use_id === preview.id)
  const token = JSON.parse(result.content).token
  assert.match(token, /^[0-9a-f-]{36}$/)
  assert.equal(blocks.find((block: any) => block.type === 'tool_use' && block.name === 'flow_start_goal').input.token, token)
  assert.equal((await rig.host.call('flow/execution', { run: rig.journal.state.runs[0]!.runId })).state, 'running')
})

test('the model gets one standing text for the whole goal, the contract in a message after approval, and its words are kept in order', async t => {
  const rig = await createLeadRig(); t.after(() => rig.dispose())
  await rig.sendGoal(); await rig.waitFor(() => !!rig.pending('plan'), 'plan')
  const plan = rig.pending('plan')!
  await rig.decide(plan, 'approve')
  await rig.waitFor(() => !!rig.pending('result'), 'reviewed two-run result')
  const bodies = rig.provider.requests.map(request => request.body)
  assert.ok(bodies.length >= 3, 'the plan, the request after approval and its tool turns')
  // A provider refuses a replayed reasoning block behind a system prompt that changed, so the bytes never change.
  const system: string = bodies[0]!.system
  assert.ok(bodies.every(body => body.system === system), 'one system text from the first request to the last')
  assert.ok(system.includes(rig.project.path), 'it gives the project root')
  for (const seat of ['rig-writer', 'rig-reviewer']) assert.ok(system.includes(seat), `it gives the seat ${seat}`)
  assert.ok(system.includes('"type":"lead-output"'), 'it gives the plan format')
  assert.ok(!system.includes(rig.journal.state.contract!.digest), 'it says nothing about the approved contract, which arrives in a message')
  const approved = bodies[1]!.messages.at(-1)
  assert.equal(approved.role, 'user')
  assert.ok(approved.content.map((block: any) => block.text).join('').includes(`"digest":"${rig.journal.state.contract!.digest}"`), 'the request after approval ends with the contract')
  const intro = rig.journal.state.messages.find(message => message.role === 'assistant' && message.text === 'Review the two-part repair before work starts.')
  assert.ok(intro, 'the sentence that came with the plan is kept as a message')
  assert.ok(intro.revision < rig.journal.state.cardPositions[plan.id]!, 'and it comes before the plan card')
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
  const failed = await rig.decide(card, 'accept').then(() => null, error => error)
  assert.equal(rig.gateSaveFailed, true, 'the injected second-board save must actually refuse')
  assert.equal(failed?.wireCode, 'lead-gate-save-failed')
  assert.notEqual(rig.journal.state.phase, 'accepted')
  assert.equal(rig.journal.state.decidedCards.includes(`${card.id}:${card.revision}`), false)
  assert.equal(rig.personGates().filter(one => one.state === 'done').length, 1)
  await rig.decide(card, 'accept')
  assert.equal(rig.journal.state.phase, 'accepted')
  assert.equal(rig.personGates().filter(one => one.outcome === 'accepted').length, 2)
  await rig.assertAccounting(); await rig.assertNoForbiddenEffects()
})

test('a person who decides after the spend reading has aged out is not refused for stale spend', async t => {
  const rig = await createLeadRig({ freshnessMs: 10_000 }); t.after(() => rig.dispose())
  await rig.reviewed()
  // The workers are quiet now, so nothing on the desk meters them again on its own.
  await new Promise(resolve => setTimeout(resolve, 11_000))
  await rig.decide(rig.pending('result')!, 'accept')
  assert.equal(rig.journal.state.phase, 'accepted')
  await rig.assertNoForbiddenEffects()
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
  if (cap === 'dollars') {
    const call = rig.host.call.bind(rig.host)
    let bump = true
    t.mock.method(rig.host, 'call', async (method: any, params: any) => {
      if (method === 'lead/settings/update' && bump) { bump = false; await rig.journal.settingsChanged() }
      return call(method, params)
    })
  }
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

for (const surface of ['window', 'phone']) test(`worker approval reaches the ${surface} and no Lead answer frame reaches the worker`, async t => {
  const rig = await createLeadRig({ scenario: 'worker-approval', eager: true }); t.after(() => rig.dispose())
  await rig.sendGoal(); await rig.waitFor(() => !!rig.pending('plan'), 'plan')
  await rig.assertEagerRefused('eager-start')
  await rig.decide(rig.pending('plan')!, 'approve')
  await rig.waitFor(() => rig.windowNotifications.some((one: any) => one.method === 'lead/changed' && one.params.thread?.cards.some((card: any) => card.kind === 'worker-approval')), 'worker approval card')
  const card = (await rig.host.call('lead/thread/read', {})).thread.cards.find(one => one.type === 'waiting')!
  assert.equal(card.type === 'waiting' && card.kind, 'worker-approval')
  // A command request is more than the compact card can carry whole, so its details stay on the desk.
  assert.match('summary' in card ? card.summary : '', /implementer.*details are hidden/i)
  assert.doesNotMatch('summary' in card ? card.summary : '', /process\.exit/)
  await assert.rejects(rig.decide(card, 'accept'), { wireCode: 'lead-worker-approval' })
  await rig.eagerApprovalTurn()
  assert.equal((await rig.workerCalls()).filter(one => one.method === 'worker-approval-answer').length, 0)
  const projection = await rig.host.call('lead/thread/read', {}) as any
  const action = projection.personActions.find((one: any) => one.kind === 'worker-approval')
  assert.ok(action, 'person can answer the real worker approval')
  const perform = await personSurface(rig, surface, t)
  // A hidden request is approved on the desk where it is shown whole; the card can only refuse it.
  assert.deepEqual(action.choices, ['no'])
  await perform({ id: action.id, contractDigest: rig.journal.state.contract!.digest, choice: 'no' })
  await rig.waitFor(async () => (await rig.workerCalls()).some(one => one.method === 'worker-approval-answer'), 'person answer reaches worker')
  await rig.assertNoForbiddenEffects()
})

for (const surface of ['window', 'phone']) test(`person runs missing required checks through Lead ${surface} and unlocks the reviewed result`, async t => {
  const rig = await createLeadRig({ manualChecks: true }); t.after(() => rig.dispose())
  await rig.sendGoal(); await rig.waitFor(() => !!rig.pending('plan'), 'plan')
  await rig.decide(rig.pending('plan')!, 'approve'); await rig.releaseWorkers()
  const perform = await personSurface(rig, surface, t)
  let action: any
  await rig.waitFor(async () => {
    const projection = await rig.host.call('lead/thread/read', {}) as any
    action = projection.personActions?.find((one: any) => one.kind === 'check')
    return !!action
  }, 'missing required check action')
  assert.equal(action.name, 'verify'); assert.ok(action.command)
  assert.equal(rig.pending('result'), undefined)
  const completed = new Set<string>()
  await rig.waitFor(async () => {
    const projection = await rig.host.call('lead/thread/read', {}) as any
    for (const check of projection.personActions ?? []) if (check.kind === 'check' && !completed.has(check.id)) {
      completed.add(check.id)
      await perform({ id: check.id, contractDigest: rig.journal.state.contract!.digest, choice: 'run' })
    }
    return !!rig.pending('result')
  }, 'reviewed result after person checks')
  for (const run of rig.journal.state.runs) {
    const evidence = await rig.host.call('evidence/board', { room: run.teamId })
    assert.ok(evidence.cards.flatMap(card => card.facts).some(one => one.record.fact.kind === 'check' && one.record.fact.counted === true))
  }
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
      await rig.waitFor(async () => !(await rig.host.call('lead/thread/read', {})).requestInFlight, 'prior refusal turn completes')
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
  // A message from the person goes on from here. The request it makes ends with the desk's message, which says step 1 has
  // started and step 2 has not, so the model is not told to start step 1 again.
  const before = rig.provider.requests.length
  await rig.host.call('lead/thread/send', { idempotencyKey: 'go-on', text: 'Carry on without step 2.' })
  await rig.waitFor(() => rig.provider.requests.length > before, 'the request that follows the person message')
  const last = rig.provider.requests[before]!.body.messages.at(-1)
  const desk = last.content.map((block: any) => block.text).join('')
  assert.equal(last.role, 'user')
  assert.ok(desk.split('\n').includes('Step states: first started, second pending.'), 'the desk says where each step stands')
  assert.ok(desk.includes(`"digest":"${rig.journal.state.contract!.digest}"`), 'and carries the approved contract')
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
  await rig.waitFor(() => !!rig.host.flowsPlane.leadRuns().find(run => run.id === rig.journal.state.runs[1]!.runId)?.seatPlans?.['1'], 'step 2 first implementer seat plan')
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


test('Stop goal stops only its owned live Flow and leaves worktrees and commits intact', async t => {
  const rig = await createLeadRig({ holdWorkers: true }); t.after(() => rig.dispose())
  await rig.sendGoal(); await rig.waitFor(() => !!rig.pending('plan'), 'plan')
  await rig.decide(rig.pending('plan')!, 'approve'); await rig.workerWaiting()
  const owned = [...rig.journal.state.runs]
  const paths = await rig.worktrees()
  const before = await Promise.all(paths.map(path => readFile(join(path, '.git'), 'utf8')))
  const stopped = await rig.host.call('lead/stop', { expectedRevision: rig.journal.state.seq })
  await rig.settle()
  assert.equal(stopped.thread.state, 'stopped'); assert.equal(stopped.wayOut, null)
  assert.ok(owned.length > 0)
  for (const run of owned) assert.equal(rig.host.flowsPlane.leadRuns().find(one => one.id === run.runId)!.state, 'stopped')
  assert.deepEqual(await rig.worktrees(), paths)
  assert.deepEqual(await Promise.all(paths.map(path => readFile(join(path, '.git'), 'utf8'))), before)
  await rig.assertNoForbiddenEffects()
})


test('Stop goal preserves a settled accepted step and its prepared postings', async t => {
  const rig = await createLeadRig({ acceptedPredecessor: true }); t.after(() => rig.dispose())
  await rig.sendGoal(); await rig.waitFor(() => !!rig.pending('plan'), 'plan')
  await rig.decide(rig.pending('plan')!, 'approve')
  await rig.waitFor(() => rig.journal.state.runs.length === 1 && rig.host.teamPlane.stateFor(rig.journal.state.runs[0]!.teamId).intents.some(intent => intent.role === 'accept' && intent.state === 'open'), 'step 1 acceptance')
  const first = rig.journal.state.runs[0]!
  const acceptance = rig.host.teamPlane.stateFor(first.teamId).intents.find(intent => intent.role === 'accept' && intent.state === 'open')!
  await rig.host.call('team/intent', { room: first.teamId, id: acceptance.id, action: 'done', outcome: 'accepted' })
  await rig.waitFor(() => rig.journal.state.runs.length === 2, 'step 2')
  assert.equal(rig.host.flowsPlane.leadRuns().find(run => run.id === first.runId)!.state, 'settled')
  const postings = structuredClone(rig.host.flowsPlane.publicationOf(first.runId))
  const stop = t.mock.method(rig.host.flowsPlane, 'stopRun')
  await rig.host.call('lead/stop', { expectedRevision: rig.journal.state.seq }); await rig.settle()
  assert.equal(stop.mock.calls.some(call => call.arguments[0] === first.runId), false, 'a settled accepted step must never fire runStopped')
  assert.deepEqual(rig.host.flowsPlane.publicationOf(first.runId), postings)
  assert.equal(rig.host.flowsPlane.leadRuns().find(run => run.id === first.runId)!.state, 'settled')
})

for (const restart of [false, true]) test(`E3/E4 ${restart ? 'across host restart' : 'in one sitting'}: person PR creation, one same-Team repair, green evidence and external merge`, { timeout: 240_000 }, async t => {
  const started = Date.now()
  // Run 40234619739 reached the repair's open acceptance gate, then hit the
  // 60s publication wait at 115–118s overall. Use the rig's 240s wait budget,
  // as the two-run repair walk does; the whole case still has a 240s ceiling.
  const rig = await createLeadRig({ publication: true, offlineForge: true, holdWorkers: true })
  t.after(() => rig.dispose())
  const offline = rig.offline
  assert.ok(offline, 'the rig exposes an offline fake forge and local bare remote')
  await rig.sendGoal(); await rig.waitFor(() => !!rig.pending('plan'), 'plan')
  await rig.decide(rig.pending('plan')!, 'approve'); await rig.releaseWorkers()
  await rig.waitFor(() => !!rig.pending('result'), 'reviewed result')
  await rig.waitFor(() => { const last = rig.host.flowsPlane.leadRuns()[0]?.rounds.at(-1); return last?.role === 'accept' && last.state === 'running' }, 'live person gate')
  await rig.waitFor(() => !!rig.pending('result'), 'stable reviewed result after person gate opens')
  await rig.decide(rig.pending('result')!, 'accept-open-pr')
  t.diagnostic(`initial reviewed PR published after ${Date.now() - started}ms`)
  const initial = structuredClone(rig.journal.state.pr)!, team = rig.journal.state.runs[0]!.teamId
  assert.equal(rig.journal.state.phase, 'following')
  assert.equal((await offline.read()).pulls.length, 1)
  await offline.failChecks(); await offline.poll()
  await rig.waitFor(() => rig.journal.state.handbacks.length === 1, 'same-Team hand-back')
  const operation = rig.journal.state.handbacks[0]!
  assert.equal(operation.teamId, team); assert.equal(operation.runId, rig.journal.state.runs[0]!.runId)
  const repairStarted = Date.now()
  try { await rig.waitFor(() => rig.journal.state.handbacks[0]?.stage === 'awaiting-ci', 'reviewed host push') }
  finally { t.diagnostic(`reviewed host push wait took ${Date.now() - repairStarted}ms; stage=${rig.journal.state.handbacks[0]?.stage}`) }
  if (restart) {
    await rig.interruptAt('host-restart')
    assert.equal(rig.journal.state.handbacks[0]?.stage, 'awaiting-ci', 'restart retains the published head and CI wait')
    assert.equal(rig.journal.state.budget?.stop, null, 'restored fake runtimes retain known spend before recovery')
  }
  const repaired = rig.journal.state.pr!.head
  assert.notEqual(repaired, initial.head)
  await offline.poll()
  assert.equal(rig.journal.state.handbacks.length, 1, 'duplicate polling opens no extra round')
  await offline.passChecks()
  // Supplemental PR reads are budgeted across polls; drive the fake clock
  // until this exact head's green check has actually been observed.
  for (let poll = 0; poll < 8 && rig.journal.state.pr?.check?.state !== 'passed'; poll++) await offline.poll()
  await rig.waitFor(() => !!rig.pending('result'), 'fresh result after green CI')
  const evidence = await new EvidenceStore(join(rig.home, 'evidence')).read(rig.project.path, 'evidence')
  assert.equal(evidence.skipped, 0)
  const green = evidence.lines.flatMap(line => line.type === 'evidence' && line.record.intake?.goal === team && line.record.fact.kind === 'ci' && line.record.fact.at === repaired ? [line.record.fact] : [])
  assert.equal(green.length, 1, 'one durable green CI fact for this Team and published head')
  assert.ok(green[0]!.kind === 'ci' && green[0]!.checks.some(check => check.name === 'CI passed' && check.state === 'passed'))
  await rig.decide(rig.pending('result')!, 'accept')
  assert.equal(rig.journal.state.phase, 'following')
  await offline.mergeExternally(); await offline.poll()
  assert.equal(rig.journal.state.phase, 'accepted'); assert.equal(rig.journal.state.pr?.state, 'merged')
  await rig.assertAccounting(); await rig.assertNoForbiddenEffects()
  assert.equal((await offline.pushes()).length, 2)
})

test('F3: an armed fake project trigger drafts an origin-bearing plan and starts no worker before person approval', { timeout: 180_000 }, async t => {
  const rig = await createLeadRig({ publication: true, offlineForge: true, holdWorkers: true, waitMs: 60_000 })
  t.after(() => rig.dispose())
  const offline = rig.offline
  assert.ok(offline, 'offline project trigger fixture')
  await offline.armTrigger()
  await offline.openPull(); await offline.poll()
  await rig.waitFor(() => !!rig.pending('plan'), 'trigger plan')
  assert.equal(rig.journal.state.origin?.source, 'pull-request')
  assert.equal(rig.journal.state.origin?.url, 'https://github.com/acme/widgets/pull/12')
  assert.equal(rig.journal.state.runs.length, 0)
  assert.equal((await rig.workerCalls()).filter(call => call.method === 'turn/start').length, 0)
  await rig.decide(rig.pending('plan')!, 'approve')
  await rig.waitFor(() => rig.journal.state.runs.length === 1, 'approved worker starts')
  await rig.releaseWorkers(); await rig.waitFor(() => !!rig.pending('result'), 'reviewed trigger result')
  await rig.assertAccounting(); await rig.assertNoForbiddenEffects()
})
