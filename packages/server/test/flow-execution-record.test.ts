import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { FlowExecution } from '@harnessdesk/protocol'

import { sourceDigest, type FlowStartRequest, type StoredFlowExecution } from '../src/flow-execution.js'
import { executionOf } from '../src/flow-recovery.js'
import { flowMethods } from '../src/methods/flows.js'
import { decideLoop } from '../src/findings/rounds.js'
import type { HostContext } from '../src/methods/context.js'
import { goalRig, type GoalRig } from './fixtures/flow-goal-rig.js'

// The synthetic rig's Runs are read through the same handler as the window.
const record = (run: FlowExecution) => run
const read = (rig: GoalRig, id: string) => flowMethods['flow/execution']({ flows: rig.flows } as HostContext, { run: id })
const FINAL = `
version: 2
name: Finish
roles:
  person: { kind: person, outcomes: [done] }
seed: { role: person, title: Finish it }
rules: []
`
const start = (rig: GoalRig, source = FINAL, extra: Record<string, unknown> = {}) => rig.flows.startGoal({
  root: '/repo', sentence: 'Finish it', source, sourcePath: null, compiled: rig.compile(source, []),
  authorization: { sourceDigest: sourceDigest(source), commandDigest: sourceDigest(''), approvedAt: 1 },
  ...extra,
} as FlowStartRequest)

test('the Run read projects the stored start time and freezes a canonical Flow revision', async (t) => {
  const rig = await goalRig(t)
  const first = await start(rig)
  const formatted = FINAL.replace('name: Finish', '# a comment\nname: "Finish"').replace('kind: person, outcomes: [done]', 'outcomes: [done], kind: person')
  const second = await start(rig, formatted)
  const changed = await start(rig, FINAL.replace('rules: []', 'rules:\n  - { id: again, on: person, then: { role: person, title: Again } }'))
  const revision = record(await read(rig, first.id))['revision']
  assert.match(String(revision), /^[0-9a-f]{12}$/)
  assert.equal(record(second)['revision'], revision)
  assert.notEqual(record(changed)['revision'], revision)
  assert.equal(record(first)['startedAt'], rig.executions.stored(first.id)!.startedAt)
  assert.equal(record(first)['endedAt'], null)
  assert.equal(record(first)['end'], null)
  await rig.executions.stop(first.id)
  await rig.restart()
  assert.equal(record(await read(rig, first.id))['revision'], revision)
})

test('lineage and the declared brief round-trip through storage and the Run read', async (t) => {
  const rig = await goalRig(t)
  const earlier = await start(rig)
  await rig.executions.stop(earlier.id)
  const source = FINAL.replace('roles:', 'inputs:\n  brief: { default: Default brief }\nroles:')
  const vars = { brief: 'A long brief\nwith a second line.' }
  const run = await start(rig, source, { continues: earlier.id, vars })
  vars.brief = 'Edited after start'
  await rig.restart()
  const restored = record(await read(rig, run.id))
  assert.equal(restored['continues'], earlier.id)
  assert.equal(restored['brief'], 'A long brief\nwith a second line.')
  const defaulted = await start(rig, source)
  assert.equal(record(defaulted)['brief'], 'Default brief')
  const undeclared = await start(rig, FINAL, { vars: { brief: 'Not an input' } })
  assert.equal(record(undeclared)['brief'], null)
  assert.equal(record(undeclared)['continues'], null)
})

test('a trigger start records its canonical revision and only its declared brief default', async (t) => {
  const rig = await goalRig(t)
  const source = FINAL.replace('roles:', 'inputs:\n  brief: { default: Trigger brief }\nroles:')
  const run = await rig.startTriggered(source, [])
  const manual = await start(rig, source)
  assert.equal(record(run)['revision'], record(manual)['revision'])
  assert.match(String(record(run)['revision']), /^[0-9a-f]{12}$/)
  assert.equal(record(run)['brief'], 'Trigger brief')
  assert.equal(record(run)['continues'], null)
  assert.equal(record(run)['startedAt'], rig.executions.stored(run.id)!.startedAt)
  await rig.restart()
  assert.equal(record(await read(rig, run.id))['brief'], 'Trigger brief')
})

test('an old Run with none of the new fields loads without invented identity or end metadata', async (t) => {
  const rig = await goalRig(t)
  const run = await start(rig)
  const stored = { ...rig.executions.stored(run.id)! } as unknown as Record<string, unknown>
  for (const field of ['revision', 'continues', 'brief', 'endedAt', 'end']) delete stored[field]
  await rig.files.save(stored as unknown as StoredFlowExecution)
  await rig.restart()
  const restored = record(await read(rig, run.id))
  assert.equal(restored['startedAt'], stored['startedAt'])
  for (const field of ['revision', 'continues', 'brief', 'endedAt', 'end']) assert.equal(field in restored, false, field)
})

test('recovery validates optional Run metadata rather than projecting unreadable fields', async (t) => {
  const rig = await goalRig(t)
  const run = await start(rig)
  const stored = rig.executions.stored(run.id)!
  for (const extra of [
    { revision: 12 }, { revision: 'not-a-digest' }, { continues: '' }, { brief: {} }, { endedAt: 'today' },
    { end: { kind: 'unrouted', card: 0, outcome: 'fail' } }, { end: { kind: 'stopped', by: 'agent' } },
    { end: { kind: 'budget', which: 'money', used: 3 } }, { end: { kind: 'budget', which: 'rounds', used: -1 } },
    { end: { kind: 'budget', which: ['rounds'], used: 2 } },
    { end: { kind: 'unknown' } },
  ]) assert.throws(() => executionOf({ ...stored, ...extra }), /flow run/, JSON.stringify(extra))
})

test('recovery refuses a malformed structured loop budget cause', async (t) => {
  const rig = await goalRig(t)
  const run = await start(rig)
  const stored = rig.executions.stored(run.id)!
  for (const budget of [{ which: 'money', used: 2 }, { which: 'rounds', used: 'two' }, { which: 'without-progress', used: -1 },
    { which: ['without-progress'], used: 2 }]) {
    assert.throws(() => executionOf({ ...stored, findings: { ...stored.findings,
      stopped: { round: 1, reason: 'The loop stopped.', ceiling: false, budget },
    } }), /flow run/, JSON.stringify(budget))
  }
})

test('a stalled check resumes without a current end and keeps its first departure time', async (t) => {
  const rig = await goalRig(t)
  rig.checkEvidenceFails = true
  const source = `version: 2\nname: Check\nroles:\n  check: { kind: check, run: echo checked, exits: { '0': pass }, otherwise: fail }\nseed: { role: check, title: Check it }\nrules: []\n`
  const run = await start(rig, source)
  await rig.flows.flush()
  const endedAt = record(await read(rig, run.id))['endedAt']
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  t.after(() => { release() })
  rig.checkEvidenceFails = false
  rig.waitCheck = () => gate
  await rig.executions.retryCheck(run.id, 1)
  const resumed = await read(rig, run.id)
  assert.equal(resumed.state, 'running')
  assert.equal(resumed.end, null)
  assert.equal(resumed.endedAt, endedAt)
  release()
  await rig.flows.flush()
  const completed = await read(rig, run.id)
  assert.deepEqual(completed.end, { kind: 'complete' })
  assert.equal(completed.endedAt, endedAt)
})

test('an answered terminal role completes and its end time survives later writes and restart', async (t) => {
  const rig = await goalRig(t)
  const run = await start(rig)
  await rig.team.intentAction(run.goal, 1, 'done', undefined, 'done')
  await rig.flows.flush()
  const ended = record(await read(rig, run.id))
  assert.deepEqual(ended['end'], { kind: 'complete' })
  assert.equal(typeof ended['endedAt'], 'number')
  assert.ok(Number(ended['endedAt']) >= Number(ended['startedAt']))
  await rig.executions.stop(run.id)
  await rig.restart()
  assert.equal(record(await read(rig, run.id))['endedAt'], ended['endedAt'])
  assert.deepEqual(record(await read(rig, run.id))['end'], ended['end'])
})

test('an outcome rejected by its outgoing rules names the unrouted card and answer', async (t) => {
  const rig = await goalRig(t)
  const source = FINAL.replace('outcomes: [done]', 'outcomes: [done, no-pr]').replace('rules: []', 'rules:\n  - { id: again, on: person, when: { every: [done] }, then: { role: person, title: Again } }')
  const run = await start(rig, source)
  await rig.team.intentAction(run.goal, 1, 'done', undefined, 'no-pr')
  await rig.flows.flush()
  const ended = await read(rig, run.id)
  assert.equal(ended.state, 'settled')
  assert.deepEqual(record(ended)['end'], { kind: 'unrouted', card: 1, outcome: 'no-pr' })
  assert.match(ended.reason!, /#1.*answered no-pr.*no rule continues/)
})

test('a person Stop and a desk wrap record their own cause', async (t) => {
  const rig = await goalRig(t)
  const person = await start(rig)
  await rig.executions.stop(person.id)
  assert.deepEqual(record(await read(rig, person.id))['end'], { kind: 'stopped', by: 'person' })
  const desk = await start(rig)
  await rig.executions.stopGoal(desk.goal, 'the Goal is being wrapped')
  assert.deepEqual(record(await read(rig, desk.id))['end'], { kind: 'stopped', by: 'desk' })
})

test('a desk stop routed through Flows keeps its attribution', async (t) => {
  const rig = await goalRig(t)
  const run = await start(rig)
  await rig.flows.stopRun(run.id, 'The trigger was stopped by the desk.', 'desk')
  assert.deepEqual((await read(rig, run.id)).end, { kind: 'stopped', by: 'desk' })
})

test('a closed round budget records which limit and how many rounds were used', async (t) => {
  const rig = await goalRig(t)
  const source = FINAL.replace('roles:', 'budget: { rounds: 1, without-progress: 2 }\nroles:').replace('rules: []', 'rules:\n  - { id: again, on: person, then: { role: person, title: Again } }')
  const run = await start(rig, source)
  await rig.team.intentAction(run.goal, 1, 'done', undefined, 'done')
  await rig.flows.flush()
  const ended = await read(rig, run.id)
  assert.equal(ended.state, 'stalled')
  assert.deepEqual(record(ended)['end'], { kind: 'budget', which: 'rounds', used: 1 })
})

test('two closed rounds without progress name that budget rather than the round ceiling', async (t) => {
  const rig = await goalRig(t)
  rig.executions.onRoundClosed((id, n) => rig.executions.recordRoundClose(id, n, (state) => {
    const decision = decideLoop({
      closed: n, limit: 10, idle: state.idleRounds, idleLimit: 2, newProgress: n === 1,
      unresolvedRepairs: [], unresolved: 1, reviewComplete: false, freshGuards: false, pendingException: false,
    })
    return { ...state, closedRounds: [...state.closedRounds, n], idleRounds: decision.idle,
      stopped: decision.next === 'person' ? { round: n, reason: decision.reason!, ceiling: decision.ceiling, ...(decision.budget ? { budget: decision.budget } : {}) } : null }
  }))
  const source = FINAL.replace('roles:', 'budget: { rounds: 10, without-progress: 2 }\nroles:').replace('rules: []', 'rules:\n  - { id: again, on: person, then: { role: person, title: Again } }')
  const run = await start(rig, source)
  for (let card = 1; card <= 3; card += 1) {
    await rig.team.intentAction(run.goal, card, 'done', undefined, 'done')
    await rig.flows.flush()
  }
  assert.deepEqual(record(await read(rig, run.id))['end'], { kind: 'budget', which: 'without-progress', used: 2 })
})

test('a check whose result could not be recorded stalls with an end time stamped once', async (t) => {
  const rig = await goalRig(t)
  rig.checkEvidenceFails = true
  const source = `version: 2\nname: Check\nroles:\n  check: { kind: check, run: echo checked, exits: { '0': pass }, otherwise: fail }\nseed: { role: check, title: Check it }\nrules: []\n`
  const run = await start(rig, source)
  await rig.flows.flush()
  const stalled = record(await read(rig, run.id))
  assert.deepEqual(stalled['end'], { kind: 'stalled' })
  assert.equal(typeof stalled['endedAt'], 'number')
  await rig.executions.stop(run.id)
  const stopped = record(await read(rig, run.id))
  assert.deepEqual(stopped['end'], { kind: 'stopped', by: 'person' })
  assert.equal(stopped['endedAt'], stalled['endedAt'])
})

test('attendance and overrides are frozen before dispatch and survive recovery', async t => {
  const rig = await goalRig(t)
  const overrides = { writer: [{ runtime: 'beta', effort: 'high' }] }
  const roster = [(await import('./fixtures/flow-goal-rig.js')).agent('writer', ['done'])]
  rig.digests.set('writer', 'writer-digest')
  const source = 'version: 2\nname: Writer\nroles:\n  writer: { uses: writer, grant: read, seats: [alpha] }\nseed: { role: writer, title: Write }\nrules: []\n'
  const { compileFlowPolicy, parseFlowPolicy } = await import('../src/flow-policy.js')
  const compiled = compileFlowPolicy(parseFlowPolicy(source).document!, roster, [], overrides)
  const run = await start(rig, source, { compiled, overrides, attended: false })
  const fields = (value: FlowExecution) => value as unknown as { attended: boolean; overrides: typeof overrides }
  assert.equal(fields(run).attended, false)
  assert.deepEqual(fields(run).overrides, overrides)
  assert.equal([...rig.seats.values()][0]!.session.runtime, 'beta')
  overrides.writer[0]!.runtime = 'gamma'
  await rig.executions.stop(run.id)
  await rig.restart()
  assert.equal(fields(await read(rig, run.id)).overrides.writer[0]!.runtime, 'beta')
  assert.equal(fields(await read(rig, run.id)).attended, false)
  const saved = rig.executions.stored(run.id)!
  for (const extra of [{ attended: 'false' }, { overrides: null }, { overrides: { writer: [{ runtime: '' }] } }, { overrides: { person: [{ runtime: 'beta' }] } }, { overrides: { writer: [{ runtime: 'gamma' }] } }]) {
    assert.throws(() => executionOf({ ...saved, ...extra }), /flow run/)
  }
  const older = { ...saved } as unknown as Record<string, unknown>
  delete older.attended; delete older.overrides
  assert.throws(() => executionOf(older), /frozen bindings/, 'missing metadata must not hide seats different from the file')
  // A pre-override run's saved bindings agree with its file's seats.
  older.compiled = rig.compile(source, roster)
  await rig.files.save(older as unknown as StoredFlowExecution)
  await rig.restart()
  assert.equal(fields(await read(rig, run.id)).attended, true)
  assert.equal(fields(await read(rig, run.id)).overrides, undefined)
})
