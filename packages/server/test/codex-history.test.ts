import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { CodexRuntime } from '@harnessdesk/adapter-codex'
import type { Session } from '@harnessdesk/protocol'

import { Client, start, stop } from './fixtures/harness.js'

/*
 * A branch whose history could not be read, through the host.
 *
 * The Codex adapter opens such a fork without its turns and says so in a
 * notice that tells the person to choose it in the sidebar. Choosing a
 * conversation there is `openSession`, which asks the host for `session/read`
 * even when it is the one on screen. So the promise holds only if the notice
 * reaches the window and that read, through the host, reaches Codex again
 * rather than the empty record the fork was opened with. This runs the real
 * adapter over its fake, 0.155.0's, with the first turn listing refused.
 */

const CODEX_FAKE = fileURLToPath(new URL('../../../adapter-codex/dist/test/fixtures/fake-codex.mjs', import.meta.url))

test('over Codex: a branch whose history could not be read says so, and choosing it again reads it whole', async (t) => {
  const harness = await start()
  t.after(() => stop(harness))
  const runtime = new CodexRuntime({
    binaryPath: CODEX_FAKE,
    clientName: 'harnessdesk-test',
    env: { FAKE_CODEX_VERSION: '0.155.0', FAKE_CODEX_FAIL_TURNS_LISTS: '1' },
  })
  harness.host.register(runtime)
  await runtime.start()
  t.after(() => runtime.dispose())
  const client = await Client.connect(harness.server)
  t.after(() => client.close())

  const fork = (await client.call('session/fork', { runtime: 'codex', sessionId: 'thread-paged' })) as Session
  assert.deepEqual(fork.turns, [])
  assert.equal(fork.itemsLoaded, false, 'the branch is opened unloaded, not as an empty conversation')

  const told = client.events.filter((event) => event.type === 'notice' && event.sessionId === fork.id)
  assert.deepEqual(
    told.map((event) => event.type === 'notice' && event.message),
    ['The branch was made, but its history could not be read. Choose it in the sidebar to load it.'],
  )

  // What choosing it in the sidebar asks the host.
  const read = (await client.call('session/read', { runtime: 'codex', sessionId: fork.id })) as Session
  assert.equal(read.itemsLoaded, true)
  assert.deepEqual(
    read.turns.map((turn) => String(turn.id)),
    ['turn-p1', 'turn-p2', 'turn-p3'],
  )
})
