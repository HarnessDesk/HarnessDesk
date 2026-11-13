import assert from 'node:assert/strict'
import { rm } from 'node:fs/promises'
import { test } from 'node:test'
import { turnId, type AgentEvent, type Session } from '@harnessdesk/protocol'
import { Client, start, stop } from './fixtures/harness.js'
import { tempDir } from './scratch.js'

/**
 * An idle status that only says sub-agents started or stopped working is not
 * a turn ending. The host reads an idle status as "this conversation may have
 * settled" — it drains the queue, tells the Team plane the turn ended, and
 * hands a flow seat its order again — so a flag that toggles while the
 * conversation rests must not do any of that, or a child finishing would start
 * a root turn nobody asked for.
 */
test('an idle status that only toggles subagentsRunning is not read as a turn ending', async (t) => {
  const work = tempDir('hd-idle-subagents-')
  const rig = await start(); const client = await Client.connect(rig.server)
  t.after(async () => { client.close(); await stop(rig); await rm(work, { recursive: true, force: true }) })
  await client.call('workspace/open', { path: work })
  const session = await client.call('session/create', { runtime: 'fake', options: { cwd: work } }) as Session
  const id = String(session.id)

  const ended: string[] = []
  const rearmed: string[] = []
  const team = rig.host.teamPlane
  const onTurnEnded = team.onTurnEnded.bind(team)
  team.onTurnEnded = (runtime, sessionId, turn) => { if (sessionId === id) ended.push(sessionId); return onTurnEnded(runtime, sessionId, turn) }
  const flows = rig.host.flowsPlane
  const reArm = flows.reArm.bind(flows)
  flows.reArm = (runtime, sessionId) => { if (sessionId === id) rearmed.push(sessionId); return reArm(runtime, sessionId) }

  const emit = (event: AgentEvent) => rig.runtime.emit(event)
  const idle = (subagentsRunning?: boolean): AgentEvent =>
    ({ type: 'session/status', sessionId: session.id, status: subagentsRunning ? { type: 'idle', subagentsRunning: true } : { type: 'idle' } })

  // A turn that ends over a sub-agent still working: its end is read once at
  // `turn/completed` and once at the idle that trails it, as before.
  emit({ type: 'turn/started', sessionId: session.id, turn: { id: turnId('root-1'), status: 'inProgress', items: [], startedAt: 1 } })
  emit({ type: 'session/status', sessionId: session.id, status: { type: 'active' } })
  emit({ type: 'turn/completed', sessionId: session.id, turn: { id: turnId('root-1'), status: 'completed', items: [], startedAt: 1 } })
  emit(idle(true))
  const afterTurn = { ended: ended.length, rearmed: rearmed.length }
  assert.ok(afterTurn.ended > 0 && afterTurn.rearmed > 0, 'the real turn end still reaches the Team plane and the flow seat')

  // The sub-agent finishes, another starts and finishes, while the root rests.
  emit(idle(false))
  emit(idle(true))
  emit(idle(false))
  await new Promise((resolve) => setTimeout(resolve, 50))
  assert.equal(ended.length, afterTurn.ended, 'no child transition is told to the Team plane as a turn ending')
  assert.equal(rearmed.length, afterTurn.rearmed, 'no child transition hands a flow seat its order again')

  // A new root turn still ends as one.
  emit({ type: 'turn/started', sessionId: session.id, turn: { id: turnId('root-2'), status: 'inProgress', items: [], startedAt: 2 } })
  emit({ type: 'session/status', sessionId: session.id, status: { type: 'active' } })
  emit({ type: 'turn/completed', sessionId: session.id, turn: { id: turnId('root-2'), status: 'completed', items: [], startedAt: 2 } })
  emit(idle(false))
  assert.ok(ended.length > afterTurn.ended, 'the next turn’s end is read again')
  assert.ok(rearmed.length > afterTurn.rearmed)
})

/**
 * A turn the host saw only as `turn/started` and `turn/completed`, with no
 * `active` status between them, still ends at the idle that trails it, even
 * when that idle carries `subagentsRunning`: the idle before it was the one
 * before the turn, and a turn has ended since.
 */
test('the idle after a turn seen with no active status is a turn ending, even when it says sub-agents still work', async (t) => {
  const work = tempDir('hd-idle-subagents-')
  const rig = await start(); const client = await Client.connect(rig.server)
  t.after(async () => { client.close(); await stop(rig); await rm(work, { recursive: true, force: true }) })
  await client.call('workspace/open', { path: work })
  const session = await client.call('session/create', { runtime: 'fake', options: { cwd: work } }) as Session
  const id = String(session.id)

  const ended: Array<'turn' | 'idle'> = []
  const rearmed: string[] = []
  const team = rig.host.teamPlane
  const onTurnEnded = team.onTurnEnded.bind(team)
  team.onTurnEnded = (runtime, sessionId, turn) => { if (sessionId === id) ended.push(turn === undefined ? 'idle' : 'turn'); return onTurnEnded(runtime, sessionId, turn) }
  const flows = rig.host.flowsPlane
  const reArm = flows.reArm.bind(flows)
  flows.reArm = (runtime, sessionId) => { if (sessionId === id) rearmed.push(sessionId); return reArm(runtime, sessionId) }

  const emit = (event: AgentEvent) => rig.runtime.emit(event)
  emit({ type: 'session/status', sessionId: session.id, status: { type: 'idle' } })
  const before = { ended: ended.length, rearmed: rearmed.length }
  emit({ type: 'turn/started', sessionId: session.id, turn: { id: turnId('root-1'), status: 'inProgress', items: [], startedAt: 1 } })
  emit({ type: 'turn/completed', sessionId: session.id, turn: { id: turnId('root-1'), status: 'completed', items: [], startedAt: 1 } })
  const atCompletion = { ended: ended.length, rearmed: rearmed.length }
  emit({ type: 'session/status', sessionId: session.id, status: { type: 'idle', subagentsRunning: true } })
  await new Promise((resolve) => setTimeout(resolve, 50))
  assert.ok(atCompletion.ended > before.ended, 'turn/completed is read as the turn ending')
  assert.ok(ended.length > atCompletion.ended, 'the trailing idle is read as the turn ending too, as any turn’s is')
  assert.ok(rearmed.length > atCompletion.rearmed, 'and hands a flow seat its order again')

  // Once that idle is handled, the sub-agent finishing is a toggle again.
  const handled = { ended: ended.length, rearmed: rearmed.length }
  emit({ type: 'session/status', sessionId: session.id, status: { type: 'idle' } })
  await new Promise((resolve) => setTimeout(resolve, 50))
  assert.deepEqual({ ended: ended.length, rearmed: rearmed.length }, handled, 'the sub-agent ending is not a turn ending')
})
