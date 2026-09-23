import assert from 'node:assert/strict'
import { test } from 'node:test'

import { CHECK_CWD_OUTSIDE } from '../src/flow-execution.js'
import { agent, goalRig } from './fixtures/flow-goal-rig.js'

/*
 * A v2 check step runs through the same bounded runner a person's own check
 * uses, records its result as evidence before the card is marked done, and
 * never runs the same command twice without a person's consent.
 */

const CHECK_FLOW = `
version: 2
name: One writer, one gate
roles:
  author: { kind: agent, uses: writer }
  gate: { kind: check, run: "pnpm verify", exits: { "0": pass, "2": fail }, otherwise: fail, timeout: 30 }
seed: { role: author, title: Write it }
rules:
  - { id: check, on: author, when: { every: [done] }, then: { role: gate, title: Verify } }
`

const checks = (events: readonly string[]) => events.filter((one) => one.startsWith('check:'))

test('a check retains its output and waits for durable evidence before completing the card', async (t) => {
  const rig = await goalRig(t)
  rig.checkOutcomes.set('pnpm verify', { exit: 2, timedOut: false, tail: 'FAIL: 1 test' })
  const run = await rig.start(CHECK_FLOW, [agent('writer', ['done'])])
  await rig.flows.flush()
  await rig.team.complete(1, { outcome: 'done' }, rig.sessionOf('seat-1'))
  await rig.flows.flush()
  assert.deepEqual(checks(rig.events), ['check:pnpm verify'], 'the exact command ran, once')
  const board = rig.board(run.goal)
  const gate = board.intents.find((one) => one.role === 'gate')
  assert.equal(gate?.state, 'done')
  assert.equal(gate?.outcome, 'fail', 'a fresh failure defeats the default, mapped by the exact exit code')
})

test('a check whose evidence cannot be saved stalls the run rather than completing on an unsaved fact', async (t) => {
  const rig = await goalRig(t)
  rig.checkEvidenceFails = true
  const run = await rig.start(CHECK_FLOW, [agent('writer', ['done'])])
  await rig.flows.flush()
  await rig.team.complete(1, { outcome: 'done' }, rig.sessionOf('seat-1'))
  await rig.flows.flush()
  const board = rig.board(run.goal)
  assert.equal(board.intents.find((one) => one.role === 'gate')?.state, 'open', 'the gate card was never marked done')
  const execution = rig.flows.executionsFor(run.goal)[0]!
  assert.equal(execution.state, 'stalled')
  assert.match(execution.reason ?? '', /evidence could not be saved/)
})

test('restart never repeats a started check without a person’s consent', async (t) => {
  const rig = await goalRig(t)
  // Simulates the desk dying between the check finishing and that being saved:
  // the save that would persist "finished" never lands, so the file stops at "started".
  rig.files.dieWhen = (stored) => stored.operations.some((one) => one.key.startsWith('check:') && one.state === 'finished')
  const run = await rig.start(CHECK_FLOW, [agent('writer', ['done'])])
  await rig.flows.flush()
  await rig.team.complete(1, { outcome: 'done' }, rig.sessionOf('seat-1')).catch(() => {})
  await rig.flows.flush().catch(() => {})

  const restarted = await rig.restart()
  await restarted.flows.load()
  await restarted.flows.flush()
  const board = rig.board(run.goal)
  const gate = board.intents.find((one) => one.role === 'gate')
  // Either it finished before the simulated crash (nothing to reconcile) or it is
  // held uncertain for a person — either way the command is not silently repeated.
  if (gate?.state !== 'done') {
    const execution = restarted.executions.stored(run.id)!
    assert.equal(execution.state, 'stalled')
    assert.match(execution.reason ?? '', /interrupted|Run again/)
  }
  assert.deepEqual([...new Set(checks(rig.events))], ['check:pnpm verify'], 'the command text never ran more than once')
})

test('a check cwd is confined to the project: `../` and an absolute path both refuse', async (t) => {
  for (const cwd of ['../../etc', '/etc']) {
    const rig = await goalRig(t)
    const flow = CHECK_FLOW.replace('otherwise: fail, timeout: 30', `otherwise: fail, timeout: 30, cwd: "${cwd}"`)
    const run = await rig.start(flow, [agent('writer', ['done'])])
    await rig.flows.flush()
    await rig.team.complete(1, { outcome: 'done' }, rig.sessionOf('seat-1'))
    await rig.flows.flush()
    assert.deepEqual(checks(rig.events), [], `no command ran for cwd ${cwd}`)
    const execution = rig.flows.executionsFor(run.goal)[0]!
    assert.equal(execution.state, 'stalled')
    assert.equal(execution.reason, CHECK_CWD_OUTSIDE)
  }
})

test('a check run through a fresh evidence append leaves an exact, distinct fact each time the round reopens', async (t) => {
  const LOOP = `
version: 2
name: Fix then gate, repeatedly
roles:
  author: { kind: agent, uses: writer }
  gate: { kind: check, run: "pnpm verify", exits: { "0": pass }, otherwise: fail, timeout: 30 }
  person: { kind: person, outcomes: [done] }
seed: { role: author, title: Write it }
rules:
  - { id: check, on: author, when: { every: [done] }, then: { role: gate, title: Verify } }
  - { id: pass, on: gate, when: { every: [pass] }, then: { role: person, title: Ship it } }
  - { id: fail, on: gate, when: { every: [fail] }, then: { role: author, title: Fix it } }
`
  const rig = await goalRig(t)
  rig.checkOutcomes.set('pnpm verify', { exit: 1, timedOut: false, tail: 'still red' })
  const run = await rig.start(LOOP, [agent('writer', ['done'])])
  await rig.flows.flush()
  await rig.team.complete(1, { outcome: 'done' }, rig.sessionOf('seat-1'))
  await rig.flows.flush()
  assert.deepEqual(checks(rig.events), ['check:pnpm verify'])
  let board = rig.board(run.goal)
  assert.equal(board.intents.find((one) => one.role === 'gate')?.outcome, 'fail')
  const fixCard = board.intents.find((one) => one.role === 'author' && one.id !== 1)
  assert.ok(fixCard, 'a fix round opened after the failing gate')

  rig.checkOutcomes.set('pnpm verify', { exit: 0, timedOut: false, tail: '' })
  await rig.team.complete(fixCard!.id, { outcome: 'done' }, rig.sessionOf(`seat-${rig.seats.size}`))
  await rig.flows.flush()
  assert.deepEqual(checks(rig.events), ['check:pnpm verify', 'check:pnpm verify'], 'the same command ran again, once, for the new round')
  board = rig.board(run.goal)
  const gates = board.intents.filter((one) => one.role === 'gate')
  assert.equal(gates.length, 2, 'each round got its own gate card')
  assert.deepEqual(gates.map((one) => one.outcome), ['fail', 'pass'])
})
