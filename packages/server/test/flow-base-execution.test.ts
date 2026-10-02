import assert from 'node:assert/strict'
import { test } from 'node:test'

import { sourceDigest } from '../src/flow-execution.js'
import { executionOf } from '../src/flow-recovery.js'
import { agent, goalRig } from './fixtures/flow-goal-rig.js'

const FLOW = `
version: 2
name: Fresh relay
base: { remote: origin }
roles:
  dev: { kind: agent, uses: writer, grant: edit }
  tester: { kind: agent, uses: reader, grant: read }
seed: { role: dev, title: Work }
rules:
  - { id: test, on: dev, then: { role: tester, title: Test } }
`
const AGENTS = [agent('writer', ['done']), agent('reader', ['approve'])]
const BASE = 'a'.repeat(40)
const WORK = 'b'.repeat(40)

test('a saved remote-base run refuses a missing, malformed or mismatched pin', async (t) => {
  const rig = await goalRig(t)
  const source = FLOW.replace('base: { remote: origin }', '')
  const run = await rig.start(source, AGENTS)
  const compiled = rig.compile(FLOW, AGENTS)
  const stored = { ...rig.executions.stored(run.id)!, source: FLOW, compiled, document: compiled.document,
    authorization: { sourceDigest: sourceDigest(FLOW), commandDigest: sourceDigest(''), approvedAt: 1 } }
  for (const pin of [undefined, { remote: 'origin', at: 'HEAD' }, { remote: 'other', at: BASE }, { remote: 'origin', branch: 'main', at: BASE }]) {
    assert.throws(() => executionOf({ ...stored, base: pin }), /base/i)
  }
  assert.equal(executionOf({ ...stored, base: { remote: 'origin', at: BASE } }).base?.at, BASE)
})

test('the fetched base is frozen across restart and a dependent reader starts at the writer commit', async (t) => {
  let fetches = 0
  const rig = await goalRig(t, { fetchBase: async (_root, base) => { fetches += 1; return { ...base, at: BASE } } })
  rig.heads.set('/repo', { at: 'c'.repeat(40), dirty: false })
  rig.beforeOpen = (n) => rig.heads.set(`/repo/.lanes/${n}`, { at: n === 1 ? BASE : WORK, dirty: false })
  const run = await rig.start(FLOW, AGENTS)
  assert.equal(run.state, 'running', run.reason ?? '')
  assert.deepEqual(run.base, { remote: 'origin', at: BASE })
  assert.equal(rig.seats.get('seat-1')!.checkout.cwd, '/repo/.lanes/1')
  const restarted = await rig.restart()
  assert.equal(restarted.executions.stored(run.id)?.base?.at, BASE)
  rig.heads.set('/repo/.lanes/1', { at: WORK, dirty: false })
  await rig.team.complete(1, { outcome: 'done' }, rig.sessionOf('seat-1'))
  await rig.flows.flush()
  const after = rig.executions.stored(run.id)!
  assert.equal(after.state, 'running', after.reason ?? '')
  assert.equal(after.seatPlans?.['2']?.base, WORK, 'predecessor work takes priority over the initial remote base')
  assert.equal(rig.seats.get('seat-2')!.checkout.cwd, '/repo/.lanes/2')
  assert.equal(fetches, 1, 'recovery and later rounds never fetch again')
})

test('a Seat opened away from the fetched commit is released before it receives any work', async (t) => {
  const rig = await goalRig(t, { fetchBase: async (_root, base) => ({ ...base, at: BASE }) })
  rig.heads.set('/repo/.lanes/1', { at: WORK, dirty: false })
  const run = await rig.start(FLOW, AGENTS)
  assert.equal(run.state, 'stalled')
  assert.match(run.reason ?? '', /did not open at a{12}/)
  assert.ok(rig.events.includes('release:seat-1'))
  assert.ok(!rig.events.some((one) => one.startsWith('order:')))
})

test('a trigger fetches its base once and dispatches from that pin after its hold is released', async (t) => {
  let fetches = 0
  const rig = await goalRig(t, { fetchBase: async (_root, base) => { fetches += 1; return { ...base, at: BASE } } })
  rig.heads.set('/repo/.lanes/1', { at: BASE, dirty: false })
  const run = await rig.startTriggered(FLOW, AGENTS)
  assert.equal(run.base?.at, BASE)
  assert.equal(rig.seats.size, 0, 'the firing is still held')
  await rig.flows.resumeTriggered(run.id)
  await rig.flows.flush()
  assert.equal(rig.executions.stored(run.id)?.state, 'running')
  assert.equal(rig.seats.get('seat-1')!.checkout.cwd, '/repo/.lanes/1')
  assert.equal(fetches, 1)
})

test('a first writer after a person round still opens from the frozen remote base', async (t) => {
  const rig = await goalRig(t, { fetchBase: async (_root, base) => ({ ...base, at: BASE }) })
  rig.heads.set('/repo', { at: WORK, dirty: false })
  rig.heads.set('/repo/.lanes/1', { at: BASE, dirty: false })
  const source = `version: 2\nname: Person then writer\nbase: { remote: origin }\nroles:\n  person: { kind: person, outcomes: [go] }\n  dev: { kind: agent, uses: writer, grant: edit }\nseed: { role: person, title: Decide }\nrules:\n  - { id: work, on: person, then: { role: dev, title: Work } }\n`
  const run = await rig.start(source, AGENTS)
  await rig.team.intentAction(run.goal, 1, 'done', undefined, 'go')
  await rig.flows.flush()
  assert.equal(rig.executions.stored(run.id)?.seatPlans?.['2']?.base, BASE)
  assert.equal(rig.seats.get('seat-1')!.checkout.cwd, '/repo/.lanes/1')
})

test('recovery validates a journaled Seat before sending its first order', async (t) => {
  const rig = await goalRig(t, { fetchBase: async (_root, base) => ({ ...base, at: BASE }) })
  rig.heads.set('/repo/.lanes/1', { at: WORK, dirty: false })
  const save = rig.files.save.bind(rig.files)
  let crashed = false
  rig.files.save = async (stored) => {
    await save(stored)
    if (!crashed && stored.operations.some((one) => one.kind === 'seat' && one.state === 'finished')) {
      crashed = true
      throw new Error('simulated crash after the Seat was journaled, before its base was validated')
    }
  }
  const run = await rig.start(FLOW, AGENTS)
  assert.ok(crashed)
  await rig.restart()
  await rig.flows.resume()
  await rig.flows.flush()
  const after = rig.executions.stored(run.id)!
  assert.equal(after.state, 'stalled')
  assert.ok(!rig.events.some((one) => one.startsWith('order:')), 'no work reaches a journaled Seat on the wrong commit')
  assert.ok(rig.events.includes('release:seat-1'))
})

test('a reader at the initial base receives the actual commits of multiple predecessor writers', async (t) => {
  const rig = await goalRig(t, { fetchBase: async (_root, base) => ({ ...base, at: BASE }) })
  rig.beforeOpen = (n) => rig.heads.set(`/repo/.lanes/${n}`, { at: BASE, dirty: false })
  const run = await rig.start(FLOW.replace('uses: writer, grant: edit', 'uses: writer, count: 2, grant: edit'), AGENTS)
  const second = 'c'.repeat(40)
  rig.heads.set('/repo/.lanes/1', { at: WORK, dirty: false })
  rig.heads.set('/repo/.lanes/2', { at: second, dirty: false })
  await rig.team.complete(1, { outcome: 'done' }, rig.sessionOf('seat-1'))
  await rig.team.complete(2, { outcome: 'done' }, rig.sessionOf('seat-2'))
  await rig.flows.flush()
  const after = rig.executions.stored(run.id)!
  assert.equal(after.state, 'running', after.reason ?? '')
  assert.equal(after.seatPlans?.['2']?.base, BASE)
  const order = rig.orderTexts.get('seat-3')?.[0] ?? ''
  assert.ok(order.includes(WORK), 'the first writer commit is named')
  assert.ok(order.includes(second), 'the second writer commit is named')
  assert.match(order, /card #1:.*written in \/repo\/\.lanes\/1/)
  assert.match(order, /card #2:.*written in \/repo\/\.lanes\/2/)
  assert.ok(!order.includes('already in it'), 'the initial base does not contain either writer’s later work')
})
