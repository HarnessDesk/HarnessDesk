import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { AcpRuntime } from '@harnessdesk/adapter-acp'
import type { Session } from '@harnessdesk/protocol'

import { buildThread } from '../src/phone-thread.js'
import type { FakeRuntime } from './fixtures/fake-runtime.js'
import { Client, halt, start, stop } from './fixtures/harness.js'
import { readStored } from './fixtures/stored-transcripts.js'
import { tempDir } from './scratch.js'

/**
 * An idle conversation the agent keeps, read back through the desk after a
 * restart (#2044).
 *
 * Reading it replays the agent's store. While replaying, every answer and
 * thinking chunk used to reach the host as an empty `item/started`: live
 * activity, as far as the host could tell, over the finished items it had
 * saved under the same ids. The read after a restart then came back with
 * every reply blank, `historyPending` set on every read after it, and a
 * shutdown that refused to finish because that "activity" could not be saved.
 * Nothing was being written; the conversation had been idle for weeks.
 */

const PEER = fileURLToPath(new URL('./fixtures/stored-history-acp.mjs', import.meta.url))
const REPLIES = ['Fixed: sum subtracted instead of adding. The tests pass.', 'Added a negatives case; all green.']

const replies = (session: Session): string[] =>
  session.turns.flatMap(turn => turn.items.flatMap(item => item.type === 'assistantMessage' ? [item.text] : []))
const thoughts = (session: Session): string[] =>
  session.turns.flatMap(turn => turn.items.flatMap(item => item.type === 'reasoning' ? [item.content.join('')] : []))

test('an idle replayed conversation reads back with its replies and nothing pending, across a restart', async (t) => {
  const work = tempDir('hd-idle-replay-work-')
  execFileSync('git', ['init', '-q', work])
  const peer = (): AcpRuntime => new AcpRuntime({
    id: 'rig-agent', name: 'Rig Agent', command: process.execPath, args: [PEER], env: { STORED_HISTORY_CWD: work },
  })
  const read = async (client: Client): Promise<Session> =>
    (await client.call('session/read', { runtime: 'rig-agent', sessionId: 'stored-1' })) as Session

  const first = await start({}, undefined, peer() as unknown as FakeRuntime)
  const client = await Client.connect(first.server)
  await client.call('workspace/open', { path: work })
  const imported = await read(client)
  assert.deepEqual(replies(imported), REPLIES)
  // The desk writes the body down a beat after the read; the restart below is
  // the one that reads it back.
  for (let tries = 0; tries < 200 && !readStored(first.stateDir, 'rig-agent', 'stored-1'); tries += 1) {
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  assert.ok(readStored(first.stateDir, 'rig-agent', 'stored-1'), 'the desk kept its own copy')
  client.close()
  await halt(first)

  const again = await start({}, first.stateDir, peer() as unknown as FakeRuntime)
  let stopped = false
  t.after(async () => { if (!stopped) await stop(again).catch(() => {}) })
  const reopened = await Client.connect(again.server)
  t.after(() => reopened.close())
  await reopened.call('workspace/open', { path: work })

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const session = await read(reopened)
    assert.equal(session.historyPending, undefined, `read ${attempt + 1} is not waiting on anything to be saved`)
    assert.deepEqual(replies(session), REPLIES, `read ${attempt + 1} keeps every reply`)
    assert.deepEqual(thoughts(session), ['Run the tests to see the failure.'], `read ${attempt + 1} keeps the thinking`)
    // The replay carries no times: a duration nobody measured is left out,
    // not reported as nought.
    for (const turn of session.turns) assert.equal(turn.durationMs ?? null, null)

    const thread = buildThread({ id: 'rig-agent:stored-1', session, running: false, project: null, pending: [], decided: [] }, { home: null, seat: 'Rig Agent' })
    assert.equal(thread.historyPending, undefined)
    assert.deepEqual(thread.turns.flatMap(turn => turn.type === 'agent' ? [turn.markdown] : []), REPLIES)
    await new Promise(resolve => setTimeout(resolve, 100))
  }

  reopened.close()
  // Nothing unsaved is left behind: shutting the desk down finishes.
  await stop(again)
  stopped = true
})
