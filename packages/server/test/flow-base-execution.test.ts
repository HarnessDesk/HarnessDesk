import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'

import { dropFlowBase, fetchFlowBase } from '../src/flow-base.js'
import { makeRepo } from './fixtures/evidence-desk.js'
import { tempDir } from './scratch.js'
import type { TriggerStartRequest } from '../src/flow-execution.js'
import { flowRevision, sourceDigest } from '../src/flow-execution.js'
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
    revision: flowRevision(compiled.document),
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

test('a trigger reuses a completed base pin offline when adoption was interrupted', async (t) => {
  let fetches = 0
  let offline = false
  const rig = await goalRig(t, { fetchBase: async (_root, base) => {
    fetches += 1
    if (offline) throw new Error('offline')
    return { ...base, at: BASE }
  } })
  let request: TriggerStartRequest | undefined
  const start = rig.flows.startTriggered.bind(rig.flows)
  rig.flows.startTriggered = (input) => { request = input; return start(input) }
  rig.files.dieWhen = (run) => Boolean(run.base && run.operations.some((op) => op.key === 'start'))
  await assert.rejects(rig.startTriggered(FLOW, AGENTS), /journal|crash/i)
  offline = true
  await rig.restart()
  const recovered = await rig.flows.startTriggered(request!)
  assert.equal(recovered.state, 'running', recovered.reason ?? '')
  assert.equal(recovered.base?.at, BASE)
  assert.equal(fetches, 1)
  assert.equal(recovered.rounds.length, 1)
  assert.equal(rig.seats.size, 0, 'Intake has not released dispatch')
})

test('a failed pre-fetch journal write performs no fetch and creates no Goal', async (t) => {
  let fetches = 0
  const rig = await goalRig(t, { fetchBase: async (_root, base) => { fetches += 1; return { ...base, at: BASE } } })
  rig.files.failOnce = () => true
  await assert.rejects(rig.start(FLOW, AGENTS), /journal/i)
  assert.equal(fetches, 0)
  assert.equal(rig.goals.size, 0)
})

test('a manual start conclusively aborted before adoption removes only its own base ref', async (t) => {
  const repo = await makeRepo('hd-base-aborted-')
  const remote = tempDir('hd-base-aborted-remote-')
  await repo.git('clone', '--no-hardlinks', repo.dir, remote)
  await repo.git('remote', 'add', 'origin', remote)
  const retained = await fetchFlowBase(repo.dir, { remote: 'origin' }, 'successful-run')
  const removed: string[] = []
  let fetched: string | undefined
  const rig = await goalRig(t, {
    fetchBase: async (_root, base, id) => { fetched = id; return fetchFlowBase(repo.dir, base, id) },
    dropBase: async (_root, id) => { removed.push(id); await dropFlowBase(repo.dir, id) },
  })
  rig.files.failOnce = (run) => Boolean(run.base && run.operations.some((op) => op.key === 'start'))
  await assert.rejects(rig.start(FLOW, AGENTS), /journal/i)
  assert.deepEqual(removed, [fetched])
  await assert.rejects(repo.git('rev-parse', '--verify', `refs/harnessdesk/flow-base/${fetched}`))
  assert.equal(await repo.git('rev-parse', 'refs/harnessdesk/flow-base/successful-run'), retained.at)
  assert.equal(rig.goals.size, 0)
  assert.equal(rig.executions.stored(fetched!)?.state, 'stopped')
})

test('recovery removes a manual base pin whose start died before making its Goal', async (t) => {
  const removed: string[] = []
  let fetched: string | undefined
  const rig = await goalRig(t, {
    fetchBase: async (_root, base, id) => { fetched = id; return { ...base, at: BASE } },
    dropBase: async (_root, id) => { removed.push(id) },
  })
  rig.files.dieWhen = (run) => Boolean(run.base && run.operations.some((op) => op.key === 'start'))
  await assert.rejects(rig.start(FLOW, AGENTS), /journal/i)
  assert.deepEqual(removed, [], 'a process exit cannot conclusively abort the start')
  await rig.restart()
  assert.deepEqual(removed, [fetched])
  assert.equal(rig.executions.stored(fetched!)?.state, 'stopped')
})

for (const during of ['start', 'recovery'] as const) {
  for (const failure of ['interruption', 'deletion failure'] as const) {
    test(`pending base deletion survives ${failure} during ${during} and preserves successful refs`, async (t) => {
      const repo = await makeRepo('hd-base-cleanup-')
      const remote = tempDir('hd-base-cleanup-remote-')
      await repo.git('clone', '--no-hardlinks', repo.dir, remote)
      await repo.git('remote', 'add', 'origin', remote)
      let fetched = ''
      let deletionFails = false
      const removed: string[] = []
      const rig = await goalRig(t, {
        fetchBase: async (_root, base, id) => { fetched = id; return fetchFlowBase(repo.dir, base, id) },
        dropBase: async (_root, id) => {
          removed.push(id)
          if (deletionFails) throw new Error('simulated ref deletion failure')
          await dropFlowBase(repo.dir, id)
        },
      })
      const successful = await rig.start(FLOW.replace('dev: { kind: agent, uses: writer, grant: edit }',
        'dev: { kind: person, outcomes: [done] }'), AGENTS)
      assert.equal(successful.state, 'running')
      const retained = successful.base!.at
      const startSave = rig.files.save.bind(rig.files)
      const interruptAbort = () => {
        const save = rig.files.save.bind(rig.files)
        rig.files.save = async (run) => {
          await save(run)
          if (run.state === 'stopped') {
            rig.files.dead = true
            throw new Error('simulated process exit after durable abort, before ref deletion')
          }
        }
      }
      if (during === 'start') {
        if (failure === 'interruption') interruptAbort()
        else deletionFails = true
        rig.files.failOnce = (run) => Boolean(run.base && run.operations.some((op) => op.key === 'start'))
      } else {
        rig.files.dieWhen = (run) => Boolean(run.base && run.operations.some((op) => op.key === 'start'))
      }
      await assert.rejects(rig.start(FLOW, AGENTS), /journal/i)
      const aborted = fetched
      const abortedRef = `refs/harnessdesk/flow-base/${aborted}`
      assert.equal(await repo.git('rev-parse', abortedRef), retained)
      if (during === 'recovery') {
        // The first restart dies (or cannot delete) after conclusively aborting the interrupted start.
        rig.files.save = startSave
        rig.files.dead = false
        rig.files.dieWhen = null
        // Flows.load reads through the same engine's files, as a fresh process does.
        if (failure === 'interruption') interruptAbort()
        else deletionFails = true
        await rig.flows.load()
      }
      const saved = JSON.parse(await readFile(join(rig.dir, 'flows-v2', `${aborted}.json`), 'utf8'))
      assert.equal(saved.state, 'stopped', 'the abort is durable even though cleanup did not finish')
      assert.equal(await repo.git('rev-parse', abortedRef), retained, 'the fault left the aborted ref behind')
      const attempts = removed.length
      deletionFails = false
      await rig.restart()
      await assert.rejects(repo.git('rev-parse', '--verify', abortedRef))
      assert.deepEqual(removed.slice(attempts), [aborted])
      assert.equal(rig.executions.stored(aborted)?.operations.find((op) => op.key === 'drop-base')?.state, 'finished')
      assert.equal(await repo.git('rev-parse', `refs/harnessdesk/flow-base/${successful.id}`), retained)
      assert.ok(!removed.includes(successful.id), 'successful runs are never offered for deletion')
      await rig.restart()
      assert.equal(removed.length, attempts + 1, 'finished cleanup is not retried')
    })
  }
}
