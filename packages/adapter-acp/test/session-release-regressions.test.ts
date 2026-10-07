import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { AcpRuntime } from '../src/index.js'

const FAKE = fileURLToPath(new URL('./fixtures/fake-acp-agent.mjs', import.meta.url))
const SHOTS = fileURLToPath(new URL('../../../../script/shots/agent.mjs', import.meta.url))

test('the native scene agent keeps distinct conversations on one connection', async (t) => {
  const runtime = new AcpRuntime({ id: 'shots', name: 'Scenes', command: process.execPath, args: [SHOTS] })
  t.after(() => runtime.dispose())
  await runtime.start()
  const first = await runtime.createSession({ cwd: '/tmp' })
  const second = await runtime.createSession({ cwd: '/tmp' })
  assert.notEqual(first.id, second.id)
  await first.close()
  assert.equal(await runtime.resumeSession(second.id), second)
})

test('passive resource roots include live no-close workers and remove released ones', async (t) => {
  const runtime = new AcpRuntime({ id: 'roots', name: 'Roots', command: process.execPath, args: [FAKE],
    env: { FAKE_ACP_NO_CLOSE: '1' } })
  t.after(() => runtime.dispose())
  await runtime.start()
  const control = runtime.resourceProcessIds()[0]!
  const first = await runtime.createSession({ cwd: '/tmp' })
  const second = await runtime.createSession({ cwd: '/tmp' })
  const worker = runtime.connectionFor(first.id).processId!
  assert.deepEqual(new Set(runtime.resourceProcessIds()),
    new Set([control, worker, runtime.connectionFor(second.id).processId!]))
  await first.close()
  assert.ok(!runtime.resourceProcessIds().includes(worker))
  await second.close()
  assert.deepEqual(runtime.resourceProcessIds(), [control])
})

test('draft picks and repeated stored reads reuse quiet handles, then reap them', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'hd-read-cache-'))
  const log = join(dir, 'lifetime.ndjson')
  const runtime = new AcpRuntime({ id: 'cache', name: 'Cache', command: process.execPath, args: [FAKE],
    env: { FAKE_ACP_NO_CLOSE: '1', FAKE_ACP_STORE: join(dir, 'store.json'),
      FAKE_ACP_LIFETIME: log, FAKE_ACP_STORE_DRAFTS: '1' } })
  t.after(async () => { await runtime.dispose(); await rm(dir, { recursive: true, force: true }) })
  const opens = async () => (await readFile(log, 'utf8')).trim().split('\n')
    .map(line => JSON.parse(line)).filter(row => row.type === 'bridge').length
  await runtime.start()
  const stored = await runtime.createSession({ cwd: dir })
  await stored.close()
  await runtime.defaultSessionOptions(dir, { voice: 'pirate' })
  const beforePicks = await opens()
  await runtime.defaultSessionOptions(dir, { voice: 'plain' })
  await runtime.defaultSessionOptions(dir, { voice: 'pirate' })
  assert.equal(await opens(), beforePicks, 'picks do not spawn another worker')
  await runtime.readSession(stored.id)
  const beforeReads = await opens()
  await runtime.readSession(stored.id)
  assert.equal(await opens(), beforeReads, 'history reads reuse the temporary handle')
  await runtime.stopForIdle()
  assert.deepEqual(runtime.resourceProcessIds(), [])
})

test('a stored read returns before worker exit, and resume cancels its quiet release', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'hd-read-return-'))
  const runtime = new AcpRuntime({ id: 'read-return', name: 'Read return', command: process.execPath, args: [FAKE],
    env: { FAKE_ACP_NO_CLOSE: '1', FAKE_ACP_STORE: join(dir, 'store.json'), FAKE_ACP_STORE_DRAFTS: '1' } })
  let release = () => {}
  t.after(async () => { release(); await runtime.dispose(); await rm(dir, { recursive: true, force: true }) })
  await runtime.start()
  const stored = await runtime.createSession({ cwd: dir })
  await stored.close()
  let stops = 0
  const original = runtime.connectionFor.bind(runtime)
  const wrapped = new WeakSet<object>()
  let entered!: () => void
  const entering = new Promise<void>(resolve => { entered = resolve })
  const barrier = new Promise<void>(resolve => { release = resolve })
  runtime.connectionFor = (id) => {
    const connection = original(id)
    if (wrapped.has(connection)) return connection
    wrapped.add(connection)
    const stop = connection.stop.bind(connection)
    connection.stop = async () => { stops++; entered(); await barrier; await stop() }
    return connection
  }
  // The stop is deliberately held; a read that waits for it cannot return.
  let read = false
  const reading = runtime.readSession(stored.id).then(session => { read = true; return session })
  // A competing read on the same id coalesces without taking ownership.
  const second = runtime.readSession(stored.id)
  const winner = await Promise.race([reading.then(() => 'read'), entering.then(() => 'stop')])
  assert.equal(winner, 'read')
  assert.equal(read, true, 'reading does not wait for resource release')
  assert.equal(stops, 0)
  await second
  t.mock.timers.enable({ apis: ['setTimeout'] })
  await runtime.readSession(stored.id)
  const resumed = await runtime.resumeSession(stored.id)
  t.mock.timers.tick(5_000)
  t.mock.timers.reset()
  assert.equal(stops, 0, 'explicit resume owns the handle beyond the quiet interval')
  release()
  await resumed.close()
})

test('a failed initial pick retains its error even when cleanup close is refused', async (t) => {
  const runtime = new AcpRuntime({ id: 'refused', name: 'Refused', command: process.execPath, args: [FAKE],
    env: { FAKE_ACP_CLOSE_FAIL: '1' } })
  t.after(() => runtime.dispose())
  await runtime.start()
  await assert.rejects(runtime.createSession({ cwd: '/tmp', model: 'no-such-model' }), /no-such-model/)
  assert.equal(await runtime.stopForIdle(), true, 'a failed open leaves no live handle')
})

test('a silent native close times out and releases all lifecycle guards', async (t) => {
  const runtime = new AcpRuntime({ id: 'silent-close', name: 'Silent close', command: process.execPath, args: [FAKE],
    env: { FAKE_ACP_CLOSE_SILENT: '1' } })
  t.after(() => runtime.dispose())
  await runtime.start()
  const session = await runtime.createSession({ cwd: '/tmp' })
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const closed = assert.rejects(session.close(), /timed out/)
  // releaseSession publishes its promise before sending the peer request.
  await Promise.resolve()
  await Promise.resolve()
  t.mock.timers.tick(3_000)
  await closed
  t.mock.timers.reset()
  assert.equal(await runtime.stopForIdle(), true)
})
