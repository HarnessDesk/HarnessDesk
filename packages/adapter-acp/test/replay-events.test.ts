import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { sessionId, type AgentEvent } from '@harnessdesk/protocol'
import { AcpRuntime } from '../src/index.js'

/**
 * Loading a stored conversation is history being re-read, not work being
 * done: nothing about its items may reach the host as activity (#2044).
 *
 * Answer and thinking chunks used to announce an empty `item/started` while
 * replaying, the one path that skipped the replay guard. The host took those
 * as fresh unsaved activity over the finished items it had saved under the
 * same ids, so an idle conversation read back with every reply blanked and
 * "still being saved" for good. The replay below is the shape a stored
 * conversation comes back in: a prompt, thinking, a command, then the answer.
 */

const FAKE = fileURLToPath(new URL('./fixtures/tool-items-acp.mjs', import.meta.url))

test('replaying a stored conversation emits no item activity, and keeps its replies', async (t) => {
  const cwd = mkdtempSync(join(tmpdir(), 'hd-acp-replay-events-'))
  t.after(() => rmSync(cwd, { recursive: true, force: true }))
  const updates = [
    { sessionUpdate: 'agent_thought_chunk', messageId: 'msg-1', content: { type: 'text', text: 'Looking at the tests first.' } },
    { sessionUpdate: 'tool_call', toolCallId: 'call-1', title: 'npm test', kind: 'execute', status: 'pending', rawInput: { command: 'npm test' } },
    { sessionUpdate: 'tool_call_update', toolCallId: 'call-1', status: 'completed', content: [{ type: 'content', content: { type: 'text', text: 'ok\n' } }] },
    { sessionUpdate: 'agent_message_chunk', messageId: 'msg-2', content: { type: 'text', text: 'The tests pass ' } },
    { sessionUpdate: 'agent_message_chunk', messageId: 'msg-2', content: { type: 'text', text: 'now.' } },
  ]
  const runtime = new AcpRuntime({
    id: 'fake-acp', name: 'Fake ACP Agent', command: process.execPath, args: [FAKE],
    env: { TOOL_UPDATES: JSON.stringify(updates), TOOL_CWD: cwd },
  })
  t.after(() => runtime.dispose())
  const events: AgentEvent[] = []
  runtime.subscribe(event => events.push(event))
  await runtime.start()

  const read = await runtime.readSession(sessionId('tool-items'))

  const activity = events.filter(event => event.type.startsWith('item/') || event.type.startsWith('turn/'))
  assert.deepEqual(activity.map(event => event.type), [], 'a replay announces no items or turns')
  const items = read.turns.flatMap(turn => turn.items)
  const reply = items.find(item => item.type === 'assistantMessage')
  assert.ok(reply?.type === 'assistantMessage')
  assert.equal(reply.text, 'The tests pass now.')
  const thought = items.find(item => item.type === 'reasoning')
  assert.ok(thought?.type === 'reasoning')
  assert.deepEqual(thought.content, ['Looking at the tests first.'])
  assert.ok(events.some(event => event.type === 'session/started'), 'the finished read is still announced once, whole')
})
