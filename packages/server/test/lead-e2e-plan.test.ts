import assert from 'node:assert/strict'
import test from 'node:test'
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { LeadPlanner } from '../src/lead/planner.js'
import { LeadRepeats } from '../src/lead/repeats.js'
import { createLeadRig } from './fixtures/lead-rig.js'

// Every case owns the actual host, child, restricted door, journal and Flow engine.
// These assertions must also hold when guards are deliberately removed locally.
// One of the Lead end-to-end files (plans, consent, the provider contract, spend caps, refused proposals, triggers and ordinary chats); they share only the rig,
// so CI runs them side by side, and the cases of each run one at a time.

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

test('one repeat approval runs twice and skips a slot while its first result waits', async t => {
  const rig = await createLeadRig({ repeat: true }); t.after(() => rig.dispose())
  await rig.reviewed()
  let schedule = await rig.host.call('lead/schedule/read', {})
  assert.equal(schedule.tasks.length, 1)
  const task = schedule.tasks[0]!, firstGoal = rig.journal.state.budget!.logicalGoalId, firstDigest = rig.journal.state.contract!.digest
  assert.equal(task.approved!.contractDigest, firstDigest)
  assert.equal(task.runs![0]!.logicalGoalId, firstGoal)
  // Advance only the schedule owner's clock. Real worker timers and consent
  // remain on the host clock; no production timer or provider is replaced.
  const later = new Date(task.lastRunAt!); later.setDate(later.getDate() + 1); later.setHours(10, 0, 0, 0)
  const owner = new LeadRepeats({ planner: new LeadPlanner(rig.home), journal: rig.journal, now: () => later.getTime(),
    async start() { throw new Error('A pending result cannot start another slot') } })
  await owner.tick(); await owner.tick()
  schedule = await rig.host.call('lead/schedule/read', {})
  assert.equal(schedule.tasks[0]!.runs!.filter(run => run.state === 'skipped').length, 1)
  assert.equal(rig.journal.state.budget!.logicalGoalId, firstGoal)
  await assert.rejects(rig.host.call('lead/repeat/control', { taskId: task.id, action: 'run-now' }))
  await rig.decide(rig.pending('result')!, 'accept')
  await rig.waitFor(() => !rig.service.requestInFlight && !rig.journal.state.budget!.requests.length, 'first repeat finishes')
  await rig.host.call('lead/repeat/control', { taskId: task.id, action: 'run-now' })
  await rig.waitFor(() => !!rig.pending('result'), 'second repeat reviewed result without another plan approval')
  assert.notEqual(rig.journal.state.budget!.logicalGoalId, firstGoal)
  assert.notEqual(rig.journal.state.contract!.digest, firstDigest)
  assert.ok(rig.journal.state.steps.every(step => step.id !== 'first' && step.id !== 'second'))
  assert.equal(rig.journal.state.cards.filter(card => card.type === 'plan' && !rig.journal.state.decidedCards.includes(`${card.id}:${card.revision}`)).length, 0)
  schedule = await rig.host.call('lead/schedule/read', {})
  assert.equal(schedule.tasks[0]!.runs!.filter(run => run.state === 'started').length, 2)
  await rig.decide(rig.pending('result')!, 'accept')
  await rig.waitFor(async () => (await rig.host.call('lead/schedule/read', {})).tasks[0]!.runs!.filter(run => run.outcome === 'accepted').length === 2, 'both run results retained')
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

test('the host door refuses an eager real preview when its admitted consent has expired', async t => {
  const rig = await createLeadRig({ holdPlanning: true }); t.after(() => rig.dispose())
  await rig.probeExpiredConsent()
  assert.equal(rig.journal.state.runs.length, 0)
  assert.equal((await rig.workerCalls()).filter(one => one.method === 'turn/start').length, 0)
  await rig.assertNoForbiddenEffects()
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

test('restricted conversational Lead delegates ordinary chats with one runtime and no approved contract', async t => {
  const rig = await createLeadRig({ ordinaryChats: true, waitMs: 30000 }); t.after(() => rig.dispose())
  await rig.sendGoal()
  const results = () => rig.provider.requests.flatMap(request => request.body.messages.flatMap((message: any) => message.content))
    .filter((block: any) => block.type === 'tool_result')
  await rig.waitFor(() => results().some((block: any) => block.tool_use_id === 'ordinary-foreign') || rig.journal.state.phase === 'waiting-for-user', 'ordinary chat tool sequence')
  assert.ok(results().some((block: any) => block.tool_use_id === 'ordinary-foreign'), JSON.stringify({ results: results(), calls: rig.calls.filter(call => call.method.startsWith('lead/chat/')), messages: rig.journal.state.messages, attempts: [...rig.journal.state.attempts.values()] }))
  const byId = (id: string) => results().find((block: any) => block.tool_use_id === id)
  for (const id of ['ordinary-start', 'ordinary-read', 'ordinary-send', 'ordinary-stop']) assert.equal(byId(id)?.is_error, false, JSON.stringify(byId(id)))
  assert.equal(byId('ordinary-foreign')?.is_error, true, 'the actual private door refuses a foreign session')
  const started = JSON.parse(byId('ordinary-start').content)
  assert.match(started.id, /^rig-writer:/)
  assert.equal(started.problem, undefined)
  assert.equal(JSON.parse(byId('ordinary-send').content).queued, true, 'the busy worker receives the ordinary reply queue')
  assert.equal(rig.journal.state.contract, null)
  assert.equal(rig.journal.state.runs.length, 0)
  assert.equal(rig.pending('plan'), undefined)
  assert.equal((await rig.workerCalls()).filter(call => call.method === 'turn/start').length, 1, 'one fake worker actually received the initial prompt')
  assert.ok((await rig.workerCalls()).some(call => call.method === 'turn/interrupt'), 'the ordinary stop reaches the actual worker interrupt path')
  assert.ok(rig.children.length > 0, 'the real restricted Lead child ran')
  assert.ok(rig.calls.filter(call => call.method.startsWith('lead/chat/')).length >= 4)
})

test('ordinary chat continuation stays visibly in flight after the first child result and Stop cancels it', async t => {
  const rig = await createLeadRig({ ordinaryChats: true, holdOrdinaryContinuation: true, waitMs: 30000 }); t.after(() => rig.dispose())
  await rig.sendGoal()
  await rig.waitFor(() => rig.provider.pending && rig.calls.some(call => call.method === 'lead/chat/start'), 'held ordinary continuation')
  const view = await rig.host.call('lead/thread/read', {})
  assert.equal(view.requestInFlight, true, 'a later provider request must keep Stop available after the first service.send result')
  const stopped = await rig.host.call('lead/stop', { expectedRevision: view.revision })
  assert.equal(stopped.requestInFlight, false)
  assert.equal(rig.journal.state.phase, 'stopped')
  await rig.waitFor(() => rig.children.every(child => child.exitCode !== null || child.signalCode !== null), 'ordinary continuation child cancellation')
  assert.equal(rig.provider.requests.length, 2, 'Stop does not schedule another provider continuation')
})
