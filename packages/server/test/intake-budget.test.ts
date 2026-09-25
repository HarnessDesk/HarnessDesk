import assert from 'node:assert/strict'
import { test } from 'node:test'

import { DEFAULT_TRIGGER_BUDGET, type TriggerDefinition } from '@harnessdesk/protocol'

import { budgetRefusal, committedToday, PAUSED_STOP, utcDay } from '../src/intake/budget.js'
import { usdMicros } from '../src/intake/definition.js'
import { definition, desk, onDisk, prFact, PROJECT, sha } from './fixtures/intake-restart.js'
import { tempDir } from './scratch.js'

/*
 * Unattended work is bounded by one budget per Goal generation — time,
 * rounds, progress and observed money — and by a daily cap on what every
 * trigger may reserve. Each is kept across restarts, midnight and a clock
 * that runs backwards; reaching one stops the work with a stated reason and
 * keeps what it produced.
 */

const HOUR = 3_600_000
const DAY = Date.UTC(2026, 8, 20)

class Clock {
  constructor(public at: number) {}
  readonly now = (): number => this.at
}

const opens = (events: readonly string[]) => events.filter((one) => one.startsWith('open:'))

test('force-push shares money time and round allowance', async () => {
  const home = tempDir('hd-intake-budget-')
  const clock = new Clock(DAY + 10 * HOUR)
  const trigger = definition({ budget: { usd: 5, rounds: 8, hours: 4, withoutProgress: 9 } })
  const d = await desk(home, { definition: trigger, now: clock.now })
  const opened = await d.admission.offer(d.arm, prFact(1, sha('a'), 'opened'))
  await d.settle()
  const goal = opened.goal!
  const first = d.store.read().budgets[goal]!
  assert.equal(first.deadline, DAY + 14 * HOUR, 'start plus the trigger’s hours')
  // The run's loop limits are the narrower of the trigger's (8 / 9) and the flow's defaults (3 / 2).
  const run = d.flows.executionsFor(goal)[0]!
  assert.deepEqual(run.findings?.budget, { rounds: 3, withoutProgress: 2 })

  // A new head just before the deadline joins the Goal: same budget, same deadline, one reservation.
  clock.at = DAY + 13 * HOUR + 59 * 60_000
  const pushed = await d.admission.offer(d.arm, prFact(1, sha('b'), 'pushed'))
  await d.settle()
  assert.equal(pushed.goal, goal)
  const after = d.store.read()
  assert.deepEqual(after.budgets[goal], { ...first, meters: after.budgets[goal]!.meters })
  assert.equal(Object.keys(after.budgets).length, 1)
  assert.equal(committedToday(after, utcDay(clock.at)), usdMicros(5), 'no second reservation')

  // Past the original deadline another head buys no time: its round is refused with the reason, and nobody is seated.
  clock.at = DAY + 14 * HOUR + 1
  const late = await d.admission.offer(d.arm, prFact(1, sha('c'), 'pushed'))
  await d.settle()
  assert.equal(late.goal, goal)
  const seatsBefore = opens((await onDisk(home)).events).length
  const waiting = d.store.read().operations.find((one) => one.key === late.firing)
  assert.equal(waiting?.attention, 'Timed out: this Goal reached its time budget.')
  assert.equal(opens((await onDisk(home)).events).length, seatsBefore)
  assert.equal(d.budgets.state(goal)?.deadline, DAY + 14 * HOUR)
})

test('concurrent projects share the daily reservation cap', async () => {
  const home = tempDir('hd-intake-budget-')
  const trigger = definition({ budget: { ...DEFAULT_TRIGGER_BUDGET, usd: 15 } })
  const d = await desk(home, { definition: trigger, capMicros: () => usdMicros(20) })
  const other = { ...d.arm, project: '/work/other', binding: { ...d.arm.binding, project: '/work/other' } }
  // Two projects' firings at once: one reserves, the other would pass the $20 cap and is skipped with why.
  const answers = await Promise.all([
    d.admission.offer(d.arm, prFact(1, sha('a'), 'opened')),
    d.admission.offer(other, prFact(2, sha('b'), 'opened', { project: '/work/other' })),
  ])
  await d.settle()
  assert.deepEqual(answers.map((one) => one.outcome).sort(), ['fired', 'skipped'])
  assert.match(answers.find((one) => one.outcome === 'skipped')!.reason ?? '', /\$15\.00 with \$15\.00 already committed today, past the \$20\.00 daily cap/)
  const snapshot = d.store.read()
  assert.equal(Object.keys(snapshot.budgets).length, 1, 'one reservation')
  assert.equal(committedToday(snapshot, utcDay(Date.now())), usdMicros(15))
  assert.equal((await onDisk(home)).goals.length, 1)
})

test('midnight and restart keep outstanding reservations', async () => {
  const home = tempDir('hd-intake-budget-')
  const clock = new Clock(DAY - 60_000)
  const trigger: TriggerDefinition = definition({ concurrency: 5, budget: { ...DEFAULT_TRIGGER_BUDGET, usd: 15, hours: 72 } })
  const cap = () => usdMicros(20)
  let d = await desk(home, { definition: trigger, now: clock.now, capMicros: cap })
  const first = await d.admission.offer(d.arm, prFact(1, sha('a'), 'opened'))
  await d.settle()
  assert.equal(first.outcome, 'fired')
  assert.equal(d.store.read().budgets[first.goal!]?.day, utcDay(DAY - 60_000))

  // Past midnight, in a fresh process: the unsettled reservation is carried, so there is no room for another.
  clock.at = DAY + 60_000
  d = await desk(home, { definition: trigger, now: clock.now, capMicros: cap })
  await d.admission.recover()
  assert.equal((await d.admission.offer(d.arm, prFact(2, sha('b'), 'opened'))).outcome, 'skipped')
  // A clock rolled back a day selects no earlier day and frees nothing.
  clock.at = DAY - 24 * HOUR
  const back = await d.admission.offer(d.arm, prFact(3, sha('c'), 'opened'))
  assert.equal(back.outcome, 'skipped')
  assert.ok(d.store.read().clock >= DAY + 60_000, 'the journal’s clock only moves forward')

  // Unknown final spend keeps the reservation: the Seat worked and its cost was never read.
  const seat = Object.keys(d.store.read().budgets[first.goal!]!.meters)[0]!
  await d.budgets.turn(first.goal!, seat, { started: DAY, ended: DAY + 1 })
  assert.equal(await d.budgets.settle(first.goal!), false)
  assert.equal((await d.admission.offer(d.arm, prFact(4, sha('d'), 'opened'))).outcome, 'skipped')
  // Known final spend replaces the reservation in the settling day's bucket, and makes room.
  const home2 = tempDir('hd-intake-budget-')
  clock.at = DAY - 60_000
  const e = await desk(home2, { definition: trigger, now: clock.now, capMicros: cap })
  const kept = await e.admission.offer(e.arm, prFact(1, sha('a'), 'opened'))
  await e.settle()
  clock.at = DAY + 60_000
  assert.equal(await e.budgets.settle(kept.goal!), true)
  assert.equal(e.store.read().days[utcDay(DAY + 60_000)], 0)
  assert.equal((await e.admission.offer(e.arm, prFact(2, sha('b'), 'opened'))).outcome, 'fired')
})

test('stopping preserves partial answers and prevents queued work', async () => {
  const stops: readonly [string, (d: Awaited<ReturnType<typeof desk>>, clock: Clock, paused: { value: boolean }, cap: { value: number }) => void, RegExp, string][] = [
    // A pause and a lowered cap are not stops (review #898): they hold, in the test below.
    ['time', (_d, clock) => { clock.at += 5 * HOUR }, /^Timed out/, 'timed out'],
    ['unknown spend', (d) => { void d }, /^Spend is unknown/, 'needs a person'],
  ]
  for (const [what, stop, reason, kind] of stops) {
    const home = tempDir('hd-intake-stop-')
    const clock = new Clock(DAY)
    const paused = { value: false }
    const cap = { value: usdMicros(20) }
    const d = await desk(home, { now: clock.now, paused: () => paused.value, capMicros: () => cap.value })
    const opened = await d.admission.offer(d.arm, prFact(1, sha('a'), 'opened'))
    await d.settle()
    const goal = opened.goal!
    const run = d.flows.executionsFor(goal)[0]!
    assert.equal(opens((await onDisk(home)).events).length, 1, `${what}: the round is working`)
    const cards = d.team.stateFor(goal).intents.length
    stop(d, clock, paused, cap)
    if (what === 'unknown spend') {
      const seat = Object.keys(d.store.read().budgets[goal]!.meters)[0]!
      await d.budgets.turn(goal, seat, { started: DAY + 1, ended: DAY + 2 })
    }
    await d.watch.tick()
    await d.settle()
    const state = d.budgets.state(goal)!
    assert.equal(state.stop?.reason, kind, what)
    assert.match(state.stop?.detail ?? '', reason, what)
    const events = (await onDisk(home)).events
    const interrupted = events.indexOf(`interrupt:${goal}`)
    assert.ok(interrupted >= 0, `${what}: active work was interrupted`)
    assert.ok(events.indexOf(`stop:${goal}`) >= 0 && events.indexOf(`stop:${goal}`) < interrupted, `${what}: the run stops before the rest is interrupted, so an interrupted turn finds nothing to re-arm`)
    const stopped = d.flows.executionsFor(goal).find((one) => one.id === run.id)!
    assert.equal(stopped.state, 'stopped', what)
    assert.match(stopped.reason ?? '', reason, what)
    // Kept: the round's cards and the Goal. Nothing wrapped, merged or deleted.
    assert.equal(d.team.stateFor(goal).intents.length, cards, `${what}: cards kept`)
    assert.equal(d.goalStore.read(goal).goal.state, 'open', `${what}: never wrapped`)
    assert.ok(!events.some((one) => one.startsWith('wrapped:')))
    // Queued work does not start: a later head only records, with the reason.
    paused.value = false
    const later = await d.admission.offer(d.arm, prFact(1, sha('f'), 'pushed'))
    await d.settle()
    assert.equal(later.goal, goal)
    assert.equal(opens((await onDisk(home)).events).length, 1, `${what}: no new Seat`)
    // A second sweep changes nothing: the first stop stands.
    await d.watch.tick()
    assert.equal(d.budgets.state(goal)?.stop?.at, state.stop?.at)
    void PROJECT
  }
})

test('a pause or a lowered cap holds work without a recorded stop, and lifting it continues the work', async () => {
  const holds: readonly [string, (paused: { value: boolean }, cap: { value: number }) => void, (paused: { value: boolean }, cap: { value: number }) => void, RegExp][] = [
    ['pause', (paused) => { paused.value = true }, (paused) => { paused.value = false }, new RegExp(`^${PAUSED_STOP}`)],
    ['a lowered cap', (_paused, cap) => { cap.value = usdMicros(1) }, (_paused, cap) => { cap.value = usdMicros(20) }, /spend cap is lower than what is already committed, so this Goal waits\. Raising the cap continues it\./],
  ]
  for (const [what, hold, lift, reason] of holds) {
    const home = tempDir('hd-intake-hold-')
    const paused = { value: false }
    const cap = { value: usdMicros(20) }
    const d = await desk(home, { definition: definition({ again: { role: 'reviewer', title: 'Continue this work', detail: null } }), paused: () => paused.value, capMicros: () => cap.value })
    const opened = await d.admission.offer(d.arm, prFact(1, sha('a'), 'opened'))
    await d.settle()
    const goal = opened.goal!
    const run = d.flows.executionsFor(goal)[0]!
    const reserved = d.store.read().budgets[goal]!.reservedMicros

    hold(paused, cap)
    await d.watch.tick()
    await d.settle()
    const held = d.flows.executionsFor(goal)[0]!
    assert.equal(d.budgets.state(goal)?.stop, null, `${what}: nothing is recorded as a stop`)
    assert.equal(held.state, 'running', `${what}: the run is held, not stopped or stalled`)
    assert.match(held.intake?.heldFor ?? '', reason, what)
    const events = (await onDisk(home)).events
    assert.ok(events.includes(`hold:${goal}`) && events.includes(`interrupt:${goal}`), `${what}: held, and its turns interrupted`)
    assert.ok(!events.includes(`stop:${goal}`), `${what}: never stopped`)
    // A second sweep does nothing more.
    await d.watch.tick()
    assert.equal((await onDisk(home)).events.filter((one) => one === `hold:${goal}`).length, 1, `${what}: held once`)
    // A later head while the cap holds waits too, with the same reason, and is not lost. (A paused machine reads no source.)
    if (what === 'a lowered cap') {
      const later = await d.admission.offer(d.arm, prFact(1, sha('b'), 'pushed'))
      await d.settle()
      assert.equal(later.goal, goal)
      assert.match(d.store.read().operations.find((one) => one.key === later.firing)?.attention ?? '', reason, `${what}: the new head waits with why`)
    }

    lift(paused, cap)
    await d.admission.recover()
    await d.settle()
    if (what === 'pause') {
      // What arrived while paused is read once it resumes, and its round opens: nothing was stopped for good.
      await d.admission.offer(d.arm, prFact(1, sha('b'), 'pushed'))
      await d.settle()
    }
    const continued = d.flows.executionsFor(goal).find((one) => one.id === run.id)!
    assert.equal(continued.state, 'running', `${what}: continued`)
    assert.equal(continued.intake?.dispatchHeld, false, `${what}: let go`)
    assert.equal(continued.intake?.heldFor ?? null, null)
    assert.equal(continued.rounds.length, 2, `${what}: the head that waited opened its round`)
    assert.deepEqual(d.store.read().operations, [], `${what}: nothing is left pending`)
    assert.equal(d.store.read().budgets[goal]!.reservedMicros, reserved, `${what}: one reservation, still held for the open Goal`)
    assert.equal(committedToday(d.store.read(), utcDay(Date.now())), reserved, `${what}: nothing reserved twice`)
    assert.equal(opens((await onDisk(home)).events).length, 2, `${what}: the new round seated`)
  }
})

test('the fail-closed decision names the first bound, and unknown spend is a stop', () => {
  const ok = {
    now: 1, deadline: 10, closedRounds: 0, roundLimit: 3, idleRounds: 0, idleLimit: 2,
    spentMicros: 0, limitMicros: 5, lane: 'available' as const, paused: false,
  }
  assert.equal(budgetRefusal(ok), null)
  assert.equal(budgetRefusal({ ...ok, spentMicros: null }), 'Spend is unknown. Check usage before continuing this Goal.')
  assert.equal(budgetRefusal({ ...ok, lane: 'unknown' }), 'Spend is unknown. Check usage before continuing this Goal.')
  assert.equal(budgetRefusal({ ...ok, lane: 'spent' }), 'Out of budget: this plan has no allowance left.')
  assert.equal(budgetRefusal({ ...ok, spentMicros: 5 }), 'Out of budget: this Goal reached its spend limit.')
  assert.equal(budgetRefusal({ ...ok, closedRounds: 3 }), 'Out of budget: this Goal reached its round limit.')
  assert.equal(budgetRefusal({ ...ok, idleRounds: 2 }), 'Out of budget: no new evidence in the allowed rounds.')
  assert.equal(budgetRefusal({ ...ok, now: 10 }), 'Timed out: this Goal reached its time budget.')
  assert.equal(budgetRefusal({ ...ok, paused: true, now: 10 }), PAUSED_STOP)
})
