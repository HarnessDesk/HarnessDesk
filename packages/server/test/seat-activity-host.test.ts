import assert from 'node:assert/strict'
import { rm } from 'node:fs/promises'
import { test } from 'node:test'
import { approvalId, turnId, type GoalView, type Session, type SeatActivity, type SeatRecord } from '@harnessdesk/protocol'
import { Client, start, stop } from './fixtures/harness.js'
import { tempDir } from './scratch.js'

test('the real host derives board claims and reduced agent events, with a fresh baseline and membership cleanup', async (t) => {
  const work = tempDir('hd-seat-activity-')
  const rig = await start(); const client = await Client.connect(rig.server)
  t.after(async () => { client.close(); await stop(rig); await rm(work, { recursive: true, force: true }) })
  await client.call('workspace/open', { path: work })
  const goal = (await client.call('goal/create', { root: work, sentence: 'Observe activity' }) as GoalView).goal.id
  const session = await client.call('session/create', { runtime: 'fake', options: { cwd: work } }) as Session
  const card = await client.call('team/add', { room: goal, title: 'A card' }) as { id: number }
  const assigned = await client.call('goal/assign', { goal, card: card.id, session: { runtime: 'fake', sessionId: session.id } }) as SeatRecord
  const host = rig.host as unknown as { seatActivities?: () => readonly SeatActivity[] }
  assert.equal(typeof host.seatActivities, 'function', 'host exposes unthrottled activity baselines')
  const initial = host.seatActivities!().find((activity) => activity.goal === goal)!
  assert.equal(initial.seat, `fake:${session.id}`)
  assert.equal(initial.card, card.id)
  assert.equal(initial.state, 'working')
  rig.runtime.emit({ type: 'turn/started', sessionId: session.id, turn: { id: turnId('activity-turn'), status: 'inProgress', items: [], startedAt: 12 } })
  const busy = host.seatActivities!().find((activity) => activity.goal === goal)!
  assert.equal(busy.state, 'working')
  assert.equal(busy.since, 12)
  rig.runtime.emit({ type: 'approval/requested', approval: { id: approvalId('activity-question'), sessionId: session.id, type: 'userInput', requestedAt: 13, tool: 'ask', questions: [] } })
  assert.equal(host.seatActivities!()[0]?.state, 'waiting')
  await client.until(() => client.notifications.some((notification) => 'method' in notification && notification.method === 'seat/activity' && notification.params.state === 'waiting'), 4000, 'seat activity to reach the real wire')
  rig.runtime.emit({ type: 'approval/resolved', sessionId: session.id, approvalId: approvalId('activity-question'), resolution: { outcome: 'decided', decision: { type: 'cancel' } } })
  rig.runtime.emit({ type: 'turn/completed', sessionId: session.id, turn: { id: turnId('activity-turn'), status: 'completed', items: [], startedAt: 12 } })
  rig.runtime.emit({ type: 'session/status', sessionId: session.id, status: { type: 'idle' } })
  const snapshots: SeatActivity[] = []
  const unsubscribe = rig.host.addBroadcaster((notification) => {
    if (notification.method === 'team/changed' && notification.params.state.id === goal && !notification.params.state.intents[0]?.claim) snapshots.push(...host.seatActivities!())
  })
  const released = rig.host.teamPlane.intentAction(goal, card.id, 'release')
  assert.equal(host.seatActivities!()[0]?.card, null, 'baseline sees the Team copy before its asynchronous save')
  await released
  await rig.host.teamPlane.flush()
  unsubscribe()
  assert.ok(snapshots.length > 0)
  assert.equal(snapshots[0]?.card, null, 'a board-only change is visible before its save completes')
  assert.equal(snapshots[0]?.state, 'idle')
  await client.call('goal/release', { goal, seat: assigned.id })
  assert.deepEqual(host.seatActivities!(), [])
})

for (const detach of ['health', 'removed'] as const) test(`runtime ${detach} settles pending activity for a Seat with no queued messages`, async (t) => {
  const work = tempDir('hd-seat-detach-'); const rig = await start(); const client = await Client.connect(rig.server)
  t.after(async () => { client.close(); await stop(rig); await rm(work, { recursive: true, force: true }) })
  await client.call('workspace/open', { path: work })
  const goal = (await client.call('goal/create', { root: work, sentence: 'Observe detachment' }) as GoalView).goal.id
  const session = await client.call('session/create', { runtime: 'fake', options: { cwd: work } }) as Session
  const card = await client.call('team/add', { room: goal, title: 'Held card' }) as { id: number }
  await client.call('goal/assign', { goal, card: card.id, session: { runtime: 'fake', sessionId: session.id } })
  rig.runtime.emit({ type: 'turn/started', sessionId: session.id, turn: { id: turnId('detach-turn'), status: 'inProgress', items: [], startedAt: 12 } })
  rig.runtime.emit({ type: 'approval/requested', approval: { id: approvalId('detach-question'), sessionId: session.id, type: 'userInput', requestedAt: 13, tool: 'ask', questions: [] } })
  assert.equal(rig.host.seatActivities()[0]?.state, 'waiting')
  const seen: SeatActivity[] = []
  const unsubscribe = rig.host.addBroadcaster((notification) => { if (notification.method === 'seat/activity') seen.push(notification.params) })
  t.after(unsubscribe)
  if (detach === 'health') rig.runtime.setHealth({ state: 'unavailable', reason: 'unknown', message: 'stopped' })
  else await rig.host.unregister(session.runtime)
  const actual = rig.host.seatActivities()[0]!
  assert.equal(actual.state, 'working', 'a retained claimed card keeps working, without the dead turn or approval')
  assert.deepEqual(actual.doing, { kind: 'thinking' })
  await new Promise((resolve) => setTimeout(resolve, 2700))
  for (const activity of seen) {
    assert.equal(activity.state, actual.state, 'a dead approval must not survive the trailing window')
    assert.deepEqual(activity.doing, actual.doing)
    assert.equal(activity.since, actual.since)
  }
})
