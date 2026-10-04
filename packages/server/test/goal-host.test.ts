import assert from 'node:assert/strict'
import { mkdir, readdir, rm, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { test } from 'node:test'

import { isBusy, type GoalReceipt, type GoalView, type SeatRecord, type Session, type TeamState, type WrapPreview } from '@harnessdesk/protocol'

import { EvidenceStore } from '../src/evidence/store.js'
import { headOf } from '../src/evidence/revision.js'
import { Client, halt, start } from './fixtures/harness.js'
import { makeRepo } from './fixtures/evidence-desk.js'
import { tempDir } from './scratch.js'
import { GoalStore } from '../src/goals/store.js'

/** Waits for a fake-runtime turn this test explicitly finished to actually settle in the host's own registry, before a busy check downstream reads it. */
const settled = async (client: Client, runtime: string, sessionId: string): Promise<void> => {
  const deadline = Date.now() + 5_000
  for (;;) {
    const read = await client.call('session/read', { runtime, sessionId }) as Session
    if (!isBusy(read)) return
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${runtime}/${sessionId} to settle`)
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

test('wrapped Seats retain conversations and refuse send, steer, queued sends, review and compaction; open Seats still dispatch', async (t) => {
  const harness = await start()
  const client = await Client.connect(harness.server)
  let restored: Awaited<ReturnType<typeof start>> | undefined
  let restoredClient: Client | undefined
  let halted = false
  const work = tempDir('hd-wrapped-record-')
  t.after(async () => { restoredClient?.close(); if (restored) await halt(restored); client.close(); if (!halted) await halt(harness); await rm(harness.stateDir, { recursive: true, force: true }); await rm(work, { recursive: true, force: true }) })
  await client.call('workspace/open', { path: work })
  const created = await client.call('goal/create', { root: work, sentence: 'Keep the completed work readable' }) as GoalView
  const card = await client.call('team/add', { room: created.goal.id, title: 'Finish the change' }) as { id: number }
  const conversation = await client.call('session/create', { runtime: 'fake', options: { cwd: work } }) as Session
  const pointer = { runtime: 'fake', sessionId: conversation.id }
  const assigned = await client.call('goal/assign', { goal: created.goal.id, card: card.id, session: pointer }) as SeatRecord
  const input = [{ type: 'text', text: 'Read the change' }]
  await client.call('turn/send', { ...pointer, input })
  await client.call('turn/steer', { ...pointer, input })
  const queued = await client.call('turn/queue', { ...pointer, input }) as { sent: boolean; queuedId: string }
  assert.equal(queued.sent, false)
  await client.call('turn/queue/cancel', { ...pointer, id: queued.queuedId })
  harness.runtime.sessions.get(conversation.id)!.finish()
  await settled(client, 'fake', conversation.id)
  /* Review and compaction put work into a conversation as surely as a send
     does, so they sit behind the same barrier. While the Team is open both
     run — the control the refusals below are measured against. */
  let compacted = 0
  Object.assign(harness.runtime.sessions.get(conversation.id)!, { compact: async () => { compacted += 1 } })
  const inPlace = { ...pointer, target: { type: 'uncommitted' } }
  const onSideThread = { ...pointer, target: { type: 'uncommitted', delivery: 'detached' } }
  const reviewing = [
    ['compaction', 'session/compact', pointer],
    ['review in place', 'session/review', inPlace],
    ['review on a side thread', 'session/review', onSideThread],
  ] as const
  await client.call('session/compact', pointer)
  assert.equal(compacted, 1, 'an open Seat compacts')
  assert.equal(await client.call('session/review', inPlace), null, 'an open Seat reviews in place')
  const side = await client.call('session/review', onSideThread) as Session
  assert.notEqual(side.id, conversation.id, 'an open Seat reviews on a side thread')
  await client.call('team/intent', { room: created.goal.id, id: card.id, action: 'done' })
  const choices = { summary: 'Finished and reviewed.', cards: [{ id: card.id, resolution: 'finished', reason: null }] }
  // Acceptance can precede turn/started by an arbitrarily long round trip.
  // Wrap must see the host's pending send as work, even while the read is idle.
  const live = harness.runtime.sessions.get(conversation.id)!
  const send = live.send.bind(live)
  let release!: () => void
  let entered!: () => void
  const waiting = new Promise<void>(resolve => { release = resolve })
  const started = new Promise<void>(resolve => { entered = resolve })
  const pending = await client.call('goal/preview', { goal: created.goal.id, choices }) as WrapPreview
  live.send = async (...args) => { entered(); await waiting; return send(...args) }
  const dispatch = client.call('turn/send', { ...pointer, input })
  await started
  try {
    await assert.rejects(client.call('goal/wrap', { goal: created.goal.id, stamp: pending.stamp, choices }), /Stop the running work/)
  } finally {
    release()
    await dispatch
    live.send = send
    live.finish()
    await settled(client, 'fake', conversation.id)
  }
  let receipt!: GoalReceipt
  const save = GoalStore.prototype.save
  let staged!: () => void
  let finishStage!: () => void
  const staging = new Promise<void>(resolve => { staged = resolve })
  const stageHeld = new Promise<void>(resolve => { finishStage = resolve })
  GoalStore.prototype.save = async function (...args) {
    if (args[0].goal.id === created.goal.id && args[0].goal.state === 'wrapping') { staged(); await stageHeld }
    return save.apply(this, args)
  }
  const wrapping = (async () => {
    for (let tries = 0; tries < 5; tries++) {
      const preview = await client.call('goal/preview', { goal: created.goal.id, choices }) as WrapPreview
      try { receipt = await client.call('goal/wrap', { goal: created.goal.id, stamp: preview.stamp, choices }) as GoalReceipt; return }
      catch (error) { if (!/changed while you reviewed/.test(String(error))) throw error }
    }
    throw new Error('the settled Team must wrap')
  })()
  try {
    await Promise.race([staging, wrapping.then(() => { throw new Error('Wrap did not stage its receipt') })])
    // Stored state is still open here; the GoalPlane closing barrier owns it.
    await assert.rejects(client.call('turn/send', { ...pointer, input }), /This Team is wrapped/)
  } finally {
    finishStage()
    GoalStore.prototype.save = save
    await wrapping
  }
  assert.ok(receipt, 'the settled Team must wrap')
  await t.test('receipt retains the conversation', () => assert.deepEqual(receipt.members?.find(one => one.seat === assigned.id), { seat: assigned.id, agent: assigned.agent?.name ?? null, seatLabel: assigned.seatLabel, session: pointer }))
  for (const method of ['turn/send', 'turn/steer', 'turn/queue', 'turn/queue/flush'] as const) {
    await t.test(method, async () => assert.rejects(client.call(method, { ...pointer, input }), /This Team is wrapped/, method))
  }
  const threads = harness.runtime.sessions.size
  for (const [name, method, params] of reviewing) {
    await t.test(name, async () => assert.rejects(client.call(method, params), /This Team is wrapped/, method))
  }
  assert.equal(compacted, 1, 'the wrapped conversation was not compacted again')
  assert.equal(harness.runtime.sessions.size, threads, 'the wrapped conversation did not start a review thread')
  const another = await client.call('goal/create', { root: work, sentence: 'Start separate work' }) as GoalView
  const newCard = await client.call('team/add', { room: another.goal.id, title: 'Use a new conversation' }) as { id: number }
  /* Choosing a conversation is not sending to one: the person is inside an open Team, so the sentence is about the
     conversation they chose, not about the Team they are in. */
  await assert.rejects(client.call('goal/assign', { goal: another.goal.id, card: newCard.id, session: pointer }), /That conversation belongs to a wrapped Team/)
  // The durable receipt, not a live membership or handle, owns the refusal. Nothing else is left to say whose
  // conversation this was: the Seat records go too, as on a desk whose evidence folder was lost.
  client.close()
  await halt(harness)
  halted = true
  const evidence = join(harness.stateDir, 'evidence')
  const seatFiles = (await readdir(evidence, { recursive: true })).filter(file => basename(file) === 'seats.ndjson')
  assert.ok(seatFiles.length > 0, 'the rig kept the Team’s Seats on disk, so removing them is a change')
  for (const file of seatFiles) await rm(join(evidence, file))
  restored = await start({}, harness.stateDir)
  restoredClient = await Client.connect(restored.server)
  await restoredClient.call('workspace/open', { path: work })
  assert.equal((await restoredClient.call('session/read', pointer) as Session).id, pointer.sessionId)
  await assert.rejects(restoredClient.call('turn/send', { ...pointer, input }), /This Team is wrapped/)
  for (const [name, method, params] of reviewing) {
    await assert.rejects(restoredClient.call(method, params), /This Team is wrapped/, `${name} after a restart`)
  }
})

/*
 * Whether a conversation belongs to a Team that is wrapped is asked before every send, steer and queued delivery, so
 * it has to cost the same on a desk with three hundred wrapped Teams as on one with three. It was a copy of every
 * Goal document, up to four times a send; it is a lookup in what the store keeps beside its documents, and this
 * counts the documents the store copies while a message goes out so that it cannot become a scan again (#1317).
 */
test('a send copies no Goal document, however many Teams are wrapped, and says no from the same lookup', async (t) => {
  const harness = await start()
  const client = await Client.connect(harness.server)
  const work = tempDir('hd-wrapped-lookup-')
  t.after(async () => { client.close(); await halt(harness); await rm(harness.stateDir, { recursive: true, force: true }); await rm(work, { recursive: true, force: true }) })
  await client.call('workspace/open', { path: work })
  const input = [{ type: 'text', text: 'Read the change' }]
  const conversation = async () => {
    const made = await client.call('session/create', { runtime: 'fake', options: { cwd: work } }) as Session
    return { runtime: 'fake', sessionId: made.id }
  }
  const team = async (sentence: string, wrap: boolean) => {
    const goal = await client.call('goal/create', { root: work, sentence }) as GoalView
    const card = await client.call('team/add', { room: goal.goal.id, title: 'Finish the change' }) as { id: number }
    const pointer = await conversation()
    await client.call('goal/assign', { goal: goal.goal.id, card: card.id, session: pointer })
    if (!wrap) return pointer
    await client.call('team/intent', { room: goal.goal.id, id: card.id, action: 'done' })
    const choices = { summary: 'Finished.', cards: [{ id: card.id, resolution: 'finished', reason: null }] }
    for (let tries = 0; ; tries += 1) {
      const preview = await client.call('goal/preview', { goal: goal.goal.id, choices }) as WrapPreview
      try { await client.call('goal/wrap', { goal: goal.goal.id, stamp: preview.stamp, choices }); return pointer }
      catch (error) { if (tries >= 4 || !/changed while you reviewed/.test(String(error))) throw error }
    }
  }
  const wrapped = [await team('Wrapped one', true), await team('Wrapped two', true), await team('Wrapped three', true)]
  const seated = await team('Still open', false)
  const loose = await conversation()

  /**
   * What the Goal store was asked while `work` ran: how many documents it copied (a `read` copies one, a `list` every
   * one), and how many times it was asked who keeps a conversation.
   */
  const asked = async (work: () => Promise<unknown>): Promise<{ documents: number; lookups: number }> => {
    const { list, read, keptBy } = GoalStore.prototype
    let documents = 0
    let lookups = 0
    GoalStore.prototype.list = function (...args) { const all = list.apply(this, args); documents += all.length; return all }
    GoalStore.prototype.read = function (...args) { documents += 1; return read.apply(this, args) }
    GoalStore.prototype.keptBy = function (...args) { lookups += 1; return keptBy.apply(this, args) }
    try { await work() } finally { Object.assign(GoalStore.prototype, { list, read, keptBy }) }
    return { documents, lookups }
  }
  // One dispatch asks twice — before it reopens the conversation and after, when a wrap may have landed — and no more.
  const dispatch = { documents: 0, lookups: 2 }

  assert.deepEqual(await asked(() => client.call('turn/send', { ...loose, input })), dispatch, 'a send to a conversation no Team keeps')
  assert.deepEqual(await asked(() => client.call('turn/send', { ...seated, input })), dispatch, 'a send to a Seat of a Team that is still open')
  for (const [index, pointer] of wrapped.entries()) {
    const refusal = await asked(() => assert.rejects(client.call('turn/send', { ...pointer, input }), /This Team is wrapped/))
    assert.deepEqual(refusal, { documents: 0, lookups: 1 }, `the refusal for wrapped Team ${index + 1} comes from the first lookup`)
  }
  for (const method of ['turn/steer', 'turn/queue', 'turn/queue/flush'] as const) {
    const refusal = await asked(() => assert.rejects(client.call(method, { ...wrapped[0], input }), /This Team is wrapped/))
    assert.deepEqual(refusal, { documents: 0, lookups: 1 }, `${method} on a wrapped conversation`)
  }
})

test('Goal Agent seating preserves the held ceiling through the host adapter', async (t) => {
  const work = tempDir('hd-goal-held-seat-work-')
  const harness = await start()
  const client = await Client.connect(harness.server)
  t.after(async () => {
    client.close()
    await harness.server.close().catch(() => {})
    await harness.host.dispose().catch(() => {})
    await rm(harness.stateDir, { recursive: true, force: true })
    await rm(work, { recursive: true, force: true })
  })
  await mkdir(`${harness.stateDir}/agents/reviewer`, { recursive: true })
  await writeFile(`${harness.stateDir}/agents/reviewer/AGENT.md`, [
    '---', 'name: Reviewer', 'ceiling: read', 'prefer: [fake]', '---', 'Read the diff.', '',
  ].join('\n'), 'utf8')
  await client.call('workspace/open', { path: work })
  const goal = await client.call('goal/create', { root: work, sentence: 'Review the compatibility seam' }) as GoalView

  const seat = await client.call('goal/seat', {
    goal: goal.goal.id, agent: 'reviewer', grant: { kind: 'ceiling', level: 'merge' },
  }) as { id: string; session: { runtime: string; sessionId: string }; standing: { kind: string; level?: string }; ceiling: { level: string; hold: string } | null }

  assert.deepEqual(seat.standing, { kind: 'ceiling', level: 'read' })
  assert.deepEqual(seat.ceiling, { level: 'read', hold: 'asked' })
  const held = harness.host.registry.get(seat.session.runtime as never, seat.session.sessionId as never)
  assert.deepEqual(held?.seatedAs?.ceiling, seat.ceiling)
})

test('a conversation already claiming an Agent identity may be adopted into a Goal card only while this process observed its attachment loading', async (t) => {
  const work = tempDir('hd-goal-assign-attachments-work-')
  const harness = await start()
  const client = await Client.connect(harness.server)
  t.after(async () => {
    client.close()
    await harness.server.close().catch(() => {})
    await harness.host.dispose().catch(() => {})
    await rm(harness.stateDir, { recursive: true, force: true })
    await rm(work, { recursive: true, force: true })
  })
  await mkdir(`${harness.stateDir}/agents/reviewer`, { recursive: true })
  await writeFile(`${harness.stateDir}/agents/reviewer/AGENT.md`, [
    '---', 'name: Reviewer', 'ceiling: read', 'prefer: [fake]', '---', 'Read the diff.', '',
  ].join('\n'), 'utf8')
  await client.call('workspace/open', { path: work })

  // A standalone Agent seat (no board yet): `seatAgent`'s own transaction ran
  // for this exact live conversation, so its attachment loading is recorded.
  const first = await client.call('agent/seat', { id: 'reviewer', cwd: work, permission: 'read' }) as Session
  // The brief order is a turn, and `goal/assign` refuses a busy conversation;
  // the fake runtime completes a turn only when a test tells it to.
  harness.runtime.sessions.get(first.id)?.finish()
  await settled(client, first.runtime, first.id)
  assert.notEqual(
    harness.host.registry.attachmentSeatOf(first.runtime as never, first.id as never),
    null,
    'seatAgent must have recorded this live conversation’s attachment Seat',
  )
  const goal = await client.call('goal/create', { root: work, sentence: 'Adopt an observed reviewer conversation' }) as GoalView
  const card = await client.call('team/add', { room: goal.goal.id, title: 'Take the reviewer seat' }) as { id: number }
  const assigned = await client.call('goal/assign', {
    goal: goal.goal.id, card: card.id, session: { runtime: first.runtime, sessionId: first.id },
  }) as SeatRecord
  assert.equal(assigned.agent?.id, 'reviewer', 'an observed Agent identity may be adopted into a card')

  // A second standalone Agent seat, this time with its recorded attachment
  // Seat cleared — standing in for a fresh registry record that never went
  // through `seatAgent` here (e.g. a restart before reconnect/resume ran it
  // again). It still claims the "reviewer" identity, so its opaque native
  // load set must not silently stand in for what that Agent approved.
  const second = await client.call('agent/seat', { id: 'reviewer', cwd: work, permission: 'read' }) as Session
  harness.runtime.sessions.get(second.id)?.finish()
  await settled(client, second.runtime, second.id)
  const record = harness.host.registry.get(second.runtime as never, second.id as never)
  assert.ok(record, 'the freshly seated conversation must be live in the registry')
  record.attachmentSeat = null
  const secondGoal = await client.call('goal/create', { root: work, sentence: 'Refuse an unobserved reviewer conversation' }) as GoalView
  const secondCard = await client.call('team/add', { room: secondGoal.goal.id, title: 'Take the unobserved seat' }) as { id: number }
  await assert.rejects(
    client.call('goal/assign', { goal: secondGoal.goal.id, card: secondCard.id, session: { runtime: second.runtime, sessionId: second.id } }),
    /Start a new Seat/,
  )
})

test('live Goal assignments write durable Seats before restart', async () => {
  const work = tempDir('hd-goal-host-work-')
  const harness = await start()
  const client = await Client.connect(harness.server)
  let second: Awaited<ReturnType<typeof start>> | null = null
  let secondClient: Client | null = null
  try {
    await client.call('workspace/open', { path: work })
    const goal = await client.call('goal/create', { root: work, sentence: 'Finish the probe' }) as GoalView
    const session = await client.call('session/create', { runtime: 'fake', options: { cwd: work } }) as Session
    const first = await client.call('team/add', { room: goal.goal.id, title: 'First probe' }) as { id: number }
    await client.call('goal/assign', { goal: goal.goal.id, card: first.id, session: { runtime: 'fake', sessionId: session.id } })
    const another = await client.call('session/create', { runtime: 'fake', options: { cwd: work } }) as Session
    const secondCard = await client.call('team/add', { room: goal.goal.id, title: 'Second probe' }) as { id: number }
    await client.call('goal/assign', { goal: goal.goal.id, card: secondCard.id, session: { runtime: 'fake', sessionId: another.id } })
    await client.call('team/post', { room: goal.goal.id, text: 'Kick-off.' })
    client.close()
    await halt(harness)
    const evidence = new EvidenceStore(`${harness.stateDir}/evidence`)
    const { lines } = await evidence.read(work, 'seats')
    assert.equal(lines.filter((line) => line.type === 'seat' && line.record.board === goal.goal.id).length, 2)
    second = await start({}, harness.stateDir, harness.runtime)
    secondClient = await Client.connect(second.server)
    await secondClient.call('workspace/open', { path: work })
    await secondClient.call('turn/send', { runtime: 'fake', sessionId: session.id, input: [{ type: 'text', text: 'Continue the open work after restart' }] })
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

/*
 * Review round 2 on #1042: a Goal Seat's own release is the one place a
 * card's claim clears through `GoalPlane` rather than `Team#patchIntent`
 * directly, and it recorded nothing — `recoverOperation` closed the Seat
 * before anything read where its checkout stood, and the read that finally
 * ran afterwards found nothing to read. Worse, had that read ever found a
 * checkout, recording it would have deadlocked: it saved through the same
 * Goal queue `release` was still holding. Goes through the real Host, a real
 * git checkout and the wire's own `goal/assign` → `goal/release` →
 * `goal/read`, exactly as the round's own probe did — a stub can't see
 * either bug, since a stub never has a real checkout to fail to read.
 */
test('a Goal Seat’s own release records where its checkout stood, and finishes promptly', async (t) => {
  const repo = await makeRepo('hd-goal-release-stop-')
  const harness = await start()
  const client = await Client.connect(harness.server)
  t.after(async () => {
    client.close()
    await harness.server.close().catch(() => {})
    await harness.host.dispose().catch(() => {})
    await rm(harness.stateDir, { recursive: true, force: true })
    await rm(repo.dir, { recursive: true, force: true })
  })
  await client.call('workspace/open', { path: repo.dir })
  const created = await client.call('goal/create', { root: repo.dir, sentence: 'Finish the probe' }) as GoalView
  const card = await client.call('team/add', { room: created.goal.id, title: 'Do the work' }) as { id: number }
  const session = await client.call('session/create', { runtime: 'fake', options: { cwd: repo.dir } }) as Session
  const assigned = await client.call('goal/assign', {
    goal: created.goal.id, card: card.id, session: { runtime: 'fake', sessionId: session.id },
  }) as { id: string }
  const head = await headOf(repo.dir)
  assert.ok(head, 'the probe repository must have a real commit to bound the release to')
  const startedAt = Date.now()
  await client.call('goal/release', { goal: created.goal.id, seat: assigned.id })
  // Well under the 10s stop-read timeout: a real, fast git read, never the bound.
  assert.ok(Date.now() - startedAt < 5_000, 'a release with a live, answering checkout must not wait for the stop-read timeout')
  const released = await client.call('goal/read', { goal: created.goal.id }) as GoalView
  assert.equal(released.board.intents[0]?.state, 'open')
  assert.equal(released.board.intents[0]?.until, head)
})

/*
 * Review round 2 on #1042, second pass: a wrap closes each receipt Seat and
 * clears its claim (`GoalPlane#closeWrapSeats`) before `Host#finishGoalWrap`
 * ever reads the board — so by the time it looked, `intent.claim` was
 * already null for every card a Seat held, and its own capture, gated on
 * that same field, never recorded anything for any of them. `#stageWrap` now
 * reads every receipt Seat's stop before any of them closes, and
 * `#closeWrapSeats` carries it into the same write that clears the claim.
 * Goes through the real Host and a real git checkout, exactly as the round's
 * own probe did. Fails on 646c0a2e6 (`until` never recorded).
 */
test('a Goal wrap records where a Seat-held card’s checkout stood, and finishes promptly', async (t) => {
  const repo = await makeRepo('hd-goal-wrap-stop-')
  const harness = await start()
  const client = await Client.connect(harness.server)
  t.after(async () => {
    client.close()
    await harness.server.close().catch(() => {})
    await harness.host.dispose().catch(() => {})
    await rm(harness.stateDir, { recursive: true, force: true })
    await rm(repo.dir, { recursive: true, force: true })
  })
  await client.call('workspace/open', { path: repo.dir })
  const created = await client.call('goal/create', { root: repo.dir, sentence: 'Finish the wrap probe' }) as GoalView
  const card = await client.call('team/add', { room: created.goal.id, title: 'Do the work' }) as { id: number }
  const session = await client.call('session/create', { runtime: 'fake', options: { cwd: repo.dir } }) as Session
  await client.call('goal/assign', {
    goal: created.goal.id, card: card.id, session: { runtime: 'fake', sessionId: session.id },
  })
  const head = await headOf(repo.dir)
  assert.ok(head, 'the probe repository must have a real commit to bound the wrap to')
  const choices = { summary: 'Reviewed and complete.', cards: [{ id: card.id, resolution: 'finished' as const, reason: 'Reviewed.' }] }
  /* Assigning a Seat starts its own background evidence observation (loading
     its attachments, most often), which can still be landing after
     `goal/assign` returns — unrelated to this test's own fix. `goal/wrap`
     refuses a stamp the Goal has since moved past, and two previews that
     agree are no promise the next write has not already started, so this
     does what a person does on that refusal: preview again and wrap again. */
  let elapsed = Number.POSITIVE_INFINITY
  for (let tries = 0; ; tries++) {
    const preview = await client.call('goal/preview', { goal: created.goal.id, choices }) as WrapPreview
    const startedAt = Date.now()
    try {
      await client.call('goal/wrap', { goal: created.goal.id, stamp: preview.stamp, choices })
      elapsed = Date.now() - startedAt
      break
    } catch (error) {
      if (tries >= 40 || !/changed while you reviewed/.test(String((error as Error).message))) throw error
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
  }
  // Well under the 10s stop-read timeout: a real, fast git read, never the bound.
  assert.ok(elapsed < 5_000, 'a wrap over a live, answering checkout must not wait for the stop-read timeout')
  const wrapped = await client.call('goal/read', { goal: created.goal.id }) as GoalView
  assert.equal(wrapped.board.intents[0]?.state, 'done')
  assert.equal(wrapped.board.intents[0]?.until, head)
})

test('a board mutation publishes the refreshed Goal view used by wrap', async (t) => {
  const work = tempDir('hd-goal-host-push-')
  const harness = await start()
  const client = await Client.connect(harness.server)
  t.after(async () => {
    client.close()
    await harness.server.close().catch(() => {})
    await harness.host.dispose().catch(() => {})
    await rm(harness.stateDir, { recursive: true, force: true })
    await rm(work, { recursive: true, force: true })
  })
  await client.call('workspace/open', { path: work })
  const created = await client.call('goal/create', { root: work, sentence: 'Publish the board' }) as GoalView
  await client.call('team/add', { room: created.goal.id, title: 'One reviewed card' })
  await client.until(() => client.notifications.some((entry) =>
    'method' in entry && entry.method === 'goal/changed' &&
    entry.params.view.goal.id === created.goal.id && entry.params.view.board.intents.length === 1,
  ), 1_000, 'the refreshed Goal view')
  assert.equal(client.notifications.some((entry) => 'method' in entry && entry.method === 'goal/changed'), true)
})

test('the first Goal activity transition after restart is announced once', async () => {
  const work = tempDir('hd-goal-activity-restart-work-')
  const harness = await start()
  const client = await Client.connect(harness.server)
  let second: Awaited<ReturnType<typeof start>> | null = null
  let secondClient: Client | null = null
  try {
    await client.call('workspace/open', { path: work })
    const goal = await client.call('goal/create', { root: work, sentence: 'Recover the activity baseline' }) as GoalView
    const card = await client.call('team/add', { room: goal.goal.id, title: 'Wait for a decision' }) as { id: number }
    client.close()
    await halt(harness)

    second = await start({}, harness.stateDir)
    secondClient = await Client.connect(second.server)
    await secondClient.call('team/intent', { room: goal.goal.id, id: card.id, action: 'block', reason: 'A decision is needed' })
    const activities = () => secondClient!.notifications.filter((entry) =>
      'method' in entry && entry.method === 'goal/activity' && entry.params.goal === goal.goal.id,
    )
    assert.deepEqual(activities().map((entry) =>
      'method' in entry && entry.method === 'goal/activity' ? entry.params : null,
    ), [{ goal: goal.goal.id, previous: 'working', activity: 'needs-you', sentence: goal.goal.sentence }])

    await secondClient.call('team/intent', { room: goal.goal.id, id: card.id, action: 'block', reason: 'Still waiting' })
    assert.equal(activities().length, 1, 'an unchanged needs-you activity is not announced again')
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
      () => client.call('team/intent', { room: created.goal.id, id: 1, action: 'done' }),
      () => client.call('team/post', { room: created.goal.id, text: 'late' }),
      () => client.call('team/handout', { room: created.goal.id, template: 'late', recipients: [] }),
      () => client.call('team/messaging', { room: created.goal.id, enabled: false }),
      () => client.call('team/deliver', { room: created.goal.id, entryId: 'missing' }),
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

/*
 * A card added while a wrap is in progress either lands before the wrap reads
 * the board — and the wrap is refused as stale — or is refused itself. Never
 * both accepted and left out of the receipt, so a Goal can never be left
 * "wrapping" with a card its receipt has no disposition for.
 */
test('a card added while a Goal wraps never leaves the Goal wrapping', async (t) => {
  for (const delay of [0, 5, 10, 15, 20, 30, 40]) {
    const work = tempDir('hd-goal-wrap-race-')
    const harness = await start()
    const client = await Client.connect(harness.server)
    t.after(async () => {
      client.close()
      await halt(harness).catch(() => {})
      await rm(work, { recursive: true, force: true })
    })
    await client.call('workspace/open', { path: work })
    const goal = (await client.call('goal/create', { root: work, sentence: 'Wrap race' }) as GoalView).goal.id
    const session = await client.call('session/create', { runtime: 'fake', options: { cwd: work } }) as Session
    const card = await client.call('team/add', { room: goal, title: 'Only card' }) as { id: number }
    await client.call('goal/assign', { goal, card: card.id, session: { runtime: 'fake', sessionId: session.id } })
    await client.call('team/intent', { room: goal, id: card.id, action: 'done' })
    await new Promise((resolve) => setTimeout(resolve, 50))
    const choices = { summary: 'Done.', cards: [{ id: card.id, resolution: 'finished' as const, reason: 'ok' }] }
    const preview = await client.call('goal/preview', { goal, choices }) as WrapPreview
    const wrap = client.call('goal/wrap', { goal, stamp: preview.stamp, choices }).then(() => 'wrapped', (error: Error) => `refused: ${error.message}`)
    await new Promise((resolve) => setTimeout(resolve, delay))
    const add = client.call('team/add', { room: goal, title: 'Added during the wrap' }).then(() => 'added', (error: Error) => `refused: ${error.message}`)
    const [wrapped, added] = await Promise.all([wrap, add])
    await harness.host.teamPlane.flush()
    const view = await client.call('goal/read', { goal }) as GoalView
    assert.notEqual(view.goal.state, 'wrapping', `after ${delay} ms: ${added} | ${wrapped}`)
    // Exactly one of them won, and the board says so.
    if (wrapped === 'wrapped') {
      assert.match(added, /^refused: .*wrap/i, `after ${delay} ms the add is refused while the Goal wraps`)
      assert.deepEqual(view.board.intents.map((one) => one.id), [card.id])
    } else {
      assert.equal(added, 'added')
      assert.match(wrapped, /changed while you reviewed|Review every card once/)
      assert.equal(view.goal.state, 'open')
    }
  }
})

/*
 * A Goal an earlier build left wrapping — its receipt missing a card added
 * mid-wrap — finishes wrapping on the next launch: the card it never
 * reviewed is set aside, and says why.
 */
test('a Goal left wrapping with a card its receipt lacks finishes on the next launch', async () => {
  const work = tempDir('hd-goal-wedged-')
  const harness = await start()
  const client = await Client.connect(harness.server)
  let again: Awaited<ReturnType<typeof start>> | null = null
  let second: Client | null = null
  try {
    await client.call('workspace/open', { path: work })
    const goal = (await client.call('goal/create', { root: work, sentence: 'Wedged' }) as GoalView).goal.id
    const card = await client.call('team/add', { room: goal, title: 'Reviewed' }) as { id: number }
    await client.call('team/intent', { room: goal, id: card.id, action: 'done' })
    await harness.host.teamPlane.flush()
    const choices = { summary: 'Done.', cards: [{ id: card.id, resolution: 'finished' as const, reason: null }] }
    const preview = await client.call('goal/preview', { goal, choices }) as WrapPreview
    client.close()
    await halt(harness)
    // Staged as a wrap whose receipt covers card #1 alone, with a card #2 on the board.
    const { readFile: read, readdir: list, writeFile: write } = await import('node:fs/promises')
    const dir = `${harness.stateDir}/goals`
    const file = (await list(dir)).find((name) => name !== 'index.json')!
    const document = JSON.parse(await read(`${dir}/${file}`, 'utf8'))
    const extra = { ...document.board.intents[0], id: 2, title: 'Added during the wrap', state: 'open', outcome: null, note: null }
    const receipt: GoalReceipt = { ...preview.receipt, id: 'receipt-1', wrappedAt: 1 }
    await write(`${dir}/${file}`, JSON.stringify({
      ...document,
      board: { ...document.board, nextIntent: 3, intents: [...document.board.intents, extra] },
      operation: { kind: 'wrap', id: 'op-1', goal, stamp: preview.stamp, receipt },
      goal: { ...document.goal, state: 'wrapping', revision: document.goal.revision + 1 },
    }))
    again = await start({}, harness.stateDir)
    second = await Client.connect(again.server)
    await second.call('workspace/open', { path: work })
    const view = await second.call('goal/read', { goal }) as GoalView
    assert.equal(view.goal.state, 'wrapped')
    const set = view.board.intents.find((one) => one.id === 2)
    assert.equal(set?.state, 'abandoned')
    assert.match(set?.note ?? '', /added while the Goal was wrapping/i)
    // The receipt lists it too, with the same reason, beside the card the person reviewed.
    const stored = await second.call('goal/receipt', { goal }) as GoalReceipt
    assert.deepEqual(stored.cards, [
      { id: card.id, title: 'Reviewed', resolution: 'finished', reason: null },
      { id: 2, resolution: 'dropped', reason: 'Added while the Goal was wrapping, so it was never reviewed.' },
    ])
    assert.equal(stored.id, 'receipt-1')
  } finally {
    second?.close()
    if (again) await halt(again).catch(() => {})
  }
})

/*
 * A card added while another board save is in flight rides in the save
 * queued behind that one — and a person who assigns the card at once lands
 * between the two. The assignment's claim has to find the card the board
 * holds, not the document as the last finished save left it, or the claim is
 * refused, the assignment stays staged, and every later save of the Goal is
 * refused with it.
 */
test('a card assigned while the save that adds it waits behind another is claimed, and the Goal keeps saving', async (t) => {
  const { GoalStore } = await import('../src/goals/store.js')
  const { Serial } = await import('../src/goals/assignments.js')
  const work = tempDir('hd-goal-assign-behind-')
  const harness = await start()
  const client = await Client.connect(harness.server)
  let again: Awaited<ReturnType<typeof start>> | null = null
  let second: Client | null = null
  const save = GoalStore.prototype.save
  const run = Serial.prototype.run
  t.after(async () => {
    GoalStore.prototype.save = save
    Serial.prototype.run = run
    client.close()
    second?.close()
    await halt(harness).catch(() => {})
    if (again) await halt(again).catch(() => {})
    await rm(work, { recursive: true, force: true })
  })
  await client.call('workspace/open', { path: work })
  const goal = (await client.call('goal/create', { root: work, sentence: 'Assign behind a save' }) as GoalView).goal.id
  const session = await client.call('session/create', { runtime: 'fake', options: { cwd: work } }) as Session

  // The next Goal save is held in flight until it is let go.
  let entered!: () => void
  let letGo!: () => void
  const inFlight = new Promise<void>((resolve) => { entered = resolve })
  const released = new Promise<void>((resolve) => { letGo = resolve })
  let hold = true
  GoalStore.prototype.save = async function (this: InstanceType<typeof GoalStore>, ...args: Parameters<typeof save>) {
    if (hold) {
      hold = false
      entered()
      await released
    }
    return save.apply(this, args)
  }
  let queued = 0
  Serial.prototype.run = function <T>(this: InstanceType<typeof Serial>, fn: () => Promise<T>): Promise<T> {
    queued += 1
    return run.call(this, fn) as Promise<T>
  }

  const first = client.call('team/add', { room: goal, title: 'Saving' }) as Promise<{ id: number }>
  await inFlight
  const added = client.call('team/add', { room: goal, title: 'Added behind it' }) as Promise<{ id: number }>
  const card = 2
  for (let tries = 0; ((await client.call('team/state', { room: goal })) as TeamState).intents.length < 2; tries += 1) {
    if (tries > 200) throw new Error('the second card never reached the board')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  const before = queued
  const assign = client.call('goal/assign', { goal, card, session: { runtime: 'fake', sessionId: session.id } })
  // The assignment is queued behind the save in flight before that save is let go.
  await client.until(() => queued > before, 2_000, 'the assignment to queue behind the save in flight')
  letGo()
  const outcomes = await Promise.allSettled([first, added, assign])
  assert.deepEqual(outcomes.map((one) => one.status === 'rejected' ? String(one.reason) : 'ok'), ['ok', 'ok', 'ok'])
  assert.equal((await added).id, card)

  const view = await client.call('goal/read', { goal }) as GoalView
  const claimed = view.board.intents.find((one) => one.id === card)
  assert.equal(claimed?.state, 'claimed')
  assert.equal(claimed?.claim?.sessionId, session.id)
  // The Goal still saves: nothing is left staged.
  await client.call('team/add', { room: goal, title: 'After the assignment' })
  await harness.host.teamPlane.flush()
  assert.deepEqual((await client.call('goal/read', { goal }) as GoalView).board.intents.map((one) => one.id), [1, 2, 3])
  client.close()
  await halt(harness)

  again = await start({}, harness.stateDir)
  second = await Client.connect(again.server)
  await second.call('workspace/open', { path: work })
  const reopened = await second.call('goal/read', { goal }) as GoalView
  assert.deepEqual(reopened.board.intents.map((one) => [one.id, one.state]), [[1, 'open'], [2, 'claimed'], [3, 'open']])
})

/*
 * An assignment an earlier build left staged — its card missing from the
 * document — no longer fails every launch. Recovery sets it aside: the Seat
 * it opened is closed, the Goal takes work again, and it says what happened.
 */
test('an assignment left staged for a card the Goal does not hold is set aside at launch, visibly', async () => {
  const work = tempDir('hd-goal-assign-wedged-')
  const harness = await start()
  const client = await Client.connect(harness.server)
  let again: Awaited<ReturnType<typeof start>> | null = null
  let second: Client | null = null
  try {
    await client.call('workspace/open', { path: work })
    const goal = (await client.call('goal/create', { root: work, sentence: 'Wedged assignment' }) as GoalView).goal.id
    const session = await client.call('session/create', { runtime: 'fake', options: { cwd: work } }) as Session
    const card = await client.call('team/add', { room: goal, title: 'Claimed' }) as { id: number }
    const seat = await client.call('goal/assign', { goal, card: card.id, session: { runtime: 'fake', sessionId: session.id } }) as { id: string }
    await harness.host.teamPlane.flush()
    client.close()
    await halt(harness)
    // The Seat's opening, as the evidence store keeps it, staged again for a card this Goal never held.
    const evidence = new EvidenceStore(`${harness.stateDir}/evidence`)
    const opening = (await evidence.read(work, 'seats')).lines
      .flatMap((line) => line.type === 'seat' && line.record.id === seat.id ? [line.record] : [])[0]
    assert.ok(opening)
    const { readFile: read, readdir: list, writeFile: write } = await import('node:fs/promises')
    const dir = `${harness.stateDir}/goals`
    const file = (await list(dir)).find((name) => name !== 'index.json')!
    const document = JSON.parse(await read(`${dir}/${file}`, 'utf8'))
    await write(`${dir}/${file}`, JSON.stringify({
      ...document,
      operation: { kind: 'assignment', id: 'op-1', goal, card: 7, opening, close: [] },
      goal: { ...document.goal, revision: document.goal.revision + 1 },
    }))

    again = await start({}, harness.stateDir)
    second = await Client.connect(again.server)
    await second.call('workspace/open', { path: work })
    const view = await second.call('goal/read', { goal }) as GoalView
    assert.match(view.problem ?? '', /card 7 could not finish/i)
    assert.deepEqual(view.members, [], 'the Seat the assignment opened is closed')
    assert.equal(view.board.intents.find((one) => one.id === card.id)?.state, 'open', 'and its claim released')
    // The Goal takes work again.
    await second.call('team/add', { room: goal, title: 'Next' })
    await again.host.teamPlane.flush()
    const next = await second.call('goal/read', { goal }) as GoalView
    assert.deepEqual(next.board.intents.map((one) => one.id), [card.id, 2])
    const fresh = await second.call('session/create', { runtime: 'fake', options: { cwd: work } }) as Session
    await second.call('goal/assign', { goal, card: card.id, session: { runtime: 'fake', sessionId: fresh.id } })
    assert.equal((await second.call('goal/read', { goal }) as GoalView).problem, null, 'a later assignment clears the note')
  } finally {
    client.close()
    second?.close()
    await halt(harness).catch(() => {})
    if (again) await halt(again).catch(() => {})
    await rm(work, { recursive: true, force: true })
  }
})

/*
 * An assignment whose claim is refused after it was staged — the card
 * blocked by hand while the Seat was being recorded — is set aside at once:
 * the person hears why, the Seat it opened is closed, and the Goal goes on
 * saving, rather than holding a staged assignment until the next launch.
 */
test('an assignment refused after it was staged is set aside at once, and the Goal keeps saving', async (t) => {
  const { GoalStore } = await import('../src/goals/store.js')
  const work = tempDir('hd-goal-assign-refused-')
  const harness = await start()
  const client = await Client.connect(harness.server)
  const save = GoalStore.prototype.save
  t.after(async () => {
    GoalStore.prototype.save = save
    client.close()
    await halt(harness).catch(() => {})
    await rm(work, { recursive: true, force: true })
  })
  await client.call('workspace/open', { path: work })
  const goal = (await client.call('goal/create', { root: work, sentence: 'Refused after staging' }) as GoalView).goal.id
  const session = await client.call('session/create', { runtime: 'fake', options: { cwd: work } }) as Session
  const card = await client.call('team/add', { room: goal, title: 'Blocked mid-assignment' }) as { id: number }
  let blocked = false
  GoalStore.prototype.save = async function (this: InstanceType<typeof GoalStore>, ...args: Parameters<typeof save>) {
    if (!blocked && args[0].operation?.kind === 'assignment') {
      blocked = true
      harness.host.teamPlane.intentAction(goal, card.id, 'block', 'Waiting on a decision')
    }
    return save.apply(this, args)
  }
  await assert.rejects(
    client.call('goal/assign', { goal, card: card.id, session: { runtime: 'fake', sessionId: session.id } }),
    /cannot be assigned now/,
  )
  assert.equal(blocked, true)
  await harness.host.teamPlane.flush()
  const view = await client.call('goal/read', { goal }) as GoalView
  assert.deepEqual(view.members, [], 'the Seat the refused assignment opened is closed')
  assert.equal(view.problem, null)
  assert.equal(view.board.intents[0]?.state, 'blocked', 'the block that refused it was saved')
  await client.call('team/add', { room: goal, title: 'The Goal still saves' })
  await harness.host.teamPlane.flush()
  assert.deepEqual((await client.call('goal/read', { goal }) as GoalView).board.intents.map((one) => one.id), [card.id, 2])
})

/*
 * The host's own claim for an opening Seat is held to the board's file rule,
 * exactly as an agent's claim is (#1015): two cards whose paths overlap are
 * never both taken, and the refusal names the paths and the card holding them.
 */
test('an assignment whose card overlaps a live claim is refused, naming the paths and the card that holds them', async (t) => {
  const work = tempDir('hd-goal-assign-overlap-')
  const harness = await start()
  const client = await Client.connect(harness.server)
  t.after(async () => {
    client.close()
    await halt(harness).catch(() => {})
    await rm(work, { recursive: true, force: true })
  })
  await client.call('workspace/open', { path: work })
  const goal = (await client.call('goal/create', { root: work, sentence: 'Two parts' }) as GoalView).goal.id
  const first = await client.call('team/add', { room: goal, title: 'Part one', files: ['src/**'] }) as { id: number }
  const second = await client.call('team/add', { room: goal, title: 'Part two', files: ['src/app.ts'] }) as { id: number }
  const third = await client.call('team/add', { room: goal, title: 'Part three', files: ['docs/**'] }) as { id: number }
  const one = await client.call('session/create', { runtime: 'fake', options: { cwd: work } }) as Session
  const two = await client.call('session/create', { runtime: 'fake', options: { cwd: work } }) as Session
  const three = await client.call('session/create', { runtime: 'fake', options: { cwd: work } }) as Session
  await client.call('goal/assign', { goal, card: first.id, session: { runtime: 'fake', sessionId: one.id } })
  await assert.rejects(
    client.call('goal/assign', { goal, card: second.id, session: { runtime: 'fake', sessionId: two.id } }),
    new RegExp(`the files of card #${second.id} overlap a live claim — src/\\*\\* is held by #${first.id}`),
  )
  // A card whose paths are its own is taken as ever.
  await client.call('goal/assign', { goal, card: third.id, session: { runtime: 'fake', sessionId: three.id } })
  await harness.host.teamPlane.flush()
  const cards = (await client.call('goal/read', { goal }) as GoalView).board.intents
  assert.deepEqual(cards.map((card) => [card.id, card.state]), [[first.id, 'claimed'], [second.id, 'open'], [third.id, 'claimed']])
})
