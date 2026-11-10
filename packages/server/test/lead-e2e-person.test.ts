import assert from 'node:assert/strict'
import { canBeginLeadGoal } from '@harnessdesk/lead'
import test, { type TestContext } from 'node:test'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { PhoneSim } from '@harnessdesk/phone-link/sim'
import { startPhoneLink } from '../src/phone-link.js'
import { createLeadRig } from './fixtures/lead-rig.js'

const personSurface = async (rig: Awaited<ReturnType<typeof createLeadRig>>, surface: string, t: TestContext) => {
  if (surface === 'window') return (params: any) => rig.host.call('lead/action/perform', params)
  const link = await startPhoneLink(rig.host, rig.logger, { home: rig.home, host: '127.0.0.1', includeLoopback: true, name: 'Test desk' })
  const phone = await PhoneSim.fromCode((await link.control.pairing()).url)
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
// One of the Lead end-to-end files (what a person approves and runs through the window and the phone, and step acceptance); they share only the rig,
// and each CI invocation keeps its files and cases serial, with a wider file deadline.

for (const { surface, hidden } of [{ surface: 'window', hidden: false }, { surface: 'phone', hidden: false }, { surface: 'window', hidden: true }]) test(`${hidden ? 'hidden' : 'visible'} worker approval reaches the ${surface} and no Lead answer frame reaches the worker`, async t => {
  const command = `node -e process.exit(0)${hidden ? '\u0007' : ''}`
  const rig = await createLeadRig({ scenario: 'worker-approval', eager: true, workerApprovalCommand: command }); t.after(() => rig.dispose())
  await rig.sendGoal(); await rig.waitFor(() => !!rig.pending('plan'), 'plan')
  await rig.assertEagerRefused('eager-start')
  await rig.decide(rig.pending('plan')!, 'approve')
  await rig.waitFor(() => rig.windowNotifications.some((one: any) => one.method === 'lead/changed' && one.params.thread?.cards.some((card: any) => card.kind === 'worker-approval')), 'worker approval card')
  const card = (await rig.host.call('lead/thread/read', {})).thread.cards.find(one => one.type === 'waiting')!
  assert.equal(card.type === 'waiting' && card.kind, 'worker-approval')
  // Whole, bounded public commands are shown; control characters keep the request hidden.
  const summary = 'summary' in card ? card.summary : ''
  if (hidden) {
    assert.match(summary, /implementer.*details are hidden/i)
    assert.doesNotMatch(summary, /process\.exit/)
  } else assert.equal(summary, `The implementer wants to run ${command}. Answer on the card.`)
  await assert.rejects(rig.decide(card, 'accept'), { wireCode: 'lead-worker-approval' })
  await rig.eagerApprovalTurn()
  assert.equal((await rig.workerCalls()).filter(one => one.method === 'worker-approval-answer').length, 0)
  const projection = await rig.host.call('lead/thread/read', {}) as any
  const action = projection.personActions.find((one: any) => one.kind === 'worker-approval')
  assert.ok(action, 'person can answer the real worker approval')
  // The phone lists that wait once, in the Lead's thread: the Team says the Lead relays it.
  const relayedTeams = async () => (await rig.host.call('workspace/read', {})).items.filter(item => item.kind === 'team' && item.team?.relayed).map(item => item.id)
  assert.deepEqual(await relayedTeams(), [rig.journal.state.runs.find(run => run.runId === action.runId)!.teamId])
  const perform = await personSurface(rig, surface, t)
  // Commands never offer a goal rule. A hidden request can only be refused here.
  assert.deepEqual(action.choices, hidden ? ['no'] : ['yes-once', 'no'])
  assert.ok(!action.choices.includes('yes-goal'))
  if (hidden) assert.equal(action.details, undefined)
  else {
    const approval = rig.host.registry.all().flatMap(record => [...record.approvals.values()]).find(one => one.type === 'command')
    assert.ok(approval?.type === 'command' && approval.cwd, 'the runtime supplied a working folder')
    assert.equal(action.details, `Command: ${command}\nWorking folder: ${approval.cwd}\nThe worker needs permission before continuing the approved work.`)
  }
  await perform({ id: action.id, contractDigest: rig.journal.state.contract!.digest, choice: hidden ? 'no' : 'yes-once' })
  await rig.waitFor(async () => (await rig.workerCalls()).some(one => one.method === 'worker-approval-answer'), 'person answer reaches worker')
  const answer = (await rig.workerCalls()).find(one => one.method === 'worker-approval-answer')!
  assert.deepEqual(answer.result, { decision: hidden ? 'decline' : 'accept' })
  await rig.waitFor(async () => (await relayedTeams()).length === 0, 'nothing left for the Lead to relay')
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
  const first = rig.journal.state.runs[0]!
  const before = await rig.host.call('evidence/board', { room: first.teamId })
  const rejected = before.cards.flatMap(card => card.facts).find(one => one.record.fact.kind === 'review')!.record
  assert.ok(rejected.fact.kind === 'review')
  assert.equal(rejected.fact.verdict, 'request-changes')
  const completed = new Set<string>()
  await rig.waitFor(async () => {
    const projection = await rig.host.call('lead/thread/read', {}) as any
    for (const check of projection.personActions ?? []) if (check.kind === 'check' && !completed.has(check.id)) {
      completed.add(check.id)
      await perform({ id: check.id, contractDigest: rig.journal.state.contract!.digest, choice: 'run' })
    }
    return rig.latestEvidence?.reviews.some(review => review.verdict === 'approve') === true
  }, 're-review after person checks')
  assert.equal(rig.latestEvidence!.revision, rejected.fact.at, 'person checks trigger review again at the same commit')
  assert.deepEqual(rig.latestEvidence!.reviews.map(review => review.verdict), ['approve'], 'the new review round supersedes the earlier rejection')
  await rig.waitFor(() => !!rig.pending('result') && rig.host.flowsPlane.executionOf(first.runId)!.rounds.at(-1)?.role === 'accept', 'reviewed result after person checks')
  assert.deepEqual(rig.host.flowsPlane.executionOf(first.runId)!.rounds.map(round => round.role), ['implement', 'review', 'review', 'accept'], 'runner trouble never opens a code repair')
  for (const run of rig.journal.state.runs) {
    const evidence = await rig.host.call('evidence/board', { room: run.teamId })
    assert.ok(evidence.cards.flatMap(card => card.facts).some(one => one.record.fact.kind === 'check' && one.record.fact.counted === true))
  }
})

test('a premature step 2 during review is cleanly refused and later starts without a person resume', async t => {
  const rig = await createLeadRig({ premature: true, holdWorkers: true }); t.after(() => rig.dispose())
  await rig.sendGoal(); await rig.waitFor(() => !!rig.pending('plan'), 'plan')
  await rig.decide(rig.pending('plan')!, 'approve')
  await rig.waitFor(() => rig.provider.pending, 'pre-review provider request')
  const held = rig.provider.requests.at(-1)!
  assert.equal(held.delivered, false, 'the provider request stays held while the writer is blocked')
  assert.equal(rig.host.flowsPlane.leadRuns().some(run => run.rounds.at(-1)?.role === 'review'), false)
  await rig.releaseWorkers(['write', 'repair'])
  await rig.waitFor(() => rig.host.flowsPlane.leadRuns().some(run => run.rounds.at(-1)?.role === 'review' && run.rounds.at(-1)?.state === 'running'), 'live review')
  assert.equal(held.delivered, false, 'the pre-review request remains held until review is live')
  await rig.waitFor(() => {
    if (rig.provider.pending) rig.provider.release()
    return [...rig.journal.state.attempts.values()].some(attempt => attempt.stepId === 'second' && attempt.method === 'flow/start-goal' && attempt.outcome !== null)
  }, 'premature start decision')
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
  // The journal's wait is visible before the child retires that request.
  // Match the window's send barrier instead of racing its in-flight guard.
  await rig.waitFor(async () => !(await rig.host.call('lead/thread/read', {})).requestInFlight, 'predecessor refusal turn completes')
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

test('a comment asking to stop ends the goal its thread opened the way Stop does, and the next step never starts', async t => {
  const rig = await createLeadRig({ holdWorkers: true }); t.after(() => rig.dispose())
  await rig.sendGoal(); await rig.waitFor(() => !!rig.pending('plan'), 'plan')
  // The goal as a mention trigger's firing opens it: that firing is its origin.
  await rig.journal.setOrigin({ source: 'issue', event: 'commented', subject: 'acme/widgets#1', url: 'https://github.com/acme/widgets/issues/1' }, 'trigger-firing-1')
  await rig.decide(rig.pending('plan')!, 'approve'); await rig.workerWaiting()
  const owned = [...rig.journal.state.runs]
  assert.equal(owned.length, 1, 'the first step’s Team is working, and the second step waits for it')
  const comment = 'https://github.com/acme/widgets/issues/1#issuecomment-9001'

  assert.deepEqual(await rig.host.stopLeadForThread({ firings: ['firing-2'], comment }), { plan: false, runs: 0 }, 'a thread that did not open the goal stops nothing of it')
  assert.equal(rig.host.flowsPlane.leadRuns().find(one => one.id === owned[0]!.runId)!.state, 'running')

  assert.deepEqual(await rig.host.stopLeadForThread({ firings: ['firing-0', 'firing-1'], comment }), { plan: true, runs: 1 })
  await rig.settle()
  assert.equal(rig.journal.state.phase, 'stopped')
  assert.equal((await rig.host.call('lead/thread/read', {})).thread.state, 'stopped')
  for (const run of owned) assert.equal(rig.host.flowsPlane.leadRuns().find(one => one.id === run.runId)!.state, 'stopped')
  const stops = (await rig.records()).filter(record => record.type === 'stop')
  assert.deepEqual(stops.map(record => (record as { from?: unknown }).from), [{ kind: 'mention', comment }], 'journaled once, as a stop from that comment')

  // Its worker's gate opens, and still nothing more starts: the plan is stopped.
  await rig.releaseWorkers(); await rig.settle()
  assert.deepEqual(rig.journal.state.runs.map(run => run.runId), owned.map(run => run.runId))
  assert.deepEqual(rig.host.flowsPlane.leadRuns().map(one => one.id), owned.map(run => run.runId), 'the second step never starts')
  assert.deepEqual(await rig.host.stopLeadForThread({ firings: ['firing-1'], comment }), { plan: false, runs: 0 }, 'a second ask finds it already stopped')
  await rig.assertNoForbiddenEffects()
})

test('the phone names each Lead Team by its step, refuses a wrap before acceptance, and wraps both once the person accepts', async t => {
  const rig = await createLeadRig(); t.after(() => rig.dispose())
  await rig.reviewed()
  const teams = [...new Set(rig.journal.state.runs.map(run => run.teamId))]
  assert.equal(teams.length, 2)
  const teamItems = async () => (await rig.host.call('workspace/read', {})).items.filter(item => item.kind === 'team' && teams.includes(item.id))
  const before = await teamItems()
  assert.deepEqual(before.map(item => item.team?.step).sort(), ['Review first repair', 'Review second repair'])
  assert.ok(before.every(item => item.by === 'Dex' && item.team?.canWrap === undefined), JSON.stringify(before))
  await assert.rejects(rig.host.call('workspace/team/wrap', { team: teams[0]! }), /Accept the result before wrapping/)
  // The result says how to check it: the commits the checks and the review read.
  const result = rig.pending('result')!
  assert.match(result.type === 'result' ? result.summary : '', /\nHow to verify: run the project's required checks at commits [0-9a-f]{7} and [0-9a-f]{7}\. The review read the same commits\.$/)
  await rig.decide(result, 'accept')
  assert.equal(rig.journal.state.phase, 'accepted')
  await rig.waitFor(async () => (await teamItems()).filter(item => item.team?.canWrap === true).length === 2, 'both Teams wrappable')
  // The next goal starts before the person wraps: the accepted Teams stay the Lead's, named and wrappable.
  // Start it the way a send does: stop the model process first. A live child keeps reading the accepted runs, and a
  // read still open when the new goal is recorded refuses it (#2042).
  await rig.service.stopGoal()
  await rig.waitFor(() => canBeginLeadGoal(rig.journal.state), 'the accepted goal settled')
  await rig.journal.beginGoal('next-goal', Date.now())
  assert.deepEqual(rig.journal.state.teams, [])
  const after = await teamItems()
  assert.deepEqual(after.map(item => item.team?.step).sort(), ['Review first repair', 'Review second repair'])
  assert.ok(after.every(item => item.by === 'Dex' && item.team?.canWrap === true), JSON.stringify(after))
  // Nothing irreversible happened before the person wrapped. Wrapping then removes clean checkouts, as on the desk,
  // and never a branch: every reviewed commit stays reachable.
  await rig.assertNoForbiddenEffects()
  const branches = () => execFileSync('git', ['for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads'], { cwd: rig.project.path, encoding: 'utf8' })
  const kept = branches()
  for (const team of teams) assert.deepEqual(await rig.host.call('workspace/team/wrap', { team }), {})
  for (const team of teams) assert.equal((await rig.host.call('goal/read', { goal: team })).goal.state, 'wrapped')
  assert.deepEqual((await teamItems()).filter(item => item.team?.canWrap), [])
  await assert.rejects(rig.host.call('workspace/team/wrap', { team: teams[0]! }), /not ready to wrap/)
  await assert.rejects(rig.host.call('workspace/team/wrap', { team: 'not-a-lead-team' }), /Wrap this Team on the desk/)
  assert.equal(branches(), kept)
})
