import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'

import type { GoalView, TriggerArmPreview, TriggerHistoryPage, TriggerProjectView, TriggerView } from '@harnessdesk/protocol'

import { makeRepo } from './fixtures/evidence-desk.js'
import { commitTriggers, intakeDesk, type IntakeDesk } from './fixtures/intake-host.js'
import { sha } from './fixtures/intake-forge.js'

/*
 * The controls a person has over an armed trigger that went wrong (review
 * #898): a source stopped at a gap resumes from now through a real control,
 * and an arm that changed or was refused can still be switched off — after
 * which none of its facts is offered at all.
 */

const E2E = { timeout: 120_000 } as const

const TRIAGE = `- id: triage
  on: issue
  events: [labelled]
  label: ready
  opens: { flow: review-pr }
`

const arm = async (d: IntakeDesk, id: string): Promise<void> => {
  const preview = await d.host.call('trigger/preview', { root: d.repo.dir, id }) as TriggerArmPreview
  assert.deepEqual(preview.problems, [])
  await d.host.call('trigger/arm', { root: d.repo.dir, id, token: preview.token! })
}

const view = async (d: IntakeDesk, id: string): Promise<TriggerView> =>
  (await d.host.call('trigger/list', { root: d.repo.dir }) as TriggerProjectView).triggers.find((one) => one.id === id)!

test('a source stopped at a gap watches from now through its control, and the gap is not replayed', E2E, async (t) => {
  const repo = await makeRepo('hd-intake-gap-')
  await commitTriggers(repo, TRIAGE)
  const d = await intakeDesk({ repo })
  t.after(() => d.stop())
  await arm(d, 'triage')
  await assert.rejects(d.host.call('trigger/rebaseline', { root: repo.dir, id: 'triage' }), /not stopped at a gap/, 'a source that reads is left alone')

  // More issues changed than one read can cover: the source stops at a gap.
  const at = d.clocks.wall + 1000
  for (let number = 1; number <= 101; number += 1) {
    d.forge.issues.push({ number, state: 'open', created: at, updated: at + number, events: [{ id: 1000 + number, event: 'labeled', created: at, label: 'ready' }], comments: [] })
  }
  d.clocks.advance(60_000)
  await d.host.intakePlane.tick()
  const stopped = await view(d, 'triage')
  assert.equal(stopped.source?.state, 'gap', 'the list says the source stopped at a gap')
  assert.match(stopped.source?.fix ?? '', /watch from now/i)

  const resumed = await d.host.call('trigger/rebaseline', { root: repo.dir, id: 'triage' }) as TriggerView
  assert.equal(resumed.source?.state, 'watching')
  d.clocks.advance(60_000)
  await d.host.intakePlane.tick()
  const goals = (await d.host.call('goal/list', {}) as readonly GoalView[]).filter((one) => one.goal.origin.kind === 'trigger')
  assert.deepEqual(goals, [], 'nothing in the gap is replayed')

  // What happens after it resumed fires as usual.
  const later = d.clocks.wall + 1000
  d.forge.issues.push({ number: 500, state: 'open', created: later, updated: later, events: [{ id: 9001, event: 'labeled', created: later, label: 'ready' }], comments: [] })
  d.clocks.advance(60_000)
  await d.host.intakePlane.tick()
  const page = await d.host.call('trigger/history', { root: repo.dir, id: 'triage' }) as TriggerHistoryPage
  assert.deepEqual(page.items.map((one) => [one.subject, one.outcome]), [['500', 'fired']])
})

test('a changed or refused arm can be switched off, and none of its facts is offered after', E2E, async (t) => {
  const d = await intakeDesk()
  t.after(() => d.stop())
  await arm(d, 'review')
  // The committed file changes: the arm no longer stands.
  await writeFile(join(d.repo.dir, '.harnessdesk', 'triggers.yml'), `# edited\n${(await import('./fixtures/intake-host.js')).TRIGGERS}`)
  await d.repo.git('commit', '-q', '-am', 'edit the triggers')
  const changed = await view(d, 'review')
  assert.equal(changed.state, 'changed')

  const off = await d.host.call('trigger/disarm', { root: d.repo.dir, id: 'review' }) as TriggerView
  assert.equal(off.state, 'off', 'a changed arm is switched off like any other')
  const reads = d.forge.calls.length
  const at = d.clocks.wall + 1000
  d.forge.pulls.push({ number: 1, head: sha('a'), state: 'open', created: at, updated: at })
  d.clocks.advance(60_000)
  await d.host.intakePlane.tick()
  const page = await d.host.call('trigger/history', { root: d.repo.dir, id: 'review' }) as TriggerHistoryPage
  assert.deepEqual(page.items, [], 'not even recorded as skipped: it is not offered')
  assert.equal(d.forge.calls.length, reads, 'and its source is not read')

  // A refused arm — its signature no longer verifies on this machine — is switched off the same way.
  await arm(d, 'review')
  const machine = join(d.stateDir, 'triggers-machine.json')
  const document = JSON.parse(await (await import('node:fs/promises')).readFile(machine, 'utf8')) as { arms: { signature: string }[] }
  document.arms[0]!.signature = '0'.repeat(64)
  await writeFile(machine, JSON.stringify(document))
  assert.equal((await view(d, 'review')).state, 'refused')
  assert.equal((await d.host.call('trigger/disarm', { root: d.repo.dir, id: 'review' }) as TriggerView).state, 'off')
})
