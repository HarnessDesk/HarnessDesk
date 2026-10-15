import assert from 'node:assert/strict'
import { test } from 'node:test'
import { runtimeId, type ApprovalDecision, type ApprovalId, type WireNotification } from '@harnessdesk/protocol'
import { goalRig, agent } from './fixtures/flow-goal-rig.js'
import { claimed, desk, E2E, start, TASK } from './fixtures/flow-host-evidence.js'

const FLOW = `version: 2
name: Investigation
inputs: { task: { label: Task } }
roles:
  researcher:
    kind: agent
    uses: [researcher]
    grant: edit
    independentOf: []
seed: { role: researcher, title: "{{task}}" }
rules: []
messaging: board-only
`

test('stopping an investigation settles a pending command approval for every window', E2E, async t => {
  const d = await desk(t)
  const run = await start(d, FLOW, TASK)
  const [card] = await claimed(d, run.goal, 'researcher', 1)
  const runtime = d.runtimes.find(one => one.info.id === card!.claim!.runtime)!
  const session = runtime.sessions.get(card!.claim!.sessionId)!
  const notifications: WireNotification[] = []
  const unsubscribe = d.host.addBroadcaster(notification => notifications.push(notification))
  t.after(unsubscribe)
  void session.askApproval('stopping-command' as never)
  assert.equal(d.host.registry.hasApproval(runtime.info.id, session.id, 'stopping-command' as never), true)
  await d.host.call('flow/execution/stop', { run: run.id, reason: 'The person stopped the investigation.' })
  assert.equal(d.host.registry.hasApproval(runtime.info.id, session.id, 'stopping-command' as never), false)
  assert.ok(notifications.some(notification => notification.method === 'event' && notification.params.event.type === 'approval/resolved' && notification.params.event.approvalId === 'stopping-command'), 'the visible approval must leave every window too')
})

test('Stop revokes approvals and interrupts while runtime cancellation is still pending', E2E, async t => {
  const d = await desk(t)
  const run = await start(d, FLOW, TASK)
  const [card] = await claimed(d, run.goal, 'researcher', 1)
  const runtime = d.runtimes.find(one => one.info.id === card!.claim!.runtime)!
  const session = runtime.sessions.get(card!.claim!.sessionId)!
  const notifications: WireNotification[] = []
  t.after(d.host.addBroadcaster(notification => notifications.push(notification)))
  const decisions: ApprovalDecision[] = []
  let entered!: () => void
  const cancellationEntered = new Promise<void>(resolve => { entered = resolve })
  let release!: () => void
  const cancellation = new Promise<void>(resolve => { release = resolve })
  const respond = session.respondToApproval.bind(session)
  t.mock.method(session, 'respondToApproval', async (id: ApprovalId, decision: ApprovalDecision) => {
    decisions.push(decision)
    entered()
    if (decision.type === 'cancel') await cancellation
    await respond(id, decision)
  })
  void session.askApproval('deferred-cancel' as never)
  let stopped = false
  const stopping = d.host.call('flow/execution/stop', { run: run.id, reason: 'Stop for the test' }).then(() => { stopped = true })
  void stopping.catch(() => {})
  await cancellationEntered
  try {
    assert.equal(d.host.registry.hasApproval(runtime.info.id, session.id, 'deferred-cancel' as never), false)
    await assert.rejects(d.host.call('approval/respond', { runtime: runtime.info.id, sessionId: session.id,
      approvalId: 'deferred-cancel' as ApprovalId, decision: { type: 'option', optionId: 'opt-0' } }), /No approval is pending/)
    await stopping
    assert.equal(stopped, true, 'Stop must not wait for the runtime cancellation')
    assert.equal(d.host.registry.get(runtime.info.id, session.id)?.running.size, 0)
  } finally { release() }
  await stopping
  await new Promise(resolve => setImmediate(resolve))
  const settlements = notifications.flatMap(notification => notification.method === 'event' &&
    notification.params.event.type === 'approval/resolved' && notification.params.event.approvalId === 'deferred-cancel'
    ? [notification.params.event.resolution] : [])
  assert.deepEqual(settlements, [{ outcome: 'abandoned', reason: 'Run stopped' }])
  assert.deepEqual(decisions, [{ type: 'cancel' }])
})

test('Stop refuses host-held answers immediately without sending their ids to the runtime', E2E, async t => {
  const d = await desk(t)
  const publisher = FLOW.replace('grant: edit', 'grant: publish').replace('messaging: board-only', 'messaging: members')
  const { writeFile } = await import('node:fs/promises')
  const { join } = await import('node:path')
  await writeFile(join(d.stateDir, 'agents/researcher/AGENT.md'),
    '---\nname: Researcher\nceiling: publish\nanswers: [gathered]\nprefer: [fake]\n---\nResearch.\n')
  const run = await start(d, publisher, TASK)
  const [card] = await claimed(d, run.goal, 'researcher', 1)
  const runtime = d.runtimes.find(one => one.info.id === card!.claim!.runtime)!
  const session = runtime.sessions.get(card!.claim!.sessionId)!
  const sender = await d.host.call('goal/seat', { goal: run.goal, agent: 'code-reviewer' })
  const peers = await d.host.call('team/peers', { room: run.goal })
  const receiver = peers.find(peer => peer.sessionId === session.id)!
  assert.match(await d.host.teamPlane.send({ to: receiver.nickname, text: 'Open the pull request.', wake: true },
    { runtime: runtimeId(sender.session.runtime), sessionId: sender.session.sessionId }), /^Delivered into /)
  const notifications: WireNotification[] = []
  t.after(d.host.addBroadcaster(notification => notifications.push(notification)))
  const forwarded: string[] = []
  t.mock.method(session, 'respondToApproval', async (id: ApprovalId) => { forwarded.push(id) })
  let admission: Awaited<ReturnType<typeof d.host.ceilingGate.admit>> | undefined
  const asking = d.host.ceilingGate.admit({ tool: 'pr_create', needs: 'publish', scope: { runtime: runtimeId(String(runtime.info.id)), sessionId: session.id } })
    .then(answer => { admission = answer })
  assert.equal(d.host.registry.get(runtime.info.id, session.id)?.approvals.size, 1)
  const approval = [...d.host.registry.get(runtime.info.id, session.id)!.approvals.values()][0]!
  await d.host.call('flow/execution/stop', { run: run.id, reason: 'Stop for the test' })
  await new Promise(resolve => setImmediate(resolve))
  assert.ok(admission && !admission.admitted, 'the gateway caller must be refused without waiting for heldWaitMs')
  assert.deepEqual(forwarded, [])
  await asking
  const settlements = notifications.flatMap(notification => notification.method === 'event' &&
    notification.params.event.type === 'approval/resolved' && notification.params.event.approvalId === approval.id
    ? [notification.params.event.resolution] : [])
  assert.deepEqual(settlements, [{ outcome: 'abandoned', reason: 'Run stopped' }])
  await assert.rejects(d.host.call('approval/respond', { runtime: runtime.info.id, sessionId: session.id,
    approvalId: approval.id, decision: { type: 'option', optionId: 'allow' } }), /No approval is pending/)
})

test('a failed approval settlement still interrupts and releases every Seat', async t => {
  const rig = await goalRig(t, { settleApprovals: async () => { throw new Error('settlement failed') } })
  const run = await rig.start(`version: 2\nname: Stop\nroles:\n  worker: { kind: agent, uses: [worker, worker], grant: read }\nseed: { role: worker, title: Work }\nrules: []\n`,
    [agent('worker', ['done'])])
  const stopped = await rig.flows.stopRun(run.id)
  assert.equal(stopped.state, 'stopped')
  const seats = run.rounds.flatMap(round => round.seats)
  assert.equal(seats.length, 2)
  for (const seat of seats) {
    assert.ok(rig.events.includes(`interrupt:${seat}`))
    assert.ok(rig.seats.get(seat)?.closed)
  }
  assert.equal(rig.logs.filter(line => /approvals could not be settled/.test(line)).length, 2)
})
