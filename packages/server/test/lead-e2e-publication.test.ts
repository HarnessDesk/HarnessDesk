import assert from 'node:assert/strict'
import test from 'node:test'
import { join } from 'node:path'
import { EvidenceStore } from '../src/evidence/store.js'
import { createLeadRig } from './fixtures/lead-rig.js'

// Every case owns the actual host, child, restricted door, journal and Flow engine.
// These assertions must also hold when guards are deliberately removed locally.
// One of the Lead end-to-end files (publication, repair, external merge and Stop after a settled step); they share only the rig,
// so CI runs them side by side, and the cases of each run one at a time.

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
  // The Flow can open its person round before the child's final worker/gate
  // notifications arrive. Merely seeing the first result is not an observation
  // barrier: those notifications fence it until the child reads the desk again.
  await rig.waitFor(() => rig.host.registry.all().every(record => record.running.size === 0), 'worker turns ended')
  await rig.host.flowsPlane.flush()
  const observedAfter = Date.now(), previousWakes = new Set(rig.journal.state.wakes.map(wake => wake.id))
  rig.service.evidenceChanged()
  await rig.waitFor(() => !rig.service.requestInFlight && rig.journal.state.managementReason === 'lead-result-awaiting-person' &&
    rig.journal.state.wakes.some(wake => !previousWakes.has(wake.id) && !wake.modelTurn && wake.at > observedAfter) &&
    !!rig.pending('result'), 'reviewed result after final worker and person-gate observations')
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
