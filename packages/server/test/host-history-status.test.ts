import assert from 'node:assert/strict'
import { join } from 'node:path'
import { test } from 'node:test'

import { sessionId } from '@harnessdesk/protocol'

import { Host } from '../src/host.js'
import { StateStore } from '../src/state.js'
import { FakeRuntime, FakeSession } from './fixtures/fake-runtime.js'
import { silent } from './fixtures/harness.js'
import { tempDir } from './scratch.js'

test('host-only history reports a live conversation idle after completion and active during a turn', async (t) => {
  const base = tempDir('hd-history-status-')
  const host = new Host({
    logger: silent,
    state: new StateStore(join(base, 'state.json')),
    builtinAgents: join(base, 'agents'),
    libraryHome: join(base, 'library'),
  })
  const runtime = new FakeRuntime()
  host.register(runtime)
  t.after(() => host.dispose())
  const live = new FakeSession(runtime, sessionId('finished-conversation'), { cwd: base, model: 'fake-1' }, {})
  const record = host.registry.upsert(live.snapshot(), live)
  const list = () => host.call('session/list', { runtime: runtime.info.id, cwd: base })
  const status = async () => {
    const page = await list()
    assert.equal(page.data.length, 1)
    assert.equal(page.data[0]!.id, live.id)
    return page.data[0]!.status
  }
  assert.equal(runtime.history.length, 0, 'the runtime page omits this conversation')

  await live.send([{ type: 'text', text: 'Finish the synthetic task' }])
  live.finish('Done')
  assert.equal(record.session.turns.at(-1)?.status, 'completed')
  assert.equal(record.running.size, 0)
  assert.equal(record.tasks.length, 0)
  assert.ok(record.live, 'opening the conversation retains its handle')
  assert.deepEqual(await status(), { type: 'idle' })

  await live.send([{ type: 'text', text: 'Start another synthetic task' }])
  assert.equal(record.running.size, 1)
  assert.deepEqual(await status(), { type: 'active' })
  live.finish('Done again')
  assert.deepEqual(await status(), { type: 'idle' })

  await host.call('session/close', { runtime: runtime.info.id, sessionId: live.id })
  assert.equal(record.live, null)
  assert.deepEqual(await status(), { type: 'notLoaded' })
})
