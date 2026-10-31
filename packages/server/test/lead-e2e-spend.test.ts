import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createLeadRig } from './fixtures/lead-rig.js'

// Every case owns the actual host, child, restricted door, journal and Flow engine.
// These assertions must also hold when guards are deliberately removed locally.
// One of the Lead end-to-end files (stale spend readings, gate declines, and interruptions during a paid request); they share only the rig,
// so CI runs them side by side, and the cases of each run one at a time.

test('a person who decides after the spend reading has aged out is not refused for stale spend', async t => {
  const rig = await createLeadRig({ freshnessMs: 10_000 }); t.after(() => rig.dispose())
  await rig.reviewed()
  // The workers are quiet now, so nothing on the desk meters them again on its own.
  await new Promise(resolve => setTimeout(resolve, 11_000))
  await rig.decide(rig.pending('result')!, 'accept')
  assert.equal(rig.journal.state.phase, 'accepted')
  await rig.assertNoForbiddenEffects()
})

test('gate decline preserves both worktrees and committed changes without forbidden effects', async t => {
  const rig = await createLeadRig(); t.after(() => rig.dispose())
  await rig.reviewed()
  const paths = rig.worktrees()
  assert.ok(paths.length >= 2)
  const contents = await Promise.all(paths.map(path => readFile(join(path, 'retry.txt'), 'utf8')))
  await rig.decide(rig.pending('result')!, 'decline')
  assert.equal(rig.journal.state.phase, 'declined')
  assert.deepEqual(await Promise.all(paths.map(path => readFile(join(path, 'retry.txt'), 'utf8'))), contents)
  await rig.assertNoForbiddenEffects()
})

for (const interruption of ['child-crash', 'host-restart', 'connection-gap'] as const) test(`full fixture ${interruption} during a running paid request preserves approval, caps and accounting`, async t => {
  const rig = await createLeadRig({ holdWorkers: true, holdRunning: true }); t.after(() => rig.dispose())
  await rig.sendGoal(); await rig.waitFor(() => !!rig.pending('plan'), 'plan')
  const plan = rig.pending('plan')!
  await rig.decide(plan, 'approve')
  await rig.waitFor(() => rig.journal.state.runs.length > 0 && rig.provider.pending, 'running Flow with a reserved paid request')
  await rig.workerWaiting()
  await rig.reachCap('rounds')
  const before = await rig.dispatchCounts()
  await rig.interruptAt(interruption)
  rig.provider.release(); await rig.releaseWorkers(); await rig.settle()
  await assert.rejects(rig.decide(plan, 'approve'), 'old plan clicks cannot grant another start')
  await rig.host.call('lead/resume', { expectedRevision: rig.journal.state.seq }).catch(() => {})
  await rig.settle()
  assert.deepEqual(await rig.dispatchCounts(), before, 'recovery cannot pay or dispatch another round at the cap')
  // Recovery removes terminal runs from live ownership; history still proves
  // exactly one real execution and one charged start, with no replacement.
  const executions = await rig.host.call('flow/executions', { project: rig.project.path, active: false })
  assert.equal(executions.length, 1)
  assert.deepEqual(rig.journal.state.budget!.executionIds, [executions[0]!.id])
  assert.equal(rig.journal.state.steps.filter(step => step.state === 'started').length, 1)
  await rig.assertAccounting(); await rig.assertNoForbiddenEffects()
})
