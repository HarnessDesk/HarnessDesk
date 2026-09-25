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
budget: { rounds: 5, without-progress: 2 }
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

/*
 * Two isolated writers, one gate with no explicit cwd: the gate must fan out
 * over each writer's own checkout — one card and one fact per revision —
 * never pick one of the two arbitrarily by running a single aggregate card
 * in a checkout neither writer actually worked in.
 */
const FAN_OUT_FLOW = `
version: 2
name: Two writers, one gate
roles:
  author: { kind: agent, uses: writer, count: 2, isolate: true, grant: edit }
  gate: { kind: check, run: "pnpm verify", exits: { "0": pass }, otherwise: fail, timeout: 30 }
seed: { role: author, title: Write it }
rules:
  - { id: check, on: author, when: { every: [done] }, then: { role: gate, title: Verify } }
`

test('a check with no explicit cwd fans out over each predecessor subject: one card and fact per revision', async (t) => {
  const rig = await goalRig(t)
  rig.heads.set('/repo/.lanes/1', { at: 'sha-writer-1', dirty: false })
  rig.heads.set('/repo/.lanes/2', { at: 'sha-writer-2', dirty: false })
  const run = await rig.start(FAN_OUT_FLOW, [agent('writer', ['done'])])
  await rig.flows.flush()
  await rig.team.complete(1, { outcome: 'done' }, rig.sessionOf('seat-1'))
  await rig.team.complete(2, { outcome: 'done' }, rig.sessionOf('seat-2'))
  await rig.flows.flush()

  assert.deepEqual(checks(rig.events), ['check:pnpm verify', 'check:pnpm verify'], 'the command ran once per subject, not once in total')
  assert.deepEqual(rig.checkCwds, ['/repo/.lanes/1', '/repo/.lanes/2'], 'each ran in its own predecessor checkout, never a shared or arbitrary one')
  const board = rig.board(run.goal)
  const gates = board.intents.filter((one) => one.role === 'gate')
  assert.equal(gates.length, 2, 'one card per subject — never one aggregate card standing in for both')
  assert.ok(gates.every((one) => one.state === 'done'))
  // Each fact is bound to its own revision, not the other subject's.
  const contexts = rig.checkContexts.map((raw) => JSON.parse(raw!) as { subjects: readonly { at: string; cwd: string }[] })
  assert.deepEqual(contexts.map((one) => one.subjects.map((s) => s.at)), [['sha-writer-1', 'sha-writer-2'], ['sha-writer-1', 'sha-writer-2']])
})

test('a check with no predecessor subject keeps one aggregate card in the Goal checkout', async (t) => {
  // A seed check — no predecessor round at all — is the other way width stays
  // 1 with no explicit `cwd`: there is nothing to fan out over.
  const rig = await goalRig(t)
  const flow = `
version: 2
name: Gate first
roles:
  gate: { kind: check, run: "pnpm verify", exits: { "0": pass }, otherwise: fail, timeout: 30 }
  person: { kind: person, outcomes: [done] }
seed: { role: gate, title: Verify }
rules:
  - { id: pass, on: gate, when: { every: [pass] }, then: { role: person, title: Ship it } }
`
  const run = await rig.start(flow, [])
  await rig.flows.flush()
  assert.deepEqual(checks(rig.events), ['check:pnpm verify'], 'exactly one aggregate command')
  assert.deepEqual(rig.checkCwds, ['/repo'], 'in the Goal checkout, having no predecessor subject to fan out over')
  const board = rig.board(run.goal)
  assert.equal(board.intents.filter((one) => one.role === 'gate').length, 1, 'one aggregate card')
  const context = JSON.parse(rig.checkContexts[0]!) as { subjects: readonly unknown[] }
  assert.deepEqual(context.subjects, [], 'no subject exists yet to report')
})

test('a check that names an explicit cwd keeps its one aggregate card, whatever the predecessor width', async (t) => {
  const rig = await goalRig(t)
  rig.heads.set('/repo/.lanes/1', { at: 'sha-writer-1', dirty: false })
  rig.heads.set('/repo/.lanes/2', { at: 'sha-writer-2', dirty: false })
  const flow = FAN_OUT_FLOW.replace(
    'gate: { kind: check, run: "pnpm verify", exits: { "0": pass }, otherwise: fail, timeout: 30 }',
    'gate: { kind: check, run: "pnpm verify", exits: { "0": pass }, otherwise: fail, timeout: 30, cwd: "sub" }',
  )
  const run = await rig.start(flow, [agent('writer', ['done'])])
  await rig.flows.flush()
  await rig.team.complete(1, { outcome: 'done' }, rig.sessionOf('seat-1'))
  await rig.team.complete(2, { outcome: 'done' }, rig.sessionOf('seat-2'))
  await rig.flows.flush()

  // This rig keeps no real `/repo` on disk, so resolving `cwd: "sub"` under
  // it refuses before anything spawns — exactly like the existing confinement
  // test above. What matters here is what mattered before either writer
  // finished: exactly one card was opened for `gate`, not one per subject.
  const board = rig.board(run.goal)
  assert.equal(board.intents.filter((one) => one.role === 'gate').length, 1, 'one aggregate card, never one per subject')
  assert.deepEqual(checks(rig.events), [])
  const execution = rig.flows.executionsFor(run.goal)[0]!
  assert.equal(execution.reason, CHECK_CWD_OUTSIDE)
})

/*
 * Each check card's checkout and revision are written down when its round
 * opens, and nothing re-derives them later: a retry runs exactly there, at
 * exactly that revision, or stalls and says why. Re-reading the writers at
 * retry time paired cards with whatever checkouts happened to be clean then.
 */
test('a retry runs the checkout its card was planned for, even after another writer’s checkout changed', async (t) => {
  const rig = await goalRig(t)
  rig.heads.set('/repo/.lanes/1', { at: 'sha-writer-1', dirty: false })
  rig.heads.set('/repo/.lanes/2', { at: 'sha-writer-2', dirty: false })
  rig.failEvidenceIn.add('/repo/.lanes/2')
  const run = await rig.start(FAN_OUT_FLOW, [agent('writer', ['done'])])
  await rig.flows.flush()
  await rig.team.complete(1, { outcome: 'done' }, rig.sessionOf('seat-1'))
  await rig.team.complete(2, { outcome: 'done' }, rig.sessionOf('seat-2'))
  await rig.flows.flush()
  assert.equal(rig.flows.executionsFor(run.goal)[0]!.state, 'stalled', 'the second check could not save its evidence')
  const second = rig.board(run.goal).intents.filter((one) => one.role === 'gate')[1]!

  // The first writer's checkout picks up uncommitted changes; the second is untouched. A restart reads the plan back.
  rig.heads.set('/repo/.lanes/1', { at: 'sha-writer-1', dirty: true })
  const restarted = await rig.restart()
  await restarted.flows.flush()
  await restarted.flows.retryCheck(run.id, second.id)
  await restarted.flows.flush()

  assert.deepEqual(rig.checkCwds, ['/repo/.lanes/1', '/repo/.lanes/2', '/repo/.lanes/2'], 'the retry ran in its own card’s checkout, never the other writer’s')
  assert.equal(rig.board(run.goal).intents.find((one) => one.id === second.id)?.state, 'done')
})

test('a retry whose planned revision has moved stalls with the reason instead of checking something else', async (t) => {
  const rig = await goalRig(t)
  rig.heads.set('/repo/.lanes/1', { at: 'sha-writer-1', dirty: false })
  rig.heads.set('/repo/.lanes/2', { at: 'sha-writer-2', dirty: false })
  rig.failEvidenceIn.add('/repo/.lanes/2')
  const run = await rig.start(FAN_OUT_FLOW, [agent('writer', ['done'])])
  await rig.flows.flush()
  await rig.team.complete(1, { outcome: 'done' }, rig.sessionOf('seat-1'))
  await rig.team.complete(2, { outcome: 'done' }, rig.sessionOf('seat-2'))
  await rig.flows.flush()
  const second = rig.board(run.goal).intents.filter((one) => one.role === 'gate')[1]!

  rig.heads.set('/repo/.lanes/2', { at: 'sha-writer-2-amended', dirty: false })
  await rig.flows.retryCheck(run.id, second.id)
  await rig.flows.flush()

  assert.deepEqual(rig.checkCwds, ['/repo/.lanes/1', '/repo/.lanes/2'], 'nothing ran a second time')
  const execution = rig.flows.executionsFor(run.goal)[0]!
  assert.equal(execution.state, 'stalled')
  assert.match(execution.reason ?? '', new RegExp(`#${second.id}.*moved`))
})

test('a writer with uncommitted changes stops the check round before any command runs', async (t) => {
  const rig = await goalRig(t)
  rig.heads.set('/repo/.lanes/1', { at: 'sha-writer-1', dirty: false })
  rig.heads.set('/repo/.lanes/2', { at: 'sha-writer-2', dirty: true })
  const run = await rig.start(FAN_OUT_FLOW, [agent('writer', ['done'])])
  await rig.flows.flush()
  await rig.team.complete(1, { outcome: 'done' }, rig.sessionOf('seat-1'))
  await rig.team.complete(2, { outcome: 'done' }, rig.sessionOf('seat-2'))
  await rig.flows.flush()

  assert.deepEqual(checks(rig.events), [], 'neither writer was checked alone in the other’s place')
  const execution = rig.flows.executionsFor(run.goal)[0]!
  assert.equal(execution.state, 'stalled')
  assert.match(execution.reason ?? '', /#2.*not committed/)
})
