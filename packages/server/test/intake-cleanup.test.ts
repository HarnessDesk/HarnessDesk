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
