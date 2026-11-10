import assert from 'node:assert/strict'
import test from 'node:test'
import { join } from 'node:path'
import { leadHandbackTerminal } from '@harnessdesk/lead'
import { EvidenceStore } from '../src/evidence/store.js'
import { createLeadRig } from './fixtures/lead-rig.js'

// Every case owns the actual host, child, restricted door, journal and Flow engine.
// These assertions must also hold when guards are deliberately removed locally.
// One of the Lead end-to-end files (publication, repair, external merge and Stop after a settled step); they share only the rig,
// so CI runs them side by side, and the cases of each run one at a time.

type LeadRig = Awaited<ReturnType<typeof createLeadRig>>

const observedResult = async (rig: LeadRig, label: string, recoveredHost: boolean, ready: () => boolean = () => true) => {
  await rig.waitFor(() => ready() && rig.host.registry.all().every(record => record.running.size === 0), `${label}: worker turns ended`)
  await rig.host.flowsPlane.flush()
  const observing = rig.childLive
  assert.ok(observing || recoveredHost, 'the one-sitting case must retain its live child observation fence')
  const observedAfter = Date.now(), previousWakes = new Set(rig.journal.state.wakes.map(wake => wake.id))
  // Recovery restores host-owned repair state without starting a child. With
  // no child there is no delayed child notification, nor a child wake to await.
  if (observing) rig.service.evidenceChanged()
  await rig.waitFor(() => ready() && !rig.service.requestInFlight && rig.journal.state.managementReason === 'lead-result-awaiting-person' &&
    (observing ? rig.journal.state.wakes.some(wake => !previousWakes.has(wake.id) && !wake.modelTurn && wake.at > observedAfter) : !rig.childLive) &&
    !!rig.pending('result'), label)
}

/** Plan, reviewed result and the person's own PR creation, as E3 walks them. */
const publishReviewedResult = async (rig: LeadRig) => {
  await rig.sendGoal(); await rig.waitFor(() => !!rig.pending('plan'), 'plan')
  await rig.decide(rig.pending('plan')!, 'approve'); await rig.releaseWorkers()
  await rig.waitFor(() => !!rig.pending('result'), 'reviewed result')
  await rig.waitFor(() => { const last = rig.host.flowsPlane.leadRuns()[0]?.rounds.at(-1); return last?.role === 'accept' && last.state === 'running' }, 'live person gate')
  // The Flow can open its person round before the child's final worker/gate
  // notifications arrive. Merely seeing the first result is not an observation
  // barrier: those notifications fence it until the child reads the desk again.
  await observedResult(rig, 'reviewed result after final worker and person-gate observations', false)
  await rig.decide(rig.pending('result')!, 'accept-open-pr')
}

for (const restart of [false, true]) test(`E3/E4 ${restart ? 'across host restart' : 'in one sitting'}: person PR creation, one same-Team repair, green evidence and external merge`, { timeout: 240_000 }, async t => {
  const started = Date.now()
  // A healthy walk waits about 10s for any one step, even on CI. A wait as long
  // as the case's own 240s ceiling meant a stalled repair was cut by the runner
  // before the rig could say which state it was stuck in; 120s still leaves a
  // slow step a dozen times its usual time, and a stall names itself.
  const rig = await createLeadRig({ publication: true, offlineForge: true, holdWorkers: true, waitMs: 120_000 })
  t.after(() => rig.dispose())
  const offline = rig.offline
  assert.ok(offline, 'the rig exposes an offline fake forge and local bare remote')
  let recoveredHost = false
  const waitForObservedResult = (label: string, ready?: () => boolean) => observedResult(rig, label, recoveredHost, ready)
  await publishReviewedResult(rig)
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
    recoveredHost = true
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
  const repairReady = () => {
    const state = rig.journal.state, op = state.handbacks.at(-1), pr = state.pr
    return op?.key === operation.key && leadHandbackTerminal(op) && op.publishedHead === repaired && state.ciPassed.includes(repaired) &&
      pr?.head === repaired && pr.check?.head === repaired && pr.check.state === 'passed'
  }
  await rig.waitFor(repairReady, 'terminal hand-back and durable green CI on the repaired head')
  const evidence = await new EvidenceStore(join(rig.home, 'evidence')).read(rig.project.path, 'evidence')
  assert.equal(evidence.skipped, 0)
  const green = evidence.lines.flatMap(line => line.type === 'evidence' && line.record.intake?.goal === team && line.record.fact.kind === 'ci' && line.record.fact.at === repaired ? [line.record.fact] : [])
  assert.equal(green.length, 1, 'one durable green CI fact for this Team and published head')
  assert.ok(green[0]!.kind === 'ci' && green[0]!.checks.some(check => check.name === 'CI passed' && check.state === 'passed'))
  // Green forge state alone does not mean the child consumed the repair's final
  // notifications. Finish that observation before re-reading the pending card.
  await waitForObservedResult('fresh post-green result after final repair observations', repairReady)
  await rig.decide(rig.pending('result')!, 'accept')
  assert.equal(rig.journal.state.phase, 'following')
  await offline.mergeExternally(); await offline.poll()
  assert.equal(rig.journal.state.phase, 'accepted'); assert.equal(rig.journal.state.pr?.state, 'merged')
  await rig.assertAccounting(); await rig.assertNoForbiddenEffects()
  assert.equal((await offline.pushes()).length, 2)
})

test('a Lead request that starts while a repair push is admitted does not park the repair on the person', { timeout: 240_000 }, async t => {
  const rig = await createLeadRig({ publication: true, offlineForge: true, holdWorkers: true, waitMs: 120_000 }); t.after(() => rig.dispose())
  const offline = rig.offline!
  type BudgetEvent = Parameters<typeof rig.journal.updateBudget>[0]
  const reserves: Extract<BudgetEvent, { type: 'reserve' }>[] = [], updateBudget = rig.journal.updateBudget.bind(rig.journal)
  t.mock.method(rig.journal, 'updateBudget', async (event: BudgetEvent, ...rest: [Parameters<typeof updateBudget>[1]?]) => {
    if (event.type === 'reserve') reserves.push(structuredClone(event))
    return updateBudget(event, ...rest)
  })
  await publishReviewedResult(rig)
  // A desk change wakes the Lead's model and starts the repair push alike. Start
  // the Lead's request exactly between pushOwned's two validations: it journals
  // its reservation first, as the child does, and is still out when the second
  // validation reads the budget.
  const ownedPush = rig.journal.ownedPush.bind(rig.journal)
  let reserved = false
  t.mock.method(rig.journal, 'ownedPush', async (operation: Parameters<typeof ownedPush>[0]) => {
    await ownedPush(operation)
    if (operation.stage !== 'prepared' || reserved) return
    reserved = true
    assert.ok(reserves.length, 'the walk made a real Lead request to model this one on')
    await updateBudget({ ...reserves.at(-1)!, requestId: 'lead-request-during-repair-push', now: Date.now() })
  })
  await offline.failChecks(); await offline.poll()
  await rig.waitFor(() => rig.journal.state.handbacks[0]?.stage === 'awaiting-ci' || rig.journal.state.ownedPush?.stage === 'needs-you', 'repair push outcome')
  assert.equal(reserved, true, 'the Lead request started inside the push')
  assert.equal(rig.journal.state.budget!.requests.length, 1, 'and was still out when the push validated')
  assert.equal(rig.journal.state.ownedPush?.stage, 'completed')
  assert.equal(rig.journal.state.handbacks[0]?.stage, 'awaiting-ci')
  assert.notEqual(rig.journal.state.managementReason, 'lead-publication-needs-you')
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
