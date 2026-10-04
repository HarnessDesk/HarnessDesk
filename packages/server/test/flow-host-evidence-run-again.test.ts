import assert from 'node:assert/strict'
import { mkdir, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'

import { desk, E2E, settled } from './fixtures/flow-host-evidence.js'

const FLOW = `version: 2
name: Check the Team checkout
roles:
  person: { kind: person, outcomes: [done] }
  check: { kind: check, run: pwd, exits: { "0": pass }, otherwise: fail }
seed: { role: person, title: Begin }
rules:
  - { id: check, on: person, then: { role: check, title: Check } }
`

test('the wire continuation previews the retained Team checkout and runs its check there', E2E, async t => {
  const d = await desk(t)
  const retained = join(d.root, 'retained')
  await mkdir(retained)
  const goal = await d.host.call('goal/create', { root: d.root, cwd: retained, sentence: 'Check this checkout' })
  const { root, cwd } = goal.goal
  const binding = { id: goal.goal.id, revision: goal.goal.revision }
  const dry = await d.host.call('authoring/start/preview', { context: { kind: 'project', root }, source: FLOW, vars: {}, goal: binding })
  assert.ok(dry.flow.token, JSON.stringify(dry.flow.problems))
  const earlier = await d.host.call('flow/start-goal', { root, source: FLOW, sentence: 'Check this checkout', token: dry.flow.token, goal: binding })
  d.runs.push(earlier.id)
  await d.host.call('flow/execution/stop', { run: earlier.id, reason: 'Start a fresh Run' })
  const params = { root, source: FLOW, continues: earlier.id }
  const preview = await d.host.call('flow/preview', params)
  assert.ok(preview.token, JSON.stringify(preview.problems))
  assert.equal(preview.commands[0]!.cwd, cwd)
  await assert.rejects(d.host.call('flow/start-goal', { root, source: FLOW, sentence: 'Another Team', token: preview.token }), /Review the dry run again/)
  const fresh = await d.host.call('flow/preview', params)
  const held = await d.host.call('flow/preview', params)
  assert.ok(held.token)
  const next = await d.host.call('flow/start-goal', { ...params, sentence: 'Check this checkout', token: fresh.token! })
  d.runs.push(next.id)
  assert.equal(next.goal, earlier.goal)
  await d.host.teamPlane.intentAction(next.goal, next.rounds[0]!.cards[0]!, 'done', undefined, 'done')
  const finished = await settled(d, next.id)
  assert.equal(finished.state, 'settled')
  const evidence = await d.host.call('evidence/board', { room: next.goal })
  const checks = evidence.cards.flatMap(card => card.facts).map(one => one.record.fact).filter(one => one.kind === 'check')
  const actual = await realpath(cwd)
  assert.ok(checks.some(fact => fact.exit === 0 && fact.tail.trim() === actual), JSON.stringify(checks))
  const stale = await d.host.call('flow/preview', params)
  assert.equal(stale.token, null, 'a superseded Run cannot preview another successor')
  assert.ok(stale.problems.some(one => /newer Run/.test(one.text)), JSON.stringify(stale.problems))
  await assert.rejects(d.host.call('flow/start-goal', { ...params, sentence: 'Stale consent', token: held.token }), /Review the dry run again/)
  const current = { root, source: FLOW, continues: next.id }
  const currentPreview = await d.host.call('flow/preview', current)
  assert.ok(currentPreview.token, JSON.stringify(currentPreview.problems))
  const third = await d.host.call('flow/start-goal', { ...current, sentence: 'Continue current work', token: currentPreview.token })
  d.runs.push(third.id)
  assert.equal(third.continues, next.id)
  assert.equal(third.goal, earlier.goal)
})
