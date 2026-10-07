import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { AcpRuntime } from '@harnessdesk/adapter-acp'
import { Host, Logger, StateStore } from '../src/index.js'

const FAKE = fileURLToPath(new URL('../../../adapter-acp/dist/test/fixtures/fake-acp-agent.mjs', import.meta.url))

test('host calls wait for an adapter-owned last-handle stop before reopening', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'hd-acp-release-race-'))
  const runtime = new AcpRuntime({ id: 'shared', name: 'Shared', command: process.execPath, args: [FAKE],
    sharedSessionProcess: true, env: { FAKE_ACP_NO_CLOSE: '1', FAKE_ACP_STORE: join(dir, 'store.json') } })
  const host = new Host({ logger: new Logger('test', { console: false }), state: new StateStore(join(dir, 'state.json')),
    catalogRefreshMs: 0, idleStopMs: 0, sessionRestMs: 0 })
  let release!: () => void
  const barrier = new Promise<void>(resolve => { release = resolve })
  t.after(async () => { release(); await host.dispose(); await rm(dir, { recursive: true, force: true }) })
  host.register(runtime)
  await host.start()
  const session = await runtime.createSession({ cwd: dir })
  await runtime.listSkills()
  const connection = runtime.connectionFor(session.id)
  const stop = connection.stop.bind(connection)
  let entered!: () => void
  const entering = new Promise<void>(resolve => { entered = resolve })
  connection.stop = async () => {
    const stopped = stop()
    entered()
    await barrier
    await stopped
  }
  const closing = session.close()
  await entering
  const listing = host.call('session/list', { runtime: runtime.info.id })
  const opening = host.call('session/create', { runtime: runtime.info.id, options: { cwd: dir } })
  const results = Promise.allSettled([listing, opening])
  release()
  await closing
  assert.deepEqual((await results).map(result => result.status), ['fulfilled', 'fulfilled'])
  assert.equal(runtime.health().state, 'ready')
})
