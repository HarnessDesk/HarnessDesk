import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { FakeRuntime, type FakeSession } from './fixtures/fake-runtime.js'
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
