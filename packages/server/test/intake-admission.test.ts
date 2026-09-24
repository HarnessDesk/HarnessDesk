import assert from 'node:assert/strict'
import { test } from 'node:test'

import { prepareAdmission, SKIP_CHANGED, SKIP_FORK } from '../src/intake/admission.js'
import { INTAKE_LANDING } from '../src/goals/plane.js'
import { Gate, settle } from './fixtures/intake-forge.js'
import { definition, desk, onDisk, prFact, sha } from './fixtures/intake-restart.js'
import { tempDir } from './scratch.js'

/*
 * Admission turns one fact into at most one firing, one Goal and one round,
 * whatever arrives twice, at once, after a restart, or while a wrap closes
 * the Goal it would join — on the real Goal store, board, flow journal,
 * evidence store and intake journal.
 */

const opens = (events: readonly string[]) => events.filter((one) => one.startsWith('open:'))
const orders = (events: readonly string[]) => events.filter((one) => one.startsWith('order:'))

test('two concurrent deliveries reserve one operation', async () => {
  const home = tempDir('hd-intake-admit-')
  const gate = new Gate()
  const reached = new Gate()
  let asked = 0
  const d = await desk(home, {
    beforeBinding: async () => {
      asked += 1
      if (asked === 1) {
        reached.open()
        await gate.opened
      }
    },
  })
  const fact = prFact(7, sha('a'), 'opened')
  // Two genuinely overlapping deliveries of the same fact: the first held inside admission, the second queued behind it.
  const first = d.admission.offer(d.arm, fact)
  const second = d.admission.offer(d.arm, fact)
  await reached.opened
  await settle()
  gate.open()
  const answers = await Promise.all([first, second])
  await d.settle()

  assert.deepEqual(answers.map((one) => one.outcome).sort(), ['duplicate', 'fired'])
  assert.equal(answers[0]!.firing, answers[1]!.firing)
  assert.equal(answers[0]!.goal, answers[1]!.goal)
  const disk = await onDisk(home)
  assert.equal(disk.goals.length, 1, 'one Goal')
  assert.equal(disk.runs.length, 1, 'one run')
  assert.equal(disk.rounds.length, 1, 'one round')
  assert.equal(Object.keys(d.store.read().firings).length, 1, 'one firing recorded')
  assert.deepEqual(opens(disk.events).length, 1)
  assert.deepEqual(orders(disk.events).length, 1)
})

test('opened pushed redelivered restart selects one Goal', async () => {
  const home = tempDir('hd-intake-admit-')
  const a = prFact(7, sha('a'), 'opened')
  const b = prFact(7, sha('b'), 'pushed')
  let d = await desk(home)
  assert.equal((await d.admission.offer(d.arm, a)).outcome, 'fired')
  const pushed = await d.admission.offer(d.arm, b)
  assert.equal(pushed.outcome, 'fired')
  assert.equal((await d.admission.offer(d.arm, b)).outcome, 'duplicate')
  await d.settle()

  // A fresh desk over the same folder: every store read back from disk, nothing kept in memory.
  d = await desk(home)
  await d.admission.recover()
  const replay = await d.admission.offer(d.arm, b)
  assert.equal(replay.outcome, 'duplicate')
  assert.equal(replay.goal, pushed.goal)
  await d.settle()

  const disk = await onDisk(home)
  assert.equal(disk.goals.length, 1, 'the push joined the Goal the opening made')
  assert.equal(disk.runs.length, 1)
  assert.deepEqual(disk.rounds.map((one) => one.split(':').slice(1).join(':').replace(/intake:[0-9a-f]+/, 'intake')), ['1:seed', '2:cause:intake'])
  assert.equal(opens(disk.events).length, 2, 'one Seat per round, never a third')
  assert.equal(disk.runs[0]!.intake?.dispatchHeld, false)
})

test('the arm is read again and forks are refused before anything fires', async () => {
  const home = tempDir('hd-intake-admit-')
  let stands = true
  const d = await desk(home, { consent: () => stands })
  const fork = await d.admission.offer(d.arm, prFact(8, sha('f'), 'opened', { fork: true }))
  assert.deepEqual([fork.outcome, fork.reason], ['skipped', SKIP_FORK])
  stands = false
  const changed = await d.admission.offer(d.arm, prFact(9, sha('c'), 'opened'))
  assert.deepEqual([changed.outcome, changed.reason], ['skipped', SKIP_CHANGED])
  // Skipped is consumed: offered again, it is the same recorded answer, not a firing.
  stands = true
  const again = await d.admission.offer(d.arm, prFact(9, sha('c'), 'opened'))
  assert.deepEqual([again.outcome, again.reason], ['duplicate', SKIP_CHANGED])
  await d.settle()
  assert.deepEqual((await onDisk(home)).goals, [])
})

test('stopped and pending Goals still consume concurrency', async () => {
  // A stopped run's Goal is still open: it holds the one slot.
  {
    const home = tempDir('hd-intake-admit-')
    const d = await desk(home)
    const first = await d.admission.offer(d.arm, prFact(1, sha('a'), 'opened'))
    await d.settle()
    const run = (await onDisk(home)).runs[0]!.id
    await d.flows.stopRun(run, 'the person stopped it')
    const other = await d.admission.offer(d.arm, prFact(2, sha('b'), 'opened'))
    assert.equal(other.outcome, 'skipped')
    assert.match(other.reason ?? '', /1 open Goal/)
    // The same subject still joins its own Goal without another slot; its stopped run records it for the person.
    const same = await d.admission.offer(d.arm, prFact(1, sha('c'), 'pushed'))
    assert.equal(same.outcome, 'fired')
    assert.equal(same.goal, first.goal)
    await d.settle()
    assert.equal((await onDisk(home)).goals.length, 1)
  }
  // A firing still being applied holds its slot too: a crash after its journal entry cannot be used to exceed the bound.
  {
    const home = tempDir('hd-intake-admit-')
    const d = await desk(home, { crashAt: 'prepared' })
    await assert.rejects(d.admission.offer(d.arm, prFact(1, sha('a'), 'opened')), /crashed at prepared/)
    const other = await d.admission.offer(d.arm, prFact(2, sha('b'), 'opened'))
    assert.equal(other.outcome, 'skipped')
    assert.equal(d.store.read().operations.filter((one) => one.state === 'prepared').length, 1)
    assert.deepEqual((await onDisk(home)).goals, [], 'no Goal was made for the refused subject')
  }
})

test('wrap and next fact choose exactly one generation', async () => {
  const wrapChoices = { summary: 'Reviewed', cards: [] as { id: number; resolution: 'finished' | 'dropped'; reason: string | null }[] }
  const wrap = async (d: Awaited<ReturnType<typeof desk>>, goal: string): Promise<unknown> => {
    // The cards the Goal document holds are the ones a wrap reviews here.
    const cards = d.goalStore.read(goal).board.intents
    const choices = { ...wrapChoices, cards: cards.map((card) => ({ id: card.id, resolution: 'dropped' as const, reason: 'Not needed' })) }
    const preview = await d.goals.preview(goal, choices)
    return d.goals.wrap(goal, preview.stamp, choices)
  }
  const hold = async () => 'held for this test'

  // The firing lands first: the wrap waits for it, and the new head's round is in the one open Goal.
  {
    const home = tempDir('hd-intake-wrap-')
    const round = new Gate()
    const atRound = new Gate()
    let rounds = 0
    const d = await desk(home, {
      gate: hold,
      beforeRound: async () => {
        rounds += 1
        if (rounds === 2) {
          atRound.open()
          await round.opened
        }
      },
    })
    const opened = await d.admission.offer(d.arm, prFact(1, sha('a'), 'opened'))
    await d.settle()
    const landing = d.admission.offer(d.arm, prFact(1, sha('b'), 'pushed'))
    await atRound.opened
    await assert.rejects(wrap(d, opened.goal!), (error: Error) => error.message === INTAKE_LANDING)
    round.open()
    const joined = await landing
    assert.equal(joined.goal, opened.goal, 'the one open Goal')
    await d.settle()
    const disk = await onDisk(home)
    assert.deepEqual(disk.goals, [opened.goal])
    assert.ok(!disk.events.some((one) => one.startsWith('wrapped:')))
  }

  // The wrap begins first: the next fact finds the Goal closing and opens exactly one new generation.
  {
    const home = tempDir('hd-intake-wrap-')
    const stop = new Gate()
    const atStop = new Gate()
    const d = await desk(home, { gate: hold, beforeStop: async () => { atStop.open(); await stop.opened } })
    const opened = await d.admission.offer(d.arm, prFact(1, sha('a'), 'opened'))
    await d.settle()
    const wrapping = wrap(d, opened.goal!).then(() => 'wrapped', (error: Error) => error.message)
    await atStop.opened
    // Decided while the wrap holds the Goal closing: a new generation, never a round in the closing Goal.
    const fresh = await d.admission.offer(d.arm, prFact(1, sha('b'), 'pushed'))
    assert.notEqual(fresh.goal, opened.goal, 'a new generation')
    stop.open()
    // A Goal made meanwhile makes this wrap's reviewed receipt stale (the wrap's own rule); reviewed again, it wraps.
    const outcome = await wrapping
    if (outcome !== 'wrapped') {
      assert.match(outcome, /changed while you reviewed/)
      await wrap(d, opened.goal!)
    }
    await d.settle()
    const disk = await onDisk(home)
    assert.deepEqual(disk.goals, [opened.goal!, fresh.goal!].sort())
    assert.ok(disk.events.includes(`wrapped:${opened.goal}`))
    const group = Object.values(d.store.read().groups)[0]!
    assert.deepEqual([group.goal, group.generation, group.open], [fresh.goal, 2, true])
    // The closing Goal took no round for it, and the new generation has only its own seed.
    assert.equal(disk.rounds.filter((one) => one.includes('intake')).length, 0)
    assert.equal(disk.runs.filter((run) => run.goal === fresh.goal).length, 1)
  }

  // The wrap and the firing queue on the Goal plane at once, the wrap's barrier first: the firing had already read
  // the Goal as open, and the barrier alone decides — the firing opens a new generation.
  {
    const home = tempDir('hd-intake-wrap-')
    const d = await desk(home, { gate: hold })
    const opened = await d.admission.offer(d.arm, prFact(1, sha('a'), 'opened'))
    await d.settle()
    const cards = d.goalStore.read(opened.goal!).board.intents
    const choices = { ...wrapChoices, cards: cards.map((card) => ({ id: card.id, resolution: 'dropped' as const, reason: 'Not needed' })) }
    const preview = await d.goals.preview(opened.goal!, choices)
    const held = new Gate()
    const base = d.goalSerial.queued
    void d.goalSerial.run(() => held.opened)
    const wrapping = d.goals.wrap(opened.goal!, preview.stamp, choices).then(() => 'wrapped', (error: Error) => error.message)
    await d.goalSerial.reached(base + 2)
    const next = d.admission.offer(d.arm, prFact(1, sha('b'), 'pushed'))
    await d.goalSerial.reached(base + 3)
    held.open()
    const fresh = await next
    assert.notEqual(fresh.goal, opened.goal, 'the barrier ran first, so the firing opened a new generation')
    const outcome = await wrapping
    if (outcome !== 'wrapped') {
      assert.match(outcome, /changed while you reviewed/)
      const again = await d.goals.preview(opened.goal!, choices)
      await d.goals.wrap(opened.goal!, again.stamp, choices)
    }
    await d.settle()
    const disk = await onDisk(home)
    assert.ok(disk.events.includes(`wrapped:${opened.goal}`))
    assert.equal(disk.rounds.filter((one) => one.includes('intake')).length, 0, 'the wrapped Goal took no round')
  }
})

test('the pure reducer keys, groups and limits one trigger', () => {
  const empty = { operations: [], groups: {} }
  const base = { again: true, newGoal: 'g1', newRun: 'r1', maxOpen: 1 }
  const a = prepareAdmission(empty, { ...base, key: 'k1', group: 'pr1', head: 'h1' })
  assert.equal(a.operation?.mode, 'start')
  assert.equal(prepareAdmission(a.state, { ...base, key: 'k1', group: 'pr1', head: 'h1' }).duplicate, true)
  const b = prepareAdmission(a.state, { ...base, key: 'k2', group: 'pr1', head: 'h2', newGoal: 'g2' })
  assert.deepEqual([b.operation?.mode, b.operation?.goal], ['again', 'g1'])
  const same = prepareAdmission(b.state, { ...base, key: 'k3', group: 'pr1', head: 'h2', newGoal: 'g3' })
  assert.equal(same.operation?.mode, 'record', 'the same head records, never a second review')
  const noAgain = prepareAdmission(b.state, { ...base, again: false, key: 'k4', group: 'pr1', head: 'h9' })
  assert.equal(noAgain.operation?.mode, 'record')
  assert.equal(prepareAdmission(b.state, { ...base, key: 'k5', group: 'pr2', head: 'x' }).operation, null, 'the limit')
  void definition
})

test('a firing whose effects keep failing holds only its own project, then goes to the person', async () => {
  const home = tempDir('hd-intake-fault-')
  const OTHER = '/work/other'
  let moved = true
  const d = await desk(home, {
    definition: definition({ concurrency: 5 }),
    // The other project's folder moved between the firing and its round: not a refusal, a failure.
    beforeRound: async (project) => { if (moved && project === OTHER) throw new Error('The project folder moved.') },
  })
  const other = { ...d.arm, project: OTHER, binding: { ...d.arm.binding, project: OTHER } }

  const failing = await d.admission.offer(other, prFact(1, sha('a'), 'opened', { project: OTHER }))
  assert.equal(failing.outcome, 'fired', 'the firing is answered: durable, its effects to follow')
  assert.equal(d.store.read().operations.find((one) => one.key === failing.firing)?.attempts, 1)
  assert.match(d.admission.fault(OTHER) ?? '', /could not be finished \(The project folder moved\)\. It is tried again on its own/)
  assert.equal(d.admission.problem, null, 'intake as a whole is not stopped')

  // Every other project keeps running.
  const fine = await d.admission.offer(d.arm, prFact(2, sha('b'), 'opened'))
  await d.settle()
  assert.equal(fine.outcome, 'fired')
  assert.equal(d.admission.fault(d.arm.project), null)
  assert.equal(opens((await onDisk(home)).events).length, 1, 'this project’s round seated')
  // Its own project's new events wait behind it, their cursor kept: an offer is no answer.
  await assert.rejects(d.admission.offer(other, prFact(3, sha('c'), 'opened', { project: OTHER })), /could not be finished/)
  assert.equal(d.store.read().firings[prFact(3, sha('c'), 'opened', { project: OTHER }).event], undefined)

  // Recovery tries it again, a bounded number of times, then sets it aside for the person.
  await d.admission.recover()
  assert.equal(d.store.read().operations.find((one) => one.key === failing.firing)?.attempts, 2)
  await d.admission.recover()
  assert.equal(d.store.read().operations.some((one) => one.key === failing.firing), false, 'set aside: never retried again')
  const tombstone = d.store.read().firings[failing.firing]
  assert.ok(tombstone, 'its tombstone is kept')
  assert.match(tombstone.attention ?? '', /after 3 tries \(The project folder moved\), so it was set aside for you/)
  assert.equal(d.admission.fault(OTHER), null, 'its project admits again')
  const events = (await onDisk(home)).events
  assert.deepEqual(events.filter((one) => one.startsWith(`fault:${OTHER}`)), [`fault:${OTHER}:retry`, `fault:${OTHER}:retry`, `fault:${OTHER}:aside`], 'each failure is said')
  // A redelivery is still a duplicate: set aside is not forgotten.
  assert.equal((await d.admission.offer(other, prFact(1, sha('a'), 'opened', { project: OTHER }))).outcome, 'duplicate')

  // Once the folder is back, the project's next fact fires and lands.
  moved = false
  const next = await d.admission.offer(other, prFact(4, sha('d'), 'opened', { project: OTHER }))
  await d.settle()
  assert.equal(next.outcome, 'fired')
  assert.deepEqual(d.store.read().operations, [])
})
