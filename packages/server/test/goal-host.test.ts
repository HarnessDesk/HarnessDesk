import assert from 'node:assert/strict'
import { rm } from 'node:fs/promises'
import { test } from 'node:test'

import type { GoalView, Session, TeamState } from '@harnessdesk/protocol'

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
