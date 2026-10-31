import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { PhoneSim } from '@harnessdesk/phone-link/sim'
import { startPhoneLink } from '../src/phone-link.js'
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

// Every case owns the actual host, child, restricted door, journal and Flow engine.
// These assertions must also hold when guards are deliberately removed locally.
// One of the Lead end-to-end files (what a person approves and runs through the window and the phone, and step acceptance); they share only the rig,
// so CI runs them side by side, and the cases of each run one at a time.

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
