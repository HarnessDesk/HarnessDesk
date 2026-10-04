import assert from 'node:assert/strict'
import { test } from 'node:test'

import { checkRetryRefusal } from '@harnessdesk/protocol'

import { checkAttemptsOf } from '../src/evidence/check-attempts.js'
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

/*
 * #1094: `evidence: [{ check: gate }]`, naming the check role's own id
 * rather than the command it runs, used to be silently unmatchable — the
 * fact a check role leaves carries the literal command it ran, never the
 * role's id, so the round would wait forever with nothing telling anyone
 * why. The role's own id is now read as its command before the guard is
 * matched, so the round opens exactly as it would if the rule had named
 * "pnpm verify" itself.
 */
test('an evidence guard naming a check role’s own id opens the round once that role’s check passes (#1094)', async (t) => {
  const GUARDED_BY_ROLE_ID = `
version: 2
name: Fix then gate, guarded by the gate role's own id
roles:
  author: { kind: agent, uses: writer, grant: edit }
  gate: { kind: check, run: "pnpm verify", exits: { "0": pass }, otherwise: fail, timeout: 30 }
  person: { kind: person, outcomes: [shipped] }
seed: { role: author, title: Write it }
rules:
  - { id: check, on: author, when: { every: [done] }, then: { role: gate, title: Verify } }
  - { id: ship, on: gate, when: { every: [pass], evidence: [{ check: gate }] }, then: { role: person, title: Ship it } }
`
  const rig = await goalRig(t)
  // The evidence guard's subject is the writer's own head: a clean commit to judge the check's fact against.
  rig.heads.set('/repo', { at: 'sha-author', dirty: false })
  const run = await rig.start(GUARDED_BY_ROLE_ID, [agent('writer', ['done'])])
  await rig.flows.flush()
  await rig.team.complete(1, { outcome: 'done' }, rig.sessionOf('seat-1'))
  await rig.flows.flush()
  assert.deepEqual(checks(rig.events), ['check:pnpm verify'])
  const board = rig.board(run.goal)
  assert.equal(board.intents.find((one) => one.role === 'gate')?.outcome, 'pass')
  assert.ok(board.intents.find((one) => one.role === 'person'), 'the guard, naming the role’s own id, opened the person round once the check passed')

  const unknown = GUARDED_BY_ROLE_ID.replace('check: gate', 'check: unknown')
  await assert.rejects(() => rig.start(unknown, [agent('writer', ['done'])]), /Rule "ship" waits for a check called "unknown".*name a check role or its command/)
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

for (const ended of ['settled', 'stopped'] as const) test(`a ${ended} run refuses a check preview and retry without changing its board`, async (t) => {
  const rig = await goalRig(t)
  const source = ended === 'stopped' ? CHECK_FLOW + '\n  - { id: work, on: gate, then: { role: author, title: More work } }\n' : CHECK_FLOW
  const run = await rig.start(source, [agent('writer', ['done'])])
  await rig.flows.flush()
  await rig.team.complete(1, { outcome: 'done' }, rig.sessionOf('seat-1'))
  await rig.flows.flush()
  if (ended === 'stopped') await rig.flows.stopRun(run.id)
  assert.equal(rig.flows.executionOf(run.id)!.state, ended)
  const card = rig.board(run.goal).intents.find((one) => one.role === 'gate')!
  const before = rig.flows.executionOf(run.id)!
  const board = rig.board(run.goal).intents
  const count = checks(rig.events).length
  /* The window shows this sentence beside a disabled control without asking; it is the host's, word for word. */
  const operation = before.operations.find((one) => one.kind === 'check' && one.card === card.id)!
  await assert.rejects(rig.flows.previewCheck(run.id, card.id), { message: checkRetryRefusal(ended, operation.state) })
  await assert.rejects(rig.flows.previewCheck(run.id, card.id), /run.*(?:stopped|settled).*Start a new run/i)
  await assert.rejects(rig.flows.retryCheck(run.id, card.id), /run.*(?:stopped|settled).*Start a new run/i)
  await rig.flows.flush()
  assert.equal(checks(rig.events).length, count)
  assert.deepEqual(rig.board(run.goal).intents, board)
  assert.deepEqual(rig.flows.executionOf(run.id), before)
})

for (const stop of ['run', 'goal', 'settled-goal'] as const) test(`a queued ${stop} stop catches a retry admitted before its controller exists and waits for completion`, async (t) => {
  const rig = await goalRig(t)
  const source = stop === 'settled-goal'
    ? CHECK_FLOW.replace('seed:', '  person: { kind: person, outcomes: [done] }\nseed:') + '\n  - { id: work, on: gate, then: { role: person, title: Decide } }\n'
    : CHECK_FLOW + '\n  - { id: work, on: gate, then: { role: author, title: More work } }\n'
  const run = await rig.start(source, [agent('writer', ['done'])])
  await rig.flows.flush()
  await rig.team.complete(1, { outcome: 'done' }, rig.sessionOf('seat-1'))
  await rig.flows.flush()
  const gate = rig.board(run.goal).intents.find((one) => one.role === 'gate')!
  const approved = await rig.flows.previewCheck(run.id, gate.id)
  const before = checks(rig.events).length
  rig.checksRunUntilStopped = () => {}
  const retry = rig.flows.retryCheck(run.id, gate.id, approved)
  try {
    if (stop === 'settled-goal') {
      await retry
      const person = rig.board(run.goal).intents.find((one) => one.role === 'person')!
      await rig.team.intentAction(run.goal, person.id, 'done', undefined, 'done')
      await rig.flows.wakeEvidence(run.goal)
      assert.equal(rig.flows.executionOf(run.id)!.state, 'settled')
    }
    if (stop !== 'run') await rig.flows.stopGoal(run.goal)
    else await rig.flows.stopRun(run.id)
    await retry
    if (stop === 'settled-goal') {
      assert.ok(rig.events.includes('check-stopped:pnpm verify'), 'Stop returned only after the already-launched retry stopped')
    } else {
      assert.equal(checks(rig.events).length, before, 'the queued retry never launched after Stop was requested')
    }
    assert.equal(rig.flows.executionOf(run.id)!.operations.find((one) => one.card === gate.id)?.state, 'uncertain')
    await assert.rejects(rig.flows.retryCheck(run.id, gate.id, approved), /Start a new run/)
  } finally {
    rig.flows.interruptChecks(run.goal)
    await rig.flows.flush()
  }
})

test('retry returns after launch while the check is still running, and a concurrent retry cannot duplicate it', async (t) => {
  const rig = await goalRig(t)
  rig.checkEvidenceFails = true
  const run = await rig.start(CHECK_FLOW, [agent('writer', ['done'])])
  await rig.flows.flush()
  await rig.team.complete(1, { outcome: 'done' }, rig.sessionOf('seat-1'))
  await rig.flows.flush()
  rig.checkEvidenceFails = false
  const gate = rig.board(run.goal).intents.find((one) => one.role === 'gate')!
  let launched!: () => void
  const launch = new Promise<void>((resolve) => { launched = resolve })
  rig.checksRunUntilStopped = launched
  const retry = rig.flows.retryCheck(run.id, gate.id)
  try {
    await launch
    const result = await Promise.race([
      retry,
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 200)),
    ])
    assert.ok(result, 'retry must return before its long-running check finishes')
    assert.equal(result.state, 'running')
    await assert.rejects(rig.flows.previewCheck(run.id, gate.id), { message: checkRetryRefusal('running', 'started') })
    await assert.rejects(rig.flows.retryCheck(run.id, gate.id), /not waiting|running/)
    assert.equal(checks(rig.events).length, 2)
  } finally {
    rig.flows.interruptChecks(run.goal)
    await rig.flows.flush()
  }
})

test('concurrent sibling retries wait for every live check and advance once, in either completion order', async (t) => {
  for (const order of [[0, 1], [1, 0]]) {
    const rig = await goalRig(t)
    rig.heads.set('/repo/.lanes/1', { at: 'sha-writer-1', dirty: false })
    rig.heads.set('/repo/.lanes/2', { at: 'sha-writer-2', dirty: false })
    rig.checkOutcomes.set('pnpm verify', { exit: 1, timedOut: false, tail: 'first failure' })
    const source = FAN_OUT_FLOW.replace('seed:', '  person: { kind: person, outcomes: [shipped] }\nseed:') +
      '\n  - { id: wait, on: gate, when: { every: [fail], evidence: [{ ci: green }] }, then: { role: person, title: Ship } }\n' +
      '\n  - { id: ship, on: gate, when: { every: [pass] }, then: { role: person, title: Ship } }\n'
    const run = await rig.start(source, [agent('writer', ['done'])])
    await rig.flows.flush()
    await rig.team.complete(1, { outcome: 'done' }, rig.sessionOf('seat-1'))
    await rig.team.complete(2, { outcome: 'done' }, rig.sessionOf('seat-2'))
    await rig.flows.flush()
    const gates = rig.board(run.goal).intents.filter((one) => one.role === 'gate')
    assert.equal(gates.length, 2)
    const release = new Map<string, () => void>()
    rig.waitCheck = (cwd) => new Promise<void>((resolve) => { release.set(cwd, resolve) })
    rig.checkOutcomes.set('pnpm verify', { exit: 0, timedOut: false, tail: 'passed again' })
    try {
      for (const gate of gates) await rig.flows.retryCheck(run.id, gate.id)
      release.get(`/repo/.lanes/${order[0]! + 1}`)!()
      const deadline = Date.now() + 2000
      while (rig.flows.executionOf(run.id)!.operations.find((one) => one.key === `check:2:${order[0]}`)?.state !== 'finished') {
        if (Date.now() > deadline) throw new Error('The first retry never completed.')
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
      // Drain queued completion/advance work without waiting for the other live check.
      await rig.flows.wakeEvidence(run.goal)
      assert.equal(rig.flows.executionOf(run.id)!.state, 'running', 'a live sibling is not interrupted')
      assert.equal(rig.board(run.goal).intents.some((one) => one.role === 'person'), false, 'routing waits for both answers')
      release.get(`/repo/.lanes/${order[1]! + 1}`)!()
      await rig.flows.flush()
      assert.equal(rig.flows.executionOf(run.id)!.state, 'running')
      assert.equal(rig.board(run.goal).intents.filter((one) => one.role === 'person').length, 1)
      assert.equal(checks(rig.events).length, 4, 'only the two consented retries ran')
    } finally {
      for (const resolve of release.values()) resolve()
      await rig.flows.flush()
    }
  }
})

test('otherwise retry and a catch-all rule route non-landing outcomes back through a bounded check loop', async (t) => {
  for (const guard of ['when: { every: [retry] }, ', '']) {
    const rig = await goalRig(t)
    const source = CHECK_FLOW.replace('otherwise: fail', 'otherwise: retry') + `\n  - { id: retry, on: gate, ${guard}then: { role: gate, title: Try again } }\nbudget: { rounds: 4, without-progress: 2 }\n`
    rig.checkOutcomes.set('pnpm verify', { exit: 1, timedOut: false, tail: 'try later' })
    const run = await rig.start(source, [agent('writer', ['done'])])
    await rig.flows.flush()
    await rig.team.complete(1, { outcome: 'done' }, rig.sessionOf('seat-1'))
    await rig.flows.flush()
    assert.ok(checks(rig.events).length > 1, 'the declared rule reruns the check')
    assert.equal(rig.flows.executionOf(run.id)!.state, 'stalled', 'the existing loop budget still bounds retries')
  }
})

test('fresh consent retries an interrupted check in its own moved checkout, but refuses movement after preview', async (t) => {
  const rig = await goalRig(t)
  rig.heads.set('/repo', { at: 'before-check', dirty: false })
  rig.checkEvidenceFails = true
  const run = await rig.start(CHECK_FLOW, [agent('writer', ['done'])])
  await rig.flows.flush()
  await rig.team.complete(1, { outcome: 'done' }, rig.sessionOf('seat-1'))
  await rig.flows.flush()
  const gate = rig.board(run.goal).intents.find((one) => one.role === 'gate')!
  const before = await rig.flows.previewCheck(run.id, gate.id)
  rig.heads.set(before.command.cwd, { at: 'after-check', dirty: false })
  await assert.rejects(rig.flows.retryCheck(run.id, gate.id, before), /checkout changed/)
  const approved = await rig.flows.previewCheck(run.id, gate.id)
  rig.checkEvidenceFails = false
  await rig.flows.retryCheck(run.id, gate.id, approved)
  await rig.flows.flush()
  assert.equal(checks(rig.events).length, 2)
  assert.equal(rig.board(run.goal).intents.find((one) => one.id === gate.id)!.state, 'done')
  assert.equal(rig.executions.stored(run.id)!.checkPlans?.['2']?.targets[0]?.at, 'after-check')
})

test('rerunning a finished earlier check keeps its downstream cards without opening duplicates', async (t) => {
  const rig = await goalRig(t)
  const source = CHECK_FLOW.replace('seed:', '  referee: { kind: person, outcomes: [landed] }\nseed:') + '\n  - { id: to-person, on: gate, when: { every: [pass] }, then: { role: referee, title: Land } }\n'
  const run = await rig.start(source, [agent('writer', ['done'])])
  await rig.flows.flush()
  await rig.team.complete(1, { outcome: 'done' }, rig.sessionOf('seat-1'))
  await rig.flows.flush()
  const before = rig.board(run.goal).intents
  const gate = before.find((one) => one.role === 'gate')!
  const referee = before.find((one) => one.role === 'referee')!
  await rig.flows.retryCheck(run.id, gate.id)
  await rig.flows.flush()
  assert.equal(rig.board(run.goal).intents.length, before.length)
  assert.equal(rig.board(run.goal).intents.find((one) => one.id === referee.id)!.state, 'open')
  assert.equal(checks(rig.events).length, 2)
})

for (const downstream of ['running', 'stalled'] as const) {
  for (const evidenceFails of [false, true]) {
    test(`retrying an earlier check preserves ${downstream} downstream work (${evidenceFails ? 'unsaved' : 'saved'} evidence)`, async (t) => {
      const rig = await goalRig(t)
      const source = `
version: 2
name: A gate before work
roles:
  gate: { kind: check, run: "pnpm verify", exits: { "0": pass }, otherwise: fail, timeout: 30 }
  author: { kind: agent, uses: writer }
seed: { role: gate, title: Check first }
rules:
  - { id: work, on: gate, when: { every: [pass] }, then: { role: author, title: Write it } }
`
      rig.failOrder = downstream === 'stalled'
      const run = await rig.start(source, [agent('writer', ['done'])])
      await rig.flows.flush()
      const before = rig.flows.executionOf(run.id)!
      assert.equal(before.state, downstream)
      if (downstream !== 'running') assert.ok(before.reason)
      const board = rig.board(run.goal).intents
      const gate = board.find((one) => one.role === 'gate')!
      const author = board.find((one) => one.role === 'author')!
      const seats = [...rig.seats.values()]
      rig.checkEvidenceFails = evidenceFails
      rig.checkOutcomes.set('pnpm verify', { exit: 1, timedOut: false, tail: 'new answer' })
      const launched = await rig.flows.retryCheck(run.id, gate.id)
      assert.equal(launched.state, before.state, 'launch does not reactivate downstream work')
      assert.equal(launched.reason, before.reason)
      await rig.flows.flush()
      const after = rig.flows.executionOf(run.id)!
      assert.equal(after.state, before.state)
      assert.equal(after.reason, before.reason)
      assert.deepEqual(after.rounds, before.rounds)
      assert.deepEqual([...rig.seats.values()], seats, 'the downstream Seats stay as they were')
      assert.deepEqual(rig.board(run.goal).intents.find((one) => one.id === author.id), author)
      assert.equal(rig.board(run.goal).intents.length, board.length)
      assert.equal(after.operations.find((one) => one.key === 'check:1:0')?.state, evidenceFails ? 'uncertain' : 'finished')
      const retried = rig.board(run.goal).intents.find((one) => one.id === gate.id)!
      assert.equal(retried.state, evidenceFails ? 'open' : 'done')
      assert.equal(retried.outcome, evidenceFails ? gate.outcome : 'fail')
      assert.equal(checks(rig.events).length, 2, 'only the consented check ran again')
    })
  }
}

/*
 * `flow/check/attempts` words each recorded result with the Flow's own mapping,
 * and the engine answers a check's card with that same mapping — so the read
 * and the card can be held to each other, for a status the Flow names, one it
 * does not, and a timeout.
 */
const WORDED_FLOW = CHECK_FLOW.replace('exits: { "0": pass, "2": fail }, otherwise: fail', 'exits: { "0": pass, "2": fix }, otherwise: stuck')
  .replace('seed:', '  person: { kind: person, outcomes: [done] }\nseed:') + '  - { id: to-person, on: gate, then: { role: person, title: Decide } }\n'

for (const [what, result, word] of [
  ['a status the flow names', { exit: 0, timedOut: false, tail: 'all green' }, 'pass'],
  ['another status the flow names', { exit: 2, timedOut: false, tail: 'FAIL: 1 test' }, 'fix'],
  ['a status the flow names no outcome for', { exit: 7, timedOut: false, tail: 'odd' }, 'stuck'],
  ['a timeout', { exit: null, timedOut: true, tail: 'It ran past 30s and was stopped.' }, 'stuck'],
] as const) test(`the attempt read words ${what} exactly as the engine answered the card`, async (t) => {
  const rig = await goalRig(t)
  rig.heads.set('/repo', { at: 'sha-author', dirty: false })
  rig.checkOutcomes.set('pnpm verify', result)
  const run = await rig.start(WORDED_FLOW, [agent('writer', ['done'])])
  await rig.flows.flush()
  await rig.team.complete(1, { outcome: 'done' }, rig.sessionOf('seat-1'))
  await rig.flows.flush()
  const gate = rig.board(run.goal).intents.find((one) => one.role === 'gate')!
  const [attempt, ...more] = await checkAttemptsOf(rig.flows.executionOf(run.id)!, gate.id, async () => rig.facts.get(run.goal) ?? [])
  assert.equal(more.length, 0)
  assert.equal(attempt!.outcome, word)
  assert.equal(attempt!.outcome, gate.outcome, 'the card was answered with the word the read gives')
  assert.deepEqual([attempt!.exit, attempt!.timedOut, attempt!.tail, attempt!.commit], [result.exit, result.timedOut, result.tail, 'sha-author'])
})

test('a check run again adds an attempt and leaves the earlier one exactly as it was recorded', async (t) => {
  const rig = await goalRig(t)
  rig.heads.set('/repo', { at: 'sha-author', dirty: false })
  rig.checkOutcomes.set('pnpm verify', { exit: 2, timedOut: false, tail: 'FAIL: 1 test' })
  const run = await rig.start(WORDED_FLOW, [agent('writer', ['done'])])
  await rig.flows.flush()
  await rig.team.complete(1, { outcome: 'done' }, rig.sessionOf('seat-1'))
  await rig.flows.flush()
  const gate = rig.board(run.goal).intents.find((one) => one.role === 'gate')!
  const read = () => checkAttemptsOf(rig.flows.executionOf(run.id)!, gate.id, async () => rig.facts.get(run.goal) ?? [])
  const before = await read()
  assert.equal(before.length, 1)

  rig.checkOutcomes.set('pnpm verify', { exit: 0, timedOut: false, tail: 'all green' })
  await rig.flows.retryCheck(run.id, gate.id)
  await rig.flows.flush()
  const after = await read()
  assert.deepEqual(after.map((one) => [one.n, one.outcome, one.tail]), [[1, 'fix', 'FAIL: 1 test'], [2, 'pass', 'all green']])
  assert.deepEqual(after[0], before[0], 'the first attempt is the record it was, byte for byte')
  assert.equal(rig.board(run.goal).intents.find((one) => one.id === gate.id)!.outcome, 'pass', 'the card carries the latest attempt’s word')
})

test('a retry is refused on the run’s and the check’s own words only where the host’s preview refuses on them', async (t) => {
  const rig = await goalRig(t)
  rig.heads.set('/repo', { at: 'sha-author', dirty: false })
  const run = await rig.start(WORDED_FLOW, [agent('writer', ['done'])])
  await rig.flows.flush()
  await rig.team.complete(1, { outcome: 'done' }, rig.sessionOf('seat-1'))
  await rig.flows.flush()
  const gate = rig.board(run.goal).intents.find((one) => one.role === 'gate')!
  const execution = rig.flows.executionOf(run.id)!
  const operation = execution.operations.find((one) => one.kind === 'check' && one.card === gate.id)!
  assert.deepEqual([execution.state, operation.state], ['running', 'finished'])
  assert.equal(checkRetryRefusal(execution.state, operation.state), null, 'a finished check on a running run is not refused on those words')
  await rig.flows.previewCheck(run.id, gate.id)
})
