import assert from 'node:assert/strict'
import { createHook } from 'node:async_hooks'
import { execFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { pipeline } from 'node:stream/promises'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { getHeapSnapshot } from 'node:v8'

import { itemId, sessionId, turnId, type Session, type TurnId } from '@harnessdesk/protocol'
import { Host } from '../src/host.js'
import { StateStore } from '../src/state.js'
import { TranscriptStore } from '../src/transcripts.js'
import { FakeRuntime } from './fixtures/fake-runtime.js'
import { silent } from './fixtures/harness.js'
import { claimed, desk, execution, scopeOf, start, whenChanged } from './fixtures/flow-host-evidence.js'
import { tempDir } from './scratch.js'

const exec = promisify(execFile)
const immediate = () => new Promise<void>(resolve => setImmediate(resolve))

function transcript(runtime: FakeRuntime, id: Session['id'], bytes = 1024, active?: TurnId): void {
  const turn = { id: active ?? turnId(`payload-${id}`), status: 'inProgress' as const, items: [] }
  if (!active) runtime.emit({ type: 'turn/started', sessionId: id, turn })
  runtime.emit({ type: 'item/completed', sessionId: id, turnId: turn.id, item: {
    id: itemId(`output-${id}`), type: 'command', command: 'synthetic-output',
    cwd: '/synthetic', origin: 'agent', actions: [],
    output: randomBytes(bytes * 3 / 4).toString('base64'), status: 'completed',
  } })
  if (!active) runtime.emit({ type: 'turn/completed', sessionId: id, turn: { ...turn, status: 'completed' } })
}

test('closing a conversation saves its body, releases it from sync, and reads it back on demand', async t => {
  const root = tempDir('hd-retention-close-')
  const host = new Host({ logger: silent, state: new StateStore(join(root, 'state.json')), builtinAgents: root, catalogRefreshMs: 0 })
  t.after(() => host.dispose())
  const runtime = new FakeRuntime()
  host.register(runtime)
  await host.start()
  const session = await host.call('session/create', { runtime: runtime.info.id, options: { cwd: root } }) as Session
  transcript(runtime, session.id)
  const before = host.registry.get(runtime.info.id, session.id)!.session
  const address = { runtime: runtime.info.id, sessionId: session.id }
  await host.call('session/close', address)
  const held = host.registry.get(runtime.info.id, session.id)!
  assert.equal(held.session.itemsLoaded, false)
  assert.deepEqual(held.session.turns, [])
  assert.equal(held.watched.size, 0)
  assert.equal(host.registry.snapshot().find(row => row.id === session.id)?.itemsLoaded, false)
  const read = await host.call('session/read', address) as Session
  assert.deepEqual(read.turns, before.turns, 'the thin runtime read is enriched with durable tool output')
  assert.equal(read.itemsLoaded, true)
  await host.call('session/resume', address)
  assert.deepEqual(host.registry.get(runtime.info.id, session.id)!.session.turns, before.turns)
})

test('a failed close-time save retains the body until storage can accept it', async t => {
  const root = tempDir('hd-retention-failed-save-')
  const host = new Host({ logger: silent, state: new StateStore(join(root, 'state.json')), builtinAgents: root, catalogRefreshMs: 0 })
  t.after(() => host.dispose())
  const runtime = new FakeRuntime()
  host.register(runtime)
  await host.start()
  const session = await host.call('session/create', { runtime: runtime.info.id, options: { cwd: root } }) as Session
  transcript(runtime, session.id)
  const db = new DatabaseSync(join(root, 'sessions.sqlite'))
  t.after(() => db.close())
  db.exec("CREATE TRIGGER refuse_body BEFORE INSERT ON bodies BEGIN SELECT RAISE(FAIL, 'synthetic storage refusal'); END")
  const address = { runtime: runtime.info.id, sessionId: session.id }
  await host.call('session/close', address)
  assert.equal(host.registry.get(runtime.info.id, session.id)!.session.itemsLoaded, true)
  db.exec('DROP TRIGGER refuse_body')
  await host.call('session/close', address)
  assert.equal(host.registry.get(runtime.info.id, session.id)!.session.itemsLoaded, false)
})

test('a reopen that overtakes a close-time save keeps its newer live body', async t => {
  const root = tempDir('hd-retention-reopen-')
  const host = new Host({ logger: silent, state: new StateStore(join(root, 'state.json')), builtinAgents: root, catalogRefreshMs: 0 })
  t.after(() => host.dispose())
  const runtime = new FakeRuntime()
  host.register(runtime)
  await host.start()
  const session = await host.call('session/create', { runtime: runtime.info.id, options: { cwd: root } }) as Session
  transcript(runtime, session.id)
  const address = { runtime: runtime.info.id, sessionId: session.id }
  let saved!: () => void
  let continueRelease!: () => void
  const entered = new Promise<void>(resolve => { saved = resolve })
  const heldSave = new Promise<void>(resolve => { continueRelease = resolve })
  const release = TranscriptStore.prototype.release
  t.mock.method(TranscriptStore.prototype, 'release', async function(this: TranscriptStore, session: Session) {
    const result = await release.call(this, session)
    saved()
    await heldSave
    return result
  })
  t.after(() => continueRelease())
  const closing = host.call('session/close', address)
  await entered
  await host.call('session/resume', address)
  continueRelease()
  await closing
  const held = host.registry.get(runtime.info.id, session.id)!
  assert.ok(held.live)
  assert.equal(held.session.itemsLoaded, true)
  assert.ok(held.session.turns.some(turn => turn.items.some(item => item.type === 'command')))
})

const FLOW = `
version: 2
name: Synthetic retention
roles:
  worker: { kind: agent, uses: implementer, count: 2, grant: read }
seed: { role: worker, title: Finish synthetic work }
rules: []
`

test('settled synthetic Flow runs stay within the retained-heap and main-thread budgets', { timeout: 120_000 }, async t => {
  if (!global.gc) {
    // CI's ordinary runner needs no flags; only this bounded child exposes GC.
    const env = { ...process.env }
    delete env['NODE_TEST_CONTEXT']
    const result = await exec(process.execPath, ['--expose-gc', '--test', '--test-reporter=tap', '--test-name-pattern=settled synthetic', fileURLToPath(import.meta.url)], { timeout: 110_000, env })
    assert.match(result.stdout, /heapPerRun/, 'the isolated child actually ran the measurement')
    t.diagnostic(result.stdout.trim())
    return
  }
  const d = await desk(t)
  const samples: { runs: number; seats: number; heap: number }[] = []
  const starts = new Map<number, number>()
  let longestTaskMs = 0
  const tasks = createHook({
    before(id) { starts.set(id, performance.now()) },
    after(id) {
      const began = starts.get(id)
      if (began !== undefined) longestTaskMs = Math.max(longestTaskMs, performance.now() - began)
      starts.delete(id)
    },
  })
  tasks.enable()
  t.after(() => tasks.disable())
  for (let n = 1; n <= 20; n++) {
    // Removed folders remain historical workspace rows, as in a long-lived desk.
    const folder = join(d.root, `workspace-${n}`)
    await mkdir(folder)
    await d.host.call('workspace/open', { path: folder })
    const run = await start(d, FLOW, {})
    const cards = await claimed(d, run.goal, 'worker', 2)
    for (const card of cards) {
      const id = sessionId(card.claim!.sessionId)
      const active = [...d.host.registry.get(d.runtimes[0]!.info.id, id)!.running].at(-1)
      assert.ok(active)
      transcript(d.runtimes[0]!, id, 512 * 1024, active)
      assert.doesNotMatch(await d.host.teamPlane.complete(card.id, {}, scopeOf(card)), /^Refused/)
      d.runtimes[0]!.sessions.get(id)!.finish()
      await d.host.call('session/close', { runtime: d.runtimes[0]!.info.id, sessionId: id })
    }
    await whenChanged(d, async () => (await execution(d, run.id)).state === 'settled' ? true : null, 'the run to settle')
    await rm(folder, { recursive: true })
    if ([5, 10, 20].includes(n)) {
      await immediate()
      global.gc()
      samples.push({ runs: n, seats: n * 2, heap: process.memoryUsage().heapUsed })
      if (process.env['HD_RETENTION_SNAPSHOTS']) {
        tasks.disable() // snapshot instrumentation is outside the workload budget
        const destination = join(process.env['HD_RETENTION_SNAPSHOTS'], `heap-${n}.heapsnapshot`)
        await mkdir(process.env['HD_RETENTION_SNAPSHOTS'], { recursive: true })
        await pipeline(getHeapSnapshot(), createWriteStream(destination))
        tasks.enable()
      }
    }
  }
  const first = samples[0]!, last = samples.at(-1)!
  const heapPerRun = (last.heap - first.heap) / (last.runs - first.runs)
  const heapPerSeat = heapPerRun / 2
  t.diagnostic(JSON.stringify({ samples, heapPerRun, heapPerSeat, longestTaskMs }))
  assert.ok(heapPerRun < 256 * 1024, `retained heap ${heapPerRun} bytes/run exceeds 256 KiB/run (128 KiB/closed seat)`)
  assert.ok(longestTaskMs < 500, `main-thread task ${longestTaskMs} ms exceeds 500 ms`)
  assert.ok(d.host.registry.all().every(record => !record.live && !record.session.itemsLoaded && record.watched.size === 0), 'every closed body was unloaded')
})
