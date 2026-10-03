import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { FakeRuntime, type FakeSession } from './fixtures/fake-runtime.js'
import { ExecutionFiles } from '../src/flow-execution.js'
import { start, stop } from './fixtures/harness.js'

for (const interrupt of [true, false]) test(`stop interrupts only a capable runtime (${interrupt}) and never opens the reviewer`, async t => {
  const home = await mkdtemp('/tmp/hd-door-')
  const runtime = new FakeRuntime({ capabilities: { interrupt } })
  const h = await start({ catalogRefreshMs: 0 }, home, runtime)
  t.after(async () => { await stop(h); await rm(home, { recursive: true, force: true }) })
  await mkdir(join(home, 'agents', 'writer'), { recursive: true })
  await writeFile(join(home, 'agents', 'writer', 'AGENT.md'), '---\nname: Writer\nceiling: read\nanswers: [written]\nprefer: [fake]\n---\nWrite it.\n')
  await h.host.call('workspace/open', { path: home })
  let writer: FakeSession | undefined
  runtime.onSend = session => { if (!writer) { session.finish(); writer = session } }
  const source = `version: 2
name: Stop test
roles:
  writer: { kind: agent, uses: writer }
  reviewer: { kind: person, outcomes: [approved] }
seed: { role: writer, title: Write }
rules:
  - { id: review, on: writer, then: { role: reviewer, title: Review } }
`
  const preview = await h.host.call('flow/preview', { root: home, source })
  assert.ok(preview.token, JSON.stringify(preview.problems))
  const run = await h.host.call('flow/start-goal', { root: home, source, sentence: 'Stop test', token: preview.token! })
  assert.ok(writer?.busy)
  const stopped = await h.host.call('flow/execution/stop', { run: run.id, reason: 'Changed' })
  assert.equal(stopped.state, 'stopped')
  assert.equal(writer.busy, !interrupt)
  if (!interrupt) writer.finish()
  const view = await h.host.call('goal/read', { goal: run.goal })
  await h.host.call('team/intent', { room: run.goal, id: view.board.intents[0]!.id, action: 'done', outcome: 'written' })
  await h.host.flowsPlane.flush()
  assert.ok(!(await h.host.call('goal/read', { goal: run.goal })).board.intents.some(card => card.role === 'reviewer'))
  assert.equal((await h.host.call('flow/execution', { run: run.id })).state, 'stopped')
})


test('stop during a check startup journal prevents the deferred command from launching', async t => {
  const home = await mkdtemp('/tmp/hd-door-')
  const h = await start({ catalogRefreshMs: 0 }, home)
  t.after(async () => { await stop(h); await rm(home, { recursive: true, force: true }) })
  await h.host.call('workspace/open', { path: home })
  const marker = join(home, 'launched')
  const source = `version: 2
name: Deferred check stop
roles:
  decide: { kind: person, outcomes: [approved] }
  gate: { kind: check, run: "printf launched > ${marker}; sleep 1", timeout: 60, exits: { "0": pass }, otherwise: fail }
  reviewer: { kind: person, outcomes: [approved] }
seed: { role: decide, title: Decide }
rules:
  - { id: check, on: decide, then: { role: gate, title: Check } }
  - { id: review, on: gate, then: { role: reviewer, title: Review } }
`
  const preview = await h.host.call('flow/preview', { root: home, source })
  assert.ok(preview.token, JSON.stringify(preview.problems))
  const run = await h.host.call('flow/start-goal', { root: home, source, sentence: 'Deferred stop', token: preview.token! })
  const save = ExecutionFiles.prototype.save
  let release!: () => void, held!: () => void
  const gated = new Promise<void>(resolve => { held = resolve })
  const resume = new Promise<void>(resolve => { release = resolve })
  let intercepted = false
  ExecutionFiles.prototype.save = async function(document) {
    if (!intercepted && document.id === run.id && document.operations.some(one => one.key === 'check:2:0' && one.state === 'started')) {
      intercepted = true; held(); await resume
    }
    return save.call(this, document)
  }
  try {
    await h.host.call('team/intent', { room: run.goal, id: 1, action: 'abandon', reason: 'Route to check' })
    await gated
    const stopping = h.host.call('flow/execution/stop', { run: run.id, reason: 'Stop before effect' })
    const concurrent = h.host.call('flow/execution/stop', { run: run.id, reason: 'Concurrent stop' })
    // Let the host accept Stop while the earlier queue item is held in its save.
    await new Promise<void>(resolve => setImmediate(resolve))
    release()
    const [stopped, repeated] = await Promise.all([stopping, concurrent])
    assert.deepEqual(repeated, stopped)
    assert.equal(stopped.state, 'stopped')
    assert.equal(stopped.reason, 'Stop before effect')
    await assert.rejects(readFile(marker), { code: 'ENOENT' }, 'the deferred command must never launch')
    assert.ok(!(await h.host.call('goal/read', { goal: run.goal })).board.intents.some(card => card.role === 'reviewer'))
  } finally { release(); ExecutionFiles.prototype.save = save }
})


test('a failed stop save leaves no dispatch barrier on the still-running run', async t => {
  const home = await mkdtemp('/tmp/hd-door-')
  const h = await start({ catalogRefreshMs: 0 }, home)
  t.after(async () => { await stop(h); await rm(home, { recursive: true, force: true }) })
  await h.host.call('workspace/open', { path: home })
  const marker = join(home, 'recovered')
  const source = `version: 2
name: Stop save recovery
roles:
  decide: { kind: person, outcomes: [approved] }
  gate: { kind: check, run: "printf recovered > ${marker}", timeout: 60, exits: { "0": pass }, otherwise: fail }
seed: { role: decide, title: Decide }
rules:
  - { id: check, on: decide, then: { role: gate, title: Check } }
`
  const preview = await h.host.call('flow/preview', { root: home, source })
  assert.ok(preview.token, JSON.stringify(preview.problems))
  const run = await h.host.call('flow/start-goal', { root: home, source, sentence: 'Stop recovery', token: preview.token! })
  const save = ExecutionFiles.prototype.save
  ExecutionFiles.prototype.save = async function(document) {
    if (document.id === run.id && document.state === 'stopped') throw new Error('Synthetic stop save failure')
    return save.call(this, document)
  }
  try { await assert.rejects(h.host.call('flow/execution/stop', { run: run.id, reason: 'Stop' }), /Synthetic stop save failure/) }
  finally { ExecutionFiles.prototype.save = save }
  assert.equal((await h.host.call('flow/execution', { run: run.id })).state, 'running')
  await h.host.call('team/intent', { room: run.goal, id: 1, action: 'abandon', reason: 'Continue after save recovery' })
  await h.host.flowsPlane.flush()
  // Completion can schedule findings-close work after the disposer's snapshot.
  await h.host.flowsPlane.cardContinuation(run.id)
  assert.equal(await readFile(marker, 'utf8'), 'recovered')
  assert.equal((await h.host.call('flow/execution', { run: run.id })).state, 'settled')
})


for (const kind of ['seat', 'turn'] as const) test(`stop during ${kind} startup sends no deferred runtime prompt`, { timeout: 30_000 }, async t => {
  const home = await mkdtemp('/tmp/hd-door-')
  const runtime = new FakeRuntime()
  const h = await start({ catalogRefreshMs: 0 }, home, runtime)
  t.after(async () => { await stop(h); await rm(home, { recursive: true, force: true }) })
  await mkdir(join(home, 'agents', 'writer'), { recursive: true })
  await writeFile(join(home, 'agents', 'writer', 'AGENT.md'), '---\nname: Writer\nceiling: read\nanswers: [written]\nprefer: [fake]\n---\nWrite it.\n')
  await h.host.call('workspace/open', { path: home })
  let prompts = 0
  runtime.onSend = session => { prompts++; session.finish() }
  const source = `version: 2
name: Deferred seat stop
roles:
  decide: { kind: person, outcomes: [approved] }
  writer: { kind: agent, uses: writer }
  reviewer: { kind: person, outcomes: [approved] }
seed: { role: decide, title: Decide }
rules:
  - { id: write, on: decide, then: { role: writer, title: Write } }
  - { id: review, on: writer, then: { role: reviewer, title: Review } }
`
  const preview = await h.host.call('flow/preview', { root: home, source })
  assert.ok(preview.token, JSON.stringify(preview.problems))
  const run = await h.host.call('flow/start-goal', { root: home, source, sentence: 'Deferred seat', token: preview.token! })
  const save = ExecutionFiles.prototype.save
  let release!: () => void, held!: () => void
  const gated = new Promise<void>(resolve => { held = resolve })
  const resume = new Promise<void>(resolve => { release = resolve })
  let intercepted = false
  ExecutionFiles.prototype.save = async function(document) {
    if (!intercepted && document.id === run.id && document.operations.some(one => one.key === `${kind}:2:0` && one.state === 'started')) {
      intercepted = true; held(); await resume
    }
    return save.call(this, document)
  }
  try {
    await h.host.call('team/intent', { room: run.goal, id: 1, action: 'abandon', reason: 'Route to writer' })
    await gated
    const before = prompts
    assert.equal(before, kind === 'seat' ? 0 : 1)
    const stopping = h.host.call('flow/execution/stop', { run: run.id, reason: 'Stop before prompt' })
    await new Promise<void>(resolve => setImmediate(resolve))
    release()
    assert.equal((await stopping).state, 'stopped')
    assert.equal(prompts, before, 'a prompt cannot be dispatched after Stop while startup was held')
    assert.ok(!(await h.host.call('goal/read', { goal: run.goal })).board.intents.some(card => card.role === 'reviewer'))
  } finally { release(); ExecutionFiles.prototype.save = save }
})
