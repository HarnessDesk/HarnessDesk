import assert from 'node:assert/strict'
import { rm } from 'node:fs/promises'
import { test } from 'node:test'

import type { GoalReceipt, GoalView, Session, TeamState, WrapPreview } from '@harnessdesk/protocol'

import { EvidenceStore } from '../src/evidence/store.js'
import { Client, halt, start } from './fixtures/harness.js'
import { tempDir } from './scratch.js'

test('a live compatibility join writes a durable Goal Seat before restart', async () => {
  const work = tempDir('hd-goal-host-work-')
  const harness = await start()
  const client = await Client.connect(harness.server)
  let second: Awaited<ReturnType<typeof start>> | null = null
  let secondClient: Client | null = null
  try {
    await client.call('workspace/open', { path: work })
    const room = await client.call('team/room/create', { root: work, name: 'Finish the probe' }) as TeamState
    const session = await client.call('session/create', { runtime: 'fake', options: { cwd: work } }) as Session
    await client.call('team/room/join', { room: room.id, runtime: 'fake', sessionId: session.id })
    const another = await client.call('session/create', { runtime: 'fake', options: { cwd: work } }) as Session
    await client.call('team/room/join', { room: room.id, runtime: 'fake', sessionId: another.id })
    await client.call('team/post', { room: room.id, text: 'Kick-off.' })
    client.close()
    await halt(harness)
    const evidence = new EvidenceStore(`${harness.stateDir}/evidence`)
    const { lines } = await evidence.read(work, 'seats')
    assert.equal(lines.filter((line) => line.type === 'seat' && line.record.board === room.id).length, 2)
    second = await start({}, harness.stateDir)
    secondClient = await Client.connect(second.server)
    await secondClient.call('workspace/open', { path: work })
    const rooms = await secondClient.call('team/rooms', { root: work }) as readonly TeamState[]
    assert.deepEqual([...rooms[0]!.members].sort(), [`fake\u0000${session.id}`, `fake\u0000${another.id}`].sort())
  } finally {
    client.close()
    await harness.server.close().catch(() => {})
    await harness.host.dispose().catch(() => {})
    secondClient?.close()
    await second?.server.close().catch(() => {})
    await second?.host.dispose().catch(() => {})
    await rm(harness.stateDir, { recursive: true, force: true })
    await rm(work, { recursive: true, force: true })
  }
})

test('Goal create and board mutation route through the real Host and survive restart', async () => {
  const work = tempDir('hd-goal-host-work-')
  const harness = await start()
  const client = await Client.connect(harness.server)
  let second: Awaited<ReturnType<typeof start>> | null = null
  let secondClient: Client | null = null
  try {
    await client.call('workspace/open', { path: work })
    const created = await client.call('goal/create', { root: work, sentence: 'Finish the probe' }) as GoalView
    const card = await client.call('team/add', { room: created.goal.id, title: 'Do the work' }) as { id: number }
    const read = await client.call('goal/read', { goal: created.goal.id }) as GoalView
    assert.deepEqual(read.board.intents.map((intent) => intent.title), ['Do the work'])
    const loose = await client.call('session/create', { runtime: 'fake', options: { cwd: work } }) as Session
    const assigned = await client.call('goal/assign', {
      goal: created.goal.id, card: card.id, session: { runtime: 'fake', sessionId: loose.id },
    }) as { id: string }
    const staffed = await client.call('goal/read', { goal: created.goal.id }) as GoalView
    assert.deepEqual(staffed.members.map((member) => member.id), [assigned.id])
    await client.call('goal/release', { goal: created.goal.id, seat: assigned.id })
    const released = await client.call('goal/read', { goal: created.goal.id }) as GoalView
    assert.deepEqual(released.members, [])
    assert.equal(released.board.intents[0]?.state, 'open')
    client.close()
    await halt(harness)

    second = await start({}, harness.stateDir)
    secondClient = await Client.connect(second.server)
    await secondClient.call('workspace/open', { path: work })
    const listed = await secondClient.call('goal/list', { root: work }) as readonly GoalView[]
    assert.equal(listed[0]?.goal.id, created.goal.id)
    assert.deepEqual(listed[0]?.board.intents.map((intent) => intent.title), ['Do the work'])
  } finally {
    client.close()
    await harness.server.close().catch(() => {})
    await harness.host.dispose().catch(() => {})
    secondClient?.close()
    await second?.server.close().catch(() => {})
    await second?.host.dispose().catch(() => {})
    await rm(harness.stateDir, { recursive: true, force: true })
    await rm(work, { recursive: true, force: true })
  }
})

test('the real Host previews, durably wraps, recovers the receipt, and refuses later board mutation', async () => {
  const work = tempDir('hd-goal-wrap-host-work-')
  const harness = await start()
  const client = await Client.connect(harness.server)
  let second: Awaited<ReturnType<typeof start>> | null = null
  let secondClient: Client | null = null
  try {
    await client.call('workspace/open', { path: work })
    const created = await client.call('goal/create', { root: work, sentence: 'Finish the wrap probe' }) as GoalView
    const loose = await client.call('session/create', { runtime: 'fake', options: { cwd: work } }) as Session
    const choices = { summary: 'Reviewed and complete.', cards: [] }
    const preview = await client.call('goal/preview', { goal: created.goal.id, choices }) as WrapPreview
    const receipt = await client.call('goal/wrap', { goal: created.goal.id, stamp: preview.stamp, choices }) as GoalReceipt
    assert.equal(receipt.summary, choices.summary)
    assert.equal((await client.call('goal/read', { goal: created.goal.id }) as GoalView).goal.state, 'wrapped')
    await assert.rejects(client.call('team/add', { room: created.goal.id, title: 'Too late' }), /read-only|wrapped/)
    const frozen: Array<() => Promise<unknown>> = [
      () => client.call('goal/update', { goal: created.goal.id, revision: 1, sentence: 'Changed' }),
      () => client.call('goal/seat', { goal: created.goal.id, agent: 'fake' }),
      () => client.call('goal/assign', { goal: created.goal.id, card: 1, session: { runtime: 'fake', sessionId: loose.id } }),
      () => client.call('goal/release', { goal: created.goal.id, seat: 'missing' }),
      () => client.call('goal/cite', { goal: created.goal.id, citation: {
        goal: created.goal.id, receipt: receipt.id, project: work, path: 'README.md', at: 'a'.repeat(40),
      } }),
      () => client.call('team/plan', { room: created.goal.id, goal: 'Late plan' }),
      () => client.call('team/wrap', { room: created.goal.id, plan: 1 }),
      () => client.call('team/intent', { room: created.goal.id, id: 1, action: 'done' }),
      () => client.call('team/post', { room: created.goal.id, text: 'late' }),
      () => client.call('team/handout', { room: created.goal.id, template: 'late', recipients: [] }),
      () => client.call('team/messaging', { room: created.goal.id, enabled: false }),
      () => client.call('team/deliver', { room: created.goal.id, entryId: 'missing' }),
      () => client.call('team/room/rename', { room: created.goal.id, name: 'Late rename' }),
      () => client.call('team/room/delete', { room: created.goal.id }),
      () => client.call('team/room/leave', { room: created.goal.id, runtime: 'fake', sessionId: loose.id }),
      () => client.call('team/room/join', { room: created.goal.id, runtime: 'fake', sessionId: loose.id }),
      () => client.call('flow/start', { room: created.goal.id, source: 'name: Late flow' }),
      () => client.call('evidence/check/run', { room: created.goal.id, card: 1, name: 'late' }),
    ]
    for (const attempt of frozen) await assert.rejects(attempt(), /closing|wrapped|read-only/)
    const team = await client.call('team/state', { room: created.goal.id }) as TeamState
    assert.deepEqual(team.intents, [])
    client.close()
    await halt(harness)

    second = await start({}, harness.stateDir)
    secondClient = await Client.connect(second.server)
    const reopened = await secondClient.call('goal/receipt', { goal: created.goal.id }) as GoalReceipt
    assert.deepEqual(reopened, receipt)
  } finally {
    client.close()
    await harness.server.close().catch(() => {})
    await harness.host.dispose().catch(() => {})
    secondClient?.close()
    await second?.server.close().catch(() => {})
    await second?.host.dispose().catch(() => {})
    await rm(harness.stateDir, { recursive: true, force: true })
    await rm(work, { recursive: true, force: true })
  }
})
