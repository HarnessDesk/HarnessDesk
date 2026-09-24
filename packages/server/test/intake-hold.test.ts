import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { FlowExecution, GoalView, TriggerArmPreview, TriggerGoalStatus, TriggerHistoryPage } from '@harnessdesk/protocol'

import { intakeDesk, until, type IntakeDesk } from './fixtures/intake-host.js'
import { sha } from './fixtures/intake-forge.js'

/*
 * A pause and the daily cap are gates that lift on their own, not stops
 * (review #898). Either one holds a trigger's work — its turns interrupted,
 * nothing recorded as a stop — and lifting it continues that work: the held
 * Seat is handed its card again, a push that waited opens its round, and the
 * Goal's reservation is held once, throughout.
 */

const E2E = { timeout: 120_000 } as const

const running = (d: IntakeDesk): readonly string[] =>
  d.host.registry.all().filter((record) => record.running.size > 0).map((record) => String(record.session.id))

const turnsOf = (d: IntakeDesk, session: string): number =>
  d.host.registry.all().find((record) => String(record.session.id) === session)?.session.turns.length ?? 0

const status = async (d: IntakeDesk, goal: string): Promise<TriggerGoalStatus> =>
  await d.host.call('trigger/goal', { goal }) as TriggerGoalStatus

/** One armed pull-request trigger (again: reviewer) with its first Goal's Seat at work. */
const working = async (d: IntakeDesk): Promise<{ goal: string; run: string; session: string }> => {
  const preview = await d.host.call('trigger/preview', { root: d.repo.dir, id: 'review' }) as TriggerArmPreview
  await d.host.call('trigger/arm', { root: d.repo.dir, id: 'review', token: preview.token! })
  const at = d.clocks.wall + 1000
  d.forge.pulls.push({ number: 1, head: sha('a'), state: 'open', created: at, updated: at })
  d.clocks.advance(60_000)
  await d.host.intakePlane.tick()
  const goal = await until(async () => (await d.host.call('goal/list', {}) as readonly GoalView[]).find((view) => view.goal.origin.kind === 'trigger')?.goal.id, 'the trigger Goal')
  const page = await d.host.call('trigger/history', { root: d.repo.dir, id: 'review' }) as TriggerHistoryPage
  const run = page.items[0]!.run!
  const session = await until(async () => {
    const view = await d.host.call('goal/read', { goal }) as GoalView
    const card = view.board.intents.find((one) => one.state === 'claimed' && one.claim)
    return card && running(d).includes(card.claim!.sessionId) ? card.claim!.sessionId : null
  }, 'its Seat at work')
  return { goal, run, session }
}

const execution = async (d: IntakeDesk, run: string): Promise<FlowExecution> => await d.host.call('flow/execution', { run }) as FlowExecution

test('pause then resume continues the work, and a push that waited opens its round', E2E, async (t) => {
  const d = await intakeDesk()
  t.after(() => d.stop())
  const { goal, run, session } = await working(d)
  const prefs = await d.host.call('trigger/preferences', {})
  const paused = await d.host.call('trigger/preferences/set', { revision: prefs.revision, paused: true, dailyUsd: 20 })
  await until(async () => (await execution(d, run)).intake?.heldFor ? true : null, 'held by the pause')
  await until(() => running(d).length === 0 ? true : null, 'its turn interrupted')
  assert.equal((await status(d, goal)).budget?.stop, null, 'nothing recorded as a stop')
  const before = turnsOf(d, session)

  // A new head arrives while paused: nothing reads it yet.
  d.forge.pulls[0] = { ...d.forge.pulls[0]!, head: sha('b'), updated: d.clocks.wall + 1000 }
  d.clocks.advance(60_000)
  await d.host.intakePlane.tick()
  assert.equal((await d.host.call('trigger/history', { root: d.repo.dir, id: 'review' }) as TriggerHistoryPage).items.length, 1)

  await d.host.call('trigger/preferences/set', { revision: paused.revision, paused: false, dailyUsd: 20 })
  await until(() => running(d).includes(session) && turnsOf(d, session) > before ? true : null, 'the held Seat handed its card again')
  const continued = await execution(d, run)
  assert.deepEqual([continued.state, continued.intake?.heldFor ?? null], ['running', null])

  // The push that waited is read now and opens its round: again was never refused by a stop.
  d.clocks.advance(60_000)
  await d.host.intakePlane.tick()
  const again = await until(async () => { const one = await execution(d, run); return one.rounds.length === 2 ? one : null }, 'the waited-for round')
  assert.equal(again.intake?.dispatchHeld, false)
  const history = await d.host.call('trigger/history', { root: d.repo.dir, id: 'review' }) as TriggerHistoryPage
  assert.deepEqual(history.items.map((one) => [one.outcome, one.head]), [['fired', sha('b')], ['fired', sha('a')]])
  assert.equal((await d.host.call('trigger/preferences', {})).reservedUsd, 5, 'one reservation for the one Goal')
  assert.equal((await status(d, goal)).budget?.stop, null)
})

test('lowering the daily cap below what is committed holds the work; raising it continues it', E2E, async (t) => {
  const d = await intakeDesk()
  t.after(() => d.stop())
  const { goal, run, session } = await working(d)
  const prefs = await d.host.call('trigger/preferences', {})
  const lowered = await d.host.call('trigger/preferences/set', { revision: prefs.revision, paused: false, dailyUsd: 1 })
  const held = await until(async () => { const one = await execution(d, run); return one.intake?.heldFor ? one : null }, 'held by the cap')
  assert.match(held.intake!.heldFor!, /spend cap is lower than what is already committed, so this Goal waits\. Raising the cap continues it\./)
  assert.equal(held.state, 'running')
  await until(() => running(d).length === 0 ? true : null, 'its turn interrupted')
  assert.equal((await status(d, goal)).budget?.stop, null, 'nothing recorded as a stop')
  const wait = await until(async () => (await status(d, goal)).waits.find((one) => /^This Goal waits: Today’s trigger spend cap/.test(one.sentence)) ?? null, 'the cap named as a wait')
  assert.equal(wait.action, 'open-usage')
  assert.equal(lowered.reservedUsd, 5, 'its reservation is still held')
  const before = turnsOf(d, session)

  await d.host.call('trigger/preferences/set', { revision: lowered.revision, paused: false, dailyUsd: 20 })
  await until(() => running(d).includes(session) && turnsOf(d, session) > before ? true : null, 'the held Seat handed its card again')
  const continued = await execution(d, run)
  assert.deepEqual([continued.state, continued.intake?.dispatchHeld, continued.intake?.heldFor ?? null], ['running', false, null])
  assert.equal((await d.host.call('trigger/preferences', {})).reservedUsd, 5)
  await until(async () => (await status(d, goal)).waits.some((one) => /spend cap/.test(one.sentence)) ? null : true, 'the cap’s wait resolved')
})

test('a firing parked at the cap names what blocks a wrap, and stopping its run while paused sets it aside at once', E2E, async (t) => {
  const d = await intakeDesk()
  t.after(() => d.stop())
  const { goal, run } = await working(d)
  const prefs = await d.host.call('trigger/preferences', {})
  const lowered = await d.host.call('trigger/preferences/set', { revision: prefs.revision, paused: false, dailyUsd: 1 })
  await until(async () => (await execution(d, run)).intake?.heldFor ? true : null, 'held by the cap')
  // A new head arrives, and waits at the cap.
  d.forge.pulls[0] = { ...d.forge.pulls[0]!, head: sha('b'), updated: d.clocks.wall + 1000 }
  d.clocks.advance(60_000)
  await d.host.intakePlane.tick()
  const blocked = d.host.intakePlane.held(goal)
  assert.equal(typeof blocked, 'string')
  assert.match(blocked as string, /is waiting \(Today’s trigger spend cap is lower than what is already committed.*Stop this Goal's run to set that work aside/)
  // Paused too: nothing is tried again. Stopping the run is the person's act, and it clears the block by itself.
  await d.host.call('trigger/preferences/set', { revision: lowered.revision, paused: true, dailyUsd: 1 })
  // The person stops the run (a finding's Drop does exactly this), while triggers are paused.
  await d.host.flowsPlane.stopRun(run, 'the person stopped this flow')
  await until(() => d.host.intakePlane.journal.read().operations.length === 0 ? true : null, 'the parked firing set aside while paused')
  assert.equal(d.host.intakePlane.held(goal), false)
  const history = await d.host.call('trigger/history', { root: d.repo.dir, id: 'review' }) as TriggerHistoryPage
  assert.equal(history.items.find((one) => one.head === sha('b'))?.outcome, 'set-aside')
})
