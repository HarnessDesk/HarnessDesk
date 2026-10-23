import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'

import type { GoalView } from '@harnessdesk/protocol'

import { intakeDesk, REVIEW_FLOW, until, type IntakeDesk } from './fixtures/intake-host.js'
import { sha } from './fixtures/intake-forge.js'

const E2E = { timeout: 120_000 } as const

const working = async (d: IntakeDesk, count = 1) => {
  if (count !== 1) {
    await writeFile(join(d.repo.dir, '.harnessdesk', 'flows', 'review-pr.yml'), REVIEW_FLOW.replace('grant: read', `grant: read, count: ${count}`))
    await d.repo.git('add', '.')
    await d.repo.git('commit', '-q', '-m', 'declare the review seats')
  }
  const preview = await d.host.call('trigger/preview', { root: d.repo.dir, id: 'review' })
  assert.ok(preview.token, JSON.stringify(preview.problems))
  await d.host.call('trigger/arm', { root: d.repo.dir, id: 'review', token: preview.token })
  const at = d.clocks.wall + 1000
  d.forge.pulls.push({ number: 1, head: sha('a'), state: 'open', created: at, updated: at })
  d.clocks.advance(60_000)
  await d.host.intakePlane.tick()
  const goal = await until(() => Object.keys(d.host.intakePlane.journal.read().budgets)[0], 'the trigger budget')
  const records = await until(async () => {
    const view = await d.host.call('goal/read', { goal }) as GoalView
    const sessions = view.board.intents.flatMap((card) => card.claim ? [card.claim.sessionId] : [])
    const found = d.host.registry.all().filter((record) => sessions.includes(String(record.session.id)) && record.running.size > 0)
    return found.length === count ? found : null
  }, 'the trigger turns')
  return { goal, records }
}

const failInterrupts = (records: Awaited<ReturnType<typeof working>>['records'], control: { fail: boolean; attempts: number }) => {
  for (const record of records) {
    const interrupt = record.live!.interrupt.bind(record.live)
    record.live!.interrupt = async () => {
      control.attempts++
      if (control.fail) throw new Error('runtime interrupt failed')
      await interrupt()
    }
  }
}

for (const kind of ['pause', 'cap'] as const) test(`a ${kind} hold retries failed interruptions until every turn ends`, E2E, async (t) => {
  const d = await intakeDesk()
  const control = { fail: true, attempts: 0 }
  t.after(() => { control.fail = false; return d.stop() })
  const { goal, records } = await working(d, 2)
  failInterrupts(records, control)
  const prefs = await d.host.call('trigger/preferences', {})
  await assert.rejects(d.host.call('trigger/preferences/set', {
    revision: prefs.revision, paused: kind === 'pause', dailyUsd: kind === 'cap' ? 1 : prefs.dailyUsd,
  }), /cleanup failed/i)
  const run = () => d.host.flowsPlane.executionsFor(goal)[0]!
  assert.ok(run().intake?.heldFor)
  assert.equal(d.host.intakePlane.journal.read().budgets[goal]!.stop, null)
  const timer = [...d.timers.live.values()].find((one) => one.ms === 1000)
  assert.ok(timer, 'failed hold interruption keeps a cleanup timer even while paused')
  for (let sweep = 0; sweep < 3; sweep++) {
    const before = control.attempts
    await d.host.intakePlane.tick().catch(() => {})
    assert.ok(control.attempts > before, 'a saved hold does not skip unfinished interruption')
    assert.ok(records.every((record) => record.running.size > 0))
  }
  control.fail = false
  timer.fn()
  await until(() => records.every((record) => record.running.size === 0) ? true : null, 'held turns interrupted by the timer')
  await d.host.intakePlane.tick()
  const completed = control.attempts
  await d.host.intakePlane.tick()
  assert.equal(control.attempts, completed, 'successful hold interruption is not repeated')
  assert.equal(run().state, 'running')
  assert.ok(run().intake?.heldFor)
  assert.equal(d.host.intakePlane.journal.read().budgets[goal]!.stop, null)
  if (kind === 'pause') await until(() => d.timers.live.size === 0 ? true : null, 'the completed paused cleanup timer retired')
  const current = await d.host.call('trigger/preferences', {})
  await d.host.call('trigger/preferences/set', { revision: current.revision, paused: false, dailyUsd: 20 })
  await until(() => records.every((record) => record.running.size > 0) ? true : null, 'held work resumed')
})

test('a paused hold keeps pending interruption through a restart', E2E, async (t) => {
  let d = await intakeDesk()
  const control = { fail: true, attempts: 0 }
  t.after(() => { control.fail = false; return d.stop() })
  const { goal, records } = await working(d)
  failInterrupts(records, control)
  const prefs = await d.host.call('trigger/preferences', {})
  await assert.rejects(d.host.call('trigger/preferences/set', { revision: prefs.revision, paused: true, dailyUsd: prefs.dailyUsd }), /cleanup failed/i)
  control.fail = false
  await d.stop()
  d = await intakeDesk({ repo: d.repo, stateDir: d.stateDir, forge: d.forge, clocks: d.clocks })
  const [timer] = [...d.timers.live.values()]
  assert.equal(d.timers.live.size, 1, 'only the pending interruption is scheduled while paused')
  assert.equal(timer?.ms, 1000)
  const reads = d.forge.calls.length
  timer!.fn()
  await until(() => d.timers.live.size === 0 ? true : null, 'the restored hold interruption completed')
  assert.equal(d.forge.calls.length, reads)
  assert.equal(d.host.intakePlane.journal.read().budgets[goal]!.stop, null)
})

test('raising the cap waits for the pending hold interruption before releasing dispatch', E2E, async (t) => {
  const d = await intakeDesk()
  const control = { fail: true, attempts: 0 }
  t.after(() => { control.fail = false; return d.stop() })
  const { goal, records } = await working(d)
  failInterrupts(records, control)
  let prefs = await d.host.call('trigger/preferences', {})
  await assert.rejects(d.host.call('trigger/preferences/set', { revision: prefs.revision, paused: false, dailyUsd: 1 }), /cleanup failed/i)
  prefs = await d.host.call('trigger/preferences', {})
  await d.host.call('trigger/preferences/set', { revision: prefs.revision, paused: false, dailyUsd: 20 }).catch(() => {})
  const run = () => d.host.flowsPlane.executionsFor(goal)[0]!
  assert.equal(run().intake?.dispatchHeld, true, 'the raised cap cannot release unfinished interruption')
  control.fail = false
  await d.host.intakePlane.tick()
  await until(() => run().intake?.dispatchHeld === false ? true : null, 'dispatch released after interruption')
  assert.equal(d.host.intakePlane.journal.read().budgets[goal]!.stop, null)
})

for (const kind of ['pause', 'cap'] as const) test(`a later ${kind} hold requires its own interruption completion`, E2E, async (t) => {
  const d = await intakeDesk()
  const control = { fail: false, attempts: 0 }
  t.after(() => { control.fail = false; return d.stop() })
  const { goal, records } = await working(d)
  const run = () => d.host.flowsPlane.executionsFor(goal)[0]!
  let prefs = await d.host.call('trigger/preferences', {})
  await d.host.call('trigger/preferences/set', { revision: prefs.revision, paused: kind === 'pause', dailyUsd: kind === 'cap' ? 1 : 20 })
  const reason = run().intake!.heldFor!
  prefs = await d.host.call('trigger/preferences', {})
  await d.host.call('trigger/preferences/set', { revision: prefs.revision, paused: false, dailyUsd: 20 })
  await until(() => records[0]!.running.size > 0 ? true : null, 'the first hold released')
  control.fail = true
  failInterrupts(records, control)
  // The run can observe a hold before the budget sweep, so its marker alone cannot reuse an earlier completion.
  await d.host.flowsPlane.holdTriggered(run().id, reason)
  const before = control.attempts
  prefs = await d.host.call('trigger/preferences', {})
  await assert.rejects(d.host.call('trigger/preferences/set', {
    revision: prefs.revision, paused: kind === 'pause', dailyUsd: kind === 'cap' ? 1 : 20,
  }), /cleanup failed/i)
  assert.ok(control.attempts > before)
  assert.ok(records[0]!.running.size > 0)
  control.fail = false
  await d.host.intakePlane.tick()
  await until(() => records[0]!.running.size === 0 ? true : null, 'the later hold interrupted')
})

test('unpausing resumes source monitoring even while hold interruption still needs retrying', E2E, async (t) => {
  const d = await intakeDesk()
  const control = { fail: true, attempts: 0 }
  t.after(() => { control.fail = false; return d.stop() })
  const { records } = await working(d)
  failInterrupts(records, control)
  let prefs = await d.host.call('trigger/preferences', {})
  await assert.rejects(d.host.call('trigger/preferences/set', { revision: prefs.revision, paused: true, dailyUsd: prefs.dailyUsd }), /cleanup failed/i)
  prefs = await d.host.call('trigger/preferences', {})
  await assert.rejects(d.host.call('trigger/preferences/set', { revision: prefs.revision, paused: false, dailyUsd: prefs.dailyUsd }), /cleanup failed/i)
  const source = [...d.timers.live.values()].find((one) => one.ms === 15_000)
  assert.ok(source, 'source monitoring follows the saved unpaused setting')
  const reads = d.forge.calls.length
  d.clocks.advance(60_000)
  source.fn()
  await until(() => d.forge.calls.length > reads ? true : null, 'the source read while cleanup remains pending')
  assert.ok(records[0]!.running.size > 0)
})

test('a budget stop retries every failed runtime interruption before completing cleanup', E2E, async (t) => {
  const d = await intakeDesk()
  let fail = true
  t.after(() => { fail = false; return d.stop() })
  const { goal, records } = await working(d, 2)
  const attempts = records.map(() => 0)
  for (const [index, record] of records.entries()) {
    const interrupt = record.live!.interrupt.bind(record.live)
    record.live!.interrupt = async () => {
      attempts[index]!++
      if (fail) throw new Error('runtime interrupt failed')
      await interrupt()
    }
  }
  d.clocks.advance(5 * 3_600_000)
  await assert.rejects(d.host.intakePlane.tick(), /cleanup failed/i)
  assert.ok(attempts.every((count) => count >= 2), 'the run stop and Goal interruption each attempt every Seat')
  assert.equal(d.host.intakePlane.journal.read().budgets[goal]!.stopCompleted, false)
  assert.ok(records.every((record) => record.running.size > 0))
  const before = [...attempts]
  fail = false
  await d.host.intakePlane.tick()
  assert.ok(attempts.every((count, index) => count > before[index]!))
  assert.equal(d.host.intakePlane.journal.read().budgets[goal]!.stopCompleted, true)
  await until(() => records.every((record) => record.running.size === 0) ? true : null, 'all turns interrupted')
  const completed = [...attempts]
  await d.host.intakePlane.tick()
  assert.deepEqual(attempts, completed)
})

for (const phase of ['disarmed', 'restarted', 'paused'] as const) test(`pending budget cleanup keeps its own timer while ${phase}`, E2E, async (t) => {
  let d = await intakeDesk()
  let fail = true
  t.after(() => { fail = false; return d.stop() })
  const { goal, records } = await working(d)
  const stop = d.host.flowsPlane.stopRun.bind(d.host.flowsPlane)
  d.host.flowsPlane.stopRun = async (...args) => {
    if (fail) throw new Error('run stop failed')
    return stop(...args)
  }
  const interrupt = records[0]!.live!.interrupt.bind(records[0]!.live)
  records[0]!.live!.interrupt = async () => {
    if (fail) throw new Error('runtime interrupt failed')
    await interrupt()
  }
  d.clocks.advance(5 * 3_600_000)
  await assert.rejects(d.host.intakePlane.tick(), /cleanup failed/i)
  assert.equal(d.host.intakePlane.journal.read().budgets[goal]!.stopCompleted, false)
  assert.ok(records[0]!.running.size > 0)
  await d.host.call('trigger/disarm', { root: d.repo.dir, id: 'review' })
  if (phase === 'restarted') {
    fail = false
    await d.stop()
    d = await intakeDesk({ repo: d.repo, stateDir: d.stateDir, forge: d.forge, clocks: d.clocks })
  } else if (phase === 'paused') {
    const prefs = await d.host.call('trigger/preferences', {})
    await assert.rejects(d.host.call('trigger/preferences/set', { revision: prefs.revision, paused: true, dailyUsd: prefs.dailyUsd }), /cleanup failed/i)
  }
  const [timer] = [...d.timers.live.values()]
  assert.equal(d.timers.live.size, 1, 'only cleanup is scheduled without an arm or a live budget')
  assert.equal(timer?.ms, 1000)
  const reads = d.forge.calls.length
  fail = false
  timer!.fn()
  await until(() => d.host.intakePlane.journal.read().budgets[goal]!.stopCompleted ? true : null, 'pending cleanup completed by its timer')
  await until(() => d.timers.live.size === 0 ? true : null, 'the cleanup timer retired')
  assert.equal(d.forge.calls.length, reads, 'cleanup reads no source')
})
