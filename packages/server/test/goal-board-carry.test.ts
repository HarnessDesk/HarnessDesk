import assert from 'node:assert/strict'
import { readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { test } from 'node:test'

import type { GoalView, Session, TeamState } from '@harnessdesk/protocol'

import { EvidenceStore } from '../src/evidence/store.js'
import { Client, halt, start } from './fixtures/harness.js'
import { tempDir } from './scratch.js'

/*
 * #881. A Goal's board has one writer, the Team engine's copy, and the Goal
 * plane's claims and releases are made to it and saved inside the Goal queue.
 * These cover the two follow-ups: a Team save the Goal plane's write carries
 * has to land whole before it is answered, and an operation that could not
 * even be set aside is tried again once the desk can write, not only after a
 * restart.
 */

/** The Goal document as it is on disk. */
const onDisk = async (stateDir: string, goal: string): Promise<{ board: { messaging: boolean }; operation: unknown }> => {
  const dir = `${stateDir}/goals`
  for (const name of await readdir(dir)) {
    if (name === 'index.json' || !name.endsWith('.json')) continue
    const document = JSON.parse(await readFile(`${dir}/${name}`, 'utf8'))
    if (document.goal.id === goal) return document
  }
  throw new Error(`no document for ${goal}`)
}

test('a Team save an assignment carries lands whole — messaging included — even when its own later run would fail', async (t) => {
  const { GoalStore } = await import('../src/goals/store.js')
  const { Serial } = await import('../src/goals/assignments.js')
  const work = tempDir('hd-goal-carry-whole-')
  const harness = await start()
  const client = await Client.connect(harness.server)
  const save = GoalStore.prototype.save
  const run = Serial.prototype.run
  t.after(async () => {
    GoalStore.prototype.save = save
    Serial.prototype.run = run
    client.close()
    await halt(harness).catch(() => {})
    await rm(work, { recursive: true, force: true })
  })
  await client.call('workspace/open', { path: work })
  const goal = (await client.call('goal/create', { root: work, sentence: 'Carry a save whole' }) as GoalView).goal.id
  const session = await client.call('session/create', { runtime: 'fake', options: { cwd: work } }) as Session
  const card = await client.call('team/add', { room: goal, title: 'To assign' }) as { id: number }
  await harness.host.teamPlane.flush()

  // The next Goal save is held in flight; after the assignment finishes, the next save fails once.
  let entered!: () => void
  let letGo!: () => void
  const inFlight = new Promise<void>((resolve) => { entered = resolve })
  const released = new Promise<void>((resolve) => { letGo = resolve })
  let hold = true
  let assignment: 'none' | 'staged' | 'finished' = 'none'
  let failed = 0
  GoalStore.prototype.save = async function (this: InstanceType<typeof GoalStore>, ...args: Parameters<typeof save>) {
    if (hold) {
      hold = false
      entered()
      await released
    }
    const [document] = args
    if (document.goal.id === goal) {
      if (assignment === 'none' && document.operation?.kind === 'assignment') assignment = 'staged'
      else if (assignment === 'staged' && document.operation === null) {
        assignment = 'finished'
        return save.apply(this, args)
      } else if (assignment === 'finished') {
        failed += 1
        throw new Error('EIO')
      }
    }
    return save.apply(this, args)
  }
  let queued = 0
  Serial.prototype.run = function <T>(this: InstanceType<typeof Serial>, fn: () => Promise<T>): Promise<T> {
    queued += 1
    return run.call(this, fn) as Promise<T>
  }

  const first = client.call('team/add', { room: goal, title: 'Saving' })
  await inFlight
  // Waits behind the save in flight: this is the save the assignment will carry.
  harness.host.teamPlane.setMessaging(goal, false)
  const before = queued
  const assign = client.call('goal/assign', { goal, card: card.id, session: { runtime: 'fake', sessionId: session.id } })
  await client.until(() => queued > before, 2_000, 'the assignment to queue behind the save in flight')
  letGo()
  const outcomes = await Promise.allSettled([first, assign])
  assert.deepEqual(outcomes.map((one) => one.status === 'rejected' ? String(one.reason) : 'ok'), ['ok', 'ok'])
  await harness.host.teamPlane.flush()

  assert.equal(assignment, 'finished')
  assert.equal(failed, 0, 'the carried save never runs on its own afterwards')
  const document = await onDisk(harness.stateDir, goal)
  assert.equal(document.board.messaging, false, 'the change the carried save held is durable')
  assert.equal(document.operation, null)
  const state = await client.call('team/state', { room: goal }) as TeamState
  assert.equal(state.messaging, false)
  assert.equal(state.problem, null)
})

/*
 * An assignment refused after it was staged, whose set-aside then fails too,
 * leaves the Goal refusing new work. It used to stay that way until the desk
 * restarted. The next board save that lands — on any Goal — tries the
 * set-aside again, and the Goal takes work once it is set aside.
 */
test('an assignment that could not even be set aside is set aside after the next board save lands, without a restart', async (t) => {
  const { GoalStore } = await import('../src/goals/store.js')
  const { GoalPlane } = await import('../src/goals/plane.js')
  const work = tempDir('hd-goal-stuck-retry-')
  const harness = await start()
  const client = await Client.connect(harness.server)
  const save = GoalStore.prototype.save
  const retryStuck = GoalPlane.prototype.retryStuck
  t.after(async () => {
    GoalStore.prototype.save = save
    GoalPlane.prototype.retryStuck = retryStuck
    client.close()
    await halt(harness).catch(() => {})
    await rm(work, { recursive: true, force: true })
  })
  await client.call('workspace/open', { path: work })
  const goal = (await client.call('goal/create', { root: work, sentence: 'Stuck assignment' }) as GoalView).goal.id
  const other = (await client.call('goal/create', { root: work, sentence: 'Another Goal' }) as GoalView).goal.id
  const session = await client.call('session/create', { runtime: 'fake', options: { cwd: work } }) as Session
  const card = await client.call('team/add', { room: goal, title: 'Blocked mid-assignment' }) as { id: number }
  await harness.host.teamPlane.flush()

  let phase: 'idle' | 'staged' | 'refused' | 'done' = 'idle'
  GoalStore.prototype.save = async function (this: InstanceType<typeof GoalStore>, ...args: Parameters<typeof save>) {
    const [document] = args
    if (document.goal.id === goal) {
      if (phase === 'idle' && document.operation?.kind === 'assignment') {
        phase = 'staged'
        // The card is blocked by hand while the Seat is being recorded, so its claim is refused.
        harness.host.teamPlane.intentAction(goal, card.id, 'block', 'Waiting on a decision')
      } else if (phase === 'staged' && document.operation === null) {
        // Setting the refused assignment aside fails once, too.
        phase = 'refused'
        throw new Error('EIO')
      }
    }
    return save.apply(this, args)
  }
  await assert.rejects(
    client.call('goal/assign', { goal, card: card.id, session: { runtime: 'fake', sessionId: session.id } }),
    /cannot be assigned now/,
  )
  assert.equal(phase, 'refused')
  const stuck = await client.call('goal/read', { goal }) as GoalView
  assert.match(stuck.problem ?? '', /Setting it aside failed too/)
  assert.match(stuck.problem ?? '', /tried again after the next board save/)
  assert.notEqual((await onDisk(harness.stateDir, goal)).operation, null, 'still staged')

  // Any board save that lands is the sign the desk can write again.
  const retries: Promise<void>[] = []
  GoalPlane.prototype.retryStuck = function (this: InstanceType<typeof GoalPlane>) {
    const retry = retryStuck.call(this)
    retries.push(retry)
    return retry
  }
  await client.call('team/add', { room: other, title: 'Elsewhere' })
  await harness.host.teamPlane.flush()
  assert.ok(retries.length > 0, 'the landed save asked for a retry')
  await Promise.all(retries)
  phase = 'done'
  assert.match((await client.call('goal/read', { goal }) as GoalView).problem ?? '', /assign the card again/)
  assert.equal((await onDisk(harness.stateDir, goal)).operation, null, 'set aside, durably')
  const view = await client.call('goal/read', { goal }) as GoalView
  assert.deepEqual(view.members, [], 'the Seat it opened is closed')
  // The Goal takes work again.
  await client.call('team/add', { room: goal, title: 'Next' })
  await harness.host.teamPlane.flush()
  assert.deepEqual((await client.call('goal/read', { goal }) as GoalView).board.intents.map((one) => one.id), [card.id, 2])
})

/*
 * A launch sets aside an assignment left staged for a card the Goal does not
 * hold — here, for a Seat whose conversation had since let its assigned card
 * go and taken another through the board itself. Setting it aside closes the
 * Seat and lets go of the claim that conversation holds, whichever side took
 * it, so no card is left claimed by a Seat that is gone.
 */
test('a launch set-aside releases the claim the Seat’s conversation took on the board itself', async () => {
  const work = tempDir('hd-goal-aside-team-claim-')
  const harness = await start()
  const client = await Client.connect(harness.server)
  let again: Awaited<ReturnType<typeof start>> | null = null
  let second: Client | null = null
  try {
    await client.call('workspace/open', { path: work })
    const goal = (await client.call('goal/create', { root: work, sentence: 'Set aside with a board claim' }) as GoalView).goal.id
    const session = await client.call('session/create', { runtime: 'fake', options: { cwd: work } }) as Session
    const assigned = await client.call('team/add', { room: goal, title: 'Assigned' }) as { id: number }
    const taken = await client.call('team/add', { room: goal, title: 'Taken on the board' }) as { id: number }
    const seat = await client.call('goal/assign', { goal, card: assigned.id, session: { runtime: 'fake', sessionId: session.id } }) as { id: string }
    const scope = { runtime: 'fake', sessionId: session.id }
    assert.match(await harness.host.teamPlane.release(assigned.id, {}, scope), /Released/i)
    assert.match(await harness.host.teamPlane.claim(taken.id, scope), /^Claimed/)
    await harness.host.teamPlane.flush()
    client.close()
    await halt(harness)

    const evidence = new EvidenceStore(`${harness.stateDir}/evidence`)
    const opening = (await evidence.read(work, 'seats')).lines
      .flatMap((line) => line.type === 'seat' && line.record.id === seat.id ? [line.record] : [])[0]
    assert.ok(opening)
    const dir = `${harness.stateDir}/goals`
    const file = (await readdir(dir)).find((name) => name !== 'index.json')!
    const document = JSON.parse(await readFile(`${dir}/${file}`, 'utf8'))
    assert.equal(document.board.intents.find((one: { id: number }) => one.id === taken.id)?.claim?.sessionId, session.id)
    await writeFile(`${dir}/${file}`, JSON.stringify({
      ...document,
      operation: { kind: 'assignment', id: 'op-1', goal, card: 7, opening, close: [] },
      goal: { ...document.goal, revision: document.goal.revision + 1 },
    }))

    again = await start({}, harness.stateDir)
    second = await Client.connect(again.server)
    await second.call('workspace/open', { path: work })
    const view = await second.call('goal/read', { goal }) as GoalView
    assert.match(view.problem ?? '', /card 7 could not finish/i)
    assert.deepEqual(view.members, [], 'the Seat is closed')
    const board = view.board.intents
    assert.equal(board.find((one) => one.id === taken.id)?.state, 'open', 'and the claim its conversation took on the board is let go')
    assert.equal(board.find((one) => one.id === taken.id)?.claim, null)
    // The Goal takes work again.
    await second.call('team/add', { room: goal, title: 'Next' })
    await again.host.teamPlane.flush()
    assert.equal((await second.call('goal/read', { goal }) as GoalView).board.intents.length, 3)
  } finally {
    client.close()
    second?.close()
    await halt(harness).catch(() => {})
    if (again) await halt(again).catch(() => {})
    await rm(work, { recursive: true, force: true })
  }
})
