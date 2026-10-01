import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { AcpRuntime } from '../src/index.js'

const FAKE = fileURLToPath(new URL('./fixtures/fake-acp-agent.mjs', import.meta.url))

test('an idle stop reaps the bridge and serves cached models, account, and history', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'hd-acp-idle-'))
  const store = join(directory, 'sessions.json')
  await writeFile(store, JSON.stringify({
    older: {
      sessionId: 'older',
      cwd: '/tmp/old-project',
      title: 'Earlier session',
      updatedAt: '2026-09-30T00:00:00.000Z',
    },
  }))
  const runtime = new AcpRuntime({
    id: 'idle-fake',
    name: 'Idle Fake',
    command: process.execPath,
    args: [FAKE],
    env: { FAKE_ACP_STORE: store },
  })
  t.after(async () => {
    await runtime.dispose()
    await rm(directory, { recursive: true, force: true })
  })

  await runtime.start()
  const models = await runtime.knownModels()
  assert.ok(models)
  const options = await runtime.defaultSessionOptions()
  assert.ok(options.length > 0)
  const account = await runtime.getAccount()
  const history = await runtime.listSessions()
  assert.equal(history.data[0]?.title, 'Earlier session')
  const pid = Number(runtime.info.version)
  assert.ok(Number.isInteger(pid) && pid > 0)

  // Taken at the stop, not earlier: the agent's command list (which sets `skills`) arrives on its own schedule after the
  // session starts, and once the process is gone this snapshot is exactly what the idle runtime must keep serving.
  const info = runtime.info
  assert.equal(await runtime.stopForIdle(), true)
  assert.equal(runtime.health().state, 'idle')
  await new Promise((resolve) => setTimeout(resolve, 40))
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' })
  assert.deepEqual(await runtime.listModels(), models)
  assert.deepEqual(await runtime.defaultSessionOptions(), options)
  assert.deepEqual(await runtime.getAccount(), account)
  assert.deepEqual(runtime.info.capabilities, info.capabilities)
  assert.deepEqual(runtime.info.presentation, info.presentation)
  assert.deepEqual(await runtime.listSessions(), history)

  await runtime.start()
  assert.equal(runtime.health().state, 'ready')
  assert.notEqual(Number(runtime.info.version), pid)
})
