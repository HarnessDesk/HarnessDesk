import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { FlowExecution, GoalView, TriggerArmPreview, TriggerHistoryPage, TriggerProjectView } from '@harnessdesk/protocol'

import { intakeDesk, until, type IntakeDesk } from './fixtures/intake-host.js'
import { sha } from './fixtures/intake-forge.js'

/*
 * An arm is consent to what runs, never a promise that it can run this
 * minute (plan decision 4, review #898). A runtime that is down or a forge
 * sign-in that blinks is no answer to a fact: the fact is kept, or its
 * firing waits at dispatch, and the work starts once the world is back —
 * never consumed as "changed since armed". And the arming preview seats as
 * unattended work is seated, so it shows what will actually run.
 */

const E2E = { timeout: 120_000 } as const

const triggerGoals = async (d: IntakeDesk): Promise<readonly GoalView[]> =>
  (await d.host.call('goal/list', {}) as readonly GoalView[]).filter((view) => view.goal.origin.kind === 'trigger')

const history = async (d: IntakeDesk, id = 'review'): Promise<TriggerHistoryPage> =>
  await d.host.call('trigger/history', { root: d.repo.dir, id }) as TriggerHistoryPage

const claimed = async (d: IntakeDesk, goal: string): Promise<number> =>
  (await d.host.call('goal/read', { goal }) as GoalView).board.intents.filter((card) => card.state === 'claimed').length

const arm = async (d: IntakeDesk, id = 'review'): Promise<void> => {
  const preview = await d.host.call('trigger/preview', { root: d.repo.dir, id }) as TriggerArmPreview
  assert.deepEqual(preview.problems, [], `${id} previews clean`)
  await d.host.call('trigger/arm', { root: d.repo.dir, id, token: preview.token! })
}

const pushPull = (d: IntakeDesk, number: number, seed: string): void => {
  const at = d.clocks.wall + 1000
  d.forge.pulls.push({ number, head: sha(seed), state: 'open', created: at, updated: at })
}

const reads = (d: IntakeDesk, what: 'user' | 'repo view'): number =>
  d.forge.argv.filter((args) => (what === 'user' ? args.at(-1) === 'user' : args[0] === 'repo' && args[1] === 'view')).length

test('a runtime briefly down holds the firing at dispatch; it starts once the runtime is back', E2E, async (t) => {
  const d = await intakeDesk()
  t.after(() => d.stop())
  await arm(d)
  d.runtime.setHealth({ state: 'unavailable', reason: 'crashed', message: 'crashed' })
  pushPull(d, 1, 'a')
  d.clocks.advance(60_000)
  await d.host.intakePlane.tick()

  const waiting = await history(d)
  assert.equal(waiting.items.length, 1, 'the fact was answered once')
  assert.equal(waiting.items[0]!.outcome, 'pending', 'fired and waiting, never skipped as changed')
  assert.match(waiting.items[0]!.reason ?? '', /No seat can be opened/)
  const listed = await d.host.call('trigger/list', { root: d.repo.dir }) as TriggerProjectView
  assert.equal(listed.triggers[0]!.state, 'armed', 'the arm still stands')
  const [goal] = await triggerGoals(d)
  assert.ok(goal, 'its Goal exists')
  assert.equal(await claimed(d, goal.goal.id), 0, 'nobody is seated while no seat can be taken')
  const run = (await d.host.call('flow/execution', { run: waiting.items[0]!.run! }) as FlowExecution)
  assert.equal(run.intake?.dispatchHeld, true)
  assert.ok((await d.host.call('trigger/goal', { goal: goal.goal.id }))!.waits.some((one) => /No seat can be opened/.test(one.sentence)), 'the wait is named')

  d.runtime.setHealth({ state: 'ready' })
  d.clocks.advance(60_000)
  await d.host.intakePlane.tick()
  await until(async () => (await claimed(d, goal.goal.id)) === 1 ? true : null, 'the card claimed once the runtime is back')
  const after = await history(d)
  assert.deepEqual(after.items.map((one) => one.outcome), ['fired'])
  assert.equal((await triggerGoals(d)).length, 1, 'one Goal, never a second')
})

test('a forge sign-in that blinks keeps the fact; it fires once the sign-in is back', E2E, async (t) => {
  const d = await intakeDesk()
  t.after(() => d.stop())
  await arm(d)
  const user = d.forge.user
  d.forge.user = null
  pushPull(d, 1, 'a')
  d.clocks.advance(60_000)
  await d.host.intakePlane.tick()
  assert.deepEqual((await history(d)).items, [], 'nothing answered, nothing consumed')
  assert.deepEqual(await triggerGoals(d), [])

  d.forge.user = user
  d.clocks.advance(60_000)
  await d.host.intakePlane.tick()
  const goals = await until(async () => { const found = await triggerGoals(d); return found.length === 1 ? found : null }, 'the Goal once signed in again')
  assert.deepEqual((await history(d)).items.map((one) => one.outcome), ['fired'])
  await until(async () => (await claimed(d, goals[0]!.goal.id)) === 1 ? true : null, 'its card claimed')
})

test('a batch of facts reads the arm once, not once per fact', E2E, async (t) => {
  const d = await intakeDesk()
  t.after(() => d.stop())
  await arm(d)
  pushPull(d, 1, 'a')
  pushPull(d, 2, 'b')
  pushPull(d, 3, 'c')
  const before = { user: reads(d, 'user'), view: reads(d, 'repo view') }
  d.clocks.advance(60_000)
  await d.host.intakePlane.tick()
  assert.equal((await history(d)).items.length, 3, 'all three answered')
  assert.equal(reads(d, 'user') - before.user, 1, 'who is signed in was asked once')
  assert.equal(reads(d, 'repo view') - before.view, 1, 'the repository was asked once')
})

test('the arming preview seats as unattended work is seated: refuse by default, seat only when a person chose it', E2E, async (t) => {
  // A runtime that can only ask its ceiling, under the shipped default.
  const asks = await intakeDesk({ runtime: 'asks' })
  t.after(() => asks.stop())
  const refused = await asks.host.call('trigger/preview', { root: asks.repo.dir, id: 'review' }) as TriggerArmPreview
  assert.equal(refused.token, null, 'nothing is armed that every firing would refuse to seat')
  assert.match(refused.problems.map((one) => one.text).join('\n'), /No seat could be opened/)
  assert.deepEqual(refused.flow?.seats[0]?.plan.candidates.map((one) => one.state), ['passed'], 'the preview shows the refusal a firing would meet')

  // The one explicit case: a person lets unattended Seats sit on an asked ceiling.
  await asks.host.call('app/state/set', { patch: { unheldCeilings: { unattended: 'seat' } } })
  await arm(asks)
  pushPull(asks, 1, 'a')
  asks.clocks.advance(60_000)
  await asks.host.intakePlane.tick()
  const [goal] = await until(async () => { const found = await triggerGoals(asks); return found.length === 1 ? found : null }, 'the Goal')
  await until(async () => (await claimed(asks, goal!.goal.id)) === 1 ? true : null, 'seated as the person chose')

  // A runtime that holds the ceiling: the shipped default arms and seats.
  const holds = await intakeDesk()
  t.after(() => holds.stop())
  await arm(holds)
  pushPull(holds, 1, 'a')
  holds.clocks.advance(60_000)
  await holds.host.intakePlane.tick()
  const [held] = await until(async () => { const found = await triggerGoals(holds); return found.length === 1 ? found : null }, 'the Goal')
  await until(async () => (await claimed(holds, held!.goal.id)) === 1 ? true : null, 'seated under the default')
})

test('a firing no seat can ever take as things stand is set aside with the change it needs, its slot and reservation given back', E2E, async (t) => {
  // Armed while this Mac seated unattended work on an asked ceiling; then the person went back to refusing it.
  const d = await intakeDesk({ runtime: 'asks' })
  t.after(() => d.stop())
  await d.host.call('app/state/set', { patch: { unheldCeilings: { unattended: 'seat' } } })
  await arm(d)
  await d.host.call('app/state/set', { patch: { unheldCeilings: { unattended: 'refuse' } } })
  pushPull(d, 1, 'a')
  d.clocks.advance(60_000)
  await d.host.intakePlane.tick()
  const first = await history(d)
  assert.deepEqual(first.items.map((one) => one.outcome), ['set-aside'], 'not a wait that says it starts on its own')
  assert.match(first.items[0]!.reason ?? '', /No seat can ever be opened for “reviewer” as things stand.*Permissions › Ceilings/)
  assert.doesNotMatch(first.items[0]!.reason ?? '', /starts on its own/)
  assert.equal((await d.host.call('trigger/preferences', {})).reservedUsd, 0, 'its reservation is given back')
  const run = await d.host.call('flow/execution', { run: first.items[0]!.run! }) as FlowExecution
  // Its slot and reservation were given back, so its run is stopped: nothing can spend under what no longer counts.
  assert.equal(run.state, 'stopped', 'its run is stopped, never left to spend uncounted')
  // Its concurrency slot is given back: the next pull request is answered, not skipped for the limit.
  pushPull(d, 2, 'b')
  d.clocks.advance(60_000)
  await d.host.intakePlane.tick()
  const second = (await history(d)).items.find((one) => one.subject === '2')
  assert.equal(second?.outcome, 'set-aside')
  assert.doesNotMatch(second?.reason ?? '', /its limit/)
})
